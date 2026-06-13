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

export const partnerRequests = {
  // requester → target istek attı
  create(fromHash, toHash) {
    _reqInsert.run(fromHash, toHash, Date.now());
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

export const partnerships = {
  add(x, y) {
    const [a, b] = _pair(x, y);
    _partInsert.run(a, b, Date.now());
  },
  isPartner(x, y) {
    const [a, b] = _pair(x, y);
    return _partGet.get(a, b) !== undefined;
  },
};

export default db;
