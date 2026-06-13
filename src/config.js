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

export { JWT_SECRET };
