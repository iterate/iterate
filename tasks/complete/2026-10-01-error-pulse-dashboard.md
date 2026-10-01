---
status: done
size: large
---

# #error-pulse: fewer pings, one daily dashboard

Status: done. #3502 (fewer pings) merged; #3504 (the daily dashboard) merges with this file moved;
the stale pages are cleaned up. The iterate.com site fix is live
(config repo commit 528dc1b).

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
      `todaysPage`; replaying 09-30 21:00–23:45 gives 1 page and 7 thread replies instead of 10
      pages and 8 broadcast replies_
- [ ] ~~fault alarm: every first-level `*.iterate.com` name except the apex, www and the first-party
      hosts is one incident, "iterate.com subdomains", listing hosts~~ _dropped (Misha, 2026-10-01):
      made-up names answer 404 now (config 528dc1b), so they no longer 5xx_
- [ ] ~~fault alarm: 5xx and request-line errors on scanner paths are dropped~~ _dropped: incidents
      are keyed by host, not path, so scanner paths never opened pages; they only inflated counts_
- [x] fault alarm, health, do-cost, notify: escalation replies are not sent to the channel
      _`PageUpdate` has no `broadcast`; notify's was already thread-only_
- [x] every poster: resolving edits the page and mentions nobody (slack.ts `resolvePage`, health.ts
      `sendUpdates`, do-cost, notify) _`resolvedPageText`, no reply; a deleted page gets nothing; a
      health page Slack can no longer edit leaves the state with nothing sent_
- [x] health: main e2e and slow e2e rows red at the same commit share one page _e2e.ts
      `heldOnMainPage`: slow rows' red updates wait while main e2e is red_
- [x] health: PR time to green pages only past its line by more than 10% _ttg.ts `LINES.margin`,
      `judge(summary, paged)`; resolves under the plain line_
