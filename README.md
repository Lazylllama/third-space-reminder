# deadline goblin 👺

A Slack bot that reads your [Hackatime](https://hackatime.hackclub.com) hours and DMs you (annoyingly, on purpose) until your weekly [Third Space](https://thirdspace.hackclub.com) hours are in and shipped.

```
hey @you, you owe the week 1h 52m. the goblin accepts payment in code only. 1h 48m left today.
week 1h 33m / 10h · today 0m / 1h 48m · debt 1h 52m · wrap-up Sun 22:00 (in 4d 3h) · reset Mon 06:00 (in 4d 11h)
[😴 snooze 1h] [📊 status]
```

## What it does

- You connect Hackatime (OAuth, read only) and make a **reminder**. A reminder has a group of Hackatime projects, a weekly goal (default 10h), the hours you want to be nagged at, optional slack-off days, and a wrap-up time.
- The goblin splits the goal into **daily targets** in your timezone and checks in at your hours until today's target is done.
- Miss a day and it becomes **debt**, spread over the days you have left. You always see how much debt you have and what today needs to recoup it.
- **Slack days** are silent while you're on track. If you're behind, the goblin asks for exactly the debt that day, nothing more.
- The week **hard resets Monday 00:00 New York time**, which is Third Space's deadline (06:00 in Sweden, Sunday 21:00 in California). Debt never carries over.
- It doesn't plan for you to code at 4am. By default the plan wraps up **Sunday 22:00 your time** (or earlier if the reset comes first). Time logged after that still counts.
- **Final day escalation:** on the wrap-up day, if you're not done, it checks in hourly from noon, then every 30 minutes in the last 3 hours. The day before, it warns you if more than 1.5 days' worth is left.
- Once the goal is hit it bugs you to **ship on thirdspace.hackclub.com** until you press "i shipped".
- ~190 goblin quotes so it doesn't repeat itself.

### How hours are counted

- It uses Hackatime's `/api/v1/users/my/stats?total_seconds=true&filter_by_project=...` for exact time windows. All categories count, AI included.
- Hackatime can total a group of projects two ways: one merged timeline, or per project and summed. They can differ by a few minutes either way. The goblin uses **the smaller one**, so it never tells you you're done before Third Space does. If you want a buffer anyway, set the goal to something like 10.25.

### The math, precisely

For a week `[Mon 00:00 NY, next Mon 00:00 NY)` in your timezone:

- **Plan days:** from the local date the week starts on (or the next date, if the week starts at or after 18:00 local, like on the US west coast) through the wrap-up date. Slack days are removed to get the **work days** (N).
- **Base:** `goal / N` per work day.
- **Debt at the start of today:** `max(0, goal × (work days before today) / N − done before today)`.
- **Today's target:**
  - On a work day: `(goal − done before today) / (work days left including today)`. That's the base plus the debt spread over the remaining days, and it gets smaller if you're ahead.
  - On a slack day: exactly the debt.
  - The last work day gets whatever is left.

Everything is recomputed from Hackatime at each check-in, so edits, late-synced heartbeats and timezone changes are always reflected.

## Setup

You need three things: a domain on Coolify, a Hackatime OAuth app and a Slack app. Keep the secrets in Coolify's environment variables.

### 1. Pick the domain

Decide the public URL the app will live on in Coolify, e.g. `https://goblin.yourdomain.com`. This is `PUBLIC_URL`.

### 2. Hackatime OAuth app

1. Go to <https://hackatime.hackclub.com/oauth/applications/new> (logged in).
2. Fill it in:
   - Name: `deadline goblin`
   - Redirect URI: `https://goblin.yourdomain.com/oauth/callback`
   - Confidential: yes
   - Scopes: `profile read`
3. Save. Copy the **UID** into `HACKATIME_CLIENT_ID` and the **Secret** into `HACKATIME_CLIENT_SECRET`.

### 3. Slack app

1. Open `manifest.yml` and replace every `YOUR-DOMAIN` with your domain.
2. Go to <https://api.slack.com/apps>, then **Create New App → From a manifest**, pick the workspace and paste the manifest.
3. **Install to Workspace.** Hack Club's workspace may need an admin to approve it.
4. Copy **OAuth & Permissions → Bot User OAuth Token** (`xoxb-...`) into `SLACK_BOT_TOKEN`.
5. Copy **Basic Information → Signing Secret** into `SLACK_SIGNING_SECRET`.

Slack verifies the request URL when you save the manifest. If the app isn't deployed yet, deploy first (step 4), then go to **Event Subscriptions** and hit retry.

### 4. Coolify

1. **New Resource → Application**, pointing at this repo. Build pack: **Dockerfile**.
2. **Domain:** `https://goblin.yourdomain.com`. **Port:** `3000`.
3. **Persistent Storage:** add a volume mounted at `/data`. The SQLite database lives there, and without it every redeploy wipes everyone's reminders.
4. **Health check:** path `/healthz`. The Dockerfile also has a `HEALTHCHECK`.
5. **Environment variables** (see `.env.example`):

   | var | value |
   | --- | --- |
   | `PUBLIC_URL` | `https://goblin.yourdomain.com` |
   | `SLACK_BOT_TOKEN` | `xoxb-...` |
   | `SLACK_SIGNING_SECRET` | from Slack |
   | `HACKATIME_CLIENT_ID` | from Hackatime |
   | `HACKATIME_CLIENT_SECRET` | from Hackatime |
   | `ENCRYPTION_KEY` | output of `openssl rand -base64 32`. Keep it forever: changing it forces everyone to reconnect |
   | `DATABASE_PATH` | `/data/goblin.sqlite` (already the default in the image) |
   | `ALLOWED_SLACK_IDS` | optional, e.g. `U0123,U0456` to limit who can use it |
   | `ADMIN_SLACK_IDS` | optional, your member ID (Slack profile → ⋮ → Copy member ID). Admins get a usage section on the Home tab |
   | `DRY_RUN` | optional, `true` logs DMs instead of sending them |

6. Deploy. The logs should say `deadline goblin is up`.

Run **one** instance. If Coolify briefly overlaps two containers during a deploy, that's fine: every check-in is claimed in SQLite before it's sent, so nobody gets double nagged.

### 5. Use it

Open the **deadline goblin** app in Slack, then its **Home** tab:

1. Connect Hackatime.
2. Check your timezone. It comes from your Slack profile, and you can override it.
3. Create a reminder (it's prefilled for Third Space: 10h, done by Sun 22:00, ship nags on).

Commands:

- `/goblin status`
- `/goblin pause 2` (1 to 14 days)
- `/goblin resume`
- `/goblin test` (sends a nag right now)
- `/goblin help`

In the DM you can type `status` or `help`.

## Checking usage

Put your member ID in `ADMIN_SLACK_IDS`. You'll get a **🛠 admin** section at the bottom of the goblin's Home tab, refreshed every time you open it (or hit 🔄 refresh).

What's in it:
- **Counts:** actively nagged (connected, not paused, with an enabled reminder), connected, needs reconnect, everyone who opened the goblin, paused, reminders, and DMs sent in the last 24h and 7d.
- **This week's tally:** 🔌 needs reconnect, ⚠️ behind, 🏁 done but not shipped, ❔ no data, ✅ on track, 🚢 shipped, ⏸ paused.
- **Last week:** how many hit the goal, and how many shipped.
- **Every user:** their reminders, hours, and state, sorted worst first.

The numbers come from each reminder's last check-in, not from live Hackatime calls, so the section stays fast however many people use it. Each line says how old its numbers are.

Privacy: admins can see everyone's weekly progress. Only list people who should.

Without an admin ID you can still query the database from Coolify's terminal:

```sh
bun -e 'const db = new (require("bun:sqlite").Database)("/data/goblin.sqlite", { readonly: true });
console.log(db.query("select count(distinct r.slack_id) as n from reminders r join users u using (slack_id) where r.enabled = 1 and u.token_status = ?").get("ok"))'
```

## Development

```sh
bun install
bun test            # unit tests, full-week minute-by-minute simulations, Bolt HTTP smoke test
bun run typecheck
cp .env.example .env && bun run dev
```

For local Slack testing, expose the port with a tunnel (e.g. `cloudflared tunnel --url http://localhost:3000`), use that URL in the manifest and `PUBLIC_URL`, and add the tunnel callback as a second redirect URI on the Hackatime app.

### Layout

| path | what |
| --- | --- |
| `src/time/week.ts` | week window (NY reset), wrap-up deadline, plan dates per timezone |
| `src/engine/plan.ts` | daily target / debt math, per-day breakdown |
| `src/engine/slots.ts` | when to check in (your hours, final-day escalation, heads-up) |
| `src/engine/decide.ts` | what to say at a check-in |
| `src/engine/evaluate.ts` | Hackatime numbers into a status, with a stale-cache fallback |
| `src/scheduler.ts` | the minute tick: claim slot, evaluate, decide, send |
| `src/messages/` | quotes and message rendering |
| `src/slack/` | App Home, modals, buttons, `/goblin`, DMs, admin section |
| `src/admin/usage.ts` | classifies every reminder for the admin overview (from cached numbers) |
| `src/hackatime/client.ts` | Hackatime API + OAuth client (retries, auth errors, caching) |
| `src/http/routes.ts` | OAuth callback page |
| `src/db/` | SQLite schema and queries |
