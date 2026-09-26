import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { Scheduler } from "../src/scheduler";
import { addReminder, connectUser, local, makeDeps, sentKinds } from "./helpers";

// Week of Mon 21 Sep 2026. Reset = Mon 06:00 Stockholm (04:00Z). Wrap-up = Sun 22:00 Stockholm.
const WEEK_START = Date.parse("2026-09-21T04:00:00Z");
const WEEK_END = Date.parse("2026-09-28T04:00:00Z");
const MIN = 60_000;
setDefaultTimeout(120_000);

async function runWeek(
  schedulers: Scheduler[],
  clock: { now: number },
  hooks: Record<string, () => void> = {},
  from = WEEK_START,
  to = WEEK_END,
) {
  for (let t = from; t < to; t += MIN) {
    clock.now = t;
    const hook = hooks[local(t)];
    if (hook) hook();
    for (const s of schedulers) await s.tick(t);
  }
}

function setup(settings = {}) {
  const env = makeDeps("2026-09-20T10:00:00Z"); // reminder created the Sunday before
  connectUser(env.repo);
  const reminder = addReminder(env.repo, settings);
  return { ...env, reminder, scheduler: new Scheduler(env.deps) };
}

const summary = (list: { kind: string; at: string }[]) => list.map((s) => `${local(s.at)} ${s.kind}`);

