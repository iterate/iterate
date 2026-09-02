---
status: in-progress
size: large
---

# Stream crash-loop quarantine (park a DO that OOMs on every boot)

**Status summary:** pure probe core implemented and tested (boot-spacing
signature, quarantine survives slowed wakes, deploy/admin unpark); DO wiring,
core event, RPC, and UI not started — held for Misha's look at the flagged
assumptions.

## Why

The bound-script-settlements incident (see `tasks/bound-script-settlements.md`,
PR #2572): a poison event OOMed the stream DO's isolate on every fold attempt.
Nothing stopped the loop — it ran at ~5s cadence for hours:

- The keepalive's revival backoff (10s→6h) and crash-loop evidence exist, but
  the wake source here is **Cloudflare's platform alarm retry plus subscriber
  retries** (`rpc-targets.ts` retries reads after "Durable Object reset"), not
  the keepalive.
- An OOM is uncatchable in-process: the incarnation dies before any code can
  record "that attempt failed", so every in-memory counter
  (`#busyRefires`, etc.) resets to zero on each boot.
- `stream/woken` is appended on every cold boot
  ([stream-durable-object.ts:1247](../apps/os/src/domains/streams/stream-durable-object.ts)),
  which is how we can see the loop in the journal — ~170+ events and climbing.

The fix pattern already exists in this codebase: the keepalive's durable mark
"stored in DO KV BELOW the journal/fold" written before work. Extend it to DO
boot itself.

## Design

**Probe (mark-before-work):** at DO init, before arming facet replays / fold
catch-up / alarms, read+write a KV record `bootCrashProbe`:

```ts
{ rapidBoots: number, lastBootAtMs: number, version: string, quarantinedAtMs?: number }
```

_Refined during implementation:_ a crashed boot can't be observed directly (an
OOM leaves no record, and there's no eviction hook), but a crash **loop** has an
unmistakable durable signature — rapid successive boots. So the probe keys on
**boot spacing** rather than a time window:

- increment + `storage.sync()` BEFORE the risky work (the crash that needs the
  record is the one that prevents writing it afterwards);
- a boot ≥30s (`RAPID_REBOOT_MS`) after the previous one resets the count —
  spaced wakes are real traffic, not a retry loop (the observed pathology
  reboots every ~5s on the platform's alarm retry cadence);
- a clean signal — a fold/alarm pass completing with nothing owed, or the
  incarnation surviving its confirmation window — resets it to zero;
- a different worker version resets it (a deploy is the antidote, matching the
  keepalive's version-reset budget);
- an existing quarantine is NOT reset by spacing (dropping the alarms slows
  the wakes; that slowdown must not read as recovery) — only a deploy or the
  admin unpark clears it.

**Trip:** 5 rapid boots in a row (`BOOT_CRASH_QUARANTINE_THRESHOLD`) →
quarantined:

- append an idempotent `stream/quarantined` evidence event (per version), so
  the journal records why the stream went quiet;
- do NOT arm alarms, facet replays, fold catch-up, or delivery lanes;
- keep serving reads (`getEvents`, `getEventPage`) — the journal itself is
  healthy and the UI should show history plus a quarantine banner instead of
  the raw platform OOM error;
- reject appends with a clear error naming the unpark path (appends feed folds;
  accepting them while folds are parked grows the poison backlog silently).

**Unpark:**

- automatic on worker version change (deploy may carry the fix — exactly this
  incident: #2572 devalues the poison event);
- explicit admin RPC (`unquarantine`) exposed through itx for operators,
  mirroring the keepalive's "operator's no-deploy antidote";
- unpark resets the probe and re-arms normally; if the stream re-trips, it
  re-parks after N more crashes — bounded, not a loop.

**UI:** the stream view should render the quarantined state (banner + retry
control wired to unquarantine) instead of the generic "isolate exceeded its
memory limit" error the user currently sees.

## Checklist

- [x] boot-crash probe record + trip/reset logic _pure module at
      `apps/os/src/domains/streams/boot-crash-probe.ts` (next to its consumers
      rather than in packages/iterate — nothing outside the stream DO needs
      it), 8 scenario tests incl. an incident replay at 5s cadence_
- [ ] wire into `StreamDurableObject` init: mark before facet/fold arming,
      confirm-clean alarm, skip arming when tripped
- [ ] `stream/quarantined` core event + reducer handling
- [ ] read paths stay open; appends rejected with a clear message
- [ ] auto-unpark on version change; admin `unquarantine` RPC via itx
- [ ] UI: quarantine banner + unpark control in the stream view
- [ ] tests: probe unit tests; DO-level test that a constructor/fold crash loop
      trips quarantine and a version bump unparks

## Assumptions (to confirm with Misha)

- Threshold 5 crashed boots / 10 min window — generous enough that transient
  platform resets (deploys, evictions) never trip it; a real OOM loop trips in
  under a minute.
- Appends rejected while quarantined (fail loud) rather than accepted-but-unfolded.
- Quarantine is DO-level, not per-processor: an OOM takes out the whole isolate,
  so finer-grained parking can't be attributed reliably.

## Implementation log
