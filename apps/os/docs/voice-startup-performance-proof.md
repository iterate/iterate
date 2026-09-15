# Fresh voice startup: experiment evidence

## Status and scope

This document summarizes the evidence for the Preview 17 fresh-stream experiment
in PR2648. It replaces a chronological experiment diary with the facts needed to
review the implementation and its limits.

The experiment is restricted to `preview_17` and stream paths below
`/agents/voice/startup-colocated/`. It is not a production placement policy.
No production OS deployment, HAVPE firmware flash, or physical playback result
is evidence for this experiment.

The implementation keeps each logical child stream independently durable while
routing the selected prefix through a same-project hosted Stream DO. It retains
normal project and stream authority, uses the existing Stream DO implementation,
and rejects hosted `reset` because clearing child storage cannot atomically clear
the host-held virtual alarm. Ordinary native reset behavior is unchanged.

Voice setup now:

1. starts the ordinary Agent provisioning/configuration and voice facet work in
   parallel;
2. includes `call-started` in the initial voice setup batch when an activation is
   supplied;
3. keeps provider ownership and terminal fencing in the voice facet; and
4. lets firmware flush locally captured microphone frames only after durable
   `conversation-accepted`, without waiting for the ordinary Agent setup RPC.

The ordinary Agent harness and its conversation semantics are unchanged.

The selected native inline voice host reuses `ProcessorFacet` lifecycle with the
voice implementation compiled into the native worker. Five self-stream methods
run through the existing hosted invocation boundary locally; other streams keep
normal RPC routing. This bypass is guarded by preview, project, source and path.
It does not implement mid-call source-change/clone-skew retirement and is not a
production replacement for dynamic workers.

A second guarded experiment starts an authorized provider upgrade after committed
`call-started`, while voice and ordinary Agent setup continue. The voice facet
claims the unaccepted upgrade through its normal fetch path and owns session start,
audio and termination. Capacity is eight preparations; claim TTL is ten seconds,
opening timeout fifteen seconds. Cancelled pending fetches remain charged until
settlement; a late upgrade is accepted and closed before freeing its slot. Caller
abort alone did not close a downstream DO upgrade in a negative control. The
250 ms registration wait for implicit microphone activation is not proven adequate.

The generic processor self-catch-up read now includes opted-in buffered ephemeral
events. Previously a durable-only read could advance the cursor beyond queued
microphone frames, causing their later delivery to be deduplicated. The merged
byte-limited prefix cannot cross an omitted durable event. Durable state rebuild
and wildcard ephemeral filtering are unchanged. A valid red/green regression
proves this cursor defect; it does not establish the cause of earlier silent calls.
The preview native inline host uses this fix, while the benchmark's published SDK
pin remains `055337b142344aed13b86cb6246c8caa1df212cd`.

## Definitions

All reported values are named milestones. They are not interchangeable.

| Milestone            | Meaning                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Setup returned       | The public `setupVoiceAgent` RPC resolved after Agent and voice fold-through barriers.                                  |
| Call started         | The client observed the durable `call-started` fact.                                                                    |
| Session configured   | The provider session configuration was observed by the stream subscriber.                                               |
| Client ready         | `conversation-accepted` reached the subscriber.                                                                         |
| First non-silent PCM | A PCM16 speaker frame with peak amplitude at least 100 reached the subscriber. It is not DAC or physical speaker onset. |
| Provider handshake   | The provider-reported handshake interval; it is not an end-to-end client metric.                                        |

A direct Node control measures a different topology. The difference between its
session-start duration and stream client-ready duration is a valid total added
topology/time observation, but it cannot assign that difference to one hop.
Browser/CLI and Worker clocks have no shared timestamp; cross-clock subtraction
therefore identifies a residual, not a named server hop.

## Constraints that preserve correctness

- No provider connection is prepared before a durable activation/call fact.
- A terminal fact fences delayed setup and closes an already-open provider call.
- A failed required hosted alarm write remains observable until a replacement
  write commits. Durable work retains the acknowledged recovery alarm.
- Ephemeral-only suffixes avoid source-owned durable scheduling when the
  existing append handoff has acknowledged a contiguous complete suffix.
