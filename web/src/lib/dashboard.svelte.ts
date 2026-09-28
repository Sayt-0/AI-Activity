// App state: sign-in, the current page (sign-in at /, a public profile at
// /u/<username>, the fictional profile at /demo, /leaderboard, /settings,
// /admin), session paging, and the 15 s auto-refresh
// (skipped while hidden or already in flight).
import { api, NotFoundError, onSessionLost, RateLimitedError, UnauthorizedError } from "./api.ts";
import { authErrorMessage } from "./auth-errors.ts";
import { DEMO_PROFILE, demoDashboard } from "./demo.ts";
import { ACTIVITY_DAYS, liveDashboard, type LiveData } from "./live.ts";
import type { DashboardVM } from "./view-model.ts";
import type { Account, Profile, SessionsResponse } from "../../../shared/types.ts";

export type Route =
  | { page: "home" }
  | { page: "profile"; username: string }
  | { page: "demo" }
  | { page: "leaderboard" }
  | { page: "friends" }
  | { page: "settings" }
  | { page: "admin" };

/**
 * "signed-out": sign-in screen; "setup": no account exists yet;
 * "missing": unknown profile.
 */
export type Status = "loading" | "ready" | "signed-out" | "setup" | "missing" | "error";

const REFRESH_MS = 15000;
/** Server-side cap on one sessions page (/api/u/<name>/sessions). */
const SESSIONS_MAX_PAGE = 200;
export const SESSIONS_PAGE = 10;

/**
 * The first `limit` sessions, in as many server pages as needed. A session
 * active between two page requests moves to the top and would come back on
 * a later page: keep its first copy only (the list is keyed by it).
 */
async function fetchSessions(username: string, limit: number): Promise<SessionsResponse> {
  const first = await api.sessions(username, Math.min(limit, SESSIONS_MAX_PAGE), null, 0);
  const key = (s: { tool: string; session_id: string }) => `${s.tool}\u0000${s.session_id}`;
  const seen = new Set(first.sessions.map(key));
  const sessions = [...first.sessions];
  let fetched = first.sessions.length;
  // Count unique sessions, not fetched rows: a duplicate must not shorten the list.
  while (sessions.length < limit && fetched < first.total) {
    const page = await api.sessions(username, Math.min(limit - sessions.length, SESSIONS_MAX_PAGE), null, fetched);
    if (!page.sessions.length) break;
    fetched += page.sessions.length;
    for (const s of page.sessions) if (!seen.has(key(s))) { seen.add(key(s)); sessions.push(s); }
  }
  return { ...first, sessions };
}

function routeFromPath(): Route {
  const path = location.pathname;
  const profile = path.match(/^\/u\/([^/]+)\/?$/);
  if (profile) {
    // A stray "%" (a mistyped link) must not stop the whole app.
    let username = profile[1];
    try { username = decodeURIComponent(username); } catch { /* keep it raw: it will be "missing" */ }
    return { page: "profile", username };
  }
  if (/^\/settings\/?$/.test(path)) return { page: "settings" };
  if (/^\/admin\/?$/.test(path)) return { page: "admin" };
  if (/^\/leaderboard\/?$/.test(path)) return { page: "leaderboard" };
  if (/^\/friends\/?$/.test(path)) return { page: "friends" };
  if (/^\/demo\/?$/.test(path)) return { page: "demo" };
  return { page: "home" };
}

export const profilePath = (username: string) => `/u/${encodeURIComponent(username)}`;

/** The complete in-app address to return to after signing in. */
export const currentPath = () => location.pathname + location.search;

const onSite = (path: string) => /^\/(?![/\\])/.test(path);

/**
 * Where to go after signing in: a same-site path from ?next=, normalized,
 * if any. "//host", "/\host", "/<tab>/host" (browsers drop tabs and
 * newlines) and "/a/..//host" (once resolved) would leave the site; the
 * server checks it the same way (safeNext). Signing in from /demo lands on
 * the viewer's real profile, not the fiction.
 */
