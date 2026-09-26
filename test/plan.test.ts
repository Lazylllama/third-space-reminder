import { describe, expect, test } from "bun:test";
import { breakdownWindows, computeStatus, dayBreakdown, type PlanSettings } from "../src/engine/plan";

const t = (iso: string) => Date.parse(iso);
const H = 3600;
const STHLM = "Europe/Stockholm";
const base: PlanSettings = { goalSeconds: 10 * H, slackDays: [], wrapDay: 7, wrapMinutes: 22 * 60 };

function status(now: string, weekSeconds: number, todaySeconds: number, settings: Partial<PlanSettings> = {}, zone = STHLM) {
  return computeStatus({ now: t(now), zone, settings: { ...base, ...settings }, weekSeconds, todaySeconds });
}

describe("computeStatus, no slack days (Stockholm)", () => {
  test("Monday morning, fresh week", () => {
    const s = status("2026-09-21T08:00:00Z", 0, 0);
    expect(s.phase).toBe("normal");
    expect(s.today).toBe("2026-09-21");
    expect(s.todayStart).toBe(t("2026-09-21T04:00:00Z")); // clipped to the reset (06:00 local)
    expect(s.base).toBeCloseTo(36000 / 7, 6);
    expect(s.todayTarget).toBe(5143);
    expect(s.debt).toBe(0);
    expect(s.dayLeft).toBe(5143);
    expect(s.weekLeft).toBe(36000);
    expect(s.activeDaysLeft).toBe(7);
  });

  test("debt after a bad start is spread over the remaining days", () => {
    // Wed 19:00 CEST, 1h done Monday, nothing Tuesday, nothing yet today
    const s = status("2026-09-23T17:00:00Z", 3600, 0);
    expect(s.expectedBefore).toBeCloseTo((36000 * 2) / 7, 6);
    expect(s.debt).toBe(6686);
    expect(s.todayTarget).toBe(6480); // (36000 - 3600) / 5
    expect(s.dayLeft).toBe(6480);
    expect(s.activeDaysLeft).toBe(5);
    expect(s.phase).toBe("normal");
  });

  test("being ahead lowers today's target", () => {
    const s = status("2026-09-23T17:00:00Z", 20000, 0);
    expect(s.debt).toBe(0);
    expect(s.ahead).toBe(9714);
    expect(s.todayTarget).toBe(3200);
  });

  test("progress today counts against today's target", () => {
    const s = status("2026-09-23T17:00:00Z", 3600 + 2000, 2000);
    expect(s.beforeSeconds).toBe(3600);
    expect(s.todayTarget).toBe(6480);
    expect(s.dayLeft).toBe(4480);
  });

  test("final day asks for everything left", () => {
    const s = status("2026-09-27T11:00:00Z", 30000, 1000);
    expect(s.phase).toBe("finalDay");
    expect(s.todayTarget).toBe(7000);
    expect(s.dayLeft).toBe(6000);
    expect(s.weekLeft).toBe(6000);
    expect(s.timeToSoft).toBe(t("2026-09-27T20:00:00Z") - t("2026-09-27T11:00:00Z"));
  });

  test("after the wrap-up it's overtime until the real reset", () => {
    expect(status("2026-09-27T21:00:00Z", 30000, 5000).phase).toBe("overtime");
    const mon = status("2026-09-28T01:00:00Z", 30000, 0); // Mon 03:00 CEST, still last week
    expect(mon.week.key).toBe("2026-09-21");
    expect(mon.phase).toBe("overtime");
    expect(mon.dayLeft).toBe(6000);
  });

  test("goal reached is weekDone no matter when", () => {
    const s = status("2026-09-24T10:00:00Z", 36000, 100);
    expect(s.phase).toBe("weekDone");
    expect(s.weekLeft).toBe(0);
    expect(s.dayLeft).toBe(0);
  });

  test("the new week starts clean (debt never carries over)", () => {
    const s = status("2026-09-28T08:00:00Z", 0, 0);
    expect(s.week.key).toBe("2026-09-28");
    expect(s.debt).toBe(0);
    expect(s.todayTarget).toBe(5143);
  });
});

