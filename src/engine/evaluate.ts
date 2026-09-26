import { decrypt } from "../crypto";
import type { Deps } from "../deps";
import { HackatimeAuthError } from "../hackatime/client";
import { previousWeek } from "../time/week";
import type { Reminder, User } from "../types";
import { breakdownWindows, computeStatus, dayBreakdown, type DayRow, type Status, windowsFor } from "./plan";

/** Numbers from the fallback cache are used for at most this long. */
export const STALE_LIMIT_MS = 3 * 3600_000;

export class NotConnectedError extends Error {
  constructor() {
    super("Hackatime is not connected");
    this.name = "NotConnectedError";
  }
}

export function tokenFor(deps: Pick<Deps, "config" | "repo" | "log">, user: User): string {
  if (user.tokenStatus !== "ok" || !user.tokenEnc) throw new NotConnectedError();
  try {
    return decrypt(user.tokenEnc, deps.config.encryptionKey);
  } catch {
    // Most likely ENCRYPTION_KEY changed. The stored token is useless now, so ask the user to reconnect.
    deps.repo.setTokenStatus(user.slackId, "invalid");
    deps.log.error(`couldn't decrypt the hackatime token for ${user.slackId} (did ENCRYPTION_KEY change?), marked invalid`);
    throw new HackatimeAuthError("stored token can't be decrypted");
  }
}

/** Run a Hackatime call; an auth failure flips the user to "invalid" so the goblin can ask them to reconnect. */
export async function withAuth<T>(deps: Deps, user: User, fn: (token: string) => Promise<T>): Promise<T> {
  const token = tokenFor(deps, user);
  try {
    return await fn(token);
  } catch (err) {
    if (err instanceof HackatimeAuthError) {
      deps.repo.setTokenStatus(user.slackId, "invalid");
      deps.log.warn(`hackatime token for ${user.slackId} was rejected, marked invalid`);
    }
    throw err;
  }
}

export interface Evaluation {
  status: Status;
  /** Set when the numbers came from the cache because Hackatime failed. */
  staleSince: number | null;
}

/** Fetch the two numbers the plan needs and compute the status. Falls back to recent cached numbers if Hackatime is down. */
export async function evaluate(deps: Deps, reminder: Reminder, user: User, now: number): Promise<Evaluation> {
  const zone = user.tz;
  if (!zone) throw new Error(`no timezone for ${user.slackId}`);
  const { week, todayStart } = windowsFor(now, zone);
  try {
    const [weekSeconds, todaySeconds] = await withAuth(deps, user, (token) =>
      Promise.all([
        deps.hackatime.groupSeconds(token, reminder.projects, week.start, now),
        deps.hackatime.groupSeconds(token, reminder.projects, todayStart, now),
      ]),
    );
    deps.repo.saveStatusCache(reminder.id, { weekKey: week.key, todayStart, weekSeconds, todaySeconds, computedAt: now });
    return { status: computeStatus({ now, zone, settings: reminder, weekSeconds, todaySeconds }), staleSince: null };
  } catch (err) {
    if (err instanceof HackatimeAuthError || err instanceof NotConnectedError) throw err;
    const cached = deps.repo.statusCache(reminder.id);
    if (cached && cached.weekKey === week.key && now - cached.computedAt <= STALE_LIMIT_MS) {
      deps.log.warn(`hackatime failed for reminder ${reminder.id}, using numbers from ${Math.round((now - cached.computedAt) / 60000)}m ago`, err);
      const todaySeconds = cached.todayStart === todayStart ? cached.todaySeconds : 0;
      return {
        status: computeStatus({ now, zone, settings: reminder, weekSeconds: cached.weekSeconds, todaySeconds }),
        staleSince: cached.computedAt,
      };
    }
    throw err;
  }
}

/** Total for the previous week, saved as a result row. Returns null if the reminder didn't exist yet. */
export async function recordPreviousWeek(deps: Deps, reminder: Reminder, user: User, currentWeekStart: number): Promise<{ totalSeconds: number; goalSeconds: number } | null> {
  const prev = previousWeek({ start: currentWeekStart, end: currentWeekStart, key: "" });
  if (reminder.createdAt >= prev.end) return null;
  const totalSeconds = await withAuth(deps, user, (token) => deps.hackatime.groupSeconds(token, reminder.projects, prev.start, prev.end));
  deps.repo.saveWeekResult(reminder.id, {
    weekKey: prev.key,
    totalSeconds,
    goalSeconds: reminder.goalSeconds,
    shippedAt: deps.repo.shippedAt(reminder.id, prev.key),
  });
  return { totalSeconds, goalSeconds: reminder.goalSeconds };
}

/** Per-day rows for the home tab. */
export async function evaluateBreakdown(deps: Deps, reminder: Reminder, user: User, now: number): Promise<DayRow[]> {
  const zone = user.tz;
  if (!zone) return [];
  const w = breakdownWindows(now, zone, reminder);
  return withAuth(deps, user, async (token) => {
    const [pre, ...days] = await Promise.all([
      w.pre ? deps.hackatime.groupSeconds(token, reminder.projects, w.pre.start, w.pre.end) : Promise.resolve(0),
      ...w.days.map((d) => deps.hackatime.groupSeconds(token, reminder.projects, d.start, d.end)),
    ]);
    const done = new Map(w.days.map((d, i) => [d.date, days[i] ?? 0]));
    return dayBreakdown(now, zone, reminder, pre ?? 0, done);
  });
}
