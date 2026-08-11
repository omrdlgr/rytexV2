// SANDBOX hakkı ücretli özelliği AÇMAMALI — db.js seviyesinde doğrudan test.
//
// Neden ayrı dosya: `isActive()` kararı HTTP'den gözlenemiyor (kapı yalnız
// ENFORCE_PREMIUM açıkken devrede). Burada db.js doğrudan import edilir,
// geçici bir DB dosyası üzerinde çalışır.
//
// İKİ KEZ koşar — bayrak modül yüklenirken okunduğu için ayrı süreç şart:
//   node test/entitlement_env_test.mjs
//   ALLOW_SANDBOX_ENTITLEMENTS=true node test/entitlement_env_test.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JWT_SECRET ||= 'x'.repeat(48); // config.js boot guard'ı
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'rytex-ent-')), 'test.db');

const { entitlements } = await import('../src/db.js');

const ALLOW = process.env.ALLOW_SANDBOX_ENTITLEMENTS === 'true';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

const future = Date.now() + 30 * 24 * 3600 * 1000;
const row = (phoneHash, environment, over = {}) => ({
  phoneHash,
  active: true,
  expiresAt: future,
  productId: 'com.rytex.app.premium.monthly',
  source: 'store',
  eventType: 'INITIAL_PURCHASE',
  environment,
  ...over,
});

console.log(`\n── Ortam ayrımı (ALLOW_SANDBOX_ENTITLEMENTS=${ALLOW})`);

entitlements.upsert(row('prod_user', 'PRODUCTION'));
ok('PRODUCTION hakkı geçerli', entitlements.isActive('prod_user') === true);

entitlements.upsert(row('sandbox_user', 'SANDBOX'));
ok(
  'SANDBOX satırı YAZILIR (teşhis için görünür kalır)',
  entitlements.get('sandbox_user')?.environment === 'SANDBOX',
  JSON.stringify(entitlements.get('sandbox_user')),
);
ok(
  ALLOW
    ? 'SANDBOX hakkı bayrak AÇIKken sayılır'
    : 'SANDBOX hakkı SAYILMAZ (bedava premium yok)',
  entitlements.isActive('sandbox_user') === ALLOW,
  `→ ${entitlements.isActive('sandbox_user')}`,
);

// Sütun eklenmeden önce yazılmış satırlar: environment NULL. Bunlar
// "bilinmiyor" ve üretim sayılır — hepsi bizim kendi testimizdi, canlıda
// ödeyen kullanıcıyı NULL diye kilitlemek daha kötü olurdu.
entitlements.upsert(row('legacy_user', null));
ok(
  'environment NULL (eski satır) üretim sayılır',
  entitlements.isActive('legacy_user') === true,
);

// Ortam ayrımı süre kontrolünü EZMEZ — süresi dolmuş üretim hakkı yine kapalı.
entitlements.upsert(row('expired_prod', 'PRODUCTION', { expiresAt: Date.now() - 1 }));
ok(
  'süresi dolmuş PRODUCTION hakkı kapalı',
  entitlements.isActive('expired_prod') === false,
);

// active=false gelen sandbox olayı her hâlükârda kapalı.
entitlements.upsert(row('sandbox_expired', 'SANDBOX', { active: false }));
ok(
  'active=false SANDBOX her durumda kapalı',
  entitlements.isActive('sandbox_expired') === false,
);

// Ortam sonradan değişebilir (aynı kimlik önce sandbox test, sonra gerçek
// satın alma): upsert son olayın ortamını yazmalı, eski değer yapışmamalı.
entitlements.upsert(row('promoted_user', 'SANDBOX'));
entitlements.upsert(row('promoted_user', 'PRODUCTION'));
ok(
  'SANDBOX → PRODUCTION geçişinde hak açılır',
  entitlements.isActive('promoted_user') === true &&
    entitlements.get('promoted_user').environment === 'PRODUCTION',
);

console.log(`\nSonuç: ${pass} geçti, ${fail} başarısız`);
process.exit(fail === 0 ? 0 : 1);
