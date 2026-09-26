import type { ActionsBlock, Button, KnownBlock } from "@slack/types";
import type { MessageKind } from "../engine/decide";
import type { Status } from "../engine/plan";
import { formatCountdown, formatDays, formatDuration, formatLocal } from "../util/format";
import { pickQuote, type QuotePool } from "./quotes";

export type RenderKind = MessageKind | "shipped" | "snoozed" | "reconnect" | "chatter";

export interface RenderReminder {
  id: number;
  name: string;
  projects: string[];
  shipNag: boolean;
}

export interface Recap {
  totalSeconds: number;
  goalSeconds: number;
}

export interface RenderContext {
  slackId: string;
  status: Status | null;
  reminder: RenderReminder | null;
  /** Show which reminder this is about (when a user has more than one). */
  showName: boolean;
  /** Recently used quote ids for this user, to avoid repeats. */
  recent: readonly string[];
  recap?: Recap | null;
  /** When numbers come from the fallback cache: when they were computed. */
  staleSince?: number | null;
  random?: () => number;
}

export interface RenderedMessage {
  text: string;
  blocks: KnownBlock[];
  quoteId: string;
}

export const ACTION_SNOOZE = "dm_snooze";
export const ACTION_STATUS = "dm_status";
export const ACTION_SHIPPED = "dm_shipped";

const THIRD_SPACE_URL = "https://thirdspace.hackclub.com";

/** Escape user-provided text for Slack mrkdwn. */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function templateVars(status: Status | null, recap?: Recap | null): Record<string, string> {
  const v: Record<string, string> = {};
  if (status) {
    v.today_left = formatDuration(status.dayLeft);
    v.today_target = formatDuration(status.todayTarget);
    v.today_done = formatDuration(status.todaySeconds, "down");
    v.week_done = formatDuration(status.weekSeconds, "down");
    v.week_goal = formatDuration(status.goal);
    v.week_left = formatDuration(status.weekLeft);
    v.debt = formatDuration(status.debt);
    v.ahead = formatDuration(status.ahead, "down");
    v.base = formatDuration(status.base);
    v.days_left = formatDays(status.activeDaysLeft);
    v.wrap_up = formatLocal(status.soft, status.zone);
    v.time_to_wrap = formatCountdown(status.timeToSoft);
    v.reset = formatLocal(status.week.end, status.zone);
    v.time_to_reset = formatCountdown(status.timeToReset);
  }
  if (recap) {
    v.last_week = formatDuration(recap.totalSeconds, "down");
    v.last_goal = formatDuration(recap.goalSeconds);
  }
  return v;
}

/** Replace {placeholders}. Unknown placeholders are left as-is (tests make sure none exist). */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (match, name: string) => vars[name] ?? match);
}

/** One-line numbers summary shown under every nag. */
export function statusLine(status: Status): string {
  const parts: string[] = [];
  const week = `week ${formatDuration(status.weekSeconds, "down")} / ${formatDuration(status.goal)}`;
  const wrap = `wrap-up ${formatLocal(status.soft, status.zone)} (in ${formatCountdown(status.timeToSoft)})`;
  const reset = `reset ${formatLocal(status.week.end, status.zone)} (in ${formatCountdown(status.timeToReset)})`;

  switch (status.phase) {
    case "weekDone":
      parts.push(`✅ ${week}`, reset);
      break;
    case "overtime":
      parts.push(week, `${formatDuration(status.weekLeft)} left`, "wrap-up passed", reset);
      break;
    case "prestart":
      parts.push(week, `plan starts ${status.plan.first}`, reset);
      break;
    default: {
      parts.push(week);
      if (status.isSlackDay && status.debt === 0) parts.push("today: slack day 😴");
      else parts.push(`today ${formatDuration(status.todaySeconds, "down")} / ${formatDuration(status.todayTarget)}`);
      if (status.debt > 0) parts.push(`debt ${formatDuration(status.debt)}`);
      else if (status.ahead >= 60) parts.push(`ahead ${formatDuration(status.ahead, "down")}`);
      parts.push(wrap);
      if (status.week.end !== status.soft) parts.push(reset);
    }
  }
  return parts.join(" · ");
}

function poolFor(kind: RenderKind): QuotePool {
  return kind;
}

function button(text: string, actionId: string, value: string, style?: "primary" | "danger"): Button {
  return { type: "button", text: { type: "plain_text", text, emoji: true }, action_id: actionId, value, ...(style ? { style } : {}) };
}

export function renderMessage(kind: RenderKind, ctx: RenderContext): RenderedMessage {
  const vars = templateVars(ctx.status, ctx.recap);
  const quote = pickQuote(poolFor(kind), ctx.recent, ctx.random);
  let body = fillTemplate(quote.text, vars);

  if (kind === "kickoff" && ctx.recap) {
    const hit = ctx.recap.totalSeconds >= ctx.recap.goalSeconds;
    const recapQuote = pickQuote(hit ? "recapHit" : "recapMiss", ctx.recent, ctx.random);
    body += `\n${fillTemplate(recapQuote.text, vars)}`;
  }
  const shipPending = kind === "weekDone" && ctx.reminder?.shipNag;
  if (shipPending) body += `\nnow go ship it on <${THIRD_SPACE_URL}|thirdspace.hackclub.com> and hit the button below when you have.`;
  if (kind === "ship") body = body.replace("thirdspace.hackclub.com", `<${THIRD_SPACE_URL}|thirdspace.hackclub.com>`);

  const text = `hey <@${ctx.slackId}>, ${body}`;
  const blocks: KnownBlock[] = [{ type: "section", text: { type: "mrkdwn", text } }];

  const context: string[] = [];
  if (ctx.status && kind !== "chatter" && kind !== "snoozed" && kind !== "shipped") context.push(statusLine(ctx.status));
  if (ctx.staleSince && ctx.status) {
    context.push(`_hackatime isn't answering, numbers from ${formatCountdown(ctx.status.now - ctx.staleSince)} ago_`);
  }
  if (ctx.showName && ctx.reminder) {
    context.push(`📌 *${escapeMrkdwn(ctx.reminder.name)}* (${ctx.reminder.projects.map(escapeMrkdwn).join(", ")})`);
  }
  if (context.length > 0) blocks.push({ type: "context", elements: context.map((c) => ({ type: "mrkdwn", text: c })) });

  const actions = actionsFor(kind, ctx);
  if (actions) blocks.push(actions);

  return { text, blocks, quoteId: quote.id };
}

function actionsFor(kind: RenderKind, ctx: RenderContext): ActionsBlock | null {
  const r = ctx.reminder;
  if (!r) return null;
  const id = String(r.id);
  const weekKey = ctx.status?.week.key ?? "";
  switch (kind) {
    case "weekDone":
      return r.shipNag ? { type: "actions", elements: [button("🚢 i shipped", ACTION_SHIPPED, `${id}|${weekKey}`, "primary")] } : null;
    case "ship":
      return {
        type: "actions",
        elements: [button("🚢 i shipped", ACTION_SHIPPED, `${id}|${weekKey}`, "primary"), button("😴 snooze 1h", ACTION_SNOOZE, id)],
      };
    case "nag":
    case "nagDebt":
    case "slackDayDebt":
    case "weekendWarning":
    case "finalDay":
    case "finalHours":
    case "impossible":
    case "overtime":
    case "kickoff":
      return { type: "actions", elements: [button("😴 snooze 1h", ACTION_SNOOZE, id), button("📊 status", ACTION_STATUS, id)] };
    default:
      return null;
  }
}
