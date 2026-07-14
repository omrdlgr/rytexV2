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

const _sparkInsert = db.prepare(
  `INSERT INTO sparks (from_hash, to_hash, req_blob, status, created_at, updated_at)
   VALUES (?, ?, ?, 'pending', ?, ?)`,
);
const _sparkForUser = db.prepare(
  `SELECT id, from_hash, to_hash, req_blob, status, resp_blob, created_at, updated_at
   FROM sparks WHERE from_hash = ? OR to_hash = ? ORDER BY updated_at DESC LIMIT 100`,
);
const _sparkGet = db.prepare('SELECT * FROM sparks WHERE id = ?');
const _sparkRespond = db.prepare(
  `UPDATE sparks SET status = ?, resp_blob = ?, updated_at = ? WHERE id = ?`,
);
const _sparkDelete = db.prepare('DELETE FROM sparks WHERE id = ?');

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
    }));
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

export default db;