- The selected host may route only the preview prefix and same project. Other
  paths use the native Stream DO unchanged.
- Hosted reset is explicitly unsupported. There is no cross-DO reset workflow.

Focused sender/alarm/keepalive tests cover remote alarm rejection, reentrant
clear/rearm, concurrent callers, retry with the same idempotency key, and
late/closing cleanup. These tests prove state and ownership behavior; they do
not prove audio playback smoothness.

## Primitive costs: activation is distinct from storage

The earlier production primitive test used an established authenticated project
WebSocket and five unique paths. A stream handle took 15–22 ms (median 16);
a generic Agent handle took 13–21 ms (median 13). Handles only address a path;
they do not create durable state.

The first durable stream operation took 1,345–2,143 ms (median 1,697). Explicit
Agent birth took 443–2,269 ms (median 501), and the subsequent passive context
append 149–1,692 ms (median 934). These include initialization barriers and
worker activation, not just a row write. Repeated passive append had median
137 ms. A global, project-worker-free control still took 1,207 / 1,254 / 1,857 ms
for first StreamDO read, followed by 54 / 60 / 64 ms for append.

Native phase probes subsequently found a fresh loopback ITX worker activation
before each new StreamDO's `get` entered. Once active, the observed get was
0–8 ms and append 22 ms. Ten paired existing-child read controls were mostly
10–13 ms (serial median 12.5, pipelined 11); a separate initial 1,009 ms sample
is retained. This supports avoiding repeated activation as the optimization
target. It does not establish a 1.3-second storage floor or promise every new
conversation can finish all initialization in tens of milliseconds.

## Retained benchmark results

### Native versus hosted fresh streams

On 14 September, Preview 17, five alternating native/hosted new stream paths
over one established project WebSocket produced audio in all ten calls before
the fixed 10-second deadline.

| Client-ready ms | Native | Hosted |
| --------------- | -----: | -----: |
| 1               |  8,892 |  3,014 |
| 2               |  4,454 |  2,131 |
| 3               |  4,314 |  1,632 |
| 4               |  4,354 |  1,304 |
| 5               |  7,719 |  1,441 |
| Median          |  4,454 |  1,632 |

First non-silent PCM medians were 5,604 ms native and 3,012 ms hosted.
Host preparation was outside the per-call timer, but did not warm the first
child ITX connection.

This is a preview experiment result, not a production latency claim. The first
call in each arm remains a cold sample and is retained rather than averaged away.

### Continuous microphone delivery

On native version `41b88e87-75fd-4dde-b78b-b285299671a7`, one 20-second
continuous-input run acknowledged all 201 microphone appends, with 175 ms
median and 490 ms maximum acknowledgement time. It received speaker audio and
closed with WebSocket code 1000. Its error-level Worker query was empty.

A post-recovery run after the source-owned ephemeral correction acknowledged
all 201 frames with 42 ms median, 117 ms p95, and 318 ms maximum. It recorded
11 relay writes, compared with 290 in an earlier matched 201-frame run. The
runs have different answer lengths and other durable activity, so the observed
reduction is not an exact per-frame cost model.

Per-answer supply deficit is a subscriber arrival calculation, not a hardware
underrun measurement. One corrected run measured 236 ms for its first answer;
an earlier clean fresh-project run measured 392 ms; a matched direct Node answer
measured 138 ms. Inter-answer pauses are excluded. None establishes physical
HAVPE playout quality.

### Direct Node controls

A separate five-pair direct Node transport comparison, using GPT-Live, marin,
client delegation, and the short commentary task, measured median
`session.started` of 829 ms on WebSocket and 1,566 ms on WebRTC. Playback
submission medians were 1,724 ms and 2,611 ms. All ten made actual SoX
playback, but network location differs from Workers and physical speaker onset
was not measured.

The corrected same-key control used 20 ms PCM16 input, the same 2,096-byte
prompt, model, voice, commentary, in-memory credential, and silence coverage
policy. Its five direct Node calls measured `session.started` of
1,576 / 986 / 838 / 827 / 809 ms (median 838) and first non-silent PCM median
1,860 ms. The paired five preview paths measured client-ready
2,828 / 1,230 / 1,303 / 1,182 / 1,344 ms (median 1,303) and first PCM median
2,555 ms. Both arms returned PCM. Input content matched, but submission timing
did not: the preview helper awaited the microphone append acknowledgement before
sending commentary. The direct helper sent both immediately. Readiness precedes
those inputs; first-PCM differences include the harness delay described below.

