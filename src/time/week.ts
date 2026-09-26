import { DateTime, IANAZone } from "luxon";

/** Third Space resets every Monday 00:00 in New York time. */
export const RESET_ZONE = "America/New_York";

/** Local hour (in the user's zone) at or after which a week that starts on that date is treated as starting the next day. */
export const FIRST_DAY_CUTOFF_MINUTES = 18 * 60;

export interface WeekWindow {
  /** Inclusive start, epoch ms. */
  start: number;
  /** Exclusive end, epoch ms. */
  end: number;
  /** ISO date of the Monday (in New York) that starts the week, e.g. "2026-09-21". */
  key: string;
}

export function isValidZone(zone: string): boolean {
  return typeof zone === "string" && zone.length > 0 && IANAZone.isValidZone(zone);
}

export function weekOf(instantMs: number): WeekWindow {
  const start = DateTime.fromMillis(instantMs, { zone: RESET_ZONE }).startOf("week");
  const end = start.plus({ weeks: 1 });
  return { start: start.toMillis(), end: end.toMillis(), key: start.toISODate()! };
}

export function previousWeek(week: WeekWindow): WeekWindow {
  return weekOf(week.start - 1);
}

export function nextWeek(week: WeekWindow): WeekWindow {
  return weekOf(week.end);
}

export function localDate(instantMs: number, zone: string): string {
  return DateTime.fromMillis(instantMs, { zone }).toISODate()!;
}

/** Start of the given local date (ISO) in the zone, epoch ms. */
export function startOfLocalDate(date: string, zone: string): number {
  return DateTime.fromISO(date, { zone }).startOf("day").toMillis();
}

/** Start of the local date after the given one, epoch ms. */
export function endOfLocalDate(date: string, zone: string): number {
  return DateTime.fromISO(date, { zone }).startOf("day").plus({ days: 1 }).toMillis();
}

/** A local wall-clock time on a local date, epoch ms. Nonexistent times (DST gaps) shift forward. */
export function localDateTime(date: string, minutes: number, zone: string): number {
  return DateTime.fromISO(date, { zone })
    .startOf("day")
    .set({ hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0, millisecond: 0 })
    .toMillis();
}

/** ISO weekday (1 = Monday ... 7 = Sunday) of a local ISO date. */
export function isoWeekday(date: string): number {
  return DateTime.fromISO(date, { zone: "UTC" }).weekday;
}

export function addDays(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: "UTC" }).plus({ days }).toISODate()!;
}

/**
 * The "wrap-up" moment: the plan aims to have the goal done by this time.
 * It's the last `wrapDay` (ISO weekday) on or before the local date of the reset,
 * at `wrapMinutes` local time, but never later than the actual reset.
 */
export function softDeadline(week: WeekWindow, zone: string, wrapDay: number, wrapMinutes: number): number {
  const lastLocal = DateTime.fromMillis(week.end - 1, { zone }).startOf("day");
  const back = (lastLocal.weekday - wrapDay + 7) % 7;
  const date = lastLocal.minus({ days: back }).toISODate()!;
  const candidate = localDateTime(date, wrapMinutes, zone);
  const clamped = Math.min(candidate, week.end);
  // Safety net: a wrap-up that lands within the first day of the week makes no sense, use the real reset instead.
  if (clamped <= week.start + 24 * 3600_000) return week.end;
  return clamped;
}

export interface WeekPlanDates {
  /** Consecutive local ISO dates the plan spreads work over. */
  dates: string[];
  first: string;
  last: string;
}

/**
 * Local dates that make up the plan for the week.
 * - First date: the local date the week starts on, unless the week starts at/after 18:00 local, then the next date.
 * - Last date: the local date of the soft deadline.
 */
export function planDates(week: WeekWindow, zone: string, soft: number): WeekPlanDates {
  const start = DateTime.fromMillis(week.start, { zone });
  const startMinutes = start.hour * 60 + start.minute;
  let first = start.startOf("day");
  if (startMinutes >= FIRST_DAY_CUTOFF_MINUTES) first = first.plus({ days: 1 });
  const last = DateTime.fromMillis(soft - 1, { zone }).startOf("day");

  const dates: string[] = [];
  let cursor = first;
  while (cursor.toMillis() <= last.toMillis() && dates.length < 10) {
    dates.push(cursor.toISODate()!);
    cursor = cursor.plus({ days: 1 });
  }
  if (dates.length === 0) dates.push(last.toISODate()!);
  return { dates, first: dates[0]!, last: dates[dates.length - 1]! };
}
