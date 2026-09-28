import fs from "node:fs";
import Database from "better-sqlite3";
import os from "node:os";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { COLLECTOR_VERSIONS } from "../shared/collectors.ts";
import {
  startServer, req, newDevice, event, collector, codexResponse, opencodeMessage, login, register, userId, TEST_ADMIN,
  awayFromMidnight, githubSignIn, githubUser, githubFollowing, renameGithubUser, githubRequests, githubCode,
} from "./helpers.js";

/** A plausible reset time for a current quota window (a far-future one is dropped). */
const soon = () => Math.floor(Date.now() / 1000) + 3600;

describe("basics (signed in as the test admin)", () => {
  let srv, key;
  const stats = async () => (await req(srv.base, "GET", "/api/u/admin/stats?days=730")).json;

  before(async () => {
    srv = await startServer();
    key = (await newDevice(srv.base)).key;
  });
  after(() => srv.stop());

  test("health", async () => {
    const r = await req(srv.base, "GET", "/api/health");
    assert.deepEqual(r.json, { ok: true });
  });

  test("ingest rejects missing, unknown and revoked keys", async () => {
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: event() })).status, 401);
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: event(), key: "ak_nope" })).status, 401);
    const d = await newDevice(srv.base, "to-revoke");
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: event(), key: d.key })).status, 200);
    assert.equal((await req(srv.base, "POST", `/api/devices/${d.id}/revoke`)).status, 200);
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: event(), key: d.key })).status, 401);
    // Idempotent: SQLite counts matched rows even when the value is unchanged.
    assert.equal((await req(srv.base, "POST", `/api/devices/${d.id}/revoke`)).status, 200);
    assert.equal((await req(srv.base, "POST", "/api/devices/999999/revoke")).status, 404);
  });

  test("a device key can be copied again, one at a time, by its owner only", async () => {
    const d = await newDevice(srv.base, "to-copy");
    const listed = (await req(srv.base, "GET", "/api/devices")).json.devices.find((x) => x.id === d.id);
    assert.equal(listed.has_key, true);
    assert.equal(listed.key, undefined);
    assert.deepEqual((await req(srv.base, "GET", `/api/devices/${d.id}/key`)).json, { key: d.key });
    assert.equal((await req(srv.base, "GET", `/api/devices/${d.id}/key`, { anon: true })).status, 401);
    const eve = await register(srv.base, "keyeve");
    assert.equal((await req(srv.base, "GET", `/api/devices/${d.id}/key`, { cookie: eve.cookie })).status, 404);
    assert.equal((await req(srv.base, "GET", "/api/devices/999999/key")).status, 404);
    // Revoking forgets the key.
    assert.equal((await req(srv.base, "POST", `/api/devices/${d.id}/revoke`)).status, 200);
    assert.equal((await req(srv.base, "GET", `/api/devices/${d.id}/key`)).status, 404);
    const revoked = (await req(srv.base, "GET", "/api/devices")).json.devices.find((x) => x.id === d.id);
    assert.equal(revoked.has_key, false);
  });

  test("collector versions: recorded per device and tool, outdated ones get an update hint", async () => {
    const d = await newDevice(srv.base, "versions");
    const post = (tool, body) => req(srv.base, "POST", `/api/ingest/${tool}`, { body, key: d.key });
    const listed = async () => (await req(srv.base, "GET", "/api/devices")).json.devices.find((x) => x.id === d.id).collectors;
    // The installer's key check (an empty body) is not a collector.
    const check = await post("claude-code", {});
    assert.equal(check.status, 200);
    assert.equal(check.json.update, undefined);
    assert.deepEqual(await listed(), []);
    // No version (a copy from before versions): version 0, told to update.
    const old = await post("claude-code", event({ collector: undefined }));
    assert.equal(old.status, 200);
    assert.equal(old.json.stored, true);
    assert.deepEqual(old.json.update, { latest: COLLECTOR_VERSIONS["claude-code"], minimum: 0 });
    // Another tool's name, or a version that is not a positive integer, counts as 0 too.
    for (const collector of [{ name: "claude-code", version: 1 }, { name: "codex", version: "1" }, { name: "codex", version: 1.5 }, "codex"]) {
      assert.ok((await post("codex", { messages: [], collector })).json.update, JSON.stringify(collector));
    }
    let rows = await listed();
    assert.deepEqual(rows.map((c) => [c.tool, c.version, c.outdated]), [["claude-code", 0, true], ["codex", 0, true]]);
    assert.equal(rows[0].latest, COLLECTOR_VERSIONS["claude-code"]);
    assert.ok(Math.abs(rows[0].seen_at - Date.now() / 1000) < 60);
    // The current collector: no hint. The old copy posted within a day, so
    // the device still shows it: an old copy next to an updated one.
    for (const tool of ["claude-code", "codex"]) {
      const r = await post(tool, { messages: [], collector: collector(tool) });
      assert.equal(r.status, 200);
      assert.equal(r.json.update, undefined);
    }
    rows = await listed();
    assert.deepEqual(rows.map((c) => [c.tool, c.version, c.newest, c.outdated]),
      [["claude-code", 0, COLLECTOR_VERSIONS["claude-code"], true], ["codex", 0, COLLECTOR_VERSIONS.codex, true]]);
    // Once the old copy has not posted for over a day before the last post, it is gone.
    const db = new Database(srv.dbPath);
    try {
      db.prepare("UPDATE collector_versions SET seen_at = seen_at - 90000 WHERE device_id = ? AND version = 0").run(d.id);
    } finally {
      db.close();
    }
    rows = await listed();
    assert.deepEqual(rows.map((c) => [c.tool, c.version, c.outdated]),
      [["claude-code", COLLECTOR_VERSIONS["claude-code"], false], ["codex", COLLECTOR_VERSIONS.codex, false]]);
    // One flat event carries the hint too.
    assert.ok((await post("claude-code", event({ collector: undefined }))).json.update);
  });

  test("a known collector version is written at most hourly (a write empties the read cache)", async () => {
    const d = await newDevice(srv.base, "versions-hourly");
    const post = () => req(srv.base, "POST", "/api/ingest/codex", { body: { messages: [], collector: collector("codex") }, key: d.key });
    const db = new Database(srv.dbPath);
    const seenAt = () => db.prepare("SELECT seen_at FROM collector_versions WHERE device_id = ?").get(d.id).seen_at;
    const age = (sec) => db.prepare("UPDATE collector_versions SET seen_at = seen_at - ? WHERE device_id = ?").run(sec, d.id);
    try {
      assert.equal((await post()).status, 200);
      age(1800);
      const half = seenAt();
      assert.equal((await post()).status, 200);
      assert.equal(seenAt(), half); // within the hour: untouched
      age(1900);
      assert.equal((await post()).status, 200);
      assert.ok(Math.abs(seenAt() - Date.now() / 1000) < 60); // over an hour: refreshed
    } finally {
      db.close();
    }
  });

  test("ingest rejects bad JSON, oversized bodies and unsupported tools", async () => {
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { raw: "{nope", key })).status, 400);
    const big = JSON.stringify({ pad: "x".repeat(300 * 1024) });
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { raw: big, key })).status, 413);
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: event({ tool: "codex" }), key })).status, 400);
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: event({ tool: "claude" }), key })).status, 400);
  });

  test("ingest is routed by tool slug, with no default tool", async () => {
    // anon: collectors send a device key, never a viewer session cookie.
    const post = (p, body = event()) => req(srv.base, "POST", p, { body, key, anon: true });
    assert.equal((await post("/api/ingest")).status, 404);
    assert.equal((await post("/api/ingest/")).status, 404);
    assert.equal((await post("/api/ingest/cursor", event({ tool: "cursor" }))).status, 404);
    assert.equal((await post("/api/ingest/constructor")).status, 404);
    assert.equal((await req(srv.base, "GET", "/api/ingest/claude-code", { anon: true })).status, 404);
    assert.equal((await post("/api/ingest/claude-code")).json.stored, true);
    // The payload's tool is optional: the URL already says which tool it is.
    const { tool, ...noTool } = event({ session_id: "slug-only" });
    const r = await req(srv.base, "POST", "/api/ingest/claude-code", { body: noTool, key });
    assert.equal(r.json.stored, true);
  });

  test("measured event shows up in stats, activity and sessions", async () => {
    const before = await stats();
    const ev = event({ session_id: "sess-A" });
    const r = await req(srv.base, "POST", "/api/ingest/claude-code", { body: ev, key });
    assert.equal(r.json.stored, true);
    assert.equal(r.json.deduped, false);
    const after = await stats();
    assert.equal(after.total_tokens - before.total_tokens, 180);
    assert.equal(after.events - before.events, 1);
    assert.equal(after.has_data, true);
    const sessions = (await req(srv.base, "GET", "/api/u/admin/sessions?limit=50")).json.sessions;
    assert.ok(sessions.some((s) => s.session_id === "sess-A" && s.tokens === 180));
  });

  test("replaying the same event_id is deduped, totals unchanged", async () => {
    const ev = event();
    await req(srv.base, "POST", "/api/ingest/claude-code", { body: ev, key });
    const mid = await stats();
    const r = await req(srv.base, "POST", "/api/ingest/claude-code", { body: ev, key });
    assert.equal(r.json.deduped, true);
    assert.deepEqual(await stats(), mid);
  });

  test("same message id: partial then final keeps the final counts, never both", async () => {
    const mid = await stats();
    const partial = event({ event_id: "msg_partial_final", usage: { input_tokens: 2, cache_creation_input_tokens: 8000, output_tokens: 3 } });
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: partial, key })).json.stored, true);
    const final = { ...partial, usage: { ...partial.usage, output_tokens: 983 } };
    const up = await req(srv.base, "POST", "/api/ingest/claude-code", { body: final, key });
    assert.equal(up.json.updated, true);
    // A late partial (fewer output tokens) or an exact replay changes nothing.
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: partial, key })).json.deduped, true);
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: final, key })).json.deduped, true);
    const after = await stats();
    assert.equal(after.total_tokens - mid.total_tokens, 2 + 8000 + 983);
    assert.equal(after.events - mid.events, 1);
  });

  test("batch of transcript messages: one row per message id", async () => {
    const mid = await stats();
    const msg = (id, out) => ({ message_id: id, session_id: "batch-s", model: "claude-opus-5-5", occurred_at: Math.floor(Date.now() / 1000), usage: { input_tokens: 10, output_tokens: out } });
    const body = {
      messages: [msg("msg_b1", 5), msg("msg_b1", 40), msg("msg_b2", 7), { session_id: "batch-s", usage: { input_tokens: 99 } }],
      rate_limits: { five_hour: { used_percentage: 33, resets_at: soon() } },
      account_ref: "batch-acct",
      context: { session_id: "batch-s", used_pct: 61, window_size: 200000 },
      collector: collector("claude-code"),
    };
    const r = (await req(srv.base, "POST", "/api/ingest/claude-code", { body, key })).json;
    // The entry without a message id is ignored: it cannot be deduplicated.
    assert.deepEqual(r, { ok: true, messages: 3, stored: 2, updated: 1, deduped: 0 });
    const again = (await req(srv.base, "POST", "/api/ingest/claude-code", { body, key })).json;
    assert.deepEqual(again, { ok: true, messages: 3, stored: 0, updated: 0, deduped: 3 });
    const after = await stats();
    assert.equal(after.total_tokens - mid.total_tokens, 50 + 17);
    assert.equal(after.events - mid.events, 2);
    const q = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas;
    assert.ok(q.some((x) => x.account_ref === "batch-acct" && x.used_pct === 33));
    const s = (await req(srv.base, "GET", "/api/u/admin/sessions?limit=50")).json.sessions.find((x) => x.session_id === "batch-s");
    assert.equal(s.context_used_pct, 61);
    assert.equal(s.context_window_size, 200000);
  });

  test("messages replace a session's old statusLine snapshot rows", async () => {
    const mid = await stats();
    // Rows written by the old snapshot collector (the migration marks them 'snapshot').
    const db = new Database(srv.dbPath);
    const { id: deviceId, user_id: uid } = db.prepare("SELECT id, user_id FROM devices ORDER BY id LIMIT 1").get();
    const legacy = db.prepare(
      `INSERT INTO usage_events (event_id, device_id, user_id, tool, session_id, input_tokens, output_tokens, occurred_at, received_at, source)
       VALUES (?, ?, ?, 'claude-code', ?, 500, 5, ?, ?, 'snapshot')`
    );
    const t = Math.floor(Date.now() / 1000);
    legacy.run("old-1", deviceId, uid, "legacy-s", t, t);
    legacy.run("old-2", deviceId, uid, "legacy-s", t, t);
    legacy.run("old-3", deviceId, uid, "other-s", t, t);
    legacy.run("old-early", deviceId, uid, "legacy-s", t - 3600, t - 3600);
    db.close();
    assert.equal((await stats()).total_tokens - mid.total_tokens, 4 * 505);

    const body = { messages: [{ message_id: "msg_legacy_1", session_id: "legacy-s", occurred_at: t, usage: { input_tokens: 500, output_tokens: 5 } }] };
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body, key })).json.stored, 1);
    // From the message's time on, legacy-s counts its one real message.
    // other-s and legacy-s's earlier snapshot (not covered yet) are kept.
    assert.equal((await stats()).total_tokens - mid.total_tokens, 505 + 505 + 505);
    // Once messages reach back that far (the README import), it goes too.
    const early = { messages: [{ message_id: "msg_legacy_0", session_id: "legacy-s", occurred_at: t - 3600, usage: { input_tokens: 1 } }] };
    await req(srv.base, "POST", "/api/ingest/claude-code", { body: early, key });
    assert.equal((await stats()).total_tokens - mid.total_tokens, 505 + 1 + 505);
  });

  test("a snapshot stamped just before its message is replaced too", async () => {
    const mid = await stats();
    const db = new Database(srv.dbPath);
    const { id: deviceId, user_id: uid } = db.prepare("SELECT id, user_id FROM devices ORDER BY id LIMIT 1").get();
    const t = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO usage_events (event_id, device_id, user_id, tool, session_id, input_tokens, occurred_at, received_at, source)
       VALUES ('early-snap', ?, ?, 'claude-code', 'slack-s', 700, ?, ?, 'snapshot')`
    ).run(deviceId, uid, t - 38, t - 38);
    db.close();
    const body = { messages: [{ message_id: "msg_slack_1", session_id: "slack-s", occurred_at: t, usage: { input_tokens: 700 } }] };
    await req(srv.base, "POST", "/api/ingest/claude-code", { body, key });
    assert.equal((await stats()).total_tokens - mid.total_tokens, 700);
  });

  test("quota shows the current window's highest value, not the last post", async () => {
    const now = Math.floor(Date.now() / 1000);
    const post = (pct, resets, at) => req(srv.base, "POST", "/api/ingest/claude-code", {
      key, body: { account_ref: "stale", occurred_at: at, rate_limits: { five_hour: { used_percentage: pct, resets_at: resets } } },
    });
    const shown = async () => (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas.find((q) => q.account_ref === "stale");
    // A far-future reset is dropped at ingest: it would pin the window.
    await post(23.5, 1999999999, now - 30);
    assert.equal(await shown(), undefined);
    // A day-old bogus row stored before that check must not win either.
    const db = new Database(srv.dbPath);
    const { id: deviceId, user_id: uid } = db.prepare("SELECT id, user_id FROM devices ORDER BY id LIMIT 1").get();
    db.prepare(
      `INSERT INTO quota_snapshots (device_id, user_id, account_ref, tool, limit_type, used_pct, resets_at, measured_at)
       VALUES (?, ?, 'stale', 'claude-code', 'five_hour', 23.5, 1999999999, ?)`
    ).run(deviceId, uid, now - 2 * 86400);
    db.close();
    await post(35, now + 3600, now - 60);
    // A second terminal posts the same window's older, lower value later.
    await post(20, now + 3600, now - 10);
    assert.deepEqual([(await shown()).used_pct, (await shown()).resets_at], [35, now + 3600]);
    // Codex jitters a window's resets_at by a few seconds: still that window.
    await post(40, now + 3599, now - 8);
    assert.deepEqual([(await shown()).used_pct, (await shown()).resets_at], [40, now + 3600]);
    // …or the previous, already reset window.
    await post(90, now - 100, now - 5);
    assert.equal((await shown()).used_pct, 40);
    // The next window replaces it, even with a lower value.
    await post(4, now + 18000, now);
    assert.deepEqual([(await shown()).used_pct, (await shown()).resets_at], [4, now + 18000]);
  });

  test("usage without an Anthropic message id is not stored", async () => {
    const before = await stats();
    // The old reference collector sent a fresh random UUID on every fire.
    for (const id of ["0b9f1c2e-5d6a-4f7b-8c9d-0e1f2a3b4c5d", "e-123", "msg_", "msg_bad id"]) {
      const r = await req(srv.base, "POST", "/api/ingest/claude-code", { body: event({ event_id: id }), key });
      assert.deepEqual(r.json, { ok: true, stored: false, updated: false, deduped: false, event_id: null });
    }
    const batch = { messages: [{ message_id: "not-a-message-id", usage: { input_tokens: 5 } }] };
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: batch, key })).json.messages, 0);
    assert.equal((await stats()).total_tokens, before.total_tokens);
  });

  test("a message id stored by another account is never overwritten", async () => {
    const bob = await register(srv.base, "msgbob");
    const bobKey = (await newDevice(srv.base, "bob-dev", bob.cookie)).key;
    const mine = event({ event_id: "msg_shared_id", usage: { input_tokens: 1, output_tokens: 1 } });
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: mine, key })).json.stored, true);
    const theirs = { ...mine, usage: { input_tokens: 1, output_tokens: 999999 } };
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: theirs, key: bobKey })).json.deduped, true);
    const bobStats = (await req(srv.base, "GET", "/api/u/msgbob/stats?days=730")).json;
    assert.equal(bobStats.total_tokens, 0);
  });

  test("empty snapshot stores no usage row but records quotas", async () => {
    const before = await stats();
    const r = await req(srv.base, "POST", "/api/ingest/claude-code", {
      key,
      body: event({ usage: {}, account_ref: "empty-acct", rate_limits: { five_hour: { used_percentage: 12, resets_at: soon() } } }),
    });
    assert.equal(r.json.stored, false);
    assert.equal((await stats()).events, before.events);
    const q = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas;
    assert.ok(q.some((x) => x.account_ref === "empty-acct" && x.used_pct === 12));
  });

  test("raw statusLine snapshot stores no usage (it re-fires per API call) but keeps quotas", async () => {
    const before = await stats();
    const r = await req(srv.base, "POST", "/api/ingest/claude-code", {
      key,
      body: {
        session_id: "raw-sess", prompt_id: "raw-p",
        model: { id: "claude-sonnet-5", display_name: "Sonnet" },
        context_window: { current_usage: { input_tokens: 1000, output_tokens: 1 } },
        rate_limits: { seven_day: { used_percentage: 44, resets_at: soon() } },
        account_ref: "raw-acct",
        cost: { total_cost_usd: 99 },
        collector: collector("claude-code"),
      },
    });
    assert.deepEqual(r.json, { ok: true, stored: false, updated: false, deduped: false, event_id: null });
    const after = await stats();
    assert.equal(after.total_tokens, before.total_tokens);
    assert.equal(after.estimated_usd, undefined);
    const q = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas;
    assert.ok(q.some((x) => x.account_ref === "raw-acct" && x.used_pct === 44));
  });

  test("two devices on the same account: latest quota snapshot wins, never summed", async () => {
    const other = (await newDevice(srv.base, "second")).key;
    const resets = soon();
    const rl = (pct) => ({ five_hour: { used_percentage: pct, resets_at: resets } });
    // measured_at has 1 s resolution: separate the posts by two seconds.
    const at = Math.floor(Date.now() / 1000);
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ account_ref: "shared", rate_limits: rl(30), occurred_at: at - 2 }) });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key: other, body: event({ account_ref: "shared", rate_limits: rl(45), occurred_at: at }) });
    const rows = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas
      .filter((q) => q.account_ref === "shared" && q.limit_type === "five_hour");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].used_pct, 45);
  });

  test("snapshots within the same second still yield one row per window", async () => {
    const rl = (pct) => ({ seven_day: { used_percentage: pct } });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ account_ref: "fast", rate_limits: rl(10) }) });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ account_ref: "fast", rate_limits: rl(11) }) });
    const rows = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas.filter((q) => q.account_ref === "fast");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].used_pct, 11);
  });

  test("a replayed stale snapshot does not replace a newer quota", async () => {
    const now = Math.floor(Date.now() / 1000);
    const q = (pct) => ({ five_hour: { used_percentage: pct, resets_at: now + 3600 } });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ account_ref: "replay", rate_limits: q(60), occurred_at: now }) });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ account_ref: "replay", rate_limits: q(10), occurred_at: now - 7200 }) });
    const quotas = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas.filter((x) => x.account_ref === "replay");
    assert.equal(quotas.length, 1);
    assert.equal(quotas[0].used_pct, 60);
  });

  test("an unchanged quota value refreshes its measured_at", async () => {
    const now = Math.floor(Date.now() / 1000);
    const q = { seven_day: { used_percentage: 12, resets_at: now + 86400 } };
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ account_ref: "same", rate_limits: q, occurred_at: now - 60 }) });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ account_ref: "same", rate_limits: q, occurred_at: now }) });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ account_ref: "same", rate_limits: q, occurred_at: now - 30 }) });
    const rows = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas.filter((x) => x.account_ref === "same");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].used_pct, 12);
    assert.equal(rows[0].measured_at, now);
  });

  test("payload without rate_limits creates no quota rows", async () => {
    const before = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas.length;
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ account_ref: "no-limits" }) });
    const q = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas;
    assert.equal(q.length, before);
    assert.ok(!q.some((x) => x.account_ref === "no-limits"));
  });

  test("spooled events with old occurred_at land on their own day, ordered", async () => {
    const day = 86400;
    const now = Math.floor(Date.now() / 1000);
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ occurred_at: now - 3 * day }) });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ occurred_at: (now - 10 * day) * 1000 }) }); // ms accepted
    const days = (await req(srv.base, "GET", "/api/u/admin/activity?days=30")).json.days.map((d) => d.day);
    assert.deepEqual(days, [...days].sort());
    const iso = (s) => new Date(s * 1000).toISOString().slice(0, 10);
    assert.ok(days.includes(iso(now - 3 * day)));
    assert.ok(days.includes(iso(now - 10 * day)));
  });

  test("occurred_at in the future is clamped to the receive time", async () => {
    const now = Math.floor(Date.now() / 1000);
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ session_id: "future", occurred_at: now + 400 * 86400 }) });
    const s = (await req(srv.base, "GET", "/api/u/admin/sessions?limit=200")).json.sessions.find((x) => x.session_id === "future");
    assert.ok(s.last_seen <= Math.floor(Date.now() / 1000));
    assert.ok(s.last_seen >= now);
  });

  test("a session reports its latest model, not the largest name", async () => {
    const now = Math.floor(Date.now() / 1000);
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ session_id: "switch", model: "claude-sonnet-5", occurred_at: now - 60 }) });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ session_id: "switch", model: "claude-opus-5-5", occurred_at: now }) });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ session_id: "switch", model: "claude-haiku-4-5", occurred_at: now - 30 }) });
    const s = (await req(srv.base, "GET", "/api/u/admin/sessions?limit=200")).json.sessions.find((x) => x.session_id === "switch");
    assert.equal(s.model, "claude-opus-5-5");
  });

  test("sessions page with offset past the per-request cap", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 5; i++) {
      await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ session_id: `page-${i}`, occurred_at: now + i }) });
    }
    const all = (await req(srv.base, "GET", "/api/u/admin/sessions?limit=200")).json;
    const p1 = (await req(srv.base, "GET", "/api/u/admin/sessions?limit=2")).json.sessions;
    const p2 = (await req(srv.base, "GET", "/api/u/admin/sessions?limit=2&offset=2")).json.sessions;
    assert.deepEqual([...p1, ...p2].map((s) => s.session_id), all.sessions.slice(0, 4).map((s) => s.session_id));
    const past = (await req(srv.base, "GET", `/api/u/admin/sessions?limit=5&offset=${all.total}`)).json;
    assert.deepEqual(past.sessions, []);
    assert.equal(past.total, all.total);
  });

  test("removed routes are gone", async () => {
    assert.equal((await req(srv.base, "GET", "/api/billing")).status, 404);
    // Own usage is read from the public profile, like anyone else's.
    for (const p of ["/api/stats", "/api/activity", "/api/quotas", "/api/summary", "/api/sessions"]) {
      assert.equal((await req(srv.base, "GET", p)).status, 404, p);
    }
    assert.equal((await req(srv.base, "POST", "/api/billing/subscription", { body: { tool: "claude-code" } })).status, 404);
  });

  test("tool filter on stats", async () => {
    const r = (await req(srv.base, "GET", "/api/u/admin/stats?days=30&tool=codex")).json;
    assert.equal(r.events, 0);
    assert.equal(r.has_data, false);
  });

  test("device list never exposes key hashes", async () => {
    const devices = (await req(srv.base, "GET", "/api/devices")).json.devices;
    assert.ok(devices.length > 0);
    for (const d of devices) {
      assert.equal(d.key_hash, undefined);
      assert.equal(d.key, undefined);
    }
  });

  test("static index is served, unknown API is 404", async () => {
    const home = await req(srv.base, "GET", "/");
    assert.equal(home.status, 200);
    assert.match(home.headers.get("content-type"), /text\/html/);
    assert.equal((await req(srv.base, "GET", "/api/nope")).status, 404);
    const deep = await req(srv.base, "GET", "/some/client/route");
    assert.equal(deep.status, 200);
    assert.equal(deep.text, home.text);
  });

  test("static serving never escapes the web root", async () => {
    for (const p of ["/%2e%2e/package.json", "/..%2fpackage.json", "/%2e%2e%2f.env.example"]) {
      const r = await req(srv.base, "GET", p);
      assert.doesNotMatch(r.text, /"dependencies"|DB_PATH/, p);
    }
  });
});

/** Opens the server's database from the test (WAL: the server keeps running). */
function withDb(srv, fn) {
  const db = new Database(srv.dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Makes every session of that user look opened `sec` seconds ago. */
const ageSessions = (srv, id, sec) => withDb(srv, (db) =>
  db.prepare("UPDATE viewer_sessions SET created_at = ? WHERE user_id = ?").run(Math.floor(Date.now() / 1000) - sec, id));

describe("locked server (first account made from the CLI)", () => {
  let srv;
  before(async () => { srv = await startServer({ signedIn: false }); });
  after(() => srv.stop());

  test("viewer APIs require a sign-in; ingest and health stay reachable", async () => {
    assert.equal((await req(srv.base, "GET", "/api/health")).status, 200);
    assert.equal((await req(srv.base, "GET", "/api/devices")).status, 401);
    assert.equal((await req(srv.base, "POST", "/api/devices", { body: { name: "x" } })).status, 401);
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: event(), key: "ak_nope" })).status, 401);
    const st = (await req(srv.base, "GET", "/api/auth/status")).json;
    assert.deepEqual(st, { authenticated: false, user: null, setup_required: false, signup_open: true, github_sign_in: true });
  });

  test("sign in with GitHub / sign out cycle", async () => {
    const r = await githubSignIn(srv.base, "admin");
    assert.deepEqual([r.status, r.location, r.error], [302, "/", null]);
    assert.match(r.headers.getSetCookie().find((c) => c.startsWith("dash_session=")), /HttpOnly/);
    const cookie = r.cookie;
    assert.equal((await req(srv.base, "GET", "/api/devices", { cookie })).status, 200);
    const me = (await req(srv.base, "GET", "/api/auth/status", { cookie })).json;
    assert.deepEqual(me.user, { id: 1, username: "admin", display_name: "admin", avatar_url: null, is_admin: true });
    const d = await newDevice(srv.base, "locked-dev", cookie);
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { body: event(), key: d.key })).json.stored, true);
    await req(srv.base, "POST", "/api/auth/logout", { cookie });
    assert.equal((await req(srv.base, "GET", "/api/devices", { cookie })).status, 401);
  });

  test("GitHub is asked for the public profile only, and the code is exchanged server-side", async () => {
    const r = await githubSignIn(srv.base, "admin");
    const q = r.start.url.searchParams;
    assert.equal(r.start.url.pathname, "/login/oauth/authorize");
    assert.equal(q.get("client_id"), "test-client");
    assert.equal(q.get("redirect_uri"), `${srv.base.replace("127.0.0.1", "127.0.0.1")}/api/auth/github/callback`);
    assert.equal(q.get("scope"), null);
    assert.match(q.get("state"), /^[\w-]{43}$/);
    // The secret only ever goes from the server to GitHub, with the same callback address.
    const exchange = githubRequests().at(-1);
    assert.deepEqual([exchange.client_id, exchange.client_secret, exchange.redirect_uri], ["test-client", "test-secret", q.get("redirect_uri")]);
    assert.ok(!JSON.stringify(r.start.json).includes("test-secret"));
  });

  test("the callback only works once, in the browser that started it", async () => {
    // No state cookie (another browser, or a forged link): nothing happens.
    const start = await req(srv.base, "POST", "/api/auth/github", { body: {}, anon: true });
    const state = new URL(start.json.url).searchParams.get("state");
    githubUser("admin");
    const noCookie = await fetch(`${srv.base}/api/auth/github/callback?code=x&state=${state}`, { redirect: "manual" });
    assert.equal(noCookie.headers.get("location"), "/?auth_error=expired");
    assert.equal(noCookie.headers.getSetCookie().some((c) => c.startsWith("dash_session=")), false);
    // A state that is not the one in this browser's cookie; the sign-in in
    // progress (its cookie) is left alone.
    const forged = await githubSignIn(srv.base, "admin", { state: "forged" });
    assert.equal(forged.error, "expired");
    assert.equal(forged.headers.getSetCookie().some((c) => c.startsWith("gh_oauth=")), false);
    // The same state twice: the second is refused (the code is single-use too).
    const first = await req(srv.base, "POST", "/api/auth/github", { body: {}, anon: true, headers: { "cf-connecting-ip": "198.51.100.77" } });
    const s = new URL(first.json.url).searchParams.get("state");
    const cookie = first.headers.getSetCookie()[0].split(";")[0];
    const back = () => fetch(`${srv.base}/api/auth/github/callback?code=nope&state=${s}`, { redirect: "manual", headers: { cookie } });
    assert.equal((await back()).headers.get("location"), "/?auth_error=github");
    assert.equal((await back()).headers.get("location"), "/?auth_error=expired");
    // Cancelled on GitHub.
    assert.equal((await githubSignIn(srv.base, null)).error, "denied");
  });

  test("it comes back to a same-site page only", async () => {
    assert.equal((await githubSignIn(srv.base, "admin", { next: "/settings?tab=x" })).location, "/settings?tab=x");
    // Normalized once, then used as is: what was checked is where it goes.
    assert.equal((await githubSignIn(srv.base, "admin", { next: "/settings/../settings?x=1" })).location, "/settings?x=1");
    // Browsers drop tabs and newlines from a Location: "/<tab>/evil" is "//evil".
    for (const next of ["//evil.example/x", "https://evil.example/", "/\\evil.example", "/\t/evil.example", "/\n/evil.example",
      "/\r//evil.example", "/ /evil.example", "/x\\y", "/\u0000", 42,
      // Dot segments resolve to "//evil.example".
      "/a/..//evil.example", "/.//evil.example", "/%2e%2e//evil.example"]) {
      assert.equal((await githubSignIn(srv.base, "admin", { next })).location, "/", String(next));
    }
  });

  test("a failed sign-in goes back to the sign-in page, still headed for next", async () => {
    assert.equal((await githubSignIn(srv.base, null, { next: "/settings?tab=x" })).location,
      `/?next=${encodeURIComponent("/settings?tab=x")}&auth_error=denied`);
    assert.equal((await githubSignIn(srv.base, null)).location, "/?auth_error=denied");
    assert.equal((await githubSignIn(srv.base, null, { next: "/a/..//evil.example" })).location, "/?auth_error=denied");
  });

  test("session and state cookies are Secure only over HTTPS", async () => {
    const plain = await githubSignIn(srv.base, "admin");
    assert.doesNotMatch(plain.start.headers.getSetCookie()[0], /Secure/);
    assert.doesNotMatch(plain.headers.getSetCookie().find((c) => c.startsWith("dash_session=")), /Secure/);
    const https = await githubSignIn(srv.base, "admin", { headers: { "x-forwarded-proto": "https" } });
    assert.match(https.start.headers.getSetCookie()[0], /Secure/);
    assert.match(https.headers.getSetCookie().find((c) => c.startsWith("dash_session=")), /Secure/);
    assert.equal(https.start.url.searchParams.get("redirect_uri"), `${srv.base.replace("http:", "https:")}/api/auth/github/callback`);
  });

  test("password sign-in and profile editing are gone", async () => {
    const cookie = await login(srv.base, "admin");
    for (const [p, body] of [
      ["/api/auth/login", { username: "admin", password: "x" }], ["/api/auth/register", { username: "x", password: "y" }],
      ["/api/auth/setup", { setup_code: "x" }], ["/api/account", { display_name: "x" }],
      ["/api/account/password", { current_password: "x", new_password: "y" }], ["/api/users/1/password", { password: "x" }],
    ]) {
      assert.equal((await req(srv.base, "POST", p, { body, cookie })).status, 404, p);
    }
  });

  test("state-changing requests must be same-site JSON", async () => {
    const cookie = await login(srv.base, "admin");
    // A cross-site HTML form can send text/plain that happens to be JSON.
    const form = await req(srv.base, "POST", "/api/auth/github", { anon: true, type: "text/plain", raw: "{}" });
    assert.equal(form.status, 415);
    assert.equal(form.headers.get("set-cookie"), null);
    assert.equal((await req(srv.base, "POST", "/api/auth/logout", { type: null, cookie })).status, 415);
    assert.equal((await req(srv.base, "POST", "/api/devices", { type: "application/x-www-form-urlencoded", raw: "name=x", cookie })).status, 415);
    const cross = await req(srv.base, "POST", "/api/devices", { body: { name: "x" }, headers: { "sec-fetch-site": "cross-site" }, cookie });
    assert.equal(cross.status, 403);
    assert.equal((await req(srv.base, "POST", "/api/auth/github", { body: {}, type: "application/json; charset=utf-8", cookie })).status, 200);
    assert.equal((await req(srv.base, "GET", "/api/devices", { type: "text/plain", cookie })).status, 200);
  });

  test("a device name that is not text falls back to the default", async () => {
    const cookie = await login(srv.base, "admin");
    const r = await req(srv.base, "POST", "/api/devices", { body: { name: { toString: 1 } }, cookie });
    assert.equal(r.status, 200);
    const d = (await req(srv.base, "GET", "/api/devices", { cookie })).json.devices.find((x) => x.id === r.json.id);
    assert.equal(d.name, "unnamed device");
  });

  test("starting sign-ins is rate limited per client; GitHub's callbacks are not", async () => {
    const ip = "203.0.113.61";
    const start = () => req(srv.base, "POST", "/api/auth/github", { body: {}, anon: true, headers: { "cf-connecting-ip": ip } });
    // Callbacks (even forged ones) take nothing from that budget.
    for (let i = 0; i < 70; i++) {
      const back = await fetch(`${srv.base}/api/auth/github/callback?state=x`, { redirect: "manual", headers: { "cf-connecting-ip": ip } });
      assert.equal(back.status, 302);
    }
    const statuses = [];
    for (let i = 0; i < 61; i++) statuses.push((await start()).status);
    assert.deepEqual([statuses.slice(0, 60).every((s) => s === 200), statuses[60]], [true, 429]);
    assert.equal((await req(srv.base, "POST", "/api/auth/github", { body: {}, anon: true, headers: { "cf-connecting-ip": "203.0.113.62" } })).status, 200);
  });
});

describe("a server without GitHub sign-in set up", () => {
  test("says so, and nobody can start a sign-in", async () => {
    const srv = await startServer({ autoLogin: false, env: { GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "" } });
    try {
      assert.equal((await req(srv.base, "GET", "/api/auth/status")).json.github_sign_in, false);
      assert.equal((await req(srv.base, "POST", "/api/auth/github", { body: {} })).status, 503);
    } finally {
      await srv.stop();
    }
  });
});

describe("client addresses for the sign-up cap", () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(() => srv.stop());

  test("CF-Connecting-IP is only trusted from localhost", async (t) => {
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
    if (!lan) return t.skip("no non-loopback IPv4 address to connect from");
    const base = srv.base.replace("localhost", lan.address).replace("127.0.0.1", lan.address);
    // From the LAN, a new header on every request must not buy a new budget.
    const errors = [];
    for (let i = 0; i < 7; i++) errors.push((await register(base, `lan${i}`, { ip: `198.51.100.${i}` })).error);
    assert.deepEqual(errors, [null, null, null, null, null, "too_many", "too_many"]);
  });

  test("behind a trusted proxy (TRUST_PROXY), each X-Forwarded-For client gets its own budget", async (t) => {
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal);
    if (!lan) return t.skip("no non-loopback IPv4 address to connect from");
    const proxied = await startServer({ env: { TRUST_PROXY: `${lan.address}/32` } });
    t.after(() => proxied.stop());
    const base = proxied.base.replace("127.0.0.1", lan.address);
    const signUp = (login, ip) => register(base, login, { headers: { "x-forwarded-for": `198.51.100.99, ${ip}` } });
    for (let i = 0; i < 5; i++) assert.equal((await signUp(`px${i}`, "203.0.113.40")).error, null);
    assert.equal((await signUp("px5", "203.0.113.40")).error, "too_many");
    // Another visitor behind the same proxy is not held back.
    assert.equal((await signUp("px6", "203.0.113.41")).error, null);
  });

  test("an invalid TRUST_PROXY stops the server at start", async () => {
    await assert.rejects(startServer({ autoLogin: false, env: { TRUST_PROXY: "caddy" } }), /TRUST_PROXY: "caddy"/);
  });
});

describe("accounts", () => {
  test("nothing is viewable without an account; the first one is made with the setup code", async () => {
    const srv = await startServer({ autoLogin: false });
    try {
      assert.deepEqual((await req(srv.base, "GET", "/api/auth/status")).json,
        { authenticated: false, user: null, setup_required: true, signup_open: true, github_sign_in: true });
      for (const p of ["/api/devices", "/api/users", "/api/admin/overview"]) {
        assert.equal((await req(srv.base, "GET", p)).status, 401, p);
      }
      // The public account list is empty until the first account exists.
      assert.deepEqual((await req(srv.base, "GET", "/api/profiles")).json.profiles, []);
      assert.equal((await req(srv.base, "POST", "/api/devices", { body: { name: "x" } })).status, 401);
      // The first account: the setup code from the server log, then GitHub.
      githubUser("louis", { name: "Louis", avatar_url: "https://avatars.githubusercontent.com/u/77?v=4" });
      const { cookie } = await githubSignIn(srv.base, "louis", { setup_code: srv.setupCode() });
      const st = (await req(srv.base, "GET", "/api/auth/status", { cookie })).json;
      assert.deepEqual(st, {
        authenticated: true, setup_required: false, signup_open: true, github_sign_in: true,
        user: { id: 1, username: "louis", display_name: "Louis", avatar_url: "https://avatars.githubusercontent.com/u/77?v=4", is_admin: true },
      });
      assert.equal((await req(srv.base, "GET", "/api/u/louis/stats?days=730", { cookie })).json.events, 0);
    } finally {
      await srv.stop();
    }
  });


  test("usage lands on the device owner; devices stay private", async () => {
    const srv = await startServer({ signedIn: false });
    try {
      await register(srv.base, "bob");
      const admin = await login(srv.base, "admin");
      const bob = await login(srv.base, "bob");
      const adminDev = await newDevice(srv.base, "admin-laptop", admin);
      const bobDev = await newDevice(srv.base, "bob-laptop", bob);
      await req(srv.base, "POST", "/api/ingest/claude-code", { key: bobDev.key, body: event({
        session_id: "bob-s",
        rate_limits: { five_hour: { used_percentage: 42, resets_at: soon() } },
      }) });

      const get = async (p, cookie) => (await req(srv.base, "GET", p, { cookie })).json;
      assert.equal((await get("/api/u/admin/stats?days=730", admin)).events, 0);
      assert.equal((await get("/api/u/bob/stats?days=730", bob)).events, 1);
      assert.deepEqual((await get("/api/u/admin/quotas", admin)).quotas, []);
      assert.equal((await get("/api/u/bob/quotas", bob)).quotas.length, 1);
      assert.equal((await get("/api/u/admin/sessions", admin)).total, 0);
      assert.deepEqual((await get("/api/devices", admin)).devices.map((d) => d.name), ["admin-laptop"]);
      assert.deepEqual((await get("/api/devices", bob)).devices.map((d) => d.name), ["bob-laptop"]);
      // Revoking another user's device looks like an unknown id.
      assert.equal((await req(srv.base, "POST", `/api/devices/${bobDev.id}/revoke`, { cookie: admin })).status, 404);
      assert.equal((await req(srv.base, "POST", `/api/devices/${adminDev.id}/revoke`, { cookie: admin })).status, 200);
    } finally {
      await srv.stop();
    }
  });

  test("signing in again replaces the browser's previous session", async () => {
    const srv = await startServer({ signedIn: false });
    try {
      const first = await login(srv.base, "admin");
      const again = await githubSignIn(srv.base, "admin", { cookie: first });
      assert.ok(again.cookie);
      assert.equal((await req(srv.base, "GET", "/api/devices", { cookie: first })).status, 401);
      assert.equal((await req(srv.base, "GET", "/api/devices", { cookie: again.cookie })).status, 200);
    } finally {
      await srv.stop();
    }
  });

  test("sessions survive a server restart", async () => {
    const dir = fs.mkdtempSync(`${os.tmpdir()}/ai-usage-restart-`);
    const env = { DB_PATH: `${dir}/t.db` };
    try {
      const first = await startServer({ signedIn: false, env });
      const cookie = await login(first.base, "admin");
      await first.stop();
      const second = await startServer({ env, autoLogin: false });
      try {
        assert.equal((await req(second.base, "GET", "/api/devices", { cookie })).status, 200);
      } finally {
        await second.stop();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("profiles from GitHub and user management", () => {
  let srv, admin;
  const post = (p, body, cookie) => req(srv.base, "POST", p, { body, cookie });
  before(async () => {
    srv = await startServer({ signedIn: false });
    admin = await login(srv.base, "admin");
  });
  after(() => srv.stop());

  test("admins list accounts; others cannot", async () => {
    const carol = (await register(srv.base, "carol", { over: { name: " Carol " } })).cookie;
    const me = (await req(srv.base, "GET", "/api/auth/status", { cookie: carol })).json.user;
    assert.deepEqual(me, { id: me.id, username: "carol", display_name: "Carol", avatar_url: null, is_admin: false });
    assert.equal((await req(srv.base, "GET", "/api/users", { cookie: carol })).status, 403);
    assert.equal((await req(srv.base, "GET", "/api/admin/overview", { cookie: carol })).status, 403);
    // Accounts are only created by signing up: there is no admin creation route.
    assert.equal((await post("/api/users", { username: "eve" }, admin)).status, 404);
    const list = (await req(srv.base, "GET", "/api/users", { cookie: admin })).json.users;
    assert.deepEqual(list.map((u) => [u.username, u.is_admin, u.disabled]),
      [["admin", true, false], ["carol", false, false]]);
  });

  test("name and picture follow GitHub at each sign-in; only allowlisted pictures are kept", async () => {
    const pic = "https://avatars.githubusercontent.com/u/12345?v=4";
    githubUser("admin", { name: "Louis M.", avatar_url: pic });
    const cookie = await login(srv.base, "admin");
    const me = (await req(srv.base, "GET", "/api/auth/status", { cookie })).json.user;
    assert.deepEqual([me.display_name, me.avatar_url], ["Louis M.", pic]);
    const anon = { anon: true };
    assert.equal((await req(srv.base, "GET", "/api/u/admin", anon)).json.avatar_url, pic);
    const board = (await req(srv.base, "GET", "/api/leaderboard?days=30", anon)).json;
    assert.equal(board.entries.find((e) => e.username === "admin").avatar_url, pic);
    // A long name is cut; a picture from anywhere else is dropped.
    githubUser("admin", { name: "x".repeat(80), avatar_url: "https://evil.example/pixel.png" });
    await login(srv.base, "admin");
    const after = (await req(srv.base, "GET", "/api/u/admin", anon)).json;
    assert.deepEqual([after.display_name, after.avatar_url], ["x".repeat(60), null]);
    // No name: the username is shown.
    githubUser("admin", { name: null, avatar_url: null });
    await login(srv.base, "admin");
    assert.equal((await req(srv.base, "GET", "/api/u/admin", anon)).json.display_name, "admin");
  });

  test("older GitHub logins (a trailing dash, \"--\") still sign in; odd ones never reach a URL", async () => {
    for (const login of ["old-style-", "old--style"]) {
      const r = await register(srv.base, login);
      assert.equal(r.error, null, login);
      assert.equal((await req(srv.base, "GET", `/api/u/${login}`, { anon: true })).json.username, login);
    }
    // GitHub never gives these: refused as an unusable answer.
    for (const login of ["a/b", "x".repeat(40), "a b"]) assert.equal((await register(srv.base, login)).error, "github", login);
  });

  test("a GitHub login rename moves the profile page; the account and its data stay", async () => {
    const ren = await register(srv.base, "renamer");
    const dev = await newDevice(srv.base, "ren-laptop", ren.cookie);
    await req(srv.base, "POST", "/api/ingest/claude-code", { key: dev.key, body: event({ session_id: "ren-s" }) });
    const id = await userId(srv.base, "renamer", admin);
    renameGithubUser("renamer", "renamed");
    const cookie = await login(srv.base, "renamed");
    assert.equal((await req(srv.base, "GET", "/api/auth/status", { cookie })).json.user.id, id);
    assert.equal((await req(srv.base, "GET", "/api/u/renamer", { anon: true })).status, 404);
    assert.equal((await req(srv.base, "GET", "/api/u/renamed/summary", { anon: true })).json.total.events, 1);
    assert.equal((await req(srv.base, "GET", "/api/devices", { cookie })).json.devices.length, 1);
  });

  test("a login given up on GitHub and taken by someone else goes to its new owner", async () => {
    const old = await register(srv.base, "handle");
    const oldId = await userId(srv.base, "handle", admin);
    // "handle" renames to "handle2" on GitHub but has not signed in here since;
    // a new GitHub user takes "handle" and signs up.
    renameGithubUser("handle", "handle2");
    const taker = await register(srv.base, "handle");
    assert.equal(taker.error, null);
    const users = (await req(srv.base, "GET", "/api/users", { cookie: admin })).json.users;
    assert.equal(users.find((u) => u.id === oldId).username, `handle-${oldId}`);
    assert.notEqual(users.find((u) => u.username === "handle").id, oldId);
    // Its next sign-in gives the first one its new login.
    await login(srv.base, "handle2");
    assert.equal((await req(srv.base, "GET", "/api/auth/status", { cookie: old.cookie })).json.user.username, "handle2");
  });



  test("a stale username moves to a free name, even when <name>-<id> is taken", async () => {
    await register(srv.base, "dup");
    const id = await userId(srv.base, "dup", admin);
    await register(srv.base, `dup-${id}`);
    renameGithubUser("dup", "dup-renamed");
    assert.equal((await register(srv.base, "dup")).error, null);
    const names = (await req(srv.base, "GET", "/api/users", { cookie: admin })).json.users.map((u) => [u.id, u.username]);
    assert.ok(names.some(([i, n]) => i === id && n === `dup-${id}-2`), JSON.stringify(names));
    assert.equal((await githubSignIn(srv.base, "dup-renamed")).error, null);
  });

  test("an unknown GitHub user signing in gets a new account; a disabled one cannot sign in", async () => {
    await register(srv.base, "frank");
    const id = await userId(srv.base, "frank", admin);
    const frank = await login(srv.base, "frank");
    const dev = await newDevice(srv.base, "frank-laptop", frank);
    assert.equal((await post(`/api/users/${id}/disable`, {}, admin)).status, 200);
    assert.equal((await req(srv.base, "GET", "/api/devices", { cookie: frank })).status, 401);
    const refused = await githubSignIn(srv.base, "frank");
    assert.deepEqual([refused.error, refused.cookie], ["disabled", null]);
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { key: dev.key, body: event() })).status, 401);
    assert.equal((await post(`/api/users/${id}/enable`, {}, admin)).status, 200);
    assert.equal((await req(srv.base, "POST", "/api/ingest/claude-code", { key: dev.key, body: event() })).status, 200);
    await login(srv.base, "frank");
    assert.equal((await post("/api/users/1/disable", {}, admin)).status, 400);
    assert.equal((await post("/api/users/999/disable", {}, admin)).status, 404);
  });

  test("admins grant and remove admin rights, never their own", async () => {
    const hank = (await register(srv.base, "hank")).cookie;
    const id = await userId(srv.base, "hank", admin);
    assert.equal((await req(srv.base, "GET", "/api/users", { cookie: hank })).status, 403);
    assert.equal((await post(`/api/users/${id}/admin`, { is_admin: "yes" }, admin)).status, 400);
    assert.equal((await post(`/api/users/${id}/admin`, { is_admin: true }, hank)).status, 403);
    assert.equal((await post(`/api/users/${id}/admin`, { is_admin: true }, admin)).status, 200);
    // Takes effect on the next request, same session.
    assert.equal((await req(srv.base, "GET", "/api/auth/status", { cookie: hank })).json.user.is_admin, true);
    assert.equal((await req(srv.base, "GET", "/api/users", { cookie: hank })).status, 200);
    // Nobody changes their own role, so there is always an admin left.
    assert.equal((await post(`/api/users/${id}/admin`, { is_admin: false }, hank)).status, 400);
    assert.equal((await post("/api/users/1/admin", { is_admin: false }, admin)).status, 400);
    assert.equal((await post(`/api/users/${id}/admin`, { is_admin: false }, admin)).status, 200);
    assert.equal((await req(srv.base, "GET", "/api/users", { cookie: hank })).status, 403);
    assert.equal((await post("/api/users/999/admin", { is_admin: true }, admin)).status, 404);
  });
});

describe("creating accounts from the site", () => {
  test("the first account needs the setup code from the server log", async () => {
    const srv = await startServer({ autoLogin: false });
    try {
      const code = srv.setupCode();
      assert.match(code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      githubUser("founder", { name: "Founder" });
      const wrong = await githubSignIn(srv.base, "founder", { setup_code: "AAAA-BBBB-CCCC" });
      assert.deepEqual([wrong.start.status, wrong.cookie], [401, null]);
      assert.equal((await githubSignIn(srv.base, "founder")).start.status, 401, "no code at all");
      // Two sign-ins started with the right code (case, spaces and dashes do not matter)...
      const first = await githubSignIn(srv.base, "founder", { setup_code: ` ${code.toLowerCase().replace(/-/g, "")} ` });
      assert.equal(first.location, "/");
      const st = (await req(srv.base, "GET", "/api/auth/status", { cookie: first.cookie })).json;
      assert.deepEqual(st.user, { id: 1, username: "founder", display_name: "Founder", avatar_url: null, is_admin: true });
      // ...then the setup code means nothing: new GitHub users sign up (not admin).
      const second = await githubSignIn(srv.base, "second", { setup_code: code });
      assert.equal(second.error, null);
      assert.equal((await req(srv.base, "GET", "/api/auth/status", { cookie: second.cookie })).json.user.is_admin, false);
    } finally {
      await srv.stop();
    }
  });

  test("a setup started twice creates one admin", async () => {
    const srv = await startServer({ autoLogin: false });
    try {
      const code = srv.setupCode();
      // Both browsers pass the code before either comes back from GitHub.
      const starts = [];
      for (const ip of ["198.51.100.201", "198.51.100.202"]) {
        const r = await req(srv.base, "POST", "/api/auth/github", { body: { setup_code: code }, anon: true, headers: { "cf-connecting-ip": ip } });
        starts.push({ state: new URL(r.json.url).searchParams.get("state"), cookie: r.headers.getSetCookie()[0].split(";")[0] });
      }
      const back = async ({ state, cookie }, login) => {
        githubUser(login);
        const codeFor = await githubCode(login);
        return (await fetch(`${srv.base}/api/auth/github/callback?code=${codeFor}&state=${state}`, { redirect: "manual", headers: { cookie } })).headers.get("location");
      };
      assert.equal(await back(starts[0], "one"), "/");
      assert.equal(await back(starts[1], "two"), "/?auth_error=exists");
      const users = withDb(srv, (db) => db.prepare("SELECT username, is_admin FROM users WHERE username IS NOT NULL").all());
      assert.deepEqual(users, [{ username: "one", is_admin: 1 }]);
    } finally {
      await srv.stop();
    }
  });

  test("setup code guesses are throttled", async () => {
    const srv = await startServer({ autoLogin: false });
    try {
      const guess = (setup_code) => req(srv.base, "POST", "/api/auth/github", { body: { setup_code }, anon: true, headers: { "cf-connecting-ip": "203.0.113.30" } });
      const statuses = (await Promise.all(Array.from({ length: 12 }, () => guess("nope")))).map((r) => r.status);
      assert.deepEqual([statuses.filter((s) => s === 401).length, statuses.filter((s) => s === 429).length], [10, 2]);
      assert.equal((await guess(srv.setupCode())).status, 429);
    } finally {
      await srv.stop();
    }
  });

  test("a server that already has accounts prints no setup code", async () => {
    const dir = fs.mkdtempSync(`${os.tmpdir()}/ai-usage-setup-`);
    const env = { DB_PATH: `${dir}/t.db` };
    try {
      const first = await startServer({ env });
      assert.ok(first.setupCode(), "the first start had one");
      await first.stop();
      const again = await startServer({ env, autoLogin: false });
      try {
        assert.equal(again.setupCode(), null);
        assert.equal((await req(again.base, "POST", "/api/auth/github", { body: { setup_code: "x" }, anon: true })).status, 200,
          "a normal sign-in: the code means nothing any more");
      } finally {
        await again.stop();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("open sign-up and admin panel", () => {
  test("anyone with a GitHub account signs up from the sign-in page", async () => {
    const srv = await startServer();
    try {
      const pic = "https://avatars.githubusercontent.com/u/31337?v=4";
      const r = await register(srv.base, "neo", { over: { name: "Neo", avatar_url: pic } });
      assert.deepEqual([r.location, r.error], ["/", null]);
      const me = (await req(srv.base, "GET", "/api/auth/status", { cookie: r.cookie })).json.user;
      assert.deepEqual(me, { id: me.id, username: "neo", display_name: "Neo", avatar_url: pic, is_admin: false });
      assert.equal((await req(srv.base, "GET", "/api/admin/overview", { cookie: r.cookie })).status, 403);
      assert.equal((await req(srv.base, "GET", "/api/u/neo", { anon: true })).json.display_name, "Neo");
    } finally {
      await srv.stop();
    }
  });

  test("an admin closes and reopens account creation", async () => {
    const srv = await startServer();
    try {
      const neo = (await register(srv.base, "neo")).cookie;
      const settings = (body, cookie) => req(srv.base, "POST", "/api/admin/settings", { body, cookie });
      assert.equal((await req(srv.base, "GET", "/api/admin/settings", { cookie: neo })).status, 403);
      assert.equal((await settings({ signup_open: false }, neo)).status, 403);
      assert.equal((await settings({ signup_open: "no" })).status, 400);
      assert.deepEqual((await settings({ signup_open: false })).json, { signup_open: false });
      assert.equal((await req(srv.base, "GET", "/api/auth/status", { anon: true })).json.signup_open, false);
      const refused = await register(srv.base, "trinity");
      assert.deepEqual([refused.error, refused.cookie], ["closed", null]);
      // Existing accounts still sign in.
      await login(srv.base, "neo");
      assert.deepEqual((await settings({ signup_open: true })).json, { signup_open: true });
      assert.equal((await register(srv.base, "trinity")).error, null);
    } finally {
      await srv.stop();
    }
  });

  test("one client cannot create accounts in bulk", async () => {
    const srv = await startServer();
    try {
      const burst = await Promise.all([0, 1, 2, 3, 4, 5, 6].map((i) => register(srv.base, `race${i}`, { ip: "203.0.113.50" })));
      assert.deepEqual(burst.map((r) => r.error ?? "ok").sort(), ["ok", "ok", "ok", "ok", "ok", "too_many", "too_many"]);
      assert.equal((await register(srv.base, "bulk7", { ip: "203.0.113.50" })).error, "too_many");
      // Existing accounts still sign in from there.
      assert.equal((await githubSignIn(srv.base, "race0", { ip: "203.0.113.50" })).error, null);
      assert.equal((await register(srv.base, "other", { ip: "203.0.113.51" })).error, null);
    } finally {
      await srv.stop();
    }
  });

  test("no sign-up before the first account exists", async () => {
    const srv = await startServer({ autoLogin: false });
    try {
      // Without the setup code, a sign-in does not even start.
      assert.equal((await register(srv.base, "neo")).start.status, 401);
      assert.equal(withDb(srv, (db) => db.prepare("SELECT COUNT(*) AS n FROM users WHERE username IS NOT NULL").get().n), 0);
    } finally {
      await srv.stop();
    }
  });

  test("the overview counts the whole server", async () => {
    const srv = await startServer();
    try {
      const { key } = await newDevice(srv.base);
      await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ session_id: "o1" }) });
      await register(srv.base, "neo");
      const o = (await req(srv.base, "GET", "/api/admin/overview")).json;
      assert.equal(o.accounts, 2);
      assert.equal(o.disabled_accounts, 0);
      assert.equal(o.devices, 1);
      assert.equal(o.events, 1);
      assert.equal(o.sessions, 1);
      assert.ok(o.last_event_at > 0);
    } finally {
      await srv.stop();
    }
  });
});

describe("deleting your own activity", () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(() => srv.stop());

  const CONFIRM = "delete my activity";
  const ingest = (key, body) => req(srv.base, "POST", "/api/ingest/claude-code", { key, body, anon: true });
  const summary = async (name) => (await req(srv.base, "GET", `/api/u/${name}/summary`, { anon: true })).json.total;
  const quotas = async (name) => (await req(srv.base, "GET", `/api/u/${name}/quotas`, { anon: true })).json.quotas;
  const withQuota = (over) => event({ rate_limits: { five_hour: { used_percentage: 12, resets_at: soon() } }, ...over });

  test("needs the phrase and a recent sign-in, and only deletes the signed-in user's rows", async () => {
    const ann = await register(srv.base, "ann");
    const bob = await register(srv.base, "bob");
    const annDev = await newDevice(srv.base, "ann-laptop", ann.cookie);
    const bobDev = await newDevice(srv.base, "bob-laptop", bob.cookie);
    const annEvent = withQuota({ session_id: "ann-s" });
    assert.equal((await ingest(annDev.key, annEvent)).json.stored, true);
    assert.equal((await ingest(bobDev.key, withQuota({ session_id: "bob-s" }))).json.stored, true);
    const del = (body, cookie = ann.cookie) => req(srv.base, "POST", "/api/account/delete-activity", { body, cookie });

    assert.equal((await del({ confirm: CONFIRM }, null)).status, 401);
    assert.equal((await req(srv.base, "POST", "/api/account/delete-activity", { body: { confirm: CONFIRM }, anon: true })).status, 401);
    assert.equal((await del({ confirm: "yes" })).status, 400);
    assert.equal((await del({})).status, 400);
    // Signed in 11 minutes ago: sign in with GitHub again first.
    const annId = await userId(srv.base, "ann");
    ageSessions(srv, annId, 11 * 60);
    const stale = await del({ confirm: CONFIRM });
    assert.deepEqual([stale.status, stale.json], [403, { error: "sign in with GitHub again to confirm", reauth: true }]);
    assert.equal((await summary("ann")).events, 1);
    const fresh = await login(srv.base, "ann");

    const ok = await del({ confirm: CONFIRM }, fresh);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { ok: true, deleted: { events: 1, quotas: 1 } });
    assert.deepEqual([(await summary("ann")).tokens, (await summary("ann")).events], [0, 0]);
    assert.deepEqual(await quotas("ann"), []);
    assert.equal((await req(srv.base, "GET", "/api/u/ann/sessions", { anon: true })).json.total, 0);
    // Bob's data, and Ann's account, session and devices are untouched.
    assert.equal((await summary("bob")).events, 1);
    assert.equal((await quotas("bob")).length, 1);
    assert.equal((await req(srv.base, "GET", "/api/auth/status", { cookie: fresh })).json.user.username, "ann");
    const devices = (await req(srv.base, "GET", "/api/devices", { cookie: fresh })).json.devices;
    assert.deepEqual(devices.map((d) => [d.name, Boolean(d.revoked)]), [["ann-laptop", false]]);
    assert.equal((await req(srv.base, "GET", `/api/devices/${annDev.id}/key`, { cookie: fresh })).json.key, annDev.key);
    // Deleting again with nothing left is fine.
    assert.deepEqual((await del({ confirm: CONFIRM }, fresh)).json.deleted, { events: 0, quotas: 0 });

    // A collector resending its history cannot bring the deleted data back...
    const replay = await ingest(annDev.key, { ...annEvent, event_id: `${annEvent.event_id}_again` });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.stored, false);
    assert.equal((await ingest(annDev.key, { messages: [{ ...annEvent, message_id: annEvent.event_id }] })).json.deduped, 1);
    assert.equal((await summary("ann")).events, 0);
    assert.deepEqual(await quotas("ann"), []);
    // ...but activity after the deletion is recorded as usual.
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await ingest(annDev.key, withQuota({ session_id: "ann-new" }))).json.stored, true);
    assert.equal((await summary("ann")).events, 1);
    assert.equal((await quotas("ann")).length, 1);
  });

  test("signing in again for it: the same GitHub account only, back to where it started", async () => {
    const rea = await register(srv.base, "rea");
    const reaId = await userId(srv.base, "rea");
    ageSessions(srv, reaId, 3600);
    const status = (cookie) => req(srv.base, "GET", "/api/auth/status", { cookie });
    assert.equal((await githubSignIn(srv.base, "rea", { reauth: true })).start.status, 401, "no session");
    // Another GitHub account: refused, back to Settings, still signed in as before.
    const other = await githubSignIn(srv.base, "someone-else", { reauth: true, cookie: rea.cookie, next: "/settings" });
    assert.deepEqual([other.location, other.cookie], ["/settings?auth_error=other_account", null]);
    assert.equal((await status(rea.cookie)).json.user.username, "rea");
    // Cancelled on GitHub: said on Settings too.
    assert.equal((await githubSignIn(srv.base, null, { reauth: true, cookie: rea.cookie, next: "/settings?x=1" })).location,
      "/settings?x=1&auth_error=denied");
    // A next that resolves off the site never becomes one on failure either.
    assert.equal((await githubSignIn(srv.base, null, { reauth: true, cookie: rea.cookie, next: "/a/..//evil.example" })).location,
      "/?auth_error=denied");
    // Its state gone (a restart, another tab's sign-in): still told, on Settings.
    const lost = await fetch(`${srv.base}/api/auth/github/callback?code=x&state=gone`, { redirect: "manual", headers: { cookie: rea.cookie } });
    assert.equal(lost.headers.get("location"), "/settings?auth_error=expired");
    // The same account: a fresh session, and deleting works.
    const again = await githubSignIn(srv.base, "rea", { reauth: true, cookie: rea.cookie, next: "/settings" });
    assert.equal(again.location, "/settings");
    const del = await req(srv.base, "POST", "/api/account/delete-activity", { body: { confirm: CONFIRM }, cookie: again.cookie });
    assert.equal(del.status, 200);
    assert.equal((await status(rea.cookie)).json.authenticated, false, "signing in again replaced the old session");
  });

  test("a clock running ahead or a missing time cannot bring deleted messages back", async () => {
    const cid = await register(srv.base, "cid");
    const dev = await newDevice(srv.base, "cid-laptop", cid.cookie);
    const now = Math.floor(Date.now() / 1000);
    // Stored at the receive time (clamped): after the deletion, a resend is
    // clamped to a newer now, past the cutoff, and only its id stops it.
    const ahead = event({ session_id: "cid-ahead", occurred_at: now + 3600 });
    const { occurred_at, ...timeless } = event({ session_id: "cid-timeless" });
    assert.equal((await ingest(dev.key, ahead)).json.stored, true);
    assert.equal((await ingest(dev.key, timeless)).json.stored, true);
    const del = await req(srv.base, "POST", "/api/account/delete-activity", { body: { confirm: CONFIRM }, cookie: cid.cookie });
    assert.deepEqual(del.json.deleted, { events: 2, quotas: 0 });
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await ingest(dev.key, { ...ahead, occurred_at: Math.floor(Date.now() / 1000) + 3600 })).json.deduped, true);
    assert.equal((await ingest(dev.key, timeless)).json.deduped, true);
    assert.equal((await summary("cid")).events, 0);
    // A context gauge measured before the deletion does not land on a new row.
    assert.equal((await ingest(dev.key, event({ session_id: "cid-ahead" }))).json.stored, true);
    const ctx = { messages: [], context: { session_id: "cid-ahead", used_pct: 77, window_size: 200000 }, occurred_at: now - 60 };
    assert.equal((await ingest(dev.key, ctx)).status, 200);
    const s = (await req(srv.base, "GET", "/api/u/cid/sessions", { anon: true })).json.sessions[0];
    assert.deepEqual([s.session_id, s.context_used_pct], ["cid-ahead", null]);
  });

  test("deleted rows are erased from the database file, not left in free pages or the WAL", async () => {
    const dee = await register(srv.base, "dee");
    const dev = await newDevice(srv.base, "dee-laptop", dee.cookie);
    const marker = `dee-secret-session-${Date.now()}`;
    for (let i = 0; i < 20; i++) await ingest(dev.key, event({ session_id: marker }));
    const found = () => [srv.dbPath, `${srv.dbPath}-wal`]
      .filter((f) => fs.existsSync(f) && fs.readFileSync(f).includes(marker));
    assert.notDeepEqual(found(), []);
    const del = await req(srv.base, "POST", "/api/account/delete-activity", { body: { confirm: CONFIRM }, cookie: dee.cookie });
    assert.equal(del.json.deleted.events, 20);
    assert.deepEqual(found(), []);
  });
});

describe("deleting your own account", () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(() => srv.stop());

  const CONFIRM = "delete my account";
  const del = (body, cookie) => req(srv.base, "POST", "/api/account/delete", { body, cookie });
  const ingest = (key, body) => req(srv.base, "POST", "/api/ingest/claude-code", { key, body, anon: true });

  test("needs the phrase and a recent sign-in, then removes the account and everything tied to it", async () => {
    const eli = await register(srv.base, "eli");
    const fay = await register(srv.base, "fay");
    const other = await login(srv.base, "eli");
    const dev = await newDevice(srv.base, "eli-laptop", eli.cookie);
    const eliId = await userId(srv.base, "eli");
    const fayDev = await newDevice(srv.base, "fay-laptop", fay.cookie);
    const quota = { five_hour: { used_percentage: 12, resets_at: soon() } };
    assert.equal((await ingest(dev.key, event({ session_id: "eli-s", rate_limits: quota }))).json.stored, true);
    assert.equal((await ingest(fayDev.key, event({ session_id: "fay-s", rate_limits: quota }))).json.stored, true);

    assert.equal((await req(srv.base, "POST", "/api/account/delete", { body: { confirm: CONFIRM }, anon: true })).status, 401);
    assert.equal((await del({ confirm: "delete my activity" }, eli.cookie)).status, 400);
    ageSessions(srv, eliId, 3600);
    const stale = await del({ confirm: CONFIRM }, eli.cookie);
    assert.deepEqual([stale.status, stale.json.reauth], [403, true]);
    assert.equal((await req(srv.base, "GET", "/api/u/eli", { anon: true })).status, 200);

    const fresh = await login(srv.base, "eli");
    const ok = await del({ confirm: CONFIRM }, fresh);
    assert.deepEqual([ok.status, ok.json], [200, { ok: true, deleted: { events: 1, quotas: 1, devices: 1 } }]);
    // Every session, the profile, the sign-in and the device key are gone.
    for (const cookie of [eli.cookie, other, fresh]) {
      assert.equal((await req(srv.base, "GET", "/api/auth/status", { cookie })).json.authenticated, false);
      assert.equal((await req(srv.base, "GET", "/api/devices", { cookie })).status, 401);
    }
    assert.equal((await req(srv.base, "GET", "/api/u/eli", { anon: true })).status, 404);
    assert.equal((await req(srv.base, "GET", "/api/u/eli/summary", { anon: true })).status, 404);
    assert.equal((await ingest(dev.key, event({ session_id: "eli-s" }))).status, 401);
    const db = new Database(srv.dbPath, { readonly: true });
    try {
      for (const table of ["usage_events", "quota_snapshots", "devices", "viewer_sessions", "deleted_events"]) {
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(eliId).n, 0, table);
      }
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?").get(eliId).n, 0);
      // Its devices' collector versions go first (they reference the device).
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM collector_versions WHERE device_id = ?").get(dev.id).n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM collector_versions WHERE device_id = ?").get(fayDev.id).n, 1);
    } finally {
      db.close();
    }
    // Another account is untouched.
    assert.equal((await req(srv.base, "GET", "/api/u/fay/summary", { anon: true })).json.total.events, 1);
    assert.equal((await req(srv.base, "GET", "/api/u/fay/quotas", { anon: true })).json.quotas.length, 1);
    assert.equal((await req(srv.base, "GET", "/api/devices", { cookie: fay.cookie })).json.devices.length, 1);
    // Signing in with that GitHub account again makes a new, empty account.
    const back = await githubSignIn(srv.base, "eli");
    assert.equal(back.error, null);
    assert.notEqual((await req(srv.base, "GET", "/api/auth/status", { cookie: back.cookie })).json.user.id, eliId);
    assert.equal((await req(srv.base, "GET", "/api/u/eli/summary", { anon: true })).json.total.events, 0);
  });

  test("the last admin cannot delete their account until another admin exists", async () => {
    const gus = await register(srv.base, "gus");
    const self = { confirm: CONFIRM };
    const last = await req(srv.base, "POST", "/api/account/delete", { body: self });
    assert.equal(last.status, 409);
    assert.equal((await req(srv.base, "GET", "/api/auth/status")).json.user.username, "admin");
    assert.equal((await req(srv.base, "POST", `/api/users/${await userId(srv.base, "gus")}/admin`, { body: { is_admin: true } })).status, 200);
    assert.equal((await req(srv.base, "POST", "/api/account/delete", { body: self })).status, 200);
    assert.equal((await req(srv.base, "GET", "/api/users", { cookie: gus.cookie })).json.users.some((u) => u.username === "admin"), false);
  });
});

describe("GitHub friends", () => {
  test("matches numeric GitHub ids, shows only enabled profiles and public seven-day usage", async () => {
    const srv = await startServer();
    try {
      const bob = await register(srv.base, "friend-bob", { over: { name: "Bob" } });
      await register(srv.base, "friend-idle");
      await register(srv.base, "friend-disabled");
      githubFollowing("admin", ["friend-bob", "friend-disabled", "friend-idle", "friend-bob", "github-only"]);
      const device = await newDevice(srv.base, "bob-machine", bob.cookie);
      await req(srv.base, "POST", "/api/ingest/claude-code", { key: device.key, body: event({ session_id: "bobs-session" }) });
      await req(srv.base, "POST", "/api/ingest/claude-code", { key: device.key, body: event({
        session_id: "older-session", occurred_at: Math.floor(Date.now() / 1000) - 8 * 86400,
      }) });
      await req(srv.base, "POST", `/api/users/${await userId(srv.base, "friend-disabled")}/disable`);

      assert.equal((await req(srv.base, "GET", "/api/friends", { anon: true })).status, 401);
      const r = await req(srv.base, "GET", "/api/friends");
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.friends.map((f) => f.username), ["friend-bob", "friend-idle"]);
      assert.equal(r.json.friends[0].tokens, 180);
      assert.equal(r.json.friends[0].sessions, 1);
      assert.ok(r.json.friends[0].last_active >= r.json.since);
      assert.equal(r.json.friends[1].last_active, null);
      assert.equal(r.json.friends[1].tokens, 0);
      assert.ok(r.json.until - r.json.since === 7 * 86400);
      assert.equal(JSON.stringify(r.json).includes("bobs-session"), false);
      assert.equal(JSON.stringify(r.json).includes(device.key), false);
      // Disabling after a cached GitHub lookup still hides the local account.
      await req(srv.base, "POST", `/api/users/${await userId(srv.base, "friend-bob")}/disable`);
      assert.deepEqual((await req(srv.base, "GET", "/api/friends")).json.friends.map((f) => f.username), ["friend-idle"]);
    } finally { await srv.stop(); }
  });

  test("empty and unavailable GitHub data are distinct", async () => {
    const srv = await startServer();
    try {
      githubFollowing("admin", []);
      assert.deepEqual((await req(srv.base, "GET", "/api/friends")).json.friends, []);
      const other = await register(srv.base, "friend-unavailable");
      githubFollowing("friend-unavailable", null);
      assert.equal((await req(srv.base, "GET", "/api/friends", { cookie: other.cookie })).status, 503);
    } finally { await srv.stop(); }
  });
});

describe("public profile pages", () => {
  test("anyone reads a profile's usage by username, never its private data", async () => {
    const srv = await startServer();
    try {
      const admin = await login(srv.base, TEST_ADMIN.username);
      await register(srv.base, "bob", { over: { name: "Bob" } });
      await register(srv.base, "gone");
      await req(srv.base, "POST", `/api/users/${await userId(srv.base, "gone", admin)}/disable`, { cookie: admin });
      const bob = await login(srv.base, "bob");
      const dev = await newDevice(srv.base, "admin-laptop", admin);
      await req(srv.base, "POST", "/api/ingest/claude-code", { key: dev.key, body: event({
        session_id: "admin-s",
        rate_limits: { five_hour: { used_percentage: 12, resets_at: soon() } },
      }) });

      // Signed out, and signed in as someone else: same public view.
      for (const cookie of [undefined, bob]) {
        const get = (p) => req(srv.base, "GET", p, cookie ? { cookie } : { anon: true });
        assert.deepEqual((await get("/api/u/admin")).json, { username: "admin", display_name: "admin", avatar_url: null });
        assert.equal((await get("/api/u/ADMIN/stats?days=730")).json.events, 1);
        assert.equal((await get("/api/u/admin/summary")).json.total.sessions, 1);
        assert.equal((await get("/api/u/admin/activity")).json.days.length, 1);
        assert.equal((await get("/api/u/admin/quotas")).json.quotas[0].used_pct, 12);
        assert.equal((await get("/api/u/admin/sessions")).json.sessions[0].session_id, "admin-s");
        // Unknown and disabled profiles do not exist.
        assert.equal((await get("/api/u/nobody")).status, 404);
        assert.equal((await get("/api/u/gone/summary")).status, 404);
        // Nothing private has a public route (401 or 404, never data).
        for (const p of ["/api/u/admin/devices", "/api/u/admin/users"]) {
          assert.ok([401, 404].includes((await get(p)).status), p);
        }
      }
      // Bob's devices stay his.
      const mine = (p) => req(srv.base, "GET", p, { cookie: bob });
      assert.deepEqual((await mine("/api/devices")).json.devices, []);
      // The account list is public, like the leaderboard (disabled ones hidden).
      const listed = [{ username: "admin", display_name: "admin", avatar_url: null }, { username: "bob", display_name: "Bob", avatar_url: null }];
      assert.deepEqual((await mine("/api/profiles")).json.profiles, listed);
      assert.deepEqual((await req(srv.base, "GET", "/api/profiles", { anon: true })).json.profiles, listed);
      assert.equal((await req(srv.base, "GET", "/api/devices", { anon: true })).status, 401);
    } finally {
      await srv.stop();
    }
  });
});

describe("read cache", () => {
  let srv, key;
  before(async () => {
    srv = await startServer();
    key = (await newDevice(srv.base, "cache")).key;
  });
  after(() => srv.stop());

  test("public reads are fresh after any write, from the server or the CLI", async () => {
    const board = async () => (await req(srv.base, "GET", "/api/leaderboard?days=30", { anon: true })).json;
    const tokens = async () => (await req(srv.base, "GET", "/api/u/admin/summary", { anon: true })).json.total.tokens;
    const before = await board();
    assert.deepEqual(await board(), before);
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ usage: { input_tokens: 5 } }) });
    assert.equal((await board()).totals.tokens, before.totals.tokens + 5);
    assert.equal(await tokens(), before.totals.tokens + 5);
    // Another connection (the CLI, a restore) writing to the same DB.
    withDb(srv, (db) => db.prepare("UPDATE users SET display_name = 'Written elsewhere' WHERE id = 1").run());
    assert.equal((await board()).entries.find((e) => e.username === "admin").display_name, "Written elsewhere");
  });

  test("read indexes replace the old ones", async () => {
    const db = new Database(srv.dbPath, { readonly: true });
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_events'").all().map((r) => r.name);
    db.close();
    assert.ok(names.includes("idx_usage_user_read") && names.includes("idx_usage_user_session_read"), String(names));
    assert.ok(!names.includes("idx_usage_device_prompt") && !names.includes("idx_usage_user_time"), String(names));
  });
});

describe("leaderboard", () => {
  test("ranks every enabled account by tokens, publicly", async () => {
    const srv = await startServer();
    try {
      const admin = await login(srv.base, TEST_ADMIN.username);
      const bob = (await register(srv.base, "bob", { over: { name: "Bob" } })).cookie;
      await register(srv.base, "idle");
      const gone = (await register(srv.base, "gone")).cookie;
      // The server decides "today" when it reads: keep the posts and the
      // reads on one UTC day.
      await awayFromMidnight();
      const now = Math.floor(Date.now() / 1000);
      const post = (key, over) => req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event(over) });
      const adminKey = (await newDevice(srv.base, "a", admin)).key;
      const bobKey = (await newDevice(srv.base, "b", bob)).key;
      const goneKey = (await newDevice(srv.base, "g", gone)).key;
      // admin: 180 tokens today; bob: 180 today + 180 yesterday + 1800 sixty days ago.
      await post(adminKey, { session_id: "a1", occurred_at: now });
      await post(bobKey, { session_id: "b1", model: "claude-sonnet-5", occurred_at: now });
      await post(bobKey, { session_id: "b2", model: "claude-sonnet-5", occurred_at: now - 86400 });
      await post(bobKey, { session_id: "b3", occurred_at: now - 60 * 86400,
        usage: { input_tokens: 1000, output_tokens: 800 } });
      await post(goneKey, { session_id: "g1", usage: { input_tokens: 99999 } });
      await req(srv.base, "POST", `/api/users/${await userId(srv.base, "gone", admin)}/disable`, { cookie: admin });

      // Public, like profile pages: same answer for visitors.
      const month = (await req(srv.base, "GET", "/api/leaderboard?days=30", { anon: true })).json;
      assert.deepEqual((await req(srv.base, "GET", "/api/leaderboard?days=30", { cookie: bob })).json, month);
      assert.equal(month.range_days, 30);
      assert.equal(month.accounts, 3);
      assert.deepEqual(month.totals, { tokens: 540, sessions: 3, events: 3, active_accounts: 2 });
      // Idle accounts are listed too, last, with zeros.
      assert.deepEqual(month.entries.map((e) => [e.username, e.tokens]), [["bob", 360], ["admin", 180], ["idle", 0]]);
      assert.deepEqual(month.entries[2], {
        username: "idle", display_name: "idle", avatar_url: null, tokens: 0, sessions: 0, events: 0, active_days: 0,
        top_model: null, last_active: null, current_streak: 0,
      });
      const b = month.entries[0];
      assert.equal(b.display_name, "Bob");
      assert.equal(b.sessions, 2);
      assert.equal(b.active_days, 2);
      assert.equal(b.top_model, "claude-sonnet-5");
      assert.equal(b.current_streak, 2); // events today and yesterday
      assert.equal(month.entries[1].current_streak, 1);
      assert.deepEqual(month.by_model.map((m) => m.name), ["claude-sonnet-5", "claude-opus-5-5"]);

      const all = (await req(srv.base, "GET", "/api/leaderboard?days=all", { cookie: bob })).json;
      assert.equal(all.range_days, null);
      assert.equal(all.entries[0].tokens, 2160);
      assert.equal(all.entries[0].top_model, "claude-opus-5-5");
      assert.equal(all.activity.reduce((a, d) => a + d.tokens, 0), 2340);
      // Disabled accounts never appear.
      assert.ok(!all.entries.some((e) => e.username === "gone"));
    } finally {
      await srv.stop();
    }
  });

  test("a streak survives a today without usage yet, not a missed day", async () => {
    const srv = await startServer();
    try {
      const admin = await login(srv.base, TEST_ADMIN.username);
      const key = (await newDevice(srv.base, "a", admin)).key;
      // The server decides "today" when it reads: keep the posts and the
      // reads on one UTC day.
      await awayFromMidnight();
      const now = Math.floor(Date.now() / 1000);
      const streak = async () => (await req(srv.base, "GET", "/api/leaderboard?days=30", { anon: true })).json.entries[0].current_streak;
      // Yesterday and the day before, nothing today yet.
      for (const d of [1, 2]) {
        await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ session_id: `s${d}`, occurred_at: now - d * 86400 }) });
      }
      assert.equal(await streak(), 2);
      await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ session_id: "s0", occurred_at: now }) });
      assert.equal(await streak(), 3);
    } finally {
      await srv.stop();
    }
  });
});

describe("local days (like GitHub's contribution calendar)", () => {
  let srv, key, cookie;
  const post = (over) => req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event(over) });
  const get = async (p) => (await req(srv.base, "GET", `/api/u/tz/${p}`, { anon: true })).json;
  const iso = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
  // 23:30 UTC three days ago: already the next day at UTC+2, still that day in UTC.
  const lateUtc = Math.floor(Date.now() / 86400000) * 86400 - 3 * 86400 + 23.5 * 3600;
  before(async () => {
    srv = await startServer();
    cookie = (await register(srv.base, "tz")).cookie;
    key = (await newDevice(srv.base, "tz-laptop", cookie)).key;
  });
  after(() => srv.stop());

  test("an event counts on the local day where it happened", async () => {
    await post({ event_id: "msg_tz_paris", occurred_at: lateUtc, utc_offset_min: 120 });
    // Invalid offsets are dropped: the event counts as UTC.
    await post({ event_id: "msg_tz_bad", occurred_at: lateUtc, utc_offset_min: 7 });
    const days = (await get("activity?days=30")).days;
    assert.deepEqual(days.map((d) => [d.day, d.tokens]), [[iso(lateUtc), 180], [iso(lateUtc + 86400), 180]]);
  });

  test("a replay dates an event stored without an offset, once", async () => {
    await post({ event_id: "msg_tz_old", occurred_at: lateUtc });
    const replay = await post({ event_id: "msg_tz_old", occurred_at: lateUtc, utc_offset_min: 120 });
    assert.equal(replay.json.deduped, true);
    // A known offset never changes: the day does not move afterwards.
    await post({ event_id: "msg_tz_old", occurred_at: lateUtc, utc_offset_min: -300 });
    const days = (await get("activity?days=30")).days;
    assert.deepEqual(days.map((d) => [d.day, d.tokens]), [[iso(lateUtc), 180], [iso(lateUtc + 86400), 360]]);
  });

  test("today is the owner's day at their latest offset, for every visitor", async () => {
    const now = Math.floor(Date.now() / 1000);
    // UTC+14: the owner's today may already be tomorrow in UTC.
    await post({ event_id: "msg_tz_now", occurred_at: now, utc_offset_min: 840 });
    const today = iso(now + 840 * 60);
    const s = await get("summary");
    assert.equal(s.day, today);
    assert.equal(s.today.tokens, 180);
    const days = (await get("activity?days=1")).days;
    assert.deepEqual(days.map((d) => d.day), [today]);
    const board = (await req(srv.base, "GET", "/api/leaderboard?days=30", { anon: true })).json;
    assert.equal(board.day, today);
    assert.equal(board.entries.find((e) => e.username === "tz").current_streak, 1);
    assert.equal(board.activity.at(-1).day, today);
  });
});

describe("summary, sessions and context (redesign APIs)", () => {
  let srv, key;
  before(async () => {
    srv = await startServer();
    key = (await newDevice(srv.base)).key;
  });
  after(() => srv.stop());

  test("summary splits all-time and today by model and tool", async () => {
    // The server decides "today" when it reads: keep the posts and the
    // read on one UTC day.
    await awayFromMidnight();
    const now = Math.floor(Date.now() / 1000);
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ session_id: "a", model: "claude-opus-5-5", occurred_at: now }) });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event({ session_id: "b", model: "claude-sonnet-5", occurred_at: now - 40 * 86400 }) });
    const s = (await req(srv.base, "GET", "/api/u/admin/summary")).json;
    assert.equal(s.total.tokens, 360);
    assert.equal(s.total.sessions, 2);
    assert.equal(s.today.tokens, 180);
    assert.equal(s.today.sessions, 1);
    assert.deepEqual(s.total.by_model.map((r) => r.name).sort(), ["claude-opus-5-5", "claude-sonnet-5"]);
    assert.equal(s.total.by_model_others_sessions, 0);
    assert.deepEqual(s.total.by_tool, [{ name: "claude-code", tokens: 360, sessions: 2, events: 2 }]);
    assert.equal(s.day, new Date(now * 1000).toISOString().slice(0, 10));
    assert.equal((await req(srv.base, "GET", "/api/u/admin/summary?tool=codex")).json.total.tokens, 0);
  });

  test("sessions report the latest context fill and a total for paging", async () => {
    const at = Math.floor(Date.now() / 1000);
    const m = (id, t) => ({ message_id: id, session_id: "ctx", occurred_at: t, usage: { input_tokens: 5 } });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: { messages: [m("msg_c1", at - 10), m("msg_c2", at)] } });
    // A raw statusLine payload puts its gauge on the session's newest row.
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: {
      session_id: "ctx", context_window: { context_window_size: 200000, used_percentage: 20, current_usage: { input_tokens: 5 } },
    } });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: {
      session_id: "ctx", context_window: { context_window_size: 200000, used_percentage: 35 },
    } });
    await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: { messages: [m("msg_c3", at - 5)] } });
    const r = (await req(srv.base, "GET", "/api/u/admin/sessions?limit=1")).json;
    assert.equal(r.sessions.length, 1);
    assert.equal(r.total, 3); // sessions a, b and ctx
    const ctx = (await req(srv.base, "GET", "/api/u/admin/sessions?limit=50")).json.sessions.find((s) => s.session_id === "ctx");
    assert.equal(ctx.context_used_pct, 35);
    assert.equal(ctx.context_window_size, 200000);
    const noCtx = (await req(srv.base, "GET", "/api/u/admin/sessions?limit=50")).json.sessions.find((s) => s.session_id === "a");
    assert.equal(noCtx.context_used_pct, null);
    assert.equal((await req(srv.base, "GET", "/api/u/admin/sessions?tool=codex")).json.total, 0);
  });

  test("summary counts distinct sessions across model rows folded into others", async () => {
    const now = Math.floor(Date.now() / 1000);
    const messages = [];
    for (let model = 0; model < 7; model++) {
      for (let session = 0; session < 3; session++) {
        messages.push({
          response_id: `resp_fold_top_${model}_${session}`,
          session_id: `fold-top-${model}-${session}`,
          model: `top-${model}`,
          occurred_at: now,
          usage: { input_tokens: 10 + model },
        });
      }
    }
    // Both folded models have two sessions, but one session used both:
    // the exact folded count is three, not the row sum of four.
    messages.push(
      { response_id: "resp_fold_a_shared", session_id: "fold-shared", model: "tail-a", occurred_at: now, usage: { input_tokens: 1 } },
      { response_id: "resp_fold_a_own", session_id: "fold-a", model: "tail-a", occurred_at: now, usage: { input_tokens: 1 } },
      { response_id: "resp_fold_b_shared", session_id: "fold-shared", model: "tail-b", occurred_at: now, usage: { input_tokens: 1 } },
      { response_id: "resp_fold_b_own", session_id: "fold-b", model: "tail-b", occurred_at: now, usage: { input_tokens: 1 } },
    );
    const ingested = await req(srv.base, "POST", "/api/ingest/codex", { key, body: { messages } });
    assert.equal(ingested.json.stored, messages.length);

    const total = (await req(srv.base, "GET", "/api/u/admin/summary?tool=codex")).json.total;
    const folded = [...total.by_model].sort((a, b) => b.sessions - a.sessions).slice(7);
    assert.deepEqual(folded.map((row) => row.name), ["tail-a", "tail-b"]);
    assert.equal(folded.reduce((sum, row) => sum + row.sessions, 0), 4);
    assert.equal(total.by_model_others_sessions, 3);
  });
});

describe("shutdown", () => {
  test("SIGTERM closes the server and checkpoints the SQLite WAL", async () => {
    const srv = await startServer();
    try {
      const { key } = await newDevice(srv.base);
      await req(srv.base, "POST", "/api/ingest/claude-code", { key, body: event() });
      assert.ok(fs.existsSync(`${srv.dbPath}-wal`));
      assert.equal(await srv.kill(), 0);
      assert.ok(!fs.existsSync(`${srv.dbPath}-wal`));
    } finally {
      await srv.stop();
    }
  });
});

describe("limits, bounds and admin edge cases", () => {
  test("the global cap of 50 wrong setup codes locks every client, owner included", async () => {
    const srv = await startServer({ autoLogin: false });
    try {
      const attempt = (ip, setup_code = "nope") => req(srv.base, "POST", "/api/auth/github", {
        anon: true, body: { setup_code }, headers: { "cf-connecting-ip": ip },
      });
      for (let c = 0; c < 5; c++) for (let i = 0; i < 10; i++) assert.equal((await attempt(`203.0.113.${100 + c}`)).status, 401);
      const owner = await attempt("203.0.113.200", srv.setupCode());
      assert.equal(owner.status, 429);
      assert.ok(Number(owner.headers.get("retry-after")) > 0);
    } finally {
      await srv.stop();
    }
  });

  test("query parameters are clamped to their documented bounds", async () => {
    const srv = await startServer();
    try {
      const days = async (q) => (await req(srv.base, "GET", `/api/u/admin/stats?${q}`)).json.range_days;
      assert.deepEqual([await days("days=99999"), await days("days=-5"), await days("days=abc"), await days("")], [730, 1, 30, 30]);
      const board = async (q) => (await req(srv.base, "GET", `/api/leaderboard?${q}`, { anon: true })).json.range_days;
      assert.deepEqual([await board("days=7"), await board("days=all"), await board("days=99999"), await board("")], [7, null, 730, 30]);
      for (const q of ["limit=999", "limit=-1", "offset=-4", "limit=abc&offset=abc"]) {
        assert.equal((await req(srv.base, "GET", `/api/u/admin/sessions?${q}`)).status, 200, q);
      }
    } finally {
      srv.stop();
    }
  });

  test("admin actions on an unknown user id are 404", async () => {
    const srv = await startServer();
    try {
      assert.equal((await req(srv.base, "POST", "/api/users/99999/enable")).status, 404);
      assert.equal((await req(srv.base, "POST", "/api/users/99999/disable")).status, 404);
      assert.equal((await req(srv.base, "POST", "/api/users/99999/admin", { body: { is_admin: true } })).status, 404);
    } finally {
      srv.stop();
    }
  });

});

describe("migrations", () => {
  test("an old database: removed features' leftovers dropped, the data in the pre-upgrade backup only", async () => {
    const dir = fs.mkdtempSync(`${os.tmpdir()}/ai-usage-legacy-`);
    const dbPath = `${dir}/t.db`;
    const old = new Database(dbPath);
    old.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL);
      CREATE TABLE devices (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL DEFAULT '', revoked INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL);
      CREATE TABLE usage_events (event_id TEXT PRIMARY KEY, device_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
        tool TEXT NOT NULL, session_id TEXT, prompt_id TEXT, model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_estimated_usd REAL, occurred_at INTEGER NOT NULL, received_at INTEGER NOT NULL);
      CREATE TABLE billing_records (id INTEGER PRIMARY KEY);
      CREATE TABLE subscriptions (id INTEGER PRIMARY KEY);
      CREATE TABLE invites (id INTEGER PRIMARY KEY);
      CREATE TABLE app_settings (key TEXT PRIMARY KEY);
      INSERT INTO users (id, created_at) VALUES (1, 0);
      INSERT INTO devices (user_id, name, key_hash, created_at) VALUES (1, 'old', 'h', 0);
      INSERT INTO usage_events (event_id, device_id, user_id, tool, input_tokens, cost_estimated_usd, occurred_at, received_at)
        VALUES ('e1', 1, 1, 'claude-code', 42, 0.1, 0, 0);
    `);
    old.close();
    const srv = await startServer({ env: { DB_PATH: dbPath }, autoLogin: false });
    await srv.stop();
    const db = new Database(dbPath, { readonly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
      for (const t of ["billing_records", "subscriptions", "invites", "app_settings"]) assert.ok(!tables.includes(t), t);
      const cols = db.prepare("PRAGMA table_info(usage_events)").all().map((c) => c.name);
      assert.ok(!cols.includes("cost_estimated_usd"));
      // Migration 5 starts over for GitHub sign-in; the backup made first keeps it.
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_events").get().n, 0);
      const [backup] = fs.readdirSync(`${dir}/backups`).filter((f) => f.endsWith("-pre-v5.db"));
      const kept = new Database(`${dir}/backups/${backup}`, { readonly: true });
      assert.equal(kept.prepare("SELECT input_tokens FROM usage_events WHERE event_id = 'e1'").get().input_tokens, 42);
      kept.close();
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("web root without index.html", () => {
  test("client routes return 404 instead of a stale or broken page", async () => {
    const root = fs.mkdtempSync(`${os.tmpdir()}/ai-usage-empty-`);
    const srv = await startServer({ env: { STATIC_DIR: root } });
    try {
      assert.equal((await req(srv.base, "GET", "/some/client/route")).status, 404);
      fs.writeFileSync(`${root}/index.html`, "<!doctype html><p>built</p>");
      const r = await req(srv.base, "GET", "/some/client/route");
      assert.equal(r.status, 200);
      assert.match(r.text, /built/);
    } finally {
      await srv.stop();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("codex ingestion", () => {
  let srv, key;
  const post = (body) => req(srv.base, "POST", "/api/ingest/codex", { body: { collector: collector("codex"), ...body }, key });
  const summary = async (tool = "codex") => (await req(srv.base, "GET", `/api/u/admin/summary?tool=${tool}`)).json.total;

  before(async () => {
    srv = await startServer();
    key = (await newDevice(srv.base, "codex")).key;
  });
  after(() => srv.stop());

  test("a response is stored once, cached input and reasoning counted once", async () => {
    // OpenAI counts cached input inside input_tokens and reasoning inside output_tokens.
    const m = codexResponse({ response_id: "resp_a", usage: {
      input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 20,
    } });
    const r = await post({ messages: [m] });
    assert.deepEqual(r.json, { ok: true, messages: 1, stored: 1, updated: 0, deduped: 0 });
    assert.deepEqual((await post({ messages: [m] })).json, { ok: true, messages: 1, stored: 0, updated: 0, deduped: 1 });
    const t = await summary();
    assert.equal(t.tokens, 1050);
    assert.equal(t.events, 1);
    assert.deepEqual(t.by_model.map((x) => x.name), ["gpt-6-astra"]);
    assert.equal((await summary("claude-code")).events, 0);
    const s = (await req(srv.base, "GET", "/api/u/admin/sessions?tool=codex")).json.sessions[0];
    assert.equal(s.tool, "codex");
    assert.equal(s.session_id, m.session_id);
  });

  test("only Codex response ids or legacy token_count ids are stored", async () => {
    const before = (await summary()).events;
    const r = await post({ messages: [
      codexResponse({ response_id: "msg_not_codex" }),
      codexResponse({ response_id: undefined }),
      codexResponse({ response_id: undefined, event_id: "01a0-random" }),
      codexResponse({ response_id: undefined, event_id: "tc_019e0073-fee_12345" }),
      codexResponse({ response_id: undefined, event_id: "tc_019e0073-fee_12345" }),
    ] });
    assert.equal(r.json.messages, 2);
    assert.equal(r.json.stored, 1);
    assert.equal((await summary()).events, before + 1);
  });

  test("a flat event is accepted too", async () => {
    const r = await post({ tool: "codex", ...codexResponse({ response_id: "resp_flat" }) });
    assert.equal(r.json.stored, true);
    assert.equal(r.json.event_id, "resp_flat");
    assert.equal((await req(srv.base, "POST", "/api/ingest/codex", { body: { tool: "claude-code" }, key })).status, 400);
  });

  test("primary / secondary rate limits become the 5-hour and weekly windows", async () => {
    const now = Math.floor(Date.now() / 1000);
    await post({ messages: [], occurred_at: now - 60, rate_limits: {
      primary: { used_percent: 17, window_minutes: 300, resets_at: now + 3600 },
      secondary: { used_percent: 75, window_minutes: 10080, resets_at: now + 86400 },
      tertiary: { used_percent: 5, window_minutes: 60, resets_at: now + 600 },
    } });
    // A stale value from another device, measured earlier, does not win.
    await post({ messages: [], occurred_at: now - 600, rate_limits: {
      primary: { used_percent: 3, window_minutes: 300, resets_at: now + 3000 },
      // Resets further away than a week: dropped.
      secondary: { used_percent: 1, window_minutes: 10080, resets_at: now + 30 * 86400 },
    } });
    const q = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas.filter((x) => x.tool === "codex");
    assert.deepEqual(q.map((x) => [x.limit_type, x.used_pct]), [["five_hour", 17], ["seven_day", 75]]);
    assert.equal(q[0].measured_at, now - 60);
  });

  test("the context gauge is computed from the last request's tokens", async () => {
    const m = codexResponse({ response_id: "resp_ctx", session_id: "codex-ctx" });
    await post({ messages: [m], context: { session_id: "codex-ctx", used_tokens: 51680, window_size: 258400 } });
    const s = (await req(srv.base, "GET", "/api/u/admin/sessions?tool=codex&limit=50")).json.sessions.find((x) => x.session_id === "codex-ctx");
    assert.equal(s.context_used_pct, 20);
    assert.equal(s.context_window_size, 258400);
  });
});

describe("opencode ingestion", () => {
  let srv, key;
  const post = (body) => req(srv.base, "POST", "/api/ingest/opencode", { body: { collector: collector("opencode"), ...body }, key });
  const summary = async (tool = "opencode") => (await req(srv.base, "GET", `/api/u/admin/summary?tool=${tool}`)).json.total;

  before(async () => {
    srv = await startServer();
    key = (await newDevice(srv.base, "opencode")).key;
  });
  after(() => srv.stop());

  test("a message is stored once, as provider/model, reasoning added to output", async () => {
    // OpenCode 1.18 counts reasoning apart: its total adds it.
    const m = opencodeMessage();
    assert.deepEqual((await post({ messages: [m] })).json, { ok: true, messages: 1, stored: 1, updated: 0, deduped: 0 });
    assert.deepEqual((await post({ messages: [m] })).json, { ok: true, messages: 1, stored: 0, updated: 0, deduped: 1 });
    const t = await summary();
    assert.equal(t.tokens, 27929);
    assert.equal(t.events, 1);
    assert.deepEqual(t.by_model.map((x) => x.name), ["anthropic/claude-sonnet-5"]);
    assert.equal((await summary("claude-code")).events, 0);
    const s = (await req(srv.base, "GET", "/api/u/admin/sessions?tool=opencode")).json.sessions[0];
    assert.equal(s.tool, "opencode");
    assert.equal(s.session_id, m.session_id);
  });

  test("reasoning already inside output is not counted twice", async () => {
    const before = (await summary()).tokens;
    await post({ messages: [opencodeMessage({ usage: {
      input_tokens: 100, output_tokens: 50, reasoning_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 150,
    } })] });
    // No total: OpenCode 1.18 semantics, reasoning is added.
    await post({ messages: [opencodeMessage({ usage: { input_tokens: 100, output_tokens: 50, reasoning_tokens: 20 } })] });
    assert.equal((await summary()).tokens - before, 150 + 170);
  });

  test("an OpenCode id never collides with the same Anthropic message id", async () => {
    const id = "msg_0d8b79c14001nstvFNseBdTpVD";
    await req(srv.base, "POST", "/api/ingest/claude-code", { body: event({ event_id: id }), key });
    const r = await post({ messages: [opencodeMessage({ message_id: id })] });
    assert.equal(r.json.stored, 1);
  });

  test("only OpenCode message ids are stored, and a flat event is accepted", async () => {
    const r = await post({ messages: [
      opencodeMessage({ message_id: "resp_not_opencode" }),
      opencodeMessage({ message_id: undefined }),
      opencodeMessage({ usage: undefined }),
    ] });
    assert.equal(r.json.messages, 0);
    const flat = await post({ tool: "opencode", ...opencodeMessage({ message_id: "msg_flat" }) });
    assert.equal(flat.json.stored, true);
    assert.equal(flat.json.event_id, "opencode:msg_flat");
    assert.equal((await req(srv.base, "POST", "/api/ingest/opencode", { body: { tool: "codex" }, key })).status, 400);
  });

  test("a partial message is replaced by its final counts", async () => {
    const before = (await summary()).tokens;
    const m = opencodeMessage({ usage: { input_tokens: 10, output_tokens: 5, reasoning_tokens: 0 } });
    await post({ messages: [m] });
    const r = await post({ messages: [{ ...m, usage: { input_tokens: 10, output_tokens: 90, reasoning_tokens: 0 } }] });
    assert.equal(r.json.updated, 1);
    assert.equal((await summary()).tokens - before, 100);
  });

  test("no quota is recorded", async () => {
    const now = Math.floor(Date.now() / 1000);
    await post({ messages: [], rate_limits: { five_hour: { used_percentage: 10, resets_at: now + 3600 } } });
    const q = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas.filter((x) => x.tool === "opencode");
    assert.deepEqual(q, []);
  });
});

describe("antigravity ingestion", () => {
  let srv, key;
  const post = (body) => req(srv.base, "POST", "/api/ingest/antigravity", { body: { collector: collector("antigravity"), ...body }, key });
  const summary = async () => (await req(srv.base, "GET", "/api/u/admin/summary?tool=antigravity")).json.total;
  const response = (over = {}) => ({
    response_id: "r1", session_id: "conv1", model: "gemini-3-pro",
    occurred_at: Math.floor(Date.now() / 1000) - 60, utc_offset_min: 120,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 300 }, ...over,
  });

  before(async () => {
    srv = await startServer();
    key = (await newDevice(srv.base, "antigravity")).key;
  });
  after(() => srv.stop());

  test("a flat event is stored once, keyed by session and response", async () => {
    const r = await post({ tool: "antigravity", ...response() });
    assert.equal(r.json.stored, true);
    assert.equal(r.json.event_id, "antigravity:conv1:r1");
    assert.equal((await post(response())).json.deduped, true);
    const t = await summary();
    assert.equal(t.tokens, 420);
    assert.equal(t.events, 1);
    const s = (await req(srv.base, "GET", "/api/u/admin/sessions?tool=antigravity")).json.sessions[0];
    assert.equal(s.session_id, "antigravity:conv1");
  });

  test("a partial response is replaced by its final counts, counted once", async () => {
    const before = await summary();
    const m = response({ response_id: "r-partial", usage: { input_tokens: 10, output_tokens: 5 } });
    assert.equal((await post({ messages: [m] })).json.stored, 1);
    const r = await post({ messages: [{ ...m, usage: { input_tokens: 10, output_tokens: 90 } }] });
    assert.equal(r.json.updated, 1);
    const after = await summary();
    assert.equal(after.tokens - before.tokens, 100);
    assert.equal(after.events - before.events, 1);
  });

  test("quotas are recorded for a known pool only", async () => {
    const limits = { five_hour: { used_percentage: 40, resets_at: soon() } };
    await post({ messages: [], account_ref: "unknown-pool", rate_limits: limits });
    await post({ messages: [], account_ref: "gemini", rate_limits: limits });
    const q = (await req(srv.base, "GET", "/api/u/admin/quotas")).json.quotas.filter((x) => x.tool === "antigravity");
    assert.deepEqual(q.map((x) => [x.account_ref, x.limit_type, x.used_pct]), [["gemini", "five_hour", 40]]);
  });
});

describe("rate limits", () => {
  const post = (base, key, body) => req(base, "POST", "/api/ingest/claude-code", { key, body });
  /**
   * Sends up to `max` requests until one is refused. Buckets refill while
   * the burst runs (more on a slow runner), so the check is: the burst
   * passes, then no more than what refilled meanwhile.
   */
  async function burst(send, { capacity, perSec, max }) {
    const start = Date.now();
    let ok = 0;
    let refused = null;
    while (ok + (refused ? 1 : 0) < max) {
      const r = await send();
      if (r.status === 429) { refused = r; break; }
      assert.equal(r.status, 200, r.text);
      ok += 1;
    }
    const refilled = Math.ceil(((Date.now() - start) / 1000) * perSec);
    assert.ok(refused, `never refused after ${ok} requests`);
    assert.ok(ok >= capacity && ok <= capacity + refilled, `${ok} passed; burst ${capacity}, refilled ${refilled}`);
    assert.ok(Number(refused.headers.get("retry-after")) >= 1);
  }
  const batch = (n, tag) => ({
    messages: Array.from({ length: n }, (_, i) => ({ ...event(), message_id: `msg_rl_${tag}_${i}` })),
  });

  test("ingest: a device over its row budget gets 429 + Retry-After and nothing is stored; replays cost nothing; other devices are not limited", async (t) => {
    const srv = await startServer();
    t.after(() => srv.stop());
    const a = await newDevice(srv.base, "flood");
    const b = await newDevice(srv.base, "normal");
    // Replays are free: the same batch resent many times only wrote once.
    const same = batch(400, "same");
    for (let i = 0; i < 60; i++) assert.equal((await post(srv.base, a.key, same)).status, 200);
    // The burst is 20,000 rows (400 written above): the batch that crosses it is still stored...
    for (let i = 0; i < 50; i++) assert.equal((await post(srv.base, a.key, batch(400, `a${i}`))).status, 200);
    const events = async () => (await req(srv.base, "GET", "/api/u/admin/summary", { anon: true })).json.total.events;
    assert.equal(await events(), 20_400);
    // ...and leaves the device in debt: a batch that would write is rolled back...
    const quotas = { five_hour: { used_percentage: 42, resets_at: Math.floor(Date.now() / 1000) + 3600 } };
    const over = await post(srv.base, a.key, { ...batch(400, "over"), rate_limits: quotas });
    assert.equal(over.status, 429);
    assert.ok(Number(over.headers.get("retry-after")) >= 1);
    assert.equal(await events(), 20_400);
    // ...but its quotas are kept, and replays still pass: a collector resending
    // its backlog gets as far as the new rows every run.
    const q = (await req(srv.base, "GET", "/api/u/admin/quotas", { anon: true })).json.quotas;
    assert.deepEqual(q.map((x) => [x.tool, x.used_pct]), [["claude-code", 42]]);
    assert.equal((await post(srv.base, a.key, same)).status, 200);
    // Other tools on the same device, and other devices, are not held up.
    const codex = await req(srv.base, "POST", "/api/ingest/codex", { key: a.key, body: { messages: [codexResponse()] } });
    assert.equal(codex.status, 200);
    assert.equal((await post(srv.base, b.key, batch(1, "b"))).status, 200);
    assert.equal(await events(), 20_402);
  });

  test("ingest: requests are capped per device and tool, replays too (with a larger budget)", async (t) => {
    const srv = await startServer();
    t.after(() => srv.stop());
    const { key } = await newDevice(srv.base);
    // Quotas only: no rows, one request each.
    const quotasOnly = { rate_limits: { five_hour: { used_percentage: 1, resets_at: Math.floor(Date.now() / 1000) + 3600 } } };
    await burst(() => post(srv.base, key, quotasOnly), { capacity: 300, perSec: 5, max: 1000 });
    const other = await newDevice(srv.base, "replays");
    const one = event();
    assert.equal((await post(srv.base, other.key, one)).json.stored, true); // stored: not a replay
    await burst(() => post(srv.base, other.key, one), { capacity: 3000, perSec: 50, max: 10_000 });
  });

  test("public reads: over the per-client budget → 429, other clients unaffected", async (t) => {
    const srv = await startServer();
    t.after(() => srv.stop());
    const get = (p, ip) => req(srv.base, "GET", p, { anon: true, headers: { "cf-connecting-ip": ip } });
    const paths = ["/api/leaderboard", "/api/u/admin/summary", "/api/profiles", "/api/u/admin/activity"];
    let i = 0;
    await burst(() => get(paths[i++ % 4], "203.0.113.60"), { capacity: 300, perSec: 5, max: 1000 });
    assert.equal((await get("/api/leaderboard", "203.0.113.61")).status, 200);
    // Health and the sign-in status are not public reads.
    assert.equal((await get("/api/health", "203.0.113.60")).status, 200);
    assert.equal((await get("/api/auth/status", "203.0.113.60")).status, 200);
  });

  test("signed-in routes: over the per-user budget → 429, other users unaffected", async (t) => {
    const srv = await startServer();
    t.after(() => srv.stop());
    await burst(() => req(srv.base, "GET", "/api/devices"), { capacity: 120, perSec: 1, max: 500 });
    const bob = await register(srv.base, "ratebob");
    assert.equal((await req(srv.base, "GET", "/api/devices", { cookie: bob.cookie })).status, 200);
  });

  test("an account has at most 20 live devices; revoking one frees a slot", async (t) => {
    const srv = await startServer();
    t.after(() => srv.stop());
    const ids = [];
    for (let i = 0; i < 20; i++) ids.push((await newDevice(srv.base, `d${i}`)).id);
    const full = await req(srv.base, "POST", "/api/devices", { body: { name: "one too many" } });
    assert.equal(full.status, 409);
    assert.match(full.json.error, /at most 20 devices/);
    assert.equal((await req(srv.base, "POST", `/api/devices/${ids[0]}/revoke`)).status, 200);
    assert.equal((await req(srv.base, "POST", "/api/devices", { body: { name: "replacement" } })).status, 200);
  });
});
