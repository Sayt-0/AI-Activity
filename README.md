# AI Activity

> **Not affiliated.** AI Activity is an independent, unofficial project. It
> is not affiliated with, endorsed or sponsored by Anthropic, OpenAI, Google or the
> OpenCode project. Claude, Claude Code, Codex, Antigravity, OpenCode and the other
> product names used here are trademarks of their respective owners, named
> only to identify the tools whose usage the dashboard measures. It reads
> the files these tools already write on your own device; it does not call
> their APIs on your behalf or work around their limits. Using those tools
> stays subject to their own terms.

## Friends

Sign in and open **Friends** from the avatar menu to see the people you
follow on GitHub who also have an enabled AI Activity profile. Each entry
links to that public profile and shows measured tokens, conversations and
last activity for the past seven days. The server reads GitHub's public
following list without requesting an OAuth scope or keeping a GitHub token.
If GitHub is unavailable, the page offers a retry.

## One-command install

Create a device key (**Settings → Devices**),
then on that machine, as the user who runs the tools (no `sudo`, no
administrator shell):

```sh
# Linux, macOS
curl -fsSL <server>/install.sh | AI_ACTIVITY_URL=<server> AI_ACTIVITY_KEY=<device key> sh
```

```powershell
# Windows (PowerShell)
$env:AI_ACTIVITY_URL="<server>"; $env:AI_ACTIVITY_KEY="<device key>"; irm <server>/install.ps1 | iex
```

**Copy install (Linux/macOS)** and **Copy install (Windows)** in Settings →
Devices copy them with the key filled in (your profile links there, under
the tools). The key is passed in the environment, never in a URL, and ends
up only in the installed collectors (files readable by you alone on
Linux/macOS). Both scripts need Python 3 (`python3`; on Windows `python`
or the `py` launcher) and install the collectors of the tools they find
(`claude` / `codex` / `agy` / `opencode` on the `PATH`, or their config
folders), as the sections below describe:

- Claude Code: `~/.claude/ai-activity-claude-code.py` and the `statusLine`
  in `~/.claude/settings.json`. Another status line already set is left
  alone (`AI_ACTIVITY_FORCE=1` replaces it: Claude Code runs only one).
- Codex: `~/.codex/ai-activity-codex.py` and its three hooks in
  `~/.codex/hooks.json`, next to your other hooks. Review them once with
  `/hooks`.
- Antigravity: `~/.gemini/ai-activity-antigravity.py` and the named
  `ai-activity` hook in `~/.gemini/config/hooks.json`. Restart it and check
  the hook is enabled. Quotas stay off (`AI_ACTIVITY_ANTIGRAVITY_QUOTAS`).
- OpenCode: the collector and plugin in `~/.config/opencode`. Restart it.

On Linux/macOS the commands are the ones below (`python3 ~/…`; on macOS,
which has no `setsid`, Codex runs the script with `--hook`). On Windows they
name the absolute path of the Python that ran the installer, so the tools
find it whatever their `PATH` (OpenCode's plugin still runs `python`).

Other entries of those files are kept, and a file that is a symlink (a
dotfiles repo) stays one: its target is updated. If one of them is not
valid JSON, nothing is installed until it is fixed.
`AI_ACTIVITY_TOOLS=claude-code,codex`
(`$env:AI_ACTIVITY_TOOLS=…` on Windows) picks the tools instead. Running it
again only updates what changed (a new key or server URL, a newer
collector), never duplicates a hook. It checks that the server takes the
key first, refuses a `<server>` that redirects (use the address it
redirects to, e.g. `https://`: the collectors do not follow redirects), and
refuses to run as root unless `AI_ACTIVITY_ALLOW_ROOT=1`.

## Send Claude Code usage from a device

1. Create a device key in the dashboard, **Settings → Devices** (one key per machine, it serves
   every tool on it; **Copy key** there gives it back any time).
2. Copy `collectors/claude-code.py` to `~/.claude/ai-activity-claude-code.py`
   on the device and replace `<server>` (e.g. `http://localhost:3000` or
   your tunnel URL) and `<device key>` at its top (or set
   `AI_ACTIVITY_URL` / `AI_ACTIVITY_KEY` in the environment Claude Code runs
   in).
3. Add this to `~/.claude/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "python3 ~/.claude/ai-activity-claude-code.py"
}
```

On Windows, use this instead, replacing `<user>` with your Windows user
directory name (backslashes and quotes are already JSON-escaped):

```json
"statusLine": {
  "type": "command",
  "command": "python \"C:\\Users\\<user>\\.claude\\ai-activity-claude-code.py\""
}
```

It needs Python 3 (standard library only) and runs as your user: no root,
nothing printed in the status line. Use the absolute path of the
interpreter if it is not on Claude Code's PATH (`python3 -c 'import sys;
print(sys.executable)'`, or `python -c "import sys; print(sys.executable)"`
on Windows, JSON-escaped like the script path).

