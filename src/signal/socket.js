import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { peers } from '../routes/partner.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-prod';

export function setupSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
  });

  // JWT auth middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('missing_token'));
    try {
      socket.userHash = jwt.verify(token, JWT_SECRET).sub;
      next();
    } catch {
      next(new Error('invalid_token'));
    }
  });

  io.on('connection', (socket) => {
    const userHash = socket.userHash;

    // Register peer as online
    peers.set(userHash, { socketId: socket.id });
    socket.join(userHash);

    // ── WebRTC Signaling ──────────────────────────────────────────

    // Caller sends offer to partner
    socket.on('signal:offer', ({ to, offer }) => {
      const target = peers.get(to);
      if (!target?.socketId) {
        socket.emit('signal:error', { code: 'peer_offline', to });
        return;
      }
      io.to(target.socketId).emit('signal:offer', {
        from: userHash,
        offer,
      });
    });

    // Callee responds with answer
    socket.on('signal:answer', ({ to, answer }) => {
      const target = peers.get(to);
      if (!target?.socketId) {
        socket.emit('signal:error', { code: 'peer_offline', to });
        return;
      }
      io.to(target.socketId).emit('signal:answer', {
        from: userHash,
        answer,
      });
    });

    // ICE candidate exchange
    socket.on('signal:ice', ({ to, candidate }) => {
      const target = peers.get(to);
      if (target?.socketId) {
        io.to(target.socketId).emit('signal:ice', {
          from: userHash,
          candidate,
        });
      }
    });

    // Partner accepted/rejected the connection request
    socket.on('partner:accept', ({ to }) => {
      const target = peers.get(to);
      if (target?.socketId) {
        io.to(target.socketId).emit('partner:accepted', { from: userHash });
      }
    });

    socket.on('partner:reject', ({ to }) => {
      const target = peers.get(to);
      if (target?.socketId) {
        io.to(target.socketId).emit('partner:rejected', { from: userHash });
      }
    });

    socket.on('disconnect', () => {
      peers.delete(userHash);
    });
  });

  // Expose io on fastify server for use in route handlers
  httpServer._rytexIo = io;

  return io;
}
