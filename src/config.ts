export interface Config {
  publicUrl: string;
  port: number;
  slackBotToken: string;
  slackSigningSecret: string;
  hackatimeBaseUrl: string;
  hackatimeClientId: string;
  hackatimeClientSecret: string;
  encryptionKey: Buffer;
  databasePath: string;
  allowedSlackIds: Set<string> | null;
  dryRun: boolean;
  logLevel: "debug" | "info" | "warn" | "error";
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const publicUrl = required(env, "PUBLIC_URL").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(publicUrl)) throw new Error("PUBLIC_URL must start with http:// or https://");

  const encryptionKey = Buffer.from(required(env, "ENCRYPTION_KEY"), "base64");
  if (encryptionKey.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 32 bytes, base64 encoded (generate one with: openssl rand -base64 32)");
  }

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("PORT must be a valid port number");

  const allowed = (env.ALLOWED_SLACK_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const logLevel = (env.LOG_LEVEL ?? "info").toLowerCase();
  if (!["debug", "info", "warn", "error"].includes(logLevel)) throw new Error("LOG_LEVEL must be debug, info, warn or error");

  return {
    publicUrl,
    port,
    slackBotToken: required(env, "SLACK_BOT_TOKEN"),
    slackSigningSecret: required(env, "SLACK_SIGNING_SECRET"),
    hackatimeBaseUrl: (env.HACKATIME_BASE_URL?.trim() || "https://hackatime.hackclub.com").replace(/\/+$/, ""),
    hackatimeClientId: required(env, "HACKATIME_CLIENT_ID"),
    hackatimeClientSecret: required(env, "HACKATIME_CLIENT_SECRET"),
    encryptionKey,
    databasePath: env.DATABASE_PATH?.trim() || "./data/goblin.sqlite",
    allowedSlackIds: allowed.length > 0 ? new Set(allowed) : null,
    dryRun: ["1", "true", "yes"].includes((env.DRY_RUN ?? "").toLowerCase()),
    logLevel: logLevel as Config["logLevel"],
  };
}
