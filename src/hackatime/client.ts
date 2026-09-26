export class HackatimeAuthError extends Error {
  constructor(message = "Hackatime rejected the token") {
    super(message);
    this.name = "HackatimeAuthError";
  }
}

export class HackatimeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "HackatimeError";
  }
}

export interface HackatimeMe {
  id: number;
  slackId: string | null;
  githubUsername: string | null;
}

export interface HackatimeProject {
  name: string;
  totalSeconds: number;
  mostRecentHeartbeat: string | null;
  archived: boolean;
}

export interface HackatimeClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof fetch;
  /** Max attempts for retryable failures (429, 5xx, network). */
  maxAttempts?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Parallel request cap. */
  concurrency?: number;
  cacheTtlMs?: number;
  clock?: () => number;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Project names can't contain commas: Hackatime splits `filter_by_project` on raw commas. */
export function isValidProjectName(name: string): boolean {
  return name.length > 0 && name.length <= 150 && !name.includes(",") && name.trim() === name;
}

export class HackatimeClient {
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly concurrency: number;
  private readonly cacheTtlMs: number;
  private readonly clock: () => number;
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private readonly cache = new Map<string, { at: number; value: number }>();

  constructor(private readonly opts: HackatimeClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.concurrency = opts.concurrency ?? 4;
    this.cacheTtlMs = opts.cacheTtlMs ?? 60_000;
    this.clock = opts.clock ?? Date.now;
  }

