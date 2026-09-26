import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { decrypt, encrypt } from "../src/crypto";
import { handleOAuthCallback, renderPage } from "../src/http/routes";
import { parseReminderSubmission, parseTzSubmission, reminderModal, searchZones } from "../src/slack/modals";
import { buildHome } from "../src/slack/home";
import { KEY, SLACK_ID, addReminder, connectUser, makeDeps } from "./helpers";

describe("crypto", () => {
  test("round trip, random IV, tamper detection", () => {
    const a = encrypt("secret-token", KEY);
    const b = encrypt("secret-token", KEY);
    expect(a).not.toBe(b);
    expect(decrypt(a, KEY)).toBe("secret-token");
    const parts = a.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(parts.join("."), KEY)).toThrow();
    expect(() => decrypt(a, Buffer.alloc(32, 1))).toThrow();
  });
});

describe("config", () => {
  const env = {
    PUBLIC_URL: "https://goblin.example.com/",
    SLACK_BOT_TOKEN: "xoxb-1",
    SLACK_SIGNING_SECRET: "s",
    HACKATIME_CLIENT_ID: "c",
    HACKATIME_CLIENT_SECRET: "cs",
    ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
  };
  test("defaults and normalization", () => {
    const c = loadConfig(env);
    expect(c.publicUrl).toBe("https://goblin.example.com");
    expect(c.hackatimeBaseUrl).toBe("https://hackatime.hackclub.com");
    expect(c.port).toBe(3000);
    expect(c.allowedSlackIds).toBeNull();
    expect(c.dryRun).toBe(false);
  });
  test("rejects bad keys and missing vars", () => {
    expect(() => loadConfig({ ...env, ENCRYPTION_KEY: "short" })).toThrow(/32 bytes/);
    expect(() => loadConfig({ ...env, SLACK_BOT_TOKEN: "" })).toThrow(/SLACK_BOT_TOKEN/);
    expect(() => loadConfig({ ...env, PUBLIC_URL: "goblin.example.com" })).toThrow(/PUBLIC_URL/);
  });
  test("allowlist", () => {
    expect([...loadConfig({ ...env, ALLOWED_SLACK_IDS: "U1, U2" }).allowedSlackIds!]).toEqual(["U1", "U2"]);
  });
});

describe("repo", () => {
  test("slot claims are exclusive and releasable", () => {
    const { repo } = makeDeps("2026-09-21T10:00:00Z");
    connectUser(repo);
    const r = addReminder(repo);
    expect(repo.claimSlot(r.id, "k")).toBe(true);
    expect(repo.claimSlot(r.id, "k")).toBe(false);
    repo.releaseSlot(r.id, "k");
    expect(repo.claimSlot(r.id, "k")).toBe(true);
  });

  test("oauth states are single use and expire", () => {
    const { repo, clock } = makeDeps("2026-09-21T10:00:00Z");
    repo.createOAuthState("s1", SLACK_ID, 60_000);
    expect(repo.consumeOAuthState("s1")).toBe(SLACK_ID);
    expect(repo.consumeOAuthState("s1")).toBeNull();
    repo.createOAuthState("s2", SLACK_ID, 60_000);
    clock.now += 61_000;
    expect(repo.consumeOAuthState("s2")).toBeNull();
  });

  test("deleting a reminder cascades", () => {
    const { repo } = makeDeps("2026-09-21T10:00:00Z");
    connectUser(repo);
    const r = addReminder(repo);
    repo.claimSlot(r.id, "k");
    repo.setShipped(r.id, "2026-09-21", 1);
    repo.deleteReminder(r.id);
    expect(repo.db.query("SELECT COUNT(*) AS n FROM slot_log").get()).toEqual({ n: 0 });
    expect(repo.db.query("SELECT COUNT(*) AS n FROM week_state").get()).toEqual({ n: 0 });
  });

  test("active reminders join their users", () => {
    const { repo } = makeDeps("2026-09-21T10:00:00Z");
    connectUser(repo);
    const r = addReminder(repo, { slackDays: [6, 7] });
    const [item] = repo.activeReminders();
    expect(item!.reminder).toEqual(r);
    expect(item!.user.tz).toBe("Europe/Stockholm");
    expect(item!.user.tokenStatus).toBe("ok");
    repo.setReminderEnabled(r.id, false);
    expect(repo.activeReminders().length).toBe(0);
  });
});

