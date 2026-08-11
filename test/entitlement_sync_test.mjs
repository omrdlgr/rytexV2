// Hak uzlaştırması — RevenueCat API cevabından DB'ye yazma kararı.
//
// ⚠️ BU DOSYADAKİ SAHTE YANITLAR CANLI API'DEN KOPYALANDI (2026-08-12).
// İlk sürümde şekli TAHMİN etmiştim; mock'lar kendi varsayımımı doğruladığı
// için üç hata birden testlerden geçmişti:
//   • environment KÜÇÜK harf ("sandbox") gelir → 'SANDBOX' ile birebir
//     karşılaştırma tutmaz, sandbox hakkı ÜRETİM sayılırdı
//   • entitlement_id RC'nin İÇ kimliğidir ("entl…"), 'premium' değil
//   • product_id de iç kimliktir ("prod…"), mağaza kimliği değil
// Ders: mock'u gerçek yanıttan üret, aklından değil.
//
// Kritik ayrım: "BİLİNMİYOR" ile "HAKKI YOK" aynı şey değil. RC'ye
// ulaşamadığımızda ödeme yapan kullanıcının hakkını silmek, hiçbir şey
// yapmamaktan çok daha kötü.
//
// Çalıştırma: node test/entitlement_sync_test.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JWT_SECRET ||= 'x'.repeat(48);
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'rytex-sync-')), 't.db');
process.env.REVENUECAT_SECRET_KEY = 'test-key';
process.env.REVENUECAT_PROJECT_ID = 'projtest';

const { entitlements } = await import('../src/db.js');
const { reconcileEntitlement } = await import('../src/entitlement_sync.js');

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

const realFetch = globalThis.fetch;
function mockFetch(routes) {
  globalThis.fetch = async (url) => {
    for (const [frag, r] of Object.entries(routes)) {
      if (String(url).includes(frag)) {
        return { status: r.status, json: async () => r.body };
      }
    }
    return { status: 404, json: async () => ({}) };
  };
}

const future = Date.now() + 30 * 24 * 3600 * 1000;

// Canlı yanıttan kopyalanmış abonelik nesnesi (kısaltılmış).
function sub(over = {}) {
  return {
    auto_renewal_status: 'will_renew',
    country: 'TR',
    current_period_ends_at: future,
    ends_at: future,
    entitlements: {
      items: [{ id: 'entl4922d27715', lookup_key: 'premium', state: 'active' }],
      object: 'list',
    },
    environment: 'production',
    gives_access: true,
    object: 'subscription',
    ownership: 'purchased',
    product_id: 'prod8eee2303c4',
    status: 'active',
    store: 'app_store',
    ...over,
  };
}

const PRODUCTS = {
  items: [
    { id: 'prod8eee2303c4', store_identifier: 'com.rytex.app.premium.yearly' },
    { id: 'prod76e258b0d5', store_identifier: 'com.rytex.app.premium.monthly' },
  ],
};

console.log('\n── Hak uzlaştırması (gerçek API şekliyle)');

// 1) Mutlu yol.
mockFetch({
  '/subscriptions': { status: 200, body: { items: [sub()] } },
  '/products': { status: 200, body: PRODUCTS },
});
await reconcileEntitlement('user_happy', null);
const happy = entitlements.get('user_happy');
ok('üretim aboneliği yazılır ve geçerli sayılır',
  happy?.active === true && entitlements.isActive('user_happy') === true,
  JSON.stringify(happy));
ok('ortam BÜYÜK harfe normalize edilir',
  happy?.environment === 'PRODUCTION', happy?.environment);
ok('product_id mağaza kimliğine çözülür (iç kimlik değil)',
  happy?.productId === 'com.rytex.app.premium.yearly', happy?.productId);
ok('bitiş ends_at alanından okunur',
  happy?.expiresAt === future, String(happy?.expiresAt));

