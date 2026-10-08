// /partner/list `premium` alanı — HTTP duman testi.
//
// Kural (karar 2026-10-09): partnerlik, iki ucundan BİRİ premium ise açık.
// İstemci karşı tarafın SUNUCUDAKİ hakkını bu alandan öğreniyor. Sınananlar:
//   • `partners` dizisi hâlâ düz hash listesi (eski istemciler cast<String>()
//     ile okuyor — biçim değişirse onlar kırılır)
//   • ödeyen partner listede görünür, ödemeyen görünmez
//   • kişi kendi hakkını bu listede görmez (yalnız partnerlerininki)
//   • SANDBOX hakkı sayılmaz
//   • süresi biten hak listeden düşer
//
// Sunucuyu KENDİ başlatır (geçici DB, port 3996).
//   node test/partner_list_premium_smoke.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

const SECRET = 'x'.repeat(48);
const RC = 'test-webhook-secret';
const PORT = 3996;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'rytex-listprem-'));

const mint = (sub) =>
  jwt.sign({ sub, jti: randomUUID() }, SECRET, { expiresIn: '1h' });

const A = { hash: 'c'.repeat(20) }; // sahip
const B = { hash: 'd'.repeat(20) }; // izleyici
A.token = mint(A.hash);
B.token = mint(B.hash);

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

const srv = spawn('node', ['src/index.js'], {
  env: {
    ...process.env,
    JWT_SECRET: SECRET,
    PORT: String(PORT),
    DB_PATH: join(dir, 'test.db'),
    NODE_ENV: 'development',
    REVENUECAT_WEBHOOK_SECRET: RC,
    // RC REST uzlaştırması bu testte kapalı kalsın (ağa çıkmasın).
    REVENUECAT_SECRET_KEY: '',
    ALLOW_SANDBOX_ENTITLEMENTS: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stderr.on('data', (d) => {
  const s = d.toString();
  if (/error|Error/.test(s)) process.stderr.write(s);
});

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch { /* henüz ayakta değil */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function req(method, path, { token, body, headers = {} } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await r.json(); } catch { /* gövdesiz */ }
  return { status: r.status, json };
}

const webhook = (appUserId, over = {}) =>
  req('POST', '/api/revenuecat/webhook', {
    headers: { authorization: RC },
    body: {
      event: {
        type: 'INITIAL_PURCHASE',
        app_user_id: appUserId,
        entitlement_ids: ['premium'],
        product_id: 'com.rytex.app.premium.monthly',
        expiration_at_ms: Date.now() + 30 * 24 * 3600 * 1000,
        store: 'APP_STORE',
        environment: 'PRODUCTION',
        ...over,
      },
    },
  });

const list = async (u) => (await req('GET', '/api/partner/list', { token: u.token })).json;

try {
  if (!(await waitUp())) throw new Error('sunucu ayağa kalkmadı');

  // Partnerlik kur: A istek atar, B kabul eder.
  await req('POST', '/api/partner/connect', {
    token: A.token, body: { partnerHash: B.hash },
  });
  const { io } = await import('socket.io-client');
  const sB = io(BASE, { auth: { token: B.token }, transports: ['websocket'] });
  await new Promise((res, rej) => {
    sB.on('connect', res);
    sB.on('connect_error', rej);
    setTimeout(() => rej(new Error('socket bağlanmadı')), 5000);
  });
  sB.emit('partner:accept', { to: A.hash });
  await new Promise((r2) => setTimeout(r2, 500));
  sB.close();

  console.log('\nBİÇİM (eski istemci uyumu)');
  let a = await list(A);
  let b = await list(B);
  ok('partnerlik kuruldu', (a?.partners || []).includes(B.hash), JSON.stringify(a));
  ok('partners hâlâ düz hash dizisi',
    Array.isArray(a?.partners) && a.partners.every((x) => typeof x === 'string'),
    JSON.stringify(a));
  ok('premium alanı dizi', Array.isArray(a?.premium), JSON.stringify(a));

  console.log('\nKİMSE ÖDEMEDİ');
  ok('A tarafında premium boş', a.premium.length === 0, JSON.stringify(a));
  ok('B tarafında premium boş', b.premium.length === 0, JSON.stringify(b));

  console.log('\nİZLEYİCİ (B) ÖDEDİ');
  let w = await webhook(B.hash);
  ok('webhook 200', w.status === 200, JSON.stringify(w.json));
  a = await list(A);
  b = await list(B);
  ok('sahip, izleyicisinin hakkını görür', a.premium.includes(B.hash), JSON.stringify(a));
  ok('kişi kendi hakkını bu listede görmez', !b.premium.includes(B.hash), JSON.stringify(b));
  ok('ödemeyen sahip listede yok', !b.premium.includes(A.hash), JSON.stringify(b));

  console.log('\nSANDBOX SAYILMAZ');
  w = await webhook(A.hash, { environment: 'SANDBOX' });
  ok('sandbox webhook 200', w.status === 200, JSON.stringify(w.json));
  b = await list(B);
  ok('sandbox hakkı premium sayılmaz', !b.premium.includes(A.hash), JSON.stringify(b));

  console.log('\nSÜRE BİTİMİ');
  w = await webhook(B.hash, { type: 'EXPIRATION', expiration_at_ms: Date.now() - 1 });
  ok('expiration webhook 200', w.status === 200, JSON.stringify(w.json));
  a = await list(A);
  ok('süresi biten hak listeden düşer', !a.premium.includes(B.hash), JSON.stringify(a));
} catch (e) {
  fail++;
  console.log('  ✗ test çöktü:', e.message);
} finally {
  srv.kill();
}

console.log(`\n${pass} geçti, ${fail} kaldı`);
process.exit(fail ? 1 : 0);
