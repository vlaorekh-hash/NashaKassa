import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.sqlite');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  telegram_id     INTEGER PRIMARY KEY,
  first_name      TEXT NOT NULL,
  username        TEXT,
  payment_details TEXT,               -- free text: "СБП, +7 900 ..., Т-Банк" — как переводить этому человеку
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS groups (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('rotation','goal')),
  amount          INTEGER NOT NULL,        -- взнос за цикл, в рублях (для rotation) / шаг рекомендации (для goal)
  frequency_days  INTEGER NOT NULL DEFAULT 30,
  goal_amount     INTEGER,                 -- только для type='goal'
  goal_deadline   TEXT,                    -- только для type='goal', ISO-дата
  created_by      INTEGER NOT NULL REFERENCES users(telegram_id),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS group_members (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id        TEXT NOT NULL REFERENCES groups(id),
  telegram_id     INTEGER NOT NULL REFERENCES users(telegram_id),
  join_order      INTEGER NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1,
  joined_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(group_id, telegram_id)
);

CREATE TABLE IF NOT EXISTS cycles (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id              TEXT NOT NULL REFERENCES groups(id),
  cycle_number          INTEGER NOT NULL,
  recipient_telegram_id INTEGER REFERENCES users(telegram_id),  -- NULL для goal-касс
  period_start          TEXT NOT NULL DEFAULT (datetime('now')),
  period_end            TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  UNIQUE(group_id, cycle_number)
);

CREATE TABLE IF NOT EXISTS contributions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id        INTEGER NOT NULL REFERENCES cycles(id),
  telegram_id     INTEGER NOT NULL REFERENCES users(telegram_id),
  amount          INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed')),
  confirmed_by    INTEGER REFERENCES users(telegram_id),
  confirmed_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(cycle_id, telegram_id)
);
`);

export function upsertUser({ telegram_id, first_name, username }) {
  db.prepare(`
    INSERT INTO users (telegram_id, first_name, username)
    VALUES (@telegram_id, @first_name, @username)
    ON CONFLICT(telegram_id) DO UPDATE SET
      first_name = excluded.first_name,
      username = excluded.username
  `).run({ telegram_id, first_name, username: username || null });
}
