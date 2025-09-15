const express = require('express');
const { body, query, validationResult } = require('express-validator');
const prisma = require('../lib/db');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Calculate distance between two points (Haversine formula)
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

// Search Services
router.get('/services', [
  query('category').optional().isString(),
  query('minRating').optional().isFloat({ min: 0, max: 5 }),
  query('maxDistance').optional().isFloat({ min: 0 }),
  query('minPrice').optional().isFloat({ min: 0 }),
  query('maxPrice').optional().isFloat({ min: 0 }),
  query('latitude').optional().isFloat(),
  query('longitude').optional().isFloat(),
  query('sortBy').optional().isIn(['price', 'rating', 'distance', 'newest']),
  query('page').optional().isInt({ min: 1 }),
  query('limit').optional().isInt({ min: 1, max: 50 }),
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      category,
      minRating = 0,
      maxDistance,
      minPrice,
      maxPrice,
      latitude,
      longitude,
      sortBy = 'newest',
      page = 1,
      limit = 20
    } = req.query;

    const skip = (page - 1) * limit;
    const take = parseInt(limit);

    // Build where clause
    const whereClause = {
      isActive: true,
      provider: {
        isAvailable: true,
        averageRating: { gte: parseFloat(minRating) }
      }
    };

    if (category) {
      whereClause.category = {
        name: { contains: category, mode: 'insensitive' }
      };
    }

    if (minPrice || maxPrice) {
      whereClause.basePrice = {};
      if (minPrice) whereClause.basePrice.gte = parseFloat(minPrice);
      if (maxPrice) whereClause.basePrice.lte = parseFloat(maxPrice);
    }

    // Get services
    let services = await prisma.service.findMany({
      where: whereClause,
      include: {
        category: { select: { id: true, name: true, icon: true } },
        provider: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                avatar: true,
                latitude: true,
                longitude: true,
                address: true
              }
            }
          }
        }
      },
      skip,
      take
    });

    // Filter by distance if location provided
    if (latitude && longitude && maxDistance) {
      services = services.filter(service => {
        const providerLat = service.provider.user.latitude;
        const providerLon = service.provider.user.longitude;
        
        if (!providerLat || !providerLon) return false;
        
        const distance = calculateDistance(
          parseFloat(latitude),
          parseFloat(longitude),
          providerLat,
          providerLon
        );
        
        return distance <= parseFloat(maxDistance);
      });
    }

    // Add distance to each service
    if (latitude && longitude) {
      services = services.map(service => {
        const providerLat = service.provider.user.latitude;
        const providerLon = service.provider.user.longitude;
        
        const distance = (providerLat && providerLon) 
          ? calculateDistance(
              parseFloat(latitude),
              parseFloat(longitude),
              providerLat,
              providerLon
            )
          : null;
        
        return { ...service, distance };
      });
    }

    // Sort services
    switch (sortBy) {
      case 'price':
        services.sort((a, b) => a.basePrice - b.basePrice);
        break;
      case 'rating':
        services.sort((a, b) => b.provider.averageRating - a.provider.averageRating);
        break;
      case 'distance':
        if (latitude && longitude) {
          services.sort((a, b) => (a.distance || Infinity) - (b.distance || Infinity));
        }
        break;
      default: // newest
        services.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    // Get total count for pagination
    const totalCount = await prisma.service.count({
      where: whereClause
    });

    res.json({
      services,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalCount / take),
        totalCount,
        hasNext: skip + take < totalCount,
        hasPrev: page > 1
      }
    });

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Categories
router.get('/categories', async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      where: { isActive: true },
      include: {
        _count: {
          select: { services: true }
        }
      },
      orderBy: { name: 'asc' }
    });

    res.json({ categories });
  } catch (error) {
    console.error('Categories error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get Popular Services
router.get('/popular', async (req, res) => {
  try {
    const popularServices = await prisma.service.findMany({
      where: {
        isActive: true,
        provider: {
          isAvailable: true,
          averageRating: { gte: 4.0 }
        }
      },
      include: {
        category: { select: { name: true, icon: true } },
        provider: {
          include: {
            user: {
              select: { name: true, avatar: true }
            }
          }
        },
        _count: {
          select: { bookings: true }
        }
      },
      orderBy: [
        { provider: { averageRating: 'desc' } },
        { provider: { totalReviews: 'desc' } }
      ],
      take: 10
    });

    res.json({ services: popularServices });
  } catch (error) {
    console.error('Popular services error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;