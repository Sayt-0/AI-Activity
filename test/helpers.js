// Black-box harness: boots the real server on a random port with a temp DB,
// so these tests survive internal rewrites (routing, framework, modules).
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { COLLECTOR_VERSIONS } from "../shared/collectors.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SERVER_ENTRY = path.join(ROOT, "server", "index.ts");

/** Session cookie used by req() when the call passes none (see startServer). */
const defaultCookies = new Map();
/** The first account of a test server: GitHub login "admin" (see githubUser). */
export const TEST_ADMIN = { username: "admin" };

/**
 * A fake GitHub for the whole test process (OAuth token endpoint, /user,
 * /users/<login>): servers get it as GITHUB_URL / GITHUB_API_URL. Users
 * are made up on first use (githubUser); a code signs one of them in.
 */
const github = { users: new Map(), follows: new Map(), codes: new Map(), requests: [], nextId: 1000, server: null, base: "" };

/** Fake public following list. Pass null to simulate GitHub being unavailable. */
export function githubFollowing(login, followed) {
  github.follows.set(login.toLowerCase(), followed);
}

/** The fake GitHub account with that login (made up on first use, or changed by `over`). */
export function githubUser(login, over = {}) {
  const key = login.toLowerCase();
  const user = github.users.get(key) ?? {
    // Like many GitHub accounts: no name (the username is shown) and, here,
    // no picture unless a test gives one.
    id: github.nextId++, login, name: null, avatar_url: null,
  };
  Object.assign(user, over);
  github.users.set(key, user);
  return user;
}

/** Renames a fake GitHub account (same id), like a GitHub login rename. */
export function renameGithubUser(login, to) {
  const user = github.users.get(login.toLowerCase());
  github.users.delete(login.toLowerCase());
  user.login = to;
  github.users.set(to.toLowerCase(), user);
  return user;
}

/** A one-time OAuth code the fake GitHub turns into that user's token. */
export async function githubCode(login) {
  await fakeGithub();
  githubUser(login);
  const code = `code-${Math.random().toString(36).slice(2)}`;
  github.codes.set(code, login.toLowerCase());
  return code;
}

/** Token exchanges the fake GitHub received (what the server sent it). */
export const githubRequests = () => github.requests;

export async function fakeGithub() {
  if (github.server) return github.base;
  github.server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const url = new URL(request.url, "http://x");
    const send = (status, json) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(json));
    };
    if (request.method === "POST" && url.pathname === "/login/oauth/access_token") {
      const b = JSON.parse(body || "{}");
      github.requests.push(b);
      const login = github.codes.get(b.code);
      github.codes.delete(b.code); // codes work once, like GitHub's
      if (!login || b.client_secret !== "test-secret") return send(200, { error: "bad_verification_code" });
      return send(200, { access_token: `token-${login}`, token_type: "bearer", scope: "" });
    }
    if (url.pathname === "/user") {
      const login = (request.headers.authorization ?? "").replace(/^Bearer token-/, "");
      const user = github.users.get(login.toLowerCase());
      return user ? send(200, user) : send(401, { message: "Bad credentials" });
    }
    const byLogin = url.pathname.match(/^\/users\/([^/]+)$/);
    if (byLogin) {
      const user = github.users.get(decodeURIComponent(byLogin[1]).toLowerCase());
      return user ? send(200, user) : send(404, { message: "Not Found" });
    }
    const following = url.pathname.match(/^\/users\/([^/]+)\/following$/);
    if (following) {
      const login = decodeURIComponent(following[1]).toLowerCase();
      const follows = github.follows.has(login) ? github.follows.get(login) : [];
      if (follows === null) return send(503, { message: "Unavailable" });
      const page = Number(url.searchParams.get("page") || 1);
      return send(200, follows.slice((page - 1) * 100, page * 100).map((name) => githubUser(name)));
    }
    send(404, { message: "Not Found" });
  });
  await new Promise((resolve) => github.server.listen(0, "127.0.0.1", resolve));
  github.server.unref(); // never keeps a test process alive
  github.base = `http://127.0.0.1:${github.server.address().port}`;
  return github.base;
}

