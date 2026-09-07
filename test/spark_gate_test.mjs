// SPARK KAPISI + TTL TEMİZLİĞİ — db.js seviyesinde doğrudan test.
//
// İki kural (kullanıcı kararı 2026-09-07):
//   1. Aynı kişiye, cevap gelmeden ikinci SPARK gönderilemez.
//   2. TTL'i dolan kayıt CEVAPLANMIŞ OLSUN OLMASIN silinir — ve süre HER
//      SPARK'ın KENDİ yaşına bakar, toplu süpürme değil.
//
// Neden ayrı dosya: karar db.js'te (`hasPendingTo`, `purgeStale`) ve zaman
// bağımlı; created_at'i elle geriye çekmek için DB'ye doğrudan yazmak gerekiyor.
//
//   node test/spark_gate_test.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.JWT_SECRET ||= 'x'.repeat(48); // config.js boot guard'ı
const dir = mkdtempSync(join(tmpdir(), 'rytex-spark-'));
process.env.DB_PATH = join(dir, 'test.db');

const { sparks, SPARK_TTL_MS } = await import('../src/db.js');
const Database = (await import('better-sqlite3')).default;
const raw = new Database(process.env.DB_PATH);

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

const A = 'HASH_A';
const B = 'HASH_B';
const C = 'HASH_C';

/** Kaydın yaşını gün cinsinden geriye çeker (TTL testleri için). */
function ageDays(id, days) {
  const t = Date.now() - days * 24 * 60 * 60 * 1000;
  raw.prepare('UPDATE sparks SET created_at = ? WHERE id = ?').run(t, id);
}

console.log('\n1) BEKLEYEN-SPARK KAPISI');
{
  const id = sparks.create(A, B, 'blob');
  ok('gönderimden sonra A→B bekleyen var', sparks.hasPendingTo(A, B));
  ok('A→C etkilenmez (kapı çift bazlı)', !sparks.hasPendingTo(A, C));
  ok('B→A etkilenmez (yön bazlı — karşı taraf gönderebilir)',
    !sparks.hasPendingTo(B, A));

  sparks.respond(id, 'accepted', null);
  ok('cevap gelince kapı AÇILIR', !sparks.hasPendingTo(A, B));

  const id2 = sparks.create(A, B, 'blob2');
  ok('cevaptan sonra yeni SPARK gönderilebilir', sparks.hasPendingTo(A, B));

  // Diğer üç cevap da kapıyı açmalı ("sessizce geç" dahil).
  for (const st of ['not_today', 'suggest', 'maybe']) {
    sparks.respond(id2, st, null);
    ok(`'${st}' cevabı da kapıyı açar`, !sparks.hasPendingTo(A, B));
    sparks.respond(id2, 'pending', null); // geri al, sıradaki için
  }
  raw.prepare('DELETE FROM sparks').run();
}

console.log('\n2) TTL — HER KAYIT KENDİ YAŞINA BAKAR');
{
  const eski = sparks.create(A, B, 'eski');
  const yeni = sparks.create(A, C, 'yeni');
  ageDays(eski, 8); // TTL'i doldu
  ageDays(yeni, 5); // dolmadı

  sparks.purgeStale();
  const kalan = raw.prepare('SELECT id FROM sparks').all().map((r) => r.id);
  ok('8 günlük kayıt SİLİNDİ', !kalan.includes(eski));
  ok('5 günlük kayıt DURUYOR (toplu süpürme değil)', kalan.includes(yeni),
    `kalan=${JSON.stringify(kalan)}`);
  raw.prepare('DELETE FROM sparks').run();
}

console.log('\n3) TTL — CEVAPLANMIŞ OLAN DA SİLİNİR');
{
  const cevapli = sparks.create(A, B, 'x');
  sparks.respond(cevapli, 'accepted', null);
  ageDays(cevapli, 8);
  sparks.purgeStale();
  ok('cevaplanmış ama süresi dolmuş kayıt silindi',
    raw.prepare('SELECT 1 FROM sparks WHERE id = ?').get(cevapli) === undefined);
}

console.log('\n4) SÜRESİ DOLAN CEVAPSIZ KAYIT KAPIYI KİLİTLEMEZ');
{
  const id = sparks.create(A, B, 'x');
  ageDays(id, 8);
  // purge henüz koşmamış olsa BİLE kapı açık olmalı; yoksa cevapsız bir
  // SPARK, temizlik gecikirse göndereni süresiz kilitlerdi.
  ok('TTL dolmuş bekleyen kayıt "bekliyor" saymaz',
    !sparks.hasPendingTo(A, B));
  sparks.purgeStale();
  raw.prepare('DELETE FROM sparks').run();
}

console.log('\n5) SINIR — TAM TTL ANI');
{
  const id = sparks.create(A, B, 'x');
  raw.prepare('UPDATE sparks SET created_at = ? WHERE id = ?')
    .run(Date.now() - SPARK_TTL_MS + 60_000, id); // TTL'e 1 dk var
  sparks.purgeStale();
  ok('TTL dolmadan 1 dk önce SİLİNMEZ',
    raw.prepare('SELECT 1 FROM sparks WHERE id = ?').get(id) !== undefined);
  ok('ve hâlâ bekliyor sayılır', sparks.hasPendingTo(A, B));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} geçti, ${fail} kaldı\n`);
process.exit(fail === 0 ? 0 : 1);
