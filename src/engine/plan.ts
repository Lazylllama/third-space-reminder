import type { ReminderSettings } from "../types";
import {
  type WeekPlanDates,
  type WeekWindow,
  endOfLocalDate,
  isoWeekday,
  localDate,
  planDates,
  softDeadline,
  startOfLocalDate,
  weekOf,
} from "../time/week";

export type Phase = "prestart" | "normal" | "finalDay" | "overtime" | "weekDone";

export type PlanSettings = Pick<ReminderSettings, "goalSeconds" | "slackDays" | "wrapDay" | "wrapMinutes">;

export interface Status {
  now: number;
  zone: string;
  week: WeekWindow;
  /** Wrap-up moment (epoch ms). */
  soft: number;
  plan: WeekPlanDates;
  /** Plan dates that aren't slack days. */
  activeDates: string[];
  today: string;
  /** Start of today's counting window: local midnight, but never before the week start. */
  todayStart: number;
  isPlanDate: boolean;
  isSlackDay: boolean;
  phase: Phase;
  goal: number;
  /** Planned seconds per active day. */
  base: number;
  weekSeconds: number;
  todaySeconds: number;
  beforeSeconds: number;
  expectedBefore: number;
  /** Seconds behind the even pace at the start of today (whole seconds, rounded up). */
  debt: number;
  /** Seconds ahead of the even pace at the start of today (whole seconds, rounded down). */
  ahead: number;
  /** What today needs (whole seconds, rounded up). */
  todayTarget: number;
  dayLeft: number;
  weekLeft: number;
  /** Active plan dates from today onward (today included when it's active). */
  activeDaysLeft: number;
  timeToSoft: number;
  timeToReset: number;
}

/** Round up to whole seconds, ignoring float noise. */
export function ceilSec(x: number): number {
  return Math.max(0, Math.ceil(x - 1e-6));
}

function floorSec(x: number): number {
  return Math.max(0, Math.floor(x + 1e-6));
}

export interface EvalWindows {
  week: WeekWindow;
  today: string;
  /** Start of today's window, clipped to the week start. */
  todayStart: number;
}

/** Which windows to ask Hackatime about when evaluating at `now`. */
export function windowsFor(now: number, zone: string): EvalWindows {
  const week = weekOf(now);
  const today = localDate(now, zone);
  const todayStart = Math.max(startOfLocalDate(today, zone), week.start);
  return { week, today, todayStart };
}

export function activeDatesOf(plan: WeekPlanDates, slackDays: number[]): string[] {
  const active = plan.dates.filter((d) => !slackDays.includes(isoWeekday(d)));
  // A zone/week where every plan date is a slack day would divide by zero: treat all dates as work days.
  return active.length > 0 ? active : [...plan.dates];
}

export interface StatusInput {
  now: number;
  zone: string;
  settings: PlanSettings;
  /** Group seconds in [week.start, now). */
  weekSeconds: number;
  /** Group seconds in [todayStart, now). */
  todaySeconds: number;
}

/** Target for a day given what was done before it. Active days split what's left; slack days only ask for the debt. */
function targetFor(
  date: string,
  goal: number,
  before: number,
  plan: WeekPlanDates,
  activeDates: string[],
): { target: number; debt: number; ahead: number; expectedBefore: number; remaining: number; isSlack: boolean } {
  const n = activeDates.length;
  const elapsed = activeDates.filter((d) => d < date).length;
  const remaining = n - elapsed;
  const expectedBefore = (goal * elapsed) / n;
  const debt = ceilSec(expectedBefore - before);
  const ahead = floorSec(before - expectedBefore);
  const isSlack = plan.dates.includes(date) && !activeDates.includes(date);
  let target: number;
  if (isSlack) target = debt;
  else target = remaining > 0 ? ceilSec(Math.max(0, goal - before) / remaining) : ceilSec(Math.max(0, goal - before));
  return { target, debt, ahead, expectedBefore, remaining, isSlack };
}