describe("a full week, minute by minute (Stockholm, nags at 17-21, 10h goal)", () => {
  test("ghost: never codes. nagged every slot, debt all week, heads-up saturday, cursed sunday", async () => {
    const { repo, reminder, scheduler, clock, slack } = setup();
    await runWeek([scheduler], clock);
    const s = summary(sentKinds(repo, reminder.id));

    expect(s.slice(0, 5)).toEqual(["Mon 17:00 kickoff", "Mon 18:00 nag", "Mon 19:00 nag", "Mon 20:00 nag", "Mon 21:00 nag"]);
    for (const day of ["Tue", "Wed", "Thu", "Fri"]) {
      expect(s.filter((x) => x.startsWith(day))).toEqual(["17:00", "18:00", "19:00", "20:00", "21:00"].map((h) => `${day} ${h} nagDebt`));
    }
    expect(s.filter((x) => x.startsWith("Sat"))).toEqual([
      "Sat 17:00 nagDebt",
      "Sat 18:00 nagDebt",
      "Sat 19:00 weekendWarning",
      "Sat 20:00 nagDebt",
      "Sat 21:00 nagDebt",
    ]);
    expect(s.filter((x) => x.startsWith("Sun"))).toEqual([
      "Sun 12:00 finalDay",
      ...["13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00", "19:30", "20:00", "20:30", "21:00", "21:30"].map((h) => `Sun ${h} impossible`),
    ]);
    expect(s.length).toBe(43);
    expect(slack.sent.length).toBe(43);
    // nothing in the 4am zone, nothing after the wrap-up (no configured hours after 22:00)
    expect(s.some((x) => x.startsWith("Mon") && !x.startsWith("Mon 1") && !x.startsWith("Mon 2"))).toBe(false);
    // every DM is exactly on its slot minute
    for (const m of slack.sent) expect(m.at % MIN).toBe(0);
  });

  test("diligent: 1h30 every morning. one 'done' per day, week done sunday, ship nag until shipped", async () => {
    const { repo, reminder, scheduler, clock, fake } = setup();
    for (let d = 21; d <= 27; d++) fake.code(`2026-09-${d}T09:00`, 90);
    await runWeek([scheduler], clock, {
      "Sun 13:05": () => repo.setShipped(reminder.id, "2026-09-21", clock.now),
    });
    expect(summary(sentKinds(repo, reminder.id))).toEqual([
      "Mon 17:00 kickoff",
      "Mon 18:00 dayDone",
      "Tue 17:00 dayDone",
      "Wed 17:00 dayDone",
      "Thu 17:00 dayDone",
      "Fri 17:00 dayDone",
      "Sat 17:00 dayDone",
      "Sun 12:00 weekDone",
      "Sun 13:00 ship",
    ]);
  });

  test("slack weekend: 2h mon-fri, done friday, then only ship nags (escalating sunday)", async () => {
    const { repo, reminder, scheduler, clock, fake } = setup({ slackDays: [6, 7] });
    for (let d = 21; d <= 25; d++) fake.code(`2026-09-${d}T09:00`, 120);
    await runWeek([scheduler], clock);
    const s = summary(sentKinds(repo, reminder.id));
    expect(s.slice(0, 6)).toEqual(["Mon 17:00 kickoff", "Mon 18:00 dayDone", "Tue 17:00 dayDone", "Wed 17:00 dayDone", "Thu 17:00 dayDone", "Fri 17:00 weekDone"]);
    const rest = s.slice(6);
    expect(rest.every((x) => x.endsWith(" ship"))).toBe(true);
    expect(rest.filter((x) => x.startsWith("Fri")).length).toBe(4);
    expect(rest.filter((x) => x.startsWith("Sat")).length).toBe(5);
    expect(rest.filter((x) => x.startsWith("Sun")).length).toBe(13);
  });

  test("slack weekend, on track, ship nags off: saturday and sunday are silent", async () => {
    const { repo, reminder, scheduler, clock, fake } = setup({ slackDays: [6, 7], shipNag: false });
    for (let d = 21; d <= 25; d++) fake.code(`2026-09-${d}T09:00`, 120);
    await runWeek([scheduler], clock);
    const s = summary(sentKinds(repo, reminder.id));
    expect(s.filter((x) => x.startsWith("Sat") || x.startsWith("Sun"))).toEqual([]);
    expect(s.at(-1)).toBe("Fri 17:00 weekDone");
  });

  test("slack weekend, behind: saturday asks for exactly the debt", async () => {
    const { repo, reminder, scheduler, clock, fake, slack } = setup({ slackDays: [6, 7] });
    for (let d = 21; d <= 24; d++) fake.code(`2026-09-${d}T09:00`, 120); // skips friday
    await runWeek([scheduler], clock);
    const s = summary(sentKinds(repo, reminder.id));
    expect(s.filter((x) => x.startsWith("Sat 17"))).toEqual(["Sat 17:00 slackDayDebt"]);
    const sat = slack.sent.find((m) => local(m.at) === "Sat 17:00")!;
    expect(JSON.stringify(sat.blocks)).toContain("debt 2h");
  });

  test("two containers ticking at once never double-send", async () => {
    const { repo, reminder, scheduler, clock, deps, slack } = setup();
    const second = new Scheduler(deps);
    await runWeek([scheduler, second, scheduler], clock);
    expect(sentKinds(repo, reminder.id).length).toBe(43);
    expect(slack.sent.length).toBe(43);
  });

  test("snooze skips the next slot only", async () => {
    const { repo, reminder, scheduler, clock } = setup();
    await runWeek([scheduler], clock, { "Tue 17:05": () => repo.setSnooze(reminder.id, clock.now + 3600_000) });
    const tue = summary(sentKinds(repo, reminder.id)).filter((x) => x.startsWith("Tue"));
    expect(tue).toEqual(["Tue 17:00 nagDebt", "Tue 19:00 nagDebt", "Tue 20:00 nagDebt", "Tue 21:00 nagDebt"]);
  });

  test("revoked token: one reconnect nag per day, nothing else", async () => {
    const { repo, reminder, scheduler, clock, fake } = setup();
    await runWeek([scheduler], clock, { "Wed 12:00": () => (fake.mode = "auth") });
    const s = summary(sentKinds(repo, reminder.id));
    expect(s.filter((x) => x.endsWith("reconnect"))).toEqual(["Wed 17:00 reconnect", "Thu 17:00 reconnect", "Fri 17:00 reconnect", "Sat 17:00 reconnect", "Sun 12:00 reconnect"]);
    expect(s.filter((x) => !x.endsWith("reconnect")).every((x) => x.startsWith("Mon") || x.startsWith("Tue"))).toBe(true);
    expect(repo.getUser(reminder.slackId)!.tokenStatus).toBe("invalid");
  });

  test("hackatime outage: recent numbers are reused (labelled), too-old ones aren't", async () => {
    const { repo, reminder, scheduler, clock, fake, slack } = setup();
    await runWeek([scheduler], clock, {
      "Tue 17:30": () => (fake.mode = "down"),
      "Wed 00:00": () => (fake.mode = "ok"),
    });
    const tue = summary(sentKinds(repo, reminder.id)).filter((x) => x.startsWith("Tue"));
    expect(tue).toEqual(["Tue 17:00 nagDebt", "Tue 18:00 nagDebt", "Tue 19:00 nagDebt", "Tue 20:00 nagDebt"]);
    const stale = slack.sent.filter((m) => ["Tue 18:00", "Tue 19:00", "Tue 20:00"].includes(local(m.at)));
    expect(stale.length).toBe(3);
    for (const m of stale) expect(JSON.stringify(m.blocks)).toContain("hackatime isn't answering");
    expect(summary(sentKinds(repo, reminder.id)).filter((x) => x.startsWith("Wed")).length).toBe(5);
  });

  test("slack being down: the slot is retried and delivered late, once", async () => {
    const { repo, reminder, scheduler, clock, slack } = setup();
    await runWeek([scheduler], clock, { "Tue 17:00": () => (slack.failNext = 1) });
    const tue = slack.sent.filter((m) => local(m.at).startsWith("Tue"));
    expect(tue.map((m) => local(m.at))).toEqual(["Tue 17:05", "Tue 18:00", "Tue 19:00", "Tue 20:00", "Tue 21:00"]);
    expect(sentKinds(repo, reminder.id).length).toBe(43);
  });

  test("paused user gets nothing, resumes cleanly", async () => {
    const { repo, reminder, scheduler, clock } = setup();
    repo.setPausedUntil(reminder.slackId, Date.parse("2026-09-24T04:00:00Z")); // until Thu 06:00
    await runWeek([scheduler], clock);
    const s = summary(sentKinds(repo, reminder.id));
    expect(s.some((x) => /^(Mon|Tue|Wed)/.test(x))).toBe(false);
    expect(s[0]).toBe("Thu 17:00 nagDebt");
  });
});

describe("other timezones", () => {
  test("Los Angeles: nothing sunday night after the reset, sprint ends at the real reset (Sun 21:00)", async () => {
    const env = makeDeps("2026-09-20T10:00:00Z");
    connectUser(env.repo, "America/Los_Angeles");
    const reminder = addReminder(env.repo, { hours: [18, 19, 20, 21, 22] });
    const scheduler = new Scheduler(env.deps);
    await runWeek([scheduler], env.clock);
    const s = sentKinds(env.repo, reminder.id).map((x) => `${local(x.at, "America/Los_Angeles")} ${x.kind}`);
    expect(s[0]).toBe("Mon 18:00 kickoff");
    const sun = s.filter((x) => x.startsWith("Sun"));
    expect(sun.at(-1)).toBe("Sun 20:30 impossible");
    expect(sun.some((x) => x.startsWith("Sun 21") || x.startsWith("Sun 22"))).toBe(false);
  });
});
