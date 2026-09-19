// Jetonlu partner daveti (QR / paylaşılabilir bağlantı) — HTTP + socket
// duman testi.
//
// Sınanan asıl iddia: JETON TEK BAŞINA PARTNERLİK KURMAZ. Onay iki taraflı
// kalmalı — jeton yalnız SAHİBE bekleyen istek bırakır, partnerlik ancak
// sahip `partner:accept` ile onaylayınca oluşur. Bu kırılırsa QR, telefon
// akışının geçmediği bir yetki yolu açar.
//
// Sunucuyu KENDİ başlatır (geçici DB, port 3997).
//   node test/partner_invite_smoke.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';

const SECRET = 'x'.repeat(48);
const PORT = 3997;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'rytex-invite-'));
const DB_FILE = join(dir, 'test.db');

const mint = (sub) =>
  jwt.sign({ sub, jti: randomUUID() }, SECRET, { expiresIn: '1h' });

// A = SAHİP (daveti üreten), B = okuyan, C = üçüncü taraf
const A = { hash: 'a'.repeat(20) };
const B = { hash: 'b'.repeat(20) };
const C = { hash: 'c'.repeat(20) };
for (const u of [A, B, C]) u.token = mint(u.hash);

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
    DB_PATH: DB_FILE,
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

const newInvite = async (role = 'sevgili') =>
  (await req('POST', '/api/partner/invite', { token: A.token, body: { role } })).json?.token;

