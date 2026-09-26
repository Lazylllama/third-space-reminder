import { describe, expect, test } from "bun:test";
import { summarizeUsage } from "../src/admin/usage";
import { windowsFor } from "../src/engine/plan";
import { adminSection } from "../src/slack/admin";
import { buildHome } from "../src/slack/home";
import { SLACK_ID, addReminder, connectUser, makeDeps } from "./helpers";

// Wed 23 Sep 2026, 19:00 in Stockholm
const NOW = "2026-09-23T17:00:00Z";
const T = Date.parse(NOW);
const ZONE = "Europe/Stockholm";

type Env = ReturnType<typeof makeDeps>;

function cache(env: Env, reminderId: number, weekSeconds: number, todaySeconds = 0, at = T) {
  const { week, todayStart } = windowsFor(at, ZONE);
  env.repo.saveStatusCache(reminderId, { weekKey: week.key, todayStart, weekSeconds, todaySeconds, computedAt: at });
}

function seed() {
  const env = makeDeps(NOW);
  const { repo } = env;
  const id = (n: number) => `U${String(n).padStart(2, "0")}`;

  connectUser(repo, ZONE, id(1));
  const r1 = addReminder(repo, {}, id(1));
  repo.setTokenStatus(id(1), "invalid"); // reconnect

  connectUser(repo, ZONE, id(2));
  addReminder(repo, {}, id(2));
  repo.setPausedUntil(id(2), T + 3600_000); // paused

  connectUser(repo, ZONE, id(3));
  const r3 = addReminder(repo, {}, id(3));
  repo.setReminderEnabled(r3.id, false); // reminder off

  repo.ensureUser(id(4));
  repo.setTimezone(id(4), ZONE, "slack");
  addReminder(repo, {}, id(4)); // never connected / disconnected

  connectUser(repo, ZONE, id(5));
  addReminder(repo, {}, id(5)); // no cache at all

  connectUser(repo, ZONE, id(6));
  const r6 = addReminder(repo, {}, id(6));
  cache(env, r6.id, 20000, 0, Date.parse("2026-09-20T12:00:00Z")); // last week's numbers

  connectUser(repo, ZONE, id(7));
  const r7 = addReminder(repo, {}, id(7));
  cache(env, r7.id, 3600); // behind by 1h 52m (6686s)

  connectUser(repo, ZONE, id(8));
  const r8 = addReminder(repo, {}, id(8));
  cache(env, r8.id, 12000); // ahead of pace

  connectUser(repo, ZONE, id(9));
  const r9 = addReminder(repo, {}, id(9));
  cache(env, r9.id, 36000); // done, not shipped

  connectUser(repo, ZONE, id(10));
  const r10 = addReminder(repo, {}, id(10));
  cache(env, r10.id, 36500);
  repo.setShipped(r10.id, "2026-09-21", T);

  connectUser(repo, ZONE, id(11));
  const r11 = addReminder(repo, { shipNag: false }, id(11));
  cache(env, r11.id, 36000);

  // DMs: one an hour ago, one two days ago, one a month ago
  for (const [ago, key] of [
    [3600_000, "a"],
    [2 * 86400_000, "b"],
    [30 * 86400_000, "c"],
  ] as const) {
    env.clock.now = T - ago;
    repo.claimSlot(r7.id, key);
    repo.finishSlot(r7.id, key, "sent", "nag", null);
  }
  env.clock.now = T;

  // last week's results
  repo.saveWeekResult(r7.id, { weekKey: "2026-09-14", totalSeconds: 36000, goalSeconds: 36000, shippedAt: T - 5 * 86400_000 });
  repo.saveWeekResult(r8.id, { weekKey: "2026-09-14", totalSeconds: 20000, goalSeconds: 36000, shippedAt: null });

  return { ...env, r1 };
}