describe("slack days", () => {
  const weekend = { slackDays: [6, 7] };

  test("goal is split over work days only", () => {
    const s = status("2026-09-21T08:00:00Z", 0, 0, weekend);
    expect(s.activeDates).toEqual(["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"]);
    expect(s.todayTarget).toBe(7200);
  });

  test("slack day while on track: nothing to do", () => {
    const s = status("2026-09-26T10:00:00Z", 36000 - 1, 0, { slackDays: [3] });
    // not a slack day here (Saturday), sanity check on the other branch below
    expect(s.isSlackDay).toBe(false);
    const wed = status("2026-09-23T10:00:00Z", 12000, 0, { slackDays: [3] }); // Mon+Tue at 6000/day pace
    expect(wed.isSlackDay).toBe(true);
    expect(wed.debt).toBe(0);
    expect(wed.todayTarget).toBe(0);
    expect(wed.dayLeft).toBe(0);
  });

  test("slack day while behind: target is exactly the debt", () => {
    const wed = status("2026-09-23T10:00:00Z", 6000, 0, { slackDays: [3] });
    expect(wed.debt).toBe(6000);
    expect(wed.todayTarget).toBe(6000);
    expect(wed.dayLeft).toBe(6000);
  });

  test("slack weekend after missing Friday's goal: Saturday asks for the rest", () => {
    const sat = status("2026-09-26T10:00:00Z", 30000, 0, weekend);
    expect(sat.isSlackDay).toBe(true);
    expect(sat.debt).toBe(6000);
    expect(sat.todayTarget).toBe(6000);
  });

  test("last active day (Friday) takes everything left", () => {
    const fri = status("2026-09-25T10:00:00Z", 20000, 0, weekend);
    expect(fri.todayTarget).toBe(16000);
  });

  test("all days marked slack falls back to all days", () => {
    const s = status("2026-09-21T08:00:00Z", 0, 0, { slackDays: [1, 2, 3, 4, 5, 6, 7] });
    expect(s.activeDates.length).toBe(7);
    expect(s.todayTarget).toBe(5143);
  });
});

describe("other zones", () => {
  test("Los Angeles: Sunday evening after the reset is prestart and counts as a head start", () => {
    const pre = status("2026-09-21T05:00:00Z", 1800, 1800, {}, "America/Los_Angeles"); // Sun 22:00 PDT
    expect(pre.phase).toBe("prestart");
    expect(pre.dayLeft).toBe(0);
    const mon = status("2026-09-21T17:00:00Z", 1800, 0, {}, "America/Los_Angeles"); // Mon 10:00 PDT
    expect(mon.phase).toBe("normal");
    expect(mon.ahead).toBe(1800);
    expect(mon.todayTarget).toBe(4886); // (36000 - 1800) / 7
  });

  test("Los Angeles: final day wrap-up is the real reset (Sun 21:00)", () => {
    const s = status("2026-09-27T19:00:00Z", 20000, 0, {}, "America/Los_Angeles"); // Sun 12:00 PDT
    expect(s.phase).toBe("finalDay");
    expect(s.soft).toBe(t("2026-09-28T04:00:00Z"));
  });

  test("Sydney: Monday morning before the Mon 14:00 reset is overtime of last week", () => {
    const s = status("2026-09-27T22:00:00Z", 20000, 0, {}, "Australia/Sydney"); // Mon 08:00 AEST
    expect(s.week.key).toBe("2026-09-21");
    expect(s.phase).toBe("overtime");
  });
});

describe("dayBreakdown", () => {
  test("rebuilds each day's target from what was done before it", () => {
    const now = t("2026-09-23T17:00:00Z");
    const done = new Map([
      ["2026-09-21", 3600],
      ["2026-09-22", 0],
      ["2026-09-23", 1000],
    ]);
    const rows = dayBreakdown(now, STHLM, base, 0, done);
    expect(rows.map((r) => r.date)).toEqual(["2026-09-21", "2026-09-22", "2026-09-23"]);
    expect(rows[0]!.target).toBe(5143);
    expect(rows[0]!.met).toBe(false);
    expect(rows[1]!.target).toBe(5400); // (36000 - 3600) / 6
    expect(rows[2]!.target).toBe(6480);
    expect(rows[2]!.isToday).toBe(true);
    expect(rows[2]!.debtAtStart).toBe(6686);
  });

  test("windows: LA has a pre-window (Sun 21:00-24:00) and days clipped to now", () => {
    const now = t("2026-09-22T19:00:00Z"); // Tue 12:00 PDT
    const w = breakdownWindows(now, "America/Los_Angeles", base);
    expect(w.pre).toEqual({ start: t("2026-09-21T04:00:00Z"), end: t("2026-09-21T07:00:00Z") });
    expect(w.days.map((d) => d.date)).toEqual(["2026-09-21", "2026-09-22"]);
    expect(w.days[1]!.end).toBe(now);
    expect(w.post).toBeNull();
  });

  test("windows: Stockholm Monday night after the wrap-up has a post-window", () => {
    const now = t("2026-09-28T01:00:00Z");
    const w = breakdownWindows(now, STHLM, base);
    expect(w.pre).toBeNull();
    expect(w.days.length).toBe(7);
    expect(w.days[0]!.start).toBe(t("2026-09-21T04:00:00Z"));
    expect(w.post).toEqual({ start: t("2026-09-27T22:00:00Z"), end: now });
  });
});
