<script lang="ts">
  import AdminOverview from "./components/AdminOverview.svelte";
  import AuthPanel from "./components/AuthPanel.svelte";
  import ActivityChart from "./components/ActivityChart.svelte";
  import Conversations from "./components/Conversations.svelte";
  import DangerZone from "./components/DangerZone.svelte";
  import Friends from "./components/Friends.svelte";
  import DevicesPanel from "./components/DevicesPanel.svelte";
  import Leaderboard from "./components/Leaderboard.svelte";
  import OpenCodeCard from "./components/OpenCodeCard.svelte";
  import ActivityToolCard from "./components/ActivityToolCard.svelte";
  import ProfilePanel from "./components/ProfilePanel.svelte";
  import SiteFooter from "./components/SiteFooter.svelte";
  import QuotaCard from "./components/QuotaCard.svelte";
  import SiteHeader from "./components/SiteHeader.svelte";
  import Section from "./components/Section.svelte";
  import TodayByTool from "./components/TodayByTool.svelte";
  import StatsRow from "./components/StatsRow.svelte";
  import UsersPanel from "./components/UsersPanel.svelte";
  import { untrack } from "svelte";
  import { clock } from "./lib/clock.svelte.ts";
  import { Dashboard } from "./lib/dashboard.svelte.ts";
  import { DEMO_PROFILE } from "./lib/demo.ts";
  import { hasLiveWindow } from "./lib/view-model.ts";

  const dash = new Dashboard();
  // Breadcrumb after "AI Activity" in the header: where you are.
  const crumb = $derived(
    dash.route.page === "demo" ? { label: DEMO_PROFILE.display_name, picture: { name: DEMO_PROFILE.display_name, url: null } }
    : dash.route.page === "profile" ? (dash.shown ? { label: `@${dash.shown.username}`, mono: true, picture: { name: dash.shown.display_name, url: dash.shown.avatar_url } } : null)
    : dash.route.page === "leaderboard" ? { label: "Leaderboard" }
    : dash.route.page === "friends" && dash.account ? { label: "Friends" }
    : dash.route.page === "settings" && dash.account ? { label: "Settings" }
    : dash.route.page === "admin" && dash.account ? { label: "Admin panel" }
    : null);
  // start() reads state (the route) while loading: untracked, so navigating
  // does not tear down and restart the polling.
  $effect(() => untrack(() => dash.start()));
  $effect(() => {
    const page = dash.route.page;
    document.title = page === "settings" ? "Settings · AI Activity"
      : page === "admin" ? "Admin panel · AI Activity"
      : page === "leaderboard" ? "Leaderboard · AI Activity"
      : page === "friends" ? "Friends · AI Activity"
      : (page === "profile" || page === "demo") && dash.shown ? `${dash.shown.display_name} · AI Activity${dash.vm?.demo ? " · Demo" : ""}`
        : "AI Activity";
  });
</script>

<!-- Site chrome (header and footer) lives here,
     outside the page branches, so every page gets exactly the same. -->
