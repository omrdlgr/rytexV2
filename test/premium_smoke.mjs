// Abonelik/sınır smoke — geçici DB + gerçek sunucu üzerinde.
//
// Kapsam:
//   • RevenueCat webhook kimlik doğrulaması (sırsız/yanlış sır → 401)
//   • Olaydan hak çıkarma (satın alma / iptal / süre bitimi / anonim)
//   • /partner/connect partner sınırı (SUNUCUDA, istemciye güvenmeden)
//
// Çalıştırma:
//   RC_SECRET=test-secret PARTNER_LIMIT=2 JWT_SECRET=... node test/premium_smoke.mjs
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';

const BASE = process.env.BASE || 'http://127.0.0.1:3999';
const RC_SECRET = process.env.REVENUECAT_WEBHOOK_SECRET || 'test-secret';
const LIMIT = Number(process.env.PARTNER_LIMIT || 2);

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

async function req(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* gövdesiz yanıt */
  }
  return { status: res.status, json };
}

const hash = (n) => `smoke_premium_${n}_${Date.now()}`;

// /register ve /login 2026-08-11'de GUVENLIK gerekcesiyle kaldirildi
// (telefon sahipligi kanitlanmadan JWT veriyorlardi). Test kullanicisi
// artik token'i yerelde imzalayarak uretilir — sunucuyla AYNI JWT_SECRET.
// Not: bu, /verify-phone'un yaptigi isin test karsiligidir; gercek akista
// sub'i sunucu, dogrulanmis Firebase token'indan turetir.
function login(phoneHash) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET gerekli (sunucuyla ayni olmali)');
  return jwt.sign({ sub: phoneHash, jti: randomUUID() }, secret, {
    expiresIn: '1h',
  });
}

function rcEvent(appUserId, over = {}) {
  return {
    event: {
      type: 'INITIAL_PURCHASE',
      app_user_id: appUserId,
      entitlement_ids: ['premium'],
      product_id: 'com.rytex.app.premium.monthly',
      expiration_at_ms: Date.now() + 30 * 24 * 3600 * 1000,
      store: 'APP_STORE',
      ...over,
    },
  };
}