- [x] docs/depot-ci.md "Slack channels" and "Health" say what changed
- [x] once merged (needs Misha's yes): edit the 34 stale 🚨 pages to ✅ resolved, no replies _done
      2026-10-01 with Misha's yes, before merging: 157 top-level 🚨/🔴 pages of the last 30 days
      (GitHub Actions-era e2e posts and old main e2e pages included) edited resolved; the 4 live
      ones kept (preview sweep, prd: 33 errors, real-model e2e, today's PR time to green)_

## PR 2: the daily dashboard (stacked on PR 1)

One top-level message per UTC day in #error-pulse, edited in place:

```
📟 error-pulse · Thu 1 Oct · 15:02 UTC
🔴 main e2e: red at 916a48f (#3495) since 14:53 · 1 row
🟢 prd hosts: all answer on 7b49a601
🟡 prd faults: ReadableStream disconnected 33 (last 14:50)
🟢 prd deploys: 9/9 live
🔴 real-model e2e: red since 99f660d
🟢 latency
🟡 PR time to green: p50 169 s (line 165 s)
🟢 DO cost: $4.94/day
⚪ preview sweep: 16 namespaces stuck (Cloudflare)
🟢 context sweep · Kit firmware · OS crash hunt
```

Design (from mapping every poster, 2026-10-01):

- **Where state lives.** The dashboard's rows are in its Slack message metadata
  (`event_type: error_pulse_dashboard`, payload `{ day, rows: { <signal>: { state, text, at } } }`),
  read back with `include_all_metadata`. Its text is rendered from the rows, so nothing parses it.
- **Finding today's.** History from 00:00 UTC, this bot's top-level message whose metadata says
  today (as do-cost's #ci headline does). The first poster after midnight posts it, copying
  yesterday's rows. Each poster rewrites only its own row and re-reads after the edit: another
  poster's edit in the same second can drop a row, so it writes again (at most three times).
- **Pages are replies in today's dashboard thread.** `slack.ts` `postPage` replaces every top-level
  page post. Edits stay edits. A page that pings mentions Jonas and Misha, and once mentioned they
  follow the thread, so any reply in it notifies them: signals that should not ping post no reply,
  only their row.
- **Finding open pages** (`findOpenPages`, for keepPage, notify, do-cost) reads the replies of each
  dashboard in its window, plus top-level messages for pages posted before the dashboard.
- **Escalations** reply in today's dashboard thread with mentions, naming the incident (a reply
  cannot have its own thread).
- **A page Slack can no longer edit** is closed by a reply in today's thread whose metadata names
  the page's ts (`error_pulse_page_closed`), which `findOpenPages` reads; it used to be a broadcast
  reply in the page's own thread.
- **Pings.** Ping (reply with mentions): main e2e red, a new prd fault burst (10+ in a window) or
  any 5xx on iterate.com, www or a first-party host, context sweep failed, Kit firmware or crash
  hunt red, DO cost over its page tier. Sent to the channel too ("prd is down"): post-deploy check
  failing, a prd deploy failing, a 5xx burst on iterate.com/www or a first-party host, DO cost at
  $50/h (a dollar figure: prd's page tier is $0.06/h, so its 5× would be $0.28/h). Row only: PR
  time to green, latency, real-model e2e, slow e2e rows, minor prd faults (fewer than 10 in a
  window, projects' own hosts). The preview sweep keeps its page (escalating stuck namespaces to
  Cloudflare is someone's job), not sent to the channel.
- **The fault alarm's minor incidents** live on an unposted page (no ts) that only its row shows;
  a ping-worthy incident posts it.
- **No pin.** The bot has no `pins:write` scope (checked 2026-10-01); the dashboard is the newest
  top-level message most of the day anyway. Adding the scope and pinning is a follow-up.
- **Edit window.** Bot edits worked on 31-hour-old pages, so a day's message stays editable.

- [x] scripts/ci/dashboard.ts: find or post today's dashboard, set a row, render _rows are a flat
      list: Slack metadata nests one level; a newer write of the same row stands (two deploys)_
- [x] fake-slack: metadata, `include_all_metadata` _and deleting a reply; `latest` not needed_
- [x] slack.ts: `postPage`, `findOpenPages` over dashboard threads and legacy pages, escalations
      and frozen pages into today's thread
- [x] fault alarm: row; unposted page for minor incidents; channel for a 5xx burst on the site's
      apex/www or a first-party host _`FIRST_PARTY_HOSTS`, `loud` (once a page), held pages with `ts: ""`_
- [x] health: a row per signal; latency, PR time to green, real-model e2e and slow e2e rows row only
      _`ROW_ONLY_SIGNALS` in sendUpdates; PR 1's `heldOnMainPage` went with it_
- [x] do-cost: row; page into the thread; $50/h sent to the channel
- [x] notify: deploy and workflow rows; deploy failure sent to the channel
- [x] post-deploy check: row; failure sent to the channel _amber row in the restore window after
      an erase_
- [x] preview sweep, context sweep: rows; preview sweep keeps its page _preview's page logic moved
      to preview-sweep.ts `keepSweepPages`, since preview.ts runs its CLI on import_
- [ ] ~~`dashboard.ts close-legacy-pages`~~ _dropped (Misha, 2026-10-01): it ran once, by hand, and its job is done_
- [x] docs/depot-ci.md "Slack channels" rewritten around the dashboard
- [ ] ~~fold quiet green rows into one line~~ _Misha, 2026-10-01: a line per row is fine for now_
- [ ] ~~pin the dashboard~~ _Misha, 2026-10-01: no need for a real pin_

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
  edits after, seven thread replies (new bursts on made-up subdomains, iterate.com grew tenfold),
  nothing else sent to the channel. With subdomain grouping it was one reply, but Misha dropped
  grouping since those names 404 now.
- The site's 500s were `recipe: 404`: the iterate project's worker.ts read the recipe from GitHub
  raw at a path #3487 moved, and threw when it had no copy. Someone had already fixed RECIPE_URL by
  10-01.
