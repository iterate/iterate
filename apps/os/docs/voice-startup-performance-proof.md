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
`0c87aed9-c59d-4969-96df-85e855bcfc1c`. Two-child append/read/subscription
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

**Open finding:** intermittent hosted calls accepted commentary but produced no
audio within ten seconds. The original retained stream is
`/agents/voice/startup-colocated/01-18cb23dd`. A later instrumented 15-call
run captured two more: the facet sent commentary without a synchronous throw,
but received only `session.started`, with no transcript/audio, parse failure,
or speaker append. This places the observed failure before speaker delivery;
it does not prove that OpenAI received the commentary. A matched direct Node
control produced audio in all 15 calls.

A separate direct control sent commentary but withheld input audio for three
seconds: it received no response until input began, then received PCM 790 ms
later. Missing initial input can therefore produce the same symptom. The next
hosted probe counted input delivery: all 15 calls received their single mic
frame, started silence fill, and produced audio. It did not capture the silent
failure, so the input-loss hypothesis remains unconfirmed. A repeat of that
probe had four calls stall before `session-configured`, two calls accept but
end without audio, then nine healthy calls. The two post-acceptance failures
have explicit terminal reasons: the provider input clock fell 2,041 and 1,633
ms behind. The clock was anchored at `session.started` even though no input
had arrived; delayed first input therefore created artificial silence debt.
The six-line fix anchors the clock at first forwarded input and credits queued
capture duration; the one-second guard against genuine scheduling stalls is
unchanged. Both regressions were observed failing against the archived pre-fix
source; all 86 voice tests pass with the fix. Preview source
`eec00510bdd4a458fa580d7c8966e3e5552e7dd0` also passed an intentional delayed-input
call: acceptance at 3,171 ms, a 2,500 ms wait before input, then PCM at 6,649 ms.
The call stayed live and its project socket closed normally. The deliberate
wait is part of this correctness test, not ordinary startup latency. This defect is separate from the still-unexplained four pending
dials and earlier silent calls. Their runtime probe was already
null because the voice facet had ended the dial.

**Alarm correctness finding:** hosted alarm writes cross an RPC boundary, while
`StreamAlarmArmer` relies on native output-gate semantics. A rejected remote
alarm write can follow a successful child append acknowledgement. Existing tests
did not cover that boundary or outbound delivery before the remote write commits.
The actual sender already creates an in-flight watchdog before its background
delivery, so a second completion protocol is unnecessary if that watchdog write
is acknowledged before delivery. The hosted adapter now drains required parent
alarm writes before acknowledging child methods or starting outbound delivery.
A failed arm remains visible until a replacement commits; concurrent caller
retries share that replacement, and an identical idempotency-key append also
repairs it. Quiet clears are coalesced. The actual hosted-child regression
verifies that a rejected acknowledgement leaves one durable event and a
successful retry still leaves exactly one. All 110 focused alarm/sender tests,
app typecheck, and targeted lint pass. This correction still needs deployed
sustained-audio and recovery proof.

During source installation/mounting, two `stream core background work failed`
errors at 14:39:10 UTC mapped to ancestor `child-stream-created` announcements.
They preceded the first measured leaf announcement by 37 seconds. All 20 expected
leaf-to-ancestor rows and all six native ancestor hierarchy rows were subsequently
verified, with durable offsets/timestamps: no index entries were missing. The
logs omit the failed ancestor path and remote rejection details, so the exact
cause remains unresolved even though the tested index state is intact.

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

On the final clean deployment, with the uninstrumented source restored, five
further calls all produced audio. Client-ready times were
6,400/1,988/2,314/1,997/2,009 ms (median 2,009). The first followed deployment and
an explicit host restart; it is retained as a cold-start limit. First PCM was
7,458/3,413/3,374/2,790/3,424 ms. Host-restart persistence/subscription recovery
and rejected-reset state preservation also passed on this deployment. The
session's eventual `/api` teardown logged `Network connection lost`. A separate
one-call probe explicitly awaited socket closure after disposing its handles:
it received close code 1000 after 26 ms, with no error-level preview logs in
that interval. The CLI framework calls `process.exit(0)` after a command
returns, so the benchmark now explicitly disposes its connection and awaits
the close acknowledgement (bounded to one second) before returning. A fresh
audio call through the corrected CLI reached readiness at 2,679 ms and PCM
at 3,550 ms, then closed with code 1000 and no teardown failure. The preview
error query covering both close checks returned no error-level entries.

## Fable review and narrower controls

Claude Fable 5.1 at xhigh reviewed the source and measurements, then reviewed
an A/B/A control. Full Agent setup had median readiness 2,036 ms; omitting
Agent creation and protocol append diagnostically gave 1,637 ms; restoring
full setup gave 2,039 ms. Each arm had five calls. The omitted-Agent arm had
one silent call and was not a functional delegation configuration. The result
supports investigating contention, without identifying the contended resource.
Delaying Agent creation only until the initial voice batch committed worsened
median readiness to 2,295 ms and was rejected.

A later A/B/A delayed Agent creation until durable conversation acceptance.
All fifteen calls produced audio, on the same native deployment; each arm's
first call after its source mount is included.

| Median, milliseconds                | Original A | Agent after acceptance B | Restored A2 |
| ----------------------------------- | ---------: | -----------------------: | ----------: |
| Client readiness                    |      2,601 |                    2,293 |       2,357 |
| First non-silent PCM                |      3,837 |                    3,398 |       3,519 |
| Provider handshake bucket           |      1,510 |                    1,300 |       1,138 |
| Readiness minus handshake, per call |      1,061 |                    1,244 |       1,061 |
| Setup RPC resolved                  |      2,177 |                    3,874 |       2,030 |

The delayed arm did not reduce the time outside the handshake bucket. Its
setup RPC finished 1,212–1,778 ms after acceptance, versus -892–688 ms in A
and -826–9 ms in A2. Setup completion is not a measurement of first delegation
latency, but the backend work is clearly later. This small experiment does not
justify adopting the ordering change; the original ordering was restored.
The temporary variant also added an internal event wait (no additional device
WebSocket), whose cost is part of the comparison. Raw samples are retained in
`/tmp/voice-startup-pr/agent-after-accepted-comparison.json` and its three
`startup-after-accepted-{a,b,a2}.json` inputs.

A separate five-call local-clock probe measured initial voice append at
91–154 ms, voice catch-up barrier at 462–831 ms, Agent creation at 648–856 ms,
and Agent protocol append at 158–374 ms. The secret preflight took 1,222 ms
first, then 61–100 ms. These intervals overlap; the voice catch-up barrier
holds the setup RPC but does not gate provider dialing or client acceptance.
Agent creation contains existence/facts reads, collection and birth appends,
and four completion barriers; it is not a single storage operation.

Fable's actionable next experiments are an Agent start after voice acceptance
(measuring first-delegation cost too), moving initial persona context into the
existing Agent setup batch, an inert DO-facet egress control, longer idle
intervals, and three simultaneous calls. Its alarm review found the correctness
boundary described above. No security-policy relaxation, discarded audit write,
keepalive, or Agent harness change was adopted from the review.

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