describe("usage summary", () => {
  test("classifies every state from cached numbers", () => {
    const { repo } = seed();
    const summary = summarizeUsage(repo.adminReminderRows("2026-09-21"), T);
    const byUser = Object.fromEntries(summary.users.map((u) => [u.slackId, u.reminders[0]!]));
    expect(byUser.U01!.state).toBe("reconnect");
    expect([byUser.U02!.state, byUser.U02!.note]).toEqual(["paused", "paused"]);
    expect([byUser.U03!.state, byUser.U03!.note]).toEqual(["paused", "reminder off"]);
    expect([byUser.U04!.state, byUser.U04!.note]).toEqual(["paused", "disconnected"]);
    expect([byUser.U05!.state, byUser.U05!.note]).toEqual(["noData", "no check-in yet this week"]);
    expect(byUser.U06!.state).toBe("noData");
    expect([byUser.U07!.state, byUser.U07!.debt, byUser.U07!.weekSeconds]).toEqual(["behind", 6686, 3600]);
    expect(byUser.U08!.state).toBe("onTrack");
    expect(byUser.U09!.state).toBe("done");
    expect(byUser.U10!.state).toBe("shipped");
    expect([byUser.U11!.state, byUser.U11!.note]).toEqual(["shipped", "done (ship nags off)"]);
    expect(summary.tally).toEqual({ reconnect: 1, behind: 1, done: 1, noData: 2, onTrack: 1, shipped: 2, paused: 3 });
  });

  test("worst first", () => {
    const { repo } = seed();
    const order = summarizeUsage(repo.adminReminderRows("2026-09-21"), T).users.map((u) => u.slackId);
    expect(order).toEqual(["U01", "U07", "U09", "U05", "U06", "U08", "U10", "U11", "U02", "U03", "U04"]);
  });

  test("a user's worst reminder decides their spot, then debt", () => {
    const env = makeDeps(NOW);
    connectUser(env.repo, ZONE, "UA");
    cache(env, addReminder(env.repo, {}, "UA").id, 12000);
    cache(env, addReminder(env.repo, {}, "UA").id, 3600); // behind 6686
    connectUser(env.repo, ZONE, "UB");
    cache(env, addReminder(env.repo, {}, "UB").id, 0); // behind more
    const users = summarizeUsage(env.repo.adminReminderRows("2026-09-21"), T).users;
    expect(users.map((u) => [u.slackId, u.worst])).toEqual([
      ["UB", "behind"],
      ["UA", "behind"],
    ]);
    expect(users[1]!.reminders.length).toBe(2);
  });

  test("counts", () => {
    const { repo } = seed();
    expect(repo.usageCounts(T)).toEqual({
      users: 11,
      connected: 9,
      needsReconnect: 1,
      activelyNagged: 7,
      pausedUsers: 1,
      reminders: 11,
      remindersEnabled: 10,
      dmsLastDay: 1,
      dmsLastWeek: 2,
    });
    expect(repo.weekResultSummary("2026-09-14")).toEqual({ recorded: 2, hit: 1, shipped: 1 });
    expect(repo.weekResultSummary("2026-09-07")).toEqual({ recorded: 0, hit: 0, shipped: 0 });
  });
});

describe("admin section on the home tab", () => {
  test("renders counts, tally, last week and the user list", () => {
    const env = seed();
    const json = JSON.stringify(adminSection(env.deps, T));
    expect(json).toContain("🛠 admin");
    expect(json).toContain("*actively nagged*\\n7");
    expect(json).toContain("*connected*\\n9 (+1 need reconnect)");
    expect(json).toContain("1 last 24h · 2 last 7d");
    expect(json).toContain("⚠️ behind 1");
    expect(json).toContain("*last week:* 1/2 hit the goal, 1 shipped");
    expect(json).toContain("<@U07> · *third space* 1h / 10h ⚠️ 1h 52m behind _(just now)_");
    expect(json).toContain("<@U01> · *third space* 🔌 needs reconnect");
    expect(json).toContain("<@U05> · *third space* ❔ no check-in yet this week");
  });

  test("only admins see it", async () => {
    const env = seed();
    connectUser(env.repo, ZONE, SLACK_ID);
    expect(JSON.stringify(await buildHome(env.deps, SLACK_ID))).not.toContain("🛠 admin");
    env.deps.config = { ...env.deps.config, adminSlackIds: new Set([SLACK_ID]) };
    expect(JSON.stringify(await buildHome(env.deps, SLACK_ID))).toContain("🛠 admin");
  });

  test("admins get in even when an allowlist doesn't include them", async () => {
    const env = seed();
    env.deps.config = { ...env.deps.config, allowedSlackIds: new Set(["U0SOMEONE"]), adminSlackIds: new Set([SLACK_ID]) };
    const json = JSON.stringify(await buildHome(env.deps, SLACK_ID));
    expect(json).not.toContain("isn't taking new victims");
    expect(json).toContain("🛠 admin");
  });

  test("shows up for admins who haven't connected hackatime yet", async () => {
    const env = seed();
    env.deps.config = { ...env.deps.config, adminSlackIds: new Set([SLACK_ID]) };
    const json = JSON.stringify(await buildHome(env.deps, SLACK_ID));
    expect(json).toContain("connect hackatime");
    expect(json).toContain("🛠 admin");
  });

  test("150 users stay inside slack's limits, and hackatime is never called", async () => {
    const env = makeDeps(NOW);
    for (let i = 0; i < 150; i++) {
      const id = `U${String(i).padStart(7, "0")}`;
      connectUser(env.repo, ZONE, id);
      cache(env, addReminder(env.repo, { name: `reminder with a longish name ${i}` }, id).id, 3600 + i);
    }
    connectUser(env.repo, ZONE, SLACK_ID);
    for (let i = 0; i < 5; i++) addReminder(env.repo, {}, SLACK_ID);
    env.deps.config = { ...env.deps.config, adminSlackIds: new Set([SLACK_ID]) };

    const section = adminSection(env.deps, T);
    const before = env.fake.calls;
    const view = await buildHome(env.deps, SLACK_ID);
    const ownReminderCalls = env.fake.calls - before;

    expect(view.blocks.length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(view)).toContain("🛠 admin");
    expect(JSON.stringify(section)).toMatch(/…and \d+ more/);
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      if ((o.type === "mrkdwn" || o.type === "plain_text") && typeof o.text === "string") expect(o.text.length).toBeLessThanOrEqual(3000);
      Object.values(o).forEach(walk);
    };
    walk(view);

    // The admin section itself makes no Hackatime calls: rendering it alone doesn't move the counter.
    const again = env.fake.calls;
    adminSection(env.deps, T);
    expect(env.fake.calls).toBe(again);
    expect(ownReminderCalls).toBeGreaterThan(0); // (only the admin's own 5 reminders hit hackatime)
  });
});