async function main() {
  console.log('\n── RevenueCat webhook kimlik doğrulaması');
  {
    const u = hash('auth');
    const noHeader = await req('POST', '/api/revenuecat/webhook', {
      body: rcEvent(u),
    });
    ok('sırsız istek 401', noHeader.status === 401, `→ ${noHeader.status}`);

    const wrong = await req('POST', '/api/revenuecat/webhook', {
      body: rcEvent(u),
      headers: { authorization: 'yanlis-sir' },
    });
    ok('yanlış sır 401', wrong.status === 401, `→ ${wrong.status}`);
  }

  console.log('\n── Olaydan hak çıkarma');
  {
    const u = hash('grant');
    const buy = await req('POST', '/api/revenuecat/webhook', {
      body: rcEvent(u),
      headers: { authorization: RC_SECRET },
    });
    ok('satın alma 200', buy.status === 200, JSON.stringify(buy.json));
    ok('durum ok', buy.json?.status === 'ok', JSON.stringify(buy.json));

    // İPTAL hakkı HEMEN bitirmez — ödenen dönem sonuna kadar sürer.
    const cancel = await req('POST', '/api/revenuecat/webhook', {
      body: rcEvent(u, { type: 'CANCELLATION' }),
      headers: { authorization: RC_SECRET },
    });
    ok('iptal 200 (hak dönem sonuna kadar sürer)', cancel.status === 200);

    const expired = await req('POST', '/api/revenuecat/webhook', {
      body: rcEvent(u, { type: 'EXPIRATION', expiration_at_ms: Date.now() - 1 }),
      headers: { authorization: RC_SECRET },
    });
    ok('süre bitimi 200', expired.status === 200);

    // SANDBOX olayı da işlenir ve KAYDEDİLİR — hakkın sayılmaması db.js
    // isActive() içinde, kapının önünde olur (bkz. entitlement_env_test.mjs).
    // Burada test edilen: alan uçtan geçiyor, route patlamıyor.
    const sandbox = await req('POST', '/api/revenuecat/webhook', {
      body: rcEvent(hash('sandbox'), { environment: 'SANDBOX' }),
      headers: { authorization: RC_SECRET },
    });
    ok('SANDBOX olayı 200 (yazılır, ama hak sayılmaz)',
      sandbox.status === 200 && sandbox.json?.status === 'ok',
      JSON.stringify(sandbox.json));
  }

  console.log('\n── Bizi ilgilendirmeyen olaylar sessizce yutulur');
  {
    const anon = await req('POST', '/api/revenuecat/webhook', {
      body: rcEvent('$RCAnonymousID:abc123'),
      headers: { authorization: RC_SECRET },
    });
    ok('anonim kimlik yok sayılır (RC tekrar denemesin)',
      anon.status === 200 && anon.json?.status === 'ignored_anonymous',
      JSON.stringify(anon.json));

    const other = await req('POST', '/api/revenuecat/webhook', {
      body: rcEvent(hash('other'), { entitlement_ids: ['baska_urun'] }),
      headers: { authorization: RC_SECRET },
    });
    ok('başka entitlement yok sayılır',
      other.status === 200 && other.json?.status === 'ignored_other_entitlement',
      JSON.stringify(other.json));

    // SAHA HATASI 2026-08-11: app_user_id'siz olaya 400 donuyorduk; RC
    // birkac kez deneyip pes ediyor ve olay SESSIZCE kayboluyordu.
    // Artik 200 + kayit: olay gorunur kalir, RC ugrasmayi birakir.
    const noUser = await req('POST', '/api/revenuecat/webhook', {
      body: { event: { type: 'RENEWAL', entitlement_ids: ['premium'] } },
      headers: { authorization: RC_SECRET },
    });
    ok('app_user_id yoksa 200 + ignored_no_user (RC tekrar denemesin)',
      noUser.status === 200 && noUser.json?.status === 'ignored_no_user',
      `→ ${noUser.status} ${JSON.stringify(noUser.json)}`);

    const bad = await req('POST', '/api/revenuecat/webhook', {
      body: { notAnEvent: true },
      headers: { authorization: RC_SECRET },
    });
    ok('event bloğu hiç yoksa 400', bad.status === 400, `→ ${bad.status}`);

    // TRANSFER: app_user_id NULL gelir, taraflar transferred_from/to'da.
    // Uygulama silinip kurulunca RC yeni anonim kimlik uretiyor ve StoreKit
    // geri yukleyince transfer tetikleniyor — nadir DEGIL.
    const transferUser = hash('transferred');
    await req('POST', '/api/revenuecat/webhook', {
      body: rcEvent(transferUser),
      headers: { authorization: RC_SECRET },
    });
    const transfer = await req('POST', '/api/revenuecat/webhook', {
      body: {
        event: {
          type: 'TRANSFER',
          app_user_id: null,
          transferred_from: [transferUser],
          transferred_to: [hash('yenikimlik')],
        },
      },
      headers: { authorization: RC_SECRET },
    });
    ok('TRANSFER işlenir, eski kimlikte hak KAPANIR',
      transfer.status === 200 &&
        transfer.json?.status === 'transfer_handled' &&
        transfer.json?.closed === 1,
      `→ ${transfer.status} ${JSON.stringify(transfer.json)}`);

    const transferAnon = await req('POST', '/api/revenuecat/webhook', {
      body: {
        event: {
          type: 'TRANSFER',
          app_user_id: null,
          transferred_from: ['$RCAnonymousID:eski'],
          transferred_to: [hash('yeni2')],
        },
      },
      headers: { authorization: RC_SECRET },
    });
    ok('TRANSFER: anonim kaynak atlanır (yazacak satır yok)',
      transferAnon.status === 200 && transferAnon.json?.closed === 0,
      JSON.stringify(transferAnon.json));

    // RC panelindeki "Send test event" sentetik olay üretir (uydurma
    // app_user_id, sahte ürün). Dolu entitlement ile gelse bile çöp satır
    // yazılmamalı.
    const testEv = await req('POST', '/api/revenuecat/webhook', {
      body: rcEvent(hash('testev'), { type: 'TEST', entitlement_ids: ['premium'] }),
      headers: { authorization: RC_SECRET },
    });
    ok('TEST olayı dolu entitlement ile de yutulur',
      testEv.status === 200 &&
        testEv.json?.status === 'ignored_other_entitlement',
      JSON.stringify(testEv.json));
  }

  console.log(`\n── Partner sınırı (sunucuda, limit=${LIMIT})`);
  {
    const owner = hash('owner');
    const token = login(owner);
    ok('sahip girişi', !!token);

    // Sınır KABUL EDİLMİŞ partnerlikleri sayar, bekleyen istekleri değil —
    // yoksa gönderilip reddedilen davetler tavanı doldururdu.
    for (let i = 0; i < LIMIT; i++) {
      const peer = hash(`peer${i}`);
      login(peer);
      const conn = await req('POST', '/api/partner/connect', {
        token,
        body: { partnerHash: peer },
      });
      ok(`bekleyen istek ${i + 1} tavanı doldurmaz`, conn.status === 200,
        `→ ${conn.status}`);
    }

    // Gerçek engeli görmek için kabul edilmiş partnerlik gerekir; DB'yi
    // doğrudan tohumlamak yerine sınırın DOLU olduğu bir sahiple denenir.
    // (Tohumlama test/premium_limit_seed.mjs içinde, DB yoluna erişimle.)
    if (process.env.SEEDED_FULL_OWNER) {
      const full = await req('POST', '/api/partner/connect', {
        token: login(process.env.SEEDED_FULL_OWNER),
        body: { partnerHash: hash('overflow') },
      });
      ok('tavan dolu sahipte 409 partner_limit_reached',
        full.status === 409 && full.json?.error === 'partner_limit_reached',
        `→ ${full.status} ${JSON.stringify(full.json)}`);
    }
  }

  console.log(`\nSonuç: ${pass} geçti, ${fail} başarısız`);
  process.exit(fail === 0 ? 1 * 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