Replacing the former one-liner (`setsid -f python3 -c "…"`): swap its
`statusLine` command for this one. Its first refresh sends every
transcript again (the one-liner's offsets did not say which server they
were for); the server stores each message id once, so nothing is counted
twice or missed.

What it does on every status line refresh:

- Reads what was added to every transcript under `~/.claude/projects`
  (sessions and subagents, all projects) since the last successful upload,
  and sends **one entry per Anthropic message id** with its token counts.
  Prompts and replies never leave the device, only ids, model, time (with
  the device's UTC offset at that time) and counts.
- The first refresh therefore sends every transcript still on disk (Claude
  Code keeps about 30 days by default): that is the import of past
  sessions. It also replaces the rows the old snapshot collector sent for
  those sessions, which counted most API calls twice.
- How far each file was sent is kept in `~/.cache/ai-activity/offsets.json`,
  per server and device key, and only moves forward once the server
  accepted everything, so nothing is lost while the server is down: the
  next refresh sends the backlog. A new server or key starts from nothing,
  so its first refresh sends the whole history. Delete that file to send
  everything again (safe: the server stores each message id once).
- The server stores each message id once. Claude Code sometimes writes a
  partial entry (a few output tokens) before the final one; the final
  counts replace it.
- The script answers at once and starts the upload detached (its own
  session on Linux/macOS; on Windows out of the console, the process group
  and, when Windows permits it, the parent job). Claude Code cancels a
  status line command when the next refresh comes; the upload keeps
  running. Uploads wait for each other (a lock in `~/.cache/ai-activity`)
  and give up after 15 minutes.
- Also sends the 5-hour and 7-day quotas and the context fill.

**Days are local, like GitHub's contribution calendar.** Each entry carries
the device's UTC offset when it happened (daylight saving included), and
counts on that local day for every visitor: it never moves afterwards,
even if you travel. "Today" and the streak end on the day it is at the
offset of your latest entry. Entries sent before collectors had offsets
count as UTC days; delete `~/.cache/ai-activity/offsets.json` (and
`codex.json`, `opencode.json`) once to resend the history with offsets: nothing is counted
twice, the server only adds the missing offsets.

The tool is part of the URL (`/api/ingest/claude-code`, `/api/ingest/codex`,
`/api/ingest/opencode`, `/api/ingest/antigravity`);
a bare `/api/ingest` answers `404`. See `AGENTS.md` §5 for the payload contract.

## Send Codex usage from a device

1. Create a device key as above (the same key can serve both tools).
2. Copy `collectors/codex.py` to `~/.codex/ai-activity-codex.py` on the
   device and replace `<server>` and `<device key>` at its top (or set
   `AI_ACTIVITY_URL` / `AI_ACTIVITY_KEY` in the environment Codex runs in).
3. Add the hooks to `~/.codex/hooks.json` (the same command three times):

`~/.codex/hooks.json`:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "setsid -f python3 ~/.codex/ai-activity-codex.py >/dev/null 2>&1 </dev/null; echo '{}'", "timeout": 10 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "setsid -f python3 ~/.codex/ai-activity-codex.py >/dev/null 2>&1 </dev/null; echo '{}'", "timeout": 10 }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "setsid -f python3 ~/.codex/ai-activity-codex.py >/dev/null 2>&1 </dev/null; echo '{}'", "timeout": 10 }] }
    ]
  }
}
```

On Windows, use this instead, replacing `<user>` with your Windows user
directory name (`--hook` answers Codex and starts the upload detached).
These commands target PowerShell: `&` is its call operator and is required
before a quoted executable path. If Python is not on Codex's PATH, replace
`python` with its quoted absolute path, JSON-escaped as shown below:

`%USERPROFILE%\.codex\hooks.json`:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "& python \"C:\\Users\\<user>\\.codex\\ai-activity-codex.py\" --hook", "timeout": 10 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "& python \"C:\\Users\\<user>\\.codex\\ai-activity-codex.py\" --hook", "timeout": 10 }] }
    ],
    "PostToolUse": [
      { "hooks": [{ "type": "command", "command": "& python \"C:\\Users\\<user>\\.codex\\ai-activity-codex.py\" --hook", "timeout": 10 }] }
    ]
  }
}
```

