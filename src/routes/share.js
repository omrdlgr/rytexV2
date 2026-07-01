import { publicKeys, shares, partnerships } from '../db.js';
import { authenticateRequest } from '../token.js';

// Uçtan-uca şifreli partner paylaşımı. Sunucu blob içeriğini OKUYAMAZ;
// yalnız ortak anahtar dağıtımı + şifreli kutu taşıması yapar.
export default async function shareRoutes(fastify) {
  // Kendi ortak anahtarını yayınla/güncelle.
  // PUT /api/keys  Body: { publicKey }
  fastify.put('/keys', {
    schema: {
      body: {
        type: 'object',
        required: ['publicKey'],
        properties: { publicKey: { type: 'string', minLength: 16, maxLength: 128 } },
      },
    },
  }, async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;
    publicKeys.set(claims.sub, request.body.publicKey);
    return reply.send({ status: 'ok' });
  });

  // Bir partnerin ortak anahtarını al (şifrelemek için).
  // GET /api/keys/:hash
  fastify.get('/keys/:hash', async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;
    const { hash } = request.params;
    // Yalnız gerçek partnerin anahtarı verilir (rastgele hash taraması olmasın).
    if (!partnerships.isPartner(claims.sub, hash)) {
      return reply.code(403).send({ error: 'not_partner' });
    }
    const key = publicKeys.get(hash);
    if (!key) return reply.code(404).send({ error: 'no_key' });
    return reply.send({ publicKey: key });
  });

  // Şifreli paylaşım kutusunu yükle (sahip → izleyici).
  // PUT /api/share  Body: { to, blob }
  fastify.put('/share', {
    schema: {
      body: {
        type: 'object',
        required: ['to', 'blob'],
        properties: {
          to: { type: 'string', minLength: 8 },
          blob: { type: 'string', minLength: 1, maxLength: 8192 },
        },
      },
    },
  }, async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;
    const { to, blob } = request.body;
    if (!partnerships.isPartner(claims.sub, to)) {
      return reply.code(403).send({ error: 'not_partner' });
    }
    shares.put(claims.sub, to, blob);
    return reply.send({ status: 'ok' });
  });

  // Bana gelen tüm şifreli kutular (izleyici).
  // GET /api/shares → { shares: [{ from, blob, updatedAt }] }
  fastify.get('/shares', async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;
    return reply.send({ shares: shares.forRecipient(claims.sub) });
  });
}
