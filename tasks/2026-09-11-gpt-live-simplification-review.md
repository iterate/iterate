# Claude Fable adversarial review and disposition

Review requested by Jonas, completed 2026-09-11 using local Claude Code 2.1.257 with `--model claude-fable-5-1 --effort xhigh`. The response containing this report identifies its model as `claude-fable-5-1`; the initial session metadata and final model usage also confirm it. Session: `000869ec-34cd-4014-8ac4-fa654e595130`. The reviewer had only Read, Grep, and Glob, with access to both source worktrees and the initial plan. It completed successfully in about 11.6 minutes.

The reviewed draft's SHA-256 is `037fa7368b4d41e1869886efa22f94f7578ef1ead1b1fb9d50ade141e74e10a0`. Its immutable local copy and raw CLI transcript are under `/tmp/gpt-live-plan-review/`. The revised plan incorporates the disposition below; Claude has not approved or re-reviewed that revision.

## Later worktree refinement

On 2026-09-11 at 13:39 UTC the plan was refreshed against voice branch `454cb43adf433996fa936a6ed56630a0bf0da4ac` and uncommitted answer diagnostics. This happened after the Claude review below. The new branch evidence changes one important deletion decision: retain the backend's single, elapsed-time-driven silence-input loop so a quiet client can receive a complete answer. Remove only the old remote-turn padding/commit mechanisms. The refreshed plan adds drift, task-lifetime, no-device-idle, and long-answer tests and preserves the new half-duplex proof scenario. No claim is made that Claude reviewed this later code or that the fresh branch measurements were independently repeated here.

## Author's disposition

The review meaningfully reduced the plan: no extra replay pacer, no port of Futurehomes' new uplink or provider framework, no pickup greeting, no launch ladder/call-pending/obituary grace, no dial cooldown after epoch fencing, and no obsolete microphone sequence/time fields. It also made pre-connection capture the first change.

| Finding | Disposition in the revised plan |
| --- | --- |
| Blockers 1–2: capture gate and mount reset | Accepted. Fix both on the GPT-Live base before broad board consolidation. Add a regression with the entire phrase before mount. Keep the native ESP capture task and queue. A real end clears PCM; an activation retains the chosen pre-roll instead of clearing it. |
| Blocker 3: epoch required | Accepted and strengthened. A RAM-only integer is insufficient across reboot or backend eviction. Allocate boot-safe epoch ranges for the configured device stream and retain the accepted/closed watermark in reduced backend state. Tag end/keepalive and correlate downstream events too. End before acceptance must target the epoch because the backend's conversation ID is not yet known. Close an epoch even if cancellation precedes its first audio. No audio journal or replay ACK protocol. |
| High 4: extra replay pacing | Accepted deletion of both proposed catch-up limiters. Keep the current full-batch fast drain and synchronous backend FIFO flush. One source correction: PR #2624's “Playout: the stall” section does report raw-wire input-burst experiments. The review did not have the PR body and its claim of no such evidence is too broad. Those experiments justify bounded appends and a measurement of long handshake replay, not an unproven second pacer. |
| High 5: budget and overflow | Partly accepted. Reduce 30 seconds to a proposed 21-second FIFO (672 KB) around a 20-second device opening deadline, with pre-roll/scheduling margin. Start the one backend deadline at first-frame mint. Reject the claim that a deadline makes overflow impossible: an established call can congest, and a timer can run late. Retain byte-based admission and a visible failure using the existing end/fault path; a counter plus silent loss is inadequate. Read actual per-board memory before finalizing the allocation. |
| High 6: greeting | Accepted. Delete it and its held-audio speech-peak heuristic. The local chime itself still needs acoustic verification; it is not proof that the first words survived. |
| High 7: Waveshare playout | Accepted. GPT-Live can answer while a local hold remains down. Fence Waveshare playout during capture, preserve M5's hardware arbitration, test delayed playback and overflow of the finite speaker queue. Actual bench proof is required before shipping the change. |
| Medium 8: CLI tails and duplication | Accepted removal of turn/flush deadlines, latest-wins loss, and the eight-frame minimum. Reject copying the ESP block into the CLI: the existing copies already diverged (50 ms versus roughly 160 ms). Extract the small proven drain function once; do not create a new queue owner or five-state sender. |
| Medium 9: host connection blocking | Keep the acceptance test, without assuming a second capture engine is needed. Follow-up source inspection found nonblocking TCP, TLS WANT_READ/WANT_WRITE, and a polled DNS-SD resolver. Verify the real loop continues consuming audio under a slow connection and other work; change a blocking stage only if the test shows one. |
| Medium 10: vestigial launch | Accepted. Delete launch/start-call/pending and redundant timers, keep the activation-triggered press probe, and distinguish callback registration from failure-driven re-registration. |
| Medium 11: sequencing and wake eligibility | Accepted. Core behavior first; delete modes and remote-PTT policy together, replace the wake-policy key with a fixed capture fact. Additional correction: Satellite1 exists in Futurehomes, so do not promise it can be bench-tested on an unported GPT-Live base. Use HAVPE first and bring Satellite1 with its dependencies. |
| Medium 12: silent failure feedback | Accepted. A failed opening produces audible feedback and an observable reason, including on lightless devices. |

