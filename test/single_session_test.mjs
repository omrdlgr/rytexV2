// TEK AKTİF OTURUM — yeni cihazda giriş eskisini kapatır.
//
// NEDEN (2026-09-17, kullanıcı sorusu): "telefonu çalınırsa eski cihazdan
// çıkış yapamaz ki?" Tetikleyici eski cihazdan çıkış DEĞİL, yeni cihazdaki
// giriş. Eskiden JWT 30 gün geçerliydi ve çalınan cihaz o süre boyunca
// partnerlerin paylaştığı sağlık verisini almaya devam ediyordu.
//
// İkinci sebep: X25519 özel anahtarı cihaz yerel; ikinci cihaz `PUT /keys`
// ile ortak anahtarı ezip ilk cihazın yeni paylaşımları çözmesini SESSİZCE
// bozuyordu.
//
// ⚠️ KAPSAM SINIRI, DÜRÜST KAYIT: `/verify-phone` gerçek Firebase ID token'ı
// istediği için HTTP ucundan otomatik tetiklenemiyor. Bu test MEKANİZMAYI
// kilitliyor (activeSessions + revokeToken + verifyToken zinciri); rotadaki
// üç satırlık bağlantı elle doğrulandı. "Saf mantık test ediliyor ama
// BAĞLANTI test edilmiyor" tuzağı biliniyor (trialStartProvider dersi).
//
//   JWT_SECRET=... node test/single_session_test.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
process.env.JWT_SECRET = SECRET;
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'rytex-sess-')), 'test.db');

const { activeSessions, deleteAccount } = await import('../src/db.js');
const { newSession, verifyToken, revokeToken } = await import('../src/token.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};
const alive = (t) => { try { verifyToken(t); return true; } catch { return false; } };

const A = 'a'.repeat(20);
const B = 'b'.repeat(20);

console.log('\nİLK GİRİŞ');
const s1 = newSession(A);
const prev0 = activeSessions.replace(A, s1.jti, s1.exp);
ok('önceki oturum yok (ilk cihaz)', prev0 === null, `→ ${JSON.stringify(prev0)}`);
ok('token geçerli', alive(s1.token));

console.log('\nİKİNCİ CİHAZDA GİRİŞ (çalınan telefon senaryosu)');
const s2 = newSession(A);
const prev1 = activeSessions.replace(A, s2.jti, s2.exp);
ok('önceki oturum DÖNDÜ', prev1?.jti === s1.jti, `→ ${JSON.stringify(prev1)}`);
revokeToken(prev1);
ok('🔴 ESKİ cihazın token\'ı artık GEÇERSİZ', !alive(s1.token));
ok('yeni cihazın token\'ı geçerli', alive(s2.token));

console.log('\nBAŞKA KİMLİK ETKİLENMİYOR');
const sB = newSession(B);
activeSessions.replace(B, sB.jti, sB.exp);
ok('B hâlâ geçerli (A\'nın girişi B\'yi kesmedi)', alive(sB.token));
const s3 = newSession(A);
revokeToken(activeSessions.replace(A, s3.jti, s3.exp));
ok('A üçüncü kez girdi, B yine etkilenmedi', alive(sB.token));
ok('A\'nın ikinci token\'ı da düştü', !alive(s2.token));

console.log('\nÇIKIŞ SATIRI TEMİZLİYOR');
activeSessions.clear(A);
const s4 = newSession(A);
ok('çıkıştan sonraki girişte iptal edilecek eski oturum YOK',
  activeSessions.replace(A, s4.jti, s4.exp) === null);

console.log('\nHESAP SİLME SATIRI TEMİZLİYOR');
const s5 = newSession(B);
activeSessions.replace(B, s5.jti, s5.exp);
deleteAccount(B);
const s6 = newSession(B);
ok('silinen hesabın bayat jti\'si taşınmıyor',
  activeSessions.replace(B, s6.jti, s6.exp) === null);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} geçti, ${fail} kaldı\n`);
process.exit(fail === 0 ? 0 : 1);
