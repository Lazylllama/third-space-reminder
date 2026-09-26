import { describe, expect, test } from "bun:test";
import { HackatimeAuthError, HackatimeClient, HackatimeError, isValidProjectName } from "../src/hackatime/client";

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function client(handler: Handler, extra: Partial<ConstructorParameters<typeof HackatimeClient>[0]> = {}) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  const c = new HackatimeClient({
    baseUrl: "https://hackatime.test",
    clientId: "cid",
    clientSecret: "secret",
    redirectUri: "https://goblin.test/oauth/callback",
    fetch: fetchImpl,
    sleep: async () => {},
    ...extra,
  });
  return { c, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("HackatimeClient", () => {
  test("authorize URL", () => {
    const { c } = client(() => json({}));
    const url = new URL(c.authorizeUrl("st4te"));
    expect(url.origin + url.pathname).toBe("https://hackatime.test/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("https://goblin.test/oauth/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("profile read");
    expect(url.searchParams.get("state")).toBe("st4te");
  });

  test("token exchange posts form data", async () => {
    const { c, calls } = client(() => json({ access_token: "tok", scope: "profile read" }));
    expect(await c.exchangeCode("abc")).toEqual({ accessToken: "tok", scope: "profile read" });
    const body = new URLSearchParams(calls[0]!.init.body as URLSearchParams);
    expect(calls[0]!.init.method).toBe("POST");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("abc");
    expect(body.get("client_secret")).toBe("secret");
    expect(body.get("redirect_uri")).toBe("https://goblin.test/oauth/callback");
  });

  test("token exchange failure is an error", async () => {
    const { c } = client(() => json({ error: "invalid_grant" }, 400));
    await expect(c.exchangeCode("bad")).rejects.toBeInstanceOf(HackatimeError);
  });

  test("single project: one stats call with exact params", async () => {
    const { c, calls } = client(() => json({ total_seconds: 1234 }));
    const secs = await c.groupSeconds("tok", ["my project"], Date.parse("2026-09-21T04:00:00Z"), Date.parse("2026-09-26T12:00:00Z"));
    expect(secs).toBe(1234);
    expect(calls.length).toBe(1);
    const u = calls[0]!.url;
    expect(u.pathname).toBe("/api/v1/users/my/stats");
    expect(u.searchParams.get("total_seconds")).toBe("true");
    expect(u.searchParams.get("filter_by_project")).toBe("my project");
    expect(u.searchParams.get("start_date")).toBe("2026-09-21T04:00:00.000Z");
    expect(u.searchParams.get("end_date")).toBe("2026-09-26T12:00:00.000Z");
    expect(u.searchParams.has("no_ai_coding")).toBe(false);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  test("multiple projects: min of merged and per-project sum", async () => {
    const totals: Record<string, number> = { "a,b": 30255, a: 25233, b: 8550 };
    const { c } = client((u) => json({ total_seconds: totals[u.searchParams.get("filter_by_project")!] }));
    expect(await c.groupSeconds("tok", ["a", "b"], 0, 1000)).toBe(30255);
    const totals2: Record<string, number> = { "a,b": 200, a: 120, b: 0 };
    const { c: c2 } = client((u) => json({ total_seconds: totals2[u.searchParams.get("filter_by_project")!] }));
    expect(await c2.groupSeconds("tok", ["a", "b"], 0, 1000)).toBe(120);
  });

  test("no projects or empty window: no call, zero", async () => {
    const { c, calls } = client(() => json({ total_seconds: 5 }));
    expect(await c.groupSeconds("tok", [], 0, 1000)).toBe(0);
    expect(await c.groupSeconds("tok", ["a"], 1000, 1000)).toBe(0);
    expect(calls.length).toBe(0);
  });

  test("404 User not found on /users/my is an auth error", async () => {
    const { c } = client(() => json({ error: "User not found" }, 404));
    await expect(c.groupSeconds("bad", ["a"], 0, 1000)).rejects.toBeInstanceOf(HackatimeAuthError);
  });

  test("401 on authenticated endpoints is an auth error", async () => {
    const { c } = client(() => new Response("", { status: 401 }));
    await expect(c.me("bad")).rejects.toBeInstanceOf(HackatimeAuthError);
    await expect(c.projects("bad")).rejects.toBeInstanceOf(HackatimeAuthError);
  });

  test("retries 429/5xx, then succeeds", async () => {
    let n = 0;
    const { c, calls } = client(() => (++n < 3 ? json({ error: "slow down" }, n === 1 ? 429 : 503) : json({ total_seconds: 42 })));
    expect(await c.groupSeconds("tok", ["a"], 0, 1000)).toBe(42);
    expect(calls.length).toBe(3);
  });

  test("gives up after max attempts", async () => {
    const { c, calls } = client(() => json({}, 502));
    await expect(c.groupSeconds("tok", ["a"], 0, 1000)).rejects.toBeInstanceOf(HackatimeError);
    expect(calls.length).toBe(3);
  });

  test("network errors are retried", async () => {
    let n = 0;
    const { c } = client(() => {
      if (++n === 1) throw new TypeError("fetch failed");
      return json({ total_seconds: 7 });
    });
    expect(await c.groupSeconds("tok", ["a"], 0, 1000)).toBe(7);
  });

  test("garbage responses are rejected, not treated as zero", async () => {
    const { c } = client(() => json({ total_seconds: "lots" }));
    await expect(c.groupSeconds("tok", ["a"], 0, 1000)).rejects.toBeInstanceOf(HackatimeError);
  });

  test("responses are cached briefly", async () => {
    let now = 0;
    const { c, calls } = client(() => json({ total_seconds: 1 }), { clock: () => now });
    await c.groupSeconds("tok", ["a"], 0, 1000);
    await c.groupSeconds("tok", ["a"], 0, 1000);
    expect(calls.length).toBe(1);
    now = 61_000;
    await c.groupSeconds("tok", ["a"], 0, 1000);
    expect(calls.length).toBe(2);
  });

  test("me and projects parse and sort", async () => {
    const { c } = client((u) =>
      u.pathname.endsWith("/me")
        ? json({ id: 42, slack_id: "U123", github_username: "orpheus" })
        : json({
            projects: [
              { name: "old", total_seconds: 10, most_recent_heartbeat: "2026-01-01T00:00:00Z", archived: false },
              { name: "new", total_seconds: 5, most_recent_heartbeat: "2026-09-25T00:00:00Z", archived: false },
              { name: "never", total_seconds: 0, most_recent_heartbeat: null, archived: true },
            ],
          }),
    );
    expect(await c.me("tok")).toEqual({ id: 42, slackId: "U123", githubUsername: "orpheus" });
    expect((await c.projects("tok")).map((p) => p.name)).toEqual(["new", "old", "never"]);
  });

  test("project name validation", () => {
    expect(isValidProjectName("third-space")).toBe(true);
    expect(isValidProjectName("a,b")).toBe(false);
    expect(isValidProjectName(" padded")).toBe(false);
    expect(isValidProjectName("")).toBe(false);
  });
});
