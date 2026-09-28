import { createHash, randomUUID } from "node:crypto";
import type {
  Account, ActivityDay, AdminOverview, AdminUser, Profile, Breakdown, BreakdownRow, DeletedAccount, DeletedActivity, Device, LeaderboardEntry,
  LeaderboardResponse, Quota, Session,
} from "../../shared/types.ts";
import { COLLECTOR_VERSIONS } from "../../shared/collectors.ts";
import { BREAKDOWN_DISPLAY_ROWS, TOOLS } from "../../shared/types.ts";
import { nowSec, type DB } from "./schema.ts";

export interface DeviceRow extends Omit<Device, "has_key" | "collectors"> {
  user_id: number;
  key_hash: string;
  key: string | null;
}

export interface UsageEventInput {
  event_id: string;
  device_id: number;
  user_id: number;
  tool: string;
  session_id: string | null;
  prompt_id: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  context_window_size: number | null;
  context_used_pct: number | null;
  occurred_at: number;
  utc_offset_min: number | null;
  received_at: number;
}

export interface QuotaSnapshotInput {
  device_id: number;
  user_id: number;
  account_ref: string;
  tool: string;
  limit_type: string;
  used_pct: number;
  resets_at: number | null;
  measured_at: number;
}

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  total_tokens: number;
  events: number;
  sessions: number;
}

export function hashKey(rawKey: string): string {
  return createHash("sha256").update(String(rawKey)).digest("hex");
}

export interface UserRow {
  id: number;
  /** The GitHub login (updated at each sign-in). */
  username: string;
  /** GitHub's name; null: the username is shown. */
  display_name: string | null;
  /** GitHub's picture (allowlisted hosts); null: the initial is shown. */
  avatar_url: string | null;
  /** The GitHub account's numeric id (issue #127). */
  github_id: number;
  is_admin: number;
  disabled: number;
}

export function toAccount(u: UserRow): Account {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name || u.username,
    avatar_url: u.avatar_url,
    is_admin: Boolean(u.is_admin),
  };
}

export function toProfile(u: UserRow): Profile {
  const { username, display_name, avatar_url } = toAccount(u);
  return { username, display_name, avatar_url };
}

/** True once at least one account exists; before that nothing is viewable (setup). */
export function accountsExist(db: DB): boolean {
  return Boolean(db.prepare("SELECT 1 FROM users LIMIT 1").get());
}

export function findUserByGithubId(db: DB, githubId: number): UserRow | null {
  return (db.prepare("SELECT * FROM users WHERE github_id = ?").get(githubId) as UserRow | undefined) ?? null;
}

/** A GitHub follow only appears when their public profile is currently enabled. */
export function enabledUserByGithubId(db: DB, githubId: number): UserRow | null {
  return (db.prepare("SELECT * FROM users WHERE github_id = ? AND disabled = 0").get(githubId) as UserRow | undefined) ?? null;
}

/** Latest event in the same rolling period used for a friend's totals. */
export function latestUsageAt(db: DB, userId: number, sinceSec: number): number | null {
  const row = db.prepare("SELECT occurred_at FROM usage_events WHERE user_id = ? AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT 1")
    .get(userId, sinceSec) as { occurred_at: number } | undefined;
  return row?.occurred_at ?? null;
}

export function findUserByUsername(db: DB, username: string): UserRow | null {
  return (db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username) as UserRow | undefined)
    ?? null;
}

export function listUsers(db: DB): UserRow[] {
  return db.prepare("SELECT * FROM users ORDER BY id").all() as UserRow[];
}

/** Accounts that can sign in, i.e. whose profile page exists. */
export function listProfiles(db: DB): Profile[] {
  return (db
    .prepare("SELECT * FROM users WHERE disabled = 0 ORDER BY username COLLATE NOCASE")
    .all() as UserRow[]).map(toProfile);
}

export function getUser(db: DB, id: number): UserRow | null {
  return (db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined) ?? null;
}

/** Accounts as the admin panel shows them, with their device count. */
export function listAdminUsers(db: DB): AdminUser[] {
  const rows = db
    .prepare(
      `SELECT u.*, (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.revoked = 0) AS devices
       FROM users u ORDER BY u.id`
    )
    .all() as (UserRow & { created_at: number; devices: number })[];
  return rows.map((u) => ({ ...toAccount(u), disabled: Boolean(u.disabled), created_at: u.created_at, devices: u.devices }));
}

