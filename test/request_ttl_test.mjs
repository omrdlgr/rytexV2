// Bekleyen partner isteğinin ÖMRÜ (7 gün) — saf db.js testi, sunucu yok.
//
// NEDEN VAR: davet eskiden SÜRESİZ bekliyordu. Uygulaması olmayan birine
// telefonla davet atılınca satır sonsuza kadar kalıyordu; anahtarı da
// uygulamayı hiç kullanmamış birinin telefon hash'iydi.
//
// ⚠️ ASIL SINANAN ŞEY LİSTELEME DEĞİL, KABUL EDİLEBİLİRLİK. `has()` süreye
// bakmazsa TTL yalnızca GÖRÜNÜRDE kalır: istek listede çıkmaz ama
// `partner:accept` doğrulamasını `has()` yaptığı için süresi geçmiş davet
// HÂLÂ partnerlik kurabilir. Bu dosyanın en önemli iddiası o.
//
//   node test/request_ttl_test.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'rytex-ttl-')), 't.db');
process.env.JWT_SECRET = 'x'.repeat(48);

const { partnerRequests, REQUEST_TTL_MS, default: _ } = await import('../src/db.js');
const Database = (await import('better-sqlite3')).default;

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

const raw = new Database(process.env.DB_PATH);
const backdate = (from, to, ms) =>
  raw
    .prepare('UPDATE partner_requests SET created_at = ? WHERE from_hash = ? AND to_hash = ?')
    .run(Date.now() - ms, from, to);

console.log('SÜRE POLİTİKASI');
ok('TTL 7 gün', REQUEST_TTL_MS === 7 * 24 * 60 * 60 * 1000, `→ ${REQUEST_TTL_MS}`);

console.log('\nTAZE İSTEK');
partnerRequests.create('a'.repeat(64), 'b'.repeat(64));
ok('listede görünür', partnerRequests.pendingFor('b'.repeat(64)).length === 1);
ok('kabul edilebilir', partnerRequests.has('a'.repeat(64), 'b'.repeat(64)) === true);

console.log('\nSÜRESİ GEÇMİŞ İSTEK');
backdate('a'.repeat(64), 'b'.repeat(64), REQUEST_TTL_MS + 60_000);
ok('listede GÖRÜNMEZ', partnerRequests.pendingFor('b'.repeat(64)).length === 0);
ok('KABUL EDİLEMEZ (asıl iddia)',
  partnerRequests.has('a'.repeat(64), 'b'.repeat(64)) === false);

console.log('\nSINIR GÜNÜ (kıl payı taze olan ölmemeli)');
partnerRequests.create('c'.repeat(64), 'd'.repeat(64));
backdate('c'.repeat(64), 'd'.repeat(64), REQUEST_TTL_MS - 60_000);
ok('6 gün 23 saatlik istek YAŞIYOR',
  partnerRequests.has('c'.repeat(64), 'd'.repeat(64)) === true);

console.log('\nBUDAMA (depolama sınırlı kalmalı)');
// ⚠️ Toplam satır sayısına bakmak YANILTIR: budama her `create()`te
// koştuğu için önceki adımlar süresi geçmiş satırı çoktan silmiş olabilir
// (ilk yazımda tam bu yüzden yanlış ölçtüm). Tek bir satırın kaderine bak.
const G = 'e'.repeat(64);
const H = 'f'.repeat(64);
partnerRequests.create(G, H);
backdate(G, H, REQUEST_TTL_MS + 60_000);
const rows = () => raw
  .prepare('SELECT COUNT(*) n FROM partner_requests WHERE from_hash = ?')
  .get(G).n;
const had = rows();
partnerRequests.create('1'.repeat(64), '2'.repeat(64)); // yazma anında budar
ok('süresi geçmiş satır diskten SİLİNDİ', had === 1 && rows() === 0,
  `→ önce ${had}, sonra ${rows()}`);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} geçti, ${fail} kaldı`);
process.exit(fail === 0 ? 0 : 1);
