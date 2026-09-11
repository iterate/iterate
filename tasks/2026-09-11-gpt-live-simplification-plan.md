---
state: todo
priority: high
size: large
tags:
  - voice
  - firmware
  - refactor
---

# One voice client: combine Futurehomes and GPT-Live

Status: refined against the voice worktree on 2026-09-11 at 13:39 UTC, after the original Claude Fable 5.1 xhigh review. The [original review and disposition](2026-09-11-gpt-live-simplification-review.md) remain historical evidence; the newer silence-input findings below supersede the earlier plan’s blanket silence-fill deletion. This revision has not had another Claude pass. This is planning only.

Inputs are pinned to `futurehomes` at `3cb06157473e6dc3749367a76bfbd0a223f11116` and `voice-gpt-live-1` at `454cb43adf433996fa936a6ed56630a0bf0da4ac` ([PR #2624](https://github.com/iterate/iterate/pull/2624)), plus the observed uncommitted answer-flow diagnostics in the latter worktree. Their common ancestor is `0a34340fa09bdd42099bf591c1f525844e48055b`. The [source inventory](2026-09-11-gpt-live-simplification-evidence.md) records the exact snapshot, including uncommitted file hashes.

## What the recent work changes

- **Keep the backend's new silence input.** The branch reports that a client stopping its microphone also stalled a long model answer. GPT-Live needs a continuing input timeline even when the person sends nothing. Removing remote PTT remains correct; removing this provider input maintenance does not.
- **One loop per dial, driven by elapsed time.** Preserve the new single background task and wall-clock catch-up. The earlier tick chain repeatedly registered background work, and the first single-loop version drifted when sleeps ran late. Neither is the final design to port.
- **Keep clients simple.** Local microphone release/EOF can send no more PCM; the backend supplies digital silence. Do not reintroduce per-client silence loops, remote turn commits, or a new half-duplex wire protocol.
- **Extend proof rather than build another harness.** Keep the new microphone-off mode in the existing wire client and the answer-flow diagnostics. Add delayed-timer, long-answer, and stop-after-hangup checks; the newly added test only steps through punctual 100 ms ticks.
- **Forwarding the whole request is only half the opening test.** The complete request can finish before connection, be forwarded correctly, and still receive a truncated answer if the provider's input stops afterward. Acceptance must include the complete resulting answer while the device stays quiet.

## Problem Statement

The two branches each remove complexity, but combining them mechanically would put obsolete complexity back. Futurehomes consolidated board setup, gestures, microphone sending, and provider selection. The GPT-Live branch replaces the provider protocol and removes remote push-to-talk. Its new protocol invalidates much of the microphone and provider machinery that Futurehomes just consolidated.

Jonas wants the largest sensible simplification, with GPT-Live as the single voice model. The non-negotiable behavior is: **speak to an ESP32 immediately after waking it, before a call exists; preserve that speech and send it to OpenAI as soon as the call becomes usable, even if the entire request finished during connection.** Waiting for a ready sound before speaking must be unnecessary.

Today the device's capture/send gates can wait for remote call acceptance, while the new backend opens a call only on its first audio. Existing queues also have inconsistent overflow behavior, a roughly five-second device capacity, and a backend limit measured in messages despite variable message sizes. Those are correctness problems, not details to preserve in a refactor.

## Solution

Use the GPT-Live branch as the protocol and backend foundation. Fix pre-connection capture there first, then bring across Futurehomes' board/audio/build consolidation and useful hardware fixes selectively. Never port the new Futurehomes uplink or provider-mode frameworks. Extract the GPT-Live microphone drain into one small shared function for the CLI and ESP32. Delete model selection, provider paths, remote turn controls, obsolete connection workarounds, and duplicate proof tools with their callers and tests.

The final path is:

**Wake or local activation → capture immediately → local PCM FIFO → mounted device stream → backend handshake FIFO → GPT-Live → ordered speaker frames → shared playout → board audio.** While an established call's device input is quiet, one backend loop feeds GPT-Live digital silence.

There are two temporary audio queues because there are two independent connections. Keep the native queues already present. Do not add a durable audio store, third replay queue, generic queue framework, provider adapter hierarchy, or distributed exactly-once protocol. The CLI and ESP32 share the short drain function and playout policy, with separate native audio and transport adapters.

### Deletion and preservation ledger

| Area | Final disposition |
| --- | --- |
| Provider selection and persisted provider modes | Delete the new shared provider-mode module as well as its board callers, NVS adapter, mode announcements, mode assets, and mode tests. One canonical stream identity; backend configuration owns the model. |
| Grok, older OpenAI dialects, colleague routing | Take their deletion from the GPT-Live branch. Do not transplant Futurehomes' corresponding backend patches or diagnostics. Keep GPT-Live delegation to the configured backend; that is useful behavior, not provider compatibility. |
| Remote push-to-talk | Delete start/finish/cancel markers, turn sequence IDs used only for those markers, manual turn padding/commit logic, flush deadlines, maximum held-button turn lengths, and PTT mode selection. Keep the new provider silence input below. |
| Provider input continuity | Keep one dial-owned backend silence loop, its clock accounting, and its real half-duplex regression. Clients need no new silence generator or turn mode. The loop starts after the held speech drains and ends with that exact dial. |
| Automatic pickup greeting | Delete the voice client's greeting request and the backend pickup-greeting option/peak-threshold scan, including setup/docs/tests. The model responds to arriving speech; local wake feedback remains subject to the acoustic acceptance test. |
| Microphone implementation | Never port the five-state Futurehomes uplink or its CLI wrapper. Share the existing GPT-Live drain behavior, with a flush clock and minimal queue access. Native adapters retain queue/thread ownership. No separate catching-up/flushing state or replay pacer. |
| Call launch | Delete no-op start-call APIs, call-pending state, the launch ladder, pending expiry, obituary grace, and dial cooldown. Capture opens the call. Retain one opening deadline per independently failing connection owner, an activation-triggered liveness probe, and audible failure. |
| Activation identity | Replace unused microphone sequence/time metadata and the backend's 1.5-second suppression with one activation epoch. It identifies a whole conversation, not a model turn. End requests and keepalives target that epoch, including before call acceptance. |
| Callback recycling | Delete the always-false proactive-recycle query and counters/branches that only supported the removed platform batch limit. Keep initial callback registration and recovery from a demonstrated callback failure. Rename those operations to their actual purpose. |
| Board setup and build | Keep Futurehomes' board table, common target entry point, shared build/defaults/partition ownership, codec helpers, asset generator, and normalized gestures. Remove fields and hooks whose last consumer was a provider mode or turn protocol. |
| Hardware-specific behavior | Keep codec/I2S setup, AEC and reference channels, volume controls, wake word, physical mute, M5 clock ownership, display/head capabilities, and custom local-sound playback when required by hardware. |
| Playout | Keep one shared queue/priming implementation and GPT-Live's ordered speaker protocol. Remove duplicate owners and historical fallback timers, not the jitter buffer. |
| Proof tooling | Keep one command family for raw-provider baseline, host client, physical board, room recording, and fault scenarios. Extend the new wire-client microphone-off option and answer-flow reporting. Share fixtures/reporting; delete provider matrices and overlapping one-off harnesses. |
| Futurehomes platform/backend WIP | Review each fix against the GPT-Live base. Port a fix only when the final path still has its bug and a focused repro proves it. Preserve unselected work on the original branch; do not represent a selective integration as having landed every experiment. |

## Decision Document

### 1. Capture and connection are independent

Local activation opens the capture gate before Wi-Fi/session mounting/callback registration. This does not work on either branch today: move the gate outside the ready block and delete mount-time microphone/uplink resets. The transport can connect in the background as it does today. Sending depends on a usable stream, never on `conversation-accepted`. The first nonempty audio message triggers the backend's existing dial behavior. Call acceptance is a status/measurement event, not permission to capture or send.

Wake detection stays active outside a conversation. During a conversation the microphone and actual AEC path stay active on supported hands-free boards. No new always-connected OpenAI session or continuous idle microphone upload is required.

ESP capture already runs in its own task; preserve that separation. The host already uses nonblocking TCP/TLS and a polled resolver. Verify that the complete connection path and other work keep draining the short CoreAudio input ring; retain the existing audio engine unless a measured blocking stage requires changing that stage.

Cover the earlier acoustic boundary too: WakeNet detects asynchronously, and its notification currently carries no PCM boundary. Keep a short rolling window of processed PCM locally while awaiting wake, then retain that window and subsequent samples when detection occurs. Reuse the capture FIFO storage where practical; this is a bounded local pre-roll, not a third network replay queue or idle cloud upload. Start with 500 ms, then measure detection-to-capture delay and adjust before claiming a no-pause wake phrase works. Physical mute disables and clears this window. Capture must already own the accepted activation before its chime can interfere; keep the chime only if the board's reference/arbitration preserves simultaneous speech. Test saying “Jarvis, turn…” without pausing, including speech during the chime.

### 2. Keep only the necessary state and ownership

Keep the user's local intent to have a conversation, the transport's actual readiness, and whether the provider has accepted it. Do not duplicate those facts in separate launch, turn, provider-mode, and retry state machines. The shared drain owns only its flush-clock policy; native queues retain sample ownership. A gate closing does not create a remote turn.

Maintain one owner for each queued sample. Peek or stage a bounded batch, submit it, and remove it only when the local transport accepts ownership. Transport backpressure leaves the FIFO intact. A normal mount or acceptance transition never resets captured PCM. Backend handshaking follows the same ordering rule: buffered audio precedes new arrivals, and readiness wakes the drain without requiring another microphone event.

Add one activation epoch to microphone input, end requests, and keepalives; correlate accepted/ended/output events with it so late events cannot alter a newer activation. Increment it only when activating from idle, not on each hold-button press in an existing conversation. Keep the backend's conversation ID for its existing transcript/tool records. The client can cancel by epoch before it knows that backend ID. Clients request an end; only the backend records that it ended. Remove the client's fallback to a compiled-in conversation ID and its direct writing of conversation-ended.

The epoch must remain monotonic for the configured device stream across client restarts. Reserve a range at client startup in durable configuration, then increment in RAM per activation; do not write flash in the audio path. The backend's reduced state retains the accepted/closed epoch watermark across eviction. Duplicate/older epochs cannot open a call; an end received before the first audio closes that epoch too. A genuinely newer activation works immediately. A reset or restored client configuration must re-establish its epoch range/binding rather than guess or accept stale audio. Use one microphone writer per configured device stream; diagnostic clients use a separate stream. This is a small identity counter, not durable audio or an ACK journal.

Explicit end and backend-initiated end clear unsent microphone audio, close capture, and fence callbacks. Remove the 1.5-second blanket suppression and its timestamp. A newer activation must also supersede an older call still awaiting teardown, so an old end cannot close the new one. Remove the dial cooldown once one dial per live epoch and a failed epoch's terminal outcome prevent frame-rate redialing. Retain the existing dial identity fence for late socket callbacks.

A brief local talk-button release merely closes capture and lets the final samples drain; it is not hangup. Hardware mute closes capture and clears local history/unsent PCM immediately, and cancels the active epoch so the backend discards its held audio when cancellation arrives. Already delivered audio cannot be retracted; do not claim a stronger mute guarantee across a broken connection. Explicit end and failed opening return the device to its inactive/wake state with audible feedback plus a classified reason in health/logs, including on boards without a display.

### 3. Bound buffering in bytes and time, and make failures visible

Proposed starting budget: **21 seconds of mono PCM16 at 16 kHz = 672,000 bytes / 1,050 existing 20 ms frames**, allocated in ESP PSRAM; the same decoded-audio byte cap on the backend handshake queue. This replaces the draft's 30-second allocation. Backend base64 and object overhead and existing platform audio/control buffers count toward the memory proof. Read real free PSRAM/internal heap on every board before claiming this budget is supported. Allocation failure reports unavailable before claiming capture is ready. Avoid adding per-board overflow policies.

Use a **20-second total opening deadline from activation** and one **15-second backend opening deadline from first-frame mint**, covering the awaited provider upgrade and handshake. These independently bound the device's whole opening attempt and the backend's own work; they are proposed limits to validate, not measured latency claims. The 21-second FIFO allows the proposed 500 ms pre-roll plus scheduling margin. A quiet hold-button board starts this opening attempt on its first capture activation, not by opening an empty call UI.

Do not overwrite the opening words or silently drop the newest speech. Keep an overflow guard: an opening deadline cannot prevent overflow during an established congested call or a delayed timer. Exhaustion uses the existing failed-conversation path with a specific reason and missing-audio count; do not invent an error-class hierarchy. Clear the failed epoch and require a new activation. This guarantee covers an opening attempt while the process stays alive, within the documented deadline/budget. It does not promise audio survival through power loss, process eviction, or arbitrary network disconnection. An evicted backend with an unfinished call must settle it as interrupted, not silently redial a provider whose volatile speech was lost.

Preserve definitely unsent input during ordinary connection progress. After ambiguous delivery or loss of an established provider session, end the affected conversation with a classified failure rather than blindly replaying commands. There is no new ACK journal, reconnect replay protocol, or automatic re-execution of captured requests. Existing platform connection recovery may prepare the next activation; it must not create an endless voice-call retry loop.

### 4. Share cadence and drain the backlog promptly

Use the GPT-Live branch's 50 ms normal flush deadline in the common sender. A partial batch must go when due or capture ends; the CLI must not wait for eight frames (160 ms) during normal input. Keep the existing 160 ms maximum payload as the starting batch bound, not as a minimum or a second timer.

On readiness, begin draining immediately, in FIFO order, without waiting for new speech. Preserve the ESP sender's existing fast path: a full batch drains on each eligible loop pass while behind, subject to transport headroom; partial steady-state batches obey the 50 ms deadline. Do not add the draft's 160-ms-per-50-ms catch-up limiter. Extract this behavior once for both clients instead of copying the code and letting the policies drift again.

Keep the backend's synchronous FIFO flush on session.started. Do not add a backend replay timer: synchronous draining already prevents later input overtaking held frames. Keep bounded payload sizes rather than concatenating the entire backlog into a huge append. The PR reports raw-wire evidence that larger input appends stall simultaneous output; it does not prove that an extra replay pacer improves opening latency. Measure long held-queue replay with live-probe before changing the existing approach.

Keep the final short PCM payload, padded base64 correctness, and the fixed 16 kHz mono format. Do not add format negotiation for a single model. Record queue depth in milliseconds, oldest-sample age, opening stage, capture-to-first-send, and first provider/speaker audio so latency has a causal explanation.

#### Preserve one continuous provider input

Keep the new backend silence loop, using the current 100 ms digital-zero chunk as its measured starting point. Start it only after session.started has synchronously drained held microphone audio and reset the input accounting at that handoff. A completed pre-connection utterance must be followed by continued provider input even when no further device frame arrives. Silence must never replace, overtake, or justify discarding captured speech.

Keep all provider appends behind the existing send helper and all filler state inside the dial. There is at most one background task per dial, including duplicate readiness and recovery events. Register it once, let it sleep internally, and stop it on end, failed dial, or replacement. Do not schedule a fresh managed background task per tick: the branch measured repeated KV/alarm work and 52 underruns from that shape.

Use elapsed time to account for late wakeups; sending one 100 ms chunk after every sleep can run the provider's input clock too slowly. Preserve this correction, but bound the amount of synchronous catch-up work and the maximum recoverable delay. If the input clock cannot recover within a measured finite budget, end with a classified failure rather than burst indefinitely or silently discard the timing debt. Choose that bound with the long-answer/late-timer tests; the current unrestricted debt loop is a starting implementation, not acceptance evidence.

Do not conflate audio sent to the provider with proof that the device is alive. Synthetic silence does not refresh device activity, mint a call, re-arm a failed epoch, or replace the client's keepalive. Keep the provider-input accounting separate from the existing real-device idle deadline. Test variable microphone payload durations and irregular arrival against the filler so it neither duplicates large spans of silence nor clips late speech. Any necessary input-clock metadata stays narrowly scoped to this behavior; do not revive a generic turn protocol.

### 5. Remove product PTT, preserve physical limitations

Satellite1, HAVPE, Stackchan, and Mac with functioning VoiceProcessingIO use hands-free conversation. HAVPE's rotary control becomes volume-only; preserve its quadrature decoder when deleting the provider-mode wheel. Stackchan loses the provider menu, not its face and motion capabilities.

M5StickS3's microphone and speaker currently share clocks in a way that requires half-duplex I2S ownership. Waveshare currently has no acoustic echo cancellation. Replace the old turns enum and runtime setters with a fixed board capture fact: hands-free or hold-button. Key wake-word enabling on that fact so deleting the old turns enum does not accidentally disable wake.

On both constrained boards, hold speaker playout while capture is open. M5 already needs its physical clock fence; add the equivalent playout hold to Waveshare, whose old remote-PTT commit previously prevented an answer during a held button. GPT-Live can answer during a pause while the button is still down. Resume queued playback on release. Apply the existing finite speaker budget: an overlong hold that exhausts it fails visibly, rather than playing into the microphone or silently truncating output. The all-five-board support scope stays intact; no new remote turn protocol is introduced.

On release, drain the already captured tail through the common sender. Wake and local sounds must use the real board audio arbitration. Preserve physical mute and usable volume buttons. Do not silently fall back from failed AEC into an unqualified hands-free mode; surface the initialization failure or use an explicitly selected diagnostic mode.

### 6. Keep the transport and playback mechanisms that have evidence

ESP32 task synchronization and the host CLI's single-owner native transport are different platform implementations. Share protocol/sender/playout behavior, not their thread ownership or fake an ESP runtime on the Mac.

Keep the PR's 300 ms elapsed-time speaker priming and end-of-answer fast path as the starting playout policy. Preserve ordered frame handling, arbitrary-sized output PCM splitting, final partial output, fresh-dial speaker clearing, bounded underrun handling, and reference audio for AEC. Do not reintroduce the removed 150 ms stall-start heuristic or add a server speaker pacer.

Keep the call keepalive and actual connection-level liveness needed to support a quiet open call. The provider silence loop maintains audio input; the client keepalive proves an intentionally open UI; transport probes detect a broken connection. These have distinct jobs. Remove overlapping application heartbeats only after tracing their failure targets. Retain failure-driven callback re-registration; delete historical scheduled recycling. Natural model turn-taking does not replace input continuity, audio buffering, transport failure detection, or physical echo cancellation.

### 7. One backend configuration and one migration


Take the GPT-Live contract, tools/delegation behavior, raw-wire integration, ephemeral-event checkpoint correction, and latest single-loop wall-clock silence input from the PR. The latter is already implemented on the other branch; preserve and harden it rather than proposing it as new work. Limit backend edits here to opening/lifecycle/input-continuity invariants and independently reproduced platform defects.

Remove automatic pickup greetings as part of early-audio correctness. A silence-only first batch does not prove that the user has not started speaking into the device backlog. Deleting this optional behavior and its speech-peak heuristic is simpler than adding another signal to coordinate greetings with queued audio. Preserve spoken responses to the user's input and backend tool results.

The activation epoch requires a contract bump beyond 21. Update every writer/reader together: firmware, host CLI, mobile voice-call client, direct wire-call/tap/bench tools, setup, and fixtures. The mobile app is present on the GPT-Live branch and must not be omitted merely because the primary acceptance case is an ESP32. Its own local capture UI can remain; remove obsolete wire fields and apply the new lifecycle rules.

Remove old client setup keys and provider-path selection at their sources. Update installed voice configuration once to the canonical stream and contract; validate expected capabilities before changing a device's saved stream identity. Ignore obsolete mode NVS keys; do not erase Wi-Fi, provisioning, or unrelated settings. Reject an incompatible voice protocol visibly instead of adding a permanent old/new adapter. Pin matching firmware/mobile/backend artifacts for rollout and roll back compatible sets. Do not move existing users onto the new contract while their installed client is incompatible.

## Commits

These are reviewable implementation slices, not instructions to commit now. Use an isolated integration branch rooted in the GPT-Live head; preserve both source branches. Each accepted slice builds and keeps the relevant existing behavior passing. Add a regression beside the fix that makes it pass, not a permanently red commit.

1. **Fix the opening journey on the GPT-Live base first.** Inventory the source branches and existing contract users, then move ESP capture outside the ready gate, delete mount-time microphone resets, and size the existing queue. Add the host intent regression that speaks before mount. Use HAVPE on this base; bring Satellite1 with its required board dependencies in slice 7 before claiming its bench proof. No port of Futurehomes' uplink is needed to make this fix.
2. **Add the epoch and cancellation boundary as one vertical change.** Update backend, C client, mobile, and proof tools in the same contract slice. Include boot-safe epoch allocation, durable accepted/closed watermarks, end-before-acceptance, far-end end, stale-frame rejection, and immediate reactivation. Clear queues on a real end, retain pre-roll on activation, and delete the time-based suppression. Verify malformed/stale epochs cannot refresh a newer call's keepalive or speaker state.
3. **Simplify backend opening and retain input continuity.** One deadline from mint, including upgrade and handshake; byte-bound the hold queue, handle call-start recording failure visibly, and keep synchronous FIFO replay. Preserve the latest one-loop silence filler and add delayed-timer/lifetime tests before deleting turn machinery. Bound exceptional catch-up without reintroducing timer chains. Remove the dial cooldown and greeting. Settle a lost incarnation's unfinished call as interrupted. Test a wholly buffered request followed by a complete answer with the microphone off, plus canceled opening, failed dial, and eviction.
4. **Delete the launch ladder.** Remove no-op start-call, pending/expiry/obituary-grace state, and their tests. Retain the device's one opening deadline and re-arm the existing press probe directly on activation. Failure produces audible feedback and a reason. Keep initial callback registration working.
5. **Extract the proven microphone drain and adopt it in the CLI.** Share the ESP's clock-driven partial flush and headroom-driven fast drain; retain native queues. Delete CLI turn/flush timestamps and tail timeout. Verify host capture survives connection progress and short input files deliver their final samples. Remove old microphone metadata from proof reporting as part of the epoch migration.
6. **Delete modes and remote PTT remnants together.** Replace turns policy/setters with a fixed capture fact and update wake eligibility. Remove provider menus/persistence/sounds, mode-dependent stream switching, marker/turn interfaces, and tests with their consumers. Keep HAVPE quadrature and volume. Add Waveshare's playout hold, retain M5 arbitration, and prove both before release. Do not import Futurehomes' mode framework just to delete it.
7. **Integrate the Futurehomes hardware/build consolidation.** Port common targets/defaults/partitions, board descriptions, codecs, normalized gestures, real audio/volume fixes, and Satellite1 as dependency-complete changes adapted directly to the smaller interface. Include affected loop adapters with their board table changes so intermediate targets build. Add the short processed pre-roll and timestamped wake handoff to the actual final WakeNet path; verify no-pause speech and chime behavior on HAVPE and Satellite1. Never port obsolete uplink/mode helpers or temporary compatibility scaffolding.
8. **Delete remaining dead transport code and consolidate proof tools.** Remove proactive-recycle queries and their counters; name initial registration and failure-driven re-registration accurately. Keep quiet-call keepalive, provider silence input, necessary liveness probes, and shared playout. Preserve the new microphone-off wire-client scenario. Promote useful answer-flow diagnostics into the existing report: separate provider-receive span/count from non-silent speaker-frame duration and per-request timing. Port a Futurehomes platform/backend fix only with a surviving repro; record keep/superseded/unrelated for each change.
9. **Validate and prepare a coordinated rollout.** Run focused host/sanitizer/backend/mobile checks, all-five-board builds, preview acceptance with coherent traces/state, and the required acoustic cases. Update firmware/CLI/backend/mobile docs and the board skill together. Record exact artifacts and missing bench coverage; do not ship an incompatible backend/client pair or call missing hardware evidence a pass.

Slices 1–5 establish the core behavior before the wider board consolidation. Steps 2 and 6 deliberately change their consumers together; split other dependency-heavy ports when it leaves all affected targets working. No temporary old/new protocol framework is needed.

## Testing Decisions

Use deterministic audio carrying a distinguishable prefix, middle, and short tail; observe bytes received at the provider boundary, not only counters or mock calls. Existing host fake-clock, voice-loop intent/answer-clock, playout, backend processor, and mobile voice-call tests provide the harnesses. Do not retain the old uplink test subject merely to reuse its fixtures. Replace obsolete turn/mode tests with final behavior tests; do not preserve deleted APIs for their tests.

| Acceptance case | Required evidence |
| --- | --- |
| No pause after wake word | Record a continuous wake word plus command, with a distinguishable first command syllable. Under wake-worker/app scheduling load and during the chime, verify the provider receives that syllable. A synthetic button tap alone does not cover this case. |
| Entire request before stream mount | Delay mount by 3 seconds, speak a 2-second phrase immediately, stop, then connect. Provider receives the complete ordered phrase without another utterance. Repeat with a delay approaching the opening deadline. |
| Entire request before OpenAI readiness | Keep the stream ready but delay provider start by 5 seconds. Verify every input sample and exactly one call under a successful opening; first held send begins on readiness. |
| Finished input, complete answer | Finish a short request before connection, remain silent or reach source EOF, then let the model produce a long answer. Verify the entire request and answer with no second utterance. Run the existing microphone-off wire-client scenario, CLI file input, and constrained board behavior; receiving only the first spoken numbers is a failure. |
| Both stages slow, continuous speech | Delay stream and provider independently within the total budget. Verify FIFO across both transitions and sustained capture, with no live audio overtaking the prefix. |
| Tail and cadence | A partial batch and short final payload arrive; CLI and ESP adapter traces obey the same 50 ms normal deadline. Two seconds of queued audio begins immediately and, with no more capture/backpressure, finishes within one second after the relevant connection becomes ready. Backend held input is sent in the readiness handler. Trace long backlogs with the real provider; add no pacer without proof. |
| Backpressure, limits, and memory | Transient local submission refusal preserves bytes; overflow/deadline/allocation failure produce one classified outcome, no silent truncation or retry storm. Vary payload lengths so a message-count cap cannot accidentally pass. Measure board PSRAM and backend/base64 overhead. |
| Lifecycle races | End before the first mic frame, end before acceptance, mute, far-end hangup, late speaker/end events, and immediate wake cannot resurrect a closed epoch or close a new one. Reboot the client and evict the backend with the same configured stream; closed epochs remain closed and a new activation works. Verify counter recovery/rebinding and concurrent-writer refusal. Already delivered PCM cannot be retracted; do not claim exactly-once delivery through disconnection. |
| Silence timing and lifetime | Step the clock by irregular intervals, not only 100 ms ticks. Verify elapsed-time filling, bounded recovery from a long stall, one task per dial, no registration per tick, and no writes after end/replacement. Mix 20/50/160 ms real payloads with late arrivals; preserve every captured sample and separate real-device activity from synthetic input. |
| Quiet calls and recovery | Keep a quiet call open beyond 60 seconds with real client keepalives and no mic PCM. Then remove both real input and keepalive: provider silence must not prevent idle closure. Verify bounded failure recovery and no connection churn. |
| Physical audio | Satellite1 and HAVPE: wake and speak before ready, normal conversation, barge-in, echo/reference stability, volume/mute, and reconnect failure. M5/Waveshare: gate/arbitration tests and actual bench proof of an answer arriving while held, playback on release, and a hold exceeding the finite speaker budget. Builds alone do not authorize the Waveshare behavior change; absent hardware, record a release blocker. Stackchan: build and regression coverage for face/head/sounds; bench proof before claiming new physical behavior. |
| First response comparison | Direct API, host pipeline, and physical board use the same fixture/config and comparable continuous or microphone-off input behavior. Separate input-end→first-provider-PCM from input-end→audible-playout; also prove the answer finishes. Report provider delta counts/spans and speaker-frame duration in matching request windows, since provider silence deltas alone do not prove an audible answer. Show cold/warm repeated samples and account for 300 ms priming, upload catch-up, and backend/tool execution. |

The functional criterion is no lost opening speech inside the declared bounds. The performance criterion is immediate drain initiation, the explicit cadence/drain bounds above, and no unexplained latency relative to the GPT-Live baseline. Report a distribution and traces, not a single fastest sample. Preview proof is required for operational changes; five builds alone are not five-board acoustic validation.

## Out of Scope

- Replacing GPT-Live's backend delegation/tools or implementing a second provider.
- Always-on idle cloud transcription, boot-before-provisioning speech, or audio persistence across device reboot and backend eviction.
- New distributed audio ACK/deduplication infrastructure or transparent continuation through an ambiguous disconnected call.
- Removing a supported board, changing its electronics, or claiming full duplex without acoustic/electrical proof.
- Unrelated platform WIP, retuning gains/volume limits without evidence, and broad UI restyling.

## Further Notes

The largest deletion is not a new abstraction: it is making provider selection and remote turn management cease to exist. The shared drain should be a small extraction of proven code, with no new queue ownership or sender state machine. Judge success by fewer independent policies and states, preserved behavior, and evidence for remaining mechanisms—not by deleting the most lines regardless of what the hardware needs.