/** The profile as GitHub gave it at sign-in: username (the login), name and picture. */
export function setGithubProfile(
  db: DB, userId: number, p: { username: string; display_name: string | null; avatar_url: string | null }
): void {
  db.prepare("UPDATE users SET username = ?, display_name = ?, avatar_url = ? WHERE id = ?")
    .run(p.username, p.display_name, p.avatar_url, userId);
}

export function setUsername(db: DB, userId: number, username: string): void {
  db.prepare("UPDATE users SET username = ? WHERE id = ?").run(username, userId);
}

/** Links an account to a GitHub account; the id must not be linked elsewhere (unique index). */
export function setGithubId(db: DB, userId: number, githubId: number): void {
  db.prepare("UPDATE users SET github_id = ? WHERE id = ?").run(githubId, userId);
}

export function setUserAdmin(db: DB, userId: number, isAdmin: boolean): void {
  db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(isAdmin ? 1 : 0, userId);
}

export function setUserDisabled(db: DB, userId: number, disabled: boolean): void {
  db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, userId);
}

/** Create an account for a GitHub account (signing in with it for the first time). */
export function createAccount(
  db: DB,
  a: { username: string; display_name: string | null; avatar_url: string | null; github_id: number; is_admin: boolean }
): number {
  const info = db.prepare(
    "INSERT INTO users (username, display_name, avatar_url, github_id, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(a.username, a.display_name, a.avatar_url, a.github_id, a.is_admin ? 1 : 0, nowSec());
  return Number(info.lastInsertRowid);
}

/** Whether anyone may create an account from the sign-in page (open unless an admin closed it). */
export function signupOpen(db: DB): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'signup_open'").get() as { value: string } | undefined;
  return row?.value !== "0";
}

export function setSignupOpen(db: DB, open: boolean): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('signup_open', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(open ? "1" : "0");
}

/** Counts for the admin overview. */
export function adminOverview(db: DB): AdminOverview {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number | null }).n ?? 0;
  return {
    accounts: n("SELECT COUNT(*) AS n FROM users"),
    disabled_accounts: n("SELECT COUNT(*) AS n FROM users WHERE disabled = 1"),
    devices: n("SELECT COUNT(*) AS n FROM devices WHERE revoked = 0"),
    events: n("SELECT COUNT(*) AS n FROM usage_events"),
    sessions: n("SELECT COUNT(DISTINCT session_id) AS n FROM usage_events"),
    last_event_at: (db.prepare("SELECT MAX(received_at) AS n FROM usage_events").get() as { n: number | null }).n,
  };
}

/** Create the first account only; null when one already exists (lost race). */
export function createFirstAccount(db: DB, a: Parameters<typeof createAccount>[1]): number | null {
  return db.transaction(() => (accountsExist(db) ? null : createAccount(db, a)))();
}

/**
 * Runs `fn` with SQLite's secure_delete on, then truncates the WAL: deleted
 * rows are overwritten with zeros in the database file instead of lingering
 * in free pages or old WAL frames. Backups taken before keep them.
 */
function erasing<T>(db: DB, fn: () => T): T {
  const was = db.pragma("secure_delete", { simple: true });
  db.pragma("secure_delete = ON");
  try {
    return db.transaction(fn)();
  } finally {
    db.pragma(`secure_delete = ${Number(was)}`);
    // Best effort: a reader holding an old snapshot keeps the WAL until the
    // next checkpoint, which overwrites those frames anyway.
    db.pragma("wal_checkpoint(TRUNCATE)");
  }
}

/**
 * Delete every usage event and quota snapshot of one user, in one
 * transaction, and remember when and which messages: ingest refuses them
 * afterwards (activityClearedAt, isDeletedEvent). The account, devices and
 * sessions stay.
 */
export function deleteUserActivity(db: DB, userId: number): DeletedActivity {
  return erasing(db, () => {
    db.prepare(
      `INSERT OR IGNORE INTO deleted_events (user_id, event_id)
       SELECT user_id, event_id FROM usage_events WHERE user_id = ? AND source = 'message'`
    ).run(userId);
    const events = db.prepare("DELETE FROM usage_events WHERE user_id = ?").run(userId).changes;
    const quotas = db.prepare("DELETE FROM quota_snapshots WHERE user_id = ?").run(userId).changes;
    db.prepare("UPDATE users SET activity_cleared_at = ? WHERE id = ?").run(nowSec(), userId);
    return { events, quotas };
  });
}

/** When the user last deleted their activity, or null if never. */
export function activityClearedAt(db: DB, userId: number): number | null {
  const row = db.prepare("SELECT activity_cleared_at AS at FROM users WHERE id = ?").get(userId) as { at: number | null } | undefined;
  return row?.at ?? null;
}

