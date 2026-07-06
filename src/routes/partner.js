import { partnerRequests, partnerships } from '../db.js';
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

    const partnerPeer = peers.get(partnerHash);
    if (!partnerPeer?.socketId) {
      return reply.code(404).send({ error: 'partner_offline' });
    }

    // Bekleyen isteği kalıcı sakla — partner:accept bunu doğrular (B4/B6).
    partnerRequests.create(requesterHash, partnerHash);

    // Notify partner via Socket.io (io instance attached by setupSocket)
    const io = fastify.io;
    if (io) {
      io.to(partnerPeer.socketId).emit('partner:request', {
        from: requesterHash,
      });
    }

    return reply.send({ status: 'request_sent' });
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
