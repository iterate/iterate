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

The first clean native preview version was
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
app typecheck, and targeted lint pass. The deployed sustained-audio results and remaining recovery limits follow.

On the corrected native deployment `b48bde47-2467-42d7-8c79-ae6cfbe469ef`,
the first startup sample missed its 10-second deadline; the next four reached
readiness at 4,996/3,712/2,184/3,497 ms and produced audio. These results do
not establish acceptable performance. The cold sample's trace shows a
6,416 ms project-config-worker build before the first voice setup append;
OpenAI had not been contacted. A separate continuous-input test hit its
eight-in-flight limit after 1.1 seconds of 100 ms microphone appends:
acknowledgements took 108–1,282 ms (median 789 ms). It stopped before a complete
spoken answer, then closed normally. Source review found that ephemeral
processor batches also awaited the new remote alarm barrier. This is a
release-blocking regression. The follow-up gives each outstanding ephemeral
batch a bounded in-memory timeout, cancelled on acknowledgement or close,
while durable batches retain their acknowledged recovery alarm. All 114 focused
tests pass, including a final unacknowledged PCM batch with no future append,
acknowledgement cancellation, replacement cancellation, and closing a connection
while its durable alarm acknowledgement is pending. Raw evidence is in `startup-alarm-fix-baseline.json` and
`hosted-continuous-audio-alarm-barrier.json` under the temporary artifact directory.

The memory-timeout follow-up is deployed as native version
`41b88e87-75fd-4dde-b78b-b285299671a7`, pinned to commit `3ebf951d81dabb2a258fad58d9851c8bb382faaf`.
The repeated continuous-input test acknowledged all 201 microphone appends over
20 seconds: median 175 ms, maximum 490 ms, versus the failed previous run's
789 ms median. It received speaker audio, closed with code 1000, and its
17:05:08–17:05:36 UTC preview window had no error-level Worker events.
This establishes continuous delivery, **not smooth playback**. Within its first
answer, the measured supply deficit was 598 ms: that much initial buffering
would have been needed to cover arrival variance at the subscriber. A matched
direct Node control, with the same instructions, commentary and paced input,
needed 138 ms for its first answer. These are individual answers of different
lengths; they indicate remaining relay variance, not a measured hardware
underrun rate. Inter-answer pauses are excluded from both figures.

The first post-deploy attempt is retained separately: it missed a 15-second
acceptance deadline. Its stream woke at 17:03:42.021 UTC, but the initial voice
batch was not appended until 17:03:55.696, a 13.675-second gap before voice
setup. Available traces do not yet explain this gap; observed config-worker
calls alone do not account for it. The benchmark ended before acceptance.
Unlike the earlier 6.416-second build sample, this is not an attributed cold
build measurement.

Five later startup calls on the existing project all produced audio and closed
normally, with client-ready times 5,214/2,871/2,341/2,595/2,147 ms (median
2,595). Five calls on a newly provisioned project with identical voice source
also all produced audio: 4,686/2,169/1,425/1,617/1,442 ms (median 1,617).
Provider-handshake medians were 990 and 897 ms respectively. Both first samples
are retained. This sequential comparison suggests the existing host's accumulated
state or concurrent work matters, but does not identify that cause; project
placement and timing also differ. Inputs are
`startup-memory-watchdog-baseline.json` and
`startup-memory-watchdog-fresh-project.json`.

The successful continuous run's shared host also recorded 268 alarm-set spans
in the trace dataset (265 in Workers invocation records). The host contains
historical child streams, so these totals do not prove an alarm write per
current audio frame. Processor recovery can independently arm the same hosted
alarm relay, beyond the ephemeral sender watchdog. Argument-level attribution
or a fresh-project control is required before changing that recovery behavior.
An instrumented follow-up identified the current child's writers. Of 330
retained relay writes, 161 came from immediate delivery scheduling and 154 from
alarm-turn replay; only 11 facet-alarm proxy calls were observed. The dominant
cause is source-owned durable subscriptions scheduling a turn before discarding
an audio-only suffix. A regression test reproduces that unnecessary scheduling.
The correction acknowledges an exactly contiguous, complete ephemeral
suffix from the existing append handoff before scheduling source-owned work;
other batches retain normal reads, filtering, retries and watchdogs.