function nextPath(): string | null {
  const next = new URLSearchParams(location.search).get("next");
  if (!next || next.length > 512 || !onSite(next) || /[\s\\\x00-\x1f\x7f]/.test(next)) return null;
  const url = new URL(next, "http://x");
  const path = url.pathname + url.search;
  return url.origin === "http://x" && onSite(path) && !/^\/demo\/?(?:[?#]|$)/.test(path) ? path : null;
}

const same = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

export class Dashboard {
  route = $state<Route>(routeFromPath());
  status = $state<Status>("loading");
  sessionsLimit = $state(SESSIONS_PAGE);
  /** The signed-in account; null when signed out. */
  account = $state<Account | null>(null);
  /** Anyone may create an account from the sign-in page (an admin setting). */
  signupOpen = $state(true);
  /** Sign in with GitHub is set up on the server. */
  github = $state(true);
  /** Why the last GitHub sign-in (or linking) failed, in words; null if it did not. */
  authError = $state<string | null>(null);
  /** The profile on screen. */
  shown = $state<Profile | null>(null);
  private live = $state<LiveData | null>(null);
  private inFlight = false;
  private reloadQueued = false;

  /** True on the signed-in viewer's own profile. */
  own = $derived(this.route.page === "profile" && same(this.route.username, this.account?.username));

  vm = $derived<DashboardVM | null>(
    // Fictional data only at /demo (always labeled); real profiles are always live.
    this.route.page === "demo" ? demoDashboard("all")
      : this.route.page === "profile" && this.live ? liveDashboard(this.live, "all")
        : null
  );

  async load(): Promise<void> {
    if (this.inFlight) {
      // A filter, paging or page change during a refresh must not be lost.
      this.reloadQueued = true;
      return;
    }
    this.inFlight = true;
    const route = this.route;
    try {
      if (route.page === "demo") {
        await this.loadDemo(route);
        return;
      }
      const auth = await api.authStatus();
      this.account = auth.user;
      this.signupOpen = auth.signup_open;
      this.github = auth.github_sign_in;
      if (!auth.user) {
        if (route.page === "profile") await this.loadProfile(route.username);
        // Public, like profile pages: the page loads its own data.
        else if (route.page === "leaderboard") this.status = "ready";
        else if (route.page === "settings" || route.page === "admin" || route.page === "friends") {
          this.go(`/?next=${encodeURIComponent(currentPath())}`, true);
        }
        else this.status = auth.setup_required ? "setup" : "signed-out";
        return;
      }
      if (route.page === "home") {
        // Signed in: the address bar shows the shareable profile link.
        this.go(nextPath() ?? profilePath(auth.user.username), true);
        return;
      }
      if (route.page === "profile") await this.loadProfile(route.username);
      else this.status = "ready";
    } catch (e) {
      // Navigated elsewhere meanwhile: the queued reload decides, not this.
      if (this.route !== route) return;
      if (e instanceof UnauthorizedError) this.signedOut();
      else if (e instanceof NotFoundError) {
        this.live = null;
        this.status = "missing";
      } else if (e instanceof RateLimitedError && this.status === "ready") {
        // Keep showing the last data; the next refresh tries again.
      } else this.status = "error";
    } finally {
      this.inFlight = false;
      if (this.reloadQueued) {
        this.reloadQueued = false;
        void this.load();
      }
    }
  }

  /**
   * /demo is client-side only: a fixed dataset, no usage API call and no
   * refresh. The sign-in status only fills the header's account menu; the
   * page needs no server and stays up (signed out) without one.
   */
  private async loadDemo(route: Route): Promise<void> {
    this.shown = DEMO_PROFILE;
    this.status = "ready";
    try {
      const auth = await api.authStatus();
      if (this.route !== route) return;
      this.account = auth.user;
      this.signupOpen = auth.signup_open;
    } catch {
      if (this.route === route) this.account = null;
    }
  }

  private async loadProfile(username: string): Promise<void> {
    const [profile, summary, activity, quotas, sessions, ocSummary, ocLatest, agSummary, agLatest] = await Promise.all([
      api.profile(username),
      // Every tool, always: there is no tool filter.
      api.summary(username, null),
      api.activity(username, ACTIVITY_DAYS, null),
      api.quotas(username),
      fetchSessions(username, this.sessionsLimit),
      api.summary(username, "opencode"),
      // Enough to count the conversations active right now.
      api.sessions(username, 10, "opencode", 0),
      // Antigravity's card falls back to the same view without quotas.
      api.summary(username, "antigravity"),
      api.sessions(username, 10, "antigravity", 0),
    ]);
    // Navigated elsewhere while this was in flight: its queued reload wins.
    if (this.route.page !== "profile" || this.route.username !== username) return;
    this.shown = profile;
    this.live = { summary, activity, quotas, sessions, opencode: { summary: ocSummary, latest: ocLatest },
      antigravity: { summary: agSummary, latest: agLatest } };
    this.status = "ready";
  }

  showMoreSessions(): void {
    this.sessionsLimit += SESSIONS_PAGE;
    void this.load();
  }

  /** Navigate within the app (path may carry a query string). */
  go(path: string, replace = false): void {
    this.authError = null; // said once, on the page GitHub sent the browser back to
    // "/" only redirects a signed-in viewer to their profile: go there
    // directly, so Back does not land on the same page again.
    if (path === "/" && this.account) path = profilePath(this.account.username);
    if (replace) history.replaceState(null, "", path);
    else history.pushState(null, "", path);
    this.showPath();
  }

  openProfile(username: string): void {
    this.go(profilePath(username));
  }

  /** Sync with the URL (after go(), or back/forward). */
  private showPath(): void {
    this.route = routeFromPath();
    this.live = null;
    this.shown = null;
    this.sessionsLimit = SESSIONS_PAGE;
    this.status = "loading";
    void this.load();
  }

  /**
   * Sign in (or sign up) with GitHub: the browser leaves for GitHub and
   * comes back signed in, to ?next= if any, else "/" (the viewer's profile).
   * The first account also gives the setup code. An error message, or null
   * once on the way.
   */
  async signIn(setupCode: string | null = null): Promise<string | null> {
    return this.toGithub({ next: nextPath() ?? "/", ...(setupCode !== null ? { setup_code: setupCode } : {}) });
  }

  /**
   * Sign the signed-in account in again with GitHub (a destructive action
   * needs a recent sign-in), then back to `next`, where a failure is told.
   */
  async signInAgain(next = currentPath()): Promise<string | null> {
    return this.toGithub({ next, reauth: true });
  }

  private async toGithub(start: Parameters<typeof api.startGithub>[0]): Promise<string | null> {
    try {
      const { url } = await api.startGithub(start);
      location.assign(url);
      return null;
    } catch (e) {
      if (e instanceof UnauthorizedError) {
        return start.setup_code !== undefined ? "Wrong setup code: copy it from the server log." : "Sign in first.";
      }
      return (e as Error).message;
    }
  }

  async logout(): Promise<void> {
    await api.logout().catch(() => {});
    this.signedOut();
    this.go("/");
  }

  /** The session ended elsewhere: sign in again, then come back here. */
  private sessionLost(): void {
    if (!this.account) return;
    this.signedOut();
    this.go(`/?next=${encodeURIComponent(currentPath())}`, true);
  }

  /** Drop everything the previous account could see. */
  private signedOut(): void {
    this.account = null;
    this.live = null;
    this.sessionsLimit = SESSIONS_PAGE;
    this.status = "signed-out";
  }

  /** Starts polling; returns a cleanup function. */
  start(): () => void {
    // Back from a failed GitHub sign-in: say why, once (not kept in the address).
    const params = new URLSearchParams(location.search);
    if (params.has("auth_error")) {
      this.authError = authErrorMessage(params.get("auth_error"));
      params.delete("auth_error");
      const query = params.toString();
      history.replaceState(null, "", location.pathname + (query ? `?${query}` : ""));
      this.route = routeFromPath();
    }
    void this.load();
    const onPop = () => this.showPath();
    window.addEventListener("popstate", onPop);
    onSessionLost(() => this.sessionLost());
    // Profile pages refresh their live data (/demo is fixed); any page
    // that could not reach the server retries.
    const tick = () => {
      if (document.hidden) return;
      if (this.status === "error" || this.route.page === "profile") void this.load();
    };
    const id = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      onSessionLost(null);
      window.removeEventListener("popstate", onPop);
      document.removeEventListener("visibilitychange", tick);
    };
  }
}
