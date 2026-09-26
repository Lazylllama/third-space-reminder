import type { ActionsBlock, Button, HomeView, KnownBlock } from "@slack/types";
import { randomToken } from "../crypto";
import { type Deps, isAllowed } from "../deps";
import { evaluate, evaluateBreakdown } from "../engine/evaluate";
import type { DayRow, Status } from "../engine/plan";
import { nextSlot } from "../engine/slots";
import { escapeMrkdwn, statusLine } from "../messages/render";
import { isoWeekday } from "../time/week";
import type { Reminder, User } from "../types";
import {
  formatCountdown,
  formatDuration,
  formatHourLabel,
  formatLocal,
  formatLocalDate,
  formatMinutesOfDay,
  progressBar,
  WEEKDAY_SHORT,
} from "../util/format";

export const MAX_REMINDERS = 5;
export const OAUTH_STATE_TTL_MS = 30 * 60_000;

export const A = {
  newReminder: "home_new_reminder",
  editReminder: "home_edit_reminder",
  toggleReminder: "home_toggle_reminder",
  deleteReminder: "home_delete_reminder",
  testReminder: "home_test_reminder",
  refresh: "home_refresh",
  changeTz: "home_change_tz",
  pauseAll: "home_pause_all",
  resumeAll: "home_resume_all",
  connect: "home_connect",
  disconnect: "home_disconnect",
} as const;

const plain = (t: string) => ({ type: "plain_text" as const, text: t, emoji: true });
const md = (t: string) => ({ type: "mrkdwn" as const, text: t });

function btn(label: string, actionId: string, value = "", extra: Partial<Button> = {}): Button {
  // Slack rejects empty `value`s, so leave the key out instead.
  return { type: "button", text: plain(label), action_id: actionId, ...(value ? { value } : {}), ...extra };
}

/** Build the App Home for a user. Never throws for Hackatime trouble; it shows it instead. */
export async function buildHome(deps: Deps, slackId: string, now = deps.clock()): Promise<HomeView> {
  const blocks: KnownBlock[] = [
    { type: "header", text: plain("👺 deadline goblin") },
    { type: "context", elements: [md("nags you until your third space hours are in. the week resets monday 00:00 new york time.")] },
  ];

  if (!isAllowed(deps, slackId)) {
    blocks.push({ type: "section", text: md("the goblin isn't taking new victims right now. ask whoever runs it to add you.") });
    return { type: "home", blocks };
  }

  const user = deps.repo.ensureUser(slackId);

  if (user.tokenStatus !== "ok") {
    const state = randomToken();
    deps.repo.createOAuthState(state, slackId, OAUTH_STATE_TTL_MS);
    const url = deps.hackatime.authorizeUrl(state);
    blocks.push(
      { type: "divider" },
      {
        type: "section",
        text: md(
          user.tokenStatus === "invalid"
            ? "⚠️ *hackatime stopped letting the goblin in.* reconnect so it can count your hours again."
            : "*step 1: connect hackatime.* the goblin only asks for read access to your coding time.",
        ),
        accessory: btn(user.tokenStatus === "invalid" ? "reconnect hackatime" : "connect hackatime", A.connect, "", { url, style: "primary" }),
      },
      { type: "context", elements: [md("the link is good for 30 minutes. if it expires, reopen this tab.")] },
    );
    blocks.push(...howItWorks());
    return { type: "home", blocks };
  }

  // Connected
  const tzText = user.tz ? `${user.tz}${user.tzSource === "slack" ? " (from your slack profile)" : " (set by you)"}` : "not set";
  blocks.push(
    { type: "divider" },
    {
      type: "section",
      text: md(`hackatime: connected ✅\ntimezone: *${escapeMrkdwn(tzText)}*`),
      accessory: btn("change timezone", A.changeTz),
    },
  );

  if (!user.tz) {
    blocks.push({ type: "section", text: md("⚠️ the goblin can't tell what time it is for you, so it can't nag. set a timezone above.") });
  }

  if (user.pausedUntil && user.pausedUntil > now) {
    blocks.push({
      type: "section",
      text: md(`⏸ everything is paused until *${user.tz ? formatLocal(user.pausedUntil, user.tz) : new Date(user.pausedUntil).toISOString()}*.`),
      accessory: btn("resume now", A.resumeAll),
    });
  }

  const reminders = deps.repo.listReminders(slackId);
  if (reminders.length === 0) {
    blocks.push({ type: "divider" }, { type: "section", text: md("*step 2: set up a reminder.* pick your projects, the goblin does the math.") });
  }

  const sections = await Promise.all(reminders.map((r) => reminderSection(deps, r, user, now)));
  for (const s of sections) blocks.push({ type: "divider" }, ...s);

  const bottom: Button[] = [];
  if (reminders.length < MAX_REMINDERS) bottom.push(btn("➕ new reminder", A.newReminder, "", { style: "primary" }));
  bottom.push(btn("🔄 refresh", A.refresh));
  if (!user.pausedUntil || user.pausedUntil <= now) bottom.push(btn("⏸ pause everything for a day", A.pauseAll, "1"));
  bottom.push(
    btn("🔌 disconnect hackatime", A.disconnect, "", {
      style: "danger",
      confirm: {
        title: plain("disconnect hackatime?"),
        text: md("the goblin will go quiet until you connect again. your reminders stay saved."),
        confirm: plain("disconnect"),
        deny: plain("keep it"),
      },
    }),
  );
  blocks.push({ type: "divider" }, { type: "actions", elements: bottom });
  blocks.push(...howItWorks());
  return { type: "home", blocks: blocks.slice(0, 100) };
}

