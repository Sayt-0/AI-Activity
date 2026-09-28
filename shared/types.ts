// API response shapes shared by the server and the web client.
// Every numeric field is a measured value; missing data is null/absent,
// never interpolated.

/** Every ingestable tool, in display order. */
export const TOOLS = ["claude-code", "codex", "antigravity", "opencode"] as const;
export type Tool = (typeof TOOLS)[number];

/** Rows kept separate in dashboard breakdown lists (the last is the fold). */
export const BREAKDOWN_DISPLAY_ROWS = 8;

/** Typed by the user to confirm deleting all their activity (POST /api/account/delete-activity). */
export const DELETE_ACTIVITY_PHRASE = "delete my activity";

/** Rows removed by POST /api/account/delete-activity. */
export interface DeletedActivity {
  events: number;
  quotas: number;
}

/** Typed by the user to confirm deleting their account (POST /api/account/delete). */
export const DELETE_ACCOUNT_PHRASE = "delete my account";

/** Rows removed by POST /api/account/delete, besides the account itself. */
export interface DeletedAccount extends DeletedActivity {
  devices: number;
}

export interface StatsResponse {
  range_days: number;
  tool: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
  events: number;
  sessions: number;
  has_data: boolean;
  provenance: string;
}

export interface ActivityDay {
  day: string; // YYYY-MM-DD, the local day where each event happened (UTC without an offset)
  tokens: number;
  sessions: number;
}

export interface ActivityResponse {
  days: ActivityDay[];
  provenance: string;
}

export interface Quota {
  account_ref: string;
  tool: string;
  limit_type: string; // five_hour | seven_day | ...
  used_pct: number;
  resets_at: number | null;
  measured_at: number;
}

export interface QuotasResponse {
  quotas: Quota[];
  provenance: string;
}

export interface Session {
  session_id: string;
  tool: string;
  model: string | null;
  tokens: number;
  last_seen: number;
  events: number;
  /** Context fill at the latest call that reported it; null if never reported. */
  context_used_pct: number | null;
  context_window_size: number | null;
}

export interface SessionsResponse {
  sessions: Session[];
  total: number; // all sessions matching the filter, for "show more"
  provenance: string;
}

export interface BreakdownRow {
  name: string;
  tokens: number;
  sessions: number;
  events: number;
}

export interface Breakdown {
  tokens: number;
  sessions: number;
  events: number;
  by_model: BreakdownRow[];
  /** Distinct sessions across the model rows folded into "others". */
  by_model_others_sessions: number;
  by_tool: BreakdownRow[];
}

export interface SummaryResponse {
  tool: string | null;
  day: string; // the owner's today (at the UTC offset of their latest event; UTC if none), YYYY-MM-DD
  total: Breakdown; // all time
  today: Breakdown;
  provenance: string;
}

export interface Device {
  id: number;
  name: string;
  key_prefix: string;
  revoked: number;
  created_at: number;
  /** The key can be fetched again (GET /api/devices/:id/key); false for revoked or older keys. */
  has_key: boolean;
  /** The collector version of each tool this device posted for, in TOOLS order. */
  collectors: DeviceCollector[];
}

/** The collector versions a device posts with, for one tool. */
export interface DeviceCollector {
  tool: Tool;
  /**
   * The lowest version still posting (seen within a day of the tool's last
   * post), so an old copy next to an updated one shows. 0: from before versions.
   */
  version: number;
  /** When `version` last posted (at most an hour stale: refreshed hourly). */
  seen_at: number;
  /** The version of the tool's last post. */
  newest: number;
  /** The version in this server's collectors/ (COLLECTOR_VERSIONS). */
  latest: number;
  /** `version` is behind `latest`: update it (run the install command again). */
  outdated: boolean;
}

/** In an ingest answer when the collector is behind this server's. */
export interface CollectorUpdate {
  latest: number;
  /** Older collectors than this get 426. */
  minimum: number;
}

export interface Account {
  id: number;
  username: string;
  display_name: string;
  /** https link to the profile picture (allowlisted hosts), or null. */
  avatar_url: string | null;
  is_admin: boolean;
}

/** An account as listed for admins. */
export interface AdminUser extends Account {
  disabled: boolean;
  created_at: number;
  /** Devices with a live (non-revoked) key. */
  devices: number;
}

export interface AuthStatus {
  authenticated: boolean;
  /** The signed-in account; null when signed out. */
  user: Account | null;
  /** No account exists yet: the first one needs the setup code (or the CLI). */
  setup_required: boolean;
  /** Anyone may create an account from the sign-in page (an admin setting). */
  signup_open: boolean;
  /** Sign in with GitHub is set up on this server (GITHUB_CLIENT_ID / _SECRET); else nobody can sign in. */
  github_sign_in: boolean;
}

/** Server settings an admin changes from the admin panel. */
export interface AdminSettings {
  signup_open: boolean;
}

/** Admin panel overview (whole server, all accounts). */
export interface AdminOverview {
  accounts: number;
  disabled_accounts: number;
  /** Devices with a live (non-revoked) key. */
  devices: number;
  events: number;
  sessions: number;
  /** When the server last received usage, or null. */
  last_event_at: number | null;
}

/** A profile page anyone signed in can open (read-only usage). */
export interface Profile {
  username: string;
  display_name: string;
  avatar_url: string | null;
}

export interface ProfilesResponse {
  profiles: Profile[];
}

/** A followed GitHub account with an enabled, public AI Activity profile. */
export interface FriendEntry extends Profile {
  tokens: number;
  sessions: number;
  last_active: number | null;
}

export interface FriendsResponse {
  /** Rolling seven-day window, in Unix seconds. */
  since: number;
  until: number;
  friends: FriendEntry[];
}

/** POST /api/ingest/<tool> with one flat event. */
export interface IngestResult {
  ok: true;
  /** A new message row was created. */
  stored: boolean;
  /** An already stored message got its final (larger) counts. */
  updated: boolean;
  /** Replay of a message already stored with these counts (or more). */
  deduped: boolean;
  /** The message id, or null when the payload carried no usage. */
  event_id: string | null;
  update?: CollectorUpdate;
}

/** POST /api/ingest/<tool> with { messages: [...] }. */
export interface IngestBatchResult {
  ok: true;
  /** Messages with a message id in the payload. */
  messages: number;
  stored: number;
  updated: number;
  deduped: number;
  update?: CollectorUpdate;
}

/** One account on the leaderboard (every enabled account, idle ones with zeros). */
export interface LeaderboardEntry {
  username: string;
  display_name: string;
  avatar_url: string | null;
  tokens: number;
  sessions: number;
  events: number;
  /** Local days with at least one event in the period. */
  active_days: number;
  /** Model with the most tokens in the period; null if never reported. */
  top_model: string | null;
  /** Latest event in the period; null when idle. */
  last_active: number | null;
  /** Consecutive local days with usage ending on the account's today, or yesterday while today has none yet (same rule as a profile's streak). */
  current_streak: number;
}

/** Server-wide usage across every enabled account (public, like profile pages). */
export interface LeaderboardResponse {
  /** Period length; null = all time. */
  range_days: number | null;
  /** Enabled accounts, active or not (= entries.length). */
  accounts: number;
  totals: { tokens: number; sessions: number; events: number; active_accounts: number };
  /** Ranked by tokens, most first. */
  entries: LeaderboardEntry[];
  by_model: BreakdownRow[];
  /** Last day of the activity calendar: the latest account's today (UTC if none), YYYY-MM-DD. */
  day: string;
  /** Everyone's daily buckets over the 364 local days ending on `day`, whatever the period. */
  activity: ActivityDay[];
  provenance: string;
}
