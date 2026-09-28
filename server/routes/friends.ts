import { Hono } from "hono";
import type { FriendsResponse } from "../../shared/types.ts";
import { enabledUserByGithubId, getUser, latestUsageAt, toProfile, usageTotals } from "../db/queries.ts";
import { nowSec, type DB } from "../db/schema.ts";
import { followingReader, type GithubConfig } from "../lib/github.ts";
import type { ViewerEnv } from "../lib/viewer-auth.ts";

const RECENT_DAYS = 7;

/** A signed-in viewer's public GitHub follows that also have public profiles here. */
export function friendsRoutes(db: DB, github: GithubConfig | null) {
  const following = github ? followingReader(github) : null;
  return new Hono<ViewerEnv>().get("/", async (c) => {
    if (!following) return c.json({ error: "GitHub is not configured" }, 503);
    const viewer = getUser(db, c.get("userId"));
    if (!viewer) return c.json({ error: "account not found" }, 401);
    let ids: number[];
    try {
      ids = await following(viewer.github_id, viewer.username);
    } catch (err) {
      console.error(`GitHub following lookup failed: ${(err as Error).message}`);
      return c.json({ error: "GitHub following is unavailable. Try again later." }, 503);
    }
    const until = nowSec();
    const since = until - RECENT_DAYS * 86400;
    const friends = [];
    for (const id of new Set(ids)) {
      const user = enabledUserByGithubId(db, id);
      if (!user || user.id === viewer.id) continue;
      const totals = usageTotals(db, user.id, since, null);
      friends.push({ ...toProfile(user), tokens: totals.total_tokens, sessions: totals.sessions,
        last_active: latestUsageAt(db, user.id, since) });
    }
    return c.json<FriendsResponse>({ since, until, friends });
  });
}