The first two instrumented runs of that correction did not prove performance.
On native `dbc8871d-b147-42b6-a9aa-3f976b8434f6`, the first hit a code-update
reset at 17:28:13.995 UTC, coinciding with acceptance; microphone requests then
reached the eight-pending bound. The second failed while opening its subscription
with a native storage-reset reference (`kc7nagaslasop9jcfiv5j6os`), before any
microphone append. Its terminal fact was already durable, and a subsequent
read found every subscription caught up, with no connections, errors or queued
work. Both failed samples are retained as
`hosted-continuous-audio-source-owned-ephemeral-probe{,-repeat}.json`.
Cloudflare documents that code updates propagate eventually and can reset
in-flight objects, but that does not explain the separate internal storage
failure. See [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).

A third, post-recovery run on the same deployment completed all 201 microphone
appends (42 ms median, 117 ms p95, 318 ms maximum) and closed with code 1000.
Its retained error query was empty. Comparing the actual 20-second feed windows
with the successful pre-fix instrumented run, relay writes fell from **290 to
11**. Facet-alarm proxy records were nine and eight respectively. Both runs
used the same 201-frame contract and commentary; answer lengths and other
durable events varied, so the 96.2% reduction is an observed traffic comparison,
not an exact per-frame cost model. First-answer supply deficit was 236 ms,
versus 392 ms in the earlier clean fresh-project run and 138 ms in direct Node.
This remains an instrumented measurement, not hardware playback proof.

Claude Fable 5.1 at xhigh independently reviewed the 19-line change and found
no blocking correctness issue. The cursor update already existed in the
matched-empty delivery path; it now joins the original append transaction,
removing the unnecessary alarm turn and range read. The final regression was
executed against archived pre-fix source and failed as expected. All 92 sender
tests and 128 combined sender/alarm/keepalive tests pass, as do app typecheck
and targeted lint. Runtime instrumentation is excluded from the committed fix.
The separate native internal-storage reset remains unexplained; subsequent
success is not its remediation. Evidence is in
`source-owned-ephemeral-valid-comparison.md` and
`hosted-continuous-audio-source-owned-ephemeral-probe-recovered.json`.

Raw evidence is retained in `hosted-continuous-audio-memory-watchdog.json`,
`hosted-continuous-audio-memory-watchdog-repeat.json`, and
`direct-continuous-audio-20260914-metrics.json`. All checks, including preview
deployment and e2e, pass on `3ebf951`; the operational findings above remain open.

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

A minimal provider control alternated five stateless Worker calls and five
fresh dynamic stateful-worker calls, with the same source, project egress,
secret, model, instructions, and paced input. Stateless readiness was
862/954/865/901/1,048 ms (median 901); stateful readiness was
3,167/2,260/2,810/2,337/1,749 ms (median 2,337). These are remote method-entry
to `session.started` measurements, excluding caller dispatch. First PCM
medians were 1,785 and 3,162 ms respectively. All ten produced audio and
observed socket closure. The stateless result is close to the earlier direct
Node control's 840 ms readiness, with the usual location and clock limits.

This stateful control uses `StatefulWorkerDurableObject`, not a hosted stream
processor; changing its path prefix does not change its placement. It therefore
does not measure the hosted-stream overhead. The first probe mistakenly called
the platform's literal `getSecret(...)` header grammar as a JavaScript function;
all ten rows failed before fetch and are retained separately, not counted as
OpenAI samples. Corrected results are in
`facet-vs-stateless-live-probe-v2-result.json` in the temporary artifact directory.

## Clean current-head results

Runtime commit `055337b142344aed13b86cb6246c8caa1df212cd` is rebased onto
`origin/main` at `3a5ea998e`; the clean, uninstrumented deployment is
`1829d6cd-62c4-4c0b-a365-82b6ec8347b6`. Deployment smokes passed. The five
startup samples retained one cold acceptance timeout at 10 seconds, whose
setup eventually resolved at 18,515 ms. The four succeeding calls reached
acceptance at 8,483/1,658/1,812/1,587 ms, with first PCM at
9,524/2,657/2,763/2,607 ms. The failed sample has no observed call-started or
provider milestones. Correlated logs now identify cold artifact builds in this
call's dependency chain, as detailed below; the complete delay is not yet
explained. Do not summarize only the last three as the distribution of all
fresh calls.

The subsequent continuous test failed before audio while opening its
subscription, with native storage-reset reference `1cvjbn8bp2mrbi7gdv5q7jbe`.
The reset affected the common host and its alarm/subscription work. A cursor
`nack` write also failed during recovery; that stack identifies where the
already-failing storage was accessed, not the origin of the platform fault.
A readback verified the scoped terminal fact and zero remaining connections,
subscription lag, retries or deadlines. No automatic retry turned either
failed sample into a reported success. The clean sustained-audio proof is
therefore still incomplete.

A separate primitive control then opened five alternating native/hosted fresh
stream pairs on one project WebSocket, with no voice setup or OpenAI call.
Each subscribed at head, appended one durable marker, and observed delivery.
All ten passed and the socket closed with code 1000:

| Median milliseconds | Native stream | Hosted stream |
| ------------------- | ------------: | ------------: |
| Open subscription   |         1,894 |           156 |
| Append acknowledged |           175 |            76 |
| Append to delivery  |           174 |            43 |

A second five-pair control started each subscription (replay from offset zero)
and first marker append concurrently. All ten pairs of operations and marker
deliveries passed. Native median subscription/append acknowledgement/delivery
times were 1,779/1,675/1,739 ms; hosted were 191/113/155 ms. The single project
WebSocket closed with code 1000. This exercises fresh-child construction overlap
without voice setup; it did not reproduce the intermittent storage fault.
Its artifact is `primitive-concurrent-subscription-control.json`.

Delivery may precede the append RPC reply because they use independent callback
and acknowledgement messages. This proves the small hosted primitive cost on
these samples; it neither explains the voice cold-start delay nor rules out the
intermittent storage-reset fault. Raw artifacts are
`startup-source-owned-ephemeral-clean.json`,
`hosted-continuous-audio-source-owned-ephemeral-clean.json`, and
`primitive-subscription-control.json` under the temporary artifact directory.

### Cold build attribution and rejected context batching

The first call's ITX log `log_07ee4e17bcaa46f1aeff0a18e191025f` confirms
`Function.call` took 18,519 ms, from 17:40:11.447 to 17:40:29.966 UTC.
Its trace is `780585d24b84a63f1a380f89609fe22a`; the original build also
appears under `e44e8b200dd98682cefb1ef91a9df8ae`. The mounted voice
entrypoint runs through a native StreamDO's ProcessorFacet, separate from
the hosted conversation parent. The generic function label is not evidence
that the whole delay was agent creation.

The build coordinator recorded `voice-agent.ts` taking 8,408 ms, from
17:40:15.140 to 17:40:23.548, and `worker.ts` taking 5,312 ms, settling at
17:40:21.381 with 22 coalesced waiters. These operations overlap; their
durations must not be added. They include source loading, compilation and
cache persistence. The voice artifact's KV write alone has a 2,698 ms span;
the build currently awaits that write before returning its artifact.

This proves cold builds occurred, not that they recur for each new stream.
The SDK pin participates in artifact identity and this run followed a new
pin. Native span timestamps are inconsistent across actors, and the function
finishes after the coordinator settlement, so this is still an incomplete
breakdown of the 18.5 seconds. The storage reset in the subsequent test
remains a separate unresolved fault. Raw queries and their limits are recorded
in `clean-cold-attribution.md` under the temporary artifact directory.

Fable's proposed initial persona-context batching was also tested with five
calls before, five with the variant, and five after restoring the baseline.
All 15 produced audio without diagnostics and all three sockets closed with
code 1000. Median acceptance was 2,046/2,013/1,562 ms and first PCM was
2,984/3,029/2,596 ms. The variant did not consistently improve either outcome,
so it was rejected and the original source was restored. Evidence is in
`persona-initial-batch-aba-20260914/summary.json`.

An unchanged-source hosted idle control retained one authenticated project
WebSocket across all four calls. The harness asserted the hosted path prefix
before connecting and issued no keepalive, polling, health or setup traffic
during its quiet intervals:

| Quiet interval | Acceptance | Provider handshake | First PCM |
| -------------- | ---------: | -----------------: | --------: |
| Initial call   |   3,138 ms |           1,263 ms |  4,000 ms |
| 30 seconds     |   2,144 ms |             756 ms |  3,204 ms |
| 90 seconds     |   2,257 ms |           1,002 ms |  3,145 ms |
| 180 seconds    |   2,250 ms |           1,336 ms |  3,136 ms |

All four produced audio without diagnostics; the project socket closed with
code 1000. This observed no progressive idle penalty through three minutes;
one sample per interval does not establish a distribution or prove that the
permanent socket prevents hibernation. An earlier run accidentally selected
ordinary native paths; it remains a separate native control, never hosted
evidence. Artifacts are `hosted-idle-decay-control.log` and
`idle-decay-native-results.json` in the temporary directory.

Fable's focused cold-build review recommends measuring background artifact
persistence and using the existing entrypoint health call at client reconnect.
Its proposed stale-while-revalidate policy reads remain unadopted: latency
work must preserve the existing egress-policy enforcement guarantees.

### Exact-pinned repo reads and remaining latency