describe("oauth callback", () => {
  const params = (p: Record<string, string>) => new URLSearchParams(p);

  function withHackatime(me: { id: number; slack_id: string | null }) {
    const env = makeDeps("2026-09-21T10:00:00Z");
    env.fake.extra = (url) => {
      if (url.pathname === "/oauth/token") return Response.json({ access_token: "fresh-token", scope: "profile read" });
      if (url.pathname === "/oauth/revoke") return new Response("{}");
      if (url.pathname === "/api/v1/authenticated/me") return Response.json(me);
      return null;
    };
    return env;
  }

  test("happy path stores an encrypted token", async () => {
    const { deps, repo } = withHackatime({ id: 9, slack_id: SLACK_ID });
    repo.createOAuthState("st", SLACK_ID, 60_000);
    const res = await handleOAuthCallback(deps, params({ code: "c", state: "st" }));
    expect(res.status).toBe(200);
    expect(res.connected).toBe(SLACK_ID);
    const user = repo.getUser(SLACK_ID)!;
    expect(user.tokenStatus).toBe("ok");
    expect(user.hackatimeUserId).toBe(9);
    expect(user.tokenEnc).not.toContain("fresh-token");
    expect(decrypt(user.tokenEnc!, KEY)).toBe("fresh-token");
  });

  test("unknown or replayed state is refused", async () => {
    const { deps, repo } = withHackatime({ id: 9, slack_id: SLACK_ID });
    expect((await handleOAuthCallback(deps, params({ code: "c", state: "nope" }))).status).toBe(400);
    repo.createOAuthState("st", SLACK_ID, 60_000);
    await handleOAuthCallback(deps, params({ code: "c", state: "st" }));
    expect((await handleOAuthCallback(deps, params({ code: "c", state: "st" }))).status).toBe(400);
  });

  test("hackatime account of a different slack user is refused", async () => {
    const { deps, repo } = withHackatime({ id: 9, slack_id: "U0SOMEONEELSE" });
    repo.createOAuthState("st", SLACK_ID, 60_000);
    const res = await handleOAuthCallback(deps, params({ code: "c", state: "st" }));
    expect(res.status).toBe(403);
    expect(repo.getUser(SLACK_ID)?.tokenStatus ?? "none").toBe("none");
  });

  test("user denied access", async () => {
    const { deps, repo } = withHackatime({ id: 9, slack_id: SLACK_ID });
    repo.createOAuthState("st", SLACK_ID, 60_000);
    const res = await handleOAuthCallback(deps, params({ error: "access_denied", state: "st" }));
    expect(res.status).toBe(400);
    expect(repo.consumeOAuthState("st")).toBeNull();
  });

  test("page escapes html", () => {
    expect(renderPage("<b>", "<script>x</script>")).not.toContain("<script>x");
  });
});

