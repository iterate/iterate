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
only for dashboard requests. The separately tested minification experiment was
removed after it showed no startup benefit.

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

**Measurement correction (15 September):** earlier CLI runs awaited WebSocket
open but left authentication and project lookup pipelined. Their first timed
call can include that unfinished work; descriptions of those first rows as
“cold” do not isolate voice startup. Raw samples remain intact. Subsequent rows
reuse resolved authentication. The corrected comparison below explicitly
awaits project identity before every batch, without opening a voice worker or
creating a conversation, and reports connection setup separately. Direct Node
provider measurements do not use this project-client boundary.

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
synchronous CPU may still consume time. The full trace was subsequently retrieved in 35 bounded pages (2,227
unique spans). The caller's artifact KV lookup took 25 ms. Its voice build
recorded 221 ms source snapshot and 3,249 ms compilation; the coordinator
invocation continued through a 1,767-ms background KV put. The subsequent controlled-delay experiment below rules out that
background persistence as a caller-response gate. The overlapping 2,221-ms default-worker build cannot
be subtracted from this caller's 8,164 ms without a dependency proof.
Evidence: `setup-probe-v2-first-resolve-attribution.md` and its paged traces.

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

## Controlled cache-persistence response boundary

Preview version `26828627-7a93-4b37-bcab-ee891f51af47` temporarily instrumented
two exact voice entrypoints. The delayed variant inserted a **10-second wait
before KV persistence**, inside the existing background promise. A/B/A used
the same full voice source and SDK `055337b`; each fresh source pin was
mounted before timing `itx.voice.health()`. No OpenAI sessions were created.

| Measurement, ms                  |     A | B, delayed persistence |    A2 |
| -------------------------------- | ----: | ---------------------: | ----: |
| Client health response           | 7,357 |                  6,147 | 5,126 |
| Caller artifact-cache lookup     |    43 |                     34 |    31 |
| Caller coordinator RPC await     | 5,389 |                  5,823 | 5,035 |
| Overall native source resolution | 5,432 |                  5,857 | 5,066 |

B's caller received the artifact, completed memoization, and disposed the
RPC result at `20:41:13.059Z`. Its deliberate cache delay was released at
`20:41:21.145Z`, and persistence completed 547 ms later. **Background cache
persistence does not gate this caller response.** The ordinary RPC span
lasting through a cache write is insufficient evidence to claim otherwise.
This agrees with Cloudflare's [Durable Object state documentation](https://developers.cloudflare.com/durable-objects/api/state/).

The B coordinator's own build work lasted 2,079 ms (28 cache read, 138 source
snapshot, 1,913 compiler call), while the caller awaited its RPC for 5,823 ms.
The remaining difference needs dispatch/materialization and artifact-transfer
attribution; it is not all compiler CPU. Memoization/disposal showed no
Workers-clock advance, which does not prove zero CPU.

The temporary probe passed 17 focused build tests and OS typecheck. Original
voice source was restored at offset 1302, pin
`f26f59616e20770b82c3e790240bc1fa74334365`, then clean native version
`dcd6eb90-0ba7-4706-b8d6-2308fe5e3e87` passed deployment smokes. Evidence:
`cache-response-boundary-results/`, the `cache-boundary-*` telemetry queries,
`cache-boundary-native-applied.patch`, and `deploy-cache-boundary-restore.log`.
The patch is not part of the PR.

## Controlled coordinator bypass

Preview version `9fd7a021-1715-409d-a7e8-7cb7ceec3b92` compared fresh full-source
builds through the usual coordinator with an exact-entrypoint direct build in
the caller. SDK `055337b` and voice source bytes stayed constant. Both paths
retained the caller KV read, second cache read, source snapshot, compiler RPC,
and artifact shaping. The direct path deliberately omitted persistence,
coalescing, caller budgets, and durable queuing. This is a lower-bound
experiment, not a proposed production implementation. No OpenAI sessions ran.

| Measurement, ms                      | A, coordinator | B, direct | A2, coordinator |
| ------------------------------------ | -------------: | --------: | --------------: |
| Client health response               |          7,151 |     5,092 |           7,000 |
| Native source resolution             |          5,309 |     2,706 |           6,975 |
| Caller artifact-cache lookup         |             87 |        37 |             105 |
| Coordinator RPC / direct build await |          5,222 |     2,669 |           6,870 |
| Build's second cache read            |              4 |         4 |               4 |
| Source snapshot                      |            228 |       114 |             119 |
| Compiler call                        |          2,339 |     2,551 |           3,351 |

The direct result localizes a substantial cost to the coordinated path, while
its compiler call remains comparable to the controls. It does not identify the
entire difference as network transfer: native actor activation, placement,
scheduling, and moving the artifact may contribute. Client health also includes
work outside native source resolution; those intervals varied across arms.
One B sample cannot establish a distribution or a safe production design.

All three health responses succeeded. The direct persistence-skipped record
and its phase log came from the same root `ProcessorFacet` parent as the loader;
the control builds came from separate coordinator Durable Objects. Fresh source
pins prevented an artifact cache hit. The ordinary voice source was restored
at offset 1348, pin `ebb0a42dc2b1a44ae5cee36f87eee448a914b664`, with a successful
health response. Temporary native code passed 20 focused tests and full OS
typecheck, then was removed. Clean native version
`0d77628f-725c-4d87-8e61-ea61c5084dd2` passed deployment smokes. Evidence: `direct-boundary-results/phase-summary.json`,
its raw arm/restore files, `clean-cold-workers-direct-boundary-*`, and
`direct-boundary-native-applied.patch`.

## Same-credential native-host transport control

The next direct Node run and Preview 17 `/secrets/openai` used the same
in-memory credential, with no credential or fingerprint written to the proof
artifacts. The secret update is offset 295. Five direct calls all returned
audio: median readiness **1,095 ms**, first non-silent PCM **1,787 ms**.
This resolves credential equivalence for this comparison, not older controls.

Temporary version `04b409ff-96f3-4861-9386-208f2fb21131` added an admin-only native
facet on the actual hosted StreamDO parent. It used normal project egress,
policy, secret substitution and audit, with no voice/Agent processor setup.
Five native controls alternated with five real fresh hosted conversations on
one existing project WebSocket. All real sessions' configured prompt hashes
matched the native/Node 2,096-byte prompt. Model, voice, initial 100-ms PCM input,
and commentary also matched. The original short persona was retained in real
setup; supplying the compiled prompt as a persona would duplicate policy.

| Measurement                           | Result                                                      |
| ------------------------------------- | ----------------------------------------------------------- |
| Native session readiness, five calls  | median 954 ms; 885–1,202 ms                                 |
| Native audio                          | 4/5; successful PCM median 1,821 ms; fifth hit 10s deadline |
| Real hosted audio                     | 5/5; no recorded call errors                                |
| Real hosted warm readiness, calls 2–5 | median 1,825 ms                                             |
| Real hosted warm PCM, calls 2–5       | median 2,866.5 ms                                           |
| First real hosted call                | ready 3,963 ms; PCM 5,022 ms                                |

Native timings begin inside the facet; real readiness is observed at the
client and includes setup and event delivery. Their difference is not an exact
attribution to any one operation. A native preflight is retained separately:
ready 2,304 ms, PCM 2,989 ms. No acoustic-onset measurement was made.

The fifth native control reached `session.started` at 961 ms, but recorded no
non-silent PCM. Its deadline and close code 1006 occurred at 10,000 ms. The
probe's fetch-abort deadline and session deadline coincide, so the cause of
that close is ambiguous. Its ProjectDO fetch outcome was `canceled`, whereas
the four successful controls were `ok`; the fetch had already returned before
`session.started`. Current records lack frame counters, so neither OpenAI
silence nor post-upgrade message loss is established. This sample remains a
failure, not an excluded outlier. The targeted host-error query returned zero
records over the paired interval; that does not explain the silent sample.

