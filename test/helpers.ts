import type { KnownBlock } from "@slack/types";
import { DateTime } from "luxon";
import { encrypt } from "../src/crypto";
import { openDatabase } from "../src/db/db";
import { Repo } from "../src/db/repo";
import type { Deps, SlackGateway } from "../src/deps";
import { HackatimeClient } from "../src/hackatime/client";
import { DEFAULT_SETTINGS, type ReminderSettings } from "../src/types";

export const KEY = Buffer.alloc(32, 7);
export const SLACK_ID = "U0TEST";

export class Clock {
  constructor(public now: number) {}
  get = () => this.now;
}

export interface Sent {
  at: number;
  slackId: string;
  text: string;
  blocks?: KnownBlock[];
}

export class FakeSlack implements SlackGateway {
  sent: Sent[] = [];
  tz: string | null = "Europe/Stockholm";
  failNext = 0;
  constructor(private readonly clock: Clock) {}
  async sendDm(slackId: string, message: { text: string; blocks?: KnownBlock[] }) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("slack is down");
    }
    this.sent.push({ at: this.clock.now, slackId, ...message });
    return String(this.sent.length);
  }
  async userTimezone() {
    return this.tz;
  }
}

/** Fake Hackatime server: coding happens in [start, end) intervals, totals are the overlap with the query window. */
export class FakeHackatime {
  intervals: [number, number][] = [];
  mode: "ok" | "auth" | "down" = "ok";
  calls = 0;
  /** Extra routes checked before the defaults (return null to fall through). */
  extra: ((url: URL) => Response | null) | null = null;

  code(startIso: string, minutes: number, zone = "Europe/Stockholm") {
    const start = DateTime.fromISO(startIso, { zone }).toMillis();
    this.intervals.push([start, start + minutes * 60_000]);
  }

  seconds(start: number, end: number): number {
    let total = 0;
    for (const [a, b] of this.intervals) total += Math.max(0, Math.min(b, end) - Math.max(a, start));
    return Math.floor(total / 1000);
  }

  fetch = (async (input: string | URL | Request) => {
    this.calls++;
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const custom = this.extra?.(url);
    if (custom) return custom;
    if (this.mode === "down") return new Response("oops", { status: 500 });
    if (this.mode === "auth") return new Response(JSON.stringify({ error: "User not found" }), { status: 404 });
    if (url.pathname === "/api/v1/users/my/stats") {
      const start = Date.parse(url.searchParams.get("start_date")!);
      const end = Date.parse(url.searchParams.get("end_date")!);
      return Response.json({ total_seconds: this.seconds(start, end) });
    }
    if (url.pathname === "/api/v1/authenticated/me") return Response.json({ id: 1, slack_id: SLACK_ID });
    if (url.pathname === "/api/v1/authenticated/projects") return Response.json({ projects: [{ name: "goblin", total_seconds: 0, most_recent_heartbeat: null, archived: false }] });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

export function makeDeps(startIso: string) {
  const clock = new Clock(Date.parse(startIso));
  const repo = new Repo(openDatabase(":memory:"), clock.get);
  const fake = new FakeHackatime();
  const hackatime = new HackatimeClient({
    baseUrl: "https://hackatime.test",
    clientId: "cid",
    clientSecret: "secret",
    redirectUri: "https://goblin.test/oauth/callback",
    fetch: fake.fetch,
    sleep: async () => {},
    clock: clock.get,
  });
  const slack = new FakeSlack(clock);
  const logs: string[] = [];
  const log = {
    debug: () => {},
    info: (...a: unknown[]) => logs.push(a.map(String).join(" ")),
    warn: (...a: unknown[]) => logs.push(a.map(String).join(" ")),
    error: (...a: unknown[]) => logs.push(a.map(String).join(" ")),
  };
  const deps: Deps = {
    config: { encryptionKey: KEY, dryRun: false, allowedSlackIds: null, publicUrl: "https://goblin.test" },
    repo,
    hackatime,
    slack,
    clock: clock.get,
    log,
  };
  return { deps, clock, repo, fake, slack, logs };
}

export function connectUser(repo: Repo, tz = "Europe/Stockholm", slackId = SLACK_ID) {
  repo.ensureUser(slackId);
  repo.setToken(slackId, encrypt("tok", KEY), 1, slackId);
  repo.setTimezone(slackId, tz, "slack");
}

export function addReminder(repo: Repo, settings: Partial<ReminderSettings> = {}, slackId = SLACK_ID) {
  return repo.createReminder(slackId, { ...DEFAULT_SETTINGS, name: "third space", projects: ["goblin"], ...settings });
}

/** Kind of each sent message, from the scheduler's slot log (in send order). */
export function sentKinds(repo: Repo, reminderId: number): { kind: string; at: string }[] {
  return repo.db
    .query<{ kind: string; slot_key: string }, [number]>(
      "SELECT kind, slot_key FROM slot_log WHERE reminder_id = ? AND outcome = 'sent' ORDER BY created_at, rowid",
    )
    .all(reminderId)
    .map((r) => ({ kind: r.kind, at: r.slot_key.replace("slot|", "") }));
}

export function local(ms: number | string, zone = "Europe/Stockholm"): string {
  const t = typeof ms === "string" ? Date.parse(ms) : ms;
  return DateTime.fromMillis(t, { zone }).toFormat("ccc HH:mm");
}
