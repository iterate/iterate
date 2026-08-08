---
state: todo
priority: high
size: medium
---

# prd: "Subrequest depth limit exceeded" breaks subscriptions and processor revival

## Evidence (prd, 2026-08-07, stream `agents/web/2026-08-07t15-50-03-269z`, project misha)

Two durable `stream/error-occurred` facts during a normal web-agent conversation:

- offset 220 (15:50:31): `subscription "project-worker" skipped failing event at
  offset 209 after 3 event-specific attempts: Subrequest depth limit exceeded.
  This request recursed through Workers too many times.` — a durable
  subscriber permanently skipped an event.
- offset 783 (15:53:39): `processor host revival has failed 3 consecutive
  times on version f836fa59-…; backing off (plateau 360m). A deploy resets the
  budget.` — the agent processor host on that stream is in a 6-hour revival
  backoff. Same likely root cause.

Also observed on the same stream from ~15:56 onward: a ~25s
open → idle-close (+5s) → wake-socket "departed" (+19s) → reopen churn loop for
the browser's session connection (`vbrowser-feed@7|browser-raw-events@7`),
appending 3 connection events per cycle indefinitely while the tab stays open.

## Why it matters

Cloudflare's subrequest depth limit is hit when delivery/wake/RPC hops ride an
already-deep request chain (append → wake → deliver → append → …). Agent turns
are exactly such chains. Consequences seen live: skipped subscriber events
(stale project-worker projections), revival backoff plateaus that only a deploy
resets, and (plausibly) the flapping worker↔DO sockets behind the churn loop.

## Goal

- Reproduce/instrument: log request depth (or a hop counter) at delivery and
  revival dial sites; find which chain exceeds the limit.
- Break the chain: deliveries and revival dials should start from a fresh
  execution context (alarm/queue hop) rather than inheriting the appending
  request's depth.
- Reconsider the 5s-after-open idle close observed in prd (config says 5m
  default `STREAM_IDLE_TEARDOWN_MS`, unset in prd) and the resulting
  3-events-per-25s churn on quiet-but-watched streams.

Related: [stream-subscriber-deliveries-stall-mid-turn](stream-subscriber-deliveries-stall-mid-turn.md),
[streaming-ui-resume-wedge](streaming-ui-resume-wedge.md).