All five real conversations subsequently had `call: null`, their activation
in `recentEndedActivations`, no pending delegations, subscription lag zero,
and no last subscription error. Their client WebSocket closed with code 1000.
These are durable terminal-state checks, not proof of a remote socket close.

The temporary native code passed OS typecheck and 11 routing/alarm tests. It
and the local paired-startup helper were removed. Clean version
`8f2098ee-985b-4aa7-a51e-1d83a7387c5e` passed deployment smokes. Source remains
pinned to `ebb0a42dc2b1a44ae5cee36f87eee448a914b664`. Evidence:
`direct-same-key-20260914/`, `native-warm-host-paired-control-result.json`, its
full log, `native-warm-host-preflight.json`, `native-warm-hosted-terminal-audit.json`,
and `clean-cold-workers-native-warm-*`. Two read-only harness failures (Node
import and property-proxy disposal) are retained separately; corrected runs
passed. No diagnostic code is part of the PR.

## Further review and smaller controls

Claude Fable 5.1 at xhigh reviewed the latest cold-build boundaries. Its useful
next direction is to enqueue builds when mounted source/deployment keys change,
preserving global coordination while moving compilation off call startup. This
is a proposal, not a measured improvement. Precreating the next conversation
would move work outside the requested button-press measurement, so that idea
is excluded. Making acceptance ephemeral also needs a separate reconnect and
delivery contract review before adoption.

A richer native transport probe on version
`1287d3e7-5ddf-4805-8523-26a96e445cbf` alternated retained-fetch-timeout and
clear-timeout-after-upgrade controls. All ten produced audible PCM with no
parse errors, send failures, aborts, or missed input-fill ticks. The first cold
call took 4,328 ms to readiness; the following nine took 770–1,173 ms. Neither
arm reproduced the earlier silent call, so that failure remains unexplained.
Targeted hosted-parent and ProjectDO error queries returned zero records for
this interval. Evidence: `native-warm-host-counter-control-result.json` and
`clean-cold-workers-native-counter-*`.

A separate native RPC primitive control ran ten alternating serial/pipelined
pairs of `ITX.get()` plus one public `getEvents({ limit: 1 })` on an existing
hosted child. Median operation time was **12.5 / 11 ms**; all arms succeeded.
The initial warmup was separately retained at 1,009 ms. Pipelining is supported
in the deployed runtime, but this small warm difference does not explain the
remaining startup gap. The SDK patch remains isolated. Evidence:
`itx-self-stream-pipeline-control-result.json`; its ownership/error tests passed
3/3. The earlier native transport probes are removed from local source.

## Actual native voice processor comparison

Preview version `5ea40972-1924-4a8a-a1e7-5ed0bb5164db` temporarily selected the
unchanged `VoiceAgentProcessor` as a native facet for one reserved prefix.
Five native calls alternated with five ordinary dynamic calls on one project
WebSocket, using the same installed setup, fresh paths, events, scoped egress,
secret and exact prompt. Runtime build identities verified the intended
placement in every call; this was not the earlier bare transport control.

All ten produced non-silent PCM within the 10-second budget. Across all five
calls per arm, median client readiness was **1,906 ms native / 1,973 ms dynamic**.
The first native call retained the deployment cold start: ready **7,346 ms**,
PCM **8,217 ms**. Across the subsequent four calls in each arm, readiness was
**1,846.5 / 1,857 ms**, handshake **868 / 845.5 ms**, and first PCM
**2,865 / 3,054 ms**. This does not establish a warm readiness improvement from
native hosting. These client measurements use the same clock boundary; the
provider handshake is reported separately, not subtracted across actors.

All ten had terminal call state and matching ended activations. One initial
subscription description reported lag 69 despite a concurrent terminal
snapshot; a bounded follow-up read showed all ten at zero lag and no last
error. These are separate checkpoints: `describe()` reads the source stream
row, while the snapshot reads the facet fold. Settled hosted callback batches
do not themselves advance the source cursor; a later checkpoint report or
teardown does. The exact advancement trigger in this sample is unobserved.
Both raw reads are retained; their difference is not a measured lost event. The project
WebSocket closed with code 1000. Targeted parent and ProjectDO error queries
returned no records over the call interval. Neither query proves the absence
of failures elsewhere.

The adapter's four selection tests and OS typecheck passed. The temporary
adapter and local benchmark helper are removed from source; the SDK experiment
also remains excluded. Evidence: `native-voice-processor-ab-result.json`, its
log, `native-voice-processor-terminal-audit{,-followup}.json`, and
`clean-cold-workers-native-processor-ab-*`. Source remained pinned to
`ebb0a42dc2b1a44ae5cee36f87eee448a914b664`, SDK `055337b`, secret offset 295. Clean version `09b2bbf8-6bb9-45cd-ad2f-1526a8e52806`
passed deployment smokes after removal. No production deployment or device
flash occurred.

## Shared build host control (excluded)

A preview-only coordinator host reused one native Durable Object with a facet
per build key. Ten alternating uncached builds used the same full voice source
and SDK pin, adding a different unimported file to force each cache miss.
Every result produced exactly 1,075,589 module bytes with the same SHA-256
`1949d8caf5a43e13634cfc66f9d983cf42fbdc86a3f27a4b08ed4511ba94570c`.

| Pair | Native build RPC (ms) | Hosted build RPC (ms) |
| ---- | --------------------: | --------------------: |
| 1    |                 4,266 |                 5,538 |
| 2    |                 3,844 |                 2,089 |
| 3    |                 4,397 |                 2,236 |
| 4    |                 4,388 |                 2,168 |
| 5    |                 3,539 |                 2,081 |

All-five medians were 4,266 / 2,168 ms; the subsequent four per arm were
4,116 / 2,128.5 ms. The first cold hosted request remains included. These are
caller-clock build RPC durations, not call readiness or OpenAI latency.
Coordinator-local build durations also varied (native 710–2,197 ms; hosted
622–2,345 ms), so the full difference cannot be attributed to actor activation.
All ten returned success. The bounded coordinator query returned 40 untruncated
records, including ten successful starts/settlements and no failed outcomes.

Adversarial source review rejected the implementation: hosted facets remain
resident until explicitly aborted, retaining approximately 1 MB per completed
key; queued child work lacks a safe durable handoff to the parent alarm; and
repeated enqueues reset the per-key retry budget. The diagnostic route and
shared-host implementation were removed rather than expanding this PR with a
new build lifecycle. The smaller follow-up prewarms the installed pinned voice
worker through its existing health RPC, outside conversation startup.

Evidence: `worker-build-host-control-result.json`,
`clean-cold-workers-host-control-worker-build.json`, and the archived
`worker-build-host-reviewed-experiment.patch` under `/tmp/voice-startup-pr`.
Experimental version `47368745-a2aa-4305-81a6-623382ba9024` ran at
22:04:10–22:04:47 UTC on 2026-09-14. No OpenAI request or project config change
was part of this build control. Clean restore version
`88599b3b-8993-4ab0-ab94-98c4b5840156` passed all deployment smokes.

## Installer prewarm

`voicelab deploy` now calls the existing health RPC on the exact installed
entrypoint after installation and optional legacy pruning. It reports an
explicit post-install failure if warmup fails, without rolling back the commit.
It creates no voice stream and starts no provider session. This does not yet
prebuild arbitrary worker refs changed through other config editing paths.

