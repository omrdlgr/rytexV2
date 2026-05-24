import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

// In-memory store — replace with a real DB (SQLite/Postgres) before prod
const users = new Map();

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-prod';
const SALT_ROUNDS = 12;

export default async function authRoutes(fastify) {
  // POST /api/register
  // Body: { phoneHash: string, password: string }
  fastify.post('/register', {
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

    if (users.has(phoneHash)) {
      return reply.code(409).send({ error: 'already_registered' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    users.set(phoneHash, { phoneHash, passwordHash, createdAt: Date.now() });

    const token = jwt.sign({ sub: phoneHash }, JWT_SECRET, { expiresIn: '30d' });
    return reply.code(201).send({ token });
  });

  // POST /api/login
  // Body: { phoneHash: string, password: string }
  fastify.post('/login', {
    schema: {
      body: {
        type: 'object',
        required: ['phoneHash', 'password'],
        properties: {
          phoneHash: { type: 'string' },
          password: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { phoneHash, password } = request.body;

    const user = users.get(phoneHash);
    if (!user) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    const token = jwt.sign({ sub: phoneHash }, JWT_SECRET, { expiresIn: '30d' });
    return reply.send({ token });
  });
}