Additional checks after the review:

- **Wake detection is an earlier boundary than activation.** Futurehomes has an asynchronous WakeNet worker, a boolean detection, discarded idle PCM, and a chime played during board polling. The reviewed draft did not cover this fully. Add a short processed local pre-roll, timestamped handoff and a real “Jarvis, turn…” test without a pause. The review's statement that the chime is harmless and capture is already open is not sufficient evidence for this path.
- **The contract also has a mobile consumer.** The GPT-Live mobile voice-call client, wire-call/tap tools and their tests emit the same events. Include them in the epoch contract change and coordinated rollout; firmware-only testing would miss incompatible installed clients.
- **Cancellation has physical limits.** Clearing the device FIFO cannot recall PCM already held by the backend. Cancel the epoch there too, and state that audio already delivered before cancellation cannot be retracted through a broken connection.
- **No unsupported exactly-once recovery.** Close an interrupted generation on backend eviction/session loss rather than silently rebuilding a provider session that lost volatile input. The durable epoch watermark prevents a stale tail from turning that failure into another call.
- **Scope remains selective.** The review did not diff Futurehomes' broad backend/platform WIP. The plan's source inventory and per-fix reproduction/disposition step remain necessary; the review is not an endorsement of those experiments.

Remaining implementation gates are measurements, not a request for more product decisions: free memory on all boards, no-pause wake/chime capture, long provider backlog replay, host loop cadence, and M5/Waveshare acoustic arbitration. The plan preserves all five boards and labels missing bench evidence as incomplete acceptance.

## Original Claude report

The following report is preserved verbatim.

## Verdict

The plan points the right way: GPT-Live as the base, delete provider modes, remote push-to-talk, and the launch ladder. It misjudges the core requirement in two ways. First, it treats "capture before connection" as a policy to preserve, but neither branch does it today: both gate the microphone flag on a mounted stream and both wipe the microphone queue when the mount starts. Second, it builds too much to fix that: a shared sender, a catch-up pacer, a byte-capped overflow failure class, and a 30 s preallocation. The fix is one flag moved out of a gate, two resets deleted, one queue resized, and one small field on the wire.

**Minimal architecture I recommend.** Device: capture task pushes into the existing PSRAM FreeRTOS queue whenever the activation flag is set. The flag is set at the wake or press edge, outside any connection gate. The existing GPT-Live flush block is unchanged: send when 50 ms are due or a full batch is queued, gated only on the stream being mounted and outbox headroom. Backend: the existing mint-on-first-frame, hold queue, and synchronous flush at session.started, with an activation epoch on each frame replacing the 1.5 s time guard, and one deadline from mint. Everything else in the plan's Decision 2 through 4 is either already present in GPT-Live or should not be built.