On clean Preview 17 version `88599b3b-8993-4ab0-ab94-98c4b5840156`, a new project
`prj_7c1966fd12f940c0aa4070cbb3d1491d` installed voice package `055337b` at config
commit `8058498c1b4a77b79dbdea76934fa0ba85355d4b`. The first prewarm completed
in **5,887 ms**; an unchanged second deploy completed prewarm in **954 ms**.
Both returned build key
`217a3f8784d63bb5d7d01d705e41c15de2f6194011d87667396457059d0dbcab`.
Post-deploy audits asserted healthy worker identity and zero voice streams.
These are installer-health durations, not a first-call latency comparison.

Three focused tests cover pinned reference selection, the later pruning commit,
and explicit warmup failure with capability disposal. OS typecheck passed.
Evidence: `voicelab-deploy-prewarm-{first,second}.log` and
`voicelab-deploy-prewarm-audit.json` under `/tmp/voice-startup-pr`.

## Native delivery scheduling boundary

A temporary Preview 17 probe measured one child StreamDO clock from entry to
its public setup append through receiver selection and wake RPC. Its synchronous
row writes and first receiver selection were at 0 ms in all five calls. Starting
the wake RPC took 191 / 245 / 271 / 138 / 143 ms; obtaining its callback took
482 / 293 / 327 / 313 / 284 ms. The interval includes alarm scheduling and the
hosted watchdog acknowledgement. Returning a callback does not establish that
its first event batch has been processed. Client ingress and other actors are
outside this clock.

The five real calls all returned audio. Readiness was 3,730 / 1,563 / 1,606 /
1,521 / 1,655 ms; the first cold sample remains included. All five had terminal
call state, matching ended activations, no pending delegations, zero subscription
lag, and no last error. The exact prompt hash, source pin and dynamic runtime
identity matched the previous controls. Targeted parent and ProjectDO error
queries returned no records. Evidence: `native-delivery-phases-v2-result.json`,
its terminal audit, and the 53 untruncated `delivery-v2-complete` probe records.
Version: `3f0ee4e2-e12a-47cf-8ff2-e3ca83333ae7`.

An initial harness attempt used removed helper options and therefore created
five ordinary-placement paths instead of the reserved probe paths. Those calls
returned audio, but the harness assertion failed and supplied no valid probe
comparison. The full log and recovered rows are retained in
`native-delivery-phases.log` and `native-delivery-harness-mismatch-recovered.json`.

## Initial eager delivery control (excluded)

A second temporary version, `79abef90-7fb0-4caf-9937-e1948022117e`, alternated
five eager and five ordinary scheduled calls. Only the initial public setup
append could start its work immediately after arming the existing alarm. The
pending-alarm marker, watchdog, hosted alarm acknowledgement and ordinary
callback-append boundary remained in place.

All ten returned audio and ended with matching terminal activations and zero
subscription lag. There was no observed deadlock in these calls. Later-four
readiness medians were **1,889 ms eager / 1,850 ms scheduled**; all-five medians
were **1,916 / 1,812 ms**. The first eager call took 5,808 ms to readiness and
7,053 ms to first PCM. One scheduled call had readiness at 1,888 ms but first
PCM at 5,654 ms. Its retained transcript timing and durable events do not locate
that extra audio delay. That subsequent read used the default durable-only
filter, so it provides no evidence about ephemeral PCM delivery or retention.
This remains an unexplained sample, not attributed to OpenAI.

The eager control does not establish an end-to-end improvement and introduces
a callback-cycle risk that unit doubles cannot resolve. It was removed along
with the timing probe and temporary CLI helper. Its 103 focused tests and OS
typecheck passed. Parent and ProjectDO error queries found no records; a bounded
follow-up completed the initially delayed probe logs (90 untruncated records).
Evidence: `native-delivery-eager-result.json`, its terminal audit,
`delayed-first-pcm-event-times.json`, and `native-delivery-eager-applied.patch`.

A separate source review rejected ephemeral `conversation-accepted`: firmware
and CLI use that durable, replayable event to release opening microphone audio.
Changing its retention would require a new subscriber/reconnect contract.
Clean restore `db7657d5-0a30-48e5-80a0-510d5423ab98` passed all deployment smokes.

## Stateless setup root control (excluded)

A ten-call alternating control moved only `setupVoiceAgent` from its mounted
stateless worker to the native project RPC root. It used a fixture read from
exact deployed source commit `ebb0a42dc2b1a44ae5cee36f87eee448a914b664`;
all substantive source files were byte-identical to the checkout, and its
generated durable-worker key was retained. The voice facet, ordinary Agent
configuration, prompt and credential stayed the same. Static SDK imports were
resolved by the OS bundle in the native arm. This tests the setup root boundary,
not arbitrary equivalence between native and userspace packages.

All ten returned audio. Native readiness was 3,727 / 1,753 / 2,034 / 1,624 /
1,572 ms; dynamic readiness was 3,146 / 1,845 / 1,665 / 1,677 / 1,693 ms.
Later-four medians were **1,688.5 ms native / 1,685 ms dynamic**, with all-five
medians of 1,753 / 1,693 ms. This offers no established warm-call improvement;
the first cold samples remain included and do not establish a cold difference.

All ten initial voice batches and full Agent configuration sequences matched
after normalizing only stream paths and activation IDs. Each initial voice
batch was contiguous. Terminal audits found ended calls, matching activation
IDs, no pending delegations, zero subscription lag and no last error, with the
same dynamic voice runtime identity. Five native selection logs confirmed the
expected source, helper hash and deployment version. Targeted parent and
ProjectDO error queries returned no records. Six focused tests and OS typecheck
passed. The adapter, source fixture and CLI helper were removed.

Experiment version: `6cfb1b5f-722f-4327-bb0b-e152efd400d4`. Evidence:
`native-root-setup-result.json`, `native-root-setup-terminal-audit.json`,
`native-root-setup-semantic-proof.json` and the archived temporary sources under
`/tmp/voice-startup-pr`. This control did not change microphone gating; opening
PCM still waited for durable `conversation-accepted` at the client. Clean restore
`a5931082-83c8-4c76-8dec-7c6ca13dfef0` passed all deployment smokes.

## Egress policy overlap control (excluded)

A Preview 17 control started the existing ProjectDO policy read concurrently
with normal setup, inside the button timer. Both arms retained ordinary policy
matching, secret authorization and audit. Ten calls used counterbalanced pairs
and a six-second gap outside each timer to expire the unchanged five-second
policy cache. All five treatment prewarms refreshed policy before actual egress,
which then reported a cache hit. The ordinary requests refreshed policy in
34 / 32 / 27 / 29 / 28 ms. Fifteen untruncated records confirmed these outcomes.

All ten returned audio and ended cleanly, with zero subscription lag, no pending
delegations and unchanged runtime identity. Targeted parent and ProjectDO error
queries returned no records. Later-four readiness medians were **2,003 ms with
prewarm / 1,826.5 ms ordinary**; all-five medians were 2,079 / 1,846 ms. The
first prewarm call took 5,353 ms. A later prewarm call still took 3,902 ms,
including a 3,117 ms provider-handshake interval. No attribution within that
interval was established. The control removes the policy read from the actual
fetch path but offers no demonstrated readiness improvement, so it was removed.

Experiment version: `dc7bcdde-c19d-4d6e-90e9-6a2796e68063`. Seven guard tests,
21 egress tests (plus one previously expected failure), and OS typecheck passed.
Evidence under `/tmp/voice-startup-pr`: `policy-prewarm-result.json`,
`policy-prewarm-classified.json`, its terminal audit and
`policy-prewarm-applied.patch`. Clean restore
`92087858-1654-4e29-8ee8-3085797e3122` passed all deployment smokes.

