// DELETE /api/account smoke — geçici DB + gerçek sunucu üzerinde.
import { io as ioClient } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';

// /register ve /login 2026-08-11'de GUVENLIK gerekcesiyle kaldirildi
// (telefon sahipligi kanitlanmadan JWT veriyorlardi). Test kullanicisinin
// token'i artik yerelde imzalanir — sunucuyla AYNI JWT_SECRET gerekir.
function mintToken(phoneHash) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET gerekli (sunucuyla ayni olmali)');
  return jwt.sign({ sub: phoneHash, jti: randomUUID() }, secret, {
    expiresIn: '1h',
  });
}

const BASE = process.env.BASE || 'http://127.0.0.1:3999';
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

async function req(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* boş gövde */
  }
  return { status: res.status, json };
}

function connect(token) {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE, { auth: { token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket timeout')), 5000);
  });
}

// Her koşuda taze hash — test yeniden çalıştırılabilir olsun.
import { randomBytes } from 'node:crypto';
const rnd = () => randomBytes(32).toString('hex');
const A = { hash: rnd(), pw: 'passwordA123' };
const B = { hash: rnd(), pw: 'passwordB123' };

console.log('DELETE /api/account smoke\n');

const health = await req('GET', '/health');
ok('health 200', health.status === 200, JSON.stringify(health));

// 1. İki kullanıcı
A.token = mintToken(A.hash);
B.token = mintToken(B.hash);
ok('A token üretildi', !!A.token);
ok('B token üretildi', !!B.token);
// Kullanıcı satırı sunucuda ilk yetkili istekte gerekmiyor; partnerlik ve
// paylaşım akışı hash üzerinden ilerliyor.

// 2. Ortak anahtarlar (doğrulaması partnerlik kurulduktan sonra — /keys/:hash
//    yalnız gerçek partnere açık)
await req('PUT', '/api/keys', { token: A.token, body: { publicKey: 'A'.repeat(44) } });
await req('PUT', '/api/keys', { token: B.token, body: { publicKey: 'B'.repeat(44) } });

// 3. Partnerlik kur: A istek → B soketten kabul
const sockA = await connect(A.token);
const sockB = await connect(B.token);
const removedOnB = new Promise((resolve) => sockB.on('partner:removed', resolve));

await req('POST', '/api/partner/connect', { token: A.token, body: { partnerHash: B.hash } });
await new Promise((resolve) => {
  sockB.emit('partner:accept', { to: A.hash });
  setTimeout(resolve, 400);
});
const listBefore = await req('GET', '/api/partner/list', { token: B.token });
ok('partnerlik kuruldu (B listesinde A var)', (listBefore.json?.partners || []).includes(A.hash), JSON.stringify(listBefore));

const keyBefore = await req('GET', `/api/keys/${A.hash}`, { token: B.token });
ok("silme öncesi A'nın ortak anahtarı sunucuda", keyBefore.status === 200, JSON.stringify(keyBefore));

// 4. Şifreli paylaşım kutusu + SPARK + push jetonu (hepsi silinmeli)
await req('PUT', '/api/share', { token: A.token, body: { to: B.hash, blob: 'enc-blob' } });
await req('POST', '/api/spark', { token: A.token, body: { to: B.hash, blob: 'enc-spark' } });
await req('POST', '/api/push-token', { token: A.token, body: { token: 'f'.repeat(40), lang: 'tr' } });
const sparksBefore = await req('GET', '/api/sparks', { token: B.token });
ok('A → B SPARK sunucuda', (sparksBefore.json?.sparks || []).length === 1, JSON.stringify(sparksBefore));
const sharesBefore = await req('GET', '/api/shares', { token: B.token });
ok('A → B şifreli kutu sunucuda', (sharesBefore.json?.shares || []).length === 1, JSON.stringify(sharesBefore));

// 5. Yetkisiz silme reddedilir
const noAuth = await req('DELETE', '/api/account');
ok('tokensız DELETE 401', noAuth.status === 401, JSON.stringify(noAuth));

// 6. A hesabını siler
const del = await req('DELETE', '/api/account', { token: A.token });
ok('A hesabı silindi (200)', del.status === 200 && del.json?.status === 'account_deleted', JSON.stringify(del));
ok('bilgilendirilen partner sayısı 1', del.json?.partnersNotified === 1, JSON.stringify(del.json));

// 7. B online partner:removed aldı
const removedEvt = await Promise.race([
  removedOnB,
  new Promise((r) => setTimeout(() => r(null), 1500)),
]);
ok("B online 'partner:removed' aldı", removedEvt?.from === A.hash, JSON.stringify(removedEvt));

// 8. Token ölü
const afterToken = await req('GET', '/api/partner/list', { token: A.token });
ok("silinen hesabın token'ı 401", afterToken.status === 401, JSON.stringify(afterToken));

// 9. Ortak anahtar, partnerlik, paylaşım kutusu gitti
// Silme sonrası B artık partner değil → /keys/:hash 403 döner (anahtarın
// gerçekten gittiğini DB'den doğruluyoruz).
const dbCheck = await import('../src/db.js');
const leftovers = {
  user: dbCheck.userStore.has(A.hash),
  key: dbCheck.publicKeys.get(A.hash) !== undefined,
  partners: dbCheck.partnerships.listFor(A.hash).length,
  push: dbCheck.pushTokens.get(A.hash) !== undefined,
};
ok('DB: kullanıcı satırı silindi', leftovers.user === false, JSON.stringify(leftovers));
ok('DB: ortak anahtar silindi', leftovers.key === false, JSON.stringify(leftovers));
ok('DB: partnerlik satırı silindi', leftovers.partners === 0, JSON.stringify(leftovers));
ok('DB: push jetonu silindi', leftovers.push === false, JSON.stringify(leftovers));

const sparksAfter = await req('GET', '/api/sparks', { token: B.token });
ok('SPARK kayıtları silindi', (sparksAfter.json?.sparks || []).length === 0, JSON.stringify(sparksAfter));

const listAfter = await req('GET', '/api/partner/list', { token: B.token });
ok("B'nin listesinde A yok", !(listAfter.json?.partners || []).includes(A.hash), JSON.stringify(listAfter));

const sharesAfter = await req('GET', '/api/shares', { token: B.token });
ok('şifreli kutu silindi', (sharesAfter.json?.shares || []).length === 0, JSON.stringify(sharesAfter));

// 10. Aynı numara yeniden kayıt olabilir
const reToken = mintToken(A.hash);
ok('aynı numara yeniden token alabiliyor', !!reToken);

// 11. Yeniden bağlanma 409 vermez (bayat partnership kalmadı)
const reconn = await req('POST', '/api/partner/connect', { token: reToken, body: { partnerHash: B.hash } });
ok('yeniden bağlanma 409 vermiyor', reconn.status === 200, JSON.stringify(reconn));

// 12. Idempotent: tekrar sil → 200
const del2 = await req('DELETE', '/api/account', { token: reToken });
ok('ikinci silme de 200 (idempotent)', del2.status === 200, JSON.stringify(del2));

sockA.close();
sockB.close();
console.log(`\n${pass}/${pass + fail} geçti`);
process.exit(fail === 0 ? 0 : 1);
