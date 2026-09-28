import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Config } from "./config.ts";
import type { DB } from "./db/schema.ts";
import { clientInfo } from "./lib/client.ts";
import { buildInstallers } from "./lib/installer.ts";
import { jsonOnly, limitBody, readCache } from "./lib/http.ts";
import { LIMITS, rateLimit, tokenBuckets } from "./lib/rate-limit.ts";
import { createViewerAuth } from "./lib/viewer-auth.ts";
import { accountRoutes, adminRoutes, userRoutes } from "./routes/account.ts";
import { authRoutes } from "./routes/auth.ts";
import { deviceRoutes } from "./routes/devices.ts";
import { friendsRoutes } from "./routes/friends.ts";
import { ingestRoutes } from "./routes/ingest.ts";
import { leaderboardRoutes, profileListRoutes, publicProfileRoutes } from "./routes/usage.ts";

/** setupCode: one-time code for creating the first account from the browser (null once one exists). */
export function createApp(db: DB, config: Config, setupCode: string | null = null) {
  const client = clientInfo(config.trustProxy);
  const auth = createViewerAuth(db, client);
  const cache = readCache(db);
  const publicReads = rateLimit(tokenBuckets(LIMITS.publicReads), (c) => auth.clientId(c));
  const perUser = rateLimit(tokenBuckets(LIMITS.sessionRequests), (c) => String(c.get("userId")));
  const oauth = rateLimit(tokenBuckets(LIMITS.oauth), (c) => auth.clientId(c));

  const api = new Hono()
    .use(limitBody(256 * 1024))
    .use(jsonOnly)
    .use(async (c, next) => {
      await next();
      c.header("cache-control", "no-store");
    })
    .get("/health", (c) => c.json({ ok: true }))
    // Starting a GitHub sign-in, per client. Not GitHub's callback: a
    // successful sign-in must not cost twice, and the callback only works
    // with a state this server just handed out.
    .on("POST", "/auth/github", oauth)
    .route("/auth", authRoutes(db, auth, client, config.github, config.publicUrl, setupCode))
    .route("/ingest", ingestRoutes(db))
    // Public, read-only: profile pages, the account list and the leaderboard.
    .use("/u/*", publicReads)
    .use("/leaderboard", publicReads)
    .use("/profiles", publicReads)
    .use("/u/*", cache)
    .use("/leaderboard", cache)
    .route("/u/:username", publicProfileRoutes(db))
    .route("/leaderboard", leaderboardRoutes(db))
    .route("/profiles", profileListRoutes(db))
    // Everything below requires a viewer session.
    .use(auth.require)
    .use(perUser)
    .route("/friends", friendsRoutes(db, config.github))
    .route("/devices", deviceRoutes(db))
    .route("/account", accountRoutes(db))
    .route("/users", userRoutes(db))
    .route("/admin", adminRoutes(db));

  const indexFile = path.join(config.staticDir, "index.html");
  // Served from memory; an async stat per request picks up a rebuilt web
  // root (new hashed asset names) without a restart or blocking I/O.
  let index: { mtimeMs: number; html: string } | null = null;
  const loadIndex = async (): Promise<string | null> => {
    try {
      const { mtimeMs } = await fs.promises.stat(indexFile);
      if (index?.mtimeMs !== mtimeMs) index = { mtimeMs, html: await fs.promises.readFile(indexFile, "utf8") };
      return index.html;
    } catch {
      index = null;
      return null;
    }
  };

  // Built once: the collectors only change with a new server version.
  const installers = buildInstallers();

  const app = new Hono()
    .route("/api", api)
    .all("/api/*", (c) => c.json({ error: "not found" }, 404))
    .get("/install.sh", (c) => {
      c.header("cache-control", "no-store");
      return c.body(installers.sh, 200, { "content-type": "text/plain; charset=utf-8" });
    })
    .get("/install.ps1", (c) => {
      c.header("cache-control", "no-store");
      return c.body(installers.ps1, 200, { "content-type": "text/plain; charset=utf-8" });
    })
    .use("*", serveStatic({ root: config.staticDir }))
    // SPA fallback for unknown non-API paths.
    .get("*", async (c) => {
      const html = await loadIndex();
      return html === null ? c.text("not found", 404) : c.html(html);
    });

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    // Details stay in the server log; the public tunnel only sees a generic error.
    console.error(err);
    return c.json({ error: "internal server error" }, 500);
  });

  return app;
}
