import type { KnownBlock } from "@slack/types";
import type { Config } from "./config";
import type { Repo } from "./db/repo";
import type { HackatimeClient } from "./hackatime/client";

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** The slice of Slack we need, so the scheduler can run against a fake in tests. */
export interface SlackGateway {
  /** Send a DM. Returns the message ts. */
  sendDm(slackId: string, message: { text: string; blocks?: KnownBlock[] }): Promise<string | null>;
  /** IANA timezone from the user's Slack profile, if any. */
  userTimezone(slackId: string): Promise<string | null>;
}

export interface Deps {
  config: Pick<Config, "encryptionKey" | "dryRun" | "allowedSlackIds" | "adminSlackIds" | "publicUrl">;
  repo: Repo;
  hackatime: HackatimeClient;
  slack: SlackGateway;
  clock: () => number;
  log: Logger;
}

export function createLogger(level: "debug" | "info" | "warn" | "error"): Logger {
  const order = { debug: 0, info: 1, warn: 2, error: 3 } as const;
  const min = order[level];
  const emit = (lvl: keyof typeof order) => (...args: unknown[]) => {
    if (order[lvl] < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase()}`;
    if (lvl === "error") console.error(line, ...args);
    else if (lvl === "warn") console.warn(line, ...args);
    else console.log(line, ...args);
  };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

export function isAdmin(deps: Pick<Deps, "config">, slackId: string): boolean {
  return deps.config.adminSlackIds.has(slackId);
}

/** Admins always get in, even when an allowlist is set. */
export function isAllowed(deps: Pick<Deps, "config">, slackId: string): boolean {
  return !deps.config.allowedSlackIds || deps.config.allowedSlackIds.has(slackId) || isAdmin(deps, slackId);
}