A separate isolated microphone experiment passed delayed-wake ordering and
firmware terminal-fencing tests, but confirmed that early ephemeral opening PCM
can be lost if the source stream is evicted before delivery. It was not adopted:
it increases the loss window compared with retaining opening speech on the
device until durable acceptance. `heldMicFrames` is not a sequence receipt.
Evidence and patch: `/tmp/voice-early-mic-proof/README.md`.

## Initial callback and setup barrier controls (excluded)

A five-call phase probe used one source StreamDO clock from public append
through receiver wake, initial callback invocation and callback acknowledgement.
The existing initial watchdog barrier took 0 / 0 / 3 / 6 / 36 ms. The first
`created` callback took 29 / 219 / 45 / 32 / 22 ms to acknowledge. Subsequent
`configured` and `call-started` callbacks can overlap: the sender pipelines
later durable batches, so this is not three serialized acknowledgement trips.
The configured handler also appends passive Agent context before processing the
call. A concurrent setup `waitUntilProcessed` can drive the processor's own
catch-up read, making callback duration insufficient to attribute processing.
All five calls returned audio and ended cleanly; the first readiness sample
remained 4,639 ms. Version: `522f783d-7952-4475-ab55-86c6ceb32963`.

A separate 20-call counterbalanced factorial varied the first callback between
one event and the three contiguous setup events (bounded to 64 KiB), and varied
normal setup waiting against a diagnostic no-op of that wait. The latter is
not a valid implementation of the public wait contract and cannot ship.
Readiness still means observing durable `conversation-accepted`, never setup
RPC return. All calls used the same installed source, prompt and secret, one
established project WebSocket, and newly created conversation paths.

| Initial callback | Setup wait | Readiness samples (ms)                | Median (ms) | Calls with PCM |
| ---------------- | ---------- | ------------------------------------- | ----------- | -------------- |
| One event        | Normal     | 5,704 / 1,744 / 2,404 / 1,915 / 1,712 | 1,915       | 5/5            |
| Three events     | Normal     | 1,999 / 1,575 / 2,123 / 1,740 / 1,796 | 1,796       | 4/5            |
| One event        | Skipped    | 1,777 / 1,758 / 2,042 / 2,318 / 1,616 | 1,777       | 5/5            |
| Three events     | Skipped    | 1,670 / 1,834 / 1,526 / 1,761 / 1,588 | 1,670       | 5/5            |

The combined arm suggests a 245 ms median reduction, but **the run failed**:
`coalesced/barrier/16-9d2d2534` became ready at 1,740 ms and acknowledged the
commentary append at 2,000 ms, yet produced no non-silent PCM within the deadline
and no answer transcript. Cleanup ended it at approximately ten seconds. The
cause remains unexplained; neither delivery loss nor provider silence has been
established. Later explicit `includeEphemeral: true` reads returned no ephemeral
frames in any of the twenty calls, including the nineteen that returned audio.
Each read coincided with a second `stream/woken` event, confirming a fresh
incarnation with an empty memory-only ephemeral buffer. The read therefore
cannot establish where this call stopped producing audio.

Twenty untruncated phase records matched all paths and actual initial batch
contents; ten skip records matched exactly the intended arms. All had version
`70b4c505-438c-4b09-a0b5-9789fa51b85b`. Every terminal audit found a closed call,
matching activation, no pending delegations, zero subscription lag, no last error
and unchanged voice runtime identity. Targeted parent and ProjectDO error queries
returned no records. These checks do not explain the audio failure. All 133
focused sender/runner tests and OS typecheck passed. The controls and probes were
archived and removed; neither optimization is adopted. Clean restore
`40efb971-0200-4af2-a3b2-42a877118514` passed deployment smokes.

Evidence under `/tmp/voice-startup-pr`: `initial-batch-phase-result.json`,
`initial-batch-factorial-result.json`, `initial-batch-factorial-classified.json`,
`initial-batch-factorial-terminal-audit.json`,
`initial-batch-factorial-events-with-ephemeral.json`, and
`initial-batch-factorial-applied.patch`.

## Refreshed direct Node control before handshake overlap

A fresh five-call direct Node control at 23:43 UTC used the same in-memory
credential just written to the proof project's `/secrets/openai` (offset 514),
the same 2,096-byte prompt and `gpt-live-1` configuration. All five returned
non-silent PCM without errors. Upgrade timings were 1,326.866 / 502.261 /
485.859 / 431.128 / 421.243 ms; readiness was 1,894.238 / 1,003.203 / 1,227.651 /
715.828 / 746.835 ms. Medians were **485.859 ms to upgrade**, **1,003.203 ms
to `session.started`**, and **1,922.066 ms to received non-silent PCM**.
The first sample remains included. This is software receipt, not physical
speaker onset. Evidence: `/tmp/voice-startup-pr/direct-same-key-handshake-overlap/`.

## Provider upgrade overlap control (retained preview experiment)

After the authoritative `call-started` append commits, the source stream starts
one native ProjectDO registration before normal receiver delivery. The ProjectDO
opens the ordinary policy/SecretDO-backed provider upgrade and retains its
unaccepted 101 response. The unchanged voice facet's ordinary fetch claims that
response through the native fetch path; the facet still sends `session.start`,
the prompt, and all audio. No provider session or future conversation is opened
before the activation event. There is no second socket or polling.

This is a narrow control, not a production design: it accepts only Preview 17,
proof project `prj_56cbca83186a40019f5792b2463c81fa`, treatment paths under
`/agents/voice/startup-colocated/handshake-overlap/overlap/`, an empty egress
policy and no interceptor. Normal authorization, secret substitution and audit
still run. A treatment stream permits one activation for its durable lifetime,
so the unchanged fetch's trusted stream scope identifies its pending activation.
A claim can wait up to 250 ms for registration. Claim rights expire after ten
seconds; terminal events revoke them immediately. Pending operations remain
charged to the eight-upgrade cap until their actual egress settles, including
cancelled operations. Ready or late-arriving unclaimed sockets are closed.
An operation that never settles continues occupying capacity; new requests
then fail explicitly instead of allowing unbounded outstanding upgrades.
Failed/missing claims return a non-upgrade response instead of opening another
connection. These restrictions and the
native voice-specific commit hook must be reconsidered before production use.

Ten counterbalanced calls over one established project WebSocket all returned
non-silent PCM. Source commit `ebb0a42dc2b1a44ae5cee36f87eee448a914b664`, runtime
identity, prompt, and credential (secret offset 514) were unchanged between arms.
Each fresh path was created inside the timer. The first sample in each arm is
retained; the later-four view is shown separately, not substituted for it.

| Measurement                             | Ordinary                              | Upgrade overlap                       |
| --------------------------------------- | ------------------------------------- | ------------------------------------- |
| Readiness samples (ms)                  | 5,724 / 2,298 / 1,820 / 2,259 / 1,889 | 1,888 / 1,315 / 1,467 / 1,926 / 1,396 |
| All-five readiness median (ms)          | 2,259                                 | 1,467                                 |
| Later-four readiness median (ms)        | 2,074                                 | 1,431.5                               |
| All-five first received PCM median (ms) | 3,208                                 | 2,561                                 |
| Calls with PCM                          | 5/5                                   | 5/5                                   |

The same-credential direct Node control immediately above measured 1,003.203 ms
median readiness. The preview treatment therefore approaches that reference,
but does not eliminate the gap or prove physical speaker latency. The ordinary
voice facet's reported handshake interval starts at its own dial and excludes
the earlier prepared upgrade: its treatment median of 380 ms is **not** the
whole OpenAI setup time.

