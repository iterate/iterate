# What kills a long-idle capnweb relay on workers.dev — empirical analysis

**Date:** 2026-08-18, 09:25–09:53 UTC. **Target:** `project-worker.iterate.workers.dev`
(build `kenton-1`). **Method:** 8 concurrent client probes from one machine (macOS, home
network), each socket owned by the harness so exact close code/reason/wasClean is captured;
idle probes auto-relaunched on death with a fresh `ctx` to collect multiple samples.
Harness: `scratchpad/wsprobe/probe.mjs` (session-scratchpad, not in repo).
This re-derives — and largely overturns — the platform finding in BUILD-LOG increment 29.

## Experiment matrix

| Probe  | Mode                                                                     | Traffic during hold                                                      |
| ------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| A1, A2 | raw WS to `/api`, no capnweb                                             | none                                                                     |
| B1, B2 | capnweb session, `connect()` parks a provider (pager to DO)              | none                                                                     |
| C1     | capnweb session                                                          | `await session.get()` every 30s — **on-socket**, edge-local, zero DO RPC |
| C2     | capnweb session                                                          | HTTPS `GET /version` every 30s — **off-socket**, same worker             |
| C3     | raw WS (`ws` pkg)                                                        | WS **protocol-level ping** every 30s (pongs verified returning)          |
| P1     | control: raw idle WS to `wss://ws.postman-echo.com/raw` (non-Cloudflare) | none                                                                     |

## Results — deaths (every one: `code=1006`, empty reason, no close frame)

| Wall time (UTC) | Probe (episode) | Age at death | Note                                    |
| --------------- | --------------- | ------------ | --------------------------------------- |
| 09:29:10.7      | A2 (1)          | 206.8s       | twin A1, opened same second, lived 819s |
| 09:30:08.4      | C3 (1)          | 264.5s       | 8 pings sent, pongs returned            |
| 09:33:10.6      | A2 (2)          | 237.8s       |                                         |
| 09:37:11.2      | C2 (1)          | 686.1s       | **co-death cluster 1** (0.7s apart,     |
| 09:37:11.9      | C3 (2)          | 421.4s       | different ages, different ctx ids)      |
| 09:38:27.3      | A2 (3)          | 314.6s       |                                         |
| 09:39:23.0      | A1 (1)          | 819.1s       |                                         |
| 09:42:03.3      | A1 (2)          | 158.2s       |                                         |
| 09:42:24.2      | C2 (2)          | 310.3s       | HTTP heartbeats did not help, again     |
| 09:45:47.9      | B2 (1)          | 1202.8s      | **co-death cluster 2** (2.4s apart;     |
| 09:45:50.3      | A2 (4)          | 441.0s       | ages 1203s vs 441s)                     |
| 09:48:05.3      | A1 (3)          | 359.9s       |                                         |
| 09:49:45.9      | C3 (3)          | 751.9s       | pings useless a third time              |
| 09:51:37.6      | A2 (5)          | 345.1s       |                                         |

14 deaths; ages 158–1203s (2.6–20.0 min), median ≈ 337s. No fixed constant: **not** the
documented ~100s proxied-WS idle timeout (every probe outlived 100s; most outlived 240s).

**Survivors at teardown (09:53, 28-min hold):** B1 (capnweb, zero traffic — outlived every
other idle socket), C1 (on-socket 30s heartbeats, 53 ok, rtt 13–15ms, never died), P1
(non-Cloudflare control, never died).

**DO-side reads (decisive):**

- B1 at 09:53:43 — client socket still open after 28 min — `/state` = `incarnation:2,
stubs:0`. The DO was evicted + reconstructed **while the relay socket stayed alive**.
- C1 at 09:53:43 — 30s edge heartbeats throughout — `incarnation:2`. Client→edge traffic
  did **not** keep the DO warm.
- C2's 4th episode (11 min old) — `incarnation:2, stubs:1`: a parked stub **can** survive a
  DO eviction; B1/C1's `stubs:0` at 28 min shows the edge→DO pager socket is itself
  independently mortal (it died without its sibling client socket dying).

## Conclusions the data supports

1. **Idle edge-terminated WebSockets are reclaimed at highly variable ages** (158s–1203s
   observed; one idle relay still alive at 1700s), always 1006 with no close frame —
   consistent with probabilistic per-process/isolate recycling, not a per-connection idle
   timer. Identical twin probes opened in the same second died 10+ minutes apart.
2. **WS protocol ping/pong does NOT protect** — 3 independent deaths with 30s pings and
   verified pongs (something below the invocation answers pongs; the reclaimer doesn't count
   them).
