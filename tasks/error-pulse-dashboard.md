---
status: in-progress
size: large
---

# #error-pulse: fewer pings, one daily dashboard

Status: PR 1 (stop the worst noise) in progress: fault alarm, silent resolutions and the iterate.com
site are done; the health signals are being finished. PR 2 (the daily dashboard) not started. The
iterate.com site fix is live (config repo commit 528dc1b).

## Why

Audit of #error-pulse, 2026-09-01 to 2026-10-01: 279 top-level posts, 874 thread replies. Every post
and reply mentions Jonas and Misha. Misha was pinged 65 times on 09-28, 32 on 09-29, 50 on 09-30.
Since 09-28 midday: prd fault alarm 69 of 119 pings (58%), main e2e 22, post-deploy check 12, PR time
to green 8.

- **One bug, 18 pings.** 09-30 21:00–23:30 UTC: after #3487 moved apps/os to core/os, the iterate
  project's site (iterate.com and every first-level `*.iterate.com` name, envs.ts `projectWildcard`)
  logged `recipe: 404` and answered 500 (6,385 that day, none on 10-01). A scanner was walking made-up
  subdomains (build., api2., inference.:8443) and paths (`/.env`, `/actuator`, `*.php`). The fault
  alarm keys a visitor 5xx by host and opens a new page for any incident with no open page
  (prd-fault-alarm.ts `triageIncidents`), so each 15-minute run posted a new page: 10 pages and 8
  broadcast "grew tenfold" replies.
- **Good news pings.** Every resolution is a thread reply with both mentions. The 16 pages from
  09-29/30 resolve around 21:00–23:20 UTC on 10-01: 16 pings for something fixed the day before.
- **Unreadable at a glance.** 38 messages still say 🚨; 4 are live. 18 are pre-09-28 fault pages
  nothing will ever resolve.
- **Flapping.** PR time to green sits on its line (p50 169 s vs 165 s): paged and resolved twice on
  10-01. main e2e and slow e2e rows red on the same commit are two pages (twice on 09-30).

Where the posts come from: prd-fault-alarm.ts (every 15 min), prd-post-deploy-check.ts (each os-prd
deploy), monitors/health.ts (main e2e, slow e2e rows, real-model e2e, latency, PR time to green, DO
cost), notify.ts (failed prd deploys, Kit firmware, crash hunt), os/preview.ts sweep (stuck
Artifacts namespaces), context-sweep.ts (failed sweep).

## Decisions (Misha, 2026-10-01)

- "Set me up with \<name\>.iterate.com" is only for the apex and www. Any other first-level
  `*.iterate.com` name that is not a first-party app answers 404.
- Buckets as proposed in the audit: filter scanner paths; one-time fixes below; resolutions and slow
  metrics become dashboard rows; incidents ping as replies in the dashboard's thread; only "prd is
  down" reaches the channel.