Twenty untruncated records on deployment `b0e5ea3e-0469-4514-86b6-fd3c813125f4`
matched exactly one registration, prepared upgrade, claim and cancellation for
each treatment path/activation; ordinary paths had none. The ProjectDO egress
intervals were 473 / 574 / 459 / 468 / 449 ms, including policy and secret work.
The already-open socket then waited 453 / 174 / 480 / 784 / 409 ms for its claim.
Those same-actor timings identify the next remaining opportunity: completing
voice processor startup earlier. Four claims had no local wait; one spent 23 ms
inside claim, which also rechecks policy. All cancellations reported zero
pending upgrades and registration waiters. Every terminal audit found a closed
call, matching activation, no delegations, zero subscription lag, no last error,
and the same voice runtime key. Targeted parent and ProjectDO error queries
returned no records. Earlier silent-call failures remain unresolved.

Validation: 115 focused tests passed, plus one previously expected failure, and
OS typecheck passed. Deployment smokes passed. Local same-DO workerd experiments
also proved delayed response handoff and both accept-then-close cleanup cases
(cancel before claim and cancel before upstream completion). Those local tests
are runtime-mechanics evidence, not a substitute for preview lifecycle proof.
The temporary CLI comparison helper is excluded from the branch.

Evidence under `/tmp/voice-startup-pr`: `handshake-overlap-result.json`,
`handshake-overlap-classified.json`, `handshake-overlap-terminal-audit.json`,
`handshake-overlap-preflight.json`, and `handshake-overlap-applied.patch`.
Local cleanup evidence: `/tmp/workerd-handshake-cleanup-20260915/result.json`.
This preview result does not authorize a production deployment or HAVPE flash.

## Authentication-resolved overlap comparison

The CLI now bounds and awaits `identity()` after socket open and before any
call timer. `connectItxReady` itself waits only for transport open: the owned
proxy hides `then`, so returning it does not await pipelined authentication or
`projects.get`. Identity resolves that chain through the project directory;
it does not pre-create the conversation or warm its voice processor.

On 15 September, 00:20:55–00:21:28 UTC, another ten counterbalanced calls used
Preview 17 version `1ab3c20c-6a29-4a7a-84f9-8df3ee0ff77c`, the same installed
source, prompt and credential as above, and one project connection. Socket
open took 815 ms and resolved project identity took 857 ms from connection
start; both are outside the call timers. All ten calls returned non-silent PCM.

| Measurement                      | Ordinary                              | Upgrade overlap                       |
| -------------------------------- | ------------------------------------- | ------------------------------------- |
| Readiness samples (ms)           | 4,727 / 1,959 / 1,671 / 2,173 / 1,832 | 1,639 / 1,582 / 1,161 / 1,536 / 1,709 |
| All-five readiness median (ms)   | 1,959                                 | 1,582                                 |
| Later-four readiness median (ms) | 1,895.5                               | 1,559                                 |
| First received PCM median (ms)   | 3,010                                 | 2,540                                 |
| Calls with PCM                   | 5/5                                   | 5/5                                   |

The all-five improvement is 377 ms; the direct Node readiness reference remains
1,003.203 ms. The first ordinary call still took 4,727 ms after identity resolved,
including 2,576 ms to observe `call-started`. Authentication therefore does not
explain that remaining delay. This is a small comparison, not a tail-latency
claim or proof of physical speaker onset.

Twenty untruncated records matched the exact version and five treatment
activations, with one registration, upgrade, claim and cancellation each.
Egress took 494 / 530 / 448 / 472 / 476 ms. The prepared socket then waited
371 / 465 / 225 / 547 / 418 ms for the voice facet's claim. Every cancellation
reported zero pending upgrades and waiters. All ten terminal states had a
closed call, matching activation, no pending delegations, zero subscription
lag, no last error, and the expected voice runtime key. Targeted ProjectDO and
hosted-parent error queries returned no records.

Two earlier single-call deployment checks are also retained: readiness/first
PCM was 5,786/6,958 ms for `final-smoke/01-2e9ad442` and 3,060/4,099 ms for
`tail-diagnostic/01-6d4a6b67`. Both preceded the identity correction and cannot
isolate call startup. Persisted telemetry queries for the first check returned
invocations but no custom overlap-phase logs; this evidence gap remains
unexplained. Live tail during the second check captured all four phases on the
correct deployment and zero pending resources at cancellation. Live tail was
not attached during the corrected paired benchmark.

Evidence under `/tmp/voice-startup-pr`: `handshake-overlap-identity-ready-result.json`,
`handshake-overlap-identity-ready-classified.json`,
`handshake-overlap-identity-ready-terminal-audit.json`, and
`handshake-overlap-live-tail.log`. Typecheck and focused CLI lint passed. All
PR checks, including preview deployment/E2E, passed on `eb8c912ea`; subsequent
head checks remain authoritative. Earlier unexplained silent calls still
block promotion.

## Cancelled upgrades retain capacity until actual cleanup

A local workerd DO-to-DO experiment showed that adding `AbortController` would
be unsafe here: the caller rejected in 29 ms after cancellation, but the
receiving object still completed a delayed upstream 101 roughly one second
later. Its socket remained open at the 2.5-second observation. The uncancelled
control remained claimable and echoed normally. This is a negative local
runtime result, not evidence about production request cancellation.

The overlap control therefore keeps the actual fetch awaited and retains its
capacity slot after cancellation or claim expiry. A late 101 is accepted and
closed before the slot is released. Logs distinguish cancellation requested
from preparation actually settled. A cancelled claim skips a needless policy
refresh; normal claims still recheck policy. Preparation checks the empty
policy once, then follows the ordinary secret/audit egress path. No abort
signal or alternative credential route was introduced.

Regression coverage exercises the real ProjectDO ownership logic with a
controlled SecretDO response: eight cancelled or expired pending fetches keep
the ninth rejected until one late response is closed, a successful response
can be claimed only once, and cancellation during the initial policy read
starts no provider fetch. Node's inability to construct a 101 is mocked at the
response adapter only. These tests do not prove cross-object network cleanup;
that limitation is why the actual fetch remains owned until settlement.

All three lifecycle regressions fail on the prior implementation (the ninth
request was incorrectly admitted), then pass with the fix. The combined five
lifecycle/scope tests, focused lint, and typecheck pass. Red/green outputs are
`/tmp/voice-startup-pr/handshake-capacity-{red,green}.log`.

Fable 5.1 xhigh independently identified the in-flight capacity issue and
recommended finer registration-to-facet timing. Its suggestion to reuse a
finished treatment stream was rejected: the precommit guard already enforces
one activation per stream. Two limits remain explicit: the 10s claim TTL is
shorter than the facet's 15s opening deadline, and the 250ms registration wait
has not been proved for implicit microphone-minted calls. Current benchmarks
and HAVPE setup use explicit activation. The review and source-checked
assessment are in `/tmp/voice-startup-pr/claude-fable-5-1-review/handshake-overlap-*`.

Evidence: `/tmp/workerd-handshake-abort-20260915/result.json` and
`apps/os/src/domains/projects/voice-handshake-overlap-lifecycle.test.ts`.
The earlier twenty successful audio samples did not exercise pending-fetch
cancellation and must not be treated as proof of that case.

## Reproduce

From `apps/os`, with the current voice source installed in a disposable
project and an existing `/secrets/openai`:

```sh
doppler run --config preview_17 -- pnpm cli voicelab startup \
  --project <project-id> --runs 5 --audio \
  --stream-prefix /agents/voice/startup-colocated/proof
```

Use a prefix outside `startup-colocated/` for native placement. The CLI holds
one authenticated, project-resolved WebSocket and emits every sample, including
errors. Socket-open and project-ready timings are reported separately.
Credential provisioning and source installation belong outside the call
measurement. Never publish credentials in benchmark artifacts.

Detailed temporary experiment scripts and raw results on the investigation
machine are under `/tmp/voice-startup-pr`; the independent Node transport
comparison is under `/tmp/voice-startup-webrtc-20260914`. They are not runtime
dependencies. Retain failed samples and distinguish clocks from different
actors when interpreting their phase arrays.