try {
  if (!(await waitUp())) throw new Error('sunucu ayağa kalkmadı');

  console.log('\nJETON ÜRETİMİ');
  let r = await req('POST', '/api/partner/invite', { body: { role: 'sevgili' } });
  ok('token yoksa 401', r.status === 401, `→ ${r.status}`);

  r = await req('POST', '/api/partner/invite', {
    token: A.token, body: { role: 'kuzen' },
  });
  ok('geçersiz rol 400', r.status === 400 && r.json?.error === 'invalid_role',
    `→ ${r.status} ${JSON.stringify(r.json)}`);

  r = await req('POST', '/api/partner/invite', {
    token: A.token, body: { role: 'sevgili' },
  });
  const token1 = r.json?.token;
  const ttl = r.json?.expiresAt - Date.now();
  ok('jeton üretildi (200)', r.status === 200 && typeof token1 === 'string',
    `→ ${r.status}`);
  // Politika 19 Eylül'de 1 saatten 7 GÜNE çıktı (telefon davetiyle aynı
  // ömür olsun diye). Bu satır politikayı KİLİTLER — değeri kazara
  // oynatan bir değişiklik burada düşer, nitekim düştü.
  ok('ömür ~7 gün', ttl > 6.9 * 24 * 60 * 60_000 && ttl <= 7 * 24 * 60 * 60_000,
    `→ ${ttl}ms`);

  console.log('\nHAM JETON DİSKTE DEĞİL (sızıntı sertleştirmesi)');
  {
    const probe = new Database(DB_FILE, { readonly: true });
    const rows = probe.prepare('SELECT token_hash FROM partner_invites').all();
    const hashes = rows.map((x) => x.token_hash);
    const expect = createHash('sha256').update(token1, 'utf8').digest('hex');
    ok('DB ham jetonu saklamıyor', !hashes.includes(token1));
    ok('DB sha256 hash saklıyor', hashes.includes(expect));
    probe.close();
  }

  console.log('\nÖN İZLEME (yakmadan okuma)');
  r = await req('GET', `/api/partner/invite/${token1}`, { token: B.token });
  ok('B rolü görebiliyor', r.status === 200 && r.json?.role === 'sevgili',
    `→ ${r.status} ${JSON.stringify(r.json)}`);
  ok('ön izleme kimlik SIZDIRMIYOR', r.json?.inviterHash === undefined,
    JSON.stringify(r.json));

  r = await req('GET', `/api/partner/invite/${token1}`, { token: A.token });
  ok('kendi jetonunu okuma 400', r.status === 400
    && r.json?.error === 'cannot_connect_to_self', `→ ${r.status}`);

  r = await req('GET', '/api/partner/invite/yok-boyle-bir-jeton', { token: B.token });
  ok('bilinmeyen jeton 410', r.status === 410
    && r.json?.error === 'invite_not_found', `→ ${r.status}`);

  console.log('\nKULLANMA — JETON TEK BAŞINA PARTNERLİK KURMAZ');
  r = await req('POST', '/api/partner/redeem', {
    token: A.token, body: { token: token1 },
  });
  ok('sahip kendi jetonunu kullanamaz 400', r.status === 400
    && r.json?.error === 'cannot_connect_to_self', `→ ${r.status}`);

  r = await req('POST', '/api/partner/redeem', {
    token: B.token, body: { token: token1 },
  });
  ok('B kullanır → request_sent', r.status === 200
    && r.json?.status === 'request_sent' && r.json?.role === 'sevgili',
    `→ ${r.status} ${JSON.stringify(r.json)}`);
  ok('kullanım yanıtı davet edenin hash\'ini verir (yerel kayıt için)',
    r.json?.inviterHash === A.hash, JSON.stringify(r.json));

  let lst = await req('GET', '/api/partner/list', { token: B.token });
  ok('🔴 PARTNERLİK HENÜZ YOK (B)', (lst.json?.partners || []).length === 0,
    JSON.stringify(lst.json));
  lst = await req('GET', '/api/partner/list', { token: A.token });
  ok('🔴 PARTNERLİK HENÜZ YOK (A)', (lst.json?.partners || []).length === 0,
    JSON.stringify(lst.json));

  console.log('\nTEK KULLANIMLIK');
  r = await req('POST', '/api/partner/redeem', {
    token: C.token, body: { token: token1 },
  });
  ok('aynı jeton ikinci kez 410 invite_used', r.status === 410
    && r.json?.error === 'invite_used', `→ ${r.status} ${JSON.stringify(r.json)}`);

  console.log('\nÇEVRİMDIŞI SAHİBE TESLİM (bayrak satırda mı)');
  const { io } = await import('socket.io-client');
  const sA = io(BASE, { auth: { token: A.token }, transports: ['websocket'] });
  const pending = await new Promise((res, rej) => {
    sA.on('partner:request', res);
    sA.on('connect_error', rej);
    setTimeout(() => rej(new Error('partner:request gelmedi')), 5000);
  });
  ok('yeniden bağlanışta istek teslim edildi', pending.from === B.hash,
    JSON.stringify(pending));
  ok('viaInvite bayrağı taşındı', pending.viaInvite === true,
    JSON.stringify(pending));
  ok('rol taşındı', pending.role === 'sevgili', JSON.stringify(pending));

  console.log('\nİKİNCİ KAPI: SAHİP ONAYI');
  sA.emit('partner:accept', { to: B.hash });
  await new Promise((r2) => setTimeout(r2, 500));
  lst = await req('GET', '/api/partner/list', { token: A.token });
  ok('onaydan SONRA partnerlik var', (lst.json?.partners || []).includes(B.hash),
    JSON.stringify(lst.json));

  console.log('\nSÜRESİ DOLMUŞ JETON');
  const token2 = await newInvite();
  {
    const w = new Database(DB_FILE);
    const h = createHash('sha256').update(token2, 'utf8').digest('hex');
    w.prepare('UPDATE partner_invites SET expires_at = ? WHERE token_hash = ?')
      .run(Date.now() - 1000, h);
    w.close();
  }
  r = await req('POST', '/api/partner/redeem', {
    token: C.token, body: { token: token2 },
  });
  ok('süresi geçmiş jeton 410 invite_expired', r.status === 410
    && r.json?.error === 'invite_expired', `→ ${r.status} ${JSON.stringify(r.json)}`);

  console.log('\nZATEN PARTNER');
  const token3 = await newInvite();
  r = await req('POST', '/api/partner/redeem', {
    token: B.token, body: { token: token3 },
  });
  ok('zaten partner 409', r.status === 409
    && r.json?.error === 'already_partners', `→ ${r.status}`);

  console.log('\nPARTNER SINIRI (jetonlu yol bir atlatma DEĞİL)');
  {
    const w = new Database(DB_FILE);
    const ins = w.prepare(
      'INSERT OR IGNORE INTO partnerships (a_hash, b_hash, created_at) VALUES (?, ?, ?)',
    );
    for (const x of ['d', 'e', 'f', 'g']) {
      const peer = x.repeat(20);
      const [p, q] = A.hash < peer ? [A.hash, peer] : [peer, A.hash];
      ins.run(p, q, Date.now());
    }
    w.close();
  }
  r = await req('POST', '/api/partner/invite', {
    token: A.token, body: { role: 'anne' },
  });
  ok('sınır dolunca jeton ÜRETİLMEZ 409', r.status === 409
    && r.json?.error === 'partner_limit_reached',
    `→ ${r.status} ${JSON.stringify(r.json)}`);

  sA.close();
} catch (e) {
  fail++;
  console.log('  ✗ ÇALIŞMA HATASI:', e.message);
} finally {
  srv.kill('SIGTERM');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} geçti, ${fail} kaldı\n`);
process.exit(fail === 0 ? 0 : 1);