async function reminderSection(deps: Deps, r: Reminder, user: User, now: number): Promise<KnownBlock[]> {
  const blocks: KnownBlock[] = [];
  const hours = r.hours.map(formatHourLabel).join(", ");
  const slack = r.slackDays.length > 0 ? ` · slack days: ${r.slackDays.map((d) => WEEKDAY_SHORT[d]).join(", ")}` : "";
  const wrap = `${r.wrapDay === 6 ? "Sat" : "Sun"} ${formatMinutesOfDay(r.wrapMinutes)}`;
  blocks.push({
    type: "section",
    text: md(`*${escapeMrkdwn(r.name)}*${r.enabled ? "" : "  _(paused)_"}\n${r.projects.map((p) => `\`${escapeMrkdwn(p)}\``).join(" ")}`),
  });
  blocks.push({
    type: "context",
    elements: [md(`goal ${formatDuration(r.goalSeconds)}/week · nags at ${hours}${slack} · done by ${wrap} · ship nags ${r.shipNag ? "on" : "off"}`)],
  });

  if (user.tz) {
    try {
      const [{ status, staleSince }, rows] = await Promise.all([
        evaluate(deps, r, user, now),
        evaluateBreakdown(deps, r, user, now).catch(() => [] as DayRow[]),
      ]);
      const shipped = deps.repo.shippedAt(r.id, status.week.key);
      blocks.push({
        type: "section",
        text: md(`${progressBar(status.weekSeconds, status.goal, 12)}  *${formatDuration(status.weekSeconds, "down")} / ${formatDuration(status.goal)}*\n${phaseText(status, r, shipped)}`),
      });
      const ctx = [statusLine(status)];
      if (staleSince) ctx.push(`_hackatime isn't answering, numbers from ${formatCountdown(now - staleSince)} ago_`);
      blocks.push({ type: "context", elements: ctx.map(md) });
      if (rows.length > 0) blocks.push({ type: "context", elements: [md(dayRowsText(rows))] });
      const extra: string[] = [];
      if (r.enabled) {
        const next = nextSlot(now, user.tz, r);
        if (next) extra.push(`next check-in ${formatLocal(next.at, user.tz)}`);
        if (r.snoozedUntil && r.snoozedUntil > now) extra.push(`snoozed until ${formatLocal(r.snoozedUntil, user.tz)}`);
      }
      const history = deps.repo.weekResults(r.id, 4);
      if (history.length > 0) {
        extra.push(
          `past weeks: ${history
            .map((h) => `${formatLocalDate(h.weekKey)} ${h.totalSeconds >= h.goalSeconds ? "✅" : "❌"} ${formatDuration(h.totalSeconds, "down")}${h.shippedAt ? " 🚢" : ""}`)
            .join(" · ")}`,
        );
      }
      if (extra.length > 0) blocks.push({ type: "context", elements: [md(extra.join(" · "))] });
    } catch (err) {
      deps.log.warn(`home: couldn't evaluate reminder ${r.id}`, err);
      blocks.push({ type: "context", elements: [md("⚠️ couldn't reach hackatime right now. hit refresh in a bit.")] });
    }
  }

  const id = String(r.id);
  const actions: ActionsBlock = {
    type: "actions",
    elements: [
      btn("✏️ edit", A.editReminder, id),
      btn(r.enabled ? "⏸ pause" : "▶️ resume", A.toggleReminder, id),
      btn("🔔 send me a nag now", A.testReminder, id),
      btn("🗑 delete", A.deleteReminder, id, {
        style: "danger",
        confirm: {
          title: plain("delete reminder?"),
          text: md(`*${escapeMrkdwn(r.name)}* and its history will be gone.`),
          confirm: plain("delete"),
          deny: plain("keep it"),
        },
      }),
    ],
  };
  blocks.push(actions);
  return blocks;
}

