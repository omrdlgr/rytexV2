import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config.js';
import { partnerRequests } from '../db.js';

// In-memory store: phoneHash → { socketId, connectedTo }
// Replace with Redis/DB for multi-instance deployments
export const peers = new Map();

function authenticate(request, reply) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'missing_token' });
    return null;
  }
  try {
    return jwt.verify(auth.slice(7), JWT_SECRET);
  } catch {
    reply.code(401).send({ error: 'invalid_token' });
    return null;
  }
}

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
          partnerHash: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const claims = authenticate(request, reply);
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
          partnerHash: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const claims = authenticate(request, reply);
    if (!claims) return;

    const requesterHash = claims.sub;
    const { partnerHash } = request.body;

    if (requesterHash === partnerHash) {
      return reply.code(400).send({ error: 'cannot_connect_to_self' });
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
}