## Findings

Verified means I read the lines cited. Hypothesis means it needs a measurement.

**Blocker 1. Pre-connection speech is discarded on both branches.** Verified.
- Evidence: `/Users/jonastemplestein/.herdr/worktrees/iterate/voice-templestein/apps/kit/firmware/components/voice/src/voice_loop.c:1637` drops every captured frame while `talking` is false. That flag is only assigned at line 3652, inside the block opened at lines 3318 to 3320, which requires the voicelab to be READY, the transport READY, and generations to match. Futurehomes is the same shape: the uplink step at `/Users/jonastemplestein/.herdr/worktrees/iterate/futurehomes/apps/kit/firmware/components/voice/src/voice_loop.c:3549` sits inside the gate at lines 3332 to 3334, and lines 3321 to 3325 additionally reset the uplink whenever the voicelab is not READY.
- Consequence: wake, speak, transport comes up 8 s later, and the model hears nothing. The profile comment at `voice_device_profile.h:67-71` in the GPT-Live tree records exactly this cold-start loss and sized the queue for it, yet the flag gate makes that queue unreachable before mount.
- Plan change: this is the first commit, not slice 6. Compute the activation flag before the ready gate. The capture task is already independent of the app task, so the "same executor" worry in Decision 1 does not apply on ESP. The host intent test can drive it: `speak_frames` at `voice_loop_intent_test.c:281-284` runs capture steps against the fake FreeRTOS queue in `tests/fakes/esp_idf/fake_esp_idf.c:224-292`. Today every test mounts first, per the comment at line 696.

**Blocker 2. Mount wipes the queue.** Verified.
- Evidence: GPT-Live `voice_loop.c:3266` resets the mic queue when the voicelab mount starts. Futurehomes `voice_loop.c:3268` calls `reset_uplink()` at the same site, which clears the queue at line 688.
- Consequence: even with Blocker 1 fixed, a remount during the opening window destroys the utterance silently.
- Plan change: delete both resets. Legitimate resets are only the activation edge, explicit end, and hardware mute.

**Blocker 3. Existing identities cannot separate a stale tail from an immediate re-activation after a far-end hangup.** Verified.
- Evidence: mic frames carry no conversation id by design, `voicelab_stream.c:1077-1082`. The backend discards, not holds, any frame within 1500 ms of an end when no call exists, `voice-agent.ts:1204-1209`. The device keeps draining `queued > 0` after the flag drops, `voice_loop.c:3735`, and the CALL_ENDED arm at lines 1097 to 1136 never resets the mic queue. Nothing in the backend reads the frame's `seq` or `t` fields; only `apps/os/scripts/voicelab/bench.ts:62-72` does.
- Consequence A: the model says goodbye and hangs up, the person immediately re-wakes and speaks, and the first up-to-1.5 s is lost. That is prefix loss. Consequence B: if you simply delete the guard, frames already in the outbox arrive after the backend's own obituary and mint a zombie call, the 171 ms case in the comment at lines 1200 to 1202. For backend-initiated ends the device learns a round trip late, so no device-side clearing can prevent B.
- Plan change: the plan's "add a field only if a failing race test proves it" is already proven by source. Add an `epoch` integer to the mic frame, incremented at each activation from idle, replacing the unread `seq` and `t`. Backend remembers the epoch that minted the ended call, drops frames of that epoch on a null call, and mints on any newer epoch. Delete the time guard and `#conversationEndedAtMs`. Device clears its queue on explicit end and on CALL_ENDED. No conversation id on frames, no ACKs.

