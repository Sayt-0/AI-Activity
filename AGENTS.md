# AGENTS.md — AI Activity

> All project instructions live here. `CLAUDE.md` only points to this file.
> Everything in this repo (code, docs, UI) is in English.

## 1. What this is

A personal, multi-device dashboard showing **real measured usage** of AI coding
tools. Current scope: **Claude Code, Codex, OpenCode and Antigravity ingestion**.
OpenCode has no quota of its own: its card shows the conversations active
now (a reply in the last 10 minutes; listed in creation order so parallel
ones never swap places), else the last one, on the right; today's tokens, conversations,
calls, models and providers on the left. Antigravity has two quota pools
(Gemini, Claude/GPT), each shown with its own 5-hour and weekly windows;
quotas are opt-in, and while no window is running its card shows the same
activity view as OpenCode (`ActivityToolCard`).

Layout, top to bottom: token activity (centered year calendar, readout shows
today unless a day is hovered; the Weekly and Cumulative tabs likewise show
the last 7 days or the running total unless a week is hovered, focused or
tapped), four stats (all-time tokens, today, sessions,
current streak; hover shows the split by tool and model, or the longest
streak), one card per tool in `TOOLS` order (Claude Code, Codex,
Antigravity on a full row, then OpenCode, which takes 2/3 of the last row,
next to "Today by tool": today's tokens split by tool), recent conversations (10 + "Show more"). No tool filter:
every tool is always shown; on your own page, a one-line box under them
says how to add one (the install command, Settings → Devices). No cost or subscription tracking (removed on
purpose). Only demo data carries a badge ("Demonstration data"). Palette: the
original dark theme; type: Geist, with Geist Mono only for ids and model
names. Quota bars carry a mark for how far into the window we are.

**Pages:** `/` shows "Sign in with GitHub", the only way in (a GitHub
user with no account yet gets one, unless an admin closed sign-up; while
no account exists, the first-account form asks for the setup code first);
once signed in it redirects to `/u/<you>`, so the address bar is the
shareable link; there is no password anywhere. Under the form, "See a demo" links to `/demo`;
signing in from `/demo` lands on your profile, not back on the demo.
`/u/<username>` is **public and read-only**, no account needed: activity,
stats, tools/quotas and conversations.
`/demo` is **public** too: the fictional dataset as the profile of a
fictional user, "Demo preview" (initial only, no picture), built in the
browser (no usage API call, no refresh). It lives only at `/demo`, never
under `/u/`, so a real account named `demo` is never mistaken for it.
`/leaderboard` is **public** too: every enabled account (idle ones last,
with zeros) ranked by tokens over 7 days / 30 days / all time, with
server-wide totals, the model split and a global activity calendar.
`/friends` is signed-in only: it matches the viewer's public GitHub follows
by numeric id to enabled accounts here, with their public seven-day usage.
The GitHub list is cached for five minutes; if GitHub is unavailable, the
page shows a retry action. The
header (`SiteHeader`) is the same on every page: logo, demo badge, and the
avatar menu (or "Sign in"), plus a breadcrumb of the current page
(`AI Activity / (picture) @name`, `/ (initial) Demo preview`, `/ Leaderboard`, `/ Friends`, `/ Settings`, `/ Admin panel`) that
replaces in-page titles. It never reads the route itself (`App.svelte`
passes the breadcrumb); site chrome (header and `SiteFooter`) is rendered
once in `App.svelte`, outside the pages. The footer, like the top of
README.md, says the project is not affiliated with or endorsed by the
makers of the tools it measures (their names are trademarks, used only to
identify them): keep both, and name any newly supported tool's owner in
them.
Clicking the avatar opens Your profile / Leaderboard / Friends / Settings / Admin
panel (admins) / Sign out. `/settings` (signed in) holds Account (the
profile from GitHub, read-only), Devices and a Danger zone
(delete your own activity, or your whole account); `/admin`
(admins) holds the server overview, the account-creation switch and the
users (make or remove admin, disable).

**Hard rule:** the demo dataset is fictional and deterministic. It is only
visible at `/demo`, always labeled "Demonstration data" (and ` · Demo` in
the tab title), and never presented as a real measurement: no real profile
ever shows it (`?demo=1` is gone and does nothing).

## 2. Quick start

```bash
npm install
cp .env.example .env        # set PORT, DB_PATH, BACKUP_DIR, GITHUB_* (loaded by
                            # npm start/dev/backup/restore; real env vars win)
npm run build               # the UI, served from web/dist
npm start                   # http://localhost:3000
```

Viewer accounts sign in with GitHub only (issue #127): no passwords. Set
up a GitHub OAuth app first (github.com/settings/developers → OAuth Apps →
New OAuth App): homepage URL = the public address, **Authorization
callback URL = `<public address>/api/auth/github/callback`**. Put its
client id and a client secret in `.env` (`GITHUB_CLIENT_ID`,
`GITHUB_CLIENT_SECRET`; never in the repo), and `PUBLIC_URL` if the
address the browser uses is not what reaches the server (unset: the
request's host, through Caddy or the tunnel). No scope is asked for: the
server only reads the public profile (numeric id, login, name, picture),
never an email, and drops the token at once.

Nothing is viewable until the first account exists; it is an admin.
Create it in the browser: type the one-time **setup code** the server
prints at start (new on every start, only while no account exists), then
sign in with GitHub. After that, sign-up is open: any GitHub user who
signs in gets an account (5 new accounts per client per hour), until an
admin turns account creation off in the admin panel (existing accounts
still sign in). Everything happens on the site: accounts are only ever
created by signing in with GitHub, device keys only in Settings →
Devices (copyable again there). There is no account or key CLI.

Username = the GitHub login, name and picture = GitHub's, updated at each
sign-in (a login rename moves `/u/<login>`; the account, keyed by the
GitHub numeric id, keeps its data).

Health check: `GET /api/health` → `{"ok":true}`.

Web client (Svelte 5 + Vite, in `web/`):

```bash
npm run dev                 # API server on :3000 (watch mode; restart
                            # it after editing .env)
npm run dev:web             # UI with HMR on :5173, proxies /api and
                            # /install.{sh,ps1} → :3000
npm run build               # → web/dist (the default STATIC_DIR)
```

CI (`.github/workflows/ci.yml`) runs typecheck, the web build and tests
(tests serve `web/dist`, so the build comes first) on
every PR and push to main, on x64 and ARM64 runners (`better-sqlite3` is
native). It also builds the Docker image on both and smoke-tests it
(healthy, setup code, first account, device key, backup, clean stop), and
runs every collector test on Windows (`collectors (windows)`, through the
README's Windows commands).

### Deploy (Docker + Caddy)

Production runs in Docker behind the server's own **Caddy** container
(reverse proxy, automatic HTTPS), which this repo does not ship.
`compose.yaml` has two services: `app` (the server; no published port) and
`backup` (the same image, `npm run backup` every day into the `data`
volume). It creates the `ai-activity-proxy` network (`PROXY_SUBNET`,
default `172.29.94.0/24`), where the app answers as `ai-activity`; Caddy
joins it. Start this stack first: it creates the network.

```yaml
# Caddy's compose file: add the network to the caddy service
services:
  caddy:
    networks: [default, ai-activity-proxy]   # keep its existing networks
networks:
  ai-activity-proxy:
    external: true
```

```
# Caddy's Caddyfile (DNS A/AAAA record → this server), then reload Caddy
ai.example.com {
	encode zstd gzip
	reverse_proxy ai-activity:3000
}
```

```bash
docker compose up -d --build       # build, start, restart on crash/reboot
docker compose logs app            # setup code for the first account
docker compose exec app node scripts/backup.ts
git pull && docker compose up -d --build                  # upgrade by hand
```

Upgrades are normally deployed from GitHub (Continuous deployment below).

- The image (`Dockerfile`) is `node:22-slim` (glibc: `better-sqlite3` has
  prebuilt binaries for amd64 and arm64 on Node 22; Node 24 would compile
  from source), runs as `node`, has a `HEALTHCHECK` on `/api/health`, and
  `npm ci` runs inside it (never copy the host's `node_modules`).
- Data lives in the `data` volume mounted on `/data` (`DB_PATH=/data/dashboard.db`,
  `BACKUP_DIR=/data/backups`): mount the directory, never the database file
  alone (its `-wal` / `-shm` sit next to it). `docker stop` sends SIGTERM:
  the server closes SQLite, which checkpoints the WAL.
- Client addresses: Caddy sets `X-Forwarded-For` to the client's address
  (it replaces what the client sent, unless Caddy's `trusted_proxies` says
  otherwise), and the app trusts it only from `TRUST_PROXY`, the whole
  `ai-activity-proxy` subnet. So nothing but Caddy and the app may join
  that network: any other container on it could forge client addresses.
  Change `PROXY_SUBNET` if the range is taken. Without it every visitor
  would look like one client to the setup-code throttle and the sign-up cap.
  IPv6 visitors may all reach Caddy as one address, depending on how
  Caddy's own network and the host's Docker are set up (issue #102).
- Restore: `docker compose stop app backup`, then
  `docker compose run --rm --no-deps app node scripts/restore.ts /data/backups/<file>`,
  then `docker compose start app backup`.
- Sign in with GitHub needs a production OAuth app (callback
  `https://ai.example.com/api/auth/github/callback`) and its
  `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` in the server's `.env`
  **before** a version with it is deployed: without them nobody can sign
  in. Deploying it (migration 5) deletes every account and all measured
  data (kept in the `-pre-v5` backup): everyone signs in with GitHub again,
  makes a new device key in Settings and reinstalls the collectors, which
  send their whole local history again. To go back, in this order: deploy
  the older commit (`ALLOW_OLDER=1 ai-activity-deploy <commit>`), stop the
  app, restore the `-pre-v5` backup, start it. Restoring it under this
  code would only run migration 5 again and empty it once more.
- Before going live: revoke and reissue every device key used through
  quick tunnels, then point the collectors (statusLine, Codex hook,
  OpenCode plugin) at the new URL.
- Logs rotate (`x-logging` in `compose.yaml`: 3 × 10 MB per container);
  Docker keeps them forever otherwise.

### Continuous deployment (GHCR + SSH)

Once CI passes on a push to main, `.github/workflows/deploy.yml` builds the
image on native amd64 and arm64 runners, publishes it as
`ghcr.io/louismoretti/ai-activity:<commit>` (and `:latest`), then connects
over SSH and runs `deploy/ai-activity-deploy <commit>` on the server. It can
also be run by hand (Actions → Deploy → Run workflow, on main). The server
never builds: it pulls the tested image.

The deploy script: checks the commit is on `origin/main` and not older than
the one deployed (a slow run never undoes a newer deploy), pulls the image
(a missing one changes nothing), checks the commit out so `compose.yaml`
matches it, writes `APP_IMAGE=<image>:<commit>` into `.env` (so manual
`docker compose` commands use it too), runs
`docker compose up -d --wait` (non-zero and the app's logs if it does not
become healthy), then removes this app's older images. Volumes are never
touched. Migrations run at start and back the database up first (§4).

Server setup, once (Docker Compose ≥ 2.20 for `--wait-timeout`):

```bash
sudo useradd -m -s /bin/bash deploy && sudo usermod -aG docker deploy
sudo mkdir /srv/ai-activity && sudo chown deploy: /srv/ai-activity
sudo -u deploy git clone https://github.com/LouisMoretti/AI-Activity /srv/ai-activity
sudo -u deploy install -m 600 /dev/null /srv/ai-activity/.env   # GITHUB_CLIENT_ID/SECRET, PROXY_SUBNET=… if needed
# Outside the checkout, owned by root: a commit cannot change what the key runs.
sudo install -o root -g root -m 755 /srv/ai-activity/deploy/ai-activity-deploy /usr/local/bin/
ssh-keygen -t ed25519 -N '' -C github-deploy -f deploy_key    # on your machine
# /home/deploy/.ssh/authorized_keys (dir 700, file 600, owned by deploy):
restrict,command="/usr/local/bin/ai-activity-deploy" ssh-ed25519 AAAA… github-deploy
ssh-keyscan -p 22 ai.example.com      # from a trusted network; check the fingerprint
```

GitHub, Settings → Environments → `production`: deployment branches
limited to `main` (reviewers optional); secret `DEPLOY_SSH_KEY` (the private
key); variables `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS` (the `ssh-keyscan`
lines), optional `DEPLOY_USER` (default `deploy`) and `DEPLOY_PORT`
(default 22). After the first publish, make the GHCR package public
(Package settings → Change visibility; it holds no secret), or run
`docker login ghcr.io` as `deploy` with a `read:packages` token: the
first deploy fails on the pull until then, re-run it. Once it has run (it
creates `ai-activity-proxy`), add the network and the site to Caddy (above).

- The key's forced command ignores what the client asks for except the
  commit id (40 hex characters), and `restrict` turns off shells, PTYs and
  forwarding. `deploy` is in the `docker` group, which is root-equivalent:
  that forced command is what keeps a leaked key from being a root shell.
- Workflows of pull requests and forks never get the environment's
  secrets; `deploy.yml` only deploys green pushes to main of this repo.
- After changing `deploy/ai-activity-deploy`, install it again (the
  `install` line above): the server never runs it from the checkout.
- Roll back on the server: `ALLOW_OLDER=1 ai-activity-deploy <commit>`
  (commits with this deploy setup only), restoring the `-pre-v<N>` backup
  first if the newer version migrated the database (§4). Main's next push
  deploys forward again.
- Manual upgrade without GitHub: `git pull && docker compose up -d --build`
  with `APP_IMAGE` removed from `.env`.

Tests: `npm test` boots the real server on a temp DB and exercises the HTTP
API black-box (`test/api.test.js`), so they must stay green across refactors;
sign-ins go through a fake GitHub in the test process (`test/helpers.js`:
`githubUser`, `githubSignIn`, `login`, `register`), and the test server's
first account is GitHub "admin", made with the setup code;
`test/migrations.test.js` upgrades old databases through the
migrations; `test/rate-limit.test.js` covers the token buckets;
`test/backup.test.js` backs up during writes, prunes and
restores; `test/client.test.js` covers client addresses behind proxies;
`test/collector-versions.test.js` checks collector versions (constants,
file hashes, update hints in each collector);
`test/confirm-delete.test.js` runs the Settings danger zone's flows
(`confirm-delete.svelte.ts`, delete activity and delete account: confirm,
cancel, success, failure);
`test/series.test.js` covers pure helpers of the web
client; `test/dashboard.test.js` runs the client's state class
(`dashboard.svelte.ts`, compiled with `svelte/compiler`) against a fake
browser and fetch; `test/live.test.js` covers the API → view-model mapping;
`test/collector.test.js` runs `collectors/claude-code.py` through the
README's statusLine command and
`test/codex-collector.test.js` runs `collectors/codex.py` through the
README's Codex Stop hook; `test/opencode-collector.test.js` runs
`collectors/opencode.py` through its plugin on a fake OpenCode database;
`test/antigravity-collector.test.js` runs `collectors/antigravity.py` on
synthetic Antigravity databases; `test/install.test.js` runs `/install.sh`
(and, on Windows, `/install.ps1`) in a temporary home.
Types: `npm run typecheck` (tsc for server, svelte-check for web). Node >= 22.18 runs the TypeScript server directly
(type stripping, no build step), so only erasable TS syntax is allowed (no
`enum`, no parameter properties) and relative imports keep their `.ts`
extension.

### Issues and pull requests

- Every issue is labeled: a type (`bug`, `enhancement`, `question`), at
  least one area (`ui`, `server`, `collectors`, `infra`, `security`,
  `documentation`, `accessibility`), and `needs decision` while a choice
  is open. The forms in `.github/ISSUE_TEMPLATE/` (blank issues are off)
  add the type, and ask for the areas: people who cannot label (not
  maintainers) pick them there, a maintainer then adds them as labels.
  From the CLI:
  `gh issue create --label enhancement --label ui`.
- Every pull request closes an issue: open the issue first, then put
  `Closes #<issue>` in the description (`.github/pull_request_template.md`).
  Give the PR the issue's labels and assign it to its author:
  `gh pr create --assignee @me --label enhancement --label ui`.

### Worktrees

Every change is made in its own git worktree, on its own branch. The main
checkout stays on a clean `main` and is never edited directly:

```bash
git fetch origin
git worktree add ../AI-Activity-<branch> -b <branch> origin/main
cd ../AI-Activity-<branch> && npm install   # node_modules is per worktree
cp ../AI-Activity/.env .                     # if the task needs it
```

Once the work is done (PR merged or abandoned), clean up:

```bash
cd ../AI-Activity
git worktree remove ../AI-Activity-<branch>  # refuses if changes are left
git branch -d <branch>                       # -D if the PR was squash-merged
git worktree prune
```

- Stop what runs from the worktree first (`npm run dev`, tunnels, test
  servers), and never leave a stale worktree or branch behind.
- `data/` is per worktree: a fresh one starts with an empty database.

## 3. Architecture

```
Claude Code statusLine → collectors/claude-code.py
Codex Stop hook → collectors/codex.py
OpenCode plugin → collectors/opencode.py
Antigravity hooks → collectors/antigravity.py
(python3, detached, on the user's device; README.md)
   │  HTTPS  Authorization: Bearer <device key> (never in the URL)
   ▼
Node server (Hono + TypeScript, server/) + SQLite (better-sqlite3)
   │  serves the static web root (STATIC_DIR, default web/dist) + JSON APIs
   ▼
Browser dashboard (web/: Svelte 5 + TypeScript, built by Vite)
```

```
server/
  index.ts          boot: config, DB, listen
  app.ts            Hono app: /api mount, viewer-auth gate, static + SPA fallback
  config.ts         env → Config (PORT, DB_PATH, STATIC_DIR, BACKUP_DIR, GITHUB_*, PUBLIC_URL)
  db/schema.ts      open + migrate (runs pending migrations)
  db/migrations.ts  ordered schema migrations (PRAGMA user_version)
  db/queries.ts     every SQL statement lives here
  lib/ingest.ts     payload normalizers, one per tool slug
  lib/viewer-auth.ts  viewer sessions + setup code throttling
  lib/github.ts       Sign in with GitHub: authorize URL, code exchange, profile
  lib/accounts.ts     username = GitHub login (stale holders moved), profile sync
  lib/setup.ts        one-time setup code for the first account
  lib/avatar.ts       profile picture link allowlist
  lib/installer.ts    /install.sh, /install.ps1 (collectors/install.py + collectors)
  lib/backup.ts       consistent snapshots, retention, restore
  lib/client.ts       client address + HTTPS behind the tunnel or TRUST_PROXY
  lib/rate-limit.ts   token buckets + LIMITS (ingest, public reads, per user, OAuth)
  lib/http.ts
  routes/           auth, ingest, usage (public profiles + leaderboard),
                    friends (signed-in GitHub follows), devices,
                    account (profile + admin users)
shared/types.ts     API response types shared with the web client, TOOLS
shared/quota-pools.ts  quota window lengths, quota pools per tool (QUOTA_POOLS)
shared/collectors.ts   collector versions: latest and minimum per tool
web/
  src/lib/api.ts          typed fetch client (401 → UnauthorizedError)
  src/lib/view-model.ts   what components render (DashboardVM)
  src/lib/live.ts         API responses → DashboardVM ("Unavailable", never guessed)
  src/lib/demo.ts         FICTIONAL /demo dataset → DashboardVM (always labeled)
  src/lib/series.ts       pure helpers: dense day series, streaks, calendar grid
  src/lib/format.ts       number, day, duration and "ago" formatting
  src/lib/dashboard.svelte.ts  state: provider, auth status, GitHub sign-in, 15 s refresh
  src/lib/auth-errors.ts  ?auth_error=<code> → message (known codes only)
  src/lib/confirm-delete.svelte.ts  danger zone flows (typed phrase; sign in again if too old)
  src/App.svelte          routes the pages; renders the site chrome once
  src/components/         StatsRow (StatCard), ActivityChart (Heatmap,
                          TrendChart), QuotaCard (Claude Code, Codex,
                          Antigravity: one column per quota pool;
                          ToolHeader, QuotaWindow, Meter), OpenCodeCard
                          (wraps ActivityToolCard, the card of a tool
                          without quota windows),
                          TodayByTool,
                          Conversations, DevicesPanel,
                          DangerZone (DangerAction), AccountMenu,
                          SiteHeader, ProfilePanel, UsersPanel,
                          AuthPanel, Leaderboard, Friends,
                          AdminOverview, …
  src/styles/tokens.css   design tokens — components only use these variables
```

Components never branch on live vs demo: both sources map into the same
`DashboardVM`, so the "demo is always labeled" rule lives in `demo.ts` only.

- The server derives the user from the ingestion key (`devices.key_hash`);
  viewers are users linked to a GitHub account (`users.github_id`), and every viewer
  API is scoped to the signed-in user (`c.get("userId")`, set by
  `viewer-auth.ts`). Sessions live in `viewer_sessions` (token stored as a
  SHA-256 hash), so they survive restarts.
- The first account is created with the setup code, printed only in the
  server log: whoever reaches the public address first cannot take it.
- GitHub sign-in (`routes/auth.ts`): `POST /api/auth/github` keeps the
  sign-in in memory under a random `state` (10 minutes; mode sign-in,
  first account or sign in again, and where to come back) and sets it in an
  HttpOnly `gh_oauth` cookie on `/api/auth/github`; GitHub sends the
  browser to `/api/auth/github/callback`, which needs that same state in
  query and cookie (once only), exchanges the code server to server and
  reads `/user`. A restart drops sign-ins in progress. The account is
  found by GitHub numeric id; its username follows the login. Another
  account still holding a login GitHub gave to someone else becomes the
  first free `<name>-<id>`, `<name>-<id>-2`… until it signs in again
  (`server/lib/accounts.ts`).
- The Claude Code collector (`collectors/claude-code.py`, copied to
  `~/.claude/ai-activity-claude-code.py`, run as the statusLine command;
  exercised by `test/collector.test.js`) reads what was added to every
  local transcript since the last accepted upload (byte offsets in
  `~/.cache/ai-activity/offsets.json`; the first run imports all history)
  and posts one entry per Anthropic message id. It answers at once and
  runs itself again detached (`--worker`, handed the status line's JSON),
  so Claude Code cancelling the status line does not kill the upload. It
  replaced a `setsid -f python3 -c` one-liner and kept its offsets file
  and lock.
- Every collector keeps its progress (`offsets.json`, `codex.json`,
  `opencode.json`, `antigravity.json`) per target: `{"targets": {"<fp>":
  {…}}}`, `fp` = the first 16 hex digits of SHA-256 of the normalized
  server URL (scheme and host lowercased, default port and trailing `/`
  dropped), `\n`, the
  device key (`target()` in each script; `collectorTarget` in
  `test/helpers.js`). Never the key or a prefix of it: these files are not
  secret. A new server or key starts empty, so its next run resends the
  whole local history (dedup makes that safe); the 8 most recently used
  targets are kept, so switching back resumes. The shape from before
  targets is dropped (one full resend), except Antigravity's
  `{"scope": sha256(url + "\n" + key), …}`, carried over when it is the
  current target's. Issue #127.
- README.md ends with "How the collector scripts work": what the four
  scripts share and, per script, where it is copied, what runs it, what it
  reads, its progress and lock files, and its flags. Keep it in step.
- The collectors run on Windows too: locks are `msvcrt.locking` on the
  lock file's first byte there (`fcntl.flock` elsewhere), the 15-minute
  limit a timer instead of `SIGALRM`, and detached runs leave the console,
  the process group and, when allowed, the parent job. Hook commands on
  Windows are `& python "<script>" --hook` for Codex in PowerShell
  (`&` is required before a quoted executable path),
  `python "<script>" --hook` for Antigravity, or the script alone for
  Claude Code through Git Bash; use the syntax of the hook runner's shell.
- The Codex collector (`collectors/codex.py`, copied to
  `~/.codex/ai-activity-codex.py`, run detached by `PostToolUse`, `Stop`
  and `UserPromptSubmit` hooks in `~/.codex/hooks.json`) works the same way on
  the rollouts under `~/.codex/sessions` and `archived_sessions` (offsets in
  `~/.cache/ai-activity/codex.json`). `Stop` does not fire on rate-limit
  stops (upstream Codex bug), so `UserPromptSubmit` is the backstop that
  posts the exhausted quota's final snapshot on the next prompt; standalone
  `rate_limits` lines (a limit snapshot without token counts, e.g. from a
  failed turn) are recorded too. `PostToolUse` sends a long turn's usage
  while it runs; since it fires often, at most one run waits behind the
  active one (`codex-waiter.lock`) and any other exits at once. Every Codex front end writes those
  files (CLI, `codex exec`, IDE extension, desktop app), so desktop tasks
  are counted without subscribing to its App Server: a separate App Server
  only streams the threads it runs itself. On Windows the hooks run
  `codex.py --hook`, which answers `{}` and starts itself detached. Codex runs a new user hook only
  after it was trusted once (`/hooks`); until then the script can run by
  hand or from cron (idempotent).
- The OpenCode collector (`collectors/opencode.py`, copied to
  `~/.config/opencode/ai-activity-opencode.py`) reads OpenCode's SQLite
  database read-only (`~/.local/share/opencode/opencode.db`), selecting
  numeric fields only (never the `part` table, titles or paths). It sends
  assistant messages changed since the last accepted `time_updated`
  (`~/.cache/ai-activity/opencode.json`), so the database is the queue.
  The plugin (`collectors/opencode-plugin.js` →
  `~/.config/opencode/plugins/ai-activity.js`) runs it detached (with
  `python` on Windows, `python3` elsewhere) at OpenCode start and on every
  `session.idle`, one run at a time.
- One-command install: `GET /install.sh` and `GET /install.ps1` (no
  session) are `collectors/install.py` with the four collectors and the
  OpenCode plugin embedded (`server/lib/installer.ts`, built at start; the
  Docker image copies `collectors/` for it), wrapped for sh and for
  PowerShell (base64, ASCII only; run through `iex`, so it throws rather
  than `exit`s). Run as
  `curl -fsSL <server>/install.sh | AI_ACTIVITY_URL=… AI_ACTIVITY_KEY=… sh`
  or `$env:AI_ACTIVITY_URL=…; $env:AI_ACTIVITY_KEY=…; irm <server>/install.ps1 | iex`:
  the key is never in a URL and ends up only in the installed collectors
  (mode 600). It installs the tools found (or `AI_ACTIVITY_TOOLS`), copies
  each collector where the README puts it, writes the README's Linux/macOS
  commands (on Windows, the installing interpreter's absolute path), merges
  into `settings.json` / `hooks.json` without touching other entries or
  another statusLine (unless `AI_ACTIVITY_FORCE=1`), writes only what
  changed (through symlinks, to their target), reads every config before
  writing anything (an invalid one changes nothing), checks the key first
  (a redirect is fatal: the collectors' POSTs never follow one) and refuses root unless
  `AI_ACTIVITY_ALLOW_ROOT=1` (`test/install.test.js`, on Linux and
  Windows). Settings → Devices copies both commands per device; the owner's
  profile links there in a one-line box under the tools.
- Collectors are versioned (issue #125): each script has a `VERSION`,
  mirrored in `COLLECTOR_VERSIONS` (`shared/collectors.ts`), and sends
  `collector: {name, version}` in every payload. Bump both on **every**
  change to a collector's files (OpenCode: `opencode.py` or its plugin),
  even a compatible one: that is what flags old copies.
  `test/collector-versions.test.js` records each collector's file hash and
  fails when one changed without a new version. An outdated collector
  writes the server's hint to stderr and
  `~/.cache/ai-activity/update-available-<tool>`; Settings → Devices shows
  it. Updates stay manual (the install command again): the server never
  ships code to run.
- Never transmit prompts, transcripts, or provider keys — metrics only.

## 4. Data model (SQLite, `data/dashboard.db`)

- `users` — viewer accounts (`username` unique, case-insensitive: the
  GitHub login, NOT NULL; `github_id` unique and NOT NULL, the GitHub
  numeric id; `display_name` and `avatar_url` from GitHub, NULL when GitHub
  has none; `is_admin`, `disabled`,
  `activity_cleared_at`: when the user last deleted their activity, §6).
  `deleted_events` — ids of the messages a user deleted (ids only), so a
  resend is refused (§5). Device, usage, quota and session tables carry
  `user_id`. `viewer_sessions` holds hashed session tokens with expiry.
- `settings` — server-wide key/value settings set from the admin panel
  (`signup_open`: `0` closes account creation; absent means open).
- `collector_versions` — per device, tool and collector version (`0`: from
  before versions), when it last posted (`seen_at`). Written for a new
  version, else at most hourly (every post comes here, and a write empties
  the public read cache). Settings → Devices shows the lowest version seen
  within a day of the tool's last post, so an old copy still posting next
  to an updated one stays flagged.

- `usage_events` — one row per **Anthropic message id** (`event_id`,
  `source = 'message'`): that API response's tokens, model, session,
  device, date and `utc_offset_min` (the device's UTC offset then; NULL =
  UTC). Rows from the old statusLine snapshot collector have
  `source = 'snapshot'` and counted most API calls about twice; a session's
  snapshot rows are deleted from the time of its oldest message received
  (minus 2 minutes: a snapshot is stamped when the statusLine fired).
- `quota_snapshots` — one row per observed quota window
  (`five_hour`, `seven_day`): account, limit type, % used, reset time,
  measurement date (an unchanged value only moves the latest row's
  measurement date forward). Never summed; see §5 for which row is shown.
- Reads go through two covering indexes on `usage_events`
  (`idx_usage_user_read`: user, time, tool, session, model, token counts,
  offset; `idx_usage_user_session_read`: user, session, tool, time, token
  counts, offset). An index missing a covered column is rebuilt at start.
  Any new read query should be answerable from one of them.
- Migrations are versioned: `PRAGMA user_version` is the number of
  migrations a database has run, and `MIGRATIONS` in
  `server/db/migrations.ts` lists them in order. At open (server,
  `npm run backup` / `restore`), each pending one runs in its own transaction
  with its version bump, so a failure leaves the database at the last
  completed step. A database at a higher version than the code knows (made
  by a newer server) is refused at start. An existing database with
  pending migrations is backed up first (`<BACKUP_DIR>/dashboard-…-pre-v<N>.db`,
  never pruned), so an upgrade can be undone with `npm run restore`.
- To change the schema, append one function to `MIGRATIONS`, never edit or
  reorder a shipped one, and write it without "already done?" guards (it
  runs once per database). SQLite cannot alter a column in place: a type or
  constraint change rebuilds the table (create new, copy, drop, rename)
  inside that step.
- Migration 1 is the schema from before versioning (databases then are at
  version 0 with any subset of its changes applied), so it alone keeps
  idempotent checks. It also drops the leftovers of removed features
  (`usage_events.cost_estimated_usd`; the `billing_records`,
  `subscriptions`, `invites`, `app_settings` tables).
  `test/migrations.test.js` checks that a fresh database and older ones
  (`test/fixtures/schema-v0.sql`) end at the same schema with their data.
- Migration 2 removes legacy `snapshot` rows already covered by exact
  message rows: per user and session, every snapshot from 2 minutes before
  the session's oldest stored message on (the ingest rule, applied to
  databases whose collectors had already advanced their offsets before
  the 2-minute slack existed).
- Migration 3 adds `users.activity_cleared_at` and `deleted_events`.
- Migration 4 adds `collector_versions`.
- Migration 5 starts the database over for sign in with GitHub: it
  deletes every account and everything tied to them (usage, quotas,
  deleted ids, devices, collector versions, sessions, settings) and
  rebuilds the empty `users` table strict (`github_id` and `username` NOT
  NULL and unique, no `password_hash`; the other tables' foreign keys
  follow it by name), with the id sequences reset. Accounts
  from before could never sign in again. The `-pre-v5` backup keeps it
  all; people sign in with GitHub, make a device key in Settings, and the
  collectors send their whole local history again (their offsets are
  kept per server and key, §3).

### Backups

`data/dashboard.db` runs in WAL mode: never copy the file while the server
runs (recent writes sit in `dashboard.db-wal`, and a copy can catch a
half-written page).

```bash
npm run backup                          # safe while the server runs
npm run backup -- --out /mnt/backups --keep-daily 7 --keep-weekly 4
npm run restore -- data/backups/dashboard-20260925-134052.db   # server stopped
```

- `backup` takes a `VACUUM INTO` snapshot (one self-contained file, every
  write committed before it started), writes it under a temporary name,
  runs `integrity_check` on it and only then names it
  `dashboard-YYYYMMDD-HHMMSS.db` (UTC; `-2`, `-3`… for more in the same
  second) in `BACKUP_DIR` (default `data/backups`, made mode 700; files
  are 600 from the moment they are created). It exits non-zero on any
  failure.
  Then it prunes: the newest backup of each of the last 7 days and of each
  of the last 4 ISO weeks stay. Only names of that exact shape are ever
  deleted (`-pre-v2`, `-pre-restore` copies and other files stay).
- Schedule it daily: in Docker, the compose file's `backup` service does
  (`BACKUP_EVERY_SEC`, default 86400; it starts once the app is healthy
  and retries a failed run after 5 minutes); else a cron line on the
  server, e.g.
  `15 3 * * * cd /srv/ai-activity && npm run -s backup`.
- Copy the backups **off the machine** too, or they die with its disk:
  e.g. `rsync -a data/backups/ backup-host:ai-activity/` or `rclone sync
  data/backups remote:ai-activity` (an rclone `crypt` remote encrypts
  them). Backups hold session and device key hashes (and, before v5, password hashes) and the
  copyable device keys: the destination must be private.
- `restore` checks the backup (integrity, schema not newer than the code),
  refuses while anything has the database open (it must leave WAL mode,
  which needs every other connection gone), saves the current database as
  `…-pre-restore.db` (one it cannot read or back up, i.e. corrupt, is set
  aside as `dashboard.db.corrupt-<stamp>` instead), then replaces it and
  removes the stale `-wal` / `-shm`. Sessions are rolled back with it: users may have to sign in again,
  and events posted after the backup are missing: the collectors only send
  what their offsets say is new. Deleting `~/.cache/ai-activity/*.json` on
  a device makes its next run resend its whole local history (dedup makes
  that safe). A device pointed at a new server or given a new key does it
  on its own: offsets are kept per server and key (§3).

Counting rules:

- Conversations = `COUNT(DISTINCT session_id)`. User messages (separate
  from assistant replies and tool calls) are not counted yet (issue #6):
  nothing in the API or the UI shows a message count.
- Count each message id once, with its final counts (the transcript may
  write a partial entry first). Never store the statusLine's
  `context_window.current_usage`: it re-fires with a partial then a final
  snapshot per API call. Never sum cumulative counters (`total_input_tokens`, `total_cost_usd`) or
  observed quotas across devices of the same account.
- Missing data is displayed as "Unavailable", never interpolated.
- Days are local, like GitHub's contribution calendar: an event counts on
  `date(occurred_at + utc_offset_min * 60)`, the day where and when it
  happened, for every visitor, and never moves afterwards (DST and travel
  included). "Today", the end of a profile's calendar and its current
  streak use the offset of the owner's latest event that has one (UTC if
  none); the leaderboard's streaks too, per account, and its calendar ends
  on the latest of those days. A streak counts back from today, or from
  yesterday while today has no usage yet (it only breaks once a whole
  local day passes without any). Time ranges (`stats?days`, leaderboard
  periods) stay rolling windows of 24 h days.

## 5. Ingestion API

`POST /api/ingest/<tool>` with header `Authorization: Bearer <device key>`.
The tool slug in the URL picks the payload normalizer
(`server/lib/ingest.ts`, one entry per slug): `claude-code`, `codex`, `antigravity` and `opencode` (`TOOLS` in
`shared/types.ts`). There is no default: a bare `/api/ingest` and unknown slugs → `404`.
Unknown or revoked keys → `401`. Small JSON bodies only (256 KB max).
Rate limits per device key **and tool** (one key serves every tool on a
machine: a Claude Code import never holds up Codex), all `429` with
`Retry-After`:

- 300 requests, refill 5/s: batches that write rows, and posts with only
  quotas / context.
- 3,000 replays, refill 50/s: batches whose messages were all stored
  already (the request is given back and charged here instead). The
  collectors resend their whole backlog after any refusal (the Claude Code
  one only saves its offsets once a run is fully accepted), so replays
  need this much larger budget.
- 20,000 rows written (stored or updated), refill 10/s. A batch is charged
  what it wrote, after the fact, so it can push the device into debt;
  while in debt, a batch that would write rows is rolled back (`429`) but
  its quotas and context are still recorded, and replays still pass. A
  backlog therefore always drains, at the refill rate once past the burst,
  which covers a first import of about a month of history.

The payload's `tool` is optional; when present it must equal the slug
(`400` otherwise).

Collector versions: every payload carries `"collector": {"name": "<slug>",
"version": N}` (`COLLECTOR_VERSIONS`, `shared/collectors.ts`). Missing, a
different name or not a positive integer counts as version 0. The version
is recorded per device and tool (`collector_versions`, §4). Behind the
latest, the answer carries `"update": {"latest": N, "minimum": M}` (the
post is still accepted). Below `MIN_COLLECTOR_VERSIONS` (0 for every tool
until a breaking change needs one), the post is refused with `426` (same
`update`, no usage stored; its version is recorded): the collectors keep their offsets, so the
backlog goes out once updated. An empty body (`{}`, the installer's key
check) is neither recorded nor refused.

A batch of transcript messages (what the README collector sends):

```json
{
  "messages": [
    {
      "message_id": "msg_011CfQ1q3CGJXyE6UmWhehGs",
      "session_id": "7d891161-…",
      "model": "claude-opus-5-5",
      "occurred_at": 1790334657,
      "utc_offset_min": 120,
      "usage": {
        "input_tokens": 2,
        "output_tokens": 281,
        "cache_creation_input_tokens": 19373,
        "cache_read_input_tokens": 20882
      }
    }
  ],
  "rate_limits": {
    "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
    "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
  },
  "context": { "session_id": "7d891161-…", "used_pct": 42, "window_size": 200000 },
  "occurred_at": 1790334657,
  "account_ref": "default",
  "collector": { "name": "claude-code", "version": 1 }
}
```

→ `{ok, messages, stored, updated, deduped}` (plus `update` for an outdated
collector). One flat event is also
accepted: its `event_id` is the message id (`usage`, `session_id`, `model`,
`occurred_at` at the top level) → `{ok, stored, updated, deduped, event_id}`.

Notes:

- Dedup: `event_id` = Anthropic message id, stored once. Claude Code writes
  a response in several transcript entries, sometimes a partial one (a few
  output tokens) before the final one: a message seen again with more
  output tokens replaces the stored counts (`updated`), anything else is a
  replay (`deduped`). A message id stored by another account is never
  touched. The collector resends the recent messages on every refresh;
  that is safe by design.
- Entries without an Anthropic message id (`msg_…`; e.g. a random per-fire
  UUID) store no usage, and neither does a raw
  statusLine payload (`context_window.current_usage`): it re-fires with a
  partial then a final snapshot per API call, which counted about twice.
  Such a payload still records its quotas and context gauge.
- When messages of a session arrive, that session's old `snapshot` rows
  from 2 minutes before the oldest of those messages on are deleted, so the
  two never add up. The collector's first run sends whole transcripts, so
  every session still on disk is fully replaced.
- Context gauge: `context` (or a raw statusLine `context_window`) is put on
  the session's newest row; `recentSessions` shows the latest one.
- Empty messages (zero tokens) store no row.
- After a user deleted their activity (§6), a message they deleted (its
  id is in `deleted_events`, whatever time a skewed clock gives it) or
  dated up to then (`occurred_at <= users.activity_cleared_at`) stores
  nothing and counts as `deduped` (the collector moves on); quotas and the
  context gauge measured up to then are dropped. Resending local history
  never brings deleted messages back. The cutoff only moves forward: a device
  whose clock runs behind loses what it measured in the gap, even once
  its clock is right again. Quotas and context have no id: a device whose
  clock runs ahead (its times are capped at now) can replay one measured
  before the deletion; it is replaced within its window.
- `utc_offset_min` (minutes east of UTC, −720..840, quarter hours; else
  dropped → UTC) dates the event's local day (§4). A replay that carries
  one fills it on a row stored without (resending the history fixes old
  days); a stored offset never changes.
- Quotas: every window with a numeric `used_percentage` (or `used_pct`) is
  recorded, dated by the payload's `occurred_at` (capped at now). A device
  can post stale values (a terminal that has not called the API yet), so
  per `(account_ref, tool, limit_type)` the dashboard shows, among the
  rows measured in the day before the latest one, the window that resets
  last and its highest `used_pct` (usage only rises within a window;
  resets within 10 min of the latest are the same window, since Codex
  jitters `resets_at` by seconds between snapshots). A
  window whose `resets_at` is further away than its length (5 h, 7 days,
  31 days for unknown types; plus 10 min) is dropped at ingest, since it
  would pin the display. Cost fields are ignored.
- Antigravity quotas are recorded only for the `account_ref`s of
  `QUOTA_POOLS.antigravity` (`gemini`, `claude-gpt`; `shared/quota-pools.ts`),
  any other is dropped; each pool is its own quota, shown apart, never summed.

### Claude Code sources → payload mapping

| Source | Payload field |
| --- | --- |
| transcript `message.id` | `messages[].message_id` (dedup key) |
| transcript `sessionId` (also on subagent files) | `messages[].session_id` |
| transcript `message.model`, `timestamp` | `model`, `occurred_at` |
| device clock at `timestamp` (`time.localtime(t).tm_gmtoff // 60`) | `messages[].utc_offset_min` |
| transcript `message.usage` (4 counters) | `messages[].usage` |
| statusLine `rate_limits.*` | `rate_limits` snapshots (absent → "Unavailable") |
| statusLine `context_window.used_percentage` / `context_window_size` | `context` gauge, never summed |

Transcripts: `~/.claude/projects/<project>/<session>.jsonl`, subagents in
`<session>/subagents/agent-*.jsonl` (same `sessionId`, never in the main
file). Only ids, model, time and counts leave the device, never content.

### Codex sources → payload mapping (`POST /api/ingest/codex`)

Same batch shape (`messages`, `rate_limits`, `context`, `occurred_at`,
`account_ref`), with Codex's own field names:

| Rollout source | Payload field |
| --- | --- |
| `token_usage_record.response_id` (`resp_…`) | `messages[].response_id` (dedup key) |
| older rollouts (no records): `token_count` → `tc_<session>_<thread total>` | `messages[].event_id` |
| `token_usage_record.session_id` / `session_meta.id` | `messages[].session_id` |
| latest `turn_context.model` (or `thread_settings_applied`) | `messages[].model` |
| `token_usage_record.usage` (`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`) | `messages[].usage` |
| machine clock at the line's `timestamp` | `messages[].utc_offset_min` |
| `token_count.rate_limits.primary` / `secondary` (`used_percent`, `window_minutes`, `resets_at`) | `rate_limits` → `five_hour` (300 min) / `seven_day` (10080 min); other lengths dropped |
| `token_count.info.last_token_usage.total_tokens` / `model_context_window` | `context.used_tokens` / `window_size` → `used_pct` |

- OpenAI counts cached input inside `input_tokens` (and reasoning inside
  `output_tokens`): stored input is `input_tokens − cached − cache write`,
  so a response's stored total equals Codex's `total_tokens`. Codex's own
  "tokens used" line excludes cached input and is smaller.
- `thread_token_usage` / `total_token_usage` are cumulative and never
  stored; older rollouts repeat `token_count` lines, which map to the same
  id. Other ids (not `resp_…` / `tc_…`) store no usage.
- `occurred_at` of a batch is when Codex measured its rate limits (the
  `token_count` line), so a replayed backlog never overrides newer values.

### OpenCode sources → payload mapping (`POST /api/ingest/opencode`)

`{messages: [...]}`, one entry per assistant message of `opencode.db`
(OpenCode 1.18 schema; `message.data` is JSON):

| Database source | Payload field |
| --- | --- |
| `message.id` (`msg_…`) | `messages[].message_id` → stored as `opencode:<id>` |
| `message.session_id`, walked up `session.parent_id` to the root | `messages[].session_id` |
| `data.providerID` / `data.modelID` | `provider_id` / `model_id` → model `provider/model` |
| `data.time.completed` (else `created`), ms | `occurred_at` (s) |
| machine clock at that time | `messages[].utc_offset_min` |
| `data.tokens.input` / `output` / `reasoning` / `cache.read` / `cache.write` / `total` | `usage.input_tokens` / `output_tokens` / `reasoning_tokens` / `cache_read_tokens` / `cache_write_tokens` / `total_tokens` |

- The `opencode:` prefix is required: OpenCode ids look like Anthropic ids
  (`msg_…`) and must never collide with them. Other ids store no usage.
- OpenCode 1.18 counts reasoning apart from output (its `total` adds it):
  stored output is `output + reasoning`. When `total` shows reasoning
  already inside output (`total = input + output + cache`, reasoning ≤
  output), it is not added twice. Input excludes the cache already.
- Subagent (child) sessions are sent as their root session, so a
  conversation counts once, like Claude Code subagents.
- A message still being written is sent with its partial counts and
  replaced by its final ones (more output tokens → `updated`).
- No `rate_limits` are recorded, whatever the payload holds: OpenCode has
  no 5-hour or weekly window. `cost` is never read. Billing mode per
  session (BYOK vs OpenCode's own) is not recorded yet: it cannot be told
  from the database (a zero cost is free, subscription or unknown price).

### Antigravity sources → payload mapping (`POST /api/ingest/antigravity`)

`collectors/antigravity.py` (hooks: `PostInvocation` and `Stop` in
`~/.gemini/config/hooks.json`; README.md) reads the `gen_metadata` table of
each conversation database under
`~/.gemini/{antigravity,antigravity-cli,antigravity-ide}/conversations/*.db`
(read-only; `data` is an undocumented protobuf):

| Database source | Payload field |
| --- | --- |
| `data` 1.4.11 (response id) | `messages[].response_id` → event `antigravity:<session>:<response>` |
| database file name | `messages[].session_id` → stored as `antigravity:<name>` |
| `data` 1.19 (`gemini-default` → null) | `messages[].model` |
| `data` 1.9.4 timestamp, else the unique `steps` row matching step 4 / bot 1.4.7 | `occurred_at` |
| machine clock at that time | `messages[].utc_offset_min` |
| `data` 1.4.1 + 1.4.2 / 1.4.5 / 1.4.9 + 1.4.10 | `usage.input_tokens` / `cache_read_tokens` / `output_tokens` (text + thinking) |
| `agy -p /usage` buckets `gemini-*` / `3p-*` (`5h`, `weekly`) | quota-only batch, `account_ref` `gemini` / `claude-gpt`, `rate_limits.five_hour` / `seven_day` |

- The same response id in two conversation databases counts twice (the
  event id includes the session). Subagent conversations count on their
  own: the local format does not link them to a parent.
- A row without a response id, a timestamp (or a unique step match) or a
  valid protobuf is skipped with a warning, never dated by file mtime or
  import time. A database in an unsupported format, or unreadable other
  than busy, is skipped until it changes; a busy one fails the run.
- Only new responses, or ones with more output tokens than accepted, are
  sent (partial then final counts, like the other tools); unchanged
  databases are not read. Cache writes and context are not recorded.
- Quotas are opt-in (`AI_ACTIVITY_ANTIGRAVITY_QUOTAS=1`): the probe runs the
  signed-in `agy`, which reaches Google's backend, and Antigravity's terms
  restrict third-party tools. Off, nothing but local metadata is read.
- Quota pools and windows mirror `QUOTA_POOLS` / `QUOTA_WINDOW_SEC`
  (`shared/quota-pools.ts`, `POOLS` / `WINDOWS` in the collector): the two
  pools are never summed. Only `agy` 1.1.11 or later receives `/usage`
  (older ones may take it as a prompt), in an empty directory, without the
  Activity URL/key. Unknown, disabled, duplicate or out-of-range buckets
  are dropped.
- Quota uploads back off on their own (five minutes after a failure, or
  `Retry-After`), so they never delay usage uploads.

## 6. Viewer + device APIs

Viewer (cookie session after a GitHub sign-in; every viewer API answers
`401` without one, including before the first account exists):

- `GET /api/auth/status` → `{authenticated, user, setup_required, signup_open, github_sign_in}`
  (`user` is `{id, username, display_name, avatar_url, is_admin}` or null;
  `setup_required` while no account exists; `github_sign_in`: sign-in is
  set up, else nobody can sign in), `POST /api/auth/logout`
- `POST /api/auth/github {next?, setup_code?, reauth?}` → `{url}`: the
  GitHub authorize page to send the browser to (`503` if GitHub sign-in is
  not set up). `next` is where to come back: a path starting with one `/`,
  with no backslash, whitespace or control character (browsers drop tabs
  and newlines from a `Location`, so `/<tab>/evil.example` would leave the
  site), then resolved (dot segments: `/a/..//evil.example` is
  `//evil.example`) and checked again; that normalized path is what every
  redirect uses. Anything else is `/`. While no account exists it needs `setup_code` (wrong or
  missing → `401`, `409` if the server has none; throttled below; the code
  ignores case, spaces and dashes): that sign-in creates the first
  account, admin. `reauth: true` (signed in, else `401`) signs the same
  account in again, for the danger zone.
- `GET /api/auth/github/callback?code&state` (GitHub sends the browser
  here) → `302` to `next` with a new session. A failure goes to the
  sign-in page, still headed for `next` (`/?next=<next>&auth_error=<code>`),
  or back to `<next>?auth_error=` for `reauth`, so Settings says why; with
  its state gone (a restart, another tab's sign-in), a signed-in viewer
  lands on `/settings?auth_error=expired`. The codes: `denied`
  (cancelled on GitHub), `expired` (unknown, reused, other-browser or
  10-minute-old state; a state that is not this browser's leaves its
  cookie alone), `github` (the exchange or `/user` failed), `disabled`,
  `setup`, `exists` (a first-account sign-in after one was made), `closed`
  (sign-up closed, new GitHub user), `too_many` (5 new accounts from one
  client in an hour, counted once made), `other_account` (`reauth`
  with another GitHub account: the session stays as it was). The web
  client shows a fixed message per code.
- `GET /api/profiles` → enabled accounts `{username, display_name, avatar_url}`,
  **no session needed** (the public leaderboard lists them too).
- Public profile pages, **no session needed**: `GET /api/u/:username` →
  `{username, display_name, avatar_url}`, and the usage routes below under
  `/api/u/:username/` (`404` if unknown or disabled). They are the only
  copy: the signed-in viewer reads their own page through them too.
  Nothing private has a public route: devices, account and users
  always need a session and only ever act on the signed-in user.
- Setup code attempts are throttled: 10 failures per client or 50 in
  total per 15 min → `429` with `Retry-After` (the global cap locks
  everyone out, owner included, until the window ends). Each attempt
  counts as a failure first (a parallel burst cannot slip through) and a
  right code only takes back that one attempt. The client
  (`server/lib/client.ts`) is `CF-Connecting-IP` from localhost (the quick
  tunnel or the Vite proxy); the last `X-Forwarded-For` address from a
  `TRUST_PROXY` peer (the Caddy container; earlier entries can be forged);
  else the socket address. The session cookie is `Secure` when the request
  is HTTPS (`X-Forwarded-Proto` counts only from those same proxies). An
  invalid `TRUST_PROXY` stops the server at start.
- Every `/api` request other than GET must be `Content-Type:
  application/json` (`415` otherwise) and not `Sec-Fetch-Site: cross-site`
  (`403`): a cross-site HTML form could otherwise post JSON-looking
  `text/plain` and start a sign-in for the visitor.
- The profile is GitHub's, updated at each sign-in: nothing to edit (no
  `POST /api/account`). Profile pictures are links, never uploads: every
  visitor's browser loads them (public pages, open sign-up), so only
  `https` images from GitHub, Gravatar or Imgur are kept
  (`server/lib/avatar.ts`, per-host path check, no credentials or port);
  anything else GitHub gives is dropped (initial shown). Hosts that show
  the uploader access logs would let anyone track every viewer's IP. The
  client loads them with `referrerpolicy="no-referrer"`.
  `POST /api/account/delete-activity {confirm}` (`confirm` must
  be `DELETE_ACTIVITY_PHRASE`, `"delete my activity"`, else `400`; the
  session must be under 10 minutes old, else `403 {reauth: true}`: the
  client offers "Sign in with GitHub again" (`reauth`, the same GitHub
  account only), which a stolen cookie cannot do, and comes back to
  Settings) deletes the signed-in user's `usage_events` and `quota_snapshots` in one
  transaction, keeps the deleted message ids and sets
  `activity_cleared_at` (§5) → `{ok, deleted: {events, quotas}}`. The
  account, profile, devices, keys and sessions stay.
  `POST /api/account/delete {confirm}` (`DELETE_ACCOUNT_PHRASE`,
  `"delete my account"`; same checks) deletes the account and everything
  tied to it in one transaction: usage, quotas, deleted ids, devices and
  their keys, every session, the user row (its username becomes free) →
  `{ok, deleted: {events, quotas, devices}}`. The last enabled admin gets
  `409` (checked inside the transaction): make another account admin
  first. The client then signs out.
  Both erase for real: `secure_delete` zeroes the freed pages and the WAL
  is truncated after (`erasing` in `queries.ts`; best effort: a reader
  holding an old snapshot keeps the WAL until the next checkpoint
  overwrites it); backups made before
  keep the data until pruned (`-pre-v<N>` ones until an admin deletes
  them), and the panel says so. Nobody can delete another user's activity
  or account (admins included). Both run synchronously and hold up every
  other request while they work (seconds for hundreds of thousands of
  events), and `deleted_events` keeps one id per deleted message until
  the account goes: fine for a personal instance, to bound if it ever
  serves many accounts.
- Admin only (`403` otherwise): `GET /api/users`, `POST /api/users/:id/admin {is_admin}` (grant or remove admin
  rights, never your own, so an admin always remains),
  `POST /api/users/:id/disable|enable`. A disabled account cannot sign
  in and its device keys are rejected at ingest; admins cannot disable
  themselves, so one enabled admin remains.
- Admin panel (admin only): `GET /api/admin/overview` → server-wide counts
  (accounts, disabled, live devices, events, sessions, last event).
  `GET /api/admin/settings` → `{signup_open}`, `POST /api/admin/settings
  {signup_open}` opens or closes account creation (stored in `settings`;
  open by default). Closing it never affects existing accounts.
- Rate limits (`LIMITS` in `server/lib/rate-limit.ts`, token buckets in
  memory: they reset when the server restarts). Over one → `429` with
  `Retry-After`:
  - public reads (`/api/u/…`, `/api/leaderboard`, `/api/profiles`): 300
    per client (the client address above), refill 5/s. A dashboard polls
    9 of them every 15 s, so about eight tabs fit behind one address. A
    rate-limited refresh keeps the page as it was (the web client does
    not show it as "Could not reach the server");
  - signed-in routes (`/api/devices`, `/api/account`, `/api/users`,
    `/api/admin`): 120 per user, refill 1/s;
  - at most 20 live devices per account (`POST /api/devices` → `409`;
    revoking one frees a slot);
  - starting a GitHub sign-in (`POST /api/auth/github`): 60 per client,
    refill one per 2 s (visitors behind one address, #102, still sign
    in). GitHub's callback is not limited: it only works with a state
    this server handed out, once;
  - ingest: per device key (§5). Health and the rest of `/api/auth/*` are
    not rate limited (the setup code and sign-ups have their own limits
    above).
- Public reads (`/api/u/…`, `/api/leaderboard`) are cached in memory until
  the database changes (this server's writes or the CLI's) and for 30 s at
  most (`readCache` in `server/lib/http.ts`).
- `GET /api/leaderboard?days=1..730|all` (default 30; the UI uses 7, 30 and all), **no session needed** → every enabled
  account, ranked by tokens in the period (`tokens`, `sessions`, `events`,
  `active_days`, `top_model`, `last_active` (null when idle),
  `current_streak`), plus `totals`, `accounts`, `by_model` and a 364-day
  global `activity` ending on `day`. Disabled accounts never appear.
- Usage, public, under `/api/u/:username/`:
  - `stats?days=30&tool=claude-code`
  - `activity?days=364&tool=...` (local-day buckets for the heatmap,
    the `days` days ending on the owner's today)
  - `quotas` (current window per account, tool + limit type; see §5)
  - `summary?tool=...` (`day`: the owner's today; all-time and today's
    tokens, sessions, events, each split `by_model` and `by_tool`)
  - `sessions?limit=10&offset=0&tool=...` (grouped by unique session id,
    with latest `context_used_pct` / `context_window_size`, plus `total`
    for paging)
- `GET /api/devices` (never the keys, only `key_prefix` and `has_key`;
  `collectors`: per tool it posted for, `{tool, version, seen_at, newest,
  latest, outdated}` (`version`: the lowest still posting, §4; `newest`:
  that of the last post), which Settings → Devices shows, outdated ones
  in warning color with how to update),
  `POST /api/devices {name}` (returns the key), `GET /api/devices/:id/key`
  → `{key}` (one key per request, own live devices only, `404` otherwise),
  `POST /api/devices/:id/revoke` (also forgets the key). A device is a
  machine: one key serves every tool on it (the tool comes from the ingest
  URL). Keys are stored in `devices.key` so the owner can copy them again
  (they only allow posting usage); ingest looks them up by `key_hash`.
  Keys made before that column existed are hash only: not copyable.

## 7. Testing checklist (acceptance criteria)

1. Real Claude Code, Codex, OpenCode or Antigravity activity → new tokens
   and sessions appear, no duplicates (Codex: after `codex exec`, or any
   turn once the hook is trusted; OpenCode: once a session goes idle;
   Antigravity: after a turn's hook fires).
2. Resend the same message ids (every status line refresh does) →
   `deduped`, totals unchanged; a partial then final entry counts once.
3. Two devices, same account → quota cards show the current window's value,
   not a sum, and a stale post from the other device does not lower it.
4. Server unreachable for a while → offsets do not move, the next refresh
   sends the whole backlog with original times. Killing the status line
   command (its whole process group) does not stop the detached upload.
5. Payload without `rate_limits` → quota card shows "Unavailable".
6. Payload after `resets_at` passed → new snapshot replaces the old window.
7. An event at 23:30 Europe/Paris shows on that local day; "Today" and the
   streak reset at the owner's local midnight.
8. `/demo` shows labeled fictional data, signed in or out; real profiles
   never do (`?demo=1` changes nothing).
9. `/` signed out: "Sign in with GitHub" (or the first-account screen,
   setup code then GitHub); no password field anywhere; signed in:
   redirect to `/u/<github-login>`, with GitHub's name and picture.
   `/settings` and `/admin` signed out: sign-in, then back. A new GitHub
   user gets an account (after the first one) until an admin closes
   sign-up; then new users land on `/?auth_error=closed` and existing ones
   still sign in.
10. `/u/<name>` opens without an account and shows usage only: no devices
   or account sections, for visitors and other accounts alike.
11. `/leaderboard` opens without an account and lists every enabled
    account, idle ones included; disabled ones never listed.

```bash
# manual test example
KEY=<device key>
curl -s localhost:3000/api/ingest/claude-code -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{
  "event_id":"msg_test_1","tool":"claude-code","session_id":"s1",
  "model":"claude-opus-5-5",
  "usage":{"input_tokens":100,"output_tokens":50,
    "cache_creation_input_tokens":10,"cache_read_input_tokens":20},
  "rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1999999999}},
  "occurred_at":1750000000}'
curl -s 'localhost:3000/api/u/<you>/stats?days=365' ; echo
curl -s localhost:3000/api/u/<you>/quotas ; echo
```

## 8. Testing with the user (Cloudflare tunnel) — REQUIRED

Quick tunnels are for testing sessions only; the deployed server is
reached through Caddy (§2, Deploy). After `npm start` works locally:

1. Install `cloudflared` if missing (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
2. Start the tunnel:
   ```bash
   cloudflared tunnel --url http://localhost:3000
   ```
3. Copy the public URL (`https://<random>.trycloudflare.com`).
4. **Send that link to the user for testing** and keep the tunnel running
   while they test. Mention the setup code from the server log if no
   account exists yet, and that `/demo` shows the labeled fictional
   dataset (no account needed).

Sign in with GitHub through a tunnel needs a GitHub OAuth app whose
callback is on that tunnel: keep a separate **dev OAuth app** (never the
production one) and, each time the quick tunnel's address changes, set its
Homepage URL to `https://<random>.trycloudflare.com` and its
Authorization callback URL to
`https://<random>.trycloudflare.com/api/auth/github/callback` (GitHub →
Settings → Developer settings → OAuth Apps). Its id and secret go in the
worktree's `.env` (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`); restart
`npm run dev` after editing it. The callback follows the host the browser
used (Vite passes it on), so `PUBLIC_URL` stays unset.
5. Revoke/replace device keys if a test key leaks; never put keys in URLs.

Live review (edits show up instantly for the tester): keep the Node API on
:3000 (collectors post there) and point the tunnel at the Vite dev server
instead, which proxies `/api` (and the install scripts, so the Devices
panel's commands work there) to :3000 and pushes changes over HMR:

```bash
npm run dev                         # API on :3000, restarts on server/ edits
npm run dev:web                     # UI on :5173 with HMR
cloudflared tunnel --url http://localhost:5173
```

`web/vite.config.ts` allows `*.trycloudflare.com` hosts and limits what the
dev server can read to `web/`, `shared/` and `node_modules/`, so `data/`
(the SQLite DB) and `.env` are never served through the tunnel.

## 9. Roadmap (later, not now)

- Codex: account-level usage from the App Server (`account/usage/read`)
  if it ever reports something the rollouts do not.
- OpenCode: billing mode per session (BYOK vs OpenCode's own), once it
  can be told apart without guessing; a quota only if a provider exposes
  one.
