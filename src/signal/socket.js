import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { peers } from '../routes/partner.js';
import { partnerRequests, partnerships } from '../db.js';
import { JWT_SECRET, CORS_ORIGIN } from '../config.js';

export function setupSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: CORS_ORIGIN, // B5: açık '*' default kaldırıldı (config.js)
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
    // YETKİ (B4): Yalnız kabul edilmiş partner çiftleri signal alışverişi
    // yapabilir. Aksi halde herhangi authenticated kullanıcı, partneri
    // olmayan birine offer/ice gönderip taciz/iz sürme yapabilirdi.

    // Caller sends offer to partner
    socket.on('signal:offer', ({ to, offer }) => {
      if (!partnerships.isPartner(userHash, to)) {
        socket.emit('signal:error', { code: 'not_authorized', to });
        return;
      }
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
      if (!partnerships.isPartner(userHash, to)) {
        socket.emit('signal:error', { code: 'not_authorized', to });
        return;
      }
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
      if (!partnerships.isPartner(userHash, to)) {
        socket.emit('signal:error', { code: 'not_authorized', to });
        return;
      }
      const target = peers.get(to);
      if (target?.socketId) {
        io.to(target.socketId).emit('signal:ice', {
          from: userHash,
          candidate,
        });
      }
    });

    // Partner accepted/rejected the connection request.
    // accept (B4/B6): Yalnız gerçekten `to`'dan userHash'e gelmiş bekleyen
    // istek varsa partnership kurulur. Sahte accept ile yetkisiz çift
    // oluşturulması engellenir.
    socket.on('partner:accept', ({ to }) => {
      if (!partnerRequests.has(to, userHash)) {
        socket.emit('partner:error', { code: 'no_pending_request', to });
        return;
      }
      partnerships.add(userHash, to);
      partnerRequests.delete(to, userHash);

      const target = peers.get(to);
      if (target?.socketId) {
        io.to(target.socketId).emit('partner:accepted', { from: userHash });
      }
    });

    socket.on('partner:reject', ({ to }) => {
      partnerRequests.delete(to, userHash);

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