## First-call setup phase probe and cancelled-upgrade settlement

A Preview 17-only, exact-project probe split the first corrected fresh-stream
setup call without adding a stream event, an extra await, or a new protocol
option. It recorded native runner phases on the runner clock and returned guest
setup phases on the guest clock; the two clocks are correlated by activation
and stream path and must not be added as one sequential waterfall.

The first row retained its failure. It observed `call-started` at 2,462 ms,
returned setup at 5,604 ms, and accepted the conversation at 5,348 ms, but no
non-silent PCM arrived during the **remaining 4,395 ms** of the fixed
10-second overall startup deadline. This is not treated as a successful audio sample.
The terminal audit subsequently found the call ended, subscription lag zero,
no subscription error, and no pending delegation. The next four rows produced
PCM at 2,999 / 2,845 / 2,593 / 2,654 ms.

| First-row phase                    | Duration / observation |
| ---------------------------------- | ---------------------: |
| Native source resolution           |                  96 ms |
| Guest `this.itx` before setup body |               1,012 ms |
| Initial durable setup append       |                  81 ms |
| Client observes `call-started`     |               2,462 ms |
| Guest voice barrier settles        |               2,402 ms |

The native probe reached guest method invocation at 96 ms. The guest clock
then spent 1,012 ms reaching its project ITX handle and 81 ms on the initial
append. About **1,120 ms** remains outside the runner's full 4,484 ms invocation,
as combined dispatch/return work; it is not yet attributed to one
foreground operation. The 1,012 ms guest ITX interval and the native 96 ms
source interval use different actor clocks, so the table identifies boundaries
rather than a valid additive critical path. This rules out a multi-second
source build in this sample, but it does not yet identify the remaining first
`call-started` delay.

The temporary source was pinned to `5fad812c482e6c647efac1b6d2421e5d89b78cc0`
on Preview deployment `aa36ee1b-6d3b-470b-9edc-b7afd49dae21`; its runtime
key was `83ad97859d80780a00b0833cacefa5d687d9bc6e6b3f73a8154e0fd80938f5a4`.
The raw benchmark, terminal audit, and native phase records are respectively
`startup-first-call-phase-result.json`,
`startup-first-call-phase-terminal-audit.json`, and
`clean-cold-workers-startup-first-call-phase-voice startup first-call phases.json`
under `/tmp/voice-startup-pr`.

A separate native-only pending-upgrade cancellation proof created two
activations and ended both before a voice facet claimed them. Neither sent
`session.start` or audio. For each activation, logs recorded cancellation while
`pendingUpgrades` was 1, followed by preparation settlement with
`pendingUpgrades` and `pendingRegistrations` both 0. This proves that the
ProjectDO's retained pending slot is released after its owned preparation
settles, rather than at cancellation request time. It does **not** prove an
upstream provider close acknowledgement. There is no basis in this proof to
infer microphone-frame loss from absent ephemeral events.

The durable streams contain one matching `call-started` and one
`conversation-ended` record each, with reason `preview native upgrade
cancellation proof`. Evidence is
`handshake-capacity-cancellation-result.json` and
`clean-cold-workers-handshake-capacity-cancel-voice handshake overlap.json`
under `/tmp/voice-startup-pr`.

## Outer timing and silent-counter follow-up

A second five-call Preview 17 probe added an outer setup boundary and read
bounded runtime counters after each call. All five calls produced audio. The
CLI process nevertheless exited non-zero because row 2's terminal append did
not resolve within its 1,000 ms cleanup bound. That is retained as a harness
failure, not discarded: the later terminal audit found the same activation
ended with subscription lag zero and no subscription error. It therefore does
not establish a lost terminal event or explain the startup delay. Row 3's
901 ms initial durable append is also retained rather than averaged away.

For the first row, the native runner measured source resolution at 79 ms and
runner settlement at 4,690 ms. Guest project ITX took 930 ms and the initial
append 143 ms. The outer native call settled at 4,708 ms, only 18 ms after the
runner, so that portion is server work inside the facet/runner boundary rather
than a multi-second outer dispatch gap. The client received setup at 5,843 ms:
approximately 1,135 ms remains outside the facet measurement and is still
unassigned. As before, the native, guest, outer, and client clocks establish
correlated boundaries; they are not an additive waterfall.

Each runtime read reported one 640-byte microphone frame, one commentary item,
provider output above zero, and a maximum silence gap of 100 ms. This is
runtime-getter evidence, not persisted console evidence: the
`voice-silent-call-probe` log query returned zero records. Ten native records
matched the exact deployment version and were untruncated; parent/project error
queries returned zero records. No transcript content is retained here. The
benchmark, terminal audit, and native records are
`startup-first-call-silent-phase-result.json`,
`startup-first-call-silent-phase-terminal-audit.json`, and
`clean-cold-workers-outer-silent-phase-voice startup first-call.json` under
`/tmp/voice-startup-pr`.

### Health warmup after a native deployment

A separate fresh deployment (`6171319f-4a12-4caf-a0f9-3df5e73095b2`)
kept the same instrumented voice source/runtime as the counter run, but called
its existing `voice.health()` before the first setup, on the benchmark's one
project WebSocket. No earlier setup, future stream, activation, or provider
session was created. Health took 2,368 ms and returned the expected runtime key.
This is a deployment-separated observation, not a within-deployment matched
pair: running a cold setup before health would itself warm the control.

All five calls returned audio and passed the CLI's cleanup bounds. The first
call's guest project-handle wait and native source resolution were both 0 ms;
the initial append still took 854 ms. First readiness was 2,998 ms and first
received PCM 4,232 ms. Its native runner took 4,169 ms, ProcessorFacet 4,174 ms,
and client setup 4,193 ms, leaving 19 ms outside the facet instead of the prior
cold observation's 1,135 ms. These observations support moving root/binding
warmup to connection establishment; they do not establish a general cold-call
latency target or remove the remaining initial-append/processor work. The
provider handshake also varied (865 ms here versus 1,751 ms in the previous
cold sample), so the full readiness difference is not attributable to health.

Ten native phase records matched the deployment and activations and were
untruncated. All five audited states were ended with no pending delegation or
subscription error. The first audit reported lag 10 for row four; a bounded
follow-up reported lag 0, with intervening stream-wake/revival and feed events
retained. All runtime counters were null by this later audit; they are not
used as audio-forwarding evidence for this run. Project/host-parent error
queries returned zero events. The successful client PCM observations remain
the audio evidence.

Artifacts under `/tmp/voice-startup-pr` are
`startup-first-call-health-warm-result.json`,
`startup-first-call-health-warm-terminal-audit.json`,
`startup-first-call-health-warm-events-with-ephemeral.json`, and
`clean-cold-workers-health-warm-phase-voice startup first-call.json`.
The temporary CLI health branch is excluded from the product benchmark; its
2,368 ms is explicitly separate from button-to-call timing, not hidden work.

### Final root capability boundary probe

A third deployment (`66d9bea7-ff21-49af-917c-d002268a59d2`) added a
root capability timer around the existing facade acquisition/invocation/disposal,
retaining the same instrumented voice source. Five fresh calls, without health
prewarm, returned audio and passed cleanup. Their terminal audits had matching
runtime/activation, ended state, no pending delegation, and zero lag/error.
Fifteen phase records were version-matched and untruncated; scoped ProjectDO
and hosted-parent error queries returned zero events.