/** Whether the user deleted a message before (deleteUserActivity); prepared once per batch. */
export function deletedEventCheck(db: DB, userId: number): (eventId: string) => boolean {
  const stmt = db.prepare("SELECT 1 FROM deleted_events WHERE user_id = ? AND event_id = ?");
  return (eventId) => stmt.get(userId, eventId) !== undefined;
}

export type DeleteAccountResult = { ok: true; deleted: DeletedAccount } | { ok: false; reason: "last_admin" };

/**
 * Delete an account and everything tied to it, in one transaction: usage,
 * quotas, deleted-message ids, devices and their keys, sessions, the user.
 * The last enabled admin cannot go (checked inside the transaction): an
 * enabled admin always remains. Children first: the foreign keys have no
 * ON DELETE CASCADE.
 */
export function deleteAccount(db: DB, userId: number): DeleteAccountResult {
  return erasing(db, (): DeleteAccountResult => {
    const others = db
      .prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0 AND id != ?")
      .get(userId) as { n: number };
    const user = db.prepare("SELECT is_admin FROM users WHERE id = ?").get(userId) as { is_admin: number } | undefined;
    if (user?.is_admin && others.n === 0) return { ok: false, reason: "last_admin" };
    const run = (sql: string) => db.prepare(sql).run(userId).changes;
    const events = run("DELETE FROM usage_events WHERE user_id = ?");
    const quotas = run("DELETE FROM quota_snapshots WHERE user_id = ?");
    run("DELETE FROM deleted_events WHERE user_id = ?");
    run("DELETE FROM collector_versions WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?)");
    const devices = run("DELETE FROM devices WHERE user_id = ?");
    run("DELETE FROM viewer_sessions WHERE user_id = ?");
    run("DELETE FROM users WHERE id = ?");
    return { ok: true, deleted: { events, quotas, devices } };
  });
}

