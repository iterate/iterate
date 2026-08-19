# Spike memo — subscriptions-into-the-facet (menu #1) vs parked-callback short-circuit (menu #2)

2026-08-19, measured on the live clean-room deployment (`project-worker.iterate.workers.dev`).
The two menu items trade against each other; these are the numbers and the shapes that make the
decision mechanical.

## Measured

| Number                                                           | live-9 (before) | live-10 (with short-circuit) |
| ---------------------------------------------------------------- | --------------- | ---------------------------- |
| In-isolate dispatch hop (`itx.whoami` via env.ITX, table-routed) | 8.3 ms          | 7.5–7.8 ms                   |
| In-isolate `stream.read(0,100)` (same lane)                      | 9.8 ms          | 9.7–9.8 ms                   |
| → marginal parent read beyond a dispatch                         | **~1.6–2.4 ms** | (same)                       |
| Push delivery, client-observed append→callback (median of 25)    | 53 ms           | **30–31 ms**                 |
| Live-state set→frame (median of 25)                              | 83 ms           | **44–65 ms**                 |

## Verdict on menu #2 (parked-callback short-circuit) — DONE, kept (increment 53)

Rows carry their mount `target` into the parent projection; the canonical parked-callback shape
(exactly `itx.clients.get('<key>')`) delivers via the parent's own `stubInvoke` — zero facet
hops, zero table routing. Every other target keeps the facet lane (substitute + apply).
**−43% push delivery latency, −~35% live-state latency**, ten-suite proof board green. The
semantic edge the menu flagged (a mount shadowing `itx.clients` can no longer intercept
deliveries for this shape) is an ALIGNMENT, not a break: delivery was always documented as "by
row identity, never the table". Revert = one commit if the interception behavior is wanted.

## Verdict on menu #1 (subscriptions into the ictx facet) — VIABLE, RECOMMEND DEFER until workerd#6810

- **workerd#6810 is still open** (checked 2026-08-19): facets cannot set alarms — `setAlarm`
  inside a facet asynchronously breaks the actor. The move therefore NEEDS the parent proxy:
  the parent keeps ONE `armAlarm(t)` verb and its `alarm()` adds `void ictx.pumpDue()`.
- **The cursor-read cost concern is settled: it's noise.** The pump's page reads become
  facet→parent RPCs at ~1.6–2.4 ms marginal each (measured through the strictly-slower
  loaded-isolate lane; native facet→parent is cheaper) against a 30–50 ms delivery path.
- **The real cost is un-doing half of menu #2**: with the pump inside the facet, parked-callback
  delivery becomes facet→parent `stubInvoke` — one in-process hop (~1–3 ms) where today, after
  increment 53, it is zero. Combined shape A+B is still strictly better than pre-spike HEAD.
- What the move buys: ~−160 lines and three nouns (PushRow projection, push cursors, the
  parent-side ladder all become facet fold + facet kv); the parent lands at ~590 lines and
  finally equals its header — LOG + SOCKETS + DOORS.
- Freeze-and-fork falls out of the mounts fold the facet already owns; the pump must run on its
  OWN promise chain in the facet (never the serial fold chain — deliveries must not HOL-block
  routing).

**Recommendation:** keep increment 53's zero-hop delivery now; do the move when #6810 lands
(the alarm proxy — the one ugly bit — then deletes itself), or earlier if the noun-collapse is
worth ~2 ms per delivery and the proxy verb.