**High 4. The proposed catch-up pacer is a second pacer.** Verified.
- Evidence: the ESP sender sends a full batch on every 5 ms pass while `behind`, `voice_loop.c:3725` and `3737`, throttled only by the outbox reserve at line 3738. The profile documents the socket's sustained rate at lines 118 to 122 and the reserve at line 41.
- Consequence: the outbox already bounds catch-up at roughly two to four seconds of audio per second, measured rather than designed. A 160 ms per 50 ms rule adds a rule and can only be slower.
- Plan change: delete Decision 4's catch-up policy and the backend replay pacer. The backend flush at `voice-agent.ts:1581` is FIFO by construction because it runs synchronously before any later frame is handled. I found no repository evidence for "burst-induced output stalls"; the only burst text in that file, lines 18 and 75, describes the output direction. Do not cite it. If you suspect the provider chokes on a large replay, measure with live-probe first.

**High 5. Budgets: make the buffer equal the deadline and delete the overflow failure class.** Verified constants, memory is a hypothesis.
- Evidence: mic queue 256 frames in PSRAM, `voice_loop.c:2694`. Speaker ring 320,000 bytes, profile line 158. Backend hold cap is 500 messages, `voice-agent.ts:433`, dropped silently at line 1242. Handshake deadline starts after socket adoption, lines 1338 to 1339, while the awaited upgrade at line 2414 is unbounded and the 5 s dial cooldown at lines 238 and 1296 can leave a minted call undialed until the next delivery.
- Plan change: one opening deadline D on the device, and a FIFO of exactly D × 50 frames. Then the deadline always fires before overflow and the "overflow → classified failure" path cannot occur and need not be written. Backend: one deadline from mint covering cooldown, upgrade, and handshake, and keep the hold cap only as a defect guard with a counter.

| Device FIFO | Frames | PSRAM |
| --- | --- | --- |
| Today | 256 | 164 KB |
| 15 s | 750 | 480 KB |
| 20 s | 1,000 | 640 KB |
| 30 s (plan) | 1,500 | 960 KB |

All five targets enable SPIRAM via `targets/common/sdkconfig.defaults:5` in the Futurehomes tree, but chip sizes are not in config. Read free PSRAM from health on each board before choosing. 15 s matches the 10 s connection-open timeout plus mount slack and covers the measured 8.3 s cold start.

**High 6. The greeting is a noise gate and collides with the requirement.** Threshold verified, room levels a hypothesis.
- Evidence: `SPEECH_PEAK = 100` on int16 at `voice-agent.ts:173`, about −50 dBFS, applied to held frames at line 1580. Default off at line 581.
- Consequence: on a physical board, ambient noise likely trips it, so the greeting never fires there. In a quiet room it fires, and a person who starts talking just after session.started is talked over.
- Plan change: delete the greeting and the peak check. The user asked to speak immediately, which makes a pickup greeting an anti-feature. The local wake chime at `board.c:397` already gives an acknowledgement.

**High 7. Server VAD changes what the hold-button boards do while held.** Verified.
- Evidence: under the old wire PTT the model never answered before commit. GPT-Live's VAD ends the turn while the button is down. M5 fences playout while the mic owns pins, `voice_loop.c:1450-1455`, and frames wait in the ring, while local sounds are dropped per `m5sticks3_audio.h:77-80`. Waveshare has no fence, `waveshare_device.c:359-360`, and no AEC, lines 104 and 376.
- Consequence: M5 plays the answer after release, bounded by the 10 s ring. Waveshare plays the answer into an open microphone and the model hears itself.
- Plan change: give Waveshare a trivial `playout_fenced_out` that holds playout while the local gate is open, reusing the M5 hook. Bench-prove both, as the plan already requires for any posture change.

**Medium 8. The CLI drops tails and cancels turns.** Verified.
- Evidence: waits for eight frames unless finished or flushing, `targets/host_cli/main.c:1477-1478`. Drops the tail after the 1500 ms flush deadline, lines 1587 to 1593. Cancels a turn on transport FAILED or STOPPED, lines 1620 to 1623. The host microphone is always latest-wins, `cli_microphone.c:52-54`, unlike the ESP's keep-oldest before ready at `voice_loop.c:1663-1666`.
- Plan change: copy the ESP flush block into the CLI verbatim rather than writing a shared sender module. Delete `flushing_turn`, the flush deadline, the turn timestamps, and the two turn constants at profile lines 234 to 235. Make the host queue refuse when full and count, matching the device.

