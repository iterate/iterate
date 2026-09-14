# Fresh voice startup experiment

This branch tests whether fresh conversation streams can approach the direct
OpenAI connection cost. The hosted-stream experiment is restricted to
`preview_17` and `/agents/voice/startup-colocated/…`. It is not a production
placement policy. Production and HAVPE have not been changed or flashed by
this experiment.

## What was slow

A fresh native Stream DO incurred native worker activation before its actual
read/write. The first userspace processor call through its scoped ITX binding
then incurred another native worker activation. Five measured first ITX calls
took 1,103–2,358 ms; subsequent calls took 0–14 ms. Native module incarnation
IDs were different for each fresh stream. SQL/storage operations after those
activations generally took tens of milliseconds.

The experiment hosts the existing Stream DO implementation as separate facets
beneath one project host. Each child retains independent SQLite state and
processor facets. Their scoped ITX bindings reuse one native worker instead
of each paying that cold cost. Authority remains scoped to the original
project and stream; the host validates every routed child name.

Other changes start voice and ordinary Agent setup in parallel, put
`call-started` in the first voice setup batch, and let firmware flush captured
speech on `conversation-accepted` without waiting for Agent setup to return.
Delegations wait for the ordinary Agent's existing provisioning/configuration
contract. The Agent harness itself is unchanged. Dashboard SSR is imported
only for dashboard requests; server output is minified while preserving class
names for telemetry.

## Measurements

Use precise milestones, rather than calling every phase “setup complete”:

- **Setup returned:** Agent provisioning/configuration and voice fold-through
  barrier finished. This may overlap the provider connection.
- **Provider ready:** `session.started`, after WebSocket upgrade and
  `session.start`.
- **Client ready:** `conversation-accepted` delivered over the established
  project WebSocket.
- **First non-silent PCM:** a PCM16 frame with peak amplitude ≥100 reached the subscriber. This
  does not measure playback, DAC output, or physical speaker onset.

14 September 2026, Preview 17, five alternating native/hosted pairs on one
project WebSocket, new stream path for every call:

| Client-ready milliseconds | Native | Hosted |
| ------------------------- | -----: | -----: |
| 1                         |  8,892 |  3,014 |
| 2                         |  4,454 |  2,131 |
| 3                         |  4,314 |  1,632 |
| 4                         |  4,354 |  1,304 |
| 5                         |  7,719 |  1,441 |
| Median                    |  4,454 |  1,632 |

All ten calls produced audio within the fixed 10-second deadline. First PCM
medians were 5,604 and 3,012 ms. Host preparation was an ordinary append/read,
184 ms outside these per-call timers; it did not warm the first child ITX
connection, whose 1,186 ms is included in the first hosted call.

Separate direct Node controls from the Mac used GPT-Live, marin, client
delegation and the same short commentary task. In five paired transport
comparisons, WebSocket median `session.started` was 829 ms and playback
submission 1,724 ms; WebRTC was 1,566 and 2,611 ms. All ten completed actual
SoX playback. These are different network locations from Workers and are not
values to subtract blindly from the hosted result. Physical speaker onset
was not measured.

## Correctness evidence and remaining limits

The clean native preview version is
`49ea2864-f1d0-4d86-bf7c-cb0b035afb09`. Two-child append/read/subscription
isolation passed. A full child retained its durable marker across killing the
native host; a new connection/subscription then received a new event.
Hosted reset is explicitly unsupported: clearing child storage cannot atomically
clear the virtual alarm stored in the host. Ordinary native reset is unchanged.
Hosted alarm tests cover restart, reentrant delete/rearm, concurrent dispatch,
future siblings and bounded failure. A terminal empty-error regression caught
and fixed an otherwise unbounded native alarm loop.

A later ten-call instrumented run produced audio every time and directly
observed commentary sent on a live socket followed by provider transcript/audio.
Error-level preview logs for that run were empty. The first call after a host
restart took 5,425 ms, including 1,746 ms credential preflight, 1,208 ms first
ITX access, and 1,884 ms provider handshake. Warm calls mostly took
1,584–1,791 ms; a 2,493 ms call included a 1,992 ms provider handshake.

