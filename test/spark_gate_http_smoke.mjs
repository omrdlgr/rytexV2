// SPARK kapısı — HTTP seviyesinde duman testi (rota bağlantısı).
//
// db.js seviyesindeki kural `spark_gate_test.mjs`'te. Burada sınanan tek şey
// ROTA BAĞLANTISI: kapı gerçekten POST /api/spark'ta uygulanıyor mu, doğru
// durum kodu ve hata kodu dönüyor mu. Altı satırlık bir wiring ama SPARK
// yolunun sessiz kırılması 22 Ağustos'ta pahalıya patladı.
//
// Sunucuyu KENDİ başlatır (geçici DB, port 3998).
//   node test/spark_gate_http_smoke.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';

const SECRET = 'x'.repeat(48);
const PORT = 3998;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'rytex-sparkhttp-'));

const mint = (sub) =>
  jwt.sign({ sub, jti: randomUUID() }, SECRET, { expiresIn: '1h' });

const A = { hash: 'a'.repeat(20) };
const B = { hash: 'b'.repeat(20) };
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

async function req(method, path, { token, body } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await r.json(); } catch { /* gövdesiz */ }
  return { status: r.status, json };
}

try {
  if (!(await waitUp())) throw new Error('sunucu ayağa kalkmadı');

  // Partner olmadan gönderim reddedilmeli (mevcut davranış korunuyor mu).
  let r = await req('POST', '/api/spark', {
    token: A.token, body: { to: B.hash, blob: 'x' },
  });
  ok('partner değilken 403', r.status === 403, `→ ${r.status}`);

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
  const plist = await req('GET', '/api/partner/list', { token: B.token });
  ok('partnerlik kuruldu (kurulum ön şartı)',
    (plist.json?.partners || []).includes(A.hash), JSON.stringify(plist.json));

  console.log('\nBEKLEYEN-SPARK KAPISI (HTTP)');
  r = await req('POST', '/api/spark', {
    token: A.token, body: { to: B.hash, blob: 'blob1' },
  });
  ok('ilk SPARK kabul edilir (201)', r.status === 201, `→ ${r.status}`);
  const id = r.json?.id;

  r = await req('POST', '/api/spark', {
    token: A.token, body: { to: B.hash, blob: 'blob2' },
  });
  ok('ikinci SPARK 409 spark_pending',
    r.status === 409 && r.json?.error === 'spark_pending',
    `→ ${r.status} ${JSON.stringify(r.json)}`);

  console.log('\nKAÇIŞ DELİĞİ KAPALI');
  r = await req('POST', '/api/spark/delete', { token: A.token, body: { id } });
  ok('bekleyen SPARK SİLİNEMEZ (409)',
    r.status === 409 && r.json?.error === 'spark_pending',
    `→ ${r.status} ${JSON.stringify(r.json)}`);

  r = await req('POST', '/api/spark', {
    token: A.token, body: { to: B.hash, blob: 'blob3' },
  });
  ok('silme denemesinden sonra da kapı kapalı', r.status === 409,
    `→ ${r.status}`);

  console.log('\nCEVAP KAPIYI AÇAR');
  r = await req('POST', '/api/spark/respond', {
    token: B.token, body: { id, status: 'accepted' },
  });
  ok('B cevap verir (200)', r.status === 200, `→ ${r.status}`);

  r = await req('POST', '/api/spark', {
    token: A.token, body: { to: B.hash, blob: 'blob4' },
  });
  ok('cevaptan sonra yeni SPARK gider (201)', r.status === 201,
    `→ ${r.status}`);

  console.log('\nCEVAPLANMIŞ KAYIT SİLİNEBİLİR (eski istemci uyumu)');
  r = await req('POST', '/api/spark/delete', { token: A.token, body: { id } });
  ok('cevaplanmış kayıt silinir (200)', r.status === 200, `→ ${r.status}`);

  sB.close();
} catch (e) {
  fail++;
  console.log('  ✗ ÇALIŞMA HATASI:', e.message);
} finally {
  srv.kill('SIGTERM');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} geçti, ${fail} kaldı\n`);
process.exit(fail === 0 ? 0 : 1);