**Medium 9. Host pre-connect capture may be lost in the loop, not the queue.** Hypothesis.
- Evidence: the Darwin input ring is 32 frames, `darwin_audio_input.h:78`, and only the main loop drains it, `main.c:1403-1426`. I could not confirm whether the POSIX transport connect blocks that loop.
- Plan change: before claiming host coverage of "entire request before mount", either confirm the connect is non-blocking or push from the CoreAudio callback directly into the FIFO.

**Medium 10. The launch ladder is already vestigial on GPT-Live.** Verified.
- Evidence: the step enum has only NOTHING and PLACE_CALL, `conversation_launch.h:46-51`. `start_call` only sets `call_pending`, `voicelab_stream.c:1328-1347`. A 20 s pending expiry at `voice_loop.c:3486-3492`, the 1500 ms obituary grace at 3503 to 3505 and 3617 to 3619, and the press probe armed only from PLACE_CALL at 3551. `needs_recycle` always returns false, `voicelab_stream.c:626-631`, while `recycle_connection` at 633 to 668 is the initial callback registration.
- Plan change: delete the launch module, its test, `start_call`, `call_pending`, the pending expiry, and the obituary grace. Re-arm the press probe at the activation edge, since it remains the only sub-10 s detector of a half-open socket at the moment a person is waiting. Rename `recycle_connection` to what it does and delete `needs_recycle` with its callers.

**Medium 11. Sequencing leaves broken intermediate states.** Verified against the plan text.
- Slices 1 to 3 port the board table before the requirement is demonstrable, and slice 4 hardens a backend path no device exercises until slice 6. Slice 8 deletes provider selection before slice 9 deletes PTT, leaving HAVPE's wheel at `havpe_device.c:125-137` selecting a posture that no longer exists. Merge those two.
- Wake-word enabling is keyed on the turns policy at `board.c:273`, `348`, and `374` in Futurehomes. Deleting the policy enum without replacing that key disables wake on every board.

**Medium 12. Failed mounts cancel intent silently on lightless boards.** Verified: `voice_loop.c:3303` clears `wants_call` on voicelab FAILED with only a status string. Play the end chime there so the failure is audible.

## Simplifications, gotchas, order

**Whole deletions beyond the plan.** Each removes a module or state rather than trimming it.
- The `turns` policy enum, `iterate_kit_voice_loop_set_turns`, and `iterate_kit_board_set_turns`. Replace with one board fact, hands-free or hold-button, and key wake-word enabling on it.
- Both mode systems: Futurehomes `provider_mode.[ch]`, `provider_mode_nvs.c`, and GPT-Live's HAVPE mode table with its NVS store and sounds, plus `stackchan_modes` after checking it holds no gesture logic.
- Futurehomes `voice_uplink.[ch]`, `cli_uplink.c`, and their tests. Never port them.
- The greeting, `SPEECH_PEAK` on held frames, and `heldMicFrames` speech detection. Keep `heldMicFrames` as a count.
- `seq` and `t` on the mic frame, replaced by `epoch`. Update `bench.ts` to read the epoch and arrival time instead.
- The backend time guard, `#conversationEndedAtMs`, and the dial cooldown. A failed dial ends the call, CALL_ENDED clears device intent at `voice_loop.c:1130`, and a new dial then requires a new activation, which is the rate limit.
- CLI turn state: `flushing_turn`, flush deadline, released/committed/answer-seen stamps, and the two turn constants.
- Tests to remove with their subjects: push_to_talk, conversation_launch, provider_mode and provider_mode_nvs, voice_uplink, cli_uplink, havpe_modes. Replace with the acceptance cases below.

