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

export { JWT_SECRET, CORS_ORIGIN };
