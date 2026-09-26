import { describe, expect, test } from "bun:test";
import { computeStatus } from "../src/engine/plan";
import { QUOTES, pickQuote, type QuotePool } from "../src/messages/quotes";
import { fillTemplate, renderMessage, statusLine, templateVars, type RenderKind } from "../src/messages/render";
import { formatCountdown, formatDuration, progressBar } from "../src/util/format";

const status = computeStatus({
  now: Date.parse("2026-09-23T17:00:00Z"),
  zone: "Europe/Stockholm",
  settings: { goalSeconds: 36000, slackDays: [], wrapDay: 7, wrapMinutes: 22 * 60 },
  weekSeconds: 5600,
  todaySeconds: 2000,
});
const vars = templateVars(status, { totalSeconds: 30000, goalSeconds: 36000 });

describe("quotes", () => {
  const all = Object.entries(QUOTES).flatMap(([pool, lines]) => lines.map((line, i) => ({ pool, i, line })));

  test("there's a lot of them", () => {
    expect(all.length).toBeGreaterThanOrEqual(150);
  });

  test("every placeholder resolves", () => {
    for (const { pool, i, line } of all) {
      const filled = fillTemplate(line, vars);
      if (/\{[a-z_]+\}/.test(filled)) throw new Error(`unresolved placeholder in ${pool}:${i}: ${filled}`);
    }
  });

  test("no em or en dashes, anywhere", () => {
    for (const { pool, i, line } of all) {
      if (/[\u2013\u2014]/.test(line)) throw new Error(`dash in ${pool}:${i}`);
    }
  });

  test("no duplicates within a pool", () => {
    for (const [pool, lines] of Object.entries(QUOTES)) expect(new Set(lines).size, pool).toBe(lines.length);
  });

  test("pickQuote avoids recent quotes, falls back when all are recent", () => {
    const pool: QuotePool = "snoozed";
    const recent = QUOTES.snoozed.slice(1).map((_, i) => `snoozed:${i + 1}`);
    expect(pickQuote(pool, recent).id).toBe("snoozed:0");
    const everything = QUOTES.snoozed.map((_, i) => `snoozed:${i}`);
    expect(pickQuote(pool, everything, () => 0.999).id).toBe(`snoozed:${QUOTES.snoozed.length - 1}`);
  });
});

describe("render", () => {
  const kinds: RenderKind[] = [
    "nag", "nagDebt", "slackDayDebt", "weekendWarning", "finalDay", "finalHours", "impossible", "overtime",
    "dayDone", "weekDone", "ship", "kickoff", "shipped", "snoozed", "reconnect", "chatter",
  ];
  for (const kind of kinds) {
    test(kind, () => {
      const msg = renderMessage(kind, {
        slackId: "U123",
        status,
        reminder: { id: 7, name: "third <space>", projects: ["a", "b"], shipNag: true },
        showName: true,
        recent: [],
        recap: { totalSeconds: 36000, goalSeconds: 36000 },
      });
      expect(msg.text.startsWith("hey <@U123>, ")).toBe(true);
      expect(msg.text).not.toMatch(/\{[a-z_]+\}/);
      expect(msg.text).not.toMatch(/[\u2013\u2014]/);
      expect(JSON.stringify(msg.blocks)).toContain("third &lt;space&gt;");
      expect(msg.quoteId.length).toBeGreaterThan(0);
    });
  }

  test("ship buttons carry reminder id and week", () => {
    const msg = renderMessage("ship", { slackId: "U1", status, reminder: { id: 7, name: "x", projects: ["a"], shipNag: true }, showName: false, recent: [] });
    expect(JSON.stringify(msg.blocks)).toContain('"value":"7|2026-09-21"');
  });

  test("status line", () => {
    expect(statusLine(status)).toBe("week 1h 33m / 10h · today 33m / 1h 48m · debt 1h 52m · wrap-up Sun 22:00 (in 4d 3h) · reset Mon 06:00 (in 4d 11h)");
  });
});

describe("format", () => {
  test("durations", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(1)).toBe("1m");
    expect(formatDuration(60)).toBe("1m");
    expect(formatDuration(61)).toBe("2m");
    expect(formatDuration(61, "down")).toBe("1m");
    expect(formatDuration(5143)).toBe("1h 26m");
    expect(formatDuration(36000)).toBe("10h");
  });
  test("countdowns", () => {
    expect(formatCountdown(0)).toBe("now");
    expect(formatCountdown(59_000)).toBe("now");
    expect(formatCountdown(90 * 60_000)).toBe("1h 30m");
    expect(formatCountdown(51 * 3600_000)).toBe("2d 3h");
  });
  test("progress bar", () => {
    expect(progressBar(0, 10)).toBe("▱▱▱▱▱▱▱▱▱▱");
    expect(progressBar(5, 10)).toBe("▰▰▰▰▰▱▱▱▱▱");
    expect(progressBar(20, 10)).toBe("▰▰▰▰▰▰▰▰▰▰");
  });
});
