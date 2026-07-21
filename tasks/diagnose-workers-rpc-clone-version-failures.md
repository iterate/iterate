---
state: in-progress
priority: high
size: medium
dependsOn: []
---

# Diagnose Workers RPC clone-version transport failures

The exact-head preview run for PR #2144 returned one 500 while the seeded
project router was resolving its repo-backed counter worker:

`Unable to deserialize cloned data due to invalid or unsupported version.`

The failing request was `a1e4b0b53fdac95c` on `os-preview-3`, trace
`730826de66ef40b26ea5777a86c3ed1f`, at 2026-07-20 20:24 UTC. The trace reached
`RepoDurableObject.getHead` and never entered `StatefulWorkerDurableObject`, so
this was a Workers RPC clone/transport failure before stateful dispatch rather
than a worker-bundler build or asset failure. Vitest's configured CI retry
passed. Five subsequent no-retry runs also passed, including four concurrent
runs, with no error-level events in their exact telemetry window.

This error predates the worker-bundler change and has appeared on other Repo DO
RPC paths. Do not hide it behind a broad retry or couple recovery to the
worker-bundler API.

Done when there is a minimized production-shaped reproduction (or enough
instrumentation to capture the next occurrence), the failing serialization
boundary and payload are identified, and the outcome is either fixed or
modeled with a narrowly bounded, observable recovery justified by the root
cause. The normal error signal must remain clean.


## Diagnosis 2026-07-21 (production burst)

63 occurrences on os-prd, all on 2026-07-21 (zero in the prior 30 days of
PostHog), all from ONE client, during a Cloudflare runtime/API instability
window (12:15–14:05 UTC) with prd deploying every 10–20 minutes.

**Throw site, proven from symbolicated frame line:columns**: the Worker
Loader entrypoint stub fetch — `await entrypoint.fetch(request)` in
`DynamicWorkerRunner.fetch` (stateless lane). NOT source resolution: the
failing ray's trace shows `RepoDurableObject.getHead` completing `ok` on the
same trace before the loader hop threw caller-side ~90ms in.

**Mechanism**: the message is V8's ValueDeserializer wire-format version
check — it fires only when serializer and deserializer run different runtime
builds. In the 12:31–12:33 window three DIFFERENT apps/projects (three
loader cache keys) failed simultaneously through one edge machine: the
poison is parent-process↔child-process build pairing, not one bad cached
child. Each error cluster began 3–14 min after a deploy and ENDED at the
next deploy (three clusters ended within seconds of the next version going
live) — new parent isolates re-roll the pairing.

**Self-healing**: 1–9 minutes per cluster, capped by deploy cadence; a fresh
connection escapes immediately, a browser's reused connection stays pinned
(the serve-error page's 3s polls made one tab re-hit the pair repeatedly —
since fixed by the page's periodic hard reload).

**The 2026-07-20 preview occurrence** fits the same mechanism one hop over:
the counter app is the stateful lane, whose post-getHead dispatch is the
cross-machine DO fetch — mixed workerd builds during staged rollouts produce
the same receiver-side rejection ("reached getHead, never entered
StatefulWorkerDurableObject").

**Related but distinct**: the same error string appeared for the restored
`iterate` project whose config repo predated the post-#2167 SDK surface
(virtual-module imports the platform no longer ships); healing that repo to
the current template (a6739397be) stopped those hosts' errors — a stale
build loading is a second path to the same deserializer rejection.

## Proposed next steps (from the diagnosis)

1. Instrumentation (primary): tag which hop threw in
   `DynamicWorkerRunner.fetch` (resolve / stateful DO fetch / loader
   entrypoint fetch) + attach the loader cacheKey before rethrow; log loader
   cache misses in `loadResolvedWorker`; include hop + cacheKey + rayId in
   the serve-lane PostHog capture. Answers next time whether fresh children
   also fail (process-pair mismatch) or only cached ones (cache staleness).
2. Bounded recovery (optional, stateless lane only): on exactly this
   message, retry once with a fresh child isolate via a per-isolate
   generation suffix on the loader cache key. No retry on the stateful hop
   (cannot change cross-machine pairing); never put the deploy version into
   the loader cache key (would cold-start every app every deploy).
