// Runs the dashboard state class (web/src/lib/dashboard.svelte.ts, Svelte 5
// runes) in node: compiled with svelte/compiler, with a fake browser
// (location, history, document) and a fake fetch answering per path.
import fs from "node:fs";
import path from "node:path";
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { stripTypeScriptTypes } from "node:module";
import { compileModule } from "svelte/compiler";

const LIB = new URL("../web/src/lib/", import.meta.url).pathname;
const BUILT = path.join(LIB, ".dashboard.test-build.js");

// --- fake browser -----------------------------------------------------------
/** Where location.assign() sent the browser (GitHub's authorize page). */
const assigned = [];
const loc = { pathname: "/", search: "", assign: (url) => assigned.push(url) };
const setUrl = (url) => {
  const u = new URL(url, "http://x");
  loc.pathname = u.pathname;
  loc.search = u.search;
};
let intervals = [];
globalThis.location = loc;
globalThis.history = { pushState: (_s, _t, url) => setUrl(url), replaceState: (_s, _t, url) => setUrl(url) };
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
globalThis.setInterval = (fn) => { intervals.push(fn); return intervals.length; };
globalThis.clearInterval = () => {};

/** path → response: a JSON body, a status number, or a function of the call count. */
let routes = {};
const calls = [];
/** Bodies of POSTs, by path. */
const sent = [];
globalThis.fetch = async (url, init) => {
  const p = String(url);
  calls.push(p);
  if (init?.body) sent.push({ path: p, body: JSON.parse(init.body) });
  const key = Object.keys(routes).find((k) => p === k || p.startsWith(k + "?") || (k.endsWith("*") && p.startsWith(k.slice(0, -1))));
  let r = key === undefined ? 404 : routes[key];
  if (typeof r === "function") r = r(p);
  if (r instanceof Error) throw r;
  const status = typeof r === "number" ? r : 200;
  return { status, ok: status < 400, json: async () => (typeof r === "number" ? {} : r) };
};

const settle = async (ms = 5000) => {
  // load() is a chain of awaits (and a refresh on a ready page never leaves
  // "ready"), so a fixed sleep cannot tell when it landed: wait until no
  // fetch starts anymore instead. The fake fetch resolves immediately, so a
  // quiet window means every chained reload finished.
  const end = Date.now() + ms;
  for (;;) {
    const n = calls.length;
    await new Promise((r) => setTimeout(r, 50));
    if (calls.length === n) return;
    assert.ok(Date.now() <= end, "fetches never settled");
  }
};
const me = { id: 1, username: "me", display_name: "Me", avatar_url: null, is_admin: false };
const signedIn = { authenticated: true, user: me, setup_required: false, signup_open: true, github_sign_in: true };
const signedOut = { authenticated: false, user: null, setup_required: false, signup_open: true, github_sign_in: true };
const AUTHORIZE = "https://github.com/login/oauth/authorize?state=s";
const emptySummary = { tool: null, day: "2026-09-25", total: { tokens: 0, sessions: 0, events: 0, by_model: [], by_model_others_sessions: 0, by_tool: [] }, today: { tokens: 0, sessions: 0, events: 0, by_model: [], by_model_others_sessions: 0, by_tool: [] }, provenance: "" };
const profileRoutes = (name, sessions = { sessions: [], total: 0, provenance: "" }) => ({
  [`/api/u/${name}`]: { username: name, display_name: name, avatar_url: null },
  [`/api/u/${name}/summary`]: emptySummary,
  [`/api/u/${name}/activity`]: { days: [], provenance: "" },
  [`/api/u/${name}/quotas`]: { quotas: [], provenance: "" },
  [`/api/u/${name}/sessions`]: sessions,
});

