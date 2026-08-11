// Merkezi config — ortam değişkenlerini tek yerde doğrular.
// JWT_SECRET zorunlu: yoksa/güvensizse boot'ta çök (sessizce dev-secret'a düşme).

const JWT_SECRET = process.env.JWT_SECRET;

const INSECURE_DEFAULTS = new Set([
  'dev-secret-change-in-prod',
  'your-strong-secret-here',
  '',
]);

if (!JWT_SECRET || INSECURE_DEFAULTS.has(JWT_SECRET) || JWT_SECRET.length < 32) {
  console.error(
    'FATAL: JWT_SECRET tanımlı değil, güvensiz varsayılan ya da 32 karakterden kısa. ' +
      "Fly'da `fly secrets set JWT_SECRET=$(openssl rand -hex 32)` ile ayarlayın.",
  );
  process.exit(1);
}

// ── CORS origin politikası ──────────────────────────────────────────
// ALLOWED_ORIGINS = virgülle ayrık origin listesi.
// Production: tanımsız/boşsa boot'ta çök — '*' ile herkese açık API olmaz.
// Dev (NODE_ENV !== 'production'): kolaylık için '*' serbest.
const IS_PROD = process.env.NODE_ENV === 'production';

const _origins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

if (IS_PROD && _origins.length === 0) {
  console.error(
    'FATAL: Production ortamında ALLOWED_ORIGINS tanımlı değil. ' +
      "CORS '*' ile açık bırakılamaz. " +
      "Örn: `fly secrets set ALLOWED_ORIGINS=https://rytex.app,https://rytex.org`.",
  );
  process.exit(1);
}

// Fastify/Socket.io cors `origin` değeri: prod'da whitelist dizisi,
// dev'de liste verilmişse onu, yoksa '*'.
const CORS_ORIGIN = _origins.length > 0 ? _origins : '*';

// ── Abonelik / RevenueCat ───────────────────────────────────────────
// RevenueCat webhook'unun paylaşılan sırrı. RC panelinde webhook
// "Authorization header value" alanına aynı değer yazılır; eşleşmeyen
// istek 401 alır. Tanımsızsa webhook KAPALI (401) — açık uç bırakmaktansa
// hiç çalışmasın: aksi halde herkes istediği kullanıcıya premium yazardı.
const REVENUECAT_WEBHOOK_SECRET = process.env.REVENUECAT_WEBHOOK_SECRET || null;

// Aynı anda paylaşılabilecek partner sayısı (karar 2026-07-10).
// Gelir kaldıracı DEĞİL, kötüye kullanım freni: bir aboneliğin bir arkadaş
// grubuna "ortak hesap" olmasını engeller. Gerçek kullanıcı 1-3 kişiyle
// paylaşıyor, bu tavana çarpmıyor.
const PARTNER_LIMIT = Number(process.env.PARTNER_LIMIT || 5);

// Premium şartının SUNUCUDA zorlanıp zorlanmayacağı.
//
// ⚠️ VARSAYILAN KAPALI, bilinçli: 14 günlük deneme ve grandfather kohortu
// İSTEMCİDE hesaplanıyor (yerel damga + Apple makbuzundaki
// originalApplicationVersion). Sunucu bunları bilmiyor. Bugün açarsak
// deneme kullanıcısını ve erken gelen kohortu kilitleriz.
//
// AÇMADAN ÖNCE ŞART: backend, entitlement'ı olmayan kullanıcının
// originalApplicationVersion'ını RevenueCat API'sinden sorup (Apple imzalı,
// istemci yalan söyleyemez) kohorttaysa promotional hak tanımalı.
const ENFORCE_PREMIUM = process.env.ENFORCE_PREMIUM === 'true';

// SANDBOX ortamından gelen hakkın geçerli sayılıp sayılmayacağı.
//
// ⚠️ VARSAYILAN KAPALI ve öyle KALMALI. Sandbox satın alması Apple'ın test
// ortamında para geçmeden tamamlanır; sayarsak TestFlight'taki herkes ücretli
// özelliği bedavaya açar. Yalnız backend kapısını (ENFORCE_PREMIUM) test
// ederken geçici olarak açılır.
const ALLOW_SANDBOX_ENTITLEMENTS =
  process.env.ALLOW_SANDBOX_ENTITLEMENTS === 'true';

// RevenueCat REST API (v2) — hak durumunu kaynağından SORMAK için.
// Webhook tek başına yetmiyor: uygulama silinip kurulunca hak anonim kimliğe,
// giriş yapılınca phoneHash'e geri taşınıyor ve RC bu geri dönüş için olay
// GÖNDERMİYOR (canlıda doğrulandı 2026-08-12). Bkz. revenuecat_api.js.
//
// Anahtar `customer_information:customers:read` iznine sahip OLMALI.
// Tanımsızsa uzlaştırma sessizce devre dışı kalır — hiçbir akış kırılmaz.
const REVENUECAT_SECRET_KEY = process.env.REVENUECAT_SECRET_KEY || null;
const REVENUECAT_PROJECT_ID = process.env.REVENUECAT_PROJECT_ID || null;

export {
  JWT_SECRET,
  CORS_ORIGIN,
  REVENUECAT_WEBHOOK_SECRET,
  PARTNER_LIMIT,
  ENFORCE_PREMIUM,
  ALLOW_SANDBOX_ENTITLEMENTS,
  REVENUECAT_SECRET_KEY,
  REVENUECAT_PROJECT_ID,
};
