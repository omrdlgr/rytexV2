import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { setupSocket } from './signal/socket.js';
import authRoutes from './routes/auth.js';
import partnerRoutes from './routes/partner.js';
import shareRoutes from './routes/share.js';
import sparkRoutes from './routes/spark.js';
import { CORS_ORIGIN } from './config.js';

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// trustProxy: Fly proxy arkasında gerçek istemci IP'si X-Forwarded-For'da.
// Olmadan rate-limit tüm trafiği tek (proxy) IP'ye bucketlar — yanlış.
const fastify = Fastify({ logger: true, trustProxy: true });

// 1. Plugins
// CORS_ORIGIN: prod'da whitelist dizisi (config.js boot'ta zorunlu kılar),
// dev'de '*'. Açık '*' default'u kaldırıldı (B5).
await fastify.register(cors, {
  origin: CORS_ORIGIN,
  methods: ['GET', 'POST'],
});

// Global rate limit — IP başına dakikada 100 istek (genel kötüye kullanım)
// Auth route'ları kendi sıkı limitlerini ayrıca uygular (bkz. auth.js).
await fastify.register(rateLimit, {
  global: true,
  max: 100,
  timeWindow: '1 minute',
});

// 2. Socket.io + decorator — must happen before ready() / listen()
const io = setupSocket(fastify.server);
fastify.decorate('io', io);

// 3. Routes
fastify.register(authRoutes, { prefix: '/api' });
fastify.register(partnerRoutes, { prefix: '/api' });
fastify.register(shareRoutes, { prefix: '/api' });
fastify.register(sparkRoutes, { prefix: '/api' });

fastify.get('/health', async () => ({ status: 'ok' }));

// 4. Start
try {
  await fastify.listen({ port: PORT, host: HOST });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
