// RevenueCat REST istemcisi — hak durumunu KAYNAĞINDAN sorar.
//
// NEDEN VAR (saha bulgusu 2026-08-12):
// Webhook tek başına yetmiyor. Kullanıcı uygulamayı silip yeniden kurunca
// RevenueCat anonim kimlik üretiyor, hak oraya taşınıyor; sonra telefonla
// giriş yapınca hak phoneHash'e GERİ taşınıyor — ama RC bu geri dönüş için
// HİÇBİR OLAY GÖNDERMİYOR (canlıda doğrulandı: giriş anında webhook'a tek
// çağrı gelmedi). TRANSFER olayı geldiği durumda bile yalnız
// `transferred_from` bilgisi taşıyor; işleyicimiz kaynağı kapatıp hedefi
// açamıyordu.
//
// Sonuç: ödeme yapmış kullanıcı sunucuda `active:0` görünüyordu. Bugün
// zararsız (ENFORCE_PREMIUM kapalı) ama kapı açıldığı gün YILLIK aboneyi
// bir sonraki yenilemeye kadar — yani bir yıla kadar — kilitlerdi.
//
// ⚠️ ALAN ADLARI CANLI YANITTAN DOĞRULANDI (2026-08-12). İlk yazımda
// tahmin etmiştim ve ÜÇÜ DE YANLIŞTI; mock testler kendi varsayımımı
// doğruladığı için hatayı gizlemişti:
//   1. `environment` KÜÇÜK harf gelir ("sandbox") — db.js 'SANDBOX' ile
//      karşılaştırıyor, eşleşmezse sandbox hakkı ÜRETİM sayılırdı.
//   2. `active_entitlements` içindeki `entitlement_id` RC'nin İÇ kimliği
//      ("entl4922d27715"), lookup key DEĞİL — 'premium' ile karşılaştırmak
//      hiç tutmaz, her ödeme yapana "hakkı yok" derdi.
//   3. `product_id` de RC iç kimliği ("prod8eee2303c4"), mağaza kimliği
//      değil.
// Bu yüzden artık YALNIZ /subscriptions kullanılıyor: gerekli her şey
// (gives_access, ends_at, environment, store, entitlements[].lookup_key)
// orada ve anlamlı biçimde var.
import {
  REVENUECAT_SECRET_KEY,
  REVENUECAT_PROJECT_ID,
} from './config.js';

const BASE = 'https://api.revenuecat.com/v2';

/// Abonelik nesnesindeki `entitlements.items[].lookup_key` ile eşleşir —
/// istemcideki PurchasesService.entitlementId ve webhook'takiyle aynı.
export const ENTITLEMENT_LOOKUP_KEY = 'premium';

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
      // En olası sebep: anahtarda `customer_information:customers:read` yok.
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

// RC iç ürün kimliği → mağaza kimliği. Abonelik nesnesi yalnız iç kimliği
// veriyor; DB'deki product_id sütununun webhook'un yazdığıyla aynı biçimde
// olması için çözülüyor. Ürün listesi küçük ve nadiren değişir → süreç
// ömrü boyunca bir kez çekilir. Çözülemezse iç kimlik yazılır (teşhis için
// yine de faydalı), akış durmaz.
let _productMap = null;
async function resolveStoreIdentifier(rcProductId, log) {
  if (!rcProductId) return null;
  if (_productMap === null) {
    const r = await rcGet(
      `/projects/${encodeURIComponent(REVENUECAT_PROJECT_ID)}/products?limit=50`,
      log,
    );
    if (r.status === 200 && Array.isArray(r.body?.items)) {
      _productMap = new Map(
        r.body.items.map((p) => [p.id, p.store_identifier ?? null]),
      );
    } else {
      _productMap = new Map(); // tekrar tekrar denemeyelim
    }
  }
  return _productMap.get(rcProductId) ?? rcProductId;
}

/// Ortam etiketini tek biçime getirir. API "sandbox" (küçük), webhook
/// "SANDBOX" (büyük) gönderiyor; db.js tek biçim bekliyor.
function normalizeEnvironment(env) {
  if (typeof env !== 'string' || !env) return null;
  return env.toUpperCase();
}

function grantsPremium(sub) {
  const items = sub?.entitlements?.items;
  return Array.isArray(items)
    && items.some((e) => e?.lookup_key === ENTITLEMENT_LOOKUP_KEY);
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
      `/customers/${encodeURIComponent(customerId)}/subscriptions`,
    log,
  );

  const none = {
    active: false, expiresAt: null, productId: null,
    environment: null, source: null,
  };

  // Müşteri RC'de hiç yoksa hak da yoktur — bu BİLGİDİR, belirsizlik değil.
  if (r.status === 404) return none;
  if (r.status !== 200 || !Array.isArray(r.body?.items)) return null;

  // `gives_access` RC'nin kendi kararı: deneme, ödemesiz dönem ve iptal
  // sonrası kalan süre dahil. Tarihe elle bakmaktan güvenilir.
  const granting = r.body.items.filter(
    (s) => grantsPremium(s) && s?.gives_access === true,
  );
  if (granting.length === 0) return none;

  // Aylıktan yıllığa geçişte iki abonelik birden listelenir; en geç biten
  // belirleyicidir.
  const best = granting.reduce((a, b) => {
    const ea = a?.ends_at ?? a?.current_period_ends_at ?? 0;
    const eb = b?.ends_at ?? b?.current_period_ends_at ?? 0;
    return eb > ea ? b : a;
  });

  const environment = normalizeEnvironment(best.environment);
  if (!environment) {
    // Ortamı bilmeden aktif hak YAZMIYORUZ — sandbox'ı üretim sayma riski.
    log?.warn(
      { customer: customerId.slice(0, 12) },
      'RevenueCat: aktif hak var ama ortam cozulemedi, yazilmadi',
    );
    return null;
  }

  return {
    active: true,
    expiresAt: best.ends_at ?? best.current_period_ends_at ?? null,
    productId: await resolveStoreIdentifier(best.product_id, log),
    environment,
    source: best.store === 'promotional' ? 'promotional' : 'store',
  };
}