// 2) SANDBOX küçük harf gelir — üretim SAYILMAMALI.
mockFetch({
  '/subscriptions': { status: 200, body: { items: [sub({ environment: 'sandbox' })] } },
  '/products': { status: 200, body: PRODUCTS },
});
await reconcileEntitlement('user_sandbox', null);
ok('küçük harf "sandbox" yazılır ama hak SAYILMAZ',
  entitlements.get('user_sandbox')?.environment === 'SANDBOX' &&
  entitlements.isActive('user_sandbox') === false,
  JSON.stringify(entitlements.get('user_sandbox')));

// 3) gives_access=false → hak yok (süresi dolmuş abonelik listede kalır).
mockFetch({
  '/subscriptions': {
    status: 200,
    body: { items: [sub({ gives_access: false, status: 'expired' })] },
  },
});
await reconcileEntitlement('user_expired', null);
ok('gives_access=false → hak yok', entitlements.isActive('user_expired') === false);

// 4) Başka entitlement → bizi ilgilendirmez.
mockFetch({
  '/subscriptions': {
    status: 200,
    body: { items: [sub({ entitlements: { items: [{ lookup_key: 'baska' }] } })] },
  },
});
await reconcileEntitlement('user_other', null);
ok('premium olmayan hak sayılmaz', entitlements.isActive('user_other') === false);

// 5) İki abonelik (aylık→yıllık geçişi): en geç biten kazanır.
const later = future + 86400000;
mockFetch({
  '/subscriptions': {
    status: 200,
    body: {
      items: [
        sub({ ends_at: future, product_id: 'prod76e258b0d5' }),
        sub({ ends_at: later, product_id: 'prod8eee2303c4' }),
      ],
    },
  },
  '/products': { status: 200, body: PRODUCTS },
});
await reconcileEntitlement('user_two', null);
ok('iki abonelikte en geç biten kazanır',
  entitlements.get('user_two')?.expiresAt === later,
  JSON.stringify(entitlements.get('user_two')));

// 6) RC ulaşılamıyor → BİLİNMİYOR, mevcut satıra DOKUNULMAZ.
entitlements.upsert({
  phoneHash: 'user_paid', active: true, expiresAt: future,
  productId: 'p', source: 'store', eventType: 'RENEWAL',
  environment: 'PRODUCTION',
});
mockFetch({ '/subscriptions': { status: 500, body: null } });
await reconcileEntitlement('user_paid', null);
ok('RC 500 → ödeme yapanın hakkı SİLİNMEZ',
  entitlements.isActive('user_paid') === true);

mockFetch({ '/subscriptions': { status: 403, body: { message: 'permission' } } });
await reconcileEntitlement('user_paid', null);
ok('403 (anahtar izni yok) → hak SİLİNMEZ',
  entitlements.isActive('user_paid') === true);

// 7) 404 → BİLGİ, hak gerçekten yok.
mockFetch({ '/subscriptions': { status: 404, body: {} } });
await reconcileEntitlement('user_paid', null);
ok('404 (müşteri yok) → hak kapatılır',
  entitlements.isActive('user_paid') === false);

// 8) Ortam alanı hiç yoksa aktif hak YAZILMAZ.
mockFetch({
  '/subscriptions': { status: 200, body: { items: [sub({ environment: null })] } },
  '/products': { status: 200, body: PRODUCTS },
});
await reconcileEntitlement('user_no_env', null);
ok('ortam yoksa aktif hak YAZILMAZ',
  entitlements.get('user_no_env') === undefined);

// 9) Ağ hatası yutulur — giriş akışı kırılmaz.
globalThis.fetch = async () => { throw new Error('ag yok'); };
let threw = false;
try { await reconcileEntitlement('user_paid', null); } catch { threw = true; }
ok('ağ hatası throw ETMEZ (giriş kırılmaz)', threw === false);

globalThis.fetch = realFetch;
console.log(`\nSonuç: ${pass} geçti, ${fail} başarısız`);
process.exit(fail === 0 ? 0 : 1);
