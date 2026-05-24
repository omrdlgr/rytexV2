import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { setupSocket } from './signal/socket.js';
import authRoutes from './routes/auth.js';
import partnerRoutes from './routes/partner.js';

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const fastify = Fastify({ logger: true });

await fastify.register(cors, {
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST'],
});

fastify.register(authRoutes, { prefix: '/api' });
fastify.register(partnerRoutes, { prefix: '/api' });

fastify.get('/health', async () => ({ status: 'ok' }));

await fastify.ready();

// Attach Socket.io to Fastify's underlying http.Server, then expose on fastify
const io = setupSocket(fastify.server);
fastify.decorate('io', io);

try {
  await fastify.listen({ port: PORT, host: HOST });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
