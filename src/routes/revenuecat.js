import { entitlements } from '../db.js';
import { REVENUECAT_WEBHOOK_SECRET } from '../config.js';

/// Uygulamanın umursadığı tek entitlement — istemcideki
/// PurchasesService.entitlementId ile birebir aynı olmalı.
const ENTITLEMENT_ID = 'premium';

/// RevenueCat anonim kullanıcı kimliği öneki. Giriş yapmamış kullanıcı bu
/// kimlikle görünür; partner özellikleri zaten telefon doğrulaması istediği
/// için anonim satın almanın burada karşılığı yok — kullanıcı giriş yapınca
/// RevenueCat kimliği phoneHash'e taşır ve yeni olay düşer.
const ANON_PREFIX = '$RCAnonymousID:';

/// Olaydan "hak şu an geçerli mi" kararını çıkarır.
///
/// Tip listesine göre dallanmak kırılgan (RC yeni tip ekleyebilir); bunun
/// yerine BİTİŞ ZAMANINA bakılır. İptal (CANCELLATION) hakkı hemen bitirmez
/// — kullanıcı ödediği dönemin sonuna kadar kullanır; RC bunu expiration
/// alanında zaten doğru veriyor.
export function decideActive(event, now = Date.now()) {
  // RC panelindeki "Send test event" sentetik bir olay üretir: uydurma
  // app_user_id (düz UUID), sahte ürün. Şu an entitlement_ids boş geldiği
  // için zaten yutuluyor ama RC dolu bir TEST olayı gönderirse veritabanına
  // çöp satır yazardık — tipi açıkça eliyoruz.
  if (event?.type === 'TEST') return null;

  const ids = event?.entitlement_ids;
  const mentionsPremium = Array.isArray(ids)
    ? ids.includes(ENTITLEMENT_ID)
    : event?.entitlement_id === ENTITLEMENT_ID;
  if (!mentionsPremium) return null; // bizi ilgilendirmeyen ürün

  if (event.type === 'EXPIRATION' || event.type === 'SUBSCRIPTION_PAUSED') {
    return false;
  }
  // TRANSFER: hak başka kimliğe taşındı — bu kimlikte artık yok.
  if (event.type === 'TRANSFER') return false;

  const exp = event.expiration_at_ms;
  if (exp == null) return true; // süresiz (ömür boyu / promotional)
  return exp > now;
}

export default async function revenuecatRoutes(fastify) {
  // POST /api/revenuecat/webhook
  //
  // RevenueCat panelinde Integrations > Webhooks ile kurulur; "Authorization
  // header value" alanına REVENUECAT_WEBHOOK_SECRET yazılır.
  //
  // GÜVENLİK: sır tanımlı değilse uç KAPALI (401). Açık bırakmak, herkesin
  // istediği phoneHash'e premium yazabilmesi demekti.
  fastify.post('/revenuecat/webhook', {
    config: {
      // RC yeniden deneme yapar; global 100/dk sınırı olayları düşürmesin.
      rateLimit: { max: 300, timeWindow: '1 minute' },
    },
  }, async (request, reply) => {
    if (!REVENUECAT_WEBHOOK_SECRET) {
      request.log.warn('RevenueCat webhook kapalı: sır tanımlı değil');
      return reply.code(401).send({ error: 'webhook_disabled' });
    }
    if (request.headers.authorization !== REVENUECAT_WEBHOOK_SECRET) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const event = request.body?.event;
    if (!event || typeof event !== 'object') {
      return reply.code(400).send({ error: 'bad_event' });
    }

    // TRANSFER: hak bir kimlikten digerine tasindi. Bu olayda `app_user_id`
    // NULL gelir; taraflar `transferred_from` / `transferred_to` dizilerinde.
    //
    // SAHA HATASI 2026-08-11: bu olay `bad_event` sayilip 400 doniyordu.
    // Sonucu sessiz ve kotu: RC birkac kez deneyip pes eder, ESKI kimlikte
    // hak acik kalir, YENI kimlikte acilmaz — abonelik sunucuda yanlis
    // kiside gorunur. Uygulama silinip yeniden kurulunca RC anonim kimlik
    // uretiyor ve StoreKit satin almayi geri yukleyince transfer tetikleniyor,
    // yani NADIR degil.
    if (event.type === 'TRANSFER') {
      const from = Array.isArray(event.transferred_from)
        ? event.transferred_from
        : [];
      let closed = 0;
      for (const id of from) {
        if (typeof id !== 'string' || id.startsWith(ANON_PREFIX)) continue;
        // Hak artik bu kimlikte DEGIL. Bitis/urun bilgisi tasinmadigi icin
        // yalnizca kapatiyoruz; yeni sahibin hakki kendi olayiyla gelir.
        entitlements.upsert({
          phoneHash: id,
          active: false,
          expiresAt: null,
          productId: null,
          source: null,
          eventType: 'TRANSFER',
        });
        closed++;
      }
      request.log.info({ closed }, 'RevenueCat TRANSFER islendi');
      return reply.send({ status: 'transfer_handled', closed });
    }

    if (typeof event.app_user_id !== 'string') {
      // Bilmedigimiz bir sekil. 400 dondurmek RC'yi tekrar tekrar denemeye
      // sokar; 200 + kayit birakmak dogru — olay kaybolmaz, gorunur olur.
      request.log.warn(
        { type: event.type, keys: Object.keys(event).slice(0, 12) },
        'RevenueCat olayinda app_user_id yok',
      );
      return reply.send({ status: 'ignored_no_user' });
    }

    const appUserId = event.app_user_id;
    if (appUserId.startsWith(ANON_PREFIX)) {
      // Anonim kimliğe yazacak yerimiz yok; kullanıcı giriş yapınca RC
      // hakkı phoneHash'e taşır ve yeni olay gelir. 200 dön ki RC tekrar
      // tekrar denemesin.
      return reply.send({ status: 'ignored_anonymous' });
    }

    const active = decideActive(event);
    if (active === null) {
      return reply.send({ status: 'ignored_other_entitlement' });
    }

    entitlements.upsert({
      phoneHash: appUserId,
      active,
      expiresAt: event.expiration_at_ms ?? null,
      productId: event.product_id ?? null,
      source: event.store === 'PROMOTIONAL' ? 'promotional' : 'store',
      eventType: event.type ?? null,
    });

    request.log.info(
      { type: event.type, active },
      'RevenueCat entitlement güncellendi',
    );
    return reply.send({ status: 'ok' });
  });
}
