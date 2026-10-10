// SPARK bildirim gövdesi istemcinin desteklediği HER içerik dilinde var mı?
// İstemci (lib/core/l10n/content_locale.dart resolvedContentLanguage) bu 14
// koddan birini /push-token'a 'lang' olarak gönderir; PUSH_BODY'de olmayan dil
// sessizce İngilizceye düşer (nb/nl/sv 2026-10-10'a kadar düşüyordu).
// Çalıştır: node test/push_body_langs_smoke.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// push.js içe aktarılınca config.js (JWT_SECRET koruması) ve db.js (DB_PATH)
// yüklenir: ortam ÖNCE kurulur, modül SONRA dinamik yüklenir; üretim DB'sine dokunulmaz.
const dir = mkdtempSync(join(tmpdir(), 'rytex-pushbody-'));
process.env.JWT_SECRET ||= 'test-' + 'x'.repeat(40);
process.env.DB_PATH = join(dir, 'test.db');
const { PUSH_BODY } = await import('../src/routes/push.js');

const CLIENT_LANGS = ['tr', 'en', 'es', 'de', 'fr', 'it', 'pt', 'pl', 'ja', 'zh', 'ru', 'nl', 'sv', 'nb'];
let fail = 0;
for (const l of CLIENT_LANGS) {
  const v = PUSH_BODY[l];
  if (typeof v !== 'string' || !v.trim()) { console.log(`✗ ${l}: gövde yok`); fail++; continue; }
  if (l !== 'en' && v === PUSH_BODY.en) { console.log(`✗ ${l}: İngilizce metnin kopyası`); fail++; continue; }
  console.log(`✓ ${l}: ${v}`);
}
console.log(fail ? `\n${fail} HATA` : `\n${CLIENT_LANGS.length}/${CLIENT_LANGS.length} dil tamam`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
