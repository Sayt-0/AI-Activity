// Typed client for the dashboard JSON API (same origin, cookie session).
import type {
  ActivityResponse, AdminOverview, AdminSettings, AdminUser, AuthStatus, DeletedAccount, DeletedActivity, LeaderboardResponse, Profile, Device, QuotasResponse,
  SessionsResponse, SummaryResponse, FriendsResponse,
} from "../../../shared/types.ts";

export class UnauthorizedError extends Error {
  constructor() { super("unauthorized"); }
}

export class NotFoundError extends Error {
  constructor() { super("not found"); }
}

/** 429: the server's rate limit; the next refresh tries again. */
export class RateLimitedError extends Error {
  constructor() { super("rate limited"); }
}

/** 403 with `reauth`: sign in with GitHub again (a recent sign-in is needed), then retry. */
export class ReauthRequiredError extends Error {}

let sessionLost: (() => void) | null = null;

/**
 * Called when a request that needs the viewer's session answers 401: the
 * session ended elsewhere (signed out, account disabled or deleted).
 * Not for /api/auth/*, where a 401 means a wrong setup code.
 */
export function onSessionLost(fn: (() => void) | null): void {
  sessionLost = fn;
}

function unauthorized(path: string): UnauthorizedError {
  if (!path.startsWith("/api/auth/")) sessionLost?.();
  return new UnauthorizedError();
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (r.status === 401) throw unauthorized(path);
  if (r.status === 404) throw new NotFoundError();
  if (r.status === 429) throw new RateLimitedError();
  if (!r.ok) throw new Error(`request failed: ${r.status}`);
  return r.json() as Promise<T>;
}

/** POST JSON; a non-2xx answer throws with the server's error message. */
async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status === 401) throw unauthorized(path);
  const json = await r.json().catch(() => ({}));
  if (r.status === 403 && json.reauth) throw new ReauthRequiredError(json.error);
  if (!r.ok) throw new Error(json.error || `request failed: ${r.status}`);
  return json as T;
}

/** A GitHub sign-in: where to come back, the setup code (first account), or signing the signed-in account in again. */
export interface GithubStart {
  next: string;
  setup_code?: string;
  reauth?: boolean;
}

const toolQuery = (tool: string | null) => (tool ? `&tool=${encodeURIComponent(tool)}` : "");
const profileBase = (username: string) => `/api/u/${encodeURIComponent(username)}`;

export const api = {
  authStatus: () => get<AuthStatus>("/api/auth/status"),
  /** The GitHub page to send the browser to; it comes back signed in (or with ?auth_error=). */
  startGithub: (start: GithubStart) => post<{ url: string }>("/api/auth/github", start),
  logout: () => post<{ ok: true }>("/api/auth/logout"),
  adminOverview: () => get<AdminOverview>("/api/admin/overview"),
  adminSettings: () => get<AdminSettings>("/api/admin/settings"),
  setSignupOpen: (signup_open: boolean) => post<AdminSettings>("/api/admin/settings", { signup_open }),
  /** Permanently deletes the signed-in user's usage and quotas. */
  deleteActivity: (confirm: string) =>
    post<{ ok: true; deleted: DeletedActivity }>("/api/account/delete-activity", { confirm }),
  /** Permanently deletes the signed-in user's account; its session goes too. */
  deleteAccount: (confirm: string) =>
    post<{ ok: true; deleted: DeletedAccount }>("/api/account/delete", { confirm }),
  users: () => get<{ users: AdminUser[] }>("/api/users"),
  setUserDisabled: (id: number, disabled: boolean) =>
    post<{ ok: true }>(`/api/users/${id}/${disabled ? "disable" : "enable"}`),
  setUserAdmin: (id: number, is_admin: boolean) => post<{ ok: true }>(`/api/users/${id}/admin`, { is_admin }),
  /** Everyone's usage over the last `days` days, or all time (null). */
  leaderboard: (days: number | null) => get<LeaderboardResponse>(`/api/leaderboard?days=${days ?? "all"}`),
  friends: () => get<FriendsResponse>("/api/friends"),
  // A profile's usage, public by username (the viewer's own page uses it too).
  profile: (username: string) => get<Profile>(profileBase(username)),
  activity: (username: string, days: number, tool: string | null) =>
    get<ActivityResponse>(`${profileBase(username)}/activity?days=${days}${toolQuery(tool)}`),
  quotas: (username: string) => get<QuotasResponse>(`${profileBase(username)}/quotas`),
  summary: (username: string, tool: string | null) =>
    get<SummaryResponse>(`${profileBase(username)}/summary?x=1${toolQuery(tool)}`),
  sessions: (username: string, limit: number, tool: string | null, offset: number) =>
    get<SessionsResponse>(`${profileBase(username)}/sessions?limit=${limit}&offset=${offset}${toolQuery(tool)}`),
  devices: () => get<{ devices: Device[] }>("/api/devices"),
  /** The full key is only ever returned here, once. */
  createDevice: (name: string) => post<{ id: number; key: string }>("/api/devices", { name }),
  deviceKey: (id: number) => get<{ key: string }>(`/api/devices/${id}/key`),
  revokeDevice: (id: number) => post<{ ok: true }>(`/api/devices/${id}/revoke`),
};
