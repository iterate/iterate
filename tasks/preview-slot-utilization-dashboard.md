---
status: todo
size: medium
branch: none
---

# Preview slot utilization & contention dashboard (from semaphore events)

We have nine preview slots leased through the semaphore
(`environment-config-lease`), and we now reclaim them off the critical path
(3h lease TTL + the hourly GC sweep — see `docs/preview-resource-gc.md`, PR
#2009). What we _don't_ have is any historical view of how the fleet is
actually used. Every question about capacity is answered by eyeballing
`pnpm preview status` at a single instant. We want a post-hoc dashboard.

## Why

- Is nine slots the right number, or are we chronically contended / chronically
  idle? Right now it's a vibe, not a measurement.
- When PRs wait for a slot, how long do they wait, and how often? (Contention.)
- How much of a slot's leased time is actually _used_ (deploy/test renewals)
  vs. idle-holding? (Utilization vs. squatting.)
- Are orphaned/leaked leases and GC reclaims trending down after #2009? (The
  whole point of that work — we should be able to see it.)
- Cost proxy: slot-hours held, and how much the 3h TTL actually saved vs. 24h.

## Data source

The semaphore coordinator (`apps/semaphore`, D1-backed) already logs every
lease transition — acquired / renewed / evicted / expired / force-released —
as an event, keyed by slot slug + holder (`pr-<n>` / `manual-<user>` / `gc`).
That event log is the raw material; no new instrumentation on the preview
tooling side should be needed (confirm the events carry: slug, holder, kind,
timestamp, and leasedUntil).

## Metrics to derive

- **Utilization**: per-slot and fleet-wide % of wall-clock leased, and % of
  leased time with a renewal in the trailing window (used vs. idle-held).
- **Contention**: count + duration of "waiting for a slot" episodes (the
  deploy wait loop already logs these; may need to emit them as events too),
  and how often the fleet hit 0 available.
- **Lease lifecycle**: median/p95 lease duration, renewals per lease, holder
  breakdown (PR vs manual vs gc).
- **Health**: orphaned-at-detection count, GC reclaims/run, force-releases —
  trend over time (proves #2009 works and stays working).

## Delivery options (decide during grooming)

1. **PostHog** (lowest effort): pipe semaphore lease-transition events to
   PostHog and build the dashboard there. Fits "post-hoc dashboard", no new UI
   to maintain, and we already use PostHog. Downside: another event sink to
   wire from the semaphore worker.
2. **In-OS-app page**: a `/preview-fleet` view in os.iterate.com querying the
   semaphore's event log via RPC. More control, more to build/own.
3. **Extend semaphore.iterate.com**: it already shows live leases; add
   historical/aggregate charts next to them. Keeps everything in one place.

Lean: start with (1) PostHog for the numbers, since the events already exist
and the value is the measurement, not a bespoke UI.

## Open questions

- Do the semaphore events already persist long enough for post-hoc analysis,
  or do they need a retention bump / export?
- Are "waiting for a slot" episodes events yet, or only log lines? Contention
  is the most valuable metric and may need to be emitted explicitly.

Raised by Jonas 2026-07-15 as a follow-up to the preview-resource-GC work.