describe("modals", () => {
  const good = {
    name: { name: { value: " third space " } },
    projects: { projects: { selected_options: [{ value: "goblin" }, { value: "other-proj" }, { value: "goblin" }] } },
    goal: { goal: { value: "10.5" } },
    hours: { hours: { selected_options: [{ value: "21" }, { value: "18" }] } },
    slack_days: { slack_days: { selected_options: [{ value: "7" }] } },
    wrap_day: { wrap_day: { selected_option: { value: "7" } } },
    wrap_time: { wrap_time: { selected_time: "22:00" } },
    ship: { ship: { selected_options: [{ value: "ship" }] } },
  };

  test("parses a valid submission", () => {
    const { input, errors } = parseReminderSubmission(good);
    expect(errors).toEqual({});
    expect(input).toEqual({
      name: "third space",
      projects: ["goblin", "other-proj"],
      goalSeconds: 37800,
      hours: [18, 21],
      slackDays: [7],
      wrapDay: 7,
      wrapMinutes: 1320,
      shipNag: true,
    });
  });

  test("rejects every broken field", () => {
    const { input, errors } = parseReminderSubmission({
      name: { name: { value: "  " } },
      projects: { projects: { selected_options: [{ value: "a,b" }] } },
      goal: { goal: { value: "0.1" } },
      hours: { hours: { selected_options: [] } },
      slack_days: { slack_days: { selected_options: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ value: String(d) })) } },
      wrap_day: { wrap_day: { selected_option: { value: "3" } } },
      wrap_time: { wrap_time: { selected_time: "09:00" } },
    });
    expect(input).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(["goal", "hours", "name", "projects", "slack_days", "wrap_day", "wrap_time"]);
  });

  test("empty project list is an error", () => {
    expect(parseReminderSubmission({ ...good, projects: { projects: { selected_options: [] } } }).errors.projects).toBeDefined();
  });

  test("modal prefills an existing reminder", () => {
    const { repo } = makeDeps("2026-09-21T10:00:00Z");
    connectUser(repo);
    const r = addReminder(repo, { goalSeconds: 37800, slackDays: [6] });
    const view = reminderModal({ reminder: r, tz: "Europe/Stockholm", now: Date.parse("2026-09-21T10:00:00Z") });
    const json = JSON.stringify(view);
    expect(json).toContain('"initial_value":"10.5"');
    expect(json).toContain('"initial_time":"22:00"');
    expect(JSON.parse(view.private_metadata!)).toEqual({ id: r.id });
    expect(view.blocks.length).toBeLessThanOrEqual(100);
  });

  test("timezone submission", () => {
    expect(parseTzSubmission({ follow: { follow: { selected_options: [{ value: "follow" }] } } }).follow).toBe(true);
    const manual = parseTzSubmission({ tz: { tz: { selected_option: { value: "Asia/Kolkata" } } } });
    expect(manual).toEqual({ follow: false, tz: "Asia/Kolkata", errors: {} });
    expect(parseTzSubmission({ tz: { tz: { selected_option: { value: "Mars/Olympus" } } } }).errors.tz).toBeDefined();
    expect(parseTzSubmission({}).errors.tz).toBeDefined();
  });

  test("timezone search", () => {
    expect(searchZones("stockholm")).toEqual(["Europe/Stockholm"]);
    expect(searchZones("new york")).toEqual(["America/New_York"]);
    expect(searchZones("").length).toBe(100);
  });
});

describe("home view", () => {
  test("not connected: connect button with a fresh oauth state", async () => {
    const { deps, repo } = makeDeps("2026-09-21T10:00:00Z");
    const view = await buildHome(deps, SLACK_ID);
    const json = JSON.stringify(view);
    expect(json).toContain("connect hackatime");
    const url = new URL(json.match(/"url":"([^"]+)"/)![1]!);
    expect(url.pathname).toBe("/oauth/authorize");
    expect(repo.consumeOAuthState(url.searchParams.get("state")!)).toBe(SLACK_ID);
  });

  test("connected with a reminder: progress, breakdown, buttons", async () => {
    const { deps, repo, fake } = makeDeps("2026-09-23T17:00:00Z");
    connectUser(repo);
    addReminder(repo);
    fake.code("2026-09-21T09:00", 60);
    const view = await buildHome(deps, SLACK_ID);
    const json = JSON.stringify(view);
    expect(json).toContain("1h / 10h");
    expect(json).toContain("Mon ❌ 1h/1h 26m");
    expect(json).toContain("send me a nag now");
    expect(view.blocks.length).toBeLessThanOrEqual(100);
  });

  test("allowlist blocks strangers", async () => {
    const { deps } = makeDeps("2026-09-21T10:00:00Z");
    deps.config = { ...deps.config, allowedSlackIds: new Set(["U0FRIEND"]) };
    const json = JSON.stringify(await buildHome(deps, SLACK_ID));
    expect(json).toContain("isn't taking new victims");
    expect(json).not.toContain("connect hackatime");
  });
});
