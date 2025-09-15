const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const prisma = require('./db');

let io;

const initializeSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  // Socket authentication middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) {
        return next(new Error('Authentication error'));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, name: true, email: true, role: true }
      });

      if (!user) {
        return next(new Error('User not found'));
      }

      socket.userId = user.id;
      socket.user = user;
      next();
    } catch (error) {
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`User ${socket.user.name} connected`);
    
    // Join user to their personal room
    socket.join(`user_${socket.userId}`);

    // Join booking room
    socket.on('join_booking', (bookingId) => {
      socket.join(`booking_${bookingId}`);
    });

    // Send message
    socket.on('send_message', async (data) => {
      try {
        const { receiverId, bookingId, content, type = 'TEXT' } = data;

        const message = await prisma.message.create({
          data: {
            content,
            type,
            senderId: socket.userId,
            receiverId,
            bookingId: bookingId || null
          },
          include: {
            sender: { select: { id: true, name: true, avatar: true } },
            receiver: { select: { id: true, name: true, avatar: true } }
          }
        });

        // Send to receiver
        socket.to(`user_${receiverId}`).emit('new_message', message);
        
        // Send to booking room if applicable
        if (bookingId) {
          socket.to(`booking_${bookingId}`).emit('new_booking_message', message);
        }

        // Confirm to sender
        socket.emit('message_sent', message);
      } catch (error) {
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    // Mark messages as read
    socket.on('mark_read', async (messageIds) => {
      try {
        await prisma.message.updateMany({
          where: {
            id: { in: messageIds },
            receiverId: socket.userId
          },
          data: { isRead: true }
        });
        
        socket.emit('messages_marked_read', messageIds);
      } catch (error) {
        socket.emit('error', { message: 'Failed to mark messages as read' });
      }
    });

    socket.on('disconnect', () => {
      console.log(`User ${socket.user.name} disconnected`);
    });
  });

  return io;
};

const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized');
  }
  return io;
};

module.exports = { initializeSocket, getIO };