The first guest project-handle wait recurred at 1,127 ms; source resolution was
67 ms and initial append 107 ms. However, the former one-second outer gap did
not recur: facade acquisition took 9 ms first and 8–9 ms later. The first
ProcessorFacet duration was 4,280 ms versus 4,277 ms in the runner. The root
reported 4,379 ms while the client's setup measurement was 4,370 ms. That small
cross-actor discrepancy is retained: independent clocks/observation boundaries
are not an exact additive waterfall. This run does **not** retrospectively
attribute or explain the earlier 1,135 ms gap. First readiness was 4,795 ms and
first received PCM 5,803 ms, with a 2,035 ms provider handshake.

Artifacts under `/tmp/voice-startup-pr` are
`startup-first-call-root-boundary-result.json`, its `terminal-audit.json`, and
`clean-cold-workers-root-boundary-phase-voice startup first-call.json`.
The combined native/CLI instrumentation is archived as
`startup-combined-phase-probes-applied.patch` and removed from the checkout.

### Clean restoration exposed a multi-second regression

After removing all phase/health instrumentation and restoring the original
`ebb0a42d…` source (`bbc88660…` runtime), clean native deployment
`84afd2d1-d261-40d3-b75b-567a3623a121` passed deploy smokes but **failed** its
three-call overlap validation. Readiness was 9,949 / 8,469 / 2,854 ms. The first
call had only 51 ms left to acknowledge its microphone append, never sent the
commentary, and also exceeded the one-second terminal-append bound; its setup
RPC settled after 20,315 ms. The other two returned PCM at 9,812 / 4,685 ms.
This first failure is a deadline-exhaustion case, not the earlier unexplained
silent-after-commentary case.

The immediately preceding same-key direct Node reference returned audio in
all five calls. Median upgrade was 459.844 ms, `session.started` 832.655 ms,
and first non-silent PCM 1,605.907 ms. The in-memory key was also written to
Preview's `/secrets/openai` at offset 621; no key/fingerprint was persisted.
The exact 2,096-byte prompt stayed unchanged. This is a sequential software
reference, not a physical speaker or interleaved provider-path control.

Twelve untruncated, version/activation-matched native overlap records showed
all three resources eventually settled with zero pending entries. The second
upgrade took 443 ms, then waited **6,046 ms** before the voice facet claimed
it. Thus OpenAI upgrade duration does not explain that particular stall.
All three later audited states were ended, with matching runtime/activation,
no pending delegation, and zero lag/error; that does not explain the delay.

Error-only ProjectDO/host-parent queries returned zero, but a targeted trace
query found **339 informational `processor relay retrying after Durable Object
lifecycle reset` messages** on trace `6dfc6368e7c015b37163624f5385991d` during
the window. That label is broader than literal resets: its classifier also
accepts overload/retryable flags and tagged stream-unavailable errors. The
logs omit the original reason and whether acquisition or invocation failed.
They establish substantial retry activity, not 339 proven object restarts or
one unbounded loop. The shared-parent invocation query hit its 2,000-row cap;
retained 1–4 second partitions avoid treating capped output as a full count.
This retry activity and the multi-second stalls remain release blockers.

The clean fixture's functional source files match the checkout. Probe sources
use different immutable source/runtime/facet identities, so their faster
samples do not isolate the effect of removing instrumentation or cache reuse.

Artifacts under `/tmp/voice-startup-pr`: `startup-after-phase-cleanup-result.json`,
`startup-after-phase-cleanup-terminal-audit.json`,
`clean-cold-workers-after-phase-cleanup-voice handshake overlap.json`,
`direct-same-key-after-first-call-phases/`, and
`clean-cold-workers-restored-dominant-custom-6dfc6368e7c015b37163624f5385991d.json`.

### Bounded retry-attribution follow-up

Temporary, project-scoped native logging records the relay's acquisition/call
phase, target stream/processor, and reset/overload/retryable/unavailable flags.
It changes no retry behavior. Diagnostic deployment
`ed44cc2d-6cbb-4b72-857d-435eb67d17e6` retained the clean `ebb0a42d…` voice
source and `bbc88660…` runtime. Its deploy smokes passed; 37 relay tests,
OS typecheck, and focused lint passed. An earlier deployment attempt stalled
in the local Vite build and was cancelled before uploading the main worker.

The first three-call batch, without a preceding secret rewrite, returned PCM
in all three calls. Readiness was 5,344 / 1,511 / 1,565 ms and first PCM
6,549 / 2,714 / 2,563 ms. The first call after deployment remains included.
A second bounded batch followed rewriting the same credential at secret offset
652, with no source/native deployment between batches. All three returned PCM:
readiness 2,086 / 1,662 / 1,792 ms, first PCM 3,101 / 2,847 / 3,197 ms.
Neither batch reproduced any relay-retry messages. A secret rewrite alone is
therefore not a reliable reproduction; the different warm/cold conditions do
not establish whether it contributed to the original failure.

Each batch has twelve untruncated, exact-version overlap records. All six
terminal audits had matching runtime/activation, ended calls, no pending
delegations, zero lag, and no last error. ProjectDO and hosted-parent
error-level queries covering both batches returned zero records. These
negative reproductions do not explain or clear the earlier 339 retries,
multi-second stalls, or retained silent-call findings.

Source inspection confirms that each relay attempt reacquires a fresh routed
facade and retries exactly once. Thus the earlier volume needs multiple
callers or outer reissues; it is not evidence of one unbounded relay loop.
A secret update does not directly update the project catalog, although
delivery activity can indirectly refresh watched project state.

Artifacts under `/tmp/voice-startup-pr`: `startup-relay-retry-probe-result.json`,
`startup-relay-retry-after-secret-result.json`, their terminal audits,
`clean-cold-workers-relay-retry-*-*.json`, and the temporary diagnostic patch
`relay-retry-diagnostic-applied.patch`. The diagnostic is not yet part of the PR.

## Native inline voice processor control

A broader control on version `3d35ba3a-ae88-4b00-be3f-7868659319e2`
instantiated the existing `ProcessorFacet` host class locally inside each
hosted conversation child, without creating another processor facet. Its
registry used the child's own storage and existing processor-alarm proxy.
Both arms retained provider-upgrade overlap, ordinary Agent setup, and the
same voice processor implementation. A source/class/project/preview guard
restricted the native arm to fresh `/overlap/inline/` paths and the immutable
`ebb0a42d…` source. The native implementation also uses native StreamRpcTarget
and scoped project egress instead of guest ITX/outbound bindings. This is a
comparison of that complete native treatment, not placement alone.

All ten counterbalanced calls over one identity-resolved project WebSocket
returned audio and passed cleanup. The first samples remain included.

| Measurement                      | Native inline                         | Ordinary dynamic facet                |
| -------------------------------- | ------------------------------------- | ------------------------------------- |
| Readiness samples (ms)           | 3,878 / 1,548 / 1,867 / 1,803 / 2,144 | 1,394 / 1,893 / 2,486 / 1,898 / 1,682 |
| All-five readiness median (ms)   | 1,867                                 | 1,893                                 |
| Later-four readiness median (ms) | 1,835                                 | 1,895.5                               |
| All-five first PCM median (ms)   | 3,134                                 | 3,024                                 |

There is no established useful improvement. The immediately preceding
five-call same-key direct Node reference had median upgrade 481.995 ms,
`session.started` 1,057.002 ms, and first PCM 1,802.533 ms; all five returned
audio. That in-memory key was written to preview secret offset 665. The
2,096-byte prompt hash matched every hosted call. These are software receipt
measurements, not physical speaker onset.

Five exact-version creation records confirmed the intended inline hosts.
Forty exact-version, untruncated overlap records accounted for all ten calls;
each cancelled upgrade settled with zero pending entries. All terminal audits
showed ended calls, matching activation, no delegation, zero lag/error, and
the expected native deployment key or dynamic `bbc88660…` runtime. Initial
voice batches were contiguous and voice/Agent configuration payloads matched
after normalizing only path, activation, UUID, and textual offset references.
ProjectDO/host-parent error queries and relay-retry queries returned zero.