/** Server environment for Sign in with GitHub against the fake GitHub. */
export async function githubEnv() {
  const base = await fakeGithub();
  return { GITHUB_CLIENT_ID: "test-client", GITHUB_CLIENT_SECRET: "test-secret", GITHUB_URL: base, GITHUB_API_URL: base };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/**
 * Boot the server on a temp DB, with Sign in with GitHub against the fake
 * GitHub. By default the first account (GitHub "admin", an admin) is made
 * like on a real server, with the setup code, and signed in: req() uses
 * that session by default (pass `anon: true` for an anonymous call).
 * `signedIn: false` makes it without keeping the session; `autoLogin:
 * false` boots with no account at all.
 */
export async function startServer({ signedIn = true, env = {}, autoLogin = true } = {}) {
  env = { ...(await githubEnv()), ...env };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-test-"));
  const dbPath = env.DB_PATH ?? path.join(dir, "t.db");
  try {
    // node --test runs test files in parallel: another file can bind a freed
    // port between freePort() and listen(), so retry once with a fresh port.
    for (let attempt = 0; ; attempt++) {
      try {
        return await bootServer({ dir, dbPath, env, admin: autoLogin, auto: autoLogin && signedIn });
      } catch (e) {
        if (attempt >= 1 || !/EADDRINUSE/.test(String(e && e.message))) throw e;
      }
    }
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

async function bootServer({ dir, dbPath, env, admin, auto }) {
  const port = await freePort();
  const proc = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  proc.stderr.on("data", (c) => (stderr += c));
  proc.stdout.on("data", (c) => (stdout += c));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      // Only once this server logged its own listen: if another test's
      // server took the port, that one answers /api/health too.
      if (stdout.includes("listening on") && (await fetch(`${base}/api/health`)).ok) break;
    } catch { /* not up yet */ }
    if (proc.exitCode !== null) throw new Error(`server exited: ${stderr}`);
    // The pass path returns as soon as /api/health is OK; the cap only
    // bounds the failure case (type-stripping + migrations on a loaded
    // ARM64 runner, with every test file booting at once).
    if (i >= 600) {
      proc.kill();
      throw new Error(`server not healthy after 30 s: ${stderr || stdout}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (admin) {
    // The first account: the setup code from this server's log, then GitHub.
    const setup_code = stdout.match(/Setup code: (\S+)/)?.[1];
    const first = setup_code ? await githubSignIn(base, TEST_ADMIN.username, { setup_code }) : null;
    if (setup_code && !first.cookie) throw new Error(`first account failed: ${first.start.status} → ${first.location}`);
    if (auto) defaultCookies.set(base, first?.cookie ?? await login(base, TEST_ADMIN.username));
  }
  return {
    base,
    dbPath,
    /** The one-time setup code the server printed, or null. */
    setupCode: () => stdout.match(/Setup code: (\S+)/)?.[1] ?? null,
    /** Sends SIGTERM and resolves with the exit code once the server is gone. */
    async kill() {
      // Ports are reused: forget the session, or a later server on this
      // port would receive the previous server's cookie.
      defaultCookies.delete(base);
      if (proc.exitCode !== null || proc.signalCode !== null) return proc.exitCode;
      proc.kill();
      return new Promise((r) => proc.once("exit", (code) => r(code)));
    },
    async stop() {
      await this.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** type: content-type to send (default application/json on anything but GET; null sends none). It overrides a content-type in `headers`. */
export async function req(base, method, p, { body, key, cookie, raw, anon = false, type, headers: extra = {} } = {}) {
  if (cookie === undefined && !anon) cookie = defaultCookies.get(base);
  const headers = { ...extra };
  if (type === undefined) type = method === "GET" ? null : "application/json";
  if (type) headers["content-type"] = type;
  if (key) headers.authorization = `Bearer ${key}`;
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + p, {
    method,
    headers,
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers, text };
}

export async function newDevice(base, name = "test-device", cookie) {
  const r = await req(base, "POST", "/api/devices", { body: { name }, cookie });
  if (r.status !== 200) throw new Error(`device create failed: ${r.status} ${r.text}`);
  return r.json;
}

/** What the current collector of `tool` sends in every payload. */
export const collector = (tool) => ({ name: tool, version: COLLECTOR_VERSIONS[tool] });

let seq = 0;
export function event(over = {}) {
  seq += 1;
  return {
    event_id: `msg_test_${Date.now()}_${seq}`,
    tool: "claude-code",
    session_id: "s1",
    prompt_id: `p-${seq}`,
    model: "claude-opus-5-5",
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 },
    occurred_at: Math.floor(Date.now() / 1000),
    collector: collector("claude-code"),
    ...over,
  };
}

/** One Codex response as the collector sends it (rollout token_usage_record). */
export function codexResponse(over = {}) {
  return {
    response_id: `resp_${Math.random().toString(36).slice(2)}`,
    session_id: "01a0b861-4cf4-7f10-8e5b-8d110992ee04",
    turn_id: "01a0b873-1871-70e2-9708-12e7c0fa6012",
    model: "gpt-6-astra",
    occurred_at: Math.floor(Date.now() / 1000) - 120,
    usage: { input_tokens: 300, cached_input_tokens: 200, cache_write_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 10 },
    ...over,
  };
}

/** One OpenCode assistant message as the collector sends it (opencode.db). */
export function opencodeMessage(over = {}) {
  return {
    message_id: `msg_${Math.random().toString(36).slice(2)}`,
    session_id: "ses_f274ca90cffecUog3NvACbUq3j",
    provider_id: "anthropic",
    model_id: "claude-sonnet-5",
    occurred_at: Math.floor(Date.now() / 1000) - 120,
    usage: { input_tokens: 325, output_tokens: 1241, reasoning_tokens: 10, cache_read_tokens: 26353, cache_write_tokens: 0, total_tokens: 27929 },
    ...over,
  };
}

let signInIp = 0;
/**
 * A whole GitHub sign-in in one browser: POST /api/auth/github ({next,
 * setup_code, reauth; link, which the server ignores}), then GitHub's redirect back to the callback with a
 * code for that GitHub login (`login: null`: the user cancelled). Each call
 * comes from its own client address (the OAuth and sign-up limits are per
 * client) unless `ip` says. Resolves with the start answer (`start`), where
 * the callback sent the browser (`location`), its `auth_error`, and the
 * session cookie it set (null if none).
 */
export async function githubSignIn(base, login, { next, setup_code, link, reauth, cookie, ip, state: forged, headers: extra = {} } = {}) {
  ip ??= `198.17.${Math.floor(++signInIp / 250) % 250}.${signInIp % 250}`;
  const headers = { "content-type": "application/json", "cf-connecting-ip": ip, ...(cookie ? { cookie } : {}), ...extra };
  const start = await fetch(`${base}/api/auth/github`, {
    method: "POST", headers, body: JSON.stringify({ next, setup_code, link, reauth }),
  });
  const startJson = await start.json().catch(() => null);
  if (start.status !== 200) return { start: { status: start.status, json: startJson }, location: null, error: null, cookie: null };
  const url = new URL(startJson.url);
  const state = forged ?? url.searchParams.get("state");
  const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith("gh_oauth="))?.split(";")[0];
  let query = `state=${encodeURIComponent(state)}`;
  if (login === null) query += "&error=access_denied";
  else query = `code=${await githubCode(login)}&${query}`;
  const back = await fetch(`${base}/api/auth/github/callback?${query}`, {
    redirect: "manual",
    headers: { "cf-connecting-ip": ip, cookie: [stateCookie, cookie].filter(Boolean).join("; "), ...extra },
  });
  const location = back.headers.get("location");
  const session = back.headers.getSetCookie().find((c) => c.startsWith("dash_session=") && !/Max-Age=0/i.test(c));
  return {
    start: { status: start.status, json: startJson, url, headers: start.headers },
    headers: back.headers,
    status: back.status,
    location,
    error: location ? new URL(location, base).searchParams.get("auth_error") : null,
    cookie: session ? session.split(";")[0] : null,
  };
}

/** Sign in with GitHub as that (linked) login and return the session cookie ("name=value"). */
export async function login(base, username) {
  const r = await githubSignIn(base, username);
  if (!r.cookie) throw new Error(`sign-in failed: ${r.start.status} ${JSON.stringify(r.start.json)} → ${r.location}`);
  return r.cookie;
}

let pollIp = 0;
/**
 * Headers for a test that polls public reads (waitFor every 100 ms, far
 * faster than a dashboard): each call comes from its own client address,
 * so the per-client rate limit never trips the test.
 */
export const asNewClient = () => ({ "cf-connecting-ip": `198.19.${Math.floor(++pollIp / 250) % 250}.${pollIp % 250}` });

/**
 * Sign up: a GitHub sign-in by a GitHub user with no account yet (made up
 * with `over`, e.g. a name). Resolves like githubSignIn.
 */
export async function register(base, login, { over, ...options } = {}) {
  githubUser(login, over);
  return githubSignIn(base, login, options);
}

/** An account's id, looked up by an admin session (the default one if omitted). */
export async function userId(base, username, cookie) {
  const users = (await req(base, "GET", "/api/users", { cookie })).json.users;
  return users.find((u) => u.username === username).id;
}

/**
 * Whether a process holds an exclusive flock on that file (missing means
 * free). Reads /proc/locks rather than trying the lock: a probe holding it
 * even briefly makes a collector's non-blocking attempt give up. Without
 * /proc (macOS), falls back to that probe; on Windows, to one on byte 0
 * (msvcrt.locking, like the Antigravity collector).
 */
export function isLocked(file) {
  if (!fs.existsSync(file)) return false;
  if (fs.existsSync("/proc/locks")) {
    const ino = String(fs.statSync(file).ino);
    // "1: FLOCK  ADVISORY  WRITE 1234 fd:01:5678 0 EOF"; "1: -> FLOCK …" lines are waiters.
    return fs.readFileSync("/proc/locks", "utf8").split("\n")
      .some((l) => /^\d+:\s+FLOCK\s+\S+\s+WRITE\s/.test(l) && l.split(/\s+/)[5]?.split(":")[2] === ino);
  }
  if (process.platform === "win32") {
    return spawnSync(PYTHON, ["-c",
      "import msvcrt, sys\nf = open(sys.argv[1], 'r+b')\ntry: msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)\nexcept OSError: sys.exit(1)\nmsvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)",
      file]).status === 1;
  }
  return spawnSync("python3", ["-c",
    "import fcntl, sys\ntry: fcntl.flock(open(sys.argv[1], 'a'), fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(1)",
    file]).status === 1;
}

/** Whether a process has that text on its command line (e.g. a temp HOME in the script path; any case on Windows). */
export const running = (text) => process.platform === "win32"
  ? execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_Process).CommandLine"],
    { encoding: "utf8", windowsHide: true }).toLowerCase().includes(text.toLowerCase())
  : execFileSync("ps", ["-Aww", "-o", "args="], { encoding: "utf8" }).includes(text);

/** The Python interpreter the collector tests run: PYTHON, else python3 (python on Windows). */
export const PYTHON = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");

/**
 * A temp directory for a test's HOME. On Windows, its long path: TEMP can
 * be a short 8.3 name (RUNNER~1), which Python may expand in the paths it
 * reports or runs.
 */
export const tempHome = (prefix) =>
  fs.mkdtempSync(path.join(process.platform === "win32" ? fs.realpathSync.native(os.tmpdir()) : os.tmpdir(), prefix));

/**
 * Resolves once no process has that text on its command line, seen twice
 * 200 ms apart: an exit handler in this process (the OpenCode plugin) may
 * start the next run in between. False after `ms`.
 */
export async function processesGone(text, ms = 30000) {
  const end = Date.now() + ms;
  for (let clear = 0; clear < 2;) {
    clear = running(text) ? 0 : clear + 1;
    if (clear < 2 && Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, clear ? 200 : 100));
  }
  return true;
}

/**
 * Waits past UTC midnight when it is less than `margin` seconds away, so
 * the posts and the reads of a test that checks "today" fall on one day
 * (the server decides today when it reads).
 */
export async function awayFromMidnight(margin = 15) {
  const left = 86400000 - (Date.now() % 86400000);
  if (left < margin * 1000) await new Promise((r) => setTimeout(r, left + 1000));
}

/**
 * The collectors' fingerprint of a server and device key (target() in
 * collectors/*.py): their offsets are kept per fingerprint (issue #127).
 */
export function collectorTarget(url, key) {
  // Like Python's urlsplit / urlunsplit: scheme, host (lowercased, default
  // port dropped), path without trailing "/", query; no scheme is all path.
  const [, scheme = "", netloc, path = "", query = ""] =
    url.trim().match(/^(?:([A-Za-z][A-Za-z0-9+.-]*):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?/);
  const s = scheme.toLowerCase();
  let host = "";
  if (netloc !== undefined) {
    const [, h = "", port] = netloc.replace(/^.*@/, "").match(/^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/) ?? [];
    host = h.toLowerCase();
    const p = port ? Number(port) : null;
    if (p !== null && !((s === "http" && p === 80) || (s === "https" && p === 443))) host += `:${p}`;
  }
  const server = (s ? `${s}:` : "") + (host ? `//${host}` : "") + path.replace(/\/+$/, "") + (query ? `?${query}` : "");
  return createHash("sha256").update(`${server}\n${key.trim()}`).digest("hex").slice(0, 16);
}

/** One target's offsets in a collector's state file, or undefined. */
export const targetOffsets = (file, url, key) =>
  JSON.parse(fs.readFileSync(file, "utf8")).targets?.[collectorTarget(url, key)];

/**
 * A fake ingest server that accepts everything and records each batch's
 * messages: tells a full resend from an incremental one.
 */
export async function recordingServer() {
  const batches = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    batches.push({ key: request.headers.authorization, messages: payload.messages ?? [] });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, messages: (payload.messages ?? []).length }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    batches,
    /** Messages received since the last call. */
    take: () => batches.splice(0).flatMap((b) => b.messages),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
