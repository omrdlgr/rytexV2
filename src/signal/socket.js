import { Server } from 'socket.io';
import { peers } from '../routes/partner.js';
import { partnerRequests, partnerships } from '../db.js';
import { CORS_ORIGIN } from '../config.js';
import { verifyToken } from '../token.js';

export function setupSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: CORS_ORIGIN, // B5: açık '*' default kaldırıldı (config.js)
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
  });

  // JWT auth middleware — verifyToken iptal listesini de kontrol eder (B7)
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('missing_token'));
    try {
      socket.userHash = verifyToken(token).sub;
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

    // reject (B6): Yalnız gerçekten `to`'dan userHash'e gelmiş bekleyen
    // istek reddedilebilir. Aksi halde herhangi biri herhangi peer'a
    // partner:rejected spam'leyebilirdi.
    socket.on('partner:reject', ({ to }) => {
      if (!partnerRequests.has(to, userHash)) {
        socket.emit('partner:error', { code: 'no_pending_request', to });
        return;
      }
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

  return io;
}
