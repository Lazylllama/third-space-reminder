import type { IncomingMessage, ServerResponse } from "node:http";
import { encrypt } from "../crypto";
import type { Deps } from "../deps";

export interface OAuthCallbackResult {
  status: number;
  title: string;
  message: string;
  /** Slack user that just got connected. */
  connected?: string;
}

/** The OAuth redirect target. Pure-ish: returns what to render, side effects go through deps. */
export async function handleOAuthCallback(deps: Deps, params: URLSearchParams): Promise<OAuthCallbackResult> {
  const error = params.get("error");
  const state = params.get("state");
  const code = params.get("code");

  if (state) {
    // Consume the state even on error so it can't be replayed.
    const slackId = deps.repo.consumeOAuthState(state);
    if (error) return { status: 400, title: "no hackatime for the goblin", message: `hackatime said: ${params.get("error_description") || error}. you can try again from the goblin's home tab in slack.` };
    if (!slackId) return { status: 400, title: "that link is stale", message: "this connect link expired or was already used. open the goblin's home tab in slack and hit connect again." };
    if (!code) return { status: 400, title: "missing code", message: "hackatime didn't send an authorization code. try connecting again from slack." };

    let token: string;
    try {
      token = (await deps.hackatime.exchangeCode(code)).accessToken;
    } catch (err) {
      deps.log.error("oauth code exchange failed", err);
      return { status: 502, title: "hackatime handshake failed", message: "the goblin couldn't trade the code for a token. try again in a minute." };
    }

    let me;
    try {
      me = await deps.hackatime.me(token);
    } catch (err) {
      deps.log.error("oauth /me failed", err);
      await deps.hackatime.revoke(token);
      return { status: 502, title: "hackatime handshake failed", message: "connected, but hackatime wouldn't say who you are. try again in a minute." };
    }

    if (me.slackId && me.slackId !== slackId) {
      await deps.hackatime.revoke(token);
      return {
        status: 403,
        title: "wrong account",
        message: "that hackatime account is linked to a different slack user. log into the hackatime account that belongs to you and try again.",
      };
    }

    deps.repo.setToken(slackId, encrypt(token, deps.config.encryptionKey), me.id, me.slackId);
    deps.log.info(`hackatime connected for ${slackId} (hackatime user ${me.id})`);
    return { status: 200, title: "connected!", message: "the goblin can see your hackatime now. head back to slack and set up a reminder.", connected: slackId };
  }

  if (error) return { status: 400, title: "no hackatime for the goblin", message: `hackatime said: ${error}.` };
  return { status: 400, title: "hmm", message: "this page is for finishing the hackatime connection. start from the goblin's home tab in slack." };
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function renderPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>deadline goblin</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #302b24; color: #fbfadb; font: 18px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 32rem; padding: 2rem; }
  h1 { color: #3ec771; font-size: 2rem; margin: 0 0 .5rem; }
  p { margin: 0; color: #e8e6c8; }
  .goblin { font-size: 3rem; }
</style>
</head>
<body><main><div class="goblin">👺</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body>
</html>`;
}

export function sendHtml(res: ServerResponse, status: number, html: string) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(html);
}

export function requestParams(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? "/", "http://localhost").searchParams;
}
