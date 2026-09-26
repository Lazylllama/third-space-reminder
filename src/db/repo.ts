import type { Database } from "bun:sqlite";
import type { Reminder, ReminderSettings, TokenStatus, User } from "../types";

interface UserRow {
  slack_id: string;
  hackatime_user_id: number | null;
  hackatime_slack_id: string | null;
  token_enc: string | null;
  token_status: TokenStatus;
  tz: string | null;
  tz_source: "slack" | "manual" | null;
  tz_synced_at: number | null;
  paused_until: number | null;
  last_reconnect_nag: string | null;
  created_at: number;
  updated_at: number;
}

interface ReminderRow {
  id: number;
  slack_id: string;
  name: string;
  projects: string;
  goal_seconds: number;
  hours: string;
  slack_days: string;
  wrap_day: number;
  wrap_minutes: number;
  ship_nag: number;
  enabled: number;
  snoozed_until: number | null;
  created_at: number;
  updated_at: number;
}

export interface ReminderInput extends ReminderSettings {
  name: string;
  projects: string[];
}

export interface WeekResult {
  weekKey: string;
  totalSeconds: number;
  goalSeconds: number;
  shippedAt: number | null;
}

export interface CachedStatus {
  weekKey: string;
  todayStart: number;
  weekSeconds: number;
  todaySeconds: number;
  computedAt: number;
}

export interface UsageCounts {
  /** Everyone who ever opened the Home tab. */
  users: number;
  connected: number;
  needsReconnect: number;
  /** Connected, not paused, with at least one enabled reminder. */
  activelyNagged: number;
  pausedUsers: number;
  reminders: number;
  remindersEnabled: number;
  dmsLastDay: number;
  dmsLastWeek: number;
}

export interface AdminReminderRow {
  reminder: Reminder;
  tz: string | null;
  tokenStatus: TokenStatus;
  pausedUntil: number | null;
  cache: CachedStatus | null;
  /** Shipped timestamp for the week asked about. */
  shippedAt: number | null;
}

