import { mlStats } from '../db.js';

// Opt-in ANONİM döngü istatistiği (ML filo eğitimi; avukat onayı 2026-07-15).
//
// BİLEREK kimlik doğrulamasız: JWT eklenseydi sunucu istatistiği hesapla
// ilişkilendirebilirdi — anonimlik tasarım gereği. Kötüye kullanım sınırları:
// sıkı şema (uzunluk bandı 10-90 gün, en çok 24 öğe), anon_id başına tek
// satır (upsert), route-özel rate limit. IP saklanmaz.
const ANON_ID = /^[0-9a-f]{32,64}$/;

export default async function statsRoutes(fastify) {
  // POST /api/stats/cycle-lengths  Body: { anonId, lengths: [number] }
  fastify.post('/stats/cycle-lengths', {
    config: {
      rateLimit: { max: 10, timeWindow: '1 minute' },
    },
    schema: {
      body: {
        type: 'object',
        required: ['anonId', 'lengths'],
        properties: {
          anonId: { type: 'string', minLength: 32, maxLength: 64 },
          lengths: {
            type: 'array',
            minItems: 1,
            maxItems: 24,
            items: { type: 'number', minimum: 10, maximum: 90 },
          },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { anonId, lengths } = request.body;
    if (!ANON_ID.test(anonId)) {
      return reply.code(400).send({ error: 'invalid_anon_id' });
    }
    mlStats.upsert(anonId, lengths);
    return reply.code(204).send();
  });
}