**Open finding:** one earlier hosted call accepted and folded commentary but
produced no audio within 10 seconds. The retained stream is
`/agents/voice/startup-colocated/01-18cb23dd`. Its historical logs do not prove
whether commentary was sent. Ten exact matching direct calls and ten later
instrumented hosted calls produced audio. Those successes do not explain or
resolve the failure. Treat it as a release blocker, not a discarded sample.

The final instrumented probe also logged two `stream core background work failed`
errors at 14:39:10 UTC, mapped to ancestor `child-stream-created` announcements.
The logs omit the failed ancestor path and remote rejection details. Audio
success does not resolve those failures; their cause and resulting index state
must be accounted for before release.

Cold-host readiness, long idle periods, simultaneous calls, and resource use
with many children need further evidence before this becomes a general
placement policy. A 30-second idle test preserved ITX warmth; it does not
establish indefinite warmth. No extra keepalive was added.

## Later direct and full-path controls

The final uninstrumented voice source (`9f7efdd7cb5180f29027090bc27400860da8cfb9`)
produced audio in all ten calls. Client-ready median was 2,092 ms
(1,619–3,211); its `handshakeTookMs` median was 1,390 ms (1,030–1,945).
That field includes project egress and credential handling before the actual
OpenAI fetch, so it is not a measurement of OpenAI alone.

A contemporary quiet Node control still reached `session.started` in a median
842 ms (800–1,003), with first non-silent PCM at 1,778 ms (1,571–1,958).
An inert stateless Worker using the exact project egress/secret route took
3,122 ms on its first call and 1,231/844/1,001/883 ms thereafter. These
controls do not support attributing the full-path delay to a general provider
slowdown.

Two subsequent five-call probes returned timing evidence through runtime state
only after audio arrived (or the fixed deadline expired). All ten produced
audio. The final probe split the remaining work as follows:

| Observed phase                                                         | Milliseconds across five calls |
| ---------------------------------------------------------------------- | -----------------------------: |
| Voice facet construction to starting its provider fetch                |                         90–214 |
| First scoped ITX get inside that facet                                 |                           0–26 |
| Configuration's passive Agent context append, before dialing           |                         18–105 |
| Secret state read                                                      |                         54–105 |
| Durable secret-use audit append                                        |                          41–58 |
| Upstream WebSocket upgrade                                             |                        389–440 |
| Project policy refresh (cache hits were 0)                             |                          0–417 |
| Provider fetch returned to `session.started`, on the voice facet clock |                      357–1,210 |
| Durable acceptance append after `session.started`                      |                          20–53 |

Client-ready times for that probe were 2,733/2,070/2,085/1,333/2,048 ms.
These phase ranges are not an additive waterfall: they overlap, use separate
actor clocks, and Workers' elapsed-time readings can disagree even for nested
operations. The 1,210 ms session-start interval is retained; the evidence does
not separate remote model initialization from inbound scheduling within it.
The stream admission, facet loading, and client downlink outside the facet's
clock also remain part of client-ready time.

The former 1–2 second first ITX call is absent from these warm hosted calls.
The remaining cost is several smaller operations plus variable policy and
provider intervals. The configuration context append remains awaited so its
failure cannot silently lose required Agent context. No credential audit was
made fire-and-forget, no keepalive was added, and all timing instrumentation is
excluded from the runtime diff.

## Reproduce

From `apps/os`, with the current voice source installed in a disposable
project and an existing `/secrets/openai`:

```sh
doppler run --config preview_17 -- pnpm cli voicelab startup \
  --project <project-id> --runs 5 --audio \
  --stream-prefix /agents/voice/startup-colocated/proof
```

Use a prefix outside `startup-colocated/` for native placement. The CLI holds
one authenticated project WebSocket and emits every sample, including errors.
Credential provisioning and source installation belong outside the call
measurement. Never publish credentials in benchmark artifacts.

Detailed temporary experiment scripts and raw results on the investigation
machine are under `/tmp/voice-startup-pr`; the independent Node transport
comparison is under `/tmp/voice-startup-webrtc-20260914`. They are not runtime
dependencies. Retain failed samples and distinguish clocks from different
actors when interpreting their phase arrays.
