import type { Deps } from "./deps";
import { type DecideState, dayDoneMarker, decide, kickoffMarker, weekDoneMarker } from "./engine/decide";
import { evaluate, NotConnectedError, recordPreviousWeek } from "./engine/evaluate";
import { dueSlot, slotKey } from "./engine/slots";
import { HackatimeAuthError } from "./hackatime/client";
import { type RenderKind, renderMessage } from "./messages/render";
import { localDate } from "./time/week";
import type { Reminder, User } from "./types";

export const RECENT_QUOTES = 10;
/** After a failure (Hackatime down with no cache, Slack error), wait this long before retrying the same slot. */
export const RETRY_AFTER_MS = 5 * 60_000;
export const TZ_SYNC_EVERY_MS = 6 * 3600_000;

export class Scheduler {
  private running = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private readonly retryAfter = new Map<number, number>();

  constructor(private readonly deps: Deps) {}

  start() {
    const kick = () => void this.tick().catch((err) => this.deps.log.error("tick failed", err));
    // Align to just after each minute boundary so hh:00 slots go out at hh:00:0x.
    const delay = 60_000 - (Date.now() % 60_000) + 2_000;
    setTimeout(() => {
      kick();
      this.timers.push(setInterval(kick, 60_000));
    }, delay);
    setTimeout(kick, 3_000);
    const maintenance = () => void this.maintenance().catch((err) => this.deps.log.error("maintenance failed", err));
    setTimeout(maintenance, 10_000);
    this.timers.push(setInterval(maintenance, 30 * 60_000));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** One pass over every enabled reminder. Safe to call concurrently (overlapping calls are skipped). */
  async tick(now = this.deps.clock()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const items = this.deps.repo.activeReminders();
      await Promise.all(items.map(({ reminder, user }) => this.processReminder(reminder, user, now)));
    } finally {
      this.running = false;
    }
  }

  private async processReminder(reminder: Reminder, user: User, now: number): Promise<void> {
    const { repo, log } = this.deps;
    if (!user.tz) return;
    if (user.pausedUntil && user.pausedUntil > now) return;
    if (user.tokenStatus === "none") return; // disconnected on purpose: stay quiet
    if ((this.retryAfter.get(reminder.id) ?? 0) > now) return;

    const slot = dueSlot(now, user.tz, reminder);
    if (!slot) return;
    const key = slotKey(slot);
    if (repo.hasSlot(reminder.id, key)) return;
    if (!repo.claimSlot(reminder.id, key)) return;

    try {
      if (reminder.snoozedUntil && reminder.snoozedUntil > slot.at) {
        repo.finishSlot(reminder.id, key, "snoozed", null, null);
        return;
      }

      if (user.tokenStatus === "invalid") {
        const today = localDate(now, user.tz);
        if (user.lastReconnectNag === today) {
          repo.finishSlot(reminder.id, key, "noauth", null, null);
          return;
        }
        const msg = this.render("reconnect", user, null, null, false);
        await this.deps.slack.sendDm(user.slackId, msg);
        repo.setLastReconnectNag(user.slackId, today);
        repo.finishSlot(reminder.id, key, "sent", "reconnect", msg.quoteId);
        return;
      }

      const { status, staleSince } = await evaluate(this.deps, reminder, user, now);
      const weekKey = status.week.key;
      const state: DecideState = {
        kickoffSent: repo.hasSlot(reminder.id, kickoffMarker(weekKey)),
        weekDoneAnnounced: repo.hasSlot(reminder.id, weekDoneMarker(weekKey)),
        dayDoneAnnounced: repo.hasSlot(reminder.id, dayDoneMarker(status.today)),
        shipped: repo.shippedAt(reminder.id, weekKey) !== null,
        shipNag: reminder.shipNag,
      };
      const decision = decide(status, slot, state);
      if (!decision.kind) {
        repo.finishSlot(reminder.id, key, "silent", null, null);
        return;
      }

      let recap = null;
      if (decision.kind === "kickoff") {
        recap = await recordPreviousWeek(this.deps, reminder, user, status.week.start).catch((err) => {
          log.warn(`couldn't build last week's recap for reminder ${reminder.id}`, err);
          return null;
        });
      }

      const showName = repo.listReminders(user.slackId).length > 1;
      const msg = this.render(decision.kind, user, reminder, status, showName, recap, staleSince);
      await this.deps.slack.sendDm(user.slackId, msg);
      repo.finishSlot(reminder.id, key, "sent", decision.kind, msg.quoteId);
      for (const marker of decision.markers) repo.mark(reminder.id, marker, decision.kind);
      log.info(`sent ${decision.kind} to ${user.slackId} (reminder ${reminder.id}, ${key})`);
    } catch (err) {
      if (err instanceof HackatimeAuthError || err instanceof NotConnectedError) {
        // Let the next tick take the reconnect path for this same slot.
        repo.releaseSlot(reminder.id, key);
        return;
      }
      repo.releaseSlot(reminder.id, key);
      this.retryAfter.set(reminder.id, now + RETRY_AFTER_MS);
      log.error(`reminder ${reminder.id} slot ${key} failed, retrying in 5m`, err);
    }
  }

  private render(
    kind: RenderKind,
    user: User,
    reminder: Reminder | null,
    status: Parameters<typeof renderMessage>[1]["status"],
    showName: boolean,
    recap: Parameters<typeof renderMessage>[1]["recap"] = null,
    staleSince: number | null = null,
  ) {
    return renderMessage(kind, {
      slackId: user.slackId,
      status,
      reminder,
      showName,
      recent: this.deps.repo.recentQuoteIds(user.slackId, RECENT_QUOTES),
      recap,
      staleSince,
    });
  }

  /** Keep Slack timezones fresh and prune old rows. */
  async maintenance(now = this.deps.clock()): Promise<void> {
    const { repo, slack, log } = this.deps;
    for (const user of repo.usersNeedingTzSync(now - TZ_SYNC_EVERY_MS)) {
      try {
        const tz = await slack.userTimezone(user.slackId);
        if (tz && tz !== user.tz) {
          repo.setTimezone(user.slackId, tz, "slack");
          log.info(`timezone for ${user.slackId} is now ${tz} (from slack)`);
        } else repo.touchTzSync(user.slackId);
      } catch (err) {
        log.warn(`timezone sync failed for ${user.slackId}`, err);
      }
    }
    repo.pruneSlotLog(now - 45 * 24 * 3600_000);
    repo.pruneOAuthStates();
  }
}