For example, a Python installation with spaces in its path uses this JSON
command for each of the three hooks:

```json
{ "command": "& \"C:\\Program Files\\Python312\\python.exe\" \"C:\\Users\\<user>\\.codex\\ai-activity-codex.py\" --hook" }
```

Use paths that exist on your device. The equivalent command entered directly
in PowerShell is:

```powershell
& "C:\Program Files\Python312\python.exe" "C:\Users\<user>\.codex\ai-activity-codex.py" --hook
```

If your hook runner uses `cmd.exe`, omit `&`; it is PowerShell syntax.
Claude Code's Windows statusLine above runs through Git Bash and keeps its
existing command.

Codex asks you to review a new hook once (`/hooks`) before running it.

### Windows troubleshooting

Repeated `hook exited with code 1` errors can mean PowerShell rejected a
quoted executable path before Python ran. Check the call operator and JSON
escaping above; a successful `--hook` invocation returns exit code 0 and `{}`.
Re-run the one-command installer to update all three AI Activity Codex hooks;
it preserves your other hooks.

If hooks succeed but console windows still flash, Codex CLI's shared
background server can be responsible. The following workaround stopped the
flashes in the Windows setup reported in [AI Activity #173](https://github.com/LouisMoretti/AI-Activity/issues/173):

```powershell
codex --no-daemon
# To resume a session:
codex --no-daemon resume
```

This runs the CLI session without the shared background server. Keep the
collector hooks enabled: automatic uploads, historical imports and archived
sessions continue to work. Check `codex --help` for `--no-daemon` in your
installed version. This is a CLI workaround, not a guaranteed fix for every
source of console flashes or for the desktop app. Switching to `pythonw.exe`
alone did not eliminate the flashes in that setup. Upstream reports:
[openai/codex #48422](https://github.com/openai/codex/issues/48422) and
[openai/codex #48074](https://github.com/openai/codex/issues/48074).

When you update `~/.codex/hooks.json`, re-copy `collectors/codex.py` to
`~/.codex/ai-activity-codex.py` at the same time: an older script blocks on
`codex.lock`, so the frequent `PostToolUse` runs would pile up behind it.

What it does after every tool call and at the end of every turn:

- Reads what was added to every rollout under `~/.codex/sessions` and
  `~/.codex/archived_sessions` since the last successful upload. Every
  Codex front end writes those files (CLI, `codex exec`, the IDE extension
  and the desktop app), so tasks started anywhere are counted, including
  ones already in progress when the hook was added.
- Sends **one entry per model response** (`token_usage_record`, keyed by
  its `resp_…` id) with its token counts, model and the machine's UTC
  offset at that time. Rollouts from Codex
  versions without those records are read from their `token_count` lines,
  one per response, keyed by the thread's running total so a repeated line
  counts once. Prompts, replies and tool output never leave the device.
- The first run sends every rollout still on disk: that is the import of
  past sessions.
- Also sends the 5-hour and weekly rate limits and the context fill Codex
  recorded with each response, dated when Codex measured them. A limit
  snapshot written without token counts (e.g. when a turn failed) is sent
  too, so an exhausted quota still records its final value.
- The `Stop` hook does not fire when Codex stops on a rate limit (upstream
  Codex bug), which would leave that final snapshot unsent: the
  `UserPromptSubmit` hook runs the same script on your next prompt and picks
  it up. If Codex is driven without prompts (`codex exec`), run the script
  by hand or from cron after hitting a limit instead.
- How far each file was sent is kept in `~/.cache/ai-activity/codex.json`,
  per server and device key (a new one gets the whole history), and only
  moves forward once the server accepted everything, so nothing
  is lost while the server is down (no separate spool needed): the next
  turn sends the backlog with its original times. Delete that file to send
  everything again (safe: the server stores each response once).
- `PostToolUse` sends a long turn's usage while it runs (Codex writes each
  response to the rollout as it comes), so the dashboard follows the turn
  instead of catching up at its end. A reply without any tool call waits
  for `Stop`.
- `setsid -f` detaches the upload so Codex goes on at once; `echo '{}'` is
  the (empty) JSON answer Codex expects from a hook. One run at a time,
  with at most one waiting behind it (it reads the rollouts once its turn
  comes, so any other run can stop at once); a run gives up after 15
  minutes. The script is idempotent: it can
  also run by hand or from cron.

## Send Antigravity usage from a device

1. Create a device key as above (the same key serves every tool).
2. Copy `collectors/antigravity.py` to `~/.gemini/ai-activity-antigravity.py`.
   Replace `<server>` and `<device key>` at its top, or set `AI_ACTIVITY_URL`
   and `AI_ACTIVITY_KEY` in the environment Antigravity runs in. Python 3
   with the standard-library SQLite module is required.
3. Merge this named hook into `~/.gemini/config/hooks.json` (keep existing
   hooks). For Linux/macOS:

```json
{
  "ai-activity": {
    "enabled": true,
    "PostInvocation": [
      {
        "type": "command",
        "command": "python3 ~/.gemini/ai-activity-antigravity.py --post-invocation",
        "timeout": 10
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "python3 ~/.gemini/ai-activity-antigravity.py --hook",
        "timeout": 10
      }
    ]
  }
}
```

For Windows, use this instead, replacing `<user>` with your Windows user
directory name. Backslashes and quotes below are already JSON-escaped:

```json
{
  "ai-activity": {
    "enabled": true,
    "PostInvocation": [
      {
        "type": "command",
        "command": "python \"C:\\Users\\<user>\\.gemini\\ai-activity-antigravity.py\" --post-invocation",
        "timeout": 10
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "python \"C:\\Users\\<user>\\.gemini\\ai-activity-antigravity.py\" --hook",
        "timeout": 10
      }
    ]
  }
}
```

Use **absolute paths to both Python and the collector** if Python is not
on Antigravity's PATH (desktop apps can inherit a different PATH from your
terminal). Find the interpreter with `python3 -c 'import sys; print(sys.executable)'`
on Linux/macOS, or `python -c "import sys; print(sys.executable)"` on Windows.
Quote paths containing spaces; on Windows JSON-escape the interpreter path
in the same way as the collector path. Configure the URL/key in the copied
script if Antigravity does not inherit your terminal's environment; use a
stable server URL for ongoing collection. Keep the device key out of the
hook command and never commit the configured copy.

The [Antigravity hook configuration](https://antigravity.google/docs/hooks/)
is shared by Antigravity 2.0, CLI, and IDE. `PostInvocation` refreshes after
each model invocation during a turn; `Stop` refreshes when the execution
loop ends. Both return immediately and launch a detached collector, which
waits two seconds for metadata to flush after acquiring the collection lock.
At most one hook worker collects and one waits; additional
hooks coalesce into that waiting pass, which reads a fresh snapshot. A hook
during collection can queue the next pass, so the final Stop update is included.
Only one uploads at a time. The quota probe runs after the collection lock
is released, so a queued worker never waits for it. Updates need no manual
command after setup, while Antigravity is running and these hooks are enabled.

4. Restart Antigravity, then confirm **ai-activity is enabled**: `/hooks`
   in CLI, **Settings → Customizations → Hooks** in Antigravity 2.0, or
   **… → Customizations → Hooks** in the IDE agent side panel.
5. Run the copied script **without either hook flag** once to import history
   and see diagnostics. Exit code 0 means supported entries were processed;
   warnings can still indicate skipped unsupported rows or databases, or an
   unavailable quota report (with its reason). Exit code 1 means a busy
   database or an upload failure; fix it and run again.
6. Complete a new Antigravity turn and leave the dashboard open. Its existing
   15-second refresh should show supported persisted usage after collection.
   If it does not, check the hook is loaded, Python and script paths resolve
   in Antigravity, the configured URL/key are correct, and a manual run works.
   Unsupported database formats may still produce no usage; see below.

For retries while Antigravity is idle, or a version that persists metadata
later than its hooks run, you can additionally schedule the script without
hook flags every minute (cron on Linux/macOS or Task Scheduler on Windows).
Use the same user, configured script, and absolute interpreter/script paths;
on Windows set the task not to start another instance if already running.
Hooks and scheduled runs share checkpoints and safely deduplicate uploads.
On Windows, workers detach from the console and create a new process group.
They also break away from the parent job when Windows permits it; jobs that
forbid breakaway fall back to console/group detachment. If the host kills its
entire job, use the scheduled retry above to cover that restriction.

What it does:

- Reads existing SQLite databases only under
  `~/.gemini/{antigravity,antigravity-cli,antigravity-ide}/conversations/`. `GEMINI_CLI_HOME` can replace `~/.gemini`.
  Support depends on a database containing the recognized `gen_metadata`
  table; encrypted/legacy conversation files and transcript-only versions
  are not supported.
- Selects generation metadata and, when needed, step metadata from a
  read-only snapshot. Never selects conversation text, prompts, responses,
  tool output, workspace paths, or authentication data.
- Sends ids, recorded model (unknown stays unknown), token counts, the
  original generation timestamp, and this machine's UTC offset at that
  time. Input includes recorded system and new input; cached input is
  separate; text and thinking output are added once. Subagent databases
  count as separate conversations because parent attribution is unavailable.
- Imports supported history, then skips every database whose stamp is
  unchanged since all of it was accepted. The stamp covers the database and
  its WAL: mtime, size, ctime, inode, the database header's change counter
  and the WAL header's salts. A changed database is read again in full (edits
  to older rows included), but only new responses, or ones with more output
  tokens, are sent. Checkpoints in `~/.cache/ai-activity/antigravity.json`
  hold, per server and device key and per conversation (hashed path), that stamp and the output tokens
  accepted per response id; a batch is recorded only once accepted, and
  deleted conversations are forgotten. A malformed checkpoint file starts
  over (the server deduplicates the replay); removing it replays history
  too. Switching server or device key automatically starts a new import.
- A busy (locked) database fails the run and is read again next time. Any
  other unreadable or unsupported database (not SQLite, another layout, a
  WAL database whose `-shm` file cannot be created) is skipped with a
  warning until its stamp changes.
- Unconfigured URL/key placeholders exit before reading history. The first
  HTTP/network failure on a usage upload stops the pass, including quota
  probing. HTTP 429/503 honor `Retry-After` (seconds or HTTP date; bounded
  to one day, with a one-minute fallback). Device keys are never forwarded
  through redirects.
- A generation without its own timestamp takes its step's, streamed from
  the same snapshot, only when its step/bot key belongs to one response;
  otherwise it is skipped with a warning, never dated by import time.
  Metadata blobs over 1 MiB are skipped.
- **Quotas are off by default.** With `AI_ACTIVITY_ANTIGRAVITY_QUOTAS=1` in
  the environment the hooks run in, it collects measured five-hour and weekly
  quota snapshots using the signed-in Antigravity CLI's `/usage` JSON report.
  That runs `agy` automatically, and each probe reaches Google's backend.
  [Antigravity's terms](https://antigravity.google/terms) forbid using
  third-party tools to access the service and allow suspending the account;
  the probe uses Google's own CLI and sign-in, but enable it at your own
  risk. Without it the card shows **Unavailable** quotas. Install **agy 1.1.11 or later**, sign
  in with the same Google account you use in Antigravity, and make `agy`
  available on the collector's PATH (including hooks and scheduled tasks).
  Verify `agy --version` (its output must contain the version) and
  `agy -p /usage --output-format json --print-timeout 90s` in a terminal.
  The CLI handles its own authentication; the collector never reads
  provider credential files. Desktop/IDE history still imports without the
  CLI; a missing CLI, an old or unrecognized version, a failed probe or an
  unsupported report leave quota windows **Unavailable**, with a diagnostic
  naming which. A window `agy` reports untouched (100% left, resetting a full
  window length from now, or no reset time) has not started yet: it stays
  **Unavailable** rather than showing 0%.
- Quotas refresh on hooks/manual/scheduled runs, at most once per minute
  after a successful upload, including runs with no new token activity.
  Failed probes or uploads back off for five minutes (or the server's
  `Retry-After`), in `~/.cache/ai-activity/antigravity-quota.json`, apart
  from usage uploads: a refused quota upload never delays token imports.
  Attempts are saved before probing, so interruption cannot reset the
  throttle. Token collection finishes first; the probe then runs outside
  the collection lock, under its own lock, and a run that finds another
  probe in progress skips its own.
  Use the optional one-minute schedule above for updates while idle. Gemini
  and Claude/GPT pools remain separate: the card uses the same percentage
  bars, elapsed-window marks, reset countdowns and expiry behavior as Codex
  and Claude Code. Percentages are used quota, never inferred from tokens.
  Missing/disabled buckets stay unavailable; after reset, the old value
  stays unavailable until a fresh snapshot arrives. Free plans may expose
  only a weekly quota. Context fill remains unavailable.
  To preview the card, open `/demo` on your server (no account needed).
  That **Demonstration data** page includes fictional Antigravity
  quotas, activity and conversations; it never writes them to the server.
- The quota subprocess runs `/usage` in an empty temporary directory,
  without the Activity URL/key, and cannot recursively trigger this
  collector's hooks. Versions older than 1.1.11 or an unrecognized version
  never receive `/usage`, since older print modes may treat it as a prompt.
  Leave `AI_ACTIVITY_ANTIGRAVITY_QUOTAS` unset (or anything but `1`) to keep
  quota probing off.

Quota command/schema evidence comes from [CodexBar's Antigravity implementation](https://github.com/steipete/CodexBar/tree/main/Sources/CodexBarCore/Providers/Antigravity).
Google documents [the quota command](https://antigravity.google/docs/cli/commands/usage)
and [plan windows](https://antigravity.google/docs/plans/). Quota tests run
the collector against a fake `agy` with synthetic reports.

**Format limitations:** Antigravity's persisted protobuf layout is
undocumented. The parser follows [independently observed field evidence](https://github.com/junhoyeo/tokscale/blob/62ca1eb1677556972ba963fdfa3a41ab23c1eb4b/crates/tokscale-core/src/sessions/antigravity_cli.rs).
It accepts standard protobuf generation timestamps, or a unique matching
step UUID and bot id with a standard step timestamp. Unknown timestamp
layouts, missing response ids, corrupt records, and ambiguous step matches
are skipped with a diagnostic, and read again only when their database
changes. They are never assigned the database modification time or import
time, so totals may be incomplete on unsupported versions. Automated tests
use synthetic SQLite/protobuf fixtures.

## Send OpenCode usage from a device

1. Create a device key as above (the same key serves every tool).
2. Copy `collectors/opencode.py` to `~/.config/opencode/ai-activity-opencode.py`
   and replace `<server>` and `<device key>` at its top (or set
   `AI_ACTIVITY_URL` / `AI_ACTIVITY_KEY` in the environment OpenCode runs in).
3. Copy `collectors/opencode-plugin.js` to
   `~/.config/opencode/plugins/ai-activity.js`. OpenCode loads it at start.

On Windows, `~` is your user directory (`C:\Users\<user>`), for OpenCode's
folders too, and the plugin runs `python` instead of `python3`: it must be
on OpenCode's PATH.

What it does:

- The plugin runs the collector, detached, when OpenCode starts and
  whenever a session goes idle (one run at a time).
- The collector reads OpenCode's own database
  (`~/.local/share/opencode/opencode.db`, read-only) and sends **one entry
  per assistant message** (keyed by its `msg_…` id) with its token counts,
  provider and model (stored as `provider/model`) and the machine's UTC
  offset at that time. It selects numeric fields only: prompts, replies,
  tool output, titles and paths are never read.
- Subagent sessions are sent as their root session, so a conversation
  with subagents counts once.
- OpenCode counts reasoning apart from output; it is added to output, like
  OpenCode's own totals, never twice.
- The first run sends the whole database: that is the import of past
  sessions.
- No 5-hour or weekly limit: OpenCode has none of its own, so the card
  shows the active conversations and today's usage instead.
- How far the database was sent is kept in
  `~/.cache/ai-activity/opencode.json`, per server and device key (a new
  one gets the whole history), and only moves forward once the
  server accepted a batch, so nothing is lost while the server is down (the
  database is the queue). Delete that file to send everything again (safe:
  the server stores each message once). The script is idempotent: it can
  also run by hand or from cron.

## How the collector scripts work

Each tool has one Python script in `collectors/`. They share the same design:

- **One file, standard library only.** Copy it next to the tool, set
  `<server>` and `<device key>` at its top, or `AI_ACTIVITY_URL` /
  `AI_ACTIVITY_KEY` in the tool's environment (the environment wins). Linux,
  macOS and Windows alike (`python3` or `python`).
- **Metrics only.** They read the tool's local files read-only and send ids,
  model, time, the machine's UTC offset and token counts (plus quotas and
  context fill where the tool has them). Prompts, replies, tool output,
  titles, paths and provider keys never leave the device.
- **The key only goes to your server.** Uploads never follow an HTTP
  redirect: a redirect fails the run (progress unchanged) instead of
  sending the device key somewhere else.
- **Progress only moves on success.** How far each source was sent is kept
  in a JSON file under `~/.cache/ai-activity/`, saved once the server
  accepted it. While the server is down nothing moves: the next run sends
  the backlog with its original times. Delete the file to send everything
  again; the server stores each message once, and a message seen again with
  more output tokens replaces its partial counts.
- **Progress is per server and key.** The progress file keeps one set of
  offsets per server URL and device key (`{"targets": {"<fingerprint>":
  …}}`; the fingerprint is the first 16 hex digits of the SHA-256 of both,
  never the key itself), for the 8 most recently used. Point a device at a
  new server, or give it a new key, and its next run sends the whole local
  history there; switch back and it resumes where it was. With a new key
  on the same account, everything comes back as already stored. With
  another account on the same server, messages the first account already
  sent stay with it (the server never moves them between accounts).
- **Never in the tool's way.** Called from a hook or the status line, a
  script answers at once and uploads from a detached copy of itself
  (Linux/macOS: its own session; Windows: out of the console, the process
  group and, when permitted, the parent job). A failure prints one line on
  stderr and exits 1; the tool is never blocked, and the next run retries.
- **One upload at a time.** A lock file in `~/.cache/ai-activity/`
  (`flock`; on Windows `msvcrt` on its first byte) serializes runs. Where
  hooks fire often (Codex, Antigravity), one more run may wait behind the
  active one and any other exits at once: the waiter reads the sources only
  once its turn comes, so it sends what they would have.
- **Idempotent.** Any script can also run by hand or from cron
  (Task Scheduler on Windows): it sends only what is new.
- **Versioned.** Each script has a `VERSION` at its top and sends it with
  every upload. When the server has a newer one, the script says so on
  stderr and in `~/.cache/ai-activity/update-available-<tool>` (removed
  once up to date), and Settings → Devices flags that device's collector
  as outdated. To update, run the device's install command again (or copy
  the new script by hand). The server never sends code: updates are
  always yours to run. A collector too old for the server (`426`) keeps
  its backlog, which goes out once it is updated.

| Script | Copy to | Run by | Reads | Progress file | Locks |
| --- | --- | --- | --- | --- | --- |
| `claude-code.py` | `~/.claude/ai-activity-claude-code.py` | the statusLine, every refresh | `~/.claude/projects/**/*.jsonl` (sessions and subagents) | `offsets.json` (byte offset per transcript) | `lock` |
| `codex.py` | `~/.codex/ai-activity-codex.py` | the `Stop`, `UserPromptSubmit` and `PostToolUse` hooks | `~/.codex/sessions`, `~/.codex/archived_sessions` (`CODEX_HOME`) | `codex.json` (byte offset per rollout) | `codex.lock`, `codex-waiter.lock` |
| `opencode.py` | `~/.config/opencode/ai-activity-opencode.py` | `opencode-plugin.js`, at start and on `session.idle` | `~/.local/share/opencode/opencode.db` (`XDG_DATA_HOME`, `OPENCODE_DB`), numeric fields only | `opencode.json` (last `time_updated` sent) | `opencode.lock` |
| `antigravity.py` | `~/.gemini/ai-activity-antigravity.py` | the `PostInvocation` and `Stop` hooks | `~/.gemini/{antigravity,antigravity-cli,antigravity-ide}/conversations/*.db` (`GEMINI_CLI_HOME`); quotas from `agy`, opt-in | `antigravity.json` (per database), `antigravity-quota.json` | `antigravity.lock`, `antigravity-waiter.lock`, `antigravity-quota.lock` |

How each one is started:

- `claude-code.py`: without arguments (the statusLine), reads the status
  line's JSON on stdin, starts `claude-code.py --worker` detached with that
  JSON, and prints nothing. `--worker` collects in the foreground: run
  `python3 ~/.claude/ai-activity-claude-code.py --worker </dev/null` (on
  Windows, `python "<path>" --worker <NUL` in cmd) to see errors while
  setting up.
- `codex.py`: without arguments, collects in the foreground (by hand, cron,
  and the Linux/macOS hooks, which detach it with `setsid -f`). `--hook`
  (the Windows hooks) prints `{}` for Codex and starts the script again
  detached.
- `opencode.py`: without arguments, collects in the foreground; the plugin
  starts it detached, one run at a time.
- `antigravity.py`: without arguments, collects in the foreground and
  prints diagnostics (skipped rows or databases, quota availability).
  `--post-invocation` and `--hook` answer the hook (`{}`, or
  `{"decision":"stop"}` for `Stop`) and start a detached worker, which
  waits 2 seconds for Antigravity to write its metadata.

Claude Code, Codex and OpenCode runs give up after 15 minutes (the progress
already accepted is kept). The payloads each script sends are described in
`AGENTS.md` §5.