3. **Unrelated HTTPS traffic to the same worker does NOT protect the socket** — 2 deaths
   with 30s `GET /version` from the same process — **and does not keep the DO warm either**
   (C1: DO evicted despite 30s edge-local capnweb heartbeats).
4. **Co-death clusters** — two events where sockets of different ages/ctx ids died <2.5s
   apart — support shared-process recycle as the mechanism.
5. **Relay-holding invocations tend to live longer than bare sockets** (relay family: 310,
   686, 1203, >1700s vs bare/pinged family: median ~340s, max 819s) — _directionally_
   suggestive that the outbound pager WS makes the invocation stickier, but n is small and
   one relay died at 310s. Not a guarantee; still mortal.
6. **On-socket application traffic was never defeated in the window** (C1: 28 min, 30s
   edge-local `session.get()`, zero deaths). Community reports say even 1/min app
   keepalives eventually drop after hours (runtime redeploys restart servers a few times a
   week) — every socket is mortal on long enough timescales.
7. **The non-Cloudflare control never died** — local NAT/network exonerated. (Also: a NAT
   would kill at a consistent idle age; the 158–1203s spread and co-death clusters don't
   match NAT behavior.)
8. **Mortality is per-hop and independent.** DO eviction (documented 70–140s idle) proceeds
   regardless of open relay sockets (B1). The client→edge socket and the edge→DO pager die
   on separate schedules — B1's client socket outlived its own pager. Corollary: a live
   client socket is NOT evidence the parked provider is still reachable.

What matches the documented record: Workers docs give HTTP-triggered invocations _no_ wall
clock limit while the client stays connected, but the runtime is updated "a few times per
week" and Cloudflare "may restart servers, which terminates WebSockets connections"; the
official guidance for long-lived WS is client heartbeat + reconnect. Nothing documents the
observed few-minute probabilistic reclaim of idle workers.dev invocations — that part is
measured, not documented. (Sources: developers.cloudflare.com/workers/platform/limits/,
developers.cloudflare.com/network/websockets/,
developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/.)

Honesty notes: all measurements from one client machine/colo over 28 min; "per-process
recycling" is the best-fit _inference_ from variance + co-deaths + close-code, not a
confirmed internal mechanism; conclusion 5 is directional, not established; hours-long
survival under on-socket heartbeats is extrapolated from one 28-min run plus community
reports, not measured here.

## What this means for the platform

**Socket death is fine and expected — by design.** Clients endeavour to reconnect the
moment a socket dies; reconnect-on-death is the designed recovery path (`parkClient`
replaces by `connectionKey`), and a reconnect re-parks providers, which also heals the
independently-mortal pager hop (conclusion 8). Cloudflare reclaiming long-idle edge
invocations is within its rights and is exactly why the platform is cheap — we want it
that way. **No keepalive machinery is needed or wanted.** (For the same reason,
`setWebSocketAutoResponse` on the pager is moot: client pings never reach the DO — the
client's WS terminates at the edge as a plain non-hibernatable pair — and we are not in
the business of keeping sockets alive.)

## Correction to BUILD-LOG increment 29

The increment-29 bullet "on workers.dev, actor eviction and STATELESS-EDGE-ISOLATE
recycling are coupled … ANY client→edge traffic … kept the actor WARM" is wrong on both
counts. Drafted replacement paragraph (to be applied by the maintainer, verbatim):

> **The platform finding, corrected (measured 2026-08-18, `research/ws-lifetime-analysis.md`):**
> actor eviction and edge-socket death are INDEPENDENT, not coupled — a DO evicted and
> reconstructed (incarnation 1→2) while its relay's client socket stayed open for 28 minutes,
> and 30s client→edge heartbeats did NOT keep the actor warm (its DO evicted too; the earlier
> keepalive correlation was a confound). What kills an idle relay is probabilistic
> reclaim of the idle edge invocation: 14 deaths at 158–1203s (median ~5.6 min, no fixed
> constant, always 1006/no close frame), with different-aged sockets co-dying <2.5s apart —
> per-process recycling, not an idle timer. WS pings don't protect (3×); unrelated HTTPS to
> the same worker doesn't protect (2×); only on-socket application traffic did (30s
> `session.get()`, 28 min, 0 deaths). A non-Cloudflare idle control survived the whole window
> (local network exonerated). The pager hop is independently mortal as well — a parked stub
> survived one DO eviction (stubs=1 after incarnation 2) but B1's pager was gone by 28 min
> while its client socket lived. Stance: sockets are ephemeral at every hop; clients
> reconnect on close and re-park by connectionKey; no keepalive machinery.