export function insertViewerSession(db: DB, tokenHash: string, userId: number, expiresAt: number): void {
  const now = nowSec();
  db.prepare("DELETE FROM viewer_sessions WHERE expires_at <= ?").run(now);
  db.prepare(
    "INSERT INTO viewer_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).run(tokenHash, userId, expiresAt, now);
}

/**
 * The user behind a live session, with when that session was opened;
 * expired sessions and disabled users get null.
 */
export function viewerSessionUser(db: DB, tokenHash: string): (UserRow & { session_created_at: number }) | null {
  return (db
    .prepare(
      `SELECT u.*, s.created_at AS session_created_at FROM viewer_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`
    )
    .get(tokenHash, nowSec()) as (UserRow & { session_created_at: number }) | undefined) ?? null;
}

export function deleteViewerSession(db: DB, tokenHash: string): void {
  db.prepare("DELETE FROM viewer_sessions WHERE token_hash = ?").run(tokenHash);
}

/** Sign a user out everywhere, optionally keeping one session. */
export function deleteUserSessions(db: DB, userId: number, keepTokenHash: string | null = null): void {
  db.prepare("DELETE FROM viewer_sessions WHERE user_id = ? AND token_hash IS NOT ?").run(userId, keepTokenHash);
}

export function findDeviceByKey(db: DB, rawKey: string | null): DeviceRow | null {
  if (!rawKey) return null;
  // A disabled account's devices stop being accepted too.
  const row = db
    .prepare(
      `SELECT d.* FROM devices d JOIN users u ON u.id = d.user_id
       WHERE d.key_hash = ? AND u.disabled = 0`
    )
    .get(hashKey(rawKey)) as DeviceRow | undefined;
  if (!row || row.revoked) return null;
  return row;
}

export function createDevice(db: DB, { userId, name }: { userId: number; name: string }) {
  const raw = `ak_${randomUUID().replace(/-/g, "")}`;
  const prefix = raw.slice(0, 10);
  const info = db
    .prepare(
      "INSERT INTO devices (user_id, name, key_hash, key, key_prefix, revoked, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)"
    )
    .run(userId, name || "unnamed device", hashKey(raw), raw, prefix, nowSec());
  return { id: Number(info.lastInsertRowid), key: raw, prefix };
}

/** Revoke one of the user's devices; false when no such device exists. */
export function revokeDevice(db: DB, userId: number, id: number): boolean {
  // A revoked key is useless, so it is not kept either.
  return db.prepare("UPDATE devices SET revoked = 1, key = NULL WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

/** The key of one of the user's live devices; null if none (or made before keys were kept). */
export function getDeviceKey(db: DB, userId: number, id: number): string | null {
  const row = db
    .prepare("SELECT key FROM devices WHERE id = ? AND user_id = ? AND revoked = 0")
    .get(id, userId) as { key: string | null } | undefined;
  return row?.key ?? null;
}

export function countLiveDevices(db: DB, userId: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM devices WHERE user_id = ? AND revoked = 0").get(userId) as { n: number }).n;
}

export function listDevices(db: DB, userId: number): Device[] {
  const rows = db
    .prepare(
      "SELECT id, name, key_prefix, revoked, created_at, key IS NOT NULL AS has_key FROM devices WHERE user_id = ? ORDER BY id"
    )
    .all(userId) as (Omit<Device, "has_key" | "collectors"> & { has_key: number })[];
  const seen = db
    .prepare(
      `SELECT c.device_id, c.tool, c.version, c.seen_at FROM collector_versions c
       JOIN devices d ON d.id = c.device_id WHERE d.user_id = ?`
    )
    .all(userId) as { device_id: number; tool: string; version: number; seen_at: number }[];
  return rows.map((d) => ({
    ...d,
    has_key: Boolean(d.has_key),
    collectors: TOOLS.flatMap((tool) => {
      const mine = seen.filter((s) => s.device_id === d.id && s.tool === tool);
      if (!mine.length) return [];
      const last = mine.reduce((a, b) => (b.seen_at > a.seen_at || (b.seen_at === a.seen_at && b.version > a.version) ? b : a));
      // The lowest version still posting: a copy seen within a day of the
      // tool's last post. An old copy left next to an updated one (a hook
      // running a stale script) stays flagged; one replaced stops a day later.
      const shown = mine
        .filter((s) => s.seen_at >= last.seen_at - COLLECTOR_STILL_POSTING_SEC)
        .reduce((a, b) => (b.version < a.version ? b : a));
      const latest = COLLECTOR_VERSIONS[tool];
      return [{
        tool, version: shown.version, seen_at: shown.seen_at, newest: last.version, latest,
        outdated: shown.version < latest,
      }];
    }),
  }));
}

/** How long after a tool's last post an older collector copy still counts as posting. */
const COLLECTOR_STILL_POSTING_SEC = 86400;

/**
 * A device posted with this collector version. Written when the version is
 * new for the device and tool, else at most hourly (seen_at): every post
 * comes here, and a write would also empty the public read cache.
 */
export function recordCollectorVersion(db: DB, deviceId: number, tool: string, version: number, now: number): void {
  db.prepare(
    `INSERT INTO collector_versions (device_id, tool, version, seen_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (device_id, tool, version) DO UPDATE SET seen_at = excluded.seen_at
     WHERE seen_at < excluded.seen_at - 3600`
  ).run(deviceId, tool, version, now);
}

export type UpsertResult = "stored" | "updated" | "deduped";

/**
 * Store one message's consumption, keyed by its Anthropic message id
 * (event_id). Claude Code writes a response in several transcript entries,
 * sometimes a partial one (a few output tokens) before the final one, so a
 * message seen again with more output tokens replaces the stored counts;
 * anything else is a replay. A message id already owned by another account
 * is never touched.
 */
export function upsertUsageEvent(db: DB, ev: UsageEventInput): UpsertResult {
  return db.transaction((): UpsertResult => {
    const existing = db
      .prepare("SELECT user_id, output_tokens, utc_offset_min FROM usage_events WHERE event_id = ?")
      .get(ev.event_id) as { user_id: number; output_tokens: number; utc_offset_min: number | null } | undefined;
    if (!existing) {
      db.prepare(
        `INSERT INTO usage_events
          (event_id, device_id, user_id, tool, session_id, prompt_id, model,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           context_window_size, context_used_pct, occurred_at, utc_offset_min, received_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'message')`
      ).run(
        ev.event_id, ev.device_id, ev.user_id, ev.tool, ev.session_id, ev.prompt_id, ev.model,
        ev.input_tokens, ev.output_tokens, ev.cache_read_tokens, ev.cache_write_tokens,
        ev.context_window_size, ev.context_used_pct, ev.occurred_at, ev.utc_offset_min, ev.received_at
      );
      return "stored";
    }
    if (existing.user_id !== ev.user_id) return "deduped";
    if (ev.output_tokens <= existing.output_tokens) {
      // A replay from a collector that sends offsets dates an event stored
      // without one (resending the history fixes old days). A known offset
      // never changes: an event's day does not move afterwards.
      if (existing.utc_offset_min === null && ev.utc_offset_min !== null) {
        db.prepare("UPDATE usage_events SET utc_offset_min = ? WHERE event_id = ?").run(ev.utc_offset_min, ev.event_id);
      }
      return "deduped";
    }
    db.prepare(
      `UPDATE usage_events SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
         cache_write_tokens = ?, model = COALESCE(?, model), utc_offset_min = COALESCE(utc_offset_min, ?),
         received_at = ?
       WHERE event_id = ?`
    ).run(
      ev.input_tokens, ev.output_tokens, ev.cache_read_tokens, ev.cache_write_tokens,
      ev.model, ev.utc_offset_min, ev.received_at, ev.event_id
    );
    return "updated";
  })();
}

const SNAPSHOT_SLACK_SEC = 120;

/**
 * Drop a session's old statusLine snapshot rows from sinceSec on, once its
 * messages from that time arrive: the messages are exact, the snapshots
 * counted most calls twice, and the two must never add up. Older snapshot
 * rows stay until messages cover them too (the collector's first run sends
 * whole transcripts, so every session still on disk is fully replaced).
 */
export function dropSnapshotRows(db: DB, userId: number, sessionId: string, sinceSec: number): number {
  // A snapshot is stamped when the statusLine fired, which can be up to about
  // a minute before the transcript's timestamp for the same API call.
  return db
    .prepare("DELETE FROM usage_events WHERE user_id = ? AND session_id = ? AND source = 'snapshot' AND occurred_at >= ?")
    .run(userId, sessionId, sinceSec - SNAPSHOT_SLACK_SEC).changes;
}

/** Put the session's latest context fill on its newest row (a gauge, never summed). */
export function setSessionContext(
  db: DB, userId: number, sessionId: string, usedPct: number | null, windowSize: number | null
): void {
  db.prepare(
    `UPDATE usage_events SET context_used_pct = COALESCE(?, context_used_pct),
       context_window_size = COALESCE(?, context_window_size)
     WHERE event_id = (
       SELECT event_id FROM usage_events WHERE user_id = ? AND session_id = ?
       ORDER BY occurred_at DESC, received_at DESC LIMIT 1
     )`
  ).run(usedPct, windowSize, userId, sessionId);
}

/**
 * Record a quota snapshot. The statusLine re-sends the same window values on
 * every fire, so an unchanged value (same used_pct and resets_at as the
 * latest row) only moves that row's measured_at forward instead of adding
 * a new row.
 */
export function insertQuotaSnapshot(db: DB, q: QuotaSnapshotInput): void {
  const latest = db
    .prepare(
      `SELECT id, used_pct, resets_at FROM quota_snapshots
       WHERE user_id = ? AND account_ref = ? AND tool = ? AND limit_type = ?
       ORDER BY measured_at DESC, id DESC LIMIT 1`
    )
    .get(q.user_id, q.account_ref, q.tool, q.limit_type) as
    { id: number; used_pct: number; resets_at: number | null } | undefined;
  if (latest && latest.used_pct === q.used_pct && latest.resets_at === q.resets_at) {
    db.prepare("UPDATE quota_snapshots SET measured_at = MAX(measured_at, ?) WHERE id = ?")
      .run(q.measured_at, latest.id);
    return;
  }
  db.prepare(
    `INSERT INTO quota_snapshots
      (device_id, user_id, account_ref, tool, limit_type, used_pct, resets_at, measured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(q.device_id, q.user_id, q.account_ref, q.tool, q.limit_type, q.used_pct, q.resets_at, q.measured_at);
}

/** Resets this close to the latest one are the same window (Codex jitter). */
const RESET_JITTER_SEC = 600;

/**
 * Current value per (account_ref, tool, limit_type). Never summed across devices.
 *
 * A device can post stale rate_limits (a second terminal that has not made
 * an API call yet), so "last posted" is not "current". Among the rows
 * measured in the day before the latest one, the window that resets last is
 * the current one, and within a window the usage only goes up: show its
 * highest percentage. Codex reports one window's resets_at a few seconds
 * apart from one snapshot to the next, so resets within RESET_JITTER_SEC of
 * the latest are the same window (a new window resets hours later). Ingest drops
 * a resets_at further away than the window is long; the one-day bound also
 * retires rows stored before that check.
 */
export function latestQuotas(db: DB, userId: number): Quota[] {
  return db
    .prepare(
      `WITH recent AS (
         SELECT q.*, MAX(measured_at) OVER (PARTITION BY account_ref, tool, limit_type) AS last
         FROM quota_snapshots q WHERE user_id = ?
       ), live AS (
         SELECT *, MAX(COALESCE(resets_at, -1)) OVER (PARTITION BY account_ref, tool, limit_type) AS win
         FROM recent WHERE measured_at >= last - 86400
       )
       SELECT account_ref, tool, limit_type, MAX(used_pct) AS used_pct,
              MAX(resets_at) AS resets_at, MAX(measured_at) AS measured_at
       FROM live WHERE COALESCE(resets_at, -1) >= win - ?
       GROUP BY account_ref, tool, limit_type
       ORDER BY account_ref, tool, limit_type`
    )
    .all(userId, RESET_JITTER_SEC) as Quota[];
}

export function usageTotals(db: DB, userId: number, sinceSec: number, tool: string | null): UsageTotals {
  return db
    .prepare(
      `SELECT
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read,
         COALESCE(SUM(cache_write_tokens), 0) AS cache_write,
         COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS total_tokens,
         COUNT(*) AS events,
         COUNT(DISTINCT session_id) AS sessions
       FROM usage_events
       WHERE user_id = ? AND occurred_at >= ?
         AND (? IS NULL OR tool = ?)`
    )
    .get(userId, sinceSec, tool, tool) as UsageTotals;
}

/**
 * An event's day: the local day where and when it happened (like a GitHub
 * contribution), from the device's UTC offset at that time. It never moves
 * afterwards. Events without an offset count as UTC.
 */
const localDay = (t = "") => `date(${t}occurred_at + COALESCE(${t}utc_offset_min, 0) * 60, 'unixepoch')`;

/** The day it is now at a UTC offset (UTC when null), as "YYYY-MM-DD". */
export function dayAt(offsetMin: number | null, now = nowSec()): string {
  return new Date((now + (offsetMin ?? 0) * 60) * 1000).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" n days later (earlier when negative). */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(day + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
}

/** The earliest time an event of that local day can have happened: its midnight at UTC+14. */
export function earliestOfDay(day: string): number {
  return Date.parse(day + "T00:00:00Z") / 1000 - 14 * 3600;
}

/**
 * The UTC offset of the user's latest event that has one: where they are
 * now, as far as we know. "Today" and the streak end on that day, for every
 * visitor of the profile.
 */
export function latestOffset(db: DB, userId: number): number | null {
  const row = db
    .prepare(
      `SELECT utc_offset_min FROM usage_events
       WHERE user_id = ? AND utc_offset_min IS NOT NULL
       ORDER BY occurred_at DESC LIMIT 1`
    )
    .get(userId) as { utc_offset_min: number } | undefined;
  return row?.utc_offset_min ?? null;
}

/** Tokens and sessions per local day of the events since sinceSec. */
export function dailyBuckets(db: DB, userId: number, sinceSec: number, tool: string | null): ActivityDay[] {
  return db
    .prepare(
      `SELECT
         ${localDay()} AS day,
         SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) AS tokens,
         COUNT(DISTINCT session_id) AS sessions
       FROM usage_events
       WHERE user_id = ? AND occurred_at >= ?
         AND (? IS NULL OR tool = ?)
       GROUP BY day ORDER BY day`
    )
    .all(userId, sinceSec, tool, tool) as ActivityDay[];
}

const TOKENS = "input_tokens + output_tokens + cache_read_tokens + cache_write_tokens";

/**
 * Most recent sessions. Model and context fill come from the session's
 * latest event that reported them (the model in use now, not MAX(model) by
 * string order; context is a gauge at that moment, never summed). Both are
 * looked up for the page's sessions only.
 */
export function recentSessions(
  db: DB, userId: number, limit: number, tool: string | null, offset = 0
): Session[] {
  const latest = (col: string, where: string) =>
    `(SELECT ${col} FROM usage_events m
      WHERE m.user_id = s.user_id AND m.session_id = s.session_id AND m.tool = s.tool AND ${where}
      ORDER BY m.occurred_at DESC, m.received_at DESC LIMIT 1)`;
  return db
    .prepare(
      `SELECT s.session_id, s.tool, s.tokens, s.last_seen, s.events,
         ${latest("model", "m.model IS NOT NULL")} AS model,
         ${latest("context_used_pct", "m.context_used_pct IS NOT NULL")} AS context_used_pct,
         ${latest("context_window_size", "m.context_used_pct IS NOT NULL")} AS context_window_size
       FROM (
         SELECT user_id, session_id, tool,
                SUM(${TOKENS}) AS tokens,
                MAX(occurred_at) AS last_seen, COUNT(*) AS events
         FROM usage_events
         WHERE user_id = ? AND session_id IS NOT NULL AND (? IS NULL OR tool = ?)
         GROUP BY session_id, tool
         ORDER BY last_seen DESC, session_id LIMIT ? OFFSET ?
       ) s
       ORDER BY s.last_seen DESC, s.session_id`
    )
    .all(userId, tool, tool, limit, offset) as Session[];
}

export function countSessions(db: DB, userId: number, tool: string | null): number {
  return (db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM usage_events
         WHERE user_id = ? AND session_id IS NOT NULL AND (? IS NULL OR tool = ?)
         GROUP BY session_id, tool
       )`
    )
    .get(userId, tool, tool) as { n: number }).n;
}

type Tally = { tokens: number; events: number; sessions: Set<string> };
const tally = (): Tally => ({ tokens: 0, events: 0, sessions: new Set() });
const add = (t: Tally, tokens: number, events: number, session: string | null) => {
  t.tokens += tokens;
  t.events += events;
  if (session !== null) t.sessions.add(session);
};
/** Rows by tokens (largest first), sessions counted distinct like COUNT(DISTINCT). */
const ranked = (m: Map<string, Tally>): BreakdownRow[] =>
  [...m].map(([name, t]) => ({ name, tokens: t.tokens, sessions: t.sessions.size, events: t.events }))
    .sort((a, b) => b.tokens - a.tokens || (a.name < b.name ? -1 : 1));

/**
 * Tokens, sessions and events since sinceSec (and on that local day, when
 * given), split by model and by tool, from one pass over the covering index
 * (grouped per model, tool and session, then folded here).
 */
export function breakdown(
  db: DB, userId: number, sinceSec: number, tool: string | null, day: string | null = null
): Breakdown {
  const groups = db
    .prepare(
      `SELECT COALESCE(model, 'unknown') AS model, tool, session_id,
              SUM(${TOKENS}) AS tokens, COUNT(*) AS events
       FROM usage_events
       WHERE user_id = ? AND occurred_at >= ? AND (? IS NULL OR tool = ?)
         AND (? IS NULL OR ${localDay()} = ?)
       GROUP BY model, tool, session_id`
    )
    .all(userId, sinceSec, tool, tool, day, day) as { model: string; tool: string; session_id: string | null; tokens: number; events: number }[];
  const total = tally();
  const byModel = new Map<string, Tally>();
  const byTool = new Map<string, Tally>();
  for (const g of groups) {
    add(total, g.tokens, g.events, g.session_id);
    if (!byModel.has(g.model)) byModel.set(g.model, tally());
    add(byModel.get(g.model)!, g.tokens, g.events, g.session_id);
    if (!byTool.has(g.tool)) byTool.set(g.tool, tally());
    add(byTool.get(g.tool)!, g.tokens, g.events, g.session_id);
  }
  const byModelRows = ranked(byModel);
  // ShareList orders the Sessions rows by their session count. Its folded
  // models can overlap, so sum their session sets as a union, not their row
  // counts. The grouped query already returned model + session from the
  // covering read index; this needs no second database pass.
  const foldedModels = byModelRows.length > BREAKDOWN_DISPLAY_ROWS
    ? [...byModelRows].sort((a, b) => b.sessions - a.sessions || (a.name < b.name ? -1 : 1)).slice(BREAKDOWN_DISPLAY_ROWS - 1)
    : [];
  const foldedSessions = new Set<string>();
  for (const row of foldedModels) {
    for (const session of byModel.get(row.name)?.sessions ?? []) foldedSessions.add(session);
  }
  return {
    tokens: total.tokens,
    sessions: total.sessions.size,
    events: total.events,
    by_model: byModelRows,
    by_model_others_sessions: foldedSessions.size,
    by_tool: ranked(byTool),
  };
}

/**
 * Everyone's usage since sinceSec, ranked by tokens. The global heatmap
 * covers calendarDays local days and ignores the period, like the streaks
 * (each counted back from that account's own today). Disabled accounts
 * never appear. Two grouped passes over the covering index (the period, and
 * the heatmap year), folded here.
 */
export function leaderboard(
  db: DB, sinceSec: number, calendarDays: number, now = nowSec()
): Omit<LeaderboardResponse, "range_days" | "provenance"> {
  // Every enabled account, used or not: idle ones rank last with zeros.
  const users = db
    .prepare(
      `SELECT id, username, display_name, avatar_url FROM users
       WHERE disabled = 0`
    )
    .all() as { id: number; username: string; display_name: string | null; avatar_url: string | null }[];
  const today = new Map(users.map((u) => [u.id, dayAt(latestOffset(db, u.id), now)]));
  // The calendar ends on the latest of those days (UTC with no account).
  const lastDay = [...today.values()].reduce((a, d) => (d > a ? d : a), dayAt(null, now));
  const firstDay = addDays(lastDay, -(calendarDays - 1));
  const activitySinceSec = earliestOfDay(firstDay);
  const LISTED_FROM = `usage_events e JOIN users u ON u.id = e.user_id
    WHERE u.disabled = 0`;
  // The period, per user, session, model and day…
  const groups = db
    .prepare(
      `SELECT e.user_id, e.session_id, e.model, ${localDay("e.")} AS day,
              SUM(${TOKENS}) AS tokens, COUNT(*) AS events, MAX(e.occurred_at) AS last
       FROM ${LISTED_FROM} AND e.occurred_at >= ?
       GROUP BY e.user_id, e.session_id, e.model, day`
    )
    .all(sinceSec) as {
      user_id: number; session_id: string | null; model: string | null; day: string;
      tokens: number; events: number; last: number;
    }[];
  // …and the heatmap year, per user, day and session (models do not matter there).
  const yearDays = db
    .prepare(
      `SELECT e.user_id, ${localDay("e.")} AS day, e.session_id, SUM(${TOKENS}) AS tokens
       FROM ${LISTED_FROM} AND e.occurred_at >= ?
       GROUP BY e.user_id, day, e.session_id`
    )
    .all(activitySinceSec) as { user_id: number; day: string; session_id: string | null; tokens: number }[];

  type Acc = Tally & { days: Set<string>; last: number | null; models: Map<string, number>; streakDays: Set<string> };
  const acc = new Map<number, Acc>(users.map((u) => [u.id, {
    ...tally(), days: new Set<string>(), last: null, models: new Map<string, number>(), streakDays: new Set<string>(),
  }]));
  const total = tally();
  const byModel = new Map<string, Tally>();
  const activity = new Map<string, Tally>();
  for (const d of yearDays) {
    acc.get(d.user_id)!.streakDays.add(d.day);
    if (d.day < firstDay) continue;
    if (!activity.has(d.day)) activity.set(d.day, tally());
    add(activity.get(d.day)!, d.tokens, 0, d.session_id);
  }
  for (const g of groups) {
    const a = acc.get(g.user_id)!;
    add(a, g.tokens, g.events, g.session_id);
    add(total, g.tokens, g.events, g.session_id);
    a.days.add(g.day);
    a.last = Math.max(a.last ?? 0, g.last);
    if (g.model !== null) a.models.set(g.model, (a.models.get(g.model) ?? 0) + g.tokens);
    const name = g.model ?? "unknown";
    if (!byModel.has(name)) byModel.set(name, tally());
    add(byModel.get(name)!, g.tokens, g.events, g.session_id);
  }

  // Consecutive active days counted back from that account's today, or from
  // yesterday while today has no usage yet (same rule as a profile's streak).
  const streak = (days: Set<string>, todayIso: string) => {
    let n = 0;
    let t = Date.parse(todayIso + "T00:00:00Z");
    if (!days.has(todayIso)) t -= 86400000;
    for (; days.has(new Date(t).toISOString().slice(0, 10)); t -= 86400000) n++;
    return n;
  };
  // Most tokens, then the model name, like ORDER BY SUM(tokens) DESC, model.
  const topModel = (m: Map<string, number>) =>
    [...m].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0]?.[0] ?? null;
  // SQLite's NOCASE: ASCII letters folded, everything else by code point.
  const nocase = (v: string) => v.replace(/[A-Z]/g, (ch) => ch.toLowerCase());

  const entries = users.map((u) => {
    const a = acc.get(u.id)!;
    return {
      username: u.username,
      display_name: u.display_name || u.username,
      avatar_url: u.avatar_url,
      tokens: a.tokens,
      sessions: a.sessions.size,
      events: a.events,
      active_days: a.days.size,
      last_active: a.last,
      top_model: topModel(a.models),
      current_streak: streak(a.streakDays, today.get(u.id)!),
    };
  }).sort((x, y) => y.tokens - x.tokens || (nocase(x.username) < nocase(y.username) ? -1 : nocase(x.username) > nocase(y.username) ? 1 : 0));

  return {
    accounts: users.length,
    totals: {
      tokens: total.tokens, sessions: total.sessions.size, events: total.events,
      active_accounts: entries.filter((e) => e.events > 0).length,
    },
    entries,
    by_model: ranked(byModel),
    day: lastDay,
    activity: [...activity].sort((x, y) => (x[0] < y[0] ? -1 : 1))
      .map(([day, t]) => ({ day, tokens: t.tokens, sessions: t.sessions.size })),
  };
}
