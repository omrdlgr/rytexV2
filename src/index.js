import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { setupSocket } from './signal/socket.js';
import authRoutes from './routes/auth.js';
import partnerRoutes from './routes/partner.js';
import shareRoutes from './routes/share.js';
import sparkRoutes from './routes/spark.js';
import statsRoutes from './routes/stats.js';
import pushRoutes from './routes/push.js';
import revenuecatRoutes from './routes/revenuecat.js';
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
  // DELETE: hesap silme (DELETE /api/account, Apple 5.1.1(v)).
  methods: ['GET', 'POST', 'DELETE'],
});

// Global rate limit — IP başına dakikada 100 istek (genel kötüye kullanım)
// Auth route'ları kendi sıkı limitlerini ayrıca uygular (bkz. auth.js).
// 100 -> 300 (2026-08-21). 100 ev kullanimi icin bile darmis: iki iPhone
// ayni WiFi'da AYNI IP'yi paylasiyor ve butceyi bolusuyor. Mobil veride
// daha kotu — operator CGNAT'inda binlerce abone tek IP arkasinda olabilir,
// o zaman limit tek kullaniciyi degil o operatordeki HERKESI vurur.
//
// Saha vakasi: istemci SPARK listesi basina 7-8 GET /keys atiyordu (istemci
// tarafinda duzeltildi); 197 anahtar istegi dakikalik butceyi bitiriyor,
// sonra gercek eylem 429 aliyordu. Kullanici "cevabin gonderilemedi,
// baglantini kontrol et" goruyordu — baglanti saglamdi, REDDEDEN BIZDIK.
await fastify.register(rateLimit, {
  global: true,
  max: 300,
  timeWindow: '1 minute',
});

// Fastify 5, `content-type: application/json` olup GÖVDESİ BOŞ istekleri
// reddediyor (FST_ERR_CTP_EMPTY_JSON_BODY); Fastify 4 tolere ediyordu.
//
// ⚠️ İstemci `/logout` ve `DELETE /account`'u GÖVDESİZ çağırıyor ve o
// sürümler KULLANICILARIN ELİNDE canlı. Sunucu tolere etmezse çıkış yapma
// ve hesap silme (Apple 5.1.1(v) zorunluluğu) kırılır — üstelik yalnız
// güncellemeyenlerde, yani en görünmez şekilde. Fastify 4 davranışı burada
// geri veriliyor: boş gövde = gövde yok.
fastify.addContentTypeParser(
  'application/json',
  { parseAs: 'string' },
  (_req, body, done) => {
    if (body === undefined || body === null || body === '') {
      return done(null, undefined);
    }
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      err.statusCode = 400;
      done(err);
    }
  },
);

// 2. Socket.io + decorator — must happen before ready() / listen()
const io = setupSocket(fastify.server);
fastify.decorate('io', io);

// 3. Routes
fastify.register(authRoutes, { prefix: '/api' });
fastify.register(partnerRoutes, { prefix: '/api' });
fastify.register(shareRoutes, { prefix: '/api' });
fastify.register(sparkRoutes, { prefix: '/api' });
fastify.register(statsRoutes, { prefix: '/api' });
fastify.register(pushRoutes, { prefix: '/api' });
fastify.register(revenuecatRoutes, { prefix: '/api' });

fastify.get('/health', async () => ({ status: 'ok' }));

// 4. Start
try {
  await fastify.listen({ port: PORT, host: HOST });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
