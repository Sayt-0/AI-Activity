<script lang="ts">
  import type { Account } from "../../../shared/types.ts";
  import Avatar from "./Avatar.svelte";

  let { account, onnavigate, onlogout }: {
    account: Account;
    /** In-app navigation to a path. */
    onnavigate: (path: string) => void;
    onlogout: () => void;
  } = $props();

  let open = $state(false);
  let root: HTMLDivElement;

  const pick = (fn: () => void) => () => {
    open = false;
    fn();
  };

  function onWindowClick(e: MouseEvent) {
    if (open && !root.contains(e.target as Node)) open = false;
  }
</script>

<svelte:window onclick={onWindowClick} onkeydown={(e) => { if (e.key === "Escape") open = false; }} />

<div class="account" bind:this={root}>
  <button type="button" class="trigger" aria-haspopup="menu" aria-expanded={open}
    aria-label="Account menu ({account.display_name})" title={account.display_name} onclick={() => (open = !open)}>
    <Avatar name={account.display_name} url={account.avatar_url} size={36} />
  </button>
  {#if open}
    <div class="menu" role="menu">
      <p class="who"><strong>{account.display_name}</strong><span class="mono">@{account.username}</span></p>
      <button type="button" role="menuitem" onclick={pick(() => onnavigate(`/u/${encodeURIComponent(account.username)}`))}>Your profile</button>
      <button type="button" role="menuitem" onclick={pick(() => onnavigate("/leaderboard"))}>Leaderboard</button>
      <button type="button" role="menuitem" onclick={pick(() => onnavigate("/friends"))}>Friends</button>
      <button type="button" role="menuitem" onclick={pick(() => onnavigate("/settings"))}>Settings</button>
      {#if account.is_admin}
        <button type="button" role="menuitem" onclick={pick(() => onnavigate("/admin"))}>Admin panel</button>
      {/if}
      <hr />
      <button type="button" role="menuitem" onclick={pick(onlogout)}>Sign out</button>
    </div>
  {/if}
</div>

<style>
  .account { position: relative; }
  /* 44px hit area around a 36px avatar, so it stays easy to tap on phones. */
  .trigger { width: 44px; height: 44px; margin: -4px; display: grid; place-items: center; border-radius: 50%; color: var(--text); }
  .trigger :global(.avatar) { transition: box-shadow .15s; }
  .trigger:hover :global(.avatar), .trigger[aria-expanded="true"] :global(.avatar), .trigger:focus-visible :global(.avatar) { box-shadow: 0 0 0 2px var(--bg), 0 0 0 3px var(--muted); }
  .trigger:focus-visible { outline: none; }
  .menu { position: absolute; right: 0; top: calc(100% + 8px); z-index: 10; min-width: 200px; display: grid; padding: 6px; background: var(--raised); border: 1px solid var(--line); border-radius: var(--radius-sm); box-shadow: 0 8px 24px rgb(0 0 0 / .35); }
  .who { display: grid; gap: 2px; padding: 6px 8px 8px; border-bottom: 1px solid var(--line); margin-bottom: 4px; }
  .who strong { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
  .who .mono { font-size: 12px; color: var(--muted); }
  hr { border: 0; border-top: 1px solid var(--line); margin: 4px 0; }
  .menu button { text-align: left; padding: 7px 8px; border-radius: 4px; font-size: 13px; color: var(--text); }
  .menu button:hover, .menu button:focus-visible { background: var(--surface-2); }
  @media (max-width: 720px) {
    .menu { min-width: 220px; }
    .menu button { padding: 11px 10px; font-size: 14px; }
  }
</style>
