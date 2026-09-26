import type { KnownBlock } from "@slack/types";
import { type ReminderState, type ReminderUsage, summarizeUsage, type UserUsage } from "../admin/usage";
import type { Deps } from "../deps";
import { escapeMrkdwn } from "../messages/render";
import { previousWeek, weekOf } from "../time/week";
import { formatCountdown, formatDuration } from "../util/format";

/** Slack allows 3000 chars per text; stay under it with some room. */
const MAX_SECTION_CHARS = 2900;
const MAX_LINES_PER_SECTION = 20;
const MAX_LIST_SECTIONS = 5;

const md = (t: string) => ({ type: "mrkdwn" as const, text: t });

const LABEL: Record<ReminderState, string> = {
  reconnect: "🔌 needs reconnect",
  behind: "⚠️ behind",
  done: "🏁 done, not shipped",
  noData: "❔ no data",
  onTrack: "✅ on track",
  shipped: "🚢 shipped",
  paused: "⏸ paused",
};

function reminderText(r: ReminderUsage, now: number): string {
  const name = `*${escapeMrkdwn(r.name)}*`;
  const progress = r.weekSeconds !== null ? ` ${formatDuration(r.weekSeconds, "down")} / ${formatDuration(r.goalSeconds)}` : "";
  let state: string;
  if (r.state === "behind") state = `⚠️ ${formatDuration(r.debt)} behind`;
  else if (r.note) state = `${LABEL[r.state].split(" ")[0]} ${r.note}`;
  else state = LABEL[r.state];
  const age = r.asOf !== null ? ` _(${formatCountdown(now - r.asOf) === "now" ? "just now" : `${formatCountdown(now - r.asOf)} ago`})_` : "";
  return `${name}${progress} ${state}${age}`;
}

export function userLine(u: UserUsage, now: number): string {
  return `<@${u.slackId}> · ${u.reminders.map((r) => reminderText(r, now)).join(" · ")}`;
}

/** Admin-only usage overview for the Home tab. Pure SQLite, never calls Hackatime. */
export function adminSection(deps: Deps, now = deps.clock()): KnownBlock[] {
  const week = weekOf(now);
  const counts = deps.repo.usageCounts(now);
  const summary = summarizeUsage(deps.repo.adminReminderRows(week.key), now);
  const last = deps.repo.weekResultSummary(previousWeek(week).key);

  const blocks: KnownBlock[] = [
    { type: "divider" },
    { type: "header", text: { type: "plain_text", text: "🛠 admin", emoji: true } },
    {
      type: "section",
      fields: [
        md(`*actively nagged*\n${counts.activelyNagged}`),
        md(`*connected*\n${counts.connected}${counts.needsReconnect ? ` (+${counts.needsReconnect} need reconnect)` : ""}`),
        md(`*opened the goblin*\n${counts.users}`),
        md(`*paused*\n${counts.pausedUsers}`),
        md(`*reminders*\n${counts.remindersEnabled} on / ${counts.reminders} total`),
        md(`*DMs sent*\n${counts.dmsLastDay} last 24h · ${counts.dmsLastWeek} last 7d`),
      ],
    },
  ];

  const tallyText = (Object.keys(LABEL) as ReminderState[])
    .filter((s) => summary.tally[s] > 0)
    .map((s) => `${LABEL[s]} ${summary.tally[s]}`)
    .join(" · ");
  const context = [`*this week:* ${tallyText || "no reminders yet"}`];
  if (last.recorded > 0) context.push(`*last week:* ${last.hit}/${last.recorded} hit the goal, ${last.shipped} shipped`);
  blocks.push({ type: "context", elements: context.map(md) });

  // The user list, chunked to respect Slack's per-block text limit.
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentLen = 0;
  let listed = 0;
  for (const u of summary.users) {
    let line = userLine(u, now);
    if (line.length > MAX_SECTION_CHARS - 1) line = `${line.slice(0, MAX_SECTION_CHARS - 2)}…`;
    const fits = current.length === 0 || (current.length < MAX_LINES_PER_SECTION && currentLen + line.length + 1 <= MAX_SECTION_CHARS);
    if (!fits) {
      if (chunks.length + 1 >= MAX_LIST_SECTIONS) break;
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += line.length + 1;
    listed++;
  }
  if (current.length > 0) chunks.push(current);
  for (const chunk of chunks) blocks.push({ type: "section", text: md(chunk.join("\n")) });

  const notes = ["numbers are from each reminder's last check-in, not live. only admins see this section."];
  if (listed < summary.users.length) notes.unshift(`…and ${summary.users.length - listed} more`);
  blocks.push({ type: "context", elements: notes.map(md) });
  return blocks;
}
