import { DateTime } from "luxon";

/** "1h 26m", "45m", "10h", "0m". Rounds up by default (use for things you still owe). */
export function formatDuration(seconds: number, round: "up" | "down" = "up"): string {
  const s = Math.max(0, seconds);
  const minutes = round === "up" ? Math.ceil(s / 60 - 1e-9) : Math.floor(s / 60 + 1e-9);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Countdown: "2d 3h", "5h 12m", "12m", "now". Rounds down. */
export function formatCountdown(ms: number): string {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60_000);
  if (totalMinutes <= 0) return "now";
  const d = Math.floor(totalMinutes / 1440);
  const h = Math.floor((totalMinutes % 1440) / 60);
  const m = totalMinutes % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** "Sun 22:00" in the given zone. */
export function formatLocal(ms: number, zone: string): string {
  return DateTime.fromMillis(ms, { zone }).toFormat("ccc HH:mm");
}

/** "Mon 21 Sep" */
export function formatLocalDate(isoDate: string): string {
  return DateTime.fromISO(isoDate, { zone: "UTC" }).toFormat("ccc d LLL");
}

export function formatDays(n: number): string {
  return `${n} ${n === 1 ? "day" : "days"}`;
}

/** Text progress bar, e.g. ▰▰▰▰▱▱▱▱▱▱ */
export function progressBar(done: number, goal: number, width = 10): string {
  const ratio = goal > 0 ? Math.min(1, Math.max(0, done / goal)) : 0;
  const filled = Math.floor(ratio * width + 1e-9);
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

export function formatHourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function formatMinutesOfDay(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export const WEEKDAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export const WEEKDAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