function toUser(r: UserRow): User {
  return {
    slackId: r.slack_id,
    hackatimeUserId: r.hackatime_user_id,
    hackatimeSlackId: r.hackatime_slack_id,
    tokenEnc: r.token_enc,
    tokenStatus: r.token_status,
    tz: r.tz,
    tzSource: r.tz_source,
    tzSyncedAt: r.tz_synced_at,
    pausedUntil: r.paused_until,
    lastReconnectNag: r.last_reconnect_nag,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toReminder(r: ReminderRow): Reminder {
  return {
    id: r.id,
    slackId: r.slack_id,
    name: r.name,
    projects: JSON.parse(r.projects),
    goalSeconds: r.goal_seconds,
    hours: JSON.parse(r.hours),
    slackDays: JSON.parse(r.slack_days),
    wrapDay: r.wrap_day,
    wrapMinutes: r.wrap_minutes,
    shipNag: r.ship_nag === 1,
    enabled: r.enabled === 1,
    snoozedUntil: r.snoozed_until,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class Repo {
  constructor(
    readonly db: Database,
    private readonly clock: () => number = Date.now,
  ) {}

  // ---------- users ----------

  getUser(slackId: string): User | null {
    const row = this.db.query<UserRow, [string]>("SELECT * FROM users WHERE slack_id = ?").get(slackId);
    return row ? toUser(row) : null;
  }

  ensureUser(slackId: string): User {
    const now = this.clock();
    this.db.query("INSERT OR IGNORE INTO users (slack_id, created_at, updated_at) VALUES (?, ?, ?)").run(slackId, now, now);
    return this.getUser(slackId)!;
  }

  setToken(slackId: string, tokenEnc: string, hackatimeUserId: number | null, hackatimeSlackId: string | null) {
    this.ensureUser(slackId);
    this.db
      .query(
        "UPDATE users SET token_enc = ?, token_status = 'ok', hackatime_user_id = ?, hackatime_slack_id = ?, last_reconnect_nag = NULL, updated_at = ? WHERE slack_id = ?",
      )
      .run(tokenEnc, hackatimeUserId, hackatimeSlackId, this.clock(), slackId);
  }

  setTokenStatus(slackId: string, status: TokenStatus) {
    this.db.query("UPDATE users SET token_status = ?, updated_at = ? WHERE slack_id = ?").run(status, this.clock(), slackId);
  }

  clearToken(slackId: string) {
    this.db
      .query("UPDATE users SET token_enc = NULL, token_status = 'none', hackatime_user_id = NULL, hackatime_slack_id = NULL, updated_at = ? WHERE slack_id = ?")
      .run(this.clock(), slackId);
  }

  setTimezone(slackId: string, tz: string, source: "slack" | "manual") {
    this.ensureUser(slackId);
    const now = this.clock();
    this.db.query("UPDATE users SET tz = ?, tz_source = ?, tz_synced_at = ?, updated_at = ? WHERE slack_id = ?").run(tz, source, now, now, slackId);
  }

  touchTzSync(slackId: string) {
    this.db.query("UPDATE users SET tz_synced_at = ? WHERE slack_id = ?").run(this.clock(), slackId);
  }

  setPausedUntil(slackId: string, until: number | null) {
    this.ensureUser(slackId);
    this.db.query("UPDATE users SET paused_until = ?, updated_at = ? WHERE slack_id = ?").run(until, this.clock(), slackId);
  }

  setLastReconnectNag(slackId: string, date: string) {
    this.db.query("UPDATE users SET last_reconnect_nag = ? WHERE slack_id = ?").run(date, slackId);
  }

  usersNeedingTzSync(olderThan: number): User[] {
    return this.db
      .query<UserRow, [number]>("SELECT * FROM users WHERE (tz_source IS NULL OR tz_source = 'slack') AND (tz_synced_at IS NULL OR tz_synced_at < ?)")
      .all(olderThan)
      .map(toUser);
  }

  // ---------- reminders ----------

  listReminders(slackId: string): Reminder[] {
    return this.db.query<ReminderRow, [string]>("SELECT * FROM reminders WHERE slack_id = ? ORDER BY id").all(slackId).map(toReminder);
  }

  getReminder(id: number): Reminder | null {
    const row = this.db.query<ReminderRow, [number]>("SELECT * FROM reminders WHERE id = ?").get(id);
    return row ? toReminder(row) : null;
  }

  /** Enabled reminders together with their owner. */
  activeReminders(): { reminder: Reminder; user: User }[] {
    const rows = this.db
      .query<ReminderRow & { u_json: string }, []>(
        `SELECT r.*, json_object(
            'slack_id', u.slack_id, 'hackatime_user_id', u.hackatime_user_id, 'hackatime_slack_id', u.hackatime_slack_id,
            'token_enc', u.token_enc, 'token_status', u.token_status, 'tz', u.tz, 'tz_source', u.tz_source,
            'tz_synced_at', u.tz_synced_at, 'paused_until', u.paused_until, 'last_reconnect_nag', u.last_reconnect_nag,
            'created_at', u.created_at, 'updated_at', u.updated_at) AS u_json
         FROM reminders r JOIN users u ON u.slack_id = r.slack_id
         WHERE r.enabled = 1 ORDER BY r.id`,
      )
      .all();
    return rows.map((row) => ({ reminder: toReminder(row), user: toUser(JSON.parse(row.u_json) as UserRow) }));
  }

  createReminder(slackId: string, input: ReminderInput): Reminder {
    this.ensureUser(slackId);
    const now = this.clock();
    const result = this.db
      .query(
        `INSERT INTO reminders (slack_id, name, projects, goal_seconds, hours, slack_days, wrap_day, wrap_minutes, ship_nag, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        slackId,
        input.name,
        JSON.stringify(input.projects),
        input.goalSeconds,
        JSON.stringify(input.hours),
        JSON.stringify(input.slackDays),
        input.wrapDay,
        input.wrapMinutes,
        input.shipNag ? 1 : 0,
        now,
        now,
      );
    return this.getReminder(Number(result.lastInsertRowid))!;
  }

  updateReminder(id: number, input: ReminderInput): Reminder | null {
    this.db
      .query(
        `UPDATE reminders SET name = ?, projects = ?, goal_seconds = ?, hours = ?, slack_days = ?, wrap_day = ?, wrap_minutes = ?, ship_nag = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.name,
        JSON.stringify(input.projects),
        input.goalSeconds,
        JSON.stringify(input.hours),
        JSON.stringify(input.slackDays),
        input.wrapDay,
        input.wrapMinutes,
        input.shipNag ? 1 : 0,
        this.clock(),
        id,
      );
    this.db.query("DELETE FROM status_cache WHERE reminder_id = ?").run(id);
    return this.getReminder(id);
  }

  setReminderEnabled(id: number, enabled: boolean) {
    this.db.query("UPDATE reminders SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, this.clock(), id);
  }

  setSnooze(id: number, until: number | null) {
    this.db.query("UPDATE reminders SET snoozed_until = ?, updated_at = ? WHERE id = ?").run(until, this.clock(), id);
  }

  deleteReminder(id: number) {
    this.db.query("DELETE FROM reminders WHERE id = ?").run(id);
  }

  // ---------- slot log (idempotency) ----------

  /** Atomically claim a slot. Returns false when someone (another tick, another container) already has it. */
  claimSlot(reminderId: number, key: string): boolean {
    const result = this.db
      .query("INSERT OR IGNORE INTO slot_log (reminder_id, slot_key, outcome, created_at) VALUES (?, ?, 'claimed', ?)")
      .run(reminderId, key, this.clock());
    return result.changes === 1;
  }

  hasSlot(reminderId: number, key: string): boolean {
    return this.db.query("SELECT 1 FROM slot_log WHERE reminder_id = ? AND slot_key = ?").get(reminderId, key) !== null;
  }

  finishSlot(reminderId: number, key: string, outcome: string, kind: string | null, quoteId: string | null) {
    this.db
      .query("UPDATE slot_log SET outcome = ?, kind = ?, quote_id = ? WHERE reminder_id = ? AND slot_key = ?")
      .run(outcome, kind, quoteId, reminderId, key);
  }

  /** Record a one-shot marker (no-op if it already exists). */
  mark(reminderId: number, key: string, kind: string) {
    this.db
      .query("INSERT OR IGNORE INTO slot_log (reminder_id, slot_key, kind, outcome, created_at) VALUES (?, ?, ?, 'marker', ?)")
      .run(reminderId, key, kind, this.clock());
  }

  releaseSlot(reminderId: number, key: string) {
    this.db.query("DELETE FROM slot_log WHERE reminder_id = ? AND slot_key = ?").run(reminderId, key);
  }

  recentQuoteIds(slackId: string, limit: number): string[] {
    return this.db
      .query<{ quote_id: string }, [string, number]>(
        `SELECT s.quote_id FROM slot_log s JOIN reminders r ON r.id = s.reminder_id
         WHERE r.slack_id = ? AND s.quote_id IS NOT NULL ORDER BY s.created_at DESC LIMIT ?`,
      )
      .all(slackId, limit)
      .map((r) => r.quote_id);
  }

  recordQuote(reminderId: number, key: string, quoteId: string) {
    this.db
      .query("INSERT OR REPLACE INTO slot_log (reminder_id, slot_key, kind, outcome, quote_id, created_at) VALUES (?, ?, 'adhoc', 'sent', ?, ?)")
      .run(reminderId, key, quoteId, this.clock());
  }

  pruneSlotLog(olderThan: number) {
    this.db.query("DELETE FROM slot_log WHERE created_at < ?").run(olderThan);
  }

  // ---------- weeks ----------

  shippedAt(reminderId: number, weekKey: string): number | null {
    const row = this.db
      .query<{ shipped_at: number | null }, [number, string]>("SELECT shipped_at FROM week_state WHERE reminder_id = ? AND week_key = ?")
      .get(reminderId, weekKey);
    return row?.shipped_at ?? null;
  }

  setShipped(reminderId: number, weekKey: string, at: number | null) {
    this.db
      .query(
        `INSERT INTO week_state (reminder_id, week_key, shipped_at) VALUES (?, ?, ?)
         ON CONFLICT (reminder_id, week_key) DO UPDATE SET shipped_at = excluded.shipped_at`,
      )
      .run(reminderId, weekKey, at);
    this.db.query("UPDATE week_results SET shipped_at = ? WHERE reminder_id = ? AND week_key = ?").run(at, reminderId, weekKey);
  }

  saveWeekResult(reminderId: number, result: WeekResult) {
    this.db
      .query(
        `INSERT INTO week_results (reminder_id, week_key, total_seconds, goal_seconds, shipped_at, recorded_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (reminder_id, week_key) DO UPDATE SET total_seconds = excluded.total_seconds, goal_seconds = excluded.goal_seconds,
           shipped_at = excluded.shipped_at, recorded_at = excluded.recorded_at`,
      )
      .run(reminderId, result.weekKey, result.totalSeconds, result.goalSeconds, result.shippedAt, this.clock());
  }

  weekResults(reminderId: number, limit: number): WeekResult[] {
    return this.db
      .query<{ week_key: string; total_seconds: number; goal_seconds: number; shipped_at: number | null }, [number, number]>(
        "SELECT week_key, total_seconds, goal_seconds, shipped_at FROM week_results WHERE reminder_id = ? ORDER BY week_key DESC LIMIT ?",
      )
      .all(reminderId, limit)
      .map((r) => ({ weekKey: r.week_key, totalSeconds: r.total_seconds, goalSeconds: r.goal_seconds, shippedAt: r.shipped_at }));
  }

  // ---------- oauth ----------

  createOAuthState(state: string, slackId: string, ttlMs: number) {
    this.db.query("INSERT INTO oauth_states (state, slack_id, expires_at) VALUES (?, ?, ?)").run(state, slackId, this.clock() + ttlMs);
  }

  /** Single use: the state is deleted whether or not it's still valid. */
  consumeOAuthState(state: string): string | null {
    const row = this.db
      .query<{ slack_id: string; expires_at: number }, [string]>("DELETE FROM oauth_states WHERE state = ? RETURNING slack_id, expires_at")
      .get(state);
    if (!row || row.expires_at < this.clock()) return null;
    return row.slack_id;
  }

  pruneOAuthStates() {
    this.db.query("DELETE FROM oauth_states WHERE expires_at < ?").run(this.clock());
  }

  // ---------- admin usage ----------

  usageCounts(now: number): UsageCounts {
    const n = (sql: string, ...params: number[]) => (this.db.query<{ n: number }, number[]>(sql).get(...params)?.n ?? 0);
    return {
      users: n("SELECT COUNT(*) AS n FROM users"),
      connected: n("SELECT COUNT(*) AS n FROM users WHERE token_status = 'ok'"),
      needsReconnect: n("SELECT COUNT(*) AS n FROM users WHERE token_status = 'invalid'"),
      activelyNagged: n(
        `SELECT COUNT(*) AS n FROM users u WHERE u.token_status = 'ok' AND (u.paused_until IS NULL OR u.paused_until <= ?)
         AND EXISTS (SELECT 1 FROM reminders r WHERE r.slack_id = u.slack_id AND r.enabled = 1)`,
        now,
      ),
      pausedUsers: n("SELECT COUNT(*) AS n FROM users WHERE paused_until > ?", now),
      reminders: n("SELECT COUNT(*) AS n FROM reminders"),
      remindersEnabled: n("SELECT COUNT(*) AS n FROM reminders WHERE enabled = 1"),
      dmsLastDay: n("SELECT COUNT(*) AS n FROM slot_log WHERE outcome = 'sent' AND created_at > ?", now - 24 * 3600_000),
      dmsLastWeek: n("SELECT COUNT(*) AS n FROM slot_log WHERE outcome = 'sent' AND created_at > ?", now - 7 * 24 * 3600_000),
    };
  }

  /** Every reminder with its owner's state, cached numbers and whether it shipped in `weekKey`. No Hackatime calls. */
  adminReminderRows(weekKey: string): AdminReminderRow[] {
    const rows = this.db
      .query<
        ReminderRow & {
          u_tz: string | null;
          u_token_status: TokenStatus;
          u_paused_until: number | null;
          c_week_key: string | null;
          c_today_start: number | null;
          c_week_seconds: number | null;
          c_today_seconds: number | null;
          c_computed_at: number | null;
          shipped_at: number | null;
        },
        [string]
      >(
        `SELECT r.*, u.tz AS u_tz, u.token_status AS u_token_status, u.paused_until AS u_paused_until,
                c.week_key AS c_week_key, c.today_start AS c_today_start, c.week_seconds AS c_week_seconds,
                c.today_seconds AS c_today_seconds, c.computed_at AS c_computed_at, w.shipped_at AS shipped_at
         FROM reminders r
         JOIN users u ON u.slack_id = r.slack_id
         LEFT JOIN status_cache c ON c.reminder_id = r.id
         LEFT JOIN week_state w ON w.reminder_id = r.id AND w.week_key = ?
         ORDER BY r.slack_id, r.id`,
      )
      .all(weekKey);
    return rows.map((row) => ({
      reminder: toReminder(row),
      tz: row.u_tz,
      tokenStatus: row.u_token_status,
      pausedUntil: row.u_paused_until,
      cache:
        row.c_week_key !== null && row.c_computed_at !== null
          ? {
              weekKey: row.c_week_key,
              todayStart: row.c_today_start ?? 0,
              weekSeconds: row.c_week_seconds ?? 0,
              todaySeconds: row.c_today_seconds ?? 0,
              computedAt: row.c_computed_at,
            }
          : null,
      shippedAt: row.shipped_at,
    }));
  }

  /** How a finished week went across all reminders that have a recorded result. */
  weekResultSummary(weekKey: string): { recorded: number; hit: number; shipped: number } {
    const row = this.db
      .query<{ recorded: number; hit: number | null; shipped: number | null }, [string]>(
        `SELECT COUNT(*) AS recorded, SUM(total_seconds >= goal_seconds) AS hit, SUM(shipped_at IS NOT NULL) AS shipped
         FROM week_results WHERE week_key = ?`,
      )
      .get(weekKey);
    return { recorded: row?.recorded ?? 0, hit: row?.hit ?? 0, shipped: row?.shipped ?? 0 };
  }

  // ---------- status cache (fallback when Hackatime is down) ----------

  saveStatusCache(reminderId: number, c: CachedStatus) {
    this.db
      .query(
        `INSERT INTO status_cache (reminder_id, week_key, today_start, week_seconds, today_seconds, computed_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (reminder_id) DO UPDATE SET week_key = excluded.week_key, today_start = excluded.today_start,
           week_seconds = excluded.week_seconds, today_seconds = excluded.today_seconds, computed_at = excluded.computed_at`,
      )
      .run(reminderId, c.weekKey, c.todayStart, c.weekSeconds, c.todaySeconds, c.computedAt);
  }

  statusCache(reminderId: number): CachedStatus | null {
    const row = this.db
      .query<{ week_key: string; today_start: number; week_seconds: number; today_seconds: number; computed_at: number }, [number]>(
        "SELECT * FROM status_cache WHERE reminder_id = ?",
      )
      .get(reminderId);
    return row
      ? { weekKey: row.week_key, todayStart: row.today_start, weekSeconds: row.week_seconds, todaySeconds: row.today_seconds, computedAt: row.computed_at }
      : null;
  }
}
