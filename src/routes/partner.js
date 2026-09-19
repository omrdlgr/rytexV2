import {
  partnerRequests,
  partnerInvites,
  partnerships,
  dissolvePartnership,
  entitlements,
} from '../db.js';
import { authenticateRequest } from '../token.js';
import { PARTNER_LIMIT, ENFORCE_PREMIUM } from '../config.js';

// In-memory store: phoneHash → { socketId, connectedTo }
// Replace with Redis/DB for multi-instance deployments
export const peers = new Map();

// Davet jetonu ömrü (kullanıcı kararı 2026-09-14): 1 SAAT.
// Gerekçe: QR yüz yüze okutuluyor — partner zaten yanında. Kısa ömür,
// yanlış sohbete düşen bağlantının penceresini de daraltır.
// Jeton ömrü. 15 Eylül'de 1 saatti (kullanıcı kararı: "24 saat uzun").
// 19 Eylül'de 7 GÜNE çıkarıldı — telefon daveti de 7 gün oldu, aynı işlev
// iki farklı politika taşımasın (bkz. REQUEST_TTL_MS).
// ⚠️ Pencere 168 kat uzadı. Kabul edilebilir olmasının sebebi jetonun tek
// başına hiçbir şey kurmaması: partnerlik SAHİP onaylayınca doğuyor, yani
// kare sızsa bile ikinci kapı duruyor. Jeton phoneHash taşımıyor ve ham
// hâli saklanmıyor (SHA-256'sı saklanıyor).
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Geçerli roller — Dart tarafındaki `enum PartnerRole` ile BİREBİR
// (lib/features/partner/domain/partner_role.dart). Sunucu rolü saklıyor
// çünkü onay ekranında gösterilecek değerin kaynağı istemci olmamalı:
// URL'ye yazılmış rol kurcalanabilir, jetona bağlı olan kurcalanamaz.
const VALID_ROLES = new Set(['es', 'sevgili', 'anne', 'baba']);

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

    // ── Paylaşım sınırı (karar 2026-07-10) ────────────────────────────
    // Kötüye kullanım freni: bir aboneliğin arkadaş grubuna "ortak hesap"
    // olmasını engeller. SUNUCUDA zorlanır — istemcide sayı tutmak süstür.
    // Yalnız DAVET EDEN sayılır; izleyici tarafı ücretsiz ve sınırsızdır
    // (model: paylaşımı hep sahip başlatır).
    if (partnerships.countFor(requesterHash) >= PARTNER_LIMIT) {
      return reply
        .code(409)
        .send({ error: 'partner_limit_reached', limit: PARTNER_LIMIT });
    }

    // ── Premium şartı ─────────────────────────────────────────────────
    // ⚠️ VARSAYILAN KAPALI. 14 günlük deneme ve grandfather kohortu
    // İSTEMCİDE hesaplanıyor (yerel damga + Apple makbuzundaki
    // originalApplicationVersion); sunucunun o bilgisi yok. Bugün açarsak
    // deneme kullanıcısını ve erken gelen kohortu kilitleriz.
    // Açmadan önce: backend, hakkı olmayan kullanıcının
    // originalApplicationVersion'ını RevenueCat API'sinden sorup kohorttaysa
    // promotional hak tanımalı (Apple imzalı veri, istemci yalan söyleyemez).
    if (ENFORCE_PREMIUM && !entitlements.isActive(requesterHash)) {
      return reply.code(402).send({ error: 'premium_required' });
    }

    // Bekleyen isteği kalıcı sakla — partner:accept bunu doğrular (B4/B6).
    // Hedefin ONLINE OLMASI ŞART DEĞİL: çevrimdışıysa istek DB'de bekler,
    // bir sonraki bağlanışında socket.js connection handler'ı teslim eder.
    partnerRequests.create(requesterHash, partnerHash);

    // Online ise anında bildir (io instance setupSocket'te eklenir).
    const partnerPeer = peers.get(partnerHash);
    const io = fastify.io;
    if (io && partnerPeer?.socketId) {
      io.to(partnerPeer.socketId).emit('partner:request', {
        from: requesterHash,
      });
    }

    return reply.send({
      status: 'request_sent',
      online: !!partnerPeer?.socketId,
    });
  });

  // POST /api/partner/disconnect
  // Body: { partnerHash: string }
  // Partnerliği iki taraflı çözer (partnership + istekler + shares + sparks).
  // Idempotent: partnership yoksa da 200 döner (istemci tekrar-deneme kuyruğu
  // güvenle çalışsın). Karşı taraf online ise anında 'partner:removed' alır;
  // offline ise bir sonraki bağlanışında /partner/list eşitlemesi yakalar.
  fastify.post('/partner/disconnect', {
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

    const userHash = claims.sub;
    const { partnerHash } = request.body;

    const existed = partnerships.isPartner(userHash, partnerHash);
    dissolvePartnership(userHash, partnerHash);

    const partnerPeer = peers.get(partnerHash);
    const io = fastify.io;
    if (io && partnerPeer?.socketId) {
      io.to(partnerPeer.socketId).emit('partner:removed', { from: userHash });
    }

    return reply.send({ status: 'disconnected', existed });
  });

  // GET /api/partner/list
  // Çağıranın onaylı partner hash'leri. İstemci offline'dayken kabul edilen
  // istekleri yakalayıp yerel "pending" durumunu düzeltmek için kullanılır.
  fastify.get('/partner/list', async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;

    return reply.send({ partners: partnerships.listFor(claims.sub) });
  });

  // ── Jetonlu davet (QR / paylaşılabilir bağlantı) ───────────────────
  //
  // Telefon akışının aynısı, tek farkı hedefin numarasını bilme şartının
  // kalkması. ONAY YİNE İKİ TARAFLI: jeton partnerlik KURMAZ, yalnız
  // sahibe bekleyen istek bırakır (partner_requests) — partnerlik ancak
  // sahip `partner:accept` ile onaylayınca kurulur. Yani QR yeni bir
  // yetki yolu açmıyor, mevcut kapıdan geçiyor.
  //
  // İkinci kapının SAHİPTE olması bilinçli: QR'ı kimin okuyacağını jeton
  // bilemez, dolayısıyla anlamlı doğrulama "kim okudu"yu görmektir.
  // Bağlantı yanlış kişiye düşse bile sahip tanımadığı kaydı reddeder.

  // POST /api/partner/invite
  // Body: { role: 'es'|'sevgili'|'anne'|'baba' }
  // Döner: { token, expiresAt, ttlMs }
  fastify.post('/partner/invite', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['role'],
        properties: {
          role: { type: 'string', minLength: 2, maxLength: 16 },
        },
      },
    },
  }, async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;

    const inviterHash = claims.sub;
    const { role } = request.body;

    if (!VALID_ROLES.has(role)) {
      return reply.code(400).send({ error: 'invalid_role' });
    }

    // Sınır ve premium kapıları /partner/connect ile AYNI — jetonlu yol
    // bir atlatma olmamalı.
    if (partnerships.countFor(inviterHash) >= PARTNER_LIMIT) {
      return reply
        .code(409)
        .send({ error: 'partner_limit_reached', limit: PARTNER_LIMIT });
    }
    if (ENFORCE_PREMIUM && !entitlements.isActive(inviterHash)) {
      return reply.code(402).send({ error: 'premium_required' });
    }

    const { token, expiresAt } = partnerInvites.create(
      inviterHash,
      role,
      INVITE_TTL_MS,
    );
    return reply.send({ token, expiresAt, ttlMs: INVITE_TTL_MS });
  });

  // GET /api/partner/invite/:token
  // Yakmadan okur — okuyan kişi onay ekranında hangi rolle bağlanacağını
  // görsün diye. Kimlik BİLGİSİ DÖNMEZ (davet edenin hash'i sızmaz);
  // yalnız rol ve geçerlilik.
  fastify.get('/partner/invite/:token', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;

    const inv = partnerInvites.lookup(request.params.token);
    if (!inv) return reply.code(410).send({ error: 'invite_not_found' });
    if (inv.used) return reply.code(410).send({ error: 'invite_used' });
    if (inv.expiresAt <= Date.now()) {
      return reply.code(410).send({ error: 'invite_expired' });
    }
    if (inv.inviterHash === claims.sub) {
      return reply.code(400).send({ error: 'cannot_connect_to_self' });
    }

    return reply.send({ role: inv.role, expiresAt: inv.expiresAt });
  });

  // POST /api/partner/redeem
  // Body: { token }
  // Jetonu yakar ve SAHİBE bekleyen istek bırakır. Partnerlik kurulmaz.
  fastify.post('/partner/redeem', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string', minLength: 16, maxLength: 128 },
        },
      },
    },
  }, async (request, reply) => {
    const claims = authenticateRequest(request, reply);
    if (!claims) return;

    const redeemerHash = claims.sub;
    const { token } = request.body;

    const inv = partnerInvites.lookup(token);
    if (!inv) return reply.code(410).send({ error: 'invite_not_found' });
    if (inv.used) return reply.code(410).send({ error: 'invite_used' });
    if (inv.expiresAt <= Date.now()) {
      return reply.code(410).send({ error: 'invite_expired' });
    }
    if (inv.inviterHash === redeemerHash) {
      return reply.code(400).send({ error: 'cannot_connect_to_self' });
    }
    if (partnerships.isPartner(inv.inviterHash, redeemerHash)) {
      return reply.code(409).send({ error: 'already_partners' });
    }
    // Sınır DAVET EDENDE sayılır (paylaşımı hep sahip başlatır) ve burada
    // TEKRAR bakılır: jeton üretimiyle okuma arasında dolmuş olabilir.
    if (partnerships.countFor(inv.inviterHash) >= PARTNER_LIMIT) {
      return reply
        .code(409)
        .send({ error: 'partner_limit_reached', limit: PARTNER_LIMIT });
    }
    if (ENFORCE_PREMIUM && !entitlements.isActive(inv.inviterHash)) {
      return reply.code(402).send({ error: 'premium_required' });
    }

    // Yakma koşullu — aynı jetonu iki kişi okuduysa yalnız biri geçer.
    if (!partnerInvites.burn(token, redeemerHash)) {
      return reply.code(410).send({ error: 'invite_used' });
    }

    // Yön TERS: isteği okuyan bırakır, SAHİP kabul eder.
    partnerRequests.create(redeemerHash, inv.inviterHash, {
      viaInvite: true,
      role: inv.role,
    });

    const inviterPeer = peers.get(inv.inviterHash);
    const io = fastify.io;
    if (io && inviterPeer?.socketId) {
      io.to(inviterPeer.socketId).emit('partner:request', {
        from: redeemerHash,
        viaInvite: true,
        role: inv.role,
      });
    }

    // inviterHash BAŞARILI kullanımda dönüyor: okuyan kişi artık bekleyen
    // partner adayı, yerel kaydı bu hash'le kuracak. Telefon akışında da
    // kabul eden taraf `partner:request.from` ile aynı bilgiyi alıyor.
    // ⚠️ ÖN İZLEME (GET) bunu DÖNMEZ — orası jetonu yakmadan, onay
    // alınmadan okunuyor; hash'i orada vermek daveti bir hash sızdırma
    // ucuna çevirirdi.
    return reply.send({
      status: 'request_sent',
      role: inv.role,
      inviterHash: inv.inviterHash,
      inviterOnline: !!inviterPeer?.socketId,
    });
  });
}
