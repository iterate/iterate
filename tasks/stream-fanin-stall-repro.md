---
status: repro-confirmed, fix-implemented
size: medium
branch: stream-fanin-stall-repro
pr: https://github.com/iterate/iterate/pull/2486
---

# Reproduce: silent stream fan-in stall after redeploy

## Status summary

Done, pending review. The stall was **reproduced locally** (abrupt platform
death mid-delivery → restart → every later append silently unprocessed), the
mechanism is pinned (`subscription-delivery-halted` has no retry story — a
halt was forever and looks CLEAN in runtime state), and the fix is
implemented red→green: halts now record the deploy version and **one
automatic resume fires under any later deploy version** (the antidote-deploy
retry, same doctrine as the keepalive crash-loop breaker's version reset).
Unit tests + a live e2e prove it. One follow-up remains (the receiver-side
`.length` cold-boot poison seen in the local repro — see follow-ups).

## The incident (preview_8, project "nustom", 2026-08-12)

The mobile media feature appends `media/uploaded` to `/media`; the userland
MediaApp starter app reacts by analyzing images and appending
`media/processed` settlements. Fan-in chain:

```
/media Stream DO
  └─ "project-worker" itx-call subscription (start: beginning, onFailingEvent: skip)
       └─ evaluateItxExpression(["processEventBatch"]) → ProjectRpcTarget.processEventBatch
            └─ template worker processEvent → MediaApp.create().processEvent
                 └─ workers.get(mediaWorkerRef).syncEvent(event)
                      └─ MediaApp DO registry.catchUp("media")   ← pull; folds + runs obligations
```

- Analysis worked all afternoon; preview redeployed ~15:55Z.
- A wipe at 15:59:39Z + 19 `media/uploaded` (15:59:49–58Z) got ZERO
  processing; MediaApp fold frozen at 252 vs head 486.
- No error events noticed, breaker not tripped, no backoff state. Silent.
- One `worker.search()` (drives `registry.catchUp`) healed the fold
  instantly; settlements flowed.

## Reproduction (deterministic, local)

Sequence (dev server = the platform; kill -9 = the redeploy's abrupt death):

1. `pnpm dev` + create a project; append `media/uploaded` to `/media`; verify
   the full chain settles (`media/processed` lands; feed cursor at head).
2. Append a burst of uploads (deliveries + analyses in flight), then SIGKILL
   the dev server mid-flight.
3. Restart. Append the incident's shape: `media/wiped` + a burst of uploads.
4. Observed: **feed cursor frozen** below head forever; zero settlements; no
   errors in logs; runtime state shows `attempt: 0, nextAttemptAt: null,
   lastError: null` — because the subscription is **`status: "halted"`** and
   `#halt` deliberately clears the backoff ladder.

What actually happened: after the abrupt death, every delivery to the project
worker failed deterministically (`Cannot read properties of undefined
(reading 'length')` from the MediaApp host's cold catch-up — see follow-ups);
`onFailingEvent: skip` isolated it, confirmed 3 skips, and the mass-skip fuse
appended `subscription-delivery-halted` **~30 seconds after restart**. From
then on the stall is silent and permanent by design:

- appends never wake a halted subscription;
- runtime state looks clean (halt clears attempt/nextAttemptAt/lastError);
- the only recovery doors were operator `resumeSubscription` /
  `setSubscriptionCursorAndResume`;
- direct reads (`search`/`list`) heal the FOLD via pull catch-up — exactly
  the incident's "instant heal" — while the feed stays dead, so the system
  even *looks* healed until the next upload stalls.

On preview_8 the halt most plausibly rode the same fuse (or the silent
15-attempt unavailability ladder during the post-deploy worker-rebuild
window — that variant appends no `stream/error-occurred` at all, matching
"no error events"). Either route terminates in the same permanent
`subscription-delivery-halted` state. preview_8's slot was re-leased before
this investigation could read the halt event's payload (503s), so the exact
receiver error there is unconfirmed; the terminal state is what the evidence
pins.

## The fix (implemented)

**A halt is a breaker, not a grave.** Mirrors the keepalive crash-loop
breaker's version reset ("the antidote deploy retries immediately",
docs/writing-stream-processors.md):

- `subscription-delivery-halted` payload + reduced state now record the
  deploy version that gave up (`workerVersion`, stamped by the sender).
- On every send check, a halted subscription whose recorded version differs
  from the current deploy version gets ONE automatic
  `subscription-delivery-resumed` (idempotency-keyed per halt instance +
  version, so redeliveries and fresh incarnations converge). Fixed receivers
  recover unattended; still-broken ones re-halt under the new version and
  stay quiet until the next deploy (bounded: one ladder per deploy).
- Version-less legacy halts are grandfathered to the operator doors (without
  a recorded version, "the deploy that just gave up" and "the antidote" are
  indistinguishable — guessing would loop a same-version halt).

## Checklist

- [x] Study the delivery mechanism end to end — _map in the incident section;
      key files: stream-event-sender.ts, stream-durable-object.ts,
      core-processor-contract.ts, packages/iterate/src/processors/*, sdk.ts_
- [x] Inspect preview_8 live — _attempted; slot re-leased (503), evidence
      gone; PostHog CI key lacks query:read scope_
- [x] Reproduce the silent stall — _deterministic local repro via
      kill-9-mid-delivery + restart (steps above); the halted terminal state
      matches every incident observation_
- [x] Pin the mechanism — _mass-skip fuse / retry-ladder →
      `subscription-delivery-halted` → no retry story, silent-clean runtime
      state_
- [x] Fix (TDD red→green) — _antidote-deploy auto-resume; 4 new sender unit
      tests (stream-event-sender.test.ts "halted-subscription antidote
      resume") + 1 live e2e (stream-connections-and-subscriptions.e2e.test.ts
      "a halt recorded under an older deploy version auto-resumes without an
      operator", passing against local dev)_
- [x] Docs — _streams README delivery guarantees + contract descriptions_
- [ ] Full gauntlet before finishing (typecheck, lint, knip, format, tests)

## Follow-ups (deliberately out of scope)

1. **The receiver-side poison**: after the abrupt kill, the MediaApp host's
   catch-up threw `Cannot read properties of undefined (reading 'length')`
   deterministically until direct reads healed it (suspects: the runner's
   cold-load/refold lane, or `detachPlainRpcResult`'s shallow spread of a
   getEventPage result in packages/iterate/src/sdk.ts). Needs its own
   stack-first hunt; it is the *trigger*, while this PR fixes the
   *unrecoverable amplifier*.
2. `ProjectRpcTarget.processEventBatch` only classifies repo-not-seeded and
   build-in-progress as receiver-unavailability; other worker-load failures
   read as per-event failures and feed the skip fuse. Worth broadening.
3. Observability: a halted platform feed (project-worker) deserves louder
   surfacing than one red row in stream runtime state.

## Implementation notes (lab notebook)

- (2026-08-12) Task created; delivery-chain map drawn.
- Local restart alone did NOT reproduce (graceful restart heals: appends →
  sendDue → delivery, level-triggered as designed). The missing ingredient
  was in-flight work severed by an ABRUPT death — that produced a
  deterministically failing receiver on the next boot, which is what the
  fuse (correctly) halts on. The un-fixable part was halted-forever.
- Ruled out along the way: alarm loss across restart (appends re-arm from
  durable rows), in-flight watchdog stranding (hosted-only rows get
  clearInFlight; source-owned rows never persist in-flight), the phantom-lag
  empty-read ack (needs an actually-empty durable suffix), quiet-alarm
  deletion (vetoed by `hasScheduledWork` + lag-without-schedule).
- The incident writer's "no backoff state / journal healthy / breaker not
  tripped" all match the HALTED terminal state: `#halt` clears the ladder, so
  the row looks pristine; the MediaApp keepalive had nothing owed at deploy
  time (delivery-side gap, not obligation-side).
- preview_8 CLI probes 503'd (slot re-leased); PostHog personal API key in
  Doppler lacks `query:read`, so the event-log reconstruction path was
  unavailable too.
