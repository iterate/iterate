---
state: todo
priority: high
size: medium
dependsOn: []
---

# Remote apps: cut the network paths down to speed of light

Measured on prd 2026-07-20 (London, project `asdasdasdasdasd`): the proxied
tasks app takes **4.8s cold / 2.0s warm** from navigation to a usable board.
Per-phase Server-Timing instrumentation in the project's config worker proved
the app-level code is NOT the problem — the config worker's whole handler
(itx-open 0ms, auth gate 0ms local HS256, kv 5ms, egress-gate rules catch-up
10–30ms, vessel upstream ~50ms) totals **~110ms warm** while the client
simultaneously observes 1.3–2.1s. The time lives in platform pre-handler
machinery and in how many times the chain is traversed.

Reference numbers (all measured, not estimated):

| Path | Measured |
| --- | --- |
| WS upgrade via `tasks--<slug>.iterate.app` | 1.2–2.1s in 7/9 attempts, ~320ms otherwise |
| WS upgrade direct to `tasks.iterate.workers.dev` | 150–210ms, every attempt |
| os `/api` upgrade (vessel's per-connection dial) | 982ms / 997ms / 101ms |
| Fresh-TCP GET, any os-served host | 200–390ms, ~1/7 spikes to 1.1–1.2s |
| Same-connection GET (reused, warm isolate) | 100–165ms |
| Asset direct from vessel (Workers Assets) | ~75ms TTFB |
| Asset through proxy | 150–450ms, one 1.5s cold spike observed |
| `listTaskFiles` on warm repo DO | 40–50ms (cold ~1s) |

Root cause of the big stalls: the os worker bundle is huge (`dist/server`
60MB; 2MB entry + chunks + wasm) so a **cold isolate costs ~1–2s**, and every
fresh TCP connection risks landing on a metal without a warm isolate.
WebSocket upgrades are always fresh connections, so they eat it most of the
time — once at the browser→proxy hop and potentially again when the vessel
dials os `/api`. The controlled comparison: the 1.2MB vessel, same colo, same
connection roulette, upgrades in 150–210ms flat.

## High-confidence fixes (measured wins, agreed direction)

### 1. Browser connects its WebSocket directly to the vessel

Skip the platform for the socket entirely: the page opens
`wss://tasks.iterate.workers.dev/api/board?project=<id>` and presents the
project-app-session token **in-band** as the first pipelined RPC
(`open({ token })`), exactly the shape os `/api` already uses. The
`?project=` param is routing-only (picks the DO); trust is unchanged — the
vessel presents the token at os `/api` and os enforces the claims, same as
the proxy-forwarded cookie today. Vessel checks `Origin` against
`https://tasks--*.iterate.app` as a courtesy filter.

Win: 1.2–2.1s → ~200ms on the tallest pole, and every subsequent frame skips
the os worker + config-worker isolate + project DO forever.

Prereq — the page needs the token: drop `HttpOnly` from the
`iterate-project-auth` cookie (one line, `sessionCookie()` in
apps/os/src/auth/project-auth.ts; keep `Secure` + `SameSite=Strict`) so the
page reads `document.cookie` directly. Decided over an echo endpoint: a
same-origin `/__session-token` endpoint nullifies HttpOnly anyway (any
origin JS can fetch it), so hiding the cookie while echoing it is theater.
The token is a capability minted FOR the app; the app's JS is the intended
bearer. If exfil-resistance ever matters, the right tool is a narrower
audience-bound short-TTL WS ticket, not HttpOnly — file separately if wanted.

Reconnect flow: on socket drop or rejected `open()`, re-read the cookie and
redial; if the platform session lapsed, the next page navigation bounces
through login as today.

### 2. Immutable caching for hashed assets

The vessel's content-hashed `/assets/*` ship
`cache-control: public, max-age=0, must-revalidate` — every reload
revalidates each asset through the full proxy chain. Set
`public, max-age=31536000, immutable` (they're content-addressed; correct by
construction). Repeat visits then serve from browser cache: the proxy chain
drops out of the reload path entirely. First visits can additionally skip
the proxy by referencing assets from the vessel origin (vite `base`), but
immutable alone removes the recurring cost.

### 3. Share one warm os dial per board DO for reads

Today every browser connection constructs a BoardSession that dials os
`/api` fresh (fresh TCP → cold-isolate roulette, ~1s twice out of three
measured). Keep ONE authenticated dial per board DO for reads
(`listTaskFiles` + the 30s poll), opened once and reused across
connections/reconnects; open per-user sessions lazily only when a user
commits (attribution must stick to the committing user). First-paint data
then rides an already-warm socket: ~50ms instead of up to ~1.5s.

Implementation order: 2 (trivial) → 1 (vessel + the one-line cookie change)
→ 3 (board DO rework), proving each on prd. Estimated end state with all
three: **~400–600ms warm, ~1s cold** to board data (from 2.0s / 4.8s today).

## Smaller opportunities (not yet sized)

- **Board HTML shell**: warm TTFB through the proxy is ~240–530ms of SSR +
  chain traversal for what is effectively a static shell (the board arrives
  over the WS). Client-only render or a cacheable shell would shave the
  first paint; modest next to items 1–3.
- **Repo DO cold read** (~1s on first `listTaskFiles`): mostly amortized by
  item 3's shared session + the board's existing 30s poll keeping it warm
  while anyone is connected. Revisit only if cold first-paint still hurts
  after 1–3.

## Platform-level (bigger lift, biggest systemic win)

### 4. Thin ingress worker in front of the fat os worker

The ~1–2s cold-isolate tax is platform-wide: it hits agent /api dials,
dashboards, every fresh connection anywhere. A small router worker (host
parsing, project-host gate, proxy dispatch — a few hundred KB) would make
cold landings ~100ms and shield the fat worker behind warm paths. This is
the structural fix; the three items above make the tasks app fast without
waiting for it.

## Verified NOT worth optimizing (measured innocent)

- Auth gate cookie verify: 0ms (local HS256 — the #2156 design paid off).
- `env.ITX.get()` session open: 0ms. `itx.kv.get`: ~5ms.
- Egress approval gate + 5s-stale rules catch-up: 10–30ms.
- Egress project-DO hop for the vessel fetch: within the ~50ms upstream.
- Capnweb pipelining: authenticate→projects.get→repos.get→listTaskFiles is
  already one network flight (~60ms warm after ws-open).

## Instrumentation / probes (keep until this lands)

- Jonas's prd config worker (commit `9f2a8fb`) stamps per-phase
  `server-timing` on every tasks response; `x-latency-probe: 1` adds a
  double egress probe that splits rules catch-up from the egress floor.
  Pristine pre-instrumentation worker.ts saved locally (latency-debug
  session, /tmp/jonas-worker-ts.json).
- Probe scripts (sign-token, browser-probe, ws-probe, os-dial-probe,
  multi-dial, ws-timing) live on a local scratch branch; each is a small
  tsx script whose behavior the reference table above captures, and they
  are trivially rebuildable from this file (sign an HS256
  project-app-session token with the shared secret, then time each hop
  with `ws`/`capnweb`/playwright from apps/os's node_modules).
