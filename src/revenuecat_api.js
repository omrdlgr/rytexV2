// RevenueCat REST istemcisi — hak durumunu KAYNAĞINDAN sorar.
//
// NEDEN VAR (saha bulgusu 2026-08-12):
// Webhook tek başına yetmiyor. Kullanıcı uygulamayı silip yeniden kurunca
// RevenueCat anonim kimlik üretiyor, hak oraya taşınıyor; sonra telefonla
// giriş yapınca hak phoneHash'e GERİ taşınıyor — ama RC bu geri dönüş için
// HİÇBİR OLAY GÖNDERMİYOR (canlıda doğrulandı: giriş anında webhook'a tek
// çağrı gelmedi). TRANSFER olayı geldiği durumda bile yalnız `transferred_from`
// bilgisi taşıyor; bizim işleyicimiz kaynağı kapatıp hedefi açamıyordu.
//
// Sonuç: ödeme yapmış kullanıcı sunucuda `active:0` görünüyordu. Bugün
// zararsız (ENFORCE_PREMIUM kapalı) ama kapı açıldığı gün YILLIK aboneyi
// bir sonraki yenilemeye kadar — yani bir yıla kadar — kilitlerdi.
//
// Çözüm: tahmin etmeyi bırak, sor. Girişte (ve TRANSFER'de) RC'ye gerçek
// durumu sorup yazıyoruz. RC ulaşılamazsa çağıran AKIŞ KIRILMAZ — null döner,
// mevcut satır olduğu gibi kalır.
import {
  REVENUECAT_SECRET_KEY,
  REVENUECAT_PROJECT_ID,
} from './config.js';

const BASE = 'https://api.revenuecat.com/v2';

/// İstemcideki PurchasesService.entitlementId ve webhook'takiyle aynı olmalı.
export const ENTITLEMENT_ID = 'premium';

const TIMEOUT_MS = 4000;

export function isConfigured() {
  return Boolean(REVENUECAT_SECRET_KEY && REVENUECAT_PROJECT_ID);
}

async function rcGet(path, log) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE + path, {
      headers: { Authorization: `Bearer ${REVENUECAT_SECRET_KEY}` },
      signal: ctrl.signal,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* gövdesiz/JSON olmayan yanıt */
    }
    if (res.status === 401 || res.status === 403) {
      // En olası sebep: anahtarda `customer_information:customers:read` izni yok.
      log?.error(
        { status: res.status, message: body?.message },
        'RevenueCat API yetki hatasi — anahtar izinlerini kontrol et',
      );
    }
    return { status: res.status, body };
  } catch (err) {
    log?.warn({ err: err.message, path }, 'RevenueCat API cagrisi basarisiz');
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

/// Aboneliklerden ortam ve ürün bilgisini çıkarmayı DENER.
///
/// `active_entitlements` aktiflik ve bitişi verir ama ortamı (SANDBOX /
/// PRODUCTION) vermez. Ortam bizim için kritik: sandbox satın alması para
/// geçmeden tamamlanır, üretim sayılırsa ücretli özellik bedavaya açılır
/// (bkz. db.js isActive). Bulunamazsa `null` döner ve ÇAĞIRAN yazmaz.
async function fetchSubscriptionMeta(customerId, log) {
  const r = await rcGet(
    `/projects/${encodeURIComponent(REVENUECAT_PROJECT_ID)}` +
      `/customers/${encodeURIComponent(customerId)}/subscriptions`,
    log,
  );
  if (r.status !== 200 || !Array.isArray(r.body?.items)) return null;

  // En geç biten abonelik belirleyicidir (aylıktan yıllığa geçişte ikisi de
  // listede olabilir).
  let best = null;
  for (const s of r.body.items) {
    const ends = s?.current_period_ends_at ?? s?.expires_at ?? null;
    if (best === null || (ends ?? 0) > (best.ends ?? 0)) {
      best = {
        ends,
        environment: s?.environment ?? null,
        productId: s?.product_id ?? s?.store_identifier ?? null,
        store: s?.store ?? null,
      };
    }
  }
  return best;
}

/// Bir kimliğin GERÇEK hak durumunu döndürür.
///
/// Dönüş:
///   - `null`  → BİLİNMİYOR (RC ulaşılamadı / izin yok / ortam çözülemedi).
///               Çağıran hiçbir şey YAZMAMALI; mevcut satır korunur.
///   - nesne   → yazılabilir gerçek durum.
///
/// Bilinçli asimetri: "bilmiyorum" ile "hakkı yok" ayrı şeyler. RC'ye
/// ulaşamadığımızda ödeme yapan kullanıcının hakkını silmek, hiçbir şey
/// yapmamaktan çok daha kötü.
export async function fetchEntitlement(customerId, log) {
  if (!isConfigured()) return null;

  const r = await rcGet(
    `/projects/${encodeURIComponent(REVENUECAT_PROJECT_ID)}` +
      `/customers/${encodeURIComponent(customerId)}/active_entitlements`,
    log,
  );

  // Müşteri RC'de hiç yoksa hak da yoktur — bu BİLGİDİR, belirsizlik değil.
  if (r.status === 404) {
    return {
      active: false, expiresAt: null, productId: null,
      environment: null, source: null,
    };
  }
  if (r.status !== 200 || !Array.isArray(r.body?.items)) return null;

  const ent = r.body.items.find((i) => i?.entitlement_id === ENTITLEMENT_ID);
  if (!ent) {
    // Aktif hak listesi geldi ve içinde premium YOK → hak gerçekten yok.
    return {
      active: false, expiresAt: null, productId: null,
      environment: null, source: null,
    };
  }

  const meta = await fetchSubscriptionMeta(customerId, log);
  if (!meta || !meta.environment) {
    // Ortamı bilmeden aktif hak YAZMIYORUZ — sandbox'ı üretim sayma riski.
    log?.warn(
      { customerId: customerId.slice(0, 12) },
      'RevenueCat: aktif hak var ama ortam cozulemedi, yazilmadi',
    );
    return null;
  }

  return {
    active: true,
    expiresAt: ent.expires_at ?? meta.ends ?? null,
    productId: meta.productId,
    environment: meta.environment,
    source: meta.store === 'promotional' ? 'promotional' : 'store',
  };
}