Validation included 53 hosted/relay tests, five real-workerd ProcessorFacet
lifecycle tests, three new focused host/guard tests, OS typecheck, lint, and
deploy smokes. A separate real-workerd constructor proof verified that the
local host can receive raw native context before using the hosted child view.
The focused mocked context test distinguishes incorrect context use; it does
not by itself prove native storage isolation.

This temporary control does not preserve mid-call source-change or clone-skew
retirement: the source guard rejects a changed configuration, but a cached
inline host does not follow ordinary facet-abort cleanup. Those operations
were excluded, not proved equivalent. The control is not a production design.

Artifacts under `/tmp/voice-startup-pr`: `inline-voice-ab-result.json`,
`inline-voice-ab-classified.json`, `inline-voice-terminal-audit.json`,
`inline-voice-events-audit.json`, `inline-voice-semantic-proof.json`,
`inline-voice-source-equivalence.json`, `inline-voice-control-applied.patch`,
`direct-same-key-inline/`, and `clean-cold-workers-inline-ab-*.json`.

## Local self-stream invocation

Version `79ac9c76-b023-4004-ab5c-ab0603527fd4` compared two native inline
hosts. The remote arm retained StreamRpcTarget's normal routed self-RPC. The
local arm supplied only its five processor read/append verbs through the
same hosted child's `invokeHostedStream` method. It retained that boundary's
required alarm-write repair/flush, plus StreamRpcTarget's retry, lifecycle
tagging, result detachment, paging, and stream-lifetime guarded append logic.
Sibling `at()` handles remained remote. This removes a self-invocation
boundary, including its output-gate behavior; it does not isolate network
transport time alone.

All ten counterbalanced calls returned audio and passed cleanup over one
identity-resolved project WebSocket, with fresh paths inside every call timer.

| Measurement                      | Local self-stream                     | Routed self-stream                    |
| -------------------------------- | ------------------------------------- | ------------------------------------- |
| Readiness samples (ms)           | 3,335 / 1,354 / 1,252 / 1,462 / 1,618 | 1,606 / 1,755 / 1,827 / 2,355 / 2,340 |
| All-five readiness median (ms)   | 1,462                                 | 1,827                                 |
| Later-four readiness median (ms) | 1,408                                 | 2,083.5                               |
| All-five first PCM median (ms)   | 2,826                                 | 3,195                                 |

The 365 ms median readiness reduction is useful evidence, not completion:
the first local call still took 3,335 ms, and the immediately preceding
five-call same-key direct reference measured median upgrade 473.799 ms,
`session.started` 822.562 ms, and first PCM 1,693.055 ms. All direct calls
returned audio; the same in-memory key was written at secret offset 688.
Every hosted call reported the unchanged 2,096-byte prompt hash.

Ten exact-version host records confirmed five local and five remote choices.
Forty exact-version, untruncated overlap records accounted for every resource,
each settling with zero pending entries. Two later local calls claimed while
the provider upgrade was still pending, waiting 334 / 410 ms inside claim;
their already-ready socket wait was zero. The other later local ready-to-claim
waits were 217 / 379 ms. Every remote socket waited after upgrade readiness:
340 / 349 / 519 / 845 / 1,185 ms. These timings support removing self-stream
work from startup, without explaining every remaining interval.

All ten terminal audits had the expected deployment runtime key, matching
activation, ended call, no delegation, zero lag, and no last error. ProjectDO,
host-parent error, and relay-retry queries returned zero events. The earlier
failed/silent samples and the mid-call source/clone lifecycle limitations
above remain unresolved; this run does not erase them.

Five focused inline-host tests, OS typecheck, lint, format, and deploy smokes
passed. The new tests exercise actual StreamRpcTarget reads, passive context
append, guarded append, and rejection through the supplied local callback.
Existing hosted and ProcessorFacet lifecycle evidence remains applicable to
the reused implementations; it does not prove every new composition boundary.

Artifacts under `/tmp/voice-startup-pr`: `inline-local-ab-result.json`,
`inline-local-ab-classified.json`, `inline-local-terminal-audit.json`,
`inline-local-events-audit.json`, `direct-same-key-inline-local/`,
`inline-local-control-applied.patch`, and `clean-cold-workers-inline-local-*.json`.

### Delaying Agent provisioning after voice acceptance: excluded control

The same-source comparison at `2026-09-15T02:38:44.761Z–02:39:22.533Z`
used deployment `4fe68da7-dd19-446d-855f-77a230eb64db`, immutable source
`188ddaa4d9d120e3ab7761617d487750d4d3489f`, and secret offset 711. Both arms
kept provider overlap and native inline/local stream invocation. The treatment
waited for matching durable acceptance and the normal initial fold barrier
before ordinary Agent creation; credential validation stayed eager and shared.
The one project WebSocket was identity-ready before timing. Paths were minted
inside each call timer, with no health call after native deployment or future
conversation/provider precreation. Order was late, parallel, parallel, late,
late, parallel, parallel, late, late, parallel.

| Milliseconds                | Delayed Agent (five calls)                  | Parallel Agent (five calls)           |
| --------------------------- | ------------------------------------------- | ------------------------------------- |
| Client readiness            | 3,143 / 1,054 / 1,068 / 1,229 / 1,843       | 1,453 / 1,155 / 1,261 / 1,400 / 1,192 |
| Median readiness            | 1,229                                       | 1,261                                 |
| First non-silent PCM        | **timeout** / 2,209 / 1,962 / 2,576 / 2,976 | 2,837 / 2,854 / 2,433 / 2,499 / 2,568 |
| Median setup RPC completion | 3,106                                       | 2,530                                 |

The immediately preceding same-key direct Node control returned audio in 5/5
calls: median WebSocket open 473 ms, session.started 929 ms, first non-silent
PCM 1,835 ms. Its first call was slower too (1,700 ms session.started), but
returned PCM at 2,538 ms. The 32 ms median readiness difference does not justify
retaining the scheduling change, particularly with later backend readiness.
The treatment and its tests were archived and removed after this comparison.

The first treatment accepted at 3,143 ms, acknowledged microphone input at
3,253 ms and commentary at 3,475 ms, and completed setup at 4,867 ms, but did
not return non-silent PCM before the fixed ten-second overall deadline. Its
commentary is durable at offset 23; backend-ready follows at 52 and the client
cleanup terminal at 66. No answer transcript was retained. This is a failed
sample, not an audio success or proof that the provider ignored commentary.
The other nine calls returned audio. All ten ended with matching activations,
no pending delegation, zero subscription lag/error, and the expected runtime.

Ten host-selection logs and forty upgrade lifecycle logs match the exact
version and are untruncated; all cancellations settled with zero resources.
No relay retries or ProjectDO/host-parent error-level logs were found. These
negative checks do not explain the silent call. The temporary gate passed
93 focused tests, OS typecheck, lint, formatting, and deployment smokes before
the comparison. Its small shared credential promise prevented an early
credential-failure terminal from being skipped by the acceptance replay cursor.

Artifacts under `/tmp/voice-startup-pr`: `late-backend-ab-result.json`,
`late-backend-ab-classified.json`, `late-backend-{events,terminal}-audit.json`,
`direct-same-key-late-backend/`, `late-backend-install.json`,
`late-backend-control-applied.patch`, and `clean-cold-workers-late-backend-*.json`.
The original immutable source was restored at root offset 2660 with a matching
`bbc88660…` health response before restoring the native deployment.

Native restoration `857dbf87-cb43-4614-9212-7366cc3b5994` passed all deployment
smokes. No additional voice calls were made to replace the failed sample.