Earlier controls with mismatched initial PCM frame sizes are retained but are
not used for first-PCM comparison.

## Latest controlled startup evidence

The retained pending-wake fix reuses the sender's existing in-flight wake set.
Idle derivation, rearming and teardown defer during that bounded interval;
normal cleanup resumes from the existing settlement path. No new opening
counter or delivery state machine remains. The initial undispatched greeting
also counts as pending on its own connection.

Preview native version `83ee71f8-b84a-435d-a6b2-280ca7185e81`, on September 15
04:53:23–04:53:57 UTC, produced the following five fresh-path results:

| Run    | Client ready (ms) | First non-silent PCM (ms) |
| ------ | ----------------: | ------------------------: |
| 1      |             2,141 |                     3,681 |
| 2      |             1,304 |                     2,775 |
| 3      |             1,231 |                     2,659 |
| 4      |             1,511 |                     3,339 |
| 5      |             1,460 |                     3,341 |
| Median |             1,460 |                     3,339 |

All five returned audio and ended with matching activation/build, zero lag,
no pending delegations and no subscription error. Scoped parent/Project/Secret
error queries and processor-relay retry queries were empty. Exact-version,
untruncated probes retained five wake, batch and retirement records, 25 upgrade
records and 80 bounded relay summaries.

The targeted idle write (requested deadline `now + 5,000 ms`) disappeared from
all five startup traces. First insured-batch watchdog waits were 68 / 0 / 0 /
142 / 262 ms; self-catch-up won the two eventless cases. The preceding excluded
opening-counter control retained that write in all five cases and waited
84 / 314 / 625 / 357 / 391 ms. This establishes removal of the unwanted work.
The five-call medians alone do not establish a general end-to-end latency gain;
first-audio timing did not consistently improve.

One authenticated project WebSocket served the five calls. Root voice health
(2,265 ms), an empty read of the existing parent (1,269 ms), and description of
the existing OpenAI secret (1,753 ms) preceded all call timers. No future child
or provider was precreated. These warmups move initialization outside button
latency; they are not a power-on startup win. Source pin `06809feb6d762494b96299ed4e5cfa65aa895392`,
secret offset 755, prompt and 20 ms initial input were unchanged from controls.

The broader global-pending-delivery control returned ready times
2,114 / 1,562 / 1,545 / 1,280 / 2,156 ms and PCM
3,571 / 2,931 / 2,845 / 2,406 / 3,611 ms. It retained the unwanted write and
could retain quiet callbacks throughout continuous PCM. It is excluded.

Validation: the held-prewake regressions fail with the wake predicate disabled
and pass with it enabled; all 120 focused sender/hosted/alarm/replay tests,
OS typecheck, lint and preview deployment smokes passed.

### Fresh same-key direct comparison

Immediately afterward, the same in-memory key was installed at preview secret
offset 905 and passed to five direct Node calls, followed by five fresh preview
paths on the same native deployment. Prompt, model, voice, 20 ms input content
and silence coverage matched. Submission timing differed as detailed below.
These are sequential small samples, not randomized pairs.

| Metric (ms)                    | Direct Node                       | Preview                           |
| ------------------------------ | --------------------------------- | --------------------------------- |
| Session started / client ready | 912, 929, 774, 2,192, 860         | 1,308, 1,096, 1,324, 1,427, 1,721 |
| Median                         | 912                               | 1,324                             |
| First non-silent PCM           | 1,991, 1,766, 1,621, 3,250, 1,878 | 3,110, 2,348, 3,006, 2,704, 2,994 |
| Median                         | 1,878                             | 2,994                             |

The readiness median difference is 412 ms across complete topologies; it does
not locate a single causal hop. The 1,116 ms subscriber-PCM median difference
also includes a benchmark scheduling mismatch and is not a relay-cost estimate.
The direct 2,192 ms outlier is retained. Both arms returned audio in all five
calls; the preview terminal and scoped error/retry audits were clean. Its five
bounded startup relay traces again contained no unwanted 5-second idle intent.

