import { describe, expect, test } from "bun:test";
import { DateTime } from "luxon";
import { dueSlot, nextSlot, slotKey, slotsForDate } from "../src/engine/slots";

const t = (iso: string) => Date.parse(iso);
const STHLM = "Europe/Stockholm";
const settings = { hours: [17, 18, 19, 20, 21], wrapDay: 7, wrapMinutes: 22 * 60 };
const local = (ms: number, zone: string) => DateTime.fromMillis(ms, { zone }).toFormat("HH:mm");

describe("slotsForDate", () => {
  test("a normal day is just the configured hours", () => {
    const slots = slotsForDate("2026-09-23", STHLM, settings);
    expect(slots.map((s) => local(s.at, STHLM))).toEqual(["17:00", "18:00", "19:00", "20:00", "21:00"]);
    expect(slots.every((s) => s.hour && !s.final && !s.headsUp)).toBe(true);
  });

  test("day before the final day adds a 19:00 heads-up (merged with the 19:00 hour)", () => {
    const slots = slotsForDate("2026-09-26", STHLM, settings);
    expect(slots.map((s) => local(s.at, STHLM))).toEqual(["17:00", "18:00", "19:00", "20:00", "21:00"]);
    const s19 = slots.find((s) => local(s.at, STHLM) === "19:00")!;
    expect(s19.hour && s19.headsUp).toBe(true);
    const onlyMorning = slotsForDate("2026-09-26", STHLM, { ...settings, hours: [9] });
    expect(onlyMorning.map((s) => [local(s.at, STHLM), s.hour, s.headsUp])).toEqual([
      ["09:00", true, false],
      ["19:00", false, true],
    ]);
  });

  test("final day: hourly from 12:00, every 30 min in the last 3h before 22:00", () => {
    const slots = slotsForDate("2026-09-27", STHLM, settings);
    expect(slots.map((s) => local(s.at, STHLM))).toEqual([
      "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00",
      "19:00", "19:30", "20:00", "20:30", "21:00", "21:30",
    ]);
    const s17 = slots.find((s) => local(s.at, STHLM) === "17:00")!;
    expect(s17.hour && s17.final).toBe(true);
  });

  test("Los Angeles final day sprints toward the real reset (21:00)", () => {
    const LA = "America/Los_Angeles";
    const slots = slotsForDate("2026-09-27", LA, settings);
    expect(slots.map((s) => local(s.at, LA))).toEqual([
      "12:00", "13:00", "14:00", "15:00", "16:00", "17:00",
      "18:00", "18:30", "19:00", "19:30", "20:00", "20:30", "21:00",
    ]);
    // 21:00 is only a configured hour (it's already next week there)
    const s21 = slots.at(-1)!;
    expect(s21.hour && !s21.final).toBe(true);
  });

  test("DST gap: a configured hour that doesn't exist collapses instead of duplicating", () => {
    // Stockholm springs forward 02:00 -> 03:00 on 2026-03-29
    const slots = slotsForDate("2026-03-29", STHLM, { hours: [2, 3], wrapDay: 7, wrapMinutes: 22 * 60 });
    const hourSlots = slots.filter((s) => s.hour);
    expect(hourSlots.length).toBe(1);
    expect(local(hourSlots[0]!.at, STHLM)).toBe("03:00");
  });

  test("slot keys are stable UTC instants", () => {
    const [first] = slotsForDate("2026-09-23", STHLM, settings);
    expect(slotKey(first!)).toBe("slot|2026-09-23T15:00:00.000Z");
  });
});

describe("dueSlot", () => {
  test("picks the slot that just started", () => {
    expect(local(dueSlot(t("2026-09-23T15:00:00Z"), STHLM, settings)!.at, STHLM)).toBe("17:00");
    expect(local(dueSlot(t("2026-09-23T15:44:00Z"), STHLM, settings)!.at, STHLM)).toBe("17:00");
  });

  test("gives up after the 45 min grace", () => {
    expect(dueSlot(t("2026-09-23T15:45:00Z"), STHLM, settings)).toBeNull();
  });

  test("nothing due before the first slot of the day", () => {
    expect(dueSlot(t("2026-09-23T10:00:00Z"), STHLM, settings)).toBeNull();
  });

  test("30-min sprint slots hand over to each other", () => {
    expect(local(dueSlot(t("2026-09-27T17:29:00Z"), STHLM, settings)!.at, STHLM)).toBe("19:00");
    expect(local(dueSlot(t("2026-09-27T17:31:00Z"), STHLM, settings)!.at, STHLM)).toBe("19:30");
  });

  test("late-night slot: due at 23:30, expired by 00:10 the next day", () => {
    const late = { ...settings, hours: [23] };
    expect(local(dueSlot(t("2026-09-23T21:30:00Z"), STHLM, late)!.at, STHLM)).toBe("23:00");
    expect(dueSlot(t("2026-09-23T22:10:00Z"), STHLM, late)).toBeNull();
  });

  test("nextSlot finds the upcoming one", () => {
    expect(local(nextSlot(t("2026-09-23T15:00:00Z"), STHLM, settings)!.at, STHLM)).toBe("18:00");
    expect(local(nextSlot(t("2026-09-23T20:00:00Z"), STHLM, settings)!.at, STHLM)).toBe("17:00");
  });
});
