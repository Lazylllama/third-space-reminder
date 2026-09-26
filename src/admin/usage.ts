import type { AdminReminderRow } from "../db/repo";
import { computeStatus } from "../engine/plan";
import { weekOf } from "../time/week";

export type ReminderState = "reconnect" | "behind" | "done" | "noData" | "onTrack" | "shipped" | "paused";

/** Worst first: the order admins care about. */
export const STATE_ORDER: readonly ReminderState[] = ["reconnect", "behind", "done", "noData", "onTrack", "shipped", "paused"];

export interface ReminderUsage {
  reminderId: number;
  name: string;
  state: ReminderState;
  /** Extra detail for paused / noData (why). */
  note: string | null;
  weekSeconds: number | null;
  goalSeconds: number;
  debt: number;
  /** When the numbers were computed (last check-in), if any. */
  asOf: number | null;
}

export interface UserUsage {
  slackId: string;
  reminders: ReminderUsage[];
  worst: ReminderState;
  maxDebt: number;
}

export interface UsageSummary {
  tally: Record<ReminderState, number>;
  users: UserUsage[];
}

/**
 * Classify every reminder from the numbers the scheduler/home already cached (no Hackatime calls).
 * Status is rebuilt as of the moment those numbers were fetched.
 */
export function classifyReminder(row: AdminReminderRow, now: number): ReminderUsage {
  const r = row.reminder;
  const base = { reminderId: r.id, name: r.name, goalSeconds: r.goalSeconds, weekSeconds: null, debt: 0, asOf: null };
  if (row.tokenStatus === "invalid") return { ...base, state: "reconnect", note: null };
  if (row.tokenStatus === "none") return { ...base, state: "paused", note: "disconnected" };
  if (row.pausedUntil && row.pausedUntil > now) return { ...base, state: "paused", note: "paused" };
  if (!r.enabled) return { ...base, state: "paused", note: "reminder off" };
  if (!row.tz) return { ...base, state: "noData", note: "no timezone" };

  const week = weekOf(now);
  const cache = row.cache;
  if (!cache || cache.weekKey !== week.key || cache.computedAt < week.start) {
    return { ...base, state: "noData", note: "no check-in yet this week" };
  }

  const status = computeStatus({
    now: cache.computedAt,
    zone: row.tz,
    settings: r,
    weekSeconds: cache.weekSeconds,
    todaySeconds: cache.todaySeconds,
  });
  const common = { ...base, weekSeconds: status.weekSeconds, asOf: cache.computedAt, note: null };
  if (status.phase === "weekDone") {
    if (row.shippedAt) return { ...common, state: "shipped" };
    return r.shipNag ? { ...common, state: "done" } : { ...common, state: "shipped", note: "done (ship nags off)" };
  }
  if (status.debt > 0) return { ...common, state: "behind", debt: status.debt };
  return { ...common, state: "onTrack" };
}

export function summarizeUsage(rows: AdminReminderRow[], now: number): UsageSummary {
  const tally = Object.fromEntries(STATE_ORDER.map((s) => [s, 0])) as Record<ReminderState, number>;
  const byUser = new Map<string, ReminderUsage[]>();
  for (const row of rows) {
    const usage = classifyReminder(row, now);
    tally[usage.state]++;
    const list = byUser.get(row.reminder.slackId) ?? [];
    list.push(usage);
    byUser.set(row.reminder.slackId, list);
  }

  const rank = (s: ReminderState) => STATE_ORDER.indexOf(s);
  const users: UserUsage[] = [...byUser.entries()].map(([slackId, reminders]) => ({
    slackId,
    reminders,
    worst: reminders.reduce<ReminderState>((w, r) => (rank(r.state) < rank(w) ? r.state : w), "paused"),
    maxDebt: Math.max(0, ...reminders.map((r) => r.debt)),
  }));
  users.sort((a, b) => rank(a.worst) - rank(b.worst) || b.maxDebt - a.maxDebt || a.slackId.localeCompare(b.slackId));
  return { tally, users };
}