function phaseText(s: Status, r: Reminder, shippedAt: number | null): string {
  switch (s.phase) {
    case "weekDone":
      if (shippedAt) return "week done and shipped 🚢 the goblin is asleep.";
      return r.shipNag ? "week done ✅ now ship it on thirdspace.hackclub.com" : "week done ✅";
    case "overtime":
      return `past the wrap-up, ${formatDuration(s.weekLeft)} short. hard reset in ${formatCountdown(s.timeToReset)}.`;
    case "prestart":
      return "the new week has started, your plan kicks off tomorrow. anything you log now is a head start.";
    case "finalDay":
      return `*final day.* ${formatDuration(s.weekLeft)} left, wrap-up in ${formatCountdown(s.timeToSoft)}.`;
    default:
      if (s.isSlackDay && s.debt === 0) return "slack day 😴 you're on track.";
      if (s.dayLeft === 0) return `today's done ✅ ${formatDuration(s.weekLeft)} left this week.`;
      return `today: ${formatDuration(s.dayLeft)} left of ${formatDuration(s.todayTarget)}${s.debt > 0 ? ` (includes catching up on ${formatDuration(s.debt)} of debt)` : ""}.`;
  }
}

function dayRowsText(rows: DayRow[]): string {
  return rows
    .map((row) => {
      const day = WEEKDAY_SHORT[isoWeekday(row.date)];
      if (row.isSlack && row.target === 0) return `${day} 😴 ${formatDuration(row.done, "down")}`;
      const mark = row.met ? "✅" : row.isToday ? "⏳" : "❌";
      return `${day} ${mark} ${formatDuration(row.done, "down")}/${formatDuration(row.target)}`;
    })
    .join("   ");
}

function howItWorks(): KnownBlock[] {
  return [
    { type: "divider" },
    {
      type: "context",
      elements: [
        md(
          [
            "*how the goblin thinks*",
            "• your goal gets split over the days left before your wrap-up (default sunday 22:00 your time). slack days get no share.",
            "• miss a day and it becomes debt, spread over the days you have left. slack days only ask for the debt, and only when you have some.",
            "• the week hard-resets monday 00:00 new york time. debt never carries over.",
            "• on the final day it checks in hourly from noon, then every 30 min in the last 3 hours. you asked for this.",
            "• multiple projects in one reminder count together (overlapping time is only counted once).",
            "• commands: `/goblin status`, `/goblin pause 2`, `/goblin resume`, `/goblin help`",
          ].join("\n"),
        ),
      ],
    },
  ];
}
