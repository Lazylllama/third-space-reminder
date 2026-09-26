import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    slack_id TEXT PRIMARY KEY,
    hackatime_user_id INTEGER,
    hackatime_slack_id TEXT,
    token_enc TEXT,
    token_status TEXT NOT NULL DEFAULT 'none' CHECK (token_status IN ('none', 'ok', 'invalid')),
    tz TEXT,
    tz_source TEXT CHECK (tz_source IN ('slack', 'manual')),
    tz_synced_at INTEGER,
    paused_until INTEGER,
    last_reconnect_nag TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slack_id TEXT NOT NULL REFERENCES users(slack_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    projects TEXT NOT NULL,
    goal_seconds INTEGER NOT NULL,
    hours TEXT NOT NULL,
    slack_days TEXT NOT NULL,
    wrap_day INTEGER NOT NULL,
    wrap_minutes INTEGER NOT NULL,
    ship_nag INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    snoozed_until INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX reminders_slack_id ON reminders(slack_id);

  -- Every slot / one-shot event we acted on. The primary key is what makes sending idempotent.
  CREATE TABLE slot_log (
    reminder_id INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
    slot_key TEXT NOT NULL,
    kind TEXT,
    outcome TEXT NOT NULL,
    quote_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (reminder_id, slot_key)
  );
  CREATE INDEX slot_log_created ON slot_log(created_at);

  CREATE TABLE week_state (
    reminder_id INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
    week_key TEXT NOT NULL,
    shipped_at INTEGER,
    PRIMARY KEY (reminder_id, week_key)
  );

  CREATE TABLE week_results (
    reminder_id INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
    week_key TEXT NOT NULL,
    total_seconds INTEGER NOT NULL,
    goal_seconds INTEGER NOT NULL,
    shipped_at INTEGER,
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (reminder_id, week_key)
  );

  CREATE TABLE oauth_states (
    state TEXT PRIMARY KEY,
    slack_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE status_cache (
    reminder_id INTEGER PRIMARY KEY REFERENCES reminders(id) ON DELETE CASCADE,
    week_key TEXT NOT NULL,
    today_start INTEGER NOT NULL,
    week_seconds INTEGER NOT NULL,
    today_seconds INTEGER NOT NULL,
    computed_at INTEGER NOT NULL
  );
  `,
];

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA synchronous = NORMAL;");
  migrate(db);
  return db;
}

function migrate(db: Database) {
  const row = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
  let version = row?.user_version ?? 0;
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version]!;
    db.transaction(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    })();
    version++;
  }
}
