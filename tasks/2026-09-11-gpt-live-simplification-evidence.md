# Source inventory for the GPT-Live simplification plan

Read-only investigation on 2026-09-11. The original baseline appears first; the 13:39 UTC refinement snapshot below supersedes it for the current plan. Locations below are evidence anchors, not prescribed implementation boundaries. The implementation plan deliberately names responsibilities rather than fixing file layout in advance.

## Branches

- Futurehomes: `/Users/jonastemplestein/.herdr/worktrees/iterate/futurehomes`, commit `3cb06157473e6dc3749367a76bfbd0a223f11116`. Saved checkpoint includes broad firmware work and experimental backend/reliability fixes; do not merge indiscriminately.
- GPT-Live: `/Users/jonastemplestein/.herdr/worktrees/iterate/voice-templestein`, branch `voice-gpt-live-1`, commit `3b85c19207d5e08cae0573cc7d1709123b0e0072`, [PR #2624](https://github.com/iterate/iterate/pull/2624). Previous inspection used `e2d481856cc7ac5a8cb937041e9b5e498b3b04b4`; the intervening commit only removes an unused import from `packages/voice-agent/src/face.ts`.
- Common ancestor: `0a34340fa09bdd42099bf591c1f525844e48055b`.
- Both working trees were clean before planning artifacts were created. Futurehomes' earlier verification was 77 ASan host tests and five ESP builds; no new firmware was flashed by this planning task. That does not validate a future combined branch.

## GPT-Live source anchors

All relative locations in this section are in the `voice-templestein` worktree.

| Location | Evidence / thing to challenge |
| --- | --- |
| `packages/voice-agent/src/voice-agent.ts`, contract and setup | Contract version 21 uses mic-frame, keepalive, and conversation-end-requested input. One GPT-Live dialect; backend delegation remains. Inspect schema for old-client/setup compatibility and exported test fixtures. |
| Same module, around 1183–1245 | First mic audio starts a call and dials immediately. Audio before readiness enters a held queue. Limit is 500 messages, not bytes, and excess is silently omitted. A 1500 ms post-end guard rejects all audio, including potentially a new activation. Failure recording call-started is caught and only resets a flag. |
| Same module, around 1285–1355 | Dial object created before asynchronous dial; identity fences prevent a late socket from reviving a closed call. Fifteen-second handshake timeout starts after socket adoption, leaving the awaited dial outside that timer. |
| Same module, around 1574–1625 | session.started sets ready, synchronously loops over held PCM, clears the queue, emits accepted, and optionally greets if no held PCM crosses a speech peak threshold. Test greeting interaction and whether lifecycle fields settle correctly. |
| Same module, microphone send and hangup | Provider append uses padded base64. Hangup clears held audio. Read eviction/revival behavior before simplifying ownership. |
| `apps/kit/firmware/components/core/include/iterate/kit/voice_device_profile.h` | 256 × 20 ms microphone slots = 5.12 seconds/163,840 PCM bytes; eight frames max per append; 50 ms microphone flush; 300 ms total speaker priming; 20-second call keepalive. Several old turn constants remain. |
| `apps/kit/firmware/targets/host_cli/main.c`, around 1467 | CLI waits for eight frames unless source finished/flushing, so steady input waits roughly 160 ms despite the 50 ms shared constant. Independent sender and legacy turn fields remain. |
| `apps/kit/firmware/components/voice/src/voice_loop.c` | ESP has 50 ms flush behavior, capture/connection gates, launch and callback recovery. Compare against the same file in Futurehomes; do not resolve this overlap by choosing a whole side. |
| `apps/kit/firmware/components/core/src/voicelab_stream.c` and header | start_call sets pending but emits no opening event. needs_recycle always returns false. recycle_connection still provides initial/failure-driven callback registration and cannot simply be deleted wholesale. Metadata includes obsolete turn concepts. |
| `apps/kit/firmware/targets/host_cli/` | Mac VoiceProcessingIO AEC and plain-queue diagnostic mode; preserve native lifecycle and actual reference audio. |
| `apps/os/scripts/voicelab/` | New live-probe/duplex/ask/wire-call tooling supersedes older provider harnesses. Review actual commands and capability failure diagnostics rather than preserving both branches' tool lists. |
| `packages/voice-agent/README.md`, PR body | PR's acoustic and raw-wire measurements motivate AEC, bounded uplink payloads, and priming. Treat them as branch evidence, not fresh measurements. Some prose uses old contract/timing values; current source wins. |

## Futurehomes source anchors

All relative locations in this section are in the `futurehomes` worktree.

| Location | Evidence / thing to challenge |
| --- | --- |
| `apps/kit/firmware/components/core/include/iterate/kit/voice_uplink.h` and `src/voice_uplink.c` | Five-state uplink, turn markers, flush snapshot/deadline, turn limit, staged frames and counters. New shared code that should largely disappear with GPT-Live. |
| `apps/kit/firmware/components/voice/src/voice_loop.c` | Uplink readiness is remote call-active; capture/send step is gated by transport/voicelab readiness. Connection readiness can reset state. Mic capture task exists but closed gate discards input. Audit wake, mounting, queue resets and backpressure together. |
| `apps/kit/firmware/targets/host_cli/cli_uplink.c` and microphone queue | New shared-uplink adapter plus separate queue ownership. Initial overflow behavior differs from ESP; verify prefix preservation rather than adopting either blindly. |
| `apps/kit/firmware/components/core/…/provider_mode.*` and `platforms/iterate_esp_idf/provider_mode_nvs.c` | Shared provider persistence and mode selection should be deleted with their tests, not migrated as a configurable one-model abstraction. |
| `apps/kit/firmware/platforms/iterate_esp_idf/components/board/` | New shared board table, codec and register helpers, I2S handling, wake word, volume and hardware facts. Preserve real sequencing and synchronization. |
| Same board component, `i2s_codec.c` around 214–240; `wake_word.c` around 197–250, 278–310, 369–381; `board.c` around 369–399 | Hardware capture feeds a separate WakeNet worker, which publishes a boolean later; no audio boundary/pre-roll travels with detection. The worker rejects samples older than 80 ms, but that is not an upper bound on phonetic detection delay or app polling. The main microphone egress discards idle PCM. Board polling plays the wake chime before the app consumes its returned intent. Preserving the first command syllable needs an acoustic no-pause test, a timestamped handoff/short local pre-roll, and chime/capture ordering. |
| `apps/kit/firmware/devices/havpe/` | Provider-mode wheel and volume quadrature may share helper code; do not delete rotary decoding along with provider selection. |
| `apps/kit/firmware/devices/m5sticks3/m5sticks3_audio.h` and `.cpp` | Capture and TX have shared clocks; channel destruction/recreation and capture fencing are physical requirements, not obsolete PTT protocol. |
| `apps/kit/firmware/devices/waveshare_s3_amoled/` | Current processor has no AEC. Avoid assuming the model solves speaker-to-microphone echo. |
| `apps/kit/firmware/devices/stackchan/` | Normalized gestures and custom local audio, face/head capabilities; a previous port omitted sounds and was corrected. Preserve those actual callbacks. |
| `apps/kit/firmware/targets/common/`, target entry points and asset generators | Shared build/default/partition ownership and sound generation are independent of the provider. Remove mode assets at their generation source. |
| `apps/kit/firmware/tests/` | Existing intent, launch, shared uplink/CLI adapter, playout, AEC selector, hardware fake and provider-mode tests. Replace obsolete semantics, retain real hardware and concurrency cases. |
| `apps/os/src/domains/{capability-host,itx,streams,workers}/` and voice-agent package | Checkpoint also contains capability refresh, pager/lifecycle, stream delivery and worker/voice diagnostics changes. Each needs disposition against the GPT-Live base; they are not all firmware refactors or established fixes. |

## Direct firmware overlaps

Both branches change these ten paths relative to their common ancestor:

- `apps/kit/firmware/components/core/include/iterate/kit/voice_device_profile.h`
- `apps/kit/firmware/components/core/include/iterate/kit/voicelab_stream.h`
- `apps/kit/firmware/components/core/src/voicelab_stream.c`
- `apps/kit/firmware/components/voice/src/voice_loop.c`
- `apps/kit/firmware/targets/host_cli/cli_options.c`
- `apps/kit/firmware/targets/host_cli/main.c`
- `apps/kit/firmware/tests/fakes/esp_idf/fake_esp_idf_platform.c`
- `apps/kit/firmware/tests/voice_loop_answer_clock_test.c`
- `apps/kit/firmware/tests/voice_loop_intent_test.c`
- `apps/kit/firmware/tests/voicelab_stream_test.c`

## Questions for the adversarial reviewer

1. Is the proposed sender still too elaborate? What can be deleted entirely, including new Futurehomes abstractions?
2. Does the plan actually preserve an utterance completed before either connection exists? Find capture gaps, resets, bounded-queue failures, greeting collisions, executor blocking and FIFO races.
3. Are the 30-second buffer, 20-second overall opening deadline, 15-second dial deadline and catch-up policy coherent and affordable? Avoid presenting unmeasured numbers as proof.
4. Can existing identities prevent stale microphone tails opening a new call while allowing immediate reactivation? If not, specify the smallest necessary change, not a speculative reliability framework.
5. Does deleting PTT accidentally delete a required M5 clock/arbitration or Waveshare echo safeguard? Does muted buffered audio have an unambiguous disposition?
6. Which retained backend/transport/playout features are unjustified, and which proposed deletions would break a real requirement?
7. Is the commit order honest about working intermediate states, contracts, hardware coverage, and backend scope?

## Post-review source checks

- In the GPT-Live tree, `apps/mobile/src/lib/voice-call.ts` and its tests, plus `apps/os/scripts/voicelab/wire-call.ts`, `tap.ts`, `transcript.ts`, and voice-agent tests, consume or emit the same lifecycle/audio events. The epoch contract change must include these consumers.
- GPT-Live `voicelab_stream.c` around 1387–1411 writes conversation-ended directly, using a compiled-in fallback ID before a live conversation ID is known. This cannot correctly cancel a newly minted backend call before acceptance; target cancellation by activation epoch and leave conversation-ended to the backend.
- GPT-Live `platforms/darwin/tls_stream.c` sets O_NONBLOCK around 358, drives its resolver around 454, and returns WOULD_BLOCK for TLS WANT_READ/WANT_WRITE around 512. DNS-SD is polled by its resolver adapter. A full-path host capture test remains needed, but an additional audio engine is not justified by source inspection.
- PR #2624's saved body explicitly reports raw-wire input-append burst experiments: larger input appends correlated with larger output gaps. That supports testing held-queue replay and retaining bounded payloads; it does not establish that a separate replay timer improves cold-start behavior. The reviewer did not read that PR text, so its no-evidence statement is corrected in the disposition.

## Refinement snapshot: 2026-09-11 13:39 UTC

The voice worktree advanced from `3b85c19207d5e08cae0573cc7d1709123b0e0072` to `454cb43adf433996fa936a6ed56630a0bf0da4ac`. At capture, only `apps/os/scripts/voicelab/ask.ts` had uncommitted changes. Futurehomes remains at `3cb06157473e6dc3749367a76bfbd0a223f11116` plus these planning documents. The exact patch, four inspected source snapshots, and prior plan are retained locally under `/tmp/gpt-live-plan-refinement/`.

| Commit / worktree change | Consequence for the plan |
| --- | --- |
| `bafb1c809`: half-duplex wire client and answer-frame reporting | Keep the existing wire-client microphone-off option and the per-request speaker-frame count/duration/timing. Extend this harness; do not create another provider mode or duplicate proof tool. |
| `c72bb3385`: provider silence input | The branch records raw-wire and preview failures when input stopped during a long answer. Preserve backend digital-zero input when clients go quiet. This is provider timing maintenance, independent of deleted remote PTT commits. |
| `68e8b2756`: test clock stepping | The added test verifies regular 100 ms fills and short suppression after real microphone input. It does not prove drift recovery, large timer stalls, task count, old-dial shutdown, or a complete long answer on hardware. |
| `8dd99c606`: one background loop per dial | Keep this replacement for the tick chain. The commit records repeated KV/alarm registration and 52 underruns with the chain; recreating managed background work every 100 ms is a known regression. |
| `454cb43ad`: wall-clock silence accounting | Keep elapsed-time catch-up. The commit records that the previous drifting loop still stopped a count at six. The current unbounded synchronous debt loop needs a finite work/recovery bound and realistic tests, rather than being declared finished from a punctual fake-clock test. |
| Uncommitted answer diagnostics | The request reporter additionally logs provider-receive delta count/span across the call. Preserve the useful distinction between provider arrivals and speaker frames, but align reporting windows and distinguish silent deltas from audible answer completion. Treat this as observed WIP, not a landed or independently verified fix. |

Current source anchors in the voice worktree:

- `packages/voice-agent/src/voice-agent.ts`: `SILENCE_FILL_MS` and its branch evidence around 200; input accounting on real mic forwarding around 1260; session.started queue drain and filler start around 1600; the one-loop filler and unbounded catch-up around 2072–2088.
- `apps/os/scripts/voicelab/voice-agent.test.ts`: the silence-fill test around 381 uses punctual clock steps. Add irregular steps, stop/replace, idle-closure, and speech-ordering coverage in the implementation.
- `apps/os/scripts/voicelab/wire-call.ts`: `micOffBetweenUtterances` around 114/260 sends one initial quiet batch to open the test call and no further mic frames between requests. This harness behavior must not become an extra product turn protocol.
- `apps/os/scripts/voicelab/ask.ts`: `micOffBetweenRequests` routes the scenario through the existing wire client; the new report observes provider delta spans and speaker audio arrival separately.

Content hashes for the inspected snapshot (SHA-256):

- `packages/voice-agent/src/voice-agent.ts`: `fdd68cf413c8107ebf7754b2640fa6b86e3ae80241c32b3c4c9d167f5ddb78a3`
- `apps/os/scripts/voicelab/voice-agent.test.ts`: `deb04693d72d5a117e63243a9c2db791d62f0d38b10264a32ffd69f930070792`
- `apps/os/scripts/voicelab/wire-call.ts`: `ce8001b3e1356ce24e13d9689b180ec7b74b39a6bcfd0be60f4a30deff82e97b`
- `apps/os/scripts/voicelab/ask.ts`: `f4413cbe41fe43bf52625539f152488eaced83306fe97a71f5ec1ec57ad49169`