export function computeStatus(input: StatusInput): Status {
  const { now, zone, settings } = input;
  const { week, today, todayStart } = windowsFor(now, zone);
  const soft = softDeadline(week, zone, settings.wrapDay, settings.wrapMinutes);
  const plan = planDates(week, zone, soft);
  const activeDates = activeDatesOf(plan, settings.slackDays);
  const goal = settings.goalSeconds;
  const base = goal / activeDates.length;

  const weekSeconds = Math.max(0, input.weekSeconds);
  const todaySeconds = Math.min(Math.max(0, input.todaySeconds), weekSeconds);
  const beforeSeconds = Math.max(0, weekSeconds - todaySeconds);
  const weekLeft = ceilSec(goal - weekSeconds);
  const isPlanDate = plan.dates.includes(today);

  let phase: Phase;
  if (weekLeft === 0) phase = "weekDone";
  else if (now >= soft) phase = "overtime";
  else if (today < plan.first) phase = "prestart";
  else if (today === plan.last) phase = "finalDay";
  else phase = "normal";

  let t = { target: 0, debt: 0, ahead: 0, expectedBefore: 0, remaining: activeDates.length, isSlack: false };
  if (isPlanDate) t = targetFor(today, goal, beforeSeconds, plan, activeDates);
  else if (today > plan.last) t = { ...t, target: weekLeft, remaining: 0, expectedBefore: goal, debt: weekLeft };

  const dayLeft = Math.min(weekLeft, Math.max(0, t.target - todaySeconds));

  return {
    now,
    zone,
    week,
    soft,
    plan,
    activeDates,
    today,
    todayStart,
    isPlanDate,
    isSlackDay: t.isSlack,
    phase,
    goal,
    base,
    weekSeconds,
    todaySeconds,
    beforeSeconds,
    expectedBefore: t.expectedBefore,
    debt: t.debt,
    ahead: t.ahead,
    todayTarget: t.target,
    dayLeft,
    weekLeft,
    activeDaysLeft: activeDates.filter((d) => d >= today).length,
    timeToSoft: Math.max(0, soft - now),
    timeToReset: Math.max(0, week.end - now),
  };
}

export interface DayWindow {
  date: string;
  start: number;
  end: number;
}

/** Windows for a per-day breakdown of the week up to `now` (future days are left out). */
export function breakdownWindows(now: number, zone: string, settings: PlanSettings): {
  pre: { start: number; end: number } | null;
  days: DayWindow[];
  post: { start: number; end: number } | null;
} {
  const week = weekOf(now);
  const soft = softDeadline(week, zone, settings.wrapDay, settings.wrapMinutes);
  const plan = planDates(week, zone, soft);
  const cap = Math.min(now, week.end);

  const firstStart = Math.max(startOfLocalDate(plan.first, zone), week.start);
  const pre = firstStart > week.start && week.start < cap ? { start: week.start, end: Math.min(firstStart, cap) } : null;

  const days: DayWindow[] = [];
  for (const date of plan.dates) {
    const start = Math.max(startOfLocalDate(date, zone), week.start);
    const end = Math.min(endOfLocalDate(date, zone), cap);
    if (start >= cap) break;
    days.push({ date, start, end });
  }

  const lastEnd = endOfLocalDate(plan.last, zone);
  const post = cap > lastEnd ? { start: lastEnd, end: cap } : null;
  return { pre, days, post };
}

export interface DayRow {
  date: string;
  isSlack: boolean;
  isToday: boolean;
  /** Target that day had at its start. */
  target: number;
  done: number;
  met: boolean;
  /** Debt at the start of that day. */
  debtAtStart: number;
}

/** Rebuild what each day's target was, from per-day totals. `done` must be in `days` order. */
export function dayBreakdown(
  now: number,
  zone: string,
  settings: PlanSettings,
  preSeconds: number,
  doneByDate: Map<string, number>,
): DayRow[] {
  const week = weekOf(now);
  const soft = softDeadline(week, zone, settings.wrapDay, settings.wrapMinutes);
  const plan = planDates(week, zone, soft);
  const activeDates = activeDatesOf(plan, settings.slackDays);
  const today = localDate(now, zone);
  const rows: DayRow[] = [];
  let before = Math.max(0, preSeconds);
  for (const date of plan.dates) {
    if (date > today) break;
    const t = targetFor(date, settings.goalSeconds, before, plan, activeDates);
    const done = Math.max(0, doneByDate.get(date) ?? 0);
    rows.push({ date, isSlack: t.isSlack, isToday: date === today, target: t.target, done, met: done >= t.target, debtAtStart: t.debt });
    before += done;
  }
  return rows;
}
