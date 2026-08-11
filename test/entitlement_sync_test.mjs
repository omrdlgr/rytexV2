// Hak uzlaştırması — RevenueCat API cevabından DB'ye yazma kararı.
//
// Kritik ayrım: "BİLİNMİYOR" ile "HAKKI YOK" aynı şey değil. RC'ye
// ulaşamadığımızda ödeme yapan kullanıcının hakkını silmek, hiçbir şey
// yapmamaktan çok daha kötü. Bu dosya o asimetriyi kilitler.
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

// fetch'i taklit et: yol → yanıt.
const realFetch = globalThis.fetch;
function mockFetch(routes) {
  globalThis.fetch = async (url) => {
    for (const [frag, r] of Object.entries(routes)) {
      if (String(url).includes(frag)) {
        return {
          status: r.status,
          json: async () => r.body,
        };
      }
    }
    return { status: 404, json: async () => ({}) };
  };
}

const future = Date.now() + 30 * 24 * 3600 * 1000;
const activeEnt = { items: [{ entitlement_id: 'premium', expires_at: future }] };

console.log('\n── Hak uzlaştırması');

// 1) Mutlu yol: aktif hak + ortam biliniyor → yazılır.
mockFetch({
  'active_entitlements': { status: 200, body: activeEnt },
  '/subscriptions': {
    status: 200,
    body: { items: [{ environment: 'PRODUCTION', product_id: 'com.rytex.app.premium.yearly', store: 'app_store', current_period_ends_at: future }] },
  },
});
await reconcileEntitlement('user_happy', null);
const happy = entitlements.get('user_happy');
ok('aktif hak + ortam bilinir → yazılır',
  happy?.active === true && happy?.environment === 'PRODUCTION' &&
  happy?.eventType === 'API_RECONCILE',
  JSON.stringify(happy));
ok('geçerli sayılır', entitlements.isActive('user_happy') === true);

// 2) RC ulaşılamıyor → BİLİNMİYOR. Mevcut satıra DOKUNULMAZ.
entitlements.upsert({
  phoneHash: 'user_paid', active: true, expiresAt: future,
  productId: 'p', source: 'store', eventType: 'RENEWAL',
  environment: 'PRODUCTION',
});
mockFetch({ 'active_entitlements': { status: 500, body: null } });
await reconcileEntitlement('user_paid', null);
ok('RC 500 → ödeme yapan kullanıcının hakkı SİLİNMEZ',
  entitlements.isActive('user_paid') === true,
  JSON.stringify(entitlements.get('user_paid')));

// 3) Yetki hatası (izin verilmemiş anahtar) → yine BİLİNMİYOR.
mockFetch({ 'active_entitlements': { status: 403, body: { message: 'permission' } } });
await reconcileEntitlement('user_paid', null);
ok('403 (anahtar izni yok) → hak SİLİNMEZ',
  entitlements.isActive('user_paid') === true);

// 4) Müşteri RC'de yok (404) → bu BİLGİ, hak gerçekten yok.
mockFetch({ 'active_entitlements': { status: 404, body: {} } });
await reconcileEntitlement('user_paid', null);
ok('404 (müşteri yok) → hak kapatılır (belirsizlik değil, bilgi)',
  entitlements.isActive('user_paid') === false,
  JSON.stringify(entitlements.get('user_paid')));

// 5) Aktif hak listesi geldi ama premium yok → hak yok.
mockFetch({ 'active_entitlements': { status: 200, body: { items: [{ entitlement_id: 'baska' }] } } });
await reconcileEntitlement('user_other', null);
ok('listede premium yok → hak yok', entitlements.isActive('user_other') === false);

// 6) Aktif hak var ama ORTAM çözülemiyor → YAZMA.
//    Sandbox'ı üretim sanıp ücretli özelliği bedavaya açma riski.
mockFetch({
  'active_entitlements': { status: 200, body: activeEnt },
  '/subscriptions': { status: 200, body: { items: [{ product_id: 'p' }] } },
});
await reconcileEntitlement('user_unknown_env', null);
ok('ortam çözülemezse aktif hak YAZILMAZ',
  entitlements.get('user_unknown_env') === undefined,
  JSON.stringify(entitlements.get('user_unknown_env')));

// 7) SANDBOX ortamı yazılır ama hak SAYILMAZ (db.js kapısı).
mockFetch({
  'active_entitlements': { status: 200, body: activeEnt },
  '/subscriptions': { status: 200, body: { items: [{ environment: 'SANDBOX', product_id: 'p', store: 'app_store' }] } },
});
await reconcileEntitlement('user_sandbox', null);
ok('SANDBOX yazılır ama geçerli SAYILMAZ',
  entitlements.get('user_sandbox')?.environment === 'SANDBOX' &&
  entitlements.isActive('user_sandbox') === false);

// 8) fetch throw ederse yutulur — çağıran akış (giriş) kırılmaz.
globalThis.fetch = async () => { throw new Error('ag yok'); };
let threw = false;
try { await reconcileEntitlement('user_paid', null); } catch { threw = true; }
ok('ağ hatası throw ETMEZ (giriş kırılmaz)', threw === false);

globalThis.fetch = realFetch;
console.log(`\nSonuç: ${pass} geçti, ${fail} başarısız`);
process.exit(fail === 0 ? 0 : 1);
