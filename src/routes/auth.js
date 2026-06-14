import bcrypt from 'bcrypt';
import { userStore } from '../db.js';
import { signToken, revokeToken, authenticateRequest } from '../token.js';

const SALT_ROUNDS = 12;

export default async function authRoutes(fastify) {
  // POST /api/register
  // Body: { phoneHash: string, password: string }
  fastify.post('/register', {
    // Brute-force/spam koruması: IP başına dakikada 5 deneme
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['phoneHash', 'password'],
        properties: {
          phoneHash: { type: 'string', minLength: 8 },
          password: { type: 'string', minLength: 6 },
        },
      },
    },
  }, async (request, reply) => {
    const { phoneHash, password } = request.body;

    if (userStore.has(phoneHash)) {
      return reply.code(409).send({ error: 'already_registered' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    userStore.create(phoneHash, passwordHash);

    const token = signToken(phoneHash);
    return reply.code(201).send({ token });
  });

  // POST /api/login
  // Body: { phoneHash: string, password: string }
  fastify.post('/login', {
    // Brute-force koruması: IP başına dakikada 5 deneme
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['phoneHash', 'password'],
        properties: {
          // minLength register ile tutarlı (B7) — şema doğrulama simetrisi
          phoneHash: { type: 'string', minLength: 8 },
          password: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { phoneHash, password } = request.body;

    const user = userStore.get(phoneHash);
    if (!user) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    const token = signToken(phoneHash);
    return reply.send({ token });
  });

  // POST /api/logout — mevcut token'ı iptal eder (B7 revocation).
  // Header: Authorization: Bearer <token>
  fastify.post('/logout', async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;
    revokeToken(claims);
    return reply.send({ status: 'logged_out' });
  });
}
