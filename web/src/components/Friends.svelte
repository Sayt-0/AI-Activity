<script lang="ts">
  import type { FriendsResponse } from "../../../shared/types.ts";
  import { api } from "../lib/api.ts";
  import { profilePath } from "../lib/dashboard.svelte.ts";
  import { fmtNum, plural } from "../lib/format.ts";
  import Avatar from "./Avatar.svelte";
  import Section from "./Section.svelte";

  let { onopen }: { onopen: (username: string) => void } = $props();
  let data = $state<FriendsResponse | null>(null);
  let error = $state(false);
  let loading = $state(true);

  const date = (seconds: number) => new Date(seconds * 1000).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });

  async function load() {
    loading = true;
    error = false;
    try {
      data = await api.friends();
    } catch {
      data = null;
      error = true;
    } finally {
      loading = false;
    }
  }

  $effect(() => { void load(); });
</script>

<Section title="GitHub friends" subtitle="People you follow who have an AI Activity profile">
  {#if loading && !data}<p class="state" role="status">Loading friends…</p>{/if}
  {#if error}
    <p class="state" role="alert">GitHub follows are unavailable right now. <button type="button" onclick={load}>Try again</button></p>
  {/if}
  {#if data}
    <p class="period">Measured usage from {date(data.since)} to {date(data.until)} (last 7 days). Dates shown in your local time.</p>
    {#if data.friends.length === 0}
      <p class="state" role="status">No accounts you follow on GitHub have an enabled AI Activity profile yet.</p>
    {:else}
      <ul class="list">
        {#each data.friends as friend (friend.username)}
          <li>
            <a href={profilePath(friend.username)} onclick={(event) => { event.preventDefault(); onopen(friend.username); }}>
              <Avatar name={friend.display_name} url={friend.avatar_url} size={40} />
              <span class="person"><strong>{friend.display_name}</strong><span class="handle">@{friend.username}</span></span>
            </a>
            <p class="usage">
              {fmtNum(friend.tokens)} tokens · {plural(friend.sessions, "conversation")}
              <span>{friend.last_active === null ? "No activity in the last 7 days" : `Last active ${date(friend.last_active)}`}</span>
            </p>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</Section>

<style>
  .period { margin: 0 0 12px; color: var(--muted); font-size: 12px; }
  .state { border: 1px solid var(--line); border-radius: var(--radius); padding: 18px; color: var(--muted); font-size: 13px; }
  .state button { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
  .list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
  li { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 18px; border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; }
  a { display: inline-flex; align-items: center; gap: 12px; min-width: 0; color: var(--text); text-decoration: none; }
  a:hover strong, a:focus-visible strong { text-decoration: underline; text-underline-offset: 2px; }
  .person { display: grid; gap: 2px; min-width: 0; }
  .person strong, .handle { overflow-wrap: anywhere; }
  .person strong { font-size: 14px; }
  .handle { color: var(--muted); font-size: 12px; }
  .usage { display: grid; gap: 3px; margin: 0; text-align: right; font-size: 13px; }
  .usage span { color: var(--muted); font-size: 12px; }
  @media (max-width: 600px) { .usage { padding-left: 52px; text-align: left; } }
</style>