Assumptions (mine, not Misha's; flag if wrong):

- "Resolved" never pings. It edits the page (its first line says ✅ resolved, plus a line saying
  why). No thread reply, except where Slack can no longer edit the page.
- A new fault-alarm incident on a day that already has an open fault page joins that page. A burst
  (10+ in its first window) also gets a thread reply that mentions both; a lone sighting is an edit.
- Escalations ("grew tenfold", "back after quiet", "now fails in …") stay thread replies with
  mentions but are no longer sent to the channel.
- Scanner paths drop out of the fault alarm entirely, on every host.
- The PR time to green margin: page when p50 or p90 is more than 10% over its line; resolve once both
  are back under the line.

## PR 1: stop the worst noise (base main)

- [x] fault alarm: a new incident joins the open page posted the same UTC day instead of opening a
      new page; a new burst replies in that page's thread with mentions _prd-fault-alarm.ts
      `todaysPage`; replaying 09-30 21:00–23:45 gives 1 page and 1 reply instead of 10 and 8_
- [x] fault alarm: every first-level `*.iterate.com` name except the apex, www and the first-party
      hosts (envs.ts `excludedHostnames`) is one incident, "iterate.com subdomains", listing hosts
      _`isSiteSubdomain`; docs.iterate.com is a real name the site serves and lands in the group
      too, named in its hosts_
- [x] fault alarm: 5xx and request-line errors on scanner paths are dropped _`isScannerPath`_
- [ ] fault alarm, health, do-cost, notify: escalation replies are not sent to the channel
- [ ] every poster: resolving edits the page and mentions nobody (slack.ts `resolvePage`, health.ts
      `sendUpdates`, do-cost, notify) _slack.ts done: `resolvedPageText`, no reply; a deleted page
      gets nothing_
- [ ] health: main e2e and slow e2e rows red at the same commit share one page
- [ ] health: PR time to green pages only past its line by more than 10%
- [ ] docs/depot-ci.md "Slack channels" and "Health" say what changed
- [ ] once merged (needs Misha's yes): edit the 34 stale 🚨 pages to ✅ resolved, no replies

## PR 2: the daily dashboard (stacked on PR 1)

One top-level message per UTC day in #error-pulse, edited in place:

```
📟 Thu 1 Oct · updated 15:02 UTC
🔴 main e2e: red at 916a48f (#3495) since 14:53 · 1 row
🟢 prd hosts: all answer on 7b49a601
🟡 prd faults: ReadableStream disconnected 33 (last 14:50)
🟢 prd deploys: 9/9 live
🔴 real-model e2e: red since 99f660d
🟢 latency
🟡 PR time to green: p50 169 s (line 165 s)
🟢 DO cost: $4.94/day
⚪ preview sweep: 16 namespaces stuck (Cloudflare)
🟢 sweeps · firmware · crash hunt
```

- [ ] scripts/ci/dashboard.ts: today's message (posted by the first poster after 00:00 UTC, carrying
      over yesterday's rows), one row per signal in a fixed order, row state in the message's Slack
      metadata, each poster rewriting only its own row (re-read after the edit, retry when another
      poster's edit raced it)
- [ ] a row is one line: at most two named incidents, then "+N"; detail lives in the incident's reply
- [ ] every page becomes a reply in today's dashboard thread, with mentions; edits stay edits;
      resolving edits the reply and the row
- [ ] "prd is down" replies are sent to the channel too: post-deploy check failing, a prd deploy
      failing, a 5xx burst on iterate.com/www or a first-party host, DO cost at 5× its page tier
- [ ] slow signals ping nobody, row only: PR time to green, latency, real-model e2e, preview sweep's
      stuck namespaces, minor prd faults (fewer than 10 in a window, projects' own hosts)
- [ ] pin today's message and unpin yesterday's (`pins:write`; log and carry on without it)
- [ ] check the workspace's message edit window is at least 24 h (the code already meets
      `edit_window_closed`); if not, the dashboard reposts when it freezes
- [ ] the old top-level pages: resolved without replies by the first run

## iterate.com site (the iterate project's config repo)

- [x] the self-host page ("Set me up with …") only on iterate.com and www.iterate.com; every other
      first-level name the site serves answers 404 _config commit 528dc1b, `SITE_HOSTS` in
      worker.ts; iterate.iterate.app/ answers 404 too_
- [x] the recipe ships with the site instead of being fetched per request, so a file move in this
      repo cannot 500 every subdomain again _kept the live read from GitHub, with setup-prompt.ts
      (a copy at 7d494c137) served when it fails and the isolate has no copy_
- [x] confirm the commit published; curl apex, www and a made-up name _typechecked locally first;
      georgejeff., build./.env, inference. 404; apex, www, /setup-prompt.md 200; docs. 401_

## Implementation log

- 2026-10-01: replayed prd's logs for 09-30 20:50–23:50 through the new alarm (alarm() with the
  Slack fake, state carried between 15-minute windows): one page at 21:05 with both mentions,
  edits after, one thread reply at 22:05 (iterate.com grew tenfold), nothing sent to the channel.
  The page lists "visitor 5xx: iterate.com subdomains 2436 on enterprise., inference., open., my.,
  build. +73" beside "iterate.com 144" and "www.iterate.com 23", so the apex outage is readable.
- The site's 500s were `recipe: 404`: the iterate project's worker.ts read the recipe from GitHub
  raw at a path #3487 moved, and threw when it had no copy. Someone had already fixed RECIPE_URL by
  10-01.