Preview connection-time health/parent/secret reads cost 145 / 919 / 57 ms,
outside the call timers. The freshly written secret and existing parent were
already initialized; this comparison is not a deployment-cold warmup proof.
Direct artifacts: `/tmp/voice-startup-pr/direct-same-key-wake-inflight/`;
preview artifacts: `/tmp/voice-startup-pr/wake-inflight-matched-*`.

### Submission timing and diagnostic-free verification

The preview helper awaited each microphone append ACK before sending commentary;
the direct helper sent both back-to-back. In the comparison above, preview
microphone ACKs took 381 / 255 / 637 / 259 / 371 ms, while the direct send gap
was at most 0.203 ms. Commentary-send-to-PCM medians were 1,018 ms preview and
1,017.6 ms direct. These separate interval distributions do not support
subtracting medians to assign causal shares. Readiness is unaffected by this
specific mismatch because input submission follows readiness.

After removing temporary probes and restoring voice source
`ebb0a42dc2b1a44ae5cee36f87eee448a914b664`, clean native deployment
`af0f2120-d73b-4b7b-8731-0a4bf3f585c7` passed deployment smokes, but its first
benchmark attempt failed before any conversation was created. At
2026-09-15T05:01:52 UTC, the ordinary root Stream DO's foreground
`processorFacade` RPC reported an internal storage reset, reference
`gul8ku3a731v1gto3nlerhp7`, ITX call `log_25d0eb53554743b2ba756e56a4d4b488`.
This zero-call failure is retained. The trace does not identify the failing SQL
statement or establish a shared application cause with the earlier hosted-parent
alarm reset. Neither is explained by OpenAI or audio input.

One separately retained post-reset control, without a redeploy or retry loop,
returned ready at 2,181 / 1,325 / 1,352 / 1,683 / 1,696 ms (median 1,683),
and PCM at 3,711 / 2,624 / 2,704 / 3,344 / 2,865 ms (median 2,865).
All five terminal states and scoped error/retry queries were clean. Health,
parent and secret initialization took 1,661 / 1,013 / 1,642 ms outside timers.
This demonstrates subsequent operation, not remediation of the reset.

Two harness controls and one valid ordered-input control then ran on that
unchanged clean deployment and credential:

- Concurrent separate append RPCs reversed microphone/commentary order in one
  of five calls. The ordering assertion stopped that row; its missing PCM is
  not a silent-provider observation. This protocol is excluded.
- An array passed as the sole append argument failed schema validation in all
  five calls. The API is variadic; these are excluded harness failures.
- A single variadic `append(microphone, commentary)` preserved increasing event
  offsets in all five calls, removing the inter-input client wait. Ready times
  were 1,791 / 1,975 / 1,404 / 1,892 / 1,761 ms (median 1,791); PCM times were
  3,458 / 3,197 / 2,723 / 3,099 / 2,880 ms (median 3,099). All five returned audio.
  This small sequential sample does not establish an overall latency gain.

All fifteen control activations, including the harness failures, ended with
matching clean build and activation, no pending delegation, zero processor lag
or attempts, and no last error. The valid ordered control's scoped error/retry
queries were empty and its twenty upgrade logs were exact-version/untruncated.
Artifacts are `/tmp/voice-startup-pr/wake-inflight-clean-*-result.json`,
`wake-inflight-input-controls-terminal-audit.json`, and
`wake-inflight-clean-storage-reset-findings.md` in the same directory.

## Attribution results

The completed scoped probes on source `06809feb6d762494b96299ed4e5cfa65aa895392`
separate project policy, SecretDO, ordinary egress, upstream fetch helper, and
first hosted-batch wake work without adding provider requests or recording
prompt/credential material.

For the first measured call, the same-actor values were: project policy read
190 ms; ordinary egress call 1,873 ms; Secret snapshot 833 ms; pre-fetch
audit/authorization 43 ms; upstream fetch helper 441 ms; and first-batch
watchdog await 86 ms. Later calls respectively recorded policy 119/0/108/0,
egress 471/478/455/457, secret snapshots 21/20/19/19, audit 32/29/31/28,
fetch helper 410/424/398/403, and watchdog waits 325/565/348/0 ms.

