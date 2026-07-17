import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Kalıcı kullanıcı deposu. Fly'da DB_PATH bir VOLUME üzerine (/data/...) gösterir;
// volume yoksa makine restart'ında dosya uçar — fly.toml [mounts] zorunlu.
const DB_PATH = process.env.DB_PATH || './data/rytex.db';

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    phone_hash    TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  -- Bekleyen bağlantı istekleri: from_hash, to_hash'e istek attı.
  CREATE TABLE IF NOT EXISTS partner_requests (
    from_hash  TEXT NOT NULL,
    to_hash    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (from_hash, to_hash)
  );

  -- Kabul edilmiş partner çiftleri. Pair normalize (a<b) saklanır,
  -- yön farketmez — isPartner her iki sırayı da kapsar.
  CREATE TABLE IF NOT EXISTS partnerships (
    a_hash     TEXT NOT NULL,
    b_hash     TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (a_hash, b_hash)
  );

  -- İptal edilmiş JWT'ler (logout). jti = token kimliği, exp = token'ın
  -- bitiş zamanı (saniye, JWT exp claim'i). exp geçince satır budanır.
  CREATE TABLE IF NOT EXISTS revoked_tokens (
    jti TEXT PRIMARY KEY,
    exp INTEGER NOT NULL
  );

  -- Kullanıcı ORTAK anahtarları (X25519, base64). Uçtan-uca şifreleme için;
  -- sunucu yalnız ortak anahtarı bilir, özel anahtar hep cihazda.
  CREATE TABLE IF NOT EXISTS public_keys (
    phone_hash TEXT PRIMARY KEY,
    pub_key    TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Şifreli paylaşım kutuları. Sunucu içeriği (blob) OKUYAMAZ. Çift başına
  -- en güncel blob tutulur (from_hash sahibi → to_hash izleyici).
  CREATE TABLE IF NOT EXISTS shares (
    from_hash  TEXT NOT NULL,
    to_hash    TEXT NOT NULL,
    blob       TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (from_hash, to_hash)
  );

  -- SPARK mesajları (mahremiyet isteği). Uçtan uca şifreli — sunucu içeriği
  -- OKUYAMAZ. İki yönlü: from_hash → to_hash istek; to_hash cevap yazar.
  CREATE TABLE IF NOT EXISTS sparks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    from_hash  TEXT NOT NULL,
    to_hash    TEXT NOT NULL,
    req_blob   TEXT NOT NULL,       -- şifreli istek (alıcı için)
    status     TEXT NOT NULL DEFAULT 'pending',
    resp_blob  TEXT,                -- şifreli cevap (gönderen için; öneri vb.)
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- FCM push token'ları (SPARK gizli bildirimi, 2026-07-16). Kullanıcı başına
  -- tek token (son cihaz kazanır). İçerik push'a HİÇ konmaz — yalnız jenerik
  -- "uygulamaya bak" metni gider; SPARK içeriği uçtan uca şifreli kalır.
  -- lang: bildirim metninin dili (istemci kayıtta bildirir).
  CREATE TABLE IF NOT EXISTS push_tokens (
    phone_hash TEXT PRIMARY KEY,
    token      TEXT NOT NULL,
    lang       TEXT NOT NULL DEFAULT 'en',
    updated_at INTEGER NOT NULL
  );

  -- Opt-in ANONİM döngü uzunluğu istatistiği (ML filo eğitimi; avukat onayı
  -- 2026-07-15). anon_id kimlikten TÜRETİLMEZ (cihazda rastgele üretilir);
  -- users tablosuyla hiçbir bağ yok. IP/kimlik SAKLANMAZ. Upsert: aynı cihaz
  -- güncel verisini eskisinin üzerine yazar, mükerrer satır birikmez.
  CREATE TABLE IF NOT EXISTS ml_stats (
    anon_id    TEXT PRIMARY KEY,
    lengths    TEXT NOT NULL,       -- JSON dizi, ör. [29.0, 31.5, 28.0]
    updated_at INTEGER NOT NULL
  );
`);

const _insert = db.prepare(
  'INSERT INTO users (phone_hash, password_hash, created_at) VALUES (?, ?, ?)',
);
const _get = db.prepare('SELECT * FROM users WHERE phone_hash = ?');

export const userStore = {
  has(phoneHash) {
    return _get.get(phoneHash) !== undefined;
  },
  get(phoneHash) {
    const row = _get.get(phoneHash);
    if (!row) return undefined;
    return {
      phoneHash: row.phone_hash,
      passwordHash: row.password_hash,
      createdAt: row.created_at,
    };
  },
  create(phoneHash, passwordHash) {
    _insert.run(phoneHash, passwordHash, Date.now());
  },
  // Telefon doğrulamalı kullanıcı (şifresiz). Yoksa oluşturur.
  ensurePhone(phoneHash) {
    if (_get.get(phoneHash) === undefined) {
      _insert.run(phoneHash, '', Date.now());
    }
  },
};

// ── Partner istek / partnership deposu ──────────────────────────────

const _reqInsert = db.prepare(
  `INSERT INTO partner_requests (from_hash, to_hash, created_at) VALUES (?, ?, ?)
   ON CONFLICT(from_hash, to_hash) DO UPDATE SET created_at = excluded.created_at`,
);
const _reqGet = db.prepare(
  'SELECT 1 FROM partner_requests WHERE from_hash = ? AND to_hash = ?',
);
const _reqDelete = db.prepare(
  'DELETE FROM partner_requests WHERE from_hash = ? AND to_hash = ?',
);
const _reqPendingFor = db.prepare(
  'SELECT from_hash FROM partner_requests WHERE to_hash = ? ORDER BY created_at',
);

export const partnerRequests = {
  // requester → target istek attı
  create(fromHash, toHash) {
    _reqInsert.run(fromHash, toHash, Date.now());
  },
  // Bu kullanıcıya bekleyen isteklerin gönderenleri — çevrimdışıyken gelen
  // davetlerin bağlantı anında teslimi için (socket.js).
  pendingFor(toHash) {
    return _reqPendingFor.all(toHash).map((r) => r.from_hash);
  },
  // toHash, fromHash'ten bekleyen istek var mı?
  has(fromHash, toHash) {
    return _reqGet.get(fromHash, toHash) !== undefined;
  },
  delete(fromHash, toHash) {
    _reqDelete.run(fromHash, toHash);
  },
};

// Pair normalize: leksikografik sıra, yön bağımsız.
function _pair(a, b) {
  return a < b ? [a, b] : [b, a];
}

const _partInsert = db.prepare(
  `INSERT INTO partnerships (a_hash, b_hash, created_at) VALUES (?, ?, ?)
   ON CONFLICT(a_hash, b_hash) DO NOTHING`,
);
const _partGet = db.prepare(
  'SELECT 1 FROM partnerships WHERE a_hash = ? AND b_hash = ?',
);
const _partList = db.prepare(
  'SELECT a_hash, b_hash FROM partnerships WHERE a_hash = ? OR b_hash = ?',
);

const _partDelete = db.prepare(
  'DELETE FROM partnerships WHERE a_hash = ? AND b_hash = ?',
);
const _reqDeletePair = db.prepare(
  `DELETE FROM partner_requests
   WHERE (from_hash = ? AND to_hash = ?) OR (from_hash = ? AND to_hash = ?)`,
);
const _shDeletePair = db.prepare(
  `DELETE FROM shares
   WHERE (from_hash = ? AND to_hash = ?) OR (from_hash = ? AND to_hash = ?)`,
);
const _sparkDeletePair = db.prepare(
  `DELETE FROM sparks
   WHERE (from_hash = ? AND to_hash = ?) OR (from_hash = ? AND to_hash = ?)`,
);

export const partnerships = {
  add(x, y) {
    const [a, b] = _pair(x, y);
    _partInsert.run(a, b, Date.now());
  },
  isPartner(x, y) {
    const [a, b] = _pair(x, y);
    return _partGet.get(a, b) !== undefined;
  },
  // Kullanıcının tüm onaylı partnerlerinin hash listesi (yön bağımsız).
  listFor(hash) {
    return _partList
      .all(hash, hash)
      .map((r) => (r.a_hash === hash ? r.b_hash : r.a_hash));
  },
};

// Partnerliği İKİ TARAFLI ve kalıcı olarak çözer: partnership satırı +
// çifte ait bekleyen istekler + şifreli paylaşım kutuları + SPARK'lar
// (her iki yönde) tek transaction'da silinir. Idempotent — partnership
// yoksa da kalıntıları temizler. "Sahip siler → erişim anında kesilir"
// vaadinin sunucu ayağı; yoksa shares/sparks sunucuda yaşamaya devam eder.
export const dissolvePartnership = db.transaction((x, y) => {
  const [a, b] = _pair(x, y);
  _partDelete.run(a, b);
  _reqDeletePair.run(x, y, y, x);
  _shDeletePair.run(x, y, y, x);
  _sparkDeletePair.run(x, y, y, x);
});

// ── İptal edilmiş token deposu (JWT revocation) ─────────────────────

const _revInsert = db.prepare(
  `INSERT INTO revoked_tokens (jti, exp) VALUES (?, ?)
   ON CONFLICT(jti) DO NOTHING`,
);
const _revGet = db.prepare('SELECT 1 FROM revoked_tokens WHERE jti = ?');
const _revPrune = db.prepare('DELETE FROM revoked_tokens WHERE exp < ?');

export const revokedTokens = {
  // exp: JWT exp claim'i (saniye)
  revoke(jti, exp) {
    _revInsert.run(jti, exp);
    // Süresi geçmişleri temizle — tablo şişmesin.
    _revPrune.run(Math.floor(Date.now() / 1000));
  },
  isRevoked(jti) {
    return _revGet.get(jti) !== undefined;
  },
};

// ── Ortak anahtar deposu (uçtan-uca şifreleme) ──────────────────────

const _pkSet = db.prepare(
  `INSERT INTO public_keys (phone_hash, pub_key, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(phone_hash) DO UPDATE SET pub_key = excluded.pub_key, updated_at = excluded.updated_at`,
);
const _pkGet = db.prepare('SELECT pub_key FROM public_keys WHERE phone_hash = ?');

export const publicKeys = {
  set(phoneHash, pubKey) {
    _pkSet.run(phoneHash, pubKey, Date.now());
  },
  get(phoneHash) {
    const row = _pkGet.get(phoneHash);
    return row ? row.pub_key : undefined;
  },
};

// ── Şifreli paylaşım kutusu deposu ──────────────────────────────────

const _shPut = db.prepare(
  `INSERT INTO shares (from_hash, to_hash, blob, updated_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(from_hash, to_hash) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`,
);
const _shForRecipient = db.prepare(
  'SELECT from_hash, blob, updated_at FROM shares WHERE to_hash = ?',
);
const _shDelete = db.prepare(
  'DELETE FROM shares WHERE from_hash = ? AND to_hash = ?',
);

export const shares = {
  // sahip (from) → izleyici (to) için şifreli blob (upsert, en güncel).
  put(fromHash, toHash, blob) {
    _shPut.run(fromHash, toHash, blob, Date.now());
  },
  // izleyiciye (to) gelen tüm şifreli kutular.
  forRecipient(toHash) {
    return _shForRecipient.all(toHash).map((r) => ({
      from: r.from_hash,
      blob: r.blob,
      updatedAt: r.updated_at,
    }));
  },
  delete(fromHash, toHash) {
    _shDelete.run(fromHash, toHash);
  },
};

// ── SPARK deposu (uçtan uca şifreli mahremiyet mesajı) ──────────────

// Şema göçü: delivered_at (alıcı CİHAZI indirdi damgası, 2026-07-16 —
// "görüldü" DEĞİL; sadece "eline geçti" — sessizce-geç mahremiyeti korunur).
{
  const cols = db.prepare('PRAGMA table_info(sparks)').all().map((c) => c.name);
  if (!cols.includes('delivered_at')) {
    db.exec('ALTER TABLE sparks ADD COLUMN delivered_at INTEGER');
  }
}

// Cevapsız SPARK bu süreden sonra 'expired' olur — bayat talep iki tarafta da
// duygusal yük ("reddedildim" / eskimiş istek garabeti) bırakmasın.
export const SPARK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const _sparkInsert = db.prepare(
  `INSERT INTO sparks (from_hash, to_hash, req_blob, status, created_at, updated_at)
   VALUES (?, ?, ?, 'pending', ?, ?)`,
);
const _sparkForUser = db.prepare(
  `SELECT id, from_hash, to_hash, req_blob, status, resp_blob, created_at,
          updated_at, delivered_at
   FROM sparks WHERE from_hash = ? OR to_hash = ? ORDER BY updated_at DESC LIMIT 100`,
);
const _sparkGet = db.prepare('SELECT * FROM sparks WHERE id = ?');
const _sparkRespond = db.prepare(
  `UPDATE sparks SET status = ?, resp_blob = ?, updated_at = ? WHERE id = ?`,
);
const _sparkDelete = db.prepare('DELETE FROM sparks WHERE id = ?');
const _sparkMarkDelivered = db.prepare(
  `UPDATE sparks SET delivered_at = ? WHERE to_hash = ? AND delivered_at IS NULL`,
);
const _sparkExpire = db.prepare(
  `UPDATE sparks SET status = 'expired', updated_at = ?
   WHERE status = 'pending' AND created_at < ?`,
);

export const sparks = {
  create(fromHash, toHash, reqBlob) {
    const now = Date.now();
    const info = _sparkInsert.run(fromHash, toHash, reqBlob, now, now);
    return info.lastInsertRowid;
  },
  // from VEYA to = user (iki yön; gönderen cevabı da görsün).
  forUser(userHash) {
    return _sparkForUser.all(userHash, userHash).map((r) => ({
      id: r.id,
      from: r.from_hash,
      to: r.to_hash,
      reqBlob: r.req_blob,
      status: r.status,
      respBlob: r.resp_blob ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      deliveredAt: r.delivered_at ?? null,
    }));
  },
  // Alıcının cihazına inen SPARK'ları damgala ("gördü" değil, "eline geçti").
  markDelivered(toHash) {
    _sparkMarkDelivered.run(Date.now(), toHash);
  },
  // Cevapsız + TTL'i geçmiş istekleri 'expired' yap (tembel; GET'te çağrılır).
  expireStale() {
    const now = Date.now();
    _sparkExpire.run(now, now - SPARK_TTL_MS);
  },
  get(id) {
    return _sparkGet.get(id);
  },
  respond(id, status, respBlob) {
    _sparkRespond.run(status, respBlob ?? null, Date.now(), id);
  },
  delete(id) {
    _sparkDelete.run(id);
  },
};

// ── Push token deposu (SPARK gizli bildirimi) ───────────────────────

const _ptSet = db.prepare(
  `INSERT INTO push_tokens (phone_hash, token, lang, updated_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(phone_hash) DO UPDATE SET token = excluded.token,
     lang = excluded.lang, updated_at = excluded.updated_at`,
);
const _ptGet = db.prepare(
  'SELECT token, lang FROM push_tokens WHERE phone_hash = ?',
);
const _ptDelete = db.prepare('DELETE FROM push_tokens WHERE phone_hash = ?');
const _ptDeleteByToken = db.prepare('DELETE FROM push_tokens WHERE token = ?');

export const pushTokens = {
  set(phoneHash, token, lang) {
    _ptSet.run(phoneHash, token, lang || 'en', Date.now());
  },
  get(phoneHash) {
    const row = _ptGet.get(phoneHash);
    return row ? { token: row.token, lang: row.lang } : undefined;
  },
  delete(phoneHash) {
    _ptDelete.run(phoneHash);
  },
  // FCM "token geçersiz" dediğinde temizlik (cihaz app'i silmiş olabilir).
  deleteByToken(token) {
    _ptDeleteByToken.run(token);
  },
};

const _mlStatsUpsert = db.prepare(
  `INSERT INTO ml_stats (anon_id, lengths, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(anon_id) DO UPDATE SET lengths = excluded.lengths,
     updated_at = excluded.updated_at`,
);
const _mlStatsCount = db.prepare('SELECT COUNT(*) AS n FROM ml_stats');

export const mlStats = {
  upsert(anonId, lengths) {
    _mlStatsUpsert.run(anonId, JSON.stringify(lengths), Date.now());
  },
  count() {
    return _mlStatsCount.get().n;
  },
};

export default db;
