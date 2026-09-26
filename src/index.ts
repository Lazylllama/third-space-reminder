import { App, LogLevel } from "@slack/bolt";
import { loadConfig } from "./config";
import { openDatabase } from "./db/db";
import { Repo } from "./db/repo";
import { createLogger, type Deps } from "./deps";
import { HackatimeClient } from "./hackatime/client";
import { handleOAuthCallback, renderPage, requestParams, sendHtml } from "./http/routes";
import { Scheduler } from "./scheduler";
import { WebSlackGateway } from "./slack/gateway";
import { buildHome } from "./slack/home";
import { registerHandlers } from "./slack/register";

/** `opts` exist for tests: skip the startup auth.test and pretend to know the bot's ids. */
export function createApp(
  env: Record<string, string | undefined> = process.env,
  opts: { verifyToken?: boolean; botId?: string; botUserId?: string } = {},
) {
  const config = loadConfig(env);
  const log = createLogger(config.logLevel);
  const db = openDatabase(config.databasePath);
  const repo = new Repo(db);
  const hackatime = new HackatimeClient({
    baseUrl: config.hackatimeBaseUrl,
    clientId: config.hackatimeClientId,
    clientSecret: config.hackatimeClientSecret,
    redirectUri: `${config.publicUrl}/oauth/callback`,
  });

  // `deps` is referenced by the custom routes below, which only run after the app is built.
  let deps: Deps;

  const app = new App({
    token: config.slackBotToken,
    signingSecret: config.slackSigningSecret,
    port: config.port,
    logLevel: config.logLevel === "debug" ? LogLevel.DEBUG : LogLevel.INFO,
    tokenVerificationEnabled: opts.verifyToken ?? true,
    ...(opts.botId && opts.botUserId ? { botId: opts.botId, botUserId: opts.botUserId } : {}),
    customRoutes: [
      {
        path: "/healthz",
        method: ["GET"],
        handler: (_req, res) => {
          try {
            db.query("SELECT 1").get();
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("ok");
          } catch {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("db unavailable");
          }
        },
      },
      {
        path: "/oauth/callback",
        method: ["GET"],
        handler: (req, res) => {
          void (async () => {
            try {
              const result = await handleOAuthCallback(deps, requestParams(req));
              sendHtml(res, result.status, renderPage(result.title, result.message));
              if (result.connected) {
                const slackId = result.connected;
                await app.client.views.publish({ user_id: slackId, view: await buildHome(deps, slackId) }).catch((err) => log.warn("home publish failed", err));
                await deps.slack
                  .sendDm(slackId, { text: "hackatime connected 👺 the goblin can see your hours now. set up a reminder on the home tab." })
                  .catch((err) => log.warn("connected DM failed", err));
              }
            } catch (err) {
              log.error("oauth callback crashed", err);
              if (!res.headersSent) sendHtml(res, 500, renderPage("the goblin tripped", "something broke on our side. try connecting again from slack."));
            }
          })();
        },
      },
    ],
  });

  deps = {
    config,
    repo,
    hackatime,
    slack: new WebSlackGateway(app.client, log, config.dryRun),
    clock: Date.now,
    log,
  };

  registerHandlers(app, deps);
  app.error(async (err) => {
    log.error("bolt error", err);
  });

  const scheduler = new Scheduler(deps);
  return { app, deps, scheduler, config, log, db };
}

if (import.meta.main) {
  const { app, scheduler, config, log, db } = createApp();
  await app.start(config.port);
  scheduler.start();
  log.info(`deadline goblin is up on :${config.port} (${config.publicUrl})${config.dryRun ? " [dry run]" : ""}`);

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down`);
    scheduler.stop();
    try {
      await app.stop();
    } catch {
      // already stopped
    }
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