Runtime `c503c53f` serves an exact pinned default-branch snapshot from the
Repo DO's durable lazy-head reader when the stored, listed and read heads all
match. Historical revisions still use checkout. A pre-fix test failed on the
unnecessary checkout; 39 repo tests and app typecheck pass with the change.
Preview version `3cda6957-824b-4236-8d4b-841e624840b5` deliberately retains
SDK pin `055337b` so the comparison changes only the native implementation.

Three forced-cold health calls per arm use the same pinned source, with unique
unused virtual modules to force different artifact keys. The emitted runtime
hash correctly remains identical. All six calls succeed:

| Measurement (ms), three samples  | Before                | After                 |
| -------------------------------- | --------------------- | --------------------- |
| Full health call                 | 9,617 / 6,083 / 7,746 | 7,272 / 6,718 / 6,315 |
| Build coordinator                | 5,863 / 3,581 / 5,731 | 2,873 / 4,843 / 3,872 |
| Repo snapshot native callee span | 1,615 / 348 / 244     | 0 / 0 / 0             |
| Artifact KV write                | 1,618 / 1,268 / 2,092 | 1,255 / 1,120 / 988   |

Zero is the recorded span duration, not literally zero work: Workers clocks
advance on I/O, and native invocation wall time can be nonzero. The removed
checkout is verified; n=3 and variable KV latency do not establish that the
entire median health improvement (7.75 to 6.72 seconds) comes from that fix.
Artifacts are `cold-pinned-worker-build-{before,after}.json`.

The following continuous hosted call still took **10,167 ms** to acceptance.
It acknowledged all 201 microphone frames and terminated normally, but its
17.9-second answer needed **893 ms** extra initial buffering to avoid a supply
deficit. A maximum **799 ms** gap already appears at the provider WebSocket
callback, before outbound stream delivery. This does not distinguish provider
delay from Worker CPU, storage gating or egress delay. A matched direct Node
control had completed-answer maximum gaps of 126/194/107 ms, but itself hit
its 50-second harness deadline waiting for the final answer's silent-tail
boundary; retain that incomplete segment and close code 1005. Neither run is
a clean end-to-end performance proof. Evidence:
`hosted-continuous-audio-pinned-snapshot-clean.json`,
`pinned-snapshot-answer-stage-metrics.json`, and
`direct-continuous-audio-20260914-current{,-metrics}.json`.

An eight-call alternating setup-route control used one authenticated socket,
fresh hosted paths and the exact installed source/props for both routes.
Mounted acceptance times were **4,485 / 3,851 / 1,833 / 1,812 ms**; direct
`workers.get(ref).setupVoiceAgent` times were **2,317 / 2,459 / 1,670 / 1,797 ms**.
All eight produced audio without diagnostics, closing the socket with 1000.
Excluding only the retained initial cold mounted sample, median setup was
1,251 ms mounted versus 1,413 ms direct. Provider handshakes ranged from
881 to 3,268 ms. This shows no consistent gain from bypassing the mounted
capability; keep the existing interface. Raw samples and exact reference are
in `setup-route-control.json`.

Current-head CI also retained a native storage reset on **Preview 5**, version
`079a3c42-4068-465c-8ff6-14799064e0fe`. ITX `Stream.append` call
`log_b1edabec50b04621b01622ac9c8d569f` failed in 857 ms; the concurrent native
Feed alarm reported references `104jd2la0q85fsj9vjfdvmlt` and
`2ipt9jh9fl6v4rr6hvoluda4` in trace
`5333052a7aad37b25fead9bea5917324`. This is not evidence that the repo change
fixed the source-version test: its expected-flake wrapper already accepts a
passing body and reports unexpected failures as `Expect test to fail`.
Keep the existing expectations and investigate the reset. These traces do
not identify its cause or establish a hosted-placement regression. Raw
evidence is `c503-storage-reset-{observability,traces}-raw.json`.

A subsequent four-call mic/filler control acknowledged 201/1/201/1 client
mic appends and terminated all calls normally on one socket (close 1000).
Single-frame arms used the processor's existing silence filler for the
remaining 20-second input window, without input-clock-debt failures. Gaps
remained in both modes; continuous-mic answers lasted 21.3/23.3 seconds while
filler arms split into several shorter answers, with possible final-segment
truncation at teardown. Do not pool those unequal answers or attribute the
gaps specifically to SQLite. Evidence is
`hosted-mic-fill-control-actual-20260914{,-stage-metrics}.json`. The earlier
`run-20260914.json` contains only four harness prefix-validation failures,
with no setup or provider calls; it is not an audio control.

