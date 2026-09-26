import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/index";

const SIGNING_SECRET = "test-signing-secret";

function sign(body: string, ts = Math.floor(Date.now() / 1000)) {
  const sig = `v0=${createHmac("sha256", SIGNING_SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
  return { "x-slack-signature": sig, "x-slack-request-timestamp": String(ts) };
}

describe("bolt app on bun (real HTTP server)", () => {
  let base = "";
  let stop: () => Promise<void> = async () => {};
  const responses: unknown[] = [];
  let responder: ReturnType<typeof Bun.serve> | null = null;

  beforeAll(async () => {
    responder = Bun.serve({
      port: 0,
      fetch: async (req) => {
        responses.push(await req.json());
        return new Response("ok");
      },
    });
    const { app, deps } = createApp(
      {
        PUBLIC_URL: "https://goblin.test",
        PORT: "3999",
        SLACK_BOT_TOKEN: "xoxb-fake",
        SLACK_SIGNING_SECRET: SIGNING_SECRET,
        HACKATIME_CLIENT_ID: "cid",
        HACKATIME_CLIENT_SECRET: "secret",
        ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
        DATABASE_PATH: ":memory:",
        LOG_LEVEL: "error",
      },
      { verifyToken: false, botId: "B0GOBLIN", botUserId: "U0GOBLIN" },
    );
    deps.slack = { sendDm: async () => null, userTimezone: async () => "Europe/Stockholm" };
    const server = (await app.start(0)) as unknown as { address(): AddressInfo };
    base = `http://127.0.0.1:${server.address().port}`;
    stop = async () => {
      await app.stop();
    };
  });

  afterAll(async () => {
    await stop();
    responder?.stop(true);
  });

  test("healthz", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("signed url_verification returns the challenge", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "goblin-challenge", token: "x" });
    const res = await fetch(`${base}/slack/events`, { method: "POST", body, headers: { "content-type": "application/json", ...sign(body) } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("goblin-challenge");
  });

  test("unsigned and stale requests are rejected", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "x" });
    const unsigned = await fetch(`${base}/slack/events`, { method: "POST", body, headers: { "content-type": "application/json" } });
    expect(unsigned.status).toBe(401);
    const stale = await fetch(`${base}/slack/events`, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...sign(body, Math.floor(Date.now() / 1000) - 3600) },
    });
    expect(stale.status).toBe(401);
  });

  test("/goblin help is acked and answered via response_url", async () => {
    const form = new URLSearchParams({
      command: "/goblin",
      text: "help",
      user_id: "U0SMOKE",
      team_id: "T0",
      channel_id: "D0",
      response_url: `http://127.0.0.1:${responder!.port}/respond`,
      trigger_id: "t",
    }).toString();
    const res = await fetch(`${base}/slack/events`, { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded", ...sign(form) } });
    expect(res.status).toBe(200);
    for (let i = 0; i < 50 && responses.length === 0; i++) await Bun.sleep(20);
    expect(JSON.stringify(responses[0])).toContain("/goblin status");
  });

  test("timezone options load over HTTP", async () => {
    const payload = {
      type: "block_suggestion",
      action_id: "tz",
      block_id: "tz",
      value: "stockholm",
      user: { id: "U0SMOKE" },
      team: { id: "T0" },
      view: { id: "V0", callback_id: "tz_modal" },
    };
    const form = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const res = await fetch(`${base}/slack/events`, { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded", ...sign(form) } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { options: { value: string }[] };
    expect(json.options.map((o) => o.value)).toEqual(["Europe/Stockholm"]);
  });

  test("oauth callback with a bogus state renders the stale page", async () => {
    const res = await fetch(`${base}/oauth/callback?code=abc&state=bogus`);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("that link is stale");
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});
