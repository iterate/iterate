---
state: done
priority: high
size: medium
tags: [os, itx, performance, projects]
---

# Cold-slot project creates can exceed 60s — find and fix the slow step

`projects.create` resolves only when the project is usable (auth register →
repo seed → project worker probe → onboarding agent birth). Warm, this takes
~5–7s (see any e2e run). On a freshly deployed stage, first-touch creates
have been observed to exceed 120s under concurrent suite load (preview CI
runs on 2026-07-02: rotating "Timed out waiting for stream event … saw 0
events" failures across admin-project / stream-security / agent-tools, each
a create stuck in the saga).

## Findings (2026-07-02, measured on preview-7)

Ruled out first: worker bundle bloat. Deployed engine workers are 1.3–5.5MB
each (api 4.0MB, app 5.0MB, repo 5.5MB) — nowhere near the historical 89MB
sourcemap incident.

Per-step instrumentation (`[create-timing]` lines, kept in tree) plus
event-log timelines across 25 concurrent creates on a fresh stage showed the
saga itself is healthy and load-stable:

- auth register 0.25–0.4s, directory prime ~0.1s, root append 0.5–1.1s
- project-processor lane (3 sequential appends) 1.1–2.6s ← slowest lane
- CF Artifacts repo create+seed 1.6–2.4s
- worker probe + created append 0.2–0.6s
- total saga 3.0–4.7s; client-observed create ≈ 4.9–5.4s

The actual fresh-slot killer is **zombie worker routes**: a route created
during deploy that is visible in the API but never fires at the edge, so
every request to that hostname falls through to the originless placeholder
DNS record and dies with a 522 after ~20s. Reproduced live on preview-7
(`mcp.iterate-preview-7.com` 522'd for 40+ minutes while
`os.iterate-preview-7.com`, same script/zone/record shape, worked); deleting
and recreating the identical route healed it instantly. This also explains
the OAuth-callback "parked browser" symptom — the os-side callback fetches
the auth worker's discovery + token endpoints over exactly these routes.

## Fixes

- `IterateRoutes` (packages/shared/src/alchemy/iterate-app.ts) now creates
  the proxied placeholder DNS records BEFORE the routes (Cloudflare requires
  the record for the route to fire) and then probes every exact route
  hostname, deleting + recreating any route the edge answers with an
  origin-fallthrough status (521/522/523/530).
- The project processor's create lane batches its two root-stream appends
  into one atomic append and runs the independent Slack-router append in
  parallel (lane: 1.1–2.6s → one round-trip apiece).
- Per-step `[create-timing]` / `[callback-timing]` instrumentation stays in
  the tree so any recurrence shows its slow step in `wrangler tail` /
  Workers Observability.