Runtime `85f8e58c1` starts the immutable artifact cache write before returning
the compiled artifact, without awaiting its completion. Same-key callers still
share the coordinator's in-memory result. Cache-write errors are logged once;
interrupted persistence can require a later rebuild from the authoritative
source. Source failures and durable queued-build ownership remain unchanged.
The coordinator's settled duration now excludes cache persistence: a reduction
in that metric alone is not a compilation speedup. Separate phase logs record
cache read, source snapshot, compilation and cache-write elapsed times. Workers
[timers advance on I/O](https://developers.cloudflare.com/workers/runtime-apis/performance/),
so these are I/O-bounded phase measurements, not isolated CPU profiles.
All 31 focused worker tests and app typecheck pass. Claude Fable 5.1 xhigh
reviewed that exact commit and found no concrete correctness issue; its review
did not run tests or claim preview proof.

Preview version `a40c2411-887e-4bcc-a579-d95ac6964052`, still on SDK pin
`055337b`, passed deployment smokes. The repeated three-row forced-cold
control succeeded before and after (both sockets closed 1000):

| Measurement (ms), three samples | Before background persistence | After                      |
| ------------------------------- | ----------------------------- | -------------------------- |
| Full health call                | 10,356 / 6,044 / 7,282        | 8,134 / 5,604 / 5,870      |
| Coordinator settlement          | 6,105 / 3,703 / 5,181         | 2,473 / 2,034 / 2,139      |
| Cache write                     | 1,404 / 2,183 / 1,579         | 2,345 / unobserved / 1,776 |
| Source snapshot phase           | not instrumented              | 253 / 41 / 48              |
| Compilation phase               | not instrumented              | 2,210 / 1,985 / 2,086      |

Median full health-call time changed from 7.28 to 5.87 seconds. n=3 and
variable source/compilation/cache timing limit causal attribution. The second
after-row lacks a cache-completion log and native invocation span even in the
extended query; an independent KV read verified its matching 1,138,058-byte
artifact exists. Do not infer a lost write from missing telemetry, or claim
the missing continuation's cause is known. Artifacts are
`cold-build-background-cache-{before,after}{,-analysis}.json`; after trace
`f4a931bb1f88f25605043ac3368ee4d2` carries the measured phases.

The following five fresh hosted voice calls all produced audio without
diagnostics and closed their shared socket with 1000. Acceptance was
**5,800 / 1,817 / 2,534 / 1,934 / 1,901 ms**, with first PCM at
**7,139 / 2,781 / 3,519 / 2,906 / 2,987 ms**. Retain the first cold call;
the remaining median acceptance is 1,918 ms, still materially above the
direct Node baseline. This control follows the forced-cold health experiment,
so it is a first voice call after deployment, not the deployment's first
request. Evidence is `hosted-background-cache-startup-control.json`.
Every CI check passed on runtime commit `85f8e58c1`; this does not resolve the
earlier storage faults or complete sustained-audio performance proof.

A refreshed direct Node control at 19:17 UTC used the current 2,125-byte
instructions, `gpt-live-1`/`marin`, 16 kHz PCM, and `Say: ready.` commentary.
All five calls reached session readiness and audible PCM: median readiness
**994 ms** (821–1,376), first non-silent PCM **1,905 ms** (1,711–2,218), and
readiness-to-PCM **890 ms**. It intentionally closes after first audio; close
1005 is its no-status close, not a handshake timeout. This measures decoded
audio availability, not acoustic speaker onset. The Doppler `os/prd` API key
has not been verified as the same account/key as the preview project's
secret. Evidence: `direct-current-ready-20260914/summary.json`.

A temporary console-only facet phase probe produced no usable diagnostic
records. Its first fresh stream timed out before acceptance; four subsequent
calls reached audio. The missing logs provide no phase attribution. The
ordinary source was freshly reinstalled and mounted at `6c3725bf5d16…`,
preserving exact-head snapshot eligibility rather than remounting a historical
pin. Artifacts: `facet-ready-phases-{install,restore}.json`,
`facet-ready-phases-audio-control.log`, and `facet-ready-phases-logs.json`.

Runtime `14056353a` uses native RPC promise pipelining for Project and Secret
processor-facade reads. It sends facade selection and its read together,
preserving strict catch-up, policy/grant checks, unborn-secret handling and
disposal. The patch changes two files (14 additions, 12 deletions); 113 relevant
tests and app typecheck passed, with one existing expected failure. Preview
version `5d901237-f837-4d3a-9870-1db87a02e9a3` passed deployment smokes with
the same SDK pin `055337b`.

A temporary source probe returned phase durations in the existing acceptance
payload and one declared diagnostic event appended after acceptance persisted.
Native before/after runs kept identical pinned voice source `3a7e5cf1abb5…`,
scenario and SDK. Each arm used one project WebSocket and five new hosted
streams; both sockets closed 1000. Four calls per arm reached audio. BEFORE's
first stream timed out before acceptance. AFTER's first accepted at **8,793 ms**,
leaving only 829 ms after commentary acknowledgement before the overall
10-second deadline; it failed the first-audio deadline. Neither is excluded
from the raw results or treated as an audio success.

| Median over the four subsequent calls, ms | Before | After |
| ----------------------------------------- | -----: | ----: |
| Client readiness                          |  1,857 | 1,767 |
| Facet provider dial to session readiness  |    977 |   973 |
| Facet acceptance append completion        |    129 |   125 |

This small comparison does **not** establish an end-to-end latency improvement
from pipelining. On the facet clock, acceptance append started in the same
millisecond as `session.started` in every recorded row. Its await took
103–420 ms before and 98–163 ms in the four warm after calls. These durations
do not localize the remaining client-visible delay to any one actor.
The rendered instructions were 2,096 bytes (`Speak supplied commentary briefly.`
plus the standard policy), so this is not an exact prompt match to the refreshed
2,125-byte direct Node control above.

BEFORE's failed stream has a durable benchmark terminal event at offset 20,
after configuration and call-started at offsets 12/13. That proves terminal
append, not the cause of the missing provider response. Fresh uninstrumented
source was restored at pin `acde9d3bb139…`, mounted offset 790, with the original
source bytes verified. Raw evidence is `facet-ready-payload-{before,after}.log`,
their `-phase-table` artifacts, the scenario fingerprint and restore JSON.
The diagnostic event and instrumentation are excluded from the runtime diff.

The subsequent exact-prompt direct control verified the same 2,096-byte
instruction hash (`191ca6ff…a80c1b89`) before dialing. All five calls reached
readiness and non-silent PCM. Median readiness was **903 ms** (833–1,625),
first PCM **1,837 ms** (1,649–2,425); the first sample was 1,242/2,060 ms.
All five intentionally closed with no status (1005), with no provider errors.
The key/account-equivalence limitation remains. Evidence:
`direct-exact-ready-2096-20260914/summary.json`.

Every CI check passed on runtime `14056353a`. The complete Preview CI log
independently confirms actual passes for path-addressed secret substitution,
the in-flight secret-refresh race, and enrolled approval keys; these are not
expected-failure wrappers. A manual filtered invocation lost its tool session
handle, so it supplies no aggregate proof. CI completed 59 files with 216
passes, 10 expected failures and 4 skips, and all five preview apps passed.
The log has no unexpected native storage reset or network-close diagnostics.
Retain one retried Playwright tree-visibility assertion and the **247.2 s** OS
E2E duration, **147.2 s** over budget. Raw log:
`depot-kzstmfpdtz-d30pw91t7d.log`.

A temporary native-only probe on version `362c71dd…` captured all five first
voice-facet wakes, with SDK `055337b` and uninstrumented voice pin `acde9d3b…`.
Four calls produced audio. The first reached client `call-started` only at
**9,620 ms**, then exceeded acceptance and cleanup-acknowledgement deadlines.
Its terminal event subsequently folded: snapshot offset 73 has `call: null`,
the activation in `recentEndedActivations`, and subscription lag zero with no
error. The connection-runtime API's null result alone does **not** prove a
facet or provider socket is absent; provider-side close was not observed.

| Native probe duration, ms                   |  01 |  02 |  03 |  04 |  05 |
| ------------------------------------------- | --: | --: | --: | --: | --: |
| Hosted watchdog acknowledgement             |  68 |  42 |  54 | 153 | 114 |
| Class preparation                           |  11 |   0 |   0 |   0 |   0 |
| First facet configure                       | 202 |   — | 216 | 159 | 153 |
| Facet wake RPC                              |  15 |  33 |  35 |  22 |  27 |
| Wake-work entry to receiver-wake resolution | 259 |  75 | 305 | 204 | 192 |

These rows are **not additive**. Other concurrent callers entered facet
configuration while the watchdog acknowledgement was pending: overlap was
26/130/102 ms in calls 01/04/05. Call 02 was already configured. Zero class
preparation means the Workers clock did not advance during that synchronous
work, not zero CPU work. Event-created-at to alarm-entry wall correlations
were 52/192/129/186/153 ms; keep them separate from the native phase clock.
The cold sample's main delay preceded the call-started append, not this
259-ms native wake. Raw evidence: `native-facet-delivery-phase-control.log`,
`native-facet-delivery-phase-observability-raw.json`, and the corrected summary
and failed-state artifacts. The diagnostic patch was removed and clean runtime
version `526f45e2-5708-4338-bded-7495393ff608` passed deployment smokes.

The cold sample's trace `ea494045447e4a26b89a9e3643cc8286` contains a fresh
`voice-agent.ts` build lasting **3.353 s** (bundler RPC 3.137 s), before the
call-started append. Its 1.664-second KV-put span is retained background work:
this deployment already includes `85f8e58c1`, and the enclosing RPC span's
longer lifetime does not establish when its caller resumed. The remaining
pre-append delay is unsegmented. Evidence:
`native-precall-310992b0-attribution.md` and its raw trace artifacts.

Fable's additional review proposed overlapping watchdog persistence and facet
configuration, but the probe already observes that overlap in several calls;
its possible gain needs a narrower control. Its per-isolate bundle-size idea is tested below; latency attribution
remains incomplete. A proposed RPC-future disposal concern was checked directly
in Preview 17: native `env.ITX.get()` reports `Symbol.dispose in future` true,
the member is callable, and explicit disposal succeeds after a benign read.
Evidence: `native-itx-dispose-probe-result.json`. No authority relaxation or
new delivery scheduler was adopted from the review.

## Minification control and manifest SQL failure (Sep 14)

The first A/B/A attempt used native version
`526f45e2-5708-4338-bded-7495393ff608`, SDK `055337b142`, the same
2,096-byte prompt and five fresh hosted conversations per arm. Root worker
health prewarming happened outside each arm's timings. A and B each completed
five calls with audio and no call errors; all receiver refs independently
confirmed their expected `minify` setting. A2 did not run: restoring its source
failed, as did one bounded restoration attempt. The project remained mounted
to B. This is an **incomplete A/B/A**, not a demonstrated latency improvement.

| Measurement                                    | A, unminified | B, minified |
| ---------------------------------------------- | ------------: | ----------: |
| Worker module bytes                            |     1,075,714 |     614,784 |
| Serialized KV artifact bytes                   |     1,138,022 |     649,579 |
| First call accepted, ms                        |         6,471 |       8,203 |
| Remaining four accepted median, ms             |       2,033.5 |     1,868.5 |
| Remaining four provider-handshake median, ms   |         1,039 |       917.5 |
| Remaining four first non-silent PCM median, ms |       3,071.5 |       2,875 |

Module size fell 42.849%, independently of timing. Most of the small warm
readiness difference coincides with provider-handshake variance; neither that
nor the single cache-write duration per arm establishes a latency gain.
Evidence: `minify-aba-results/`, `minify-ab-artifact-traces.json`, and
`minify-aba-derived.json` under the temporary proof directory.

Restoration exposed a native repository defect: manifest queries chunked 100
paths but also bound the branch, exceeding Durable Object SQLite's
[100-variable limit](https://developers.cloudflare.com/durable-objects/platform/limits/).
Failure logs `log_79117fb8bec54e3f96c360e47085f59b` and
`log_d6279af114d54e208dba348d199d7cee` report `too many SQL variables`.
Commit `58c49b522` reserves one binding for the branch in manifest reads and
removals; OID-only batches remain 100. Regression tests enforce the remote
limit while reading 100 paths and removing 101. All 35 focused tests and the
full OS typecheck pass. Native preview version
`3e4b707a-0cf1-48bb-bb40-3e3112ad0ab8` passed deployment smokes and restored
the unminified root at offset 983, pinned to current repo head
`e88da8aa4f6be6a5de244f1479adaccf5d24149d`. Its source install reported no
new change: the earlier failed operation had already committed the source,
but had not mounted it. The successful recovery proves the previously failing
read path with the existing repository size. Evidence:
`deploy-sql-binding-fix.log` and `minify-aba-post-sql-fix-restore.json`.

## Completed minification A/B/A after the SQL fix

The repeat used the same fixed native version and SDK for all three arms,
with fresh source directories and five fresh hosted child streams each. All
**15/15** calls returned non-silent PCM before the deadline, with no recorded
call errors. Root prewarming remained outside the measured call. Local source
checks and every receiver ref confirm A/A2 unminified and B minified.

| Measurement, ms                      |       A | B, minified |      A2 |
| ------------------------------------ | ------: | ----------: | ------: |
| First call accepted                  |   5,705 |       6,402 |   5,563 |
| First call handshake interval        |   1,806 |       5,097 |   2,482 |
| First call non-silent PCM            |   6,629 |       7,470 |   6,593 |
| Remaining four accepted median       | 1,883.5 |     1,920.5 | 1,812.5 |
| Remaining four handshake median      |     919 |         988 |   846.5 |
| Remaining four non-silent PCM median |   2,865 |       3,049 |   2,875 |

**No warm-start latency benefit is established.** B was slightly slower than
both controls for readiness and PCM. The independently proven bundle-size
reduction remains valid, but minification is not adopted in this PR. B's
5.097-second handshake outlier is retained: this interval includes platform
egress and provider session establishment, not pure OpenAI latency. A simple
subtraction from client readiness is not an independently measured native
phase or a causal overhead estimate.

The final A2 baseline is mounted at root offset 1093, pinned to current repo
head `697b132af26cc88f996de0aa0bfc0cba63027ff2`; its root and all five receiver
refs have minification absent/false. A separate post-run read verifies the
mount and repository head. Evidence: `minify-aba-repeat-results/summary.json`,
all arm logs and receiver records, and `minify-aba-repeat-mounted-state.json`.
The failed first attempt remains separately preserved.

## B's handshake outlier: project policy refresh

Trace `d7fea57dd6f2dc5688c41fd28655c283` narrows the retained B first-call
handshake outlier. Its ProjectDO egress request lasted 4,535 ms. A nested
root processor-facade invocation lasted 3,944 ms and ended shortly before the
473-ms SecretDO fetch began. The source awaits the project policy snapshot
before entering SecretDO egress. Together, the ordering and source localize
the delay to policy refresh; exact caller-resume markers are still required
to equate the whole RPC lifetime with foreground wait.

That root invocation contains a default project-worker build: 134 ms repo
snapshot plus 2,579 ms compilation, settling in 2,713 ms. Config-source
installation changes the whole repository build key even if `worker.ts`
bytes are unchanged. The ProjectProcessor config-commit handler waits for
default worker readiness while processor work is blocked. This is a cost of
the first call after a config change, distinct from an ordinary fresh stream
with unchanged installed source. It is not evidence of a five-second OpenAI
connection. The remaining SecretDO duration cannot be split into secret
preparation and upstream fetch using this retained trace.

Evidence: `minify-b-outlier-telemetry.json` and
`minify-b-outlier-full-trace.json`. Do not weaken build-cache correctness or
policy freshness to remove this wait.

## Setup source-resolution and guest phase probe

A temporary native/guest probe split setup without extra events or RPCs. Its
first harness attempt lost its client result to a missing cleanup import;
that artifact remains separate. Native evidence still records 5,003 ms source
resolution and 6,541 ms guest execution. Durable inspection found terminal
offset 20, no active call, the activation in the ended set, and subscription
lag zero at offset 72. This proves the terminal fold, not provider-side close.
The harness was corrected and its actual copied runner/wrapper typechecked.

The second run used an explicit **20-second observation window**, retaining
the ordinary 10-second budget as the acceptance criterion. All five calls
returned audio without recorded errors, but the first is an original-budget
failure: accepted at **10,608 ms**, first non-silent PCM at **11,509 ms**. Four
warm calls had median readiness **2,012 ms** and PCM **3,018.5 ms**. No root
health prewarming preceded these calls.

Native ProcessorFacet timings for the cold call are 8,164 ms inside source
resolution before loader acquisition and 3,183 ms in the guest RPC, totaling
11,347 ms. The four warm source-resolution segments show no clock advance;
synchronous CPU may still consume time. The cold 8,164-ms interval needs
further subdivision using its retained build trace.

The guest's independent cold clock shows:

| Guest operation            | Start, ms | End, ms |
| -------------------------- | --------: | ------: |
| Entrypoint ITX await       |         0 |       0 |
| Initial voice append       |         0 |     111 |
| Voice subscription barrier |       111 |     661 |
| Secret validation          |         0 |   1,189 |
| Agent create               |     1,189 |   2,327 |
| Agent append               |     2,327 |   3,055 |
| Backend-ready append       |     3,055 |   3,183 |

Voice and Agent lanes overlap. Agent create/append dominate **setup RPC
completion**, but do not gate the initial provider dial; backend readiness
only gates delegation forwarding. Do not infer an Agent readiness bottleneck
from this table or combine native/guest timestamps as one clock.

All temporary native code was removed. Clean preview version
`656f50f7-3f0c-4e3b-8207-963aeefe1c96` passed deployment smokes. Original voice
bytes were restored at mount offset 1247, pinned to
`2ea818d217c0f03f4e8eb36ed5353e641d5675bf`; probe marker absent. Evidence:
`setup-probe-v2-results/phase-summary.json`, its raw startup/restore files,
`clean-cold-workers-setup-probe-v2-voice startup setup dispatch.json`, and
`deploy-setup-phase-restore.log`. The failed first attempt and terminal audit
are in `setup-probe-results/` and `setup-probe-first-attempt-failed-state.json`.

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