Qualitative impact: three state machines disappear from the device loop, one from the CLI, one from each board with a mode wheel, and the backend loses two timers. Nothing hardware-specific is touched except the Waveshare playout hold.

**Gotchas and acceptance cases.**
1. Wake, speak 2 s, stay silent, transport READY at +8 s. Provider receives the whole phrase. Health shows `mic_frames_idle` flat during the window and zero drops.
2. Same with stream mounted and a slow dial. Backend reports held frames and the input transcript contains the phrase without a second utterance.
3. Voicelab FAILED and remount mid-utterance. Phrase survives or the end chime plays. Never silence.
4. Model hangs up, person re-wakes within 1 s. New call minted from the first frame of the new epoch, no dropped prefix, no zombie from the old epoch.
5. Button end, then immediate re-wake. Device FIFO cleared, obituary precedes any frame on the ordered socket.
6. Hardware mute during opening. FIFO cleared, nothing uploaded on unmute.
7. Second activation while the first is opening. Hands-free boards cannot, since wake is disabled while a call is wanted at `board.c:347-348`. Hold-button boards: release drains the tail, a new press in the same call keeps the epoch. The epoch only increments from idle.
8. M5: an answer arriving during a hold plays after release. Waveshare: playout held while the gate is open.
9. The wake chime is written by the codec's sound path at `i2s_codec.c:192-200` while capture is already open, so it lands in the first held frames. Harmless to the model, but it is why the greeting's peak check cannot be trusted.
10. Silent open call beyond 60 s on a hold-button board survives on the keepalive at `voice_loop.c:3569-3579`.

**Revised implementation order.**
1. On the GPT-Live base with the two bench boards: move the activation flag out of the ready gate, delete both mount resets, size the FIFO to the deadline, clear the FIFO on end and mute. Intent test speaks before mount. Bench proof of case 1 on Satellite1.
2. Backend: epoch fence, single deadline from mint, hold-cap counter, greeting removed. Tests for cases 4 and 5.
3. Delete the launch ladder, `start_call`, `call_pending`, obituary grace. Re-arm the press probe at activation.
4. Replace `turns` with the capture-gate fact. Delete both mode systems and mode sounds together. Waveshare playout hold. HAVPE rotary becomes volume only.
5. CLI: port the ESP flush block, delete turn state, fix queue overflow, verify host pre-connect capture.
6. Port the Futurehomes board table, build ownership, gestures, and hardware fixes onto that result, dropping the uplink and mode modules at the source.
7. Delete dead recycle queries, metrics, and tests. Update docs and the board skill.
8. Validation: host suite, five builds, Satellite1 and HAVPE acoustic runs of cases 1 through 5 and 10, M5 and Waveshare bench for case 8.

**Product decisions I made rather than asked.** Delete the greeting. Hold Waveshare playout while its button is held. Put an epoch on the wire, which is a contract bump.

**Inspected.** Both `voice_loop.c` files at the capture, gate, flush, mount, CALL_ENDED, launch, and keepalive sites. GPT-Live `voice-agent.ts` mic-frame, dial, session.started, hangUp, idle, and dial-socket paths and its test at lines 400 to 575. `voicelab_stream.c` start_call, recycle, append, keepalive, end_call. `voice_device_profile.h`, `conversation_launch.h`, `voice_uplink.[ch]`, CLI `main.c` capture and talk paths, `cli_microphone.c`, Futurehomes `board.c` wake and gesture wiring, M5 and Waveshare device and audio headers, HAVPE mode adoption, sdkconfig SPIRAM flags, and the host fakes.

**Limits.** No git tooling, so the Futurehomes backend and platform WIP were not diffed against the base. I did not verify the POSIX connect blocking, free PSRAM per board, provider behavior under a large replay, XMOS echo handling of the chime, or the contents of the Stackchan modes test.
