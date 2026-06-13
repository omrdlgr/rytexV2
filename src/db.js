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

export default db;
