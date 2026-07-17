import { partnerRequests, partnerships, dissolvePartnership } from '../db.js';
import { authenticateRequest } from '../token.js';

// In-memory store: phoneHash → { socketId, connectedTo }
// Replace with Redis/DB for multi-instance deployments
export const peers = new Map();

export default async function partnerRoutes(fastify) {
  // POST /api/partner/find
  // Body: { partnerHash: string }
  // Returns whether the partner is online
  fastify.post('/partner/find', {
    schema: {
      body: {
        type: 'object',
        required: ['partnerHash'],
        properties: {
          partnerHash: { type: 'string', minLength: 8 },
        },
      },
    },
  }, async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;

    const { partnerHash } = request.body;
    const peer = peers.get(partnerHash);

    return reply.send({
      found: !!peer,
      online: !!(peer?.socketId),
    });
  });

  // POST /api/partner/connect
  // Body: { partnerHash: string }
  // Sends a connection request via Socket.io if partner is online
  fastify.post('/partner/connect', {
    schema: {
      body: {
        type: 'object',
        required: ['partnerHash'],
        properties: {
          partnerHash: { type: 'string', minLength: 8 },
        },
      },
    },
  }, async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;

    const requesterHash = claims.sub;
    const { partnerHash } = request.body;

    if (requesterHash === partnerHash) {
      return reply.code(400).send({ error: 'cannot_connect_to_self' });
    }

    // Zaten partnerse tekrar istek/spam üretme (B6).
    if (partnerships.isPartner(requesterHash, partnerHash)) {
      return reply.code(409).send({ error: 'already_partners' });
    }

    // Bekleyen isteği kalıcı sakla — partner:accept bunu doğrular (B4/B6).
    // Hedefin ONLINE OLMASI ŞART DEĞİL: çevrimdışıysa istek DB'de bekler,
    // bir sonraki bağlanışında socket.js connection handler'ı teslim eder.
    partnerRequests.create(requesterHash, partnerHash);

    // Online ise anında bildir (io instance setupSocket'te eklenir).
    const partnerPeer = peers.get(partnerHash);
    const io = fastify.io;
    if (io && partnerPeer?.socketId) {
      io.to(partnerPeer.socketId).emit('partner:request', {
        from: requesterHash,
      });
    }

    return reply.send({
      status: 'request_sent',
      online: !!partnerPeer?.socketId,
    });
  });

  // POST /api/partner/disconnect
  // Body: { partnerHash: string }
  // Partnerliği iki taraflı çözer (partnership + istekler + shares + sparks).
  // Idempotent: partnership yoksa da 200 döner (istemci tekrar-deneme kuyruğu
  // güvenle çalışsın). Karşı taraf online ise anında 'partner:removed' alır;
  // offline ise bir sonraki bağlanışında /partner/list eşitlemesi yakalar.
  fastify.post('/partner/disconnect', {
    schema: {
      body: {
        type: 'object',
        required: ['partnerHash'],
        properties: {
          partnerHash: { type: 'string', minLength: 8 },
        },
      },
    },
  }, async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;

    const userHash = claims.sub;
    const { partnerHash } = request.body;

    const existed = partnerships.isPartner(userHash, partnerHash);
    dissolvePartnership(userHash, partnerHash);

    const partnerPeer = peers.get(partnerHash);
    const io = fastify.io;
    if (io && partnerPeer?.socketId) {
      io.to(partnerPeer.socketId).emit('partner:removed', { from: userHash });
    }

    return reply.send({ status: 'disconnected', existed });
  });

  // GET /api/partner/list
  // Çağıranın onaylı partner hash'leri. İstemci offline'dayken kabul edilen
  // istekleri yakalayıp yerel "pending" durumunu düzeltmek için kullanılır.
  fastify.get('/partner/list', async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;

    return reply.send({ partners: partnerships.listFor(claims.sub) });
  });
}
