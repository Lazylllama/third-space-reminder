import type { App, BlockAction, ButtonAction } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";
import { decrypt } from "../crypto";
import { type Deps, isAllowed } from "../deps";
import { evaluate, tokenFor } from "../engine/evaluate";
import { type HackatimeProject, isValidProjectName } from "../hackatime/client";
import { pickQuote } from "../messages/quotes";
import { ACTION_SHIPPED, ACTION_SNOOZE, ACTION_STATUS, escapeMrkdwn, renderMessage, statusLine } from "../messages/render";
import { RECENT_QUOTES } from "../scheduler";
import { isValidZone } from "../time/week";
import type { Reminder, User } from "../types";
import { formatDuration, formatLocal } from "../util/format";
import { A, buildHome, MAX_REMINDERS } from "./home";
import {
  PROJECTS_ACTION,
  parseReminderSubmission,
  parseTzSubmission,
  projectOption,
  REMINDER_MODAL,
  reminderModal,
  searchZones,
  TZ_ACTION,
  TZ_MODAL,
  tzModal,
} from "./modals";
import { adhocKind, statusMessage, summaryText } from "./status";

const HOUR = 3600_000;
const TZ_REFRESH_MS = 6 * HOUR;
const PROJECT_CACHE_MS = 5 * 60_000;

