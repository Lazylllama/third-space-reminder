import type { ModalView, PlainTextOption } from "@slack/types";
import type { ReminderInput } from "../db/repo";
import { isValidProjectName } from "../hackatime/client";
import { formatLocal, formatHourLabel, formatMinutesOfDay, WEEKDAY_NAMES } from "../util/format";
import { isValidZone, weekOf } from "../time/week";
import { DEFAULT_SETTINGS, type Reminder } from "../types";

export const REMINDER_MODAL = "reminder_modal";
export const TZ_MODAL = "tz_modal";
export const PROJECTS_ACTION = "projects";
export const TZ_ACTION = "tz";

export const MAX_PROJECTS = 20;
export const MIN_GOAL_HOURS = 0.5;
export const MAX_GOAL_HOURS = 80;
export const MIN_WRAP_MINUTES = 12 * 60;

const text = (t: string) => ({ type: "plain_text" as const, text: t, emoji: true });

export function projectOption(name: string, label?: string): PlainTextOption {
  return { text: text(truncate(label ?? name, 75)), value: name };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

const hourOption = (h: number): PlainTextOption => ({ text: text(formatHourLabel(h)), value: String(h) });
const dayOption = (d: number): PlainTextOption => ({ text: text(WEEKDAY_NAMES[d]!), value: String(d) });
const SHIP_OPTION: PlainTextOption = { text: text("keep nagging me to ship on thirdspace.hackclub.com once the goal is hit"), value: "ship" };

export function reminderModal(opts: { reminder: Reminder | null; tz: string; now: number }): ModalView {
  const r = opts.reminder;
  const s = r ?? { ...DEFAULT_SETTINGS, name: "third space", projects: [] as string[] };
  const resetLocal = formatLocal(weekOf(opts.now).end, opts.tz);

  return {
    type: "modal",
    callback_id: REMINDER_MODAL,
    private_metadata: JSON.stringify({ id: r?.id ?? null }),
    title: text(r ? "edit reminder" : "new reminder"),
    submit: text(r ? "save" : "arm the goblin"),
    close: text("cancel"),
    blocks: [
      {
        type: "input",
        block_id: "name",
        label: text("name"),
        element: { type: "plain_text_input", action_id: "name", initial_value: s.name, max_length: 60 },
      },
      {
        type: "input",
        block_id: "projects",
        label: text("hackatime projects"),
        hint: text("time on these projects counts together toward the goal. type a name that isn't listed to add it anyway."),
        element: {
          type: "multi_external_select",
          action_id: PROJECTS_ACTION,
          min_query_length: 0,
          max_selected_items: MAX_PROJECTS,
          placeholder: text("pick your projects"),
          ...(s.projects.length > 0 ? { initial_options: s.projects.map((p) => projectOption(p)) } : {}),
        },
      },
      {
        type: "input",
        block_id: "goal",
        label: text("weekly goal (hours)"),
        hint: text("third space needs 10 hours a week."),
        element: {
          type: "number_input",
          action_id: "goal",
          is_decimal_allowed: true,
          min_value: String(MIN_GOAL_HOURS),
          max_value: String(MAX_GOAL_HOURS),
          initial_value: String(Math.round((s.goalSeconds / 3600) * 100) / 100),
        },
      },
      {
        type: "input",
        block_id: "hours",
        label: text("nag me at"),
        hint: text(`times are in ${opts.tz}. on the final day the goblin also escalates on its own.`),
        element: {
          type: "multi_static_select",
          action_id: "hours",
          placeholder: text("pick hours"),
          options: Array.from({ length: 24 }, (_, h) => hourOption(h)),
          initial_options: s.hours.map(hourOption),
        },
      },
      {
        type: "input",
        block_id: "slack_days",
        optional: true,
        label: text("slack-off days"),
        hint: text("no nags on these days while you're on track. if you're behind, the goblin only asks for the debt."),
        element: {
          type: "checkboxes",
          action_id: "slack_days",
          options: [1, 2, 3, 4, 5, 6, 7].map(dayOption),
          ...(s.slackDays.length > 0 ? { initial_options: s.slackDays.map(dayOption) } : {}),
        },
      },
      {
        type: "input",
        block_id: "wrap_day",
        label: text("plan to be done by (day)"),
        element: {
          type: "static_select",
          action_id: "wrap_day",
          options: [dayOption(7), dayOption(6)],
          initial_option: dayOption(s.wrapDay),
        },
      },
      {
        type: "input",
        block_id: "wrap_time",
        label: text("plan to be done by (time)"),
        hint: text(`the real reset is monday 00:00 new york time (${resetLocal} for you). the goblin plans for you to be done before that, and never later than the reset.`),
        element: { type: "timepicker", action_id: "wrap_time", initial_time: formatMinutesOfDay(s.wrapMinutes) },
      },
      {
        type: "input",
        block_id: "ship",
        optional: true,
        label: text("shipping"),
        element: {
          type: "checkboxes",
          action_id: "ship",
          options: [SHIP_OPTION],
          ...(s.shipNag ? { initial_options: [SHIP_OPTION] } : {}),
        },
      },
    ],
  };
}

type StateValues = Record<string, Record<string, Record<string, unknown>>>;

interface SelectedOption {
  value: string;
}

function field(values: StateValues, block: string, action = block): Record<string, unknown> {
  return values[block]?.[action] ?? {};
}

export interface ParsedReminder {
  input: ReminderInput | null;
  errors: Record<string, string>;
}

/** Validate a reminder modal submission. Every rule the UI hints at is enforced here too. */
export function parseReminderSubmission(values: StateValues): ParsedReminder {
  const errors: Record<string, string> = {};

  const name = String(field(values, "name").value ?? "").trim();
  if (!name) errors.name = "give it a name";
  else if (name.length > 60) errors.name = "keep it under 60 characters";

  const projects = [
    ...new Set(((field(values, "projects", PROJECTS_ACTION).selected_options as SelectedOption[] | undefined) ?? []).map((o) => o.value)),
  ];
  if (projects.length === 0) errors.projects = "pick at least one project";
  else if (projects.length > MAX_PROJECTS) errors.projects = `at most ${MAX_PROJECTS} projects`;
  else if (!projects.every(isValidProjectName)) errors.projects = "project names can't contain commas or leading/trailing spaces";

  const goalHours = Number(field(values, "goal").value);
  if (!Number.isFinite(goalHours) || goalHours < MIN_GOAL_HOURS || goalHours > MAX_GOAL_HOURS) {
    errors.goal = `pick something between ${MIN_GOAL_HOURS} and ${MAX_GOAL_HOURS} hours`;
  }

  const hours = [
    ...new Set(((field(values, "hours").selected_options as SelectedOption[] | undefined) ?? []).map((o) => Number(o.value))),
  ]
    .filter((h) => Number.isInteger(h) && h >= 0 && h <= 23)
    .sort((a, b) => a - b);
  if (hours.length === 0) errors.hours = "pick at least one hour, the goblin needs to know when to haunt you";

  const slackDays = [
    ...new Set(((field(values, "slack_days").selected_options as SelectedOption[] | undefined) ?? []).map((o) => Number(o.value))),
  ]
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)
    .sort((a, b) => a - b);
  if (slackDays.length >= 7) errors.slack_days = "leave at least one day to actually code on";

  const wrapDay = Number((field(values, "wrap_day").selected_option as SelectedOption | undefined)?.value);
  if (wrapDay !== 6 && wrapDay !== 7) errors.wrap_day = "saturday or sunday";

  const time = String(field(values, "wrap_time").selected_time ?? "");
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  const wrapMinutes = m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  if (!Number.isFinite(wrapMinutes) || wrapMinutes < MIN_WRAP_MINUTES || wrapMinutes > 23 * 60 + 59) {
    errors.wrap_time = "pick a time between 12:00 and 23:59";
  }

  const shipNag = ((field(values, "ship").selected_options as SelectedOption[] | undefined) ?? []).some((o) => o.value === "ship");

  if (Object.keys(errors).length > 0) return { input: null, errors };
  return {
    input: { name, projects, goalSeconds: Math.round(goalHours * 3600), hours, slackDays, wrapDay, wrapMinutes, shipNag },
    errors,
  };
}