let Dashboard, api;
before(async () => {
  const ts = fs.readFileSync(path.join(LIB, "dashboard.svelte.ts"), "utf8");
  const { js } = compileModule(stripTypeScriptTypes(ts), { filename: "dashboard.svelte.js", generate: "client" });
  fs.writeFileSync(BUILT, js.code);
  ({ Dashboard } = await import(BUILT));
  ({ api } = await import(path.join(LIB, "api.ts")));
});
after(() => fs.rmSync(BUILT, { force: true }));
beforeEach(() => { routes = {}; calls.length = 0; sent.length = 0; assigned.length = 0; intervals = []; });

/** A dashboard opened at url, started, and settled. */
async function open(url, extra = {}) {
  setUrl(url);
  routes = { "/api/auth/status": signedIn, ...extra };
  const dash = new Dashboard();
  const stop = dash.start();
  await settle();
  return { dash, stop, tick: () => intervals.at(-1)() };
}

describe("dashboard state", () => {
  test("a malformed profile link shows 'missing' instead of crashing", async () => {
    const { dash, stop } = await open("/u/%ZZ", { "/api/u/%25ZZ*": 404 });
    assert.equal(dash.route.username, "%ZZ");
    assert.equal(dash.status, "missing");
    stop();
  });

  test("any page that could not reach the server retries on the next tick", async () => {
    const { dash, stop, tick } = await open("/leaderboard");
    routes["/api/auth/status"] = new TypeError("network down");
    dash.go("/settings");
    await settle();
    assert.equal(dash.status, "error");
    routes["/api/auth/status"] = signedIn;
    tick();
    await settle();
    assert.equal(dash.status, "ready");
    stop();
  });

  test("a rate-limited refresh keeps the page as it was; a first load shows the error", async () => {
    const { dash, stop, tick } = await open("/u/me", profileRoutes("me"));
    assert.equal(dash.status, "ready");
    const shown = dash.vm;
    routes["/api/u/me/summary"] = 429;
    tick();
    await settle();
    assert.equal(dash.status, "ready");
    assert.equal(dash.vm, shown);
    stop();
    const first = await open("/u/me", { ...profileRoutes("me"), "/api/u/me/summary": 429 });
    assert.equal(first.dash.status, "error");
    first.stop();
  });

  test("a 401 on a page that needs the session sends back to sign-in, then here", async () => {
    const { dash, stop } = await open("/settings", { "/api/devices": 401 });
    assert.equal(dash.status, "ready");
    // The session ended elsewhere: the server now says signed out, too.
    routes["/api/auth/status"] = signedOut;
    await assert.rejects(api.devices());
    await settle();
    assert.equal(dash.account, null);
    assert.equal(loc.pathname + loc.search, `/?next=${encodeURIComponent("/settings")}`);
    assert.equal(dash.status, "signed-out");
    stop();
  });

  test("opening a protected page signed out preserves its query for sign-in", async () => {
    const { stop } = await open("/settings?tab=x", { "/api/auth/status": signedOut });
    assert.equal(loc.pathname + loc.search, `/?next=${encodeURIComponent("/settings?tab=x")}`);
    stop();
  });

  test("Friends requires sign-in and returns there after GitHub", async () => {
    const { dash, stop } = await open("/friends", { "/api/auth/status": signedOut });
    assert.equal(loc.pathname + loc.search, `/?next=${encodeURIComponent("/friends")}`);
    assert.equal(dash.status, "signed-out");
    stop();
    const signed = await open("/friends");
    assert.equal(signed.dash.route.page, "friends");
    assert.equal(signed.dash.status, "ready");
    signed.stop();
  });

  test("a lost session preserves the query through the GitHub sign-in", async () => {
    const { dash, stop } = await open("/u/me?tab=x", profileRoutes("me"));
    routes["/api/devices"] = 401;
    routes["/api/auth/status"] = signedOut;
    await assert.rejects(api.devices());
    await settle();
    assert.equal(loc.pathname + loc.search, `/?next=${encodeURIComponent("/u/me?tab=x")}`);

    routes["/api/auth/github"] = { url: AUTHORIZE };
    assert.equal(await dash.signIn(), null);
    // GitHub sends the browser back to next once signed in.
    assert.deepEqual(sent, [{ path: "/api/auth/github", body: { next: "/u/me?tab=x" } }]);
    assert.deepEqual(assigned, [AUTHORIZE]);
    stop();
  });

  test("a wrong setup code is not a lost session", async () => {
    const { dash, stop } = await open("/", { "/api/auth/status": { ...signedOut, setup_required: true }, "/api/auth/github": 401 });
    assert.equal(dash.status, "setup");
    assert.equal(await dash.signIn("WRONG-CODE"), "Wrong setup code: copy it from the server log.");
    assert.deepEqual(sent, [{ path: "/api/auth/github", body: { next: "/", setup_code: "WRONG-CODE" } }]);
    assert.deepEqual([dash.status, assigned.length], ["setup", 0]);
    stop();
  });

  test("signing in comes back to a safe destination, else your profile", async () => {
    for (const [start, next] of [
      ["/", "/"],
      // From the demo: the real profile, not the fiction.
      ["/?demo=1", "/"],
      [`/?next=${encodeURIComponent("/demo")}`, "/"],
      [`/?next=${encodeURIComponent("/settings?tab=x")}`, "/settings?tab=x"],
      [`/?next=${encodeURIComponent("https://example.com/away")}`, "/"],
      [`/?next=${encodeURIComponent("//example.com/away")}`, "/"],
      [`/?next=${encodeURIComponent("/\t/example.com/away")}`, "/"],
      [`/?next=${encodeURIComponent("/a/..//example.com/away")}`, "/"],
      [`/?next=${encodeURIComponent("/settings/../settings?tab=x")}`, "/settings?tab=x"],
    ]) {
      const { dash, stop } = await open(start, { "/api/auth/status": signedOut, "/api/auth/github": { url: AUTHORIZE } });
      sent.length = 0;
      assert.equal(await dash.signIn(), null);
      assert.deepEqual(sent, [{ path: "/api/auth/github", body: { next } }], start);
      stop();
    }
  });

  test("back from a failed GitHub sign-in: says why once, and drops it from the address", async () => {
    const { dash, stop } = await open(`/?auth_error=closed&next=${encodeURIComponent("/settings")}`, { "/api/auth/status": signedOut });
    assert.equal(dash.authError, "Account creation is closed on this server: only existing accounts can sign in.");
    assert.equal(loc.pathname + loc.search, `/?next=${encodeURIComponent("/settings")}`);
    assert.equal(dash.status, "signed-out");
    stop();
    // Only known codes: a link cannot put its own words on the page.
    const other = await open("/?auth_error=Your+account+was+hacked", { "/api/auth/status": signedOut });
    assert.equal(other.dash.authError, null);
    assert.equal(loc.pathname + loc.search, "/");
    other.stop();
  });

  test("signing in again from Settings comes back to Settings, where a failure is told", async () => {
    const { dash, stop } = await open("/settings", { "/api/auth/github": { url: AUTHORIZE } });
    assert.equal(await dash.signInAgain(), null);
    assert.deepEqual(sent, [{ path: "/api/auth/github", body: { next: "/settings", reauth: true } }]);
    assert.deepEqual(assigned, [AUTHORIZE]);
    stop();
    const back = await open("/settings?auth_error=other_account");
    assert.equal(back.dash.status, "ready");
    assert.match(back.dash.authError, /not the one signed in here/);
    assert.equal(loc.pathname + loc.search, "/settings");
    back.stop();
  });

  test("the home link goes straight to your profile when signed in", async () => {
    const { dash, stop } = await open("/leaderboard", profileRoutes("me"));
    dash.go("/");
    assert.equal(loc.pathname, "/u/me");
    stop();
  });

  test("/demo shows the fictional user, signed out, without usage calls or refresh", async () => {
    const { dash, stop, tick } = await open("/demo", { "/api/auth/status": signedOut });
    assert.equal(dash.status, "ready");
    assert.equal(dash.account, null);
    assert.equal(dash.own, false);
    assert.deepEqual(dash.shown, { username: "demo", display_name: "Demo preview", avatar_url: null });
    assert.equal(dash.vm.demo, true);
    assert.deepEqual(calls, ["/api/auth/status"]);
    tick();
    await settle();
    assert.deepEqual(calls, ["/api/auth/status"], "no refresh");
    stop();
  });

  test("/demo stays up when the server is unreachable", async () => {
    const { dash, stop } = await open("/demo", { "/api/auth/status": new TypeError("network down") });
    assert.equal(dash.status, "ready");
    assert.equal(dash.vm.demo, true);
    stop();
  });

  test("?demo=1 has no effect on a real profile", async () => {
    const { dash, stop } = await open("/u/me?demo=1", profileRoutes("me"));
    assert.equal(loc.pathname + loc.search, "/u/me?demo=1", "the query is ignored, not rewritten");
    assert.equal(dash.route.page, "profile");
    assert.equal(dash.vm.demo, false);
    assert.ok(!dash.vm.sessions.some(s => s.id.startsWith("demo-")));
    stop();
  });

  test("/demo is signed in too; leaving it shows live data again", async () => {
    const { dash, stop } = await open("/demo", profileRoutes("me"));
    assert.equal(dash.account.username, "me");
    assert.equal(dash.vm.demo, true);
    assert.deepEqual(dash.vm.antigravity.pools.map(p => p.windows.map(w => w.pct)), [[42, 68], [19, 32]]);
    const ids = dash.vm.sessions.map(s => s.id.slice(0, 8));
    assert.equal(dash.vm.sessions.filter(s => s.tool === "antigravity").length, 2);
    assert.equal(dash.vm.opencode.today.tokens, 0);
    assert.equal(dash.vm.opencode.today.sessions, 0);
    assert.equal(dash.vm.opencode.today.calls, 0);
    assert.equal(dash.vm.opencode.recent.length, 1, "demo covers history without use today");
    assert.equal(new Set(ids).size, ids.length, "demo ids differ in what the list shows");
    assert.ok(dash.vm.stats.today.byTool.some(r => r.name === "antigravity" && r.value > 0));
    for (const figure of [dash.vm.stats.today, dash.vm.stats.total, dash.vm.stats.sessions]) {
      assert.equal(new Set(figure.byModel.map(r => r.name)).size, figure.byModel.length);
    }
    dash.go("/leaderboard");
    await settle();
    dash.openProfile("me");
    await settle();
    assert.equal(dash.vm.demo, false);
    assert.deepEqual(dash.vm.antigravity.pools.map(p => p.windows.map(w => w.pct)), [[null, null], [null, null]]);
    assert.ok(!dash.vm.sessions.some(s => s.id.startsWith("demo-")));
    stop();
  });

  test("a session that moves between two pages is listed once", async () => {
    const s = (id, t) => ({ session_id: id, tool: "claude-code", tokens: 1, last_seen: t, events: 1, model: null, context_used_pct: null, context_window_size: null });
    const page1 = Array.from({ length: 200 }, (_, i) => s(`s${i}`, 1000 - i));
    // s150 became active between the two requests: it is on page 2 as well.
    const page2 = [s("s150", 2000), ...Array.from({ length: 9 }, (_, i) => s(`t${i}`, 10 - i))];
    const { dash, stop } = await open("/u/me", {
      ...profileRoutes("me"),
      "/api/u/me/sessions": (p) => ({ sessions: p.includes("offset=0") ? page1 : page2, total: 210, provenance: "" }),
    });
    for (let i = 0; i < 20; i++) dash.showMoreSessions();
    await settle();
    await settle();
    const ids = dash.vm.sessions.map((x) => x.id ?? x.session_id);
    assert.equal(new Set(ids).size, ids.length);
    stop();
  });

  test("navigating loads the new page once", async () => {
    const { dash, stop } = await open("/u/me", profileRoutes("me"));
    const before = calls.filter((c) => c === "/api/auth/status").length;
    dash.go("/leaderboard");
    await settle();
    assert.equal(calls.filter((c) => c === "/api/auth/status").length, before + 1);
    stop();
  });
});