  authorizeUrl(state: string): string {
    const url = new URL("/oauth/authorize", this.opts.baseUrl);
    url.searchParams.set("client_id", this.opts.clientId);
    url.searchParams.set("redirect_uri", this.opts.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "profile read");
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<{ accessToken: string; scope: string }> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.opts.redirectUri,
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
    });
    const res = await this.request("/oauth/token", { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } }, false);
    if (res.status === 400 || res.status === 401) {
      throw new HackatimeError(`Token exchange failed (${res.status}): ${await safeText(res)}`, res.status);
    }
    const json = (await this.json(res)) as { access_token?: unknown; scope?: unknown };
    if (typeof json.access_token !== "string" || !json.access_token) throw new HackatimeError("Token exchange returned no access_token");
    return { accessToken: json.access_token, scope: typeof json.scope === "string" ? json.scope : "" };
  }

  async revoke(token: string): Promise<void> {
    const body = new URLSearchParams({ token, client_id: this.opts.clientId, client_secret: this.opts.clientSecret });
    try {
      await this.request("/oauth/revoke", { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } }, false);
    } catch {
      // best effort
    }
  }

  async me(token: string): Promise<HackatimeMe> {
    const res = await this.request("/api/v1/authenticated/me", { headers: auth(token) }, true);
    const json = (await this.json(res)) as { id?: unknown; slack_id?: unknown; github_username?: unknown };
    if (typeof json.id !== "number") throw new HackatimeError("Unexpected /authenticated/me response");
    return {
      id: json.id,
      slackId: typeof json.slack_id === "string" && json.slack_id ? json.slack_id : null,
      githubUsername: typeof json.github_username === "string" ? json.github_username : null,
    };
  }

  async projects(token: string): Promise<HackatimeProject[]> {
    const res = await this.request("/api/v1/authenticated/projects", { headers: auth(token) }, true);
    const json = (await this.json(res)) as { projects?: unknown };
    if (!Array.isArray(json.projects)) throw new HackatimeError("Unexpected /authenticated/projects response");
    const out: HackatimeProject[] = [];
    for (const p of json.projects as Record<string, unknown>[]) {
      if (typeof p?.name !== "string" || !p.name) continue;
      out.push({
        name: p.name,
        totalSeconds: typeof p.total_seconds === "number" ? p.total_seconds : 0,
        mostRecentHeartbeat: typeof p.most_recent_heartbeat === "string" ? p.most_recent_heartbeat : null,
        archived: p.archived === true,
      });
    }
    return out.sort((a, b) => (b.mostRecentHeartbeat ?? "").localeCompare(a.mostRecentHeartbeat ?? "") || a.name.localeCompare(b.name));
  }

  /**
   * Seconds logged on the project group in [startMs, endMs).
   * Hackatime can total a group two ways (one merged timeline, or per project then summed) and they can disagree
   * by a few minutes either way. We take the smaller one so we never call a goal done before Third Space does.
   */
  async groupSeconds(token: string, projects: string[], startMs: number, endMs: number): Promise<number> {
    const names = [...new Set(projects)].filter(isValidProjectName);
    if (names.length === 0 || endMs <= startMs) return 0;
    if (names.length === 1) return this.statsTotal(token, names, startMs, endMs);
    const [merged, ...parts] = await Promise.all([
      this.statsTotal(token, names, startMs, endMs),
      ...names.map((name) => this.statsTotal(token, [name], startMs, endMs)),
    ]);
    return Math.min(merged!, parts.reduce((a, b) => a + b, 0));
  }

  private async statsTotal(token: string, projects: string[], startMs: number, endMs: number): Promise<number> {
    const url = new URL("/api/v1/users/my/stats", this.opts.baseUrl);
    url.searchParams.set("total_seconds", "true");
    url.searchParams.set("filter_by_project", projects.join(","));
    url.searchParams.set("start_date", new Date(startMs).toISOString());
    url.searchParams.set("end_date", new Date(endMs).toISOString());

    const cacheKey = `${hash(token)}|${url.search}`;
    const cached = this.cache.get(cacheKey);
    const now = this.clock();
    if (cached && now - cached.at < this.cacheTtlMs) return cached.value;

    const res = await this.request(url.pathname + url.search, { headers: auth(token) }, true);
    const json = (await this.json(res)) as { total_seconds?: unknown };
    if (typeof json.total_seconds !== "number" || !Number.isFinite(json.total_seconds) || json.total_seconds < 0) {
      throw new HackatimeError("Unexpected stats response");
    }
    const value = Math.floor(json.total_seconds);
    this.cache.set(cacheKey, { at: now, value });
    if (this.cache.size > 5000) this.pruneCache(now);
    return value;
  }

  private pruneCache(now: number) {
    for (const [key, entry] of this.cache) if (now - entry.at >= this.cacheTtlMs) this.cache.delete(key);
  }

  private async json(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      throw new HackatimeError(`Invalid JSON from Hackatime (${res.status})`, res.status);
    }
  }

  /** Fetch with timeout, concurrency cap and retries. `authed` requests map auth failures to HackatimeAuthError. */
  private async request(path: string, init: RequestInit, authed: boolean): Promise<Response> {
    await this.acquire();
    try {
      let lastError: unknown;
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        let res: Response;
        try {
          res = await this.fetchImpl(new URL(path, this.opts.baseUrl), { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
        } catch (err) {
          lastError = err;
          if (attempt < this.maxAttempts) await this.sleep(backoff(attempt));
          continue;
        }

        if (authed && (res.status === 401 || res.status === 403)) throw new HackatimeAuthError();
        // `/users/my/...` answers 404 "User not found" when the token doesn't resolve to a user.
        if (authed && res.status === 404 && path.startsWith("/api/v1/users/my/")) {
          const text = await safeText(res);
          if (/user not found/i.test(text)) throw new HackatimeAuthError();
          throw new HackatimeError(`Hackatime 404: ${text}`, 404);
        }
        if (RETRYABLE.has(res.status)) {
          lastError = new HackatimeError(`Hackatime ${res.status}`, res.status);
          if (attempt < this.maxAttempts) {
            const retryAfter = Number(res.headers.get("retry-after"));
            await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : backoff(attempt));
          }
          continue;
        }
        if (!res.ok && !(path === "/oauth/token" && (res.status === 400 || res.status === 401))) {
          throw new HackatimeError(`Hackatime ${res.status}: ${await safeText(res)}`, res.status);
        }
        return res;
      }
      if (lastError instanceof HackatimeError) throw lastError;
      throw new HackatimeError(`Hackatime unreachable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(() => resolve()));
  }

  private release() {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }
}

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

function backoff(attempt: number): number {
  return 500 * 2 ** (attempt - 1);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}

function hash(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 16);
}
