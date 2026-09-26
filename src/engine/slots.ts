import type { ReminderSettings } from "../types";
import { addDays, localDate, localDateTime, planDates, softDeadline, weekOf } from "../time/week";

export const HOUR_MS = 3600_000;
export const MINUTE_MS = 60_000;
/** A missed slot is still sent if we get to it within this long (and before the next slot). */
export const SLOT_GRACE_MS = 45 * MINUTE_MS;
/** Final-day escalation: hourly from this local time... */
export const FINAL_DAY_START_MINUTES = 12 * 60;
/** ...then every 30 min during the last 3 hours before the wrap-up. */
export const FINAL_SPRINT_MS = 3 * HOUR_MS;
export const FINAL_SPRINT_STEP_MS = 30 * MINUTE_MS;
/** Heads-up the day before the final day, at this local time. */
export const HEADS_UP_MINUTES = 19 * 60;

export interface Slot {
  readonly at: number;
  /** A configured reminder hour. */
  hour: boolean;
  /** Final-day escalation slot. */
  final: boolean;
  /** Day-before-final heads-up slot. */
  headsUp: boolean;
}

export function slotKey(slot: Slot): string {
  return `slot|${new Date(slot.at).toISOString()}`;
}

type SlotSettings = Pick<ReminderSettings, "hours" | "wrapDay" | "wrapMinutes">;

const slotCache = new Map<string, readonly Slot[]>();
const SLOT_CACHE_MAX = 5000;

/** All slots whose local date (in `zone`) is `date`. Sorted, deduped by instant. Memoized (it's pure). */
export function slotsForDate(date: string, zone: string, settings: SlotSettings): readonly Slot[] {
  const key = `${date}|${zone}|${settings.hours.join(",")}|${settings.wrapDay}|${settings.wrapMinutes}`;
  const hit = slotCache.get(key);
  if (hit) return hit;
  const slots = Object.freeze(buildSlotsForDate(date, zone, settings).map((s) => Object.freeze(s)));
  if (slotCache.size >= SLOT_CACHE_MAX) slotCache.clear();
  slotCache.set(key, slots);
  return slots;
}

function buildSlotsForDate(date: string, zone: string, settings: SlotSettings): Slot[] {
  const byAt = new Map<number, Slot>();
  const add = (at: number, kind: "hour" | "final" | "headsUp") => {
    if (localDate(at, zone) !== date) return; // DST shifts can push a time onto another date
    const slot = byAt.get(at) ?? { at, hour: false, final: false, headsUp: false };
    slot[kind] = true;
    byAt.set(at, slot);
  };

  for (const h of settings.hours) add(localDateTime(date, h * 60, zone), "hour");

  // The date is the final day (or the day before it) of the week containing its local noon. Neighbouring
  // weeks are checked too so an odd zone can never slip through; their final days are 7 days away, so they never double up.
  const noon = localDateTime(date, 12 * 60, zone);
  const weeks = new Map([noon - 24 * HOUR_MS, noon, noon + 24 * HOUR_MS].map((t) => [weekOf(t).key, weekOf(t)]));
  for (const week of weeks.values()) {
    const soft = softDeadline(week, zone, settings.wrapDay, settings.wrapMinutes);
    const plan = planDates(week, zone, soft);
    if (plan.last === date) {
      const sprintStart = soft - FINAL_SPRINT_MS;
      for (let at = localDateTime(date, FINAL_DAY_START_MINUTES, zone); at < sprintStart; at += HOUR_MS) add(at, "final");
      for (let at = sprintStart; at < soft; at += FINAL_SPRINT_STEP_MS) add(at, "final");
    }
    if (addDays(plan.last, -1) === date) add(localDateTime(date, HEADS_UP_MINUTES, zone), "headsUp");
  }

  return [...byAt.values()].sort((a, b) => a.at - b.at);
}

/**
 * The slot that should be acted on at `now`, if any: the latest slot at or before `now`,
 * as long as we're still within the grace period and the next slot hasn't started.
 */
export function dueSlot(now: number, zone: string, settings: SlotSettings): Slot | null {
  const today = localDate(now, zone);
  const slots = [...slotsForDate(addDays(today, -1), zone, settings), ...slotsForDate(today, zone, settings), ...slotsForDate(addDays(today, 1), zone, settings)];
  let due: Slot | null = null;
  let next: Slot | null = null;
  for (const slot of slots) {
    if (slot.at <= now) due = slot;
    else {
      next = slot;
      break;
    }
  }
  if (!due) return null;
  if (now >= due.at + SLOT_GRACE_MS) return null;
  if (next && now >= next.at) return null;
  return due;
}

/** The next slot strictly after `now` (for display). */
export function nextSlot(now: number, zone: string, settings: SlotSettings): Slot | null {
  const today = localDate(now, zone);
  for (let i = 0; i < 8; i++) {
    const found = slotsForDate(addDays(today, i), zone, settings).find((s) => s.at > now);
    if (found) return found;
  }
  return null;
}
