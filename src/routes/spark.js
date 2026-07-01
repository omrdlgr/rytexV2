import { sparks, partnerships } from '../db.js';
import { authenticateRequest } from '../token.js';

// SPARK — mahremiyet isteği. Uçtan uca şifreli; sunucu içeriği OKUYAMAZ.
// Yalnız partner çiftleri arasında. Romantik-kova kuralı istemci tarafında
// (rol bilgisi sunucuda yok); sunucu yalnız partnership'i doğrular.
const ALLOWED_STATUS = ['accepted', 'not_today', 'suggest', 'maybe'];

export default async function sparkRoutes(fastify) {
  // SPARK gönder. POST /api/spark  Body: { to, blob }
  fastify.post('/spark', {
    schema: {
      body: {
        type: 'object',
        required: ['to', 'blob'],
        properties: {
          to: { type: 'string', minLength: 8 },
          blob: { type: 'string', minLength: 1, maxLength: 4096 },
        },
      },
    },
  }, async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;
    const { to, blob } = request.body;
    if (to === claims.sub) {
      return reply.code(400).send({ error: 'cannot_spark_self' });
    }
    if (!partnerships.isPartner(claims.sub, to)) {
      return reply.code(403).send({ error: 'not_partner' });
    }
    const id = sparks.create(claims.sub, to, blob);
    return reply.code(201).send({ id });
  });

  // Bana ait SPARK'lar (gönderdiğim + aldığım). GET /api/sparks
  fastify.get('/sparks', async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;
    return reply.send({ sparks: sparks.forUser(claims.sub) });
  });

  // SPARK'a cevap ver (yalnız ALICI). POST /api/spark/respond
  // Body: { id, status, blob? }  status: accepted|not_today|suggest|maybe
  fastify.post('/spark/respond', {
    schema: {
      body: {
        type: 'object',
        required: ['id', 'status'],
        properties: {
          id: { type: 'integer' },
          status: { type: 'string', enum: ALLOWED_STATUS },
          blob: { type: 'string', maxLength: 4096 },
        },
      },
    },
  }, async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;
    const { id, status, blob } = request.body;
    const row = sparks.get(id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    // Yalnız isteğin ALICISI cevaplayabilir.
    if (row.to_hash !== claims.sub) {
      return reply.code(403).send({ error: 'not_recipient' });
    }
    sparks.respond(id, status, blob ?? null);
    return reply.send({ status: 'ok' });
  });

  // SPARK sil (iki taraftan biri gizleyebilir). POST /api/spark/delete
  fastify.post('/spark/delete', {
    schema: {
      body: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer' } },
      },
    },
  }, async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;
    const row = sparks.get(request.body.id);
    if (!row) return reply.send({ status: 'ok' });
    if (row.from_hash !== claims.sub && row.to_hash !== claims.sub) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    sparks.delete(request.body.id);
    return reply.send({ status: 'ok' });
  });
}
