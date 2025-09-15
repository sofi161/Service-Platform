const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const moment = require('moment-timezone');
const prisma = require('../lib/db');
const { authenticateToken } = require('../middleware/auth');
const { getIO } = require('../lib/socket');

const router = express.Router();

// Create Booking
router.post('/', authenticateToken, [
  body('serviceId').isInt({ min: 1 }),
  body('scheduledDate').isISO8601(),
  body('scheduledTime').matches(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/),
  body('notes').optional().isString().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { serviceId, scheduledDate, scheduledTime, notes } = req.body;
    const customerId = req.user.id;

    // Get service details
    const service = await prisma.service.findFirst({
      where: {
        id: parseInt(serviceId),
        isActive: true
      },
      include: {
        provider: {
          include: {
            user: { select: { id: true, name: true, email: true } }
          }
        }
      }
    });

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    // Check if provider is available
    if (!service.provider.isAvailable) {
      return res.status(400).json({ error: 'Provider is currently unavailable' });
    }

    // Check if the selected time slot is available
    const bookingDateTime = moment(`${scheduledDate} ${scheduledTime}`);
    const endDateTime = bookingDateTime.clone().add(service.duration, 'minutes');

    const conflictingBookings = await prisma.booking.findMany({
      where: {
        providerId: service.provider.id,
        scheduledDate: new Date(scheduledDate),
        status: { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] },
        OR: [
          {
            AND: [
              { scheduledTime: { lte: scheduledTime } },
              // Add duration check here if needed
            ]
          }
        ]
      }
    });

    if (conflictingBookings.length > 0) {
      return res.status(400).json({ error: 'Time slot is not available' });
    }

    // Create booking
    const booking = await prisma.booking.create({
      data: {
        bookingId: uuidv4(),
        customerId,
        serviceId: service.id,
        providerId: service.provider.id,
        scheduledDate: new Date(scheduledDate),
        scheduledTime,
        duration: service.duration,
        totalPrice: service.basePrice,
        notes: notes || null
      },
      include: {
        customer: { select: { id: true, name: true, email: true, phone: true } },
        service: { select: { name: true, duration: true } },
        provider: {
          include: {
            user: { select: { id: true, name: true, email: true } }
          }
        }
      }
    });

    // Send real-time notification to provider
    try {
      const io = getIO();
      io.to(`user_${service.provider.userId}`).emit('new_booking', {
        type: 'NEW_BOOKING',
        booking,
        message: `New booking request from ${booking.customer.name}`
      });
    } catch (socketError) {
      console.log('Socket notification failed:', socketError.message);
    }

    res.status(201).json({
      message: 'Booking created successfully',
      booking
    });

  } catch (error) {
    console.error('Booking creation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get User Bookings
router.get('/my', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { status, page = 1, limit = 10 } = req.query;
    
    const skip = (page - 1) * limit;
    const take = parseInt(limit);

    const whereClause = {
      customerId: userId
    };

    if (status) {
      whereClause.status = status.toUpperCase();
    }

    const bookings = await prisma.booking.findMany({
      where: whereClause,
      include: {
        service: {
          select: {
            name: true,
            duration: true,
            category: { select: { name: true } }
          }
        },
        provider: {
          include: {
            user: { select: { name: true, avatar: true, phone: true } }
          }
        },
        review: true
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take
    });

    const totalCount = await prisma.booking.count({ where: whereClause });

    res.json({
      bookings,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalCount / take),
        totalCount
      }
    });

  } catch (error) {
    console.error('Get bookings error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update Booking Status (Provider only)
router.patch('/:bookingId/status', authenticateToken, [
  param('bookingId').isUUID(),
  body('status').isIn(['CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']),
  body('cancellationReason').optional().isString()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { bookingId } = req.params;
    const { status, cancellationReason } = req.body;
    const userId = req.user.id;

    // Find booking
    const booking = await prisma.booking.findFirst({
      where: {
        bookingId,
        provider: { userId }
      },
      include: {
        customer: { select: { id: true, name: true } },
        provider: { select: { id: true } }
      }
    });

    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    // Update booking
    const updatedBooking = await prisma.booking.update({
      where: { id: booking.id },
      data: {
        status,
        cancellationReason: status === 'CANCELLED' ? cancellationReason : null
      },
      include: {
        customer: { select: { id: true, name: true } },
        service: { select: { name: true } }
      }
    });

    // Send notification to customer
    try {
      const io = getIO();
      io.to(`user_${booking.customer.id}`).emit('booking_update', {
        type: 'BOOKING_STATUS_UPDATED',
        booking: updatedBooking,
        message: `Your booking has been ${status.toLowerCase()}`
      });
    } catch (socketError) {
      console.log('Socket notification failed:', socketError.message);
    }

    res.json({
      message: 'Booking status updated successfully',
      booking: updatedBooking
    });

  } catch (error) {
    console.error('Booking update error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Available Time Slots
router.get('/availability/:serviceId', [
  param('serviceId').isInt({ min: 1 }),
  query('date').isISO8601()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { serviceId } = req.params;
    const { date } = req.query;

    const service = await prisma.service.findFirst({
      where: {
        id: parseInt(serviceId),
        isActive: true
      },
      include: {
        provider: true
      }
    });

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    // Get existing bookings for the date
    const existingBookings = await prisma.booking.findMany({
      where: {
        providerId: service.provider.id,
        scheduledDate: new Date(date),
        status: { in: ['CONFIRMED', 'IN_PROGRESS'] }
      },
      select: {
        scheduledTime: true,
        duration: true
      }
    });

    // Generate available time slots (example: 9 AM to 6 PM)
    const timeSlots = [];
    for (let hour = 9; hour < 18; hour++) {
      for (let minute = 0; minute < 60; minute += 30) {
        const time = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
        
        // Check if this slot conflicts with existing bookings
        const isAvailable = !existingBookings.some(booking => {
          const bookingStart = moment(`${date} ${booking.scheduledTime}`);
          const bookingEnd = bookingStart.clone().add(booking.duration, 'minutes');
          const slotStart = moment(`${date} ${time}`);
          const slotEnd = slotStart.clone().add(service.duration, 'minutes');
          
          return slotStart.isBefore(bookingEnd) && slotEnd.isAfter(bookingStart);
        });

        if (isAvailable) {
          timeSlots.push({
            time,
            available: true
          });
        }
      }
    }

    res.json({ timeSlots });

  } catch (error) {
    console.error('Availability check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;