export function registerHandlers(app: App, deps: Deps) {
  const { repo, log } = deps;
  const projectCache = new Map<string, { at: number; projects: HackatimeProject[] }>();

  const publishHome = async (client: WebClient, slackId: string) => {
    try {
      await client.views.publish({ user_id: slackId, view: await buildHome(deps, slackId) });
    } catch (err) {
      log.error(`couldn't publish home for ${slackId}`, err);
    }
  };

  /** Make sure we have a timezone, pulling it from the Slack profile unless the user picked one. */
  const ensureTz = async (slackId: string): Promise<User> => {
    const user = repo.ensureUser(slackId);
    const stale = !user.tzSyncedAt || deps.clock() - user.tzSyncedAt > TZ_REFRESH_MS;
    if (user.tzSource !== "manual" && (!user.tz || stale)) {
      try {
        const tz = await deps.slack.userTimezone(slackId);
        if (tz) repo.setTimezone(slackId, tz, "slack");
        else repo.touchTzSync(slackId);
      } catch (err) {
        log.warn(`couldn't read slack timezone for ${slackId}`, err);
      }
    }
    return repo.getUser(slackId)!;
  };

  /** Reminder by id, only if it belongs to this user. */
  const ownReminder = (slackId: string, value: string | undefined): Reminder | null => {
    const id = Number(value);
    if (!Number.isInteger(id)) return null;
    const r = repo.getReminder(id);
    return r && r.slackId === slackId ? r : null;
  };

  const reply = async (client: WebClient, channel: string | undefined, threadTs: string | undefined, text: string, blocks?: KnownBlock[]) => {
    if (!channel) return;
    await client.chat.postMessage({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}), ...(blocks ? { blocks } : {}) });
  };

  // ---------------------------------------------------------------- home tab

  app.event("app_home_opened", async ({ event, client }) => {
    if (event.tab !== "home") return;
    if (isAllowed(deps, event.user)) await ensureTz(event.user);
    await publishHome(client, event.user);
  });

  app.action(A.connect, async ({ ack }) => {
    await ack(); // URL button, the browser does the rest
  });

  app.action(A.refresh, async ({ ack, body, client }) => {
    await ack();
    await ensureTz(body.user.id);
    await publishHome(client, body.user.id);
  });

  app.action<BlockAction<ButtonAction>>(A.newReminder, async ({ ack, body, client }) => {
    await ack();
    const slackId = body.user.id;
    if (!isAllowed(deps, slackId)) return;
    const user = await ensureTz(slackId);
    if (user.tokenStatus !== "ok") return publishHome(client, slackId);
    if (!user.tz) {
      await client.views.open({ trigger_id: body.trigger_id, view: tzModal({ current: null, slackTz: null, followingSlack: false }) });
      return;
    }
    if (repo.listReminders(slackId).length >= MAX_REMINDERS) return publishHome(client, slackId);
    await client.views.open({ trigger_id: body.trigger_id, view: reminderModal({ reminder: null, tz: user.tz, now: deps.clock() }) });
  });

  app.action<BlockAction<ButtonAction>>(A.editReminder, async ({ ack, body, action, client }) => {
    await ack();
    const r = ownReminder(body.user.id, action.value);
    const user = repo.getUser(body.user.id);
    if (!r || !user?.tz) return publishHome(client, body.user.id);
    await client.views.open({ trigger_id: body.trigger_id, view: reminderModal({ reminder: r, tz: user.tz, now: deps.clock() }) });
  });

  app.action<BlockAction<ButtonAction>>(A.toggleReminder, async ({ ack, body, action, client }) => {
    await ack();
    const r = ownReminder(body.user.id, action.value);
    if (r) repo.setReminderEnabled(r.id, !r.enabled);
    await publishHome(client, body.user.id);
  });

  app.action<BlockAction<ButtonAction>>(A.deleteReminder, async ({ ack, body, action, client }) => {
    await ack();
    const r = ownReminder(body.user.id, action.value);
    if (r) {
      repo.deleteReminder(r.id);
      log.info(`${body.user.id} deleted reminder ${r.id}`);
    }
    await publishHome(client, body.user.id);
  });

  app.action<BlockAction<ButtonAction>>(A.testReminder, async ({ ack, body, action, client }) => {
    await ack();
    const r = ownReminder(body.user.id, action.value);
    const user = repo.getUser(body.user.id);
    if (!r || !user) return;
    await sendAdhocNag(client, user, r);
  });

  app.action<BlockAction<ButtonAction>>(A.changeTz, async ({ ack, body, client }) => {
    await ack();
    const user = repo.ensureUser(body.user.id);
    const slackTz = await deps.slack.userTimezone(body.user.id).catch(() => null);
    await client.views.open({
      trigger_id: body.trigger_id,
      view: tzModal({ current: user.tz, slackTz, followingSlack: user.tzSource !== "manual" }),
    });
  });

  app.action<BlockAction<ButtonAction>>(A.pauseAll, async ({ ack, body, action, client }) => {
    await ack();
    const days = Math.min(14, Math.max(1, Number(action.value) || 1));
    repo.setPausedUntil(body.user.id, deps.clock() + days * 24 * HOUR);
    await publishHome(client, body.user.id);
  });

  app.action(A.resumeAll, async ({ ack, body, client }) => {
    await ack();
    repo.setPausedUntil(body.user.id, null);
    await publishHome(client, body.user.id);
  });

  app.action(A.disconnect, async ({ ack, body, client }) => {
    await ack();
    const user = repo.getUser(body.user.id);
    if (user?.tokenEnc) {
      try {
        await deps.hackatime.revoke(decrypt(user.tokenEnc, deps.config.encryptionKey));
      } catch (err) {
        log.warn("revoke failed", err);
      }
    }
    repo.clearToken(body.user.id);
    log.info(`${body.user.id} disconnected hackatime`);
    await publishHome(client, body.user.id);
  });

  // ---------------------------------------------------------------- modals

  app.options(PROJECTS_ACTION, async ({ ack, body }) => {
    const slackId = body.user.id;
    const query = String(body.value ?? "").trim();
    const user = repo.getUser(slackId);
    let projects: HackatimeProject[] = [];
    if (user && user.tokenStatus === "ok" && isAllowed(deps, slackId)) {
      const cached = projectCache.get(slackId);
      if (cached && deps.clock() - cached.at < PROJECT_CACHE_MS) projects = cached.projects;
      else {
        try {
          projects = await deps.hackatime.projects(tokenFor(deps, user));
          projectCache.set(slackId, { at: deps.clock(), projects });
        } catch (err) {
          log.warn(`couldn't list projects for ${slackId}`, err);
        }
      }
    }
    const q = query.toLowerCase();
    const matches = projects.filter((p) => isValidProjectName(p.name) && p.name.toLowerCase().includes(q));
    const options = matches.slice(0, 99).map((p) => projectOption(p.name, p.archived ? `${p.name} (archived)` : p.name));
    if (query && isValidProjectName(query) && !projects.some((p) => p.name === query)) {
      options.unshift(projectOption(query, `➕ use "${query}" (no activity yet)`));
    }
    await ack({ options });
  });

  app.options(TZ_ACTION, async ({ ack, body }) => {
    const zones = searchZones(String(body.value ?? ""));
    const now = deps.clock();
    await ack({
      options: zones.map((z) => ({ text: { type: "plain_text" as const, text: `${z} (now ${formatLocal(now, z)})`.slice(0, 75) }, value: z })),
    });
  });

  app.view(REMINDER_MODAL, async ({ ack, body, view, client }) => {
    const slackId = body.user.id;
    const parsed = parseReminderSubmission(view.state.values as never);
    if (!parsed.input) {
      await ack({ response_action: "errors", errors: parsed.errors });
      return;
    }
    await ack();
    if (!isAllowed(deps, slackId)) return;
    const meta = JSON.parse(view.private_metadata || "{}") as { id?: number | null };
    let reminder: Reminder | null;
    if (meta.id) {
      const existing = ownReminder(slackId, String(meta.id));
      reminder = existing ? repo.updateReminder(existing.id, parsed.input) : null;
      log.info(`${slackId} updated reminder ${meta.id}`);
    } else {
      if (repo.listReminders(slackId).length >= MAX_REMINDERS) return publishHome(client, slackId);
      reminder = repo.createReminder(slackId, parsed.input);
      log.info(`${slackId} created reminder ${reminder.id}`);
      const user = repo.getUser(slackId);
      if (user) await sendArmed(user, reminder);
    }
    await publishHome(client, slackId);
  });

  app.view(TZ_MODAL, async ({ ack, body, view, client }) => {
    const slackId = body.user.id;
    const parsed = parseTzSubmission(view.state.values as never);
    let slackTz: string | null = null;
    if (parsed.follow) {
      slackTz = await deps.slack.userTimezone(slackId).catch(() => null);
      if (!slackTz) parsed.errors.follow = "your slack profile has no timezone, pick one below instead";
    }
    if (Object.keys(parsed.errors).length > 0) {
      await ack({ response_action: "errors", errors: parsed.errors });
      return;
    }
    await ack();
    if (parsed.follow && slackTz) repo.setTimezone(slackId, slackTz, "slack");
    else if (parsed.tz && isValidZone(parsed.tz)) repo.setTimezone(slackId, parsed.tz, "manual");
    await publishHome(client, slackId);
  });

  // ---------------------------------------------------------------- DM buttons

  app.action<BlockAction<ButtonAction>>(ACTION_SNOOZE, async ({ ack, body, action, client }) => {
    await ack();
    const r = ownReminder(body.user.id, action.value);
    if (!r) return;
    repo.setSnooze(r.id, deps.clock() + HOUR);
    const q = pickQuote("snoozed", repo.recentQuoteIds(body.user.id, RECENT_QUOTES));
    await reply(client, body.channel?.id, body.message?.ts, q.text);
  });

  app.action<BlockAction<ButtonAction>>(ACTION_STATUS, async ({ ack, body, action, client }) => {
    await ack();
    const user = repo.getUser(body.user.id);
    const r = ownReminder(body.user.id, action.value);
    if (!user || !r) return;
    const msg = await statusMessage(deps, user, r);
    await reply(client, body.channel?.id, body.message?.ts, msg.text, msg.blocks);
  });

  app.action<BlockAction<ButtonAction>>(ACTION_SHIPPED, async ({ ack, body, action, client }) => {
    await ack();
    const [id, weekKey] = String(action.value ?? "").split("|");
    const r = ownReminder(body.user.id, id);
    if (!r || !weekKey || !/^\d{4}-\d{2}-\d{2}$/.test(weekKey)) return;
    const already = repo.shippedAt(r.id, weekKey);
    if (!already) repo.setShipped(r.id, weekKey, deps.clock());
    const channel = body.channel?.id;
    const ts = body.message?.ts;
    if (channel && ts && body.message) {
      const blocks = ((body.message.blocks ?? []) as KnownBlock[]).filter((b) => b.type !== "actions");
      blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "🚢 shipped. logged." }] });
      await client.chat.update({ channel, ts, text: String(body.message.text ?? "shipped"), blocks });
    }
    if (!already) {
      const q = pickQuote("shipped", repo.recentQuoteIds(body.user.id, RECENT_QUOTES));
      await reply(client, channel, ts, q.text);
    }
    await publishHome(client, body.user.id);
  });

  // ---------------------------------------------------------------- /goblin

  app.command("/goblin", async ({ ack, command, respond, client }) => {
    await ack();
    const slackId = command.user_id;
    if (!isAllowed(deps, slackId)) {
      await respond({ response_type: "ephemeral", text: "the goblin isn't taking new victims right now." });
      return;
    }
    const [sub = "status", arg] = command.text.trim().toLowerCase().split(/\s+/);
    const user = await ensureTz(slackId);

    switch (sub) {
      case "status":
      case "": {
        const msg = await statusMessage(deps, user);
        await respond({ response_type: "ephemeral", text: msg.text, blocks: msg.blocks });
        return;
      }
      case "pause": {
        const days = arg ? Number(arg) : 1;
        if (!Number.isFinite(days) || days <= 0 || days > 14) {
          await respond({ response_type: "ephemeral", text: "pause for how many days? 1 to 14, like `/goblin pause 2`." });
          return;
        }
        const until = deps.clock() + days * 24 * HOUR;
        repo.setPausedUntil(slackId, until);
        await respond({
          response_type: "ephemeral",
          text: `fine. the goblin is paused until ${user.tz ? formatLocal(until, user.tz) : new Date(until).toISOString()}. \`/goblin resume\` to bring it back early.`,
        });
        await publishHome(client, slackId);
        return;
      }
      case "resume":
      case "unpause": {
        repo.setPausedUntil(slackId, null);
        await respond({ response_type: "ephemeral", text: "the goblin is back. it missed you. menacingly." });
        await publishHome(client, slackId);
        return;
      }
      case "test": {
        const r = repo.listReminders(slackId)[0];
        if (!r) {
          await respond({ response_type: "ephemeral", text: "no reminders yet. set one up on the goblin's home tab." });
          return;
        }
        await sendAdhocNag(client, user, r);
        await respond({ response_type: "ephemeral", text: "check your DMs." });
        return;
      }
      default:
        await respond({ response_type: "ephemeral", text: HELP_TEXT });
    }
  });

  // ---------------------------------------------------------------- DMs

  app.event("message", async ({ event, client }) => {
    const e = event as { channel_type?: string; subtype?: string; bot_id?: string; user?: string; text?: string; channel: string; ts: string; thread_ts?: string };
    if (e.channel_type !== "im" || e.subtype || e.bot_id || !e.user) return;
    const slackId = e.user;
    if (!isAllowed(deps, slackId)) return;
    const text = (e.text ?? "").trim().toLowerCase();
    if (/^(status|stats|how am i doing\??)$/.test(text)) {
      const user = await ensureTz(slackId);
      const msg = await statusMessage(deps, user);
      await client.chat.postMessage({ channel: e.channel, text: msg.text, blocks: msg.blocks, ...(e.thread_ts ? { thread_ts: e.thread_ts } : {}) });
      return;
    }
    if (/^(help|\?)$/.test(text)) {
      await client.chat.postMessage({ channel: e.channel, text: HELP_TEXT, ...(e.thread_ts ? { thread_ts: e.thread_ts } : {}) });
      return;
    }
    const q = pickQuote("chatter", []);
    await client.chat.postMessage({ channel: e.channel, text: q.text, ...(e.thread_ts ? { thread_ts: e.thread_ts } : {}) });
  });

  // ---------------------------------------------------------------- helpers

  async function sendAdhocNag(client: WebClient, user: User, r: Reminder) {
    try {
      const { status, staleSince } = await evaluate(deps, r, user, deps.clock());
      const kind = adhocKind(deps, r, status);
      if (!kind) {
        await deps.slack.sendDm(user.slackId, { text: `nothing to nag about right now: ${summaryText(status)}` });
        return;
      }
      const msg = renderMessage(kind, {
        slackId: user.slackId,
        status,
        reminder: r,
        showName: repo.listReminders(user.slackId).length > 1,
        recent: repo.recentQuoteIds(user.slackId, RECENT_QUOTES),
        staleSince,
      });
      await deps.slack.sendDm(user.slackId, msg);
      repo.recordQuote(r.id, `adhoc|${deps.clock()}`, msg.quoteId);
    } catch (err) {
      log.warn(`adhoc nag failed for ${user.slackId}`, err);
      await deps.slack.sendDm(user.slackId, { text: "the goblin couldn't reach hackatime just now. try again in a minute." }).catch(() => null);
    }
    await publishHome(client, user.slackId);
  }

  async function sendArmed(user: User, r: Reminder) {
    if (!user.tz) return;
    try {
      const { status } = await evaluate(deps, r, user, deps.clock());
      const text =
        `hey <@${user.slackId}>, the goblin is armed for *${escapeMrkdwn(r.name)}* 👺\n` +
        `goal ${formatDuration(r.goalSeconds)} a week, about ${formatDuration(status.base)} per work day. ${summaryText(status)}`;
      await deps.slack.sendDm(user.slackId, {
        text,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text } },
          { type: "context", elements: [{ type: "mrkdwn", text: statusLine(status) }] },
        ],
      });
    } catch (err) {
      log.warn(`couldn't send the armed message to ${user.slackId}`, err);
    }
  }
}

export const HELP_TEXT = [
  "*deadline goblin* 👺 nags you until your weekly hours are in.",
  "• set things up on the goblin's *home* tab (click its name, then Home).",
  "• `/goblin status`: where you're at",
  "• `/goblin pause 2`: shut up for 2 days (1 to 14)",
  "• `/goblin resume`: come back early",
  "• `/goblin test`: send a nag right now",
  "• in this DM you can also just type `status` or `help`.",
].join("\n");
