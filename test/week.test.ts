import { describe, expect, test } from "bun:test";
import { planDates, softDeadline, weekOf } from "../src/time/week";

const t = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

describe("weekOf", () => {
  test("mid-week instant maps to Monday 00:00 New York (EDT = 04:00Z)", () => {
    const w = weekOf(t("2026-09-26T12:00:00Z"));
    expect(w.key).toBe("2026-09-21");
    expect(iso(w.start)).toBe("2026-09-21T04:00:00.000Z");
    expect(iso(w.end)).toBe("2026-09-28T04:00:00.000Z");
  });

  test("boundaries are [start, end)", () => {
    expect(weekOf(t("2026-09-28T03:59:59.999Z")).key).toBe("2026-09-21");
    expect(weekOf(t("2026-09-28T04:00:00.000Z")).key).toBe("2026-09-28");
    // 06:00 Monday in Stockholm (CEST) is the exact reset
    expect(weekOf(t("2026-09-21T04:00:00Z")).key).toBe("2026-09-21");
  });

  test("week spanning the US fall-back is 169h", () => {
    const w = weekOf(t("2026-10-28T12:00:00Z"));
    expect(w.key).toBe("2026-10-26");
    expect(iso(w.start)).toBe("2026-10-26T04:00:00.000Z");
    expect(iso(w.end)).toBe("2026-11-02T05:00:00.000Z");
    expect((w.end - w.start) / 3600_000).toBe(169);
  });

  test("week spanning the US spring-forward is 167h", () => {
    const w = weekOf(t("2026-03-05T12:00:00Z"));
    expect(w.key).toBe("2026-03-02");
    expect(iso(w.start)).toBe("2026-03-02T05:00:00.000Z");
    expect(iso(w.end)).toBe("2026-03-09T04:00:00.000Z");
    expect((w.end - w.start) / 3600_000).toBe(167);
  });
});

describe("softDeadline (default Sunday 22:00)", () => {
  const w = weekOf(t("2026-09-24T12:00:00Z"));
  const SUN = 7;
  const SAT = 6;
  const cases: [string, string][] = [
    ["Europe/Stockholm", "2026-09-27T20:00:00.000Z"], // Sun 22:00 CEST, reset is Mon 06:00
    ["America/New_York", "2026-09-28T02:00:00.000Z"], // Sun 22:00 EDT
    ["America/Los_Angeles", "2026-09-28T04:00:00.000Z"], // clamped to the reset, Sun 21:00 PDT
    ["Pacific/Honolulu", "2026-09-28T04:00:00.000Z"], // clamped to the reset, Sun 18:00 HST
    ["Asia/Kolkata", "2026-09-27T16:30:00.000Z"], // Sun 22:00 IST
    ["Asia/Singapore", "2026-09-27T14:00:00.000Z"],
    ["Australia/Sydney", "2026-09-27T12:00:00.000Z"], // Sun 22:00 AEST, reset is Mon 14:00
    ["Pacific/Kiritimati", "2026-09-27T08:00:00.000Z"], // Sun 22:00 +14, reset is Mon 18:00
    ["UTC", "2026-09-27T22:00:00.000Z"],
  ];
  for (const [zone, expected] of cases) {
    test(zone, () => expect(iso(softDeadline(w, zone, SUN, 22 * 60))).toBe(expected));
  }

  test("Saturday wrap-up", () => {
    expect(iso(softDeadline(w, "Europe/Stockholm", SAT, 22 * 60))).toBe("2026-09-26T20:00:00.000Z");
    expect(iso(softDeadline(w, "America/Los_Angeles", SAT, 22 * 60))).toBe("2026-09-27T05:00:00.000Z");
  });

  test("EU fall-back week (Sun 25 Oct is 25h long in Stockholm)", () => {
    const w2 = weekOf(t("2026-10-21T12:00:00Z"));
    expect(iso(softDeadline(w2, "Europe/Stockholm", SUN, 22 * 60))).toBe("2026-10-25T21:00:00.000Z"); // 22:00 CET
  });

  test("US fall-back week, Stockholm already on CET", () => {
    const w3 = weekOf(t("2026-10-28T12:00:00Z"));
    expect(iso(softDeadline(w3, "Europe/Stockholm", SUN, 22 * 60))).toBe("2026-11-01T21:00:00.000Z");
    // New York wrap-up on the fall-back day itself (EST after 02:00)
    expect(iso(softDeadline(w3, "America/New_York", SUN, 22 * 60))).toBe("2026-11-02T03:00:00.000Z");
  });
});

describe("planDates", () => {
  const w = weekOf(t("2026-09-24T12:00:00Z"));
  const plan = (zone: string, wrapDay = 7) => planDates(w, zone, softDeadline(w, zone, wrapDay, 22 * 60));
  const monToSun = ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"];

  test("Stockholm: Mon..Sun (the Mon 00:00-06:00 after is bonus time)", () => expect(plan("Europe/Stockholm").dates).toEqual(monToSun));
  test("New York: Mon..Sun", () => expect(plan("America/New_York").dates).toEqual(monToSun));
  test("Los Angeles: week starts Sun 21:00, so Monday is day one", () => expect(plan("America/Los_Angeles").dates).toEqual(monToSun));
  test("Honolulu: week starts Sun 18:00, so Monday is day one", () => expect(plan("Pacific/Honolulu").dates).toEqual(monToSun));
  test("Kolkata: Mon 09:30 start keeps Monday", () => expect(plan("Asia/Kolkata").dates).toEqual(monToSun));
  test("Singapore: Mon 12:00 start keeps Monday", () => expect(plan("Asia/Singapore").dates).toEqual(monToSun));
  test("Sydney: Mon 14:00 start keeps Monday", () => expect(plan("Australia/Sydney").dates).toEqual(monToSun));
  test("Kiritimati: Mon 18:00 start rolls to Tuesday", () => expect(plan("Pacific/Kiritimati").dates).toEqual(monToSun.slice(1)));
  test("Saturday wrap-up ends the plan on Saturday", () => expect(plan("Europe/Stockholm", 6).dates).toEqual(monToSun.slice(0, 6)));
});
