import type { KnownBlock } from "@slack/types";
import type { Deps } from "../deps";
import { decide, type MessageKind } from "../engine/decide";
import { evaluate } from "../engine/evaluate";
import type { Status } from "../engine/plan";
import { escapeMrkdwn, statusLine } from "../messages/render";
import type { Reminder, User } from "../types";
import { formatCountdown, formatDuration, progressBar } from "../util/format";

const md = (t: string) => ({ type: "mrkdwn" as const, text: t });

export function summaryText(s: Status): string {
  switch (s.phase) {
    case "weekDone":
      return "week done ✅";
    case "overtime":
      return `past the wrap-up, ${formatDuration(s.weekLeft)} short. reset in ${formatCountdown(s.timeToReset)}.`;
    case "prestart":
      return "new week started, your plan kicks off tomorrow.";
    case "finalDay":
      return `final day: ${formatDuration(s.weekLeft)} left, wrap-up in ${formatCountdown(s.timeToSoft)}.`;
    default:
      if (s.isSlackDay && s.debt === 0) return "slack day, you're on track 😴";
      if (s.dayLeft === 0) return `today's done ✅ ${formatDuration(s.weekLeft)} left this week.`;
      return `${formatDuration(s.dayLeft)} left today${s.debt > 0 ? `, ${formatDuration(s.debt)} of debt` : ""}.`;
  }
}

/** Status of one or all of a user's reminders, as message blocks. */
export async function statusMessage(deps: Deps, user: User, only?: Reminder): Promise<{ text: string; blocks: KnownBlock[] }> {
  if (user.tokenStatus !== "ok") {
    const text = "hackatime isn't connected. open the goblin's home tab to connect it.";
    return { text, blocks: [{ type: "section", text: md(text) }] };
  }
  if (!user.tz) {
    const text = "the goblin doesn't know your timezone yet. set it on the home tab.";
    return { text, blocks: [{ type: "section", text: md(text) }] };
  }
  const reminders = only ? [only] : deps.repo.listReminders(user.slackId);
  if (reminders.length === 0) {
    const text = "no reminders yet. set one up on the goblin's home tab.";
    return { text, blocks: [{ type: "section", text: md(text) }] };
  }

  const now = deps.clock();
  const blocks: KnownBlock[] = [];
  const lines: string[] = [];
  for (const r of reminders) {
    try {
      const { status, staleSince } = await evaluate(deps, r, user, now);
      const head = `*${escapeMrkdwn(r.name)}*${r.enabled ? "" : " _(paused)_"}  ${progressBar(status.weekSeconds, status.goal)}  ${formatDuration(status.weekSeconds, "down")} / ${formatDuration(status.goal)}`;
      blocks.push({ type: "section", text: md(`${head}\n${summaryText(status)}`) });
      const ctx = [statusLine(status)];
      if (staleSince) ctx.push(`_numbers from ${formatCountdown(now - staleSince)} ago, hackatime isn't answering_`);
      blocks.push({ type: "context", elements: ctx.map(md) });
      lines.push(`${r.name}: ${summaryText(status)}`);
    } catch (err) {
      deps.log.warn(`status: couldn't evaluate reminder ${r.id}`, err);
      blocks.push({ type: "section", text: md(`*${escapeMrkdwn(r.name)}*: ⚠️ couldn't reach hackatime right now.`) });
      lines.push(`${r.name}: couldn't reach hackatime`);
    }
  }
  return { text: lines.join("\n"), blocks };
}

/**
 * Pick what a "send me a nag now" should say, without recording any one-shot markers.
 * Null when there's honestly nothing to nag about (plan hasn't started, on-track slack day).
 */
export function adhocKind(deps: Deps, r: Reminder, status: Status): MessageKind | null {
  const shipped = deps.repo.shippedAt(r.id, status.week.key) !== null;
  const d = decide(
    status,
    { at: status.now, hour: true, final: status.phase === "finalDay", headsUp: false },
    { kickoffSent: true, weekDoneAnnounced: true, dayDoneAnnounced: false, shipped, shipNag: r.shipNag },
  );
  if (d.kind) return d.kind;
  if (status.phase === "weekDone") return "weekDone";
  if (status.phase === "prestart" || (status.isSlackDay && status.debt === 0)) return null;
  return status.dayLeft === 0 ? "dayDone" : "nag";
}