<div class="shell">
  <SiteHeader account={dash.account} demo={!!dash.vm?.demo}
    {crumb}
    signIn={dash.status !== "loading" && dash.status !== "signed-out" && dash.status !== "setup"}
    onnavigate={(p) => dash.go(p)} onlogout={() => dash.logout()} />

  <main>
    {#if dash.status === "signed-out" || dash.status === "setup"}
      <AuthPanel setup={dash.status === "setup"} signupOpen={dash.signupOpen} github={dash.github}
        error={dash.authError} onsignin={(code) => dash.signIn(code)} />
    {/if}
    {#if dash.status === "signed-out" || dash.status === "setup"}
      <p class="demo-link">
        No account? <a href="/demo" onclick={(e) => { e.preventDefault(); dash.go("/demo"); }}>See a demo</a> with fictional data.
      </p>
    {/if}

    {#if dash.status === "missing"}
      <p class="gate">
        No profile named <span class="mono">@{dash.route.page === "profile" ? dash.route.username : ""}</span>.
        {#if dash.account}<button type="button" onclick={() => dash.go("/")}>Go to your profile</button>{/if}
      </p>
    {/if}

    {#if dash.status === "error"}
      <p class="notice" role="alert">Could not reach the server. Retrying every 15 seconds.</p>
    {/if}

    {#if dash.route.page === "settings" && dash.account && dash.status === "ready"}
      {#if dash.authError}<p class="notice" role="alert">{dash.authError}</p>{/if}
      <Section title="Account" subtitle="Your profile, from GitHub">
        {#key dash.account.id}
          <ProfilePanel account={dash.account} />
        {/key}
      </Section>

      <Section title="Devices" subtitle="One ingestion key per machine">
        <DevicesPanel />
      </Section>

      <Section title="Danger zone" subtitle="Cannot be undone">
        {#key dash.account.id}
          <DangerZone ondeletedactivity={() => dash.load()} onsignout={() => dash.logout()} onreauth={() => dash.signInAgain()} />
        {/key}
      </Section>

    {/if}

    {#if dash.route.page === "admin" && dash.account && dash.status === "ready"}
      {#if dash.account.is_admin}
        <Section title="Overview" subtitle="The whole server, every account">
          <AdminOverview />
        </Section>
        <Section title="Users" subtitle="Profile pages are public; devices and settings stay private">
          <UsersPanel selfId={dash.account.id} />
        </Section>
      {:else}
        <p class="gate">This page is for admins.</p>
      {/if}
    {/if}

    {#if dash.route.page === "leaderboard" && dash.status === "ready"}
      <Leaderboard self={dash.account?.username ?? null} onopen={(u) => dash.openProfile(u)} />
    {/if}

    {#if dash.route.page === "friends" && dash.account && dash.status === "ready"}
      <Friends onopen={(u) => dash.openProfile(u)} />
    {/if}

    {#if dash.vm && dash.shown}
      {@const vm = dash.vm}
      {@const quotaCards = { "claude-code": vm.claude, codex: vm.codex, antigravity: vm.antigravity }}
      <ActivityChart series={vm.series} today={vm.today} demo={vm.demo} hasActivity={vm.hasActivity} />
      <StatsRow stats={vm.stats} />

      <Section title="Tools" subtitle="Limits are per account, latest snapshot">
        <div class="tools">
          <!-- In TOOLS order (shared/types.ts). -->
          {#each vm.tools as tool (tool)}
            {#if tool === "opencode"}
              <div class="wide">
                <OpenCodeCard vm={vm.opencode} />
                <TodayByTool today={vm.stats.today} />
              </div>
            {:else if tool === "antigravity" && !hasLiveWindow(vm.antigravity, clock.now)}
              <!-- No quota window running (quotas are optional): what is going on now. -->
              <div class="full"><ActivityToolCard tool="antigravity" vm={vm.antigravityActivity} /></div>
            {:else}
              {@const q = quotaCards[tool]}
              <div class="quota" class:full={q.pools.length > 1}><QuotaCard vm={q} /></div>
            {/if}
          {/each}
        </div>
        {#if dash.own}
          <!-- Owner only: how the other tools get here (README.md, "One-command install"). -->
          <p class="howto">
            Add a tool: run a device's install command from
            <button type="button" onclick={() => dash.go("/settings")}>Settings → Devices</button>
            on that machine (Linux, macOS or Windows). It sets up every tool it finds.
          </p>
        {/if}
      </Section>

      <Section title="Conversations" subtitle="Most recent first">
        <Conversations sessions={vm.sessions} total={vm.sessionsTotal} onmore={() => dash.showMoreSessions()} />
      </Section>
    {/if}
  </main>

  <SiteFooter />
</div>

<style>
  .shell { max-width: 1080px; margin: 0 auto; padding: 44px 42px 56px; }
  .gate { border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 20px; color: var(--muted); font-size: 13px; line-height: 1.6; }
  .gate button { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 4px 10px; font-size: 12px; color: var(--text); }
  .howto { margin-top: 16px; border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 16px; color: var(--muted); font-size: 13px; line-height: 1.6; }
  .howto button { padding: 0; color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
  .howto button:hover { color: var(--accent); }
  .demo-link { max-width: 420px; margin: 12px auto 0; text-align: center; color: var(--muted); font-size: 13px; }
  .demo-link a { color: var(--text); text-underline-offset: 2px; }
  .demo-link a:hover { color: var(--accent); }
  .notice { color: var(--warn); margin: 12px 0; text-align: center; }
  .quota { display: grid; } /* the card fills its grid cell */
  /* A quota card with several pools (Antigravity) takes a whole row. */
  .full { grid-column: 1 / -1; }
  /* OpenCode (2/3) and today's split by tool (1/3) share a row. */
  .wide { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 16px; }
  @media (max-width: 720px) { .wide { grid-template-columns: 1fr; } }
  .tools { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 400px), 1fr)); gap: 16px; }
  @media (max-width: 720px) {
    .shell { padding: 24px 16px 40px; }
  }
</style>