The earlier outer probe remains useful for one negative conclusion: its first
client setup was 5,843 ms, ProcessorFacet was 4,708 ms, and runner was 4,690
ms; across all five rows, facet minus runner was 4–18 ms. This does not make a
server waterfall because client and Worker clocks differ. The later root
capability probe observed facade acquisition of 8–9 ms and no recurrence of
that earlier one-second residual; it does not retrospectively explain it.

An opening-counter control passed its regression tests but did not eliminate
the measured alarm writes. Its five ready times were 1,878 / 1,503 / 1,949 /
2,228 / 1,687 ms; first PCM was 3,479 / 2,570 / 3,171 / 3,433 / 3,127 ms.
All calls ended with matching activation/build, no pending delegations, zero lag
and no subscription error. However, a parent storage reset occurred during its
connection-time parent read (3,108 ms), before the call timers. The native error
reference is `rc0nluanmkta30spol6bmc56`, at 2026-09-15T04:42:15.938Z. It remains
unexplained and blocks promotion.

Same-actor timestamps place the unwanted idle intent before callback opening:
in call four, the wake watchdog awaited from +460 to +751 ms, and the idle
intent queued at +464 ms. The callback wake began at +751 ms. Similar ordering
occurred in three other calls. The retained fix uses the existing pending-wake state to defer idle decisions
during that bounded wait; the wider pending-batch and opening-counter policies
are excluded. The preview control above confirms the target write disappears.

## Failures and excluded controls

Failures are retained rather than converted into successful medians:

- An initial native post-deploy sample missed the 10-second deadline before
  OpenAI contact; its trace showed a 6,416 ms project-config-worker build.
- A later post-deploy attempt had a 13.675-second gap before the initial voice
  batch append. Available traces did not explain it.
- Two instrumented continuous-input attempts failed during deployment
  propagation: one code-update reset at acceptance and one internal storage
  reset while opening a subscription. A later post-recovery success does not
  remediate or explain the storage reset.
- Intermittent accepted-commentary/no-audio observations remain unresolved.
  One direct control showed that withholding input can produce the same visible
  symptom; a subsequent hosted input-delivery probe did not reproduce it.
- A benchmark cleanup append exceeded its 1,000 ms client observation bound,
  but the terminal audit later showed ended state with zero lag. That is not a
  lost terminal fact and has no source-backed causal link to the startup path.

The following are excluded from performance conclusions: minification,
shared-build-host controls, installer prewarm, eager delivery, stateless setup
root, egress-policy overlap, pre-wake watchdog changes, batching controls, and
any sample with unmatched direct input or unresolved project authentication.
They remain useful diagnostic history only.

## Open blockers and follow-up

1. The intermittent silent-provider outcome needs a trace that proves whether
   commentary reached OpenAI and whether response frames were emitted.
2. The native internal storage-reset failure remains unexplained and is a
   release blocker until classified.
3. Fresh matched direct/provider comparisons and sustained delivery must
   establish how much end-to-end latency the remaining platform work adds.
4. Requested alarm deadlines must remain distinct from relay wait measurements.
5. Continuous delivery and subscriber supply deficit need a physical HAVPE
   proof before any speaker smoothness claim.

## Evidence locations

The chronological diary was copied before replacement and remains local only at:

`/tmp/voice-startup-pr/voice-startup-performance-proof-diary-archived.md`

Key local raw artifacts include:

- `/tmp/voice-startup-pr/initial-greeting-pending.log`
- `/tmp/voice-startup-pr/global-pending-idle.log`
- `/tmp/voice-startup-pr/startup-first-call-silent-phase-result.json`
- `/tmp/voice-startup-pr/clean-cold-workers-outer-silent-phase-voice startup first-call.json`
- `/tmp/voice-startup-pr/hosted-continuous-audio-source-owned-ephemeral-clean.json`
- `/tmp/voice-startup-pr/hosted-continuous-audio-pinned-snapshot-clean.json`

These paths are not reviewer-accessible attachments. A PR body should state the
outcomes and limitations above, and link only to evidence deliberately uploaded
or published by the repository workflow.