export function tzModal(opts: { current: string | null; slackTz: string | null; followingSlack: boolean }): ModalView {
  const followOption: PlainTextOption = {
    text: text(opts.slackTz ? `follow my slack profile (${opts.slackTz})` : "follow my slack profile"),
    value: "follow",
  };
  return {
    type: "modal",
    callback_id: TZ_MODAL,
    title: text("timezone"),
    submit: text("save"),
    close: text("cancel"),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "the goblin uses this for your reminder hours and for what counts as \"today\". the weekly reset itself is always monday 00:00 new york time.",
        },
      },
      {
        type: "input",
        block_id: "follow",
        optional: true,
        label: text("automatic"),
        element: {
          type: "checkboxes",
          action_id: "follow",
          options: [followOption],
          ...(opts.followingSlack ? { initial_options: [followOption] } : {}),
        },
      },
      {
        type: "input",
        block_id: "tz",
        optional: true,
        label: text("or pick one"),
        hint: text("ignored while 'follow my slack profile' is checked."),
        element: {
          type: "external_select",
          action_id: TZ_ACTION,
          min_query_length: 1,
          placeholder: text("search, e.g. stockholm"),
          ...(opts.current ? { initial_option: { text: text(opts.current), value: opts.current } } : {}),
        },
      },
    ],
  };
}

export function parseTzSubmission(values: StateValues): { follow: boolean; tz: string | null; errors: Record<string, string> } {
  const follow = ((field(values, "follow").selected_options as SelectedOption[] | undefined) ?? []).some((o) => o.value === "follow");
  const tz = (field(values, "tz", TZ_ACTION).selected_option as SelectedOption | undefined)?.value ?? null;
  const errors: Record<string, string> = {};
  if (!follow) {
    if (!tz) errors.tz = "pick a timezone, or check 'follow my slack profile'";
    else if (!isValidZone(tz)) errors.tz = "that's not a timezone the goblin knows";
  }
  return { follow, tz, errors };
}

let zoneList: string[] | null = null;
export function allZones(): string[] {
  if (!zoneList) {
    const zones = new Set(Intl.supportedValuesOf("timeZone"));
    zones.add("UTC");
    zoneList = [...zones].filter(isValidZone).sort();
  }
  return zoneList;
}

export function searchZones(query: string, limit = 100): string[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, "_");
  return allZones()
    .filter((z) => z.toLowerCase().includes(q))
    .slice(0, limit);
}
