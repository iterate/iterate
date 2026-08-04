# setupVoiceAgent readiness: the token handshake

Deployed config commit **08f3d849**, protocol revision
**`warmup/3-call-path-and-bridge`**,
identity `/agents/voice/dev-621cd7aa562613aa`.
Machine-readable record: `warmup-handshake-97213c36.json`.

## What it proves, and why the three earlier attempts did not

| Attempt              | What it read                        | Why it was vacuous                                                    |
| -------------------- | ----------------------------------- | --------------------------------------------------------------------- |
| `state !== null`     | the stream's processor registration | proves registration, not that the subscription-owning instance exists |
| `processor.health()` | a reply from a worker ref           | proves a wrapper answered, not that instance                          |
| `this.processor`     | a function reference                | reads a property; runs nothing                                        |

The handshake instead: setup appends `voicelab/warmup` with a fresh token; the
processor that owns this stream's subscription consumes it, resolves the brief at
the head of the agent stream, and appends `voicelab/warmup-ready` carrying that
token, the streamPath, the brief's exact `idempotencyKey`, and the protocol
revision. Setup returns only when all four match; otherwise it throws.

## The processor was not the whole cost: the bridge is a second cold worker

Warming the processor alone did not fix the first call. Session 2 of a
remount cycle acknowledged warm-up in **409 ms** and the call still took
**16.2 s** to go live. The stream shows why:

| time         | event                                                                       |
| ------------ | --------------------------------------------------------------------------- |
| 01:14:20.573 | `call-requested` — no bridge answers                                        |
| 01:14:28.573 | `call-requested` again — the device re-asks, exactly 8.000 s later          |
| 01:14:29.120 | a bridge enters (`bridgeEnteredAt`)                                         |
| 01:14:30.373 | `call-accepted` — dialled in 458 ms, ready in 1063 ms                       |
| 01:14:30.411 | `call-failed: superseded by a newer bridge` — the first bridge, 38 ms later |

The bridge is a **separate stateful dynamic worker** (`voiceBridgeRef`,
`durableWorkerKey: voicelab-bridge`), killed by the same remount and reached by
`startVoiceCall` with a 30 s build budget. Both bridges entered within a second
of each other, ~8.5 s after the first request: those eight seconds were its
build, and the device's re-ask — correct in itself, a request can be lost —
created the second bridge that superseded the first.

So the probe now travels the whole call path: it is dispatched **after** the
birth-certificate gate and judged by the same freshness rule as a real
`call-requested` (the two things that can silently drop one), and it warms the
bridge through the same ref, the same fetch helper and the same build budget
`startVoiceCall` uses — via an inert `mode=warm` route that dials nothing,
appends nothing, and does not disturb a call that may be building.

Setup's `warm.ok` now requires the bridge leg (`bridgeWarmMs` present), and the
acknowledgement is correlated at that hop too: a bridge echoing another token is
not the one this probe reached.

## Two bounds, deliberately different

`WARMUP_DEADLINE_MS` is 45 s and is **not** the 15 s call-live gate. The gate is
a promise to the person holding the device; the deadline is setup volunteering to
pay a cost so the call does not. Two cold builds sit inside it — the guest out of
the config repo (measured 13.6 s, and 17.0 s once it also warms the bridge) and
the bridge's own 30 s budget. Timing out at 15 s would push both back into the
first call, which is the defect the handshake exists to remove.

## The measured cost this removes

|                                | round trip | setup total |
| ------------------------------ | ---------- | ----------- |
| cold (first call after deploy) | 13 610 ms  | 13 996 ms   |
| warm (second)                  | 188 ms     | 579 ms      |
| warm (third)                   | 183 ms     | 637 ms      |

That 13.6 s is the dynamic-worker build out of the config repo — the cost a
first call used to pay, which is what made "call live in 16.2 s" against a
bridge whose own share was 1.4 s.

## Failure audit: `voicelab/warmup-unresolved`

Named `-unresolved` rather than `-failed` because that is what it reports: the
processor woke and could not resolve a brief.

- **Contract-defined** — declared in `emits` with a payload schema requiring a
  non-empty `token` (`voice-agent.ts`, contract block).
- **Token-correlated** — the handler echoes the token it consumed; setup's
  `waitForEvent` predicate matches on that token, so an answer left over from a
  previous setup on this long-lived stream can neither satisfy nor fail this one.
- **Observed for immediate classified failure** — setup waits on
  `["voicelab/warmup-ready", "voicelab/warmup-unresolved"]` together. The
  unresolved branch sets `warm.error` to the processor's own reason and returns
  in milliseconds instead of burning the 15 s deadline.
- **Can never count as success** — `warm.ok` is assigned only in the ready
  branch, and only when the brief key and protocol revision both match.
  `acknowledged` stays false.
- **Cannot reach the provider, the device, or audio** — hosted delivery is
  filtered, and no warm type appears in any of the three consumers:
  - bridge → `mic-frame`, `ping`, `turn`, `say`, `call-ended`, `call-accepted`
  - device downlink (`voicelab_stream.c`) → `spk-frame`, `grok-event`,
    `call-ended`, `call-accepted`, `pong`
  - processor wake filter → `voice-agent/created`, `call-requested`,
    `call-accepted`, `call-failed`, `warmup` — the answers are absent, so an
    acknowledgement cannot re-wake the processor that wrote it.

## Root cause of the first failing revision (8a4e09aa)

Setup threw on both attempts with `acknowledged=false` and no answer event at
all — not an unresolved answer, a silence. Cause: `voicelab/warmup` was missing
from the processor's own wake filter, and **hosted delivery is filtered**, so the
token never reached the processor. Fixed by adding the type to the filter, which
also changes the filter's `contentHash` — the idempotency key follows the
content, so a re-setup appends a new `subscription-configured` under the same
`subscriptionKey` and replaces the old filter rather than running two.

## Head-of-stream correctness

Both readers now share one `latestBrief(stream)`: `getEventPage` for
`streamMaxOffset`, then a bounded tail behind it. `getEvents` starts at offset
**zero**, so the previous filtered `limit: 500` read returned the OLDEST matches
— on a stream carrying ten sessions of mic frames, "the latest brief" was hours
stale, despite the comment above it claiming to compare the head. Setup and the
processor must read identically or the comparison is meaningless.

Setup no longer derives the expected key from its own append result, which was
`null` whenever the refresh deduplicated and degraded the check to "some brief".
It reads the actual head brief after refreshing and requires that exact key.
