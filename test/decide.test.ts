import { describe, expect, test } from "bun:test";
import { type DecideState, decide } from "../src/engine/decide";
import { computeStatus, type PlanSettings } from "../src/engine/plan";
import type { Slot } from "../src/engine/slots";

const t = (iso: string) => Date.parse(iso);
const STHLM = "Europe/Stockholm";
const settings: PlanSettings = { goalSeconds: 36000, slackDays: [], wrapDay: 7, wrapMinutes: 22 * 60 };
const fresh: DecideState = { kickoffSent: true, weekDoneAnnounced: false, dayDoneAnnounced: false, shipped: false, shipNag: true };

function run(now: string, week: number, today: number, slot: Partial<Slot> = {}, state: Partial<DecideState> = {}, s: Partial<PlanSettings> = {}) {
  const status = computeStatus({ now: t(now), zone: STHLM, settings: { ...settings, ...s }, weekSeconds: week, todaySeconds: today });
  const fullSlot: Slot = { at: t(now), hour: true, final: false, headsUp: false, ...slot };
  return decide(status, fullSlot, { ...fresh, ...state });
}

describe("decide", () => {
  test("kickoff on the first plan day, once", () => {
    expect(run("2026-09-21T15:00:00Z", 0, 0, {}, { kickoffSent: false })).toEqual({ kind: "kickoff", markers: ["kickoff|2026-09-21"] });
    expect(run("2026-09-21T15:00:00Z", 0, 0).kind).toBe("nag");
  });

  test("plain nag when on pace but today isn't done", () => {
    expect(run("2026-09-22T15:00:00Z", 5143, 0).kind).toBe("nag");
  });

  test("debt nag when behind", () => {
    expect(run("2026-09-23T15:00:00Z", 3600, 0).kind).toBe("nagDebt");
  });

  test("day done: one celebration, then silence", () => {
    expect(run("2026-09-22T15:00:00Z", 12000, 6000)).toEqual({ kind: "dayDone", markers: ["dayDone|2026-09-22"] });
    expect(run("2026-09-22T15:00:00Z", 12000, 6000, {}, { dayDoneAnnounced: true }).kind).toBeNull();
  });

  test("slack day on track is silent, behind gets a slack-day nag", () => {
    expect(run("2026-09-23T15:00:00Z", 12000, 0, {}, {}, { slackDays: [3] }).kind).toBeNull();
    expect(run("2026-09-23T15:00:00Z", 6000, 0, {}, {}, { slackDays: [3] }).kind).toBe("slackDayDebt");
    // cleared the debt on the slack day: one "done" message
    expect(run("2026-09-23T15:00:00Z", 12000, 6000, {}, {}, { slackDays: [3] }).kind).toBe("dayDone");
  });

  test("heads-up the day before the final day only when a lot is left", () => {
    expect(run("2026-09-26T17:00:00Z", 20000, 0, { hour: false, headsUp: true }).kind).toBe("weekendWarning");
    expect(run("2026-09-26T17:00:00Z", 33000, 0, { hour: false, headsUp: true }).kind).toBeNull();
    // merged with an hour slot and not much left (33000s by Saturday is ahead of pace): normal nag
    expect(run("2026-09-26T17:00:00Z", 33000, 0, { hour: true, headsUp: true }).kind).toBe("nag");
    // any debt on the day before the final day means more than 1.5 days' worth is left: the heads-up wins
    expect(run("2026-09-26T17:00:00Z", 25000, 0, { hour: true, headsUp: true }).kind).toBe("weekendWarning");
  });

  test("final day escalation", () => {
    expect(run("2026-09-27T10:00:00Z", 30000, 0, { hour: false, final: true }).kind).toBe("finalDay"); // 12:00
    expect(run("2026-09-27T17:30:00Z", 30000, 0, { hour: false, final: true }).kind).toBe("finalHours"); // 19:30
    // 6h left with 2h to go before 22:00: impossible
    expect(run("2026-09-27T18:00:00Z", 14400, 0, { hour: true, final: true }).kind).toBe("impossible");
  });

  test("overtime only nags on configured hours", () => {
    expect(run("2026-09-27T21:00:00Z", 30000, 0, { hour: true }).kind).toBe("overtime");
    expect(run("2026-09-27T21:00:00Z", 30000, 0, { hour: false, final: true }).kind).toBeNull();
  });

  test("week done: announce once, then ship nags until shipped", () => {
    expect(run("2026-09-25T15:00:00Z", 36000, 0)).toEqual({ kind: "weekDone", markers: ["weekDone|2026-09-21"] });
    expect(run("2026-09-25T15:00:00Z", 36000, 0, {}, { weekDoneAnnounced: true }).kind).toBe("ship");
    expect(run("2026-09-25T15:00:00Z", 36000, 0, {}, { weekDoneAnnounced: true, shipped: true }).kind).toBeNull();
    expect(run("2026-09-25T15:00:00Z", 36000, 0, {}, { weekDoneAnnounced: true, shipNag: false }).kind).toBeNull();
  });

  test("prestart is silent", () => {
    const status = computeStatus({ now: t("2026-09-21T05:00:00Z"), zone: "America/Los_Angeles", settings, weekSeconds: 0, todaySeconds: 0 });
    expect(decide(status, { at: status.now, hour: true, final: false, headsUp: false }, { ...fresh, kickoffSent: false }).kind).toBeNull();
  });
});
