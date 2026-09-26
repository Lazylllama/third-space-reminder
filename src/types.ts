/** The knobs that drive the plan math for one reminder. */
export interface ReminderSettings {
  /** Weekly goal in seconds (Third Space: 10h = 36000). */
  goalSeconds: number;
  /** Local hours (0-23) to nag at, sorted, unique. */
  hours: number[];
  /** ISO weekdays (1 = Mon ... 7 = Sun) that are slack-off days. */
  slackDays: number[];
  /** ISO weekday of the wrap-up (6 = Sat, 7 = Sun). */
  wrapDay: number;
  /** Minutes after local midnight for the wrap-up, 720..1439. */
  wrapMinutes: number;
  /** Keep nagging to ship on thirdspace.hackclub.com once the goal is hit. */
  shipNag: boolean;
}

export interface Reminder extends ReminderSettings {
  id: number;
  slackId: string;
  name: string;
  projects: string[];
  enabled: boolean;
  snoozedUntil: number | null;
  createdAt: number;
  updatedAt: number;
}

export type TokenStatus = "none" | "ok" | "invalid";

export interface User {
  slackId: string;
  hackatimeUserId: number | null;
  hackatimeSlackId: string | null;
  tokenEnc: string | null;
  tokenStatus: TokenStatus;
  tz: string | null;
  tzSource: "slack" | "manual" | null;
  tzSyncedAt: number | null;
  pausedUntil: number | null;
  lastReconnectNag: string | null;
  createdAt: number;
  updatedAt: number;
}

export const DEFAULT_SETTINGS: ReminderSettings = {
  goalSeconds: 10 * 3600,
  hours: [17, 18, 19, 20, 21],
  slackDays: [],
  wrapDay: 7,
  wrapMinutes: 22 * 60,
  shipNag: true,
};
