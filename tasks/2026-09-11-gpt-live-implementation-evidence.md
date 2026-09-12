# GPT-Live integration evidence

Implementation branch: `futurehomes-gpt-live`, based on PR #2624 at
`9dd9aea7225cf0818eb508d63736d54fbfb7c8f6`. Verification below records the completed checkpoints and the limits of the
silent proof. The pull request carries the live final CI status.

## Saved checkpoints

| Commit | Change |
| --- | --- |
| `a7fc2322f` | Selective shared board/audio/build consolidation on the GPT-Live base |
| `7a8982f4e` | HAVPE dial decoder build fix |
| `a19846baa` | Input bounds, provider clock and reduced face corrections |
| `d401131af` | Immediate capture, activation fencing, pre-roll and provider-mode deletion |
| `76adf4631` | Contract 23, fixed GPT-Live configuration, mirror/greeting deletion, bounded opening |
| `eb5758bb8` | One board identity, fixed hardware gates, launch deletion, shared quiet-call presence |
| `dfffa7fce` | Terminal recovery through processor alarms, quiet-call fix and mobile suppression |
| `bafea50c4` | Nullable-check simplification and explicit wire validation boundary |
| `e7994f649` | Continuous capture on every board/CLI, one-press controls, native M5 duplex and activation fixes |
| `85d538152` | 200 ms playout prefill, meaningful gap classification and append-failure regression |
| `611b66cce` | Node physical socket ownership, duplicate-handle lifetime and pre-ready callback fencing |
| `382eb8817` | Terminal outbox/state fixes, M5 front-button mapping, CLI close wait and archived HAVPE proof |
| `d46f0fa63` | Preserve completed CLI stdout across close timeout; record exact installed final image |

The original branch and unrelated backend experiments remain on
`backup/futurehomes-before-gpt-live-integration`. These checkpoints do not claim
all experimental Futurehomes backend work was landed.

## Primary source decisions

| Source inspected | Consequence |
| --- | --- |
| [GPT-Live WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets?api=live) and [delegation](https://developers.openai.com/api/docs/guides/live-delegation) | Wait for `session.started`; use fixed mono PCM, continuous input and ordered output. No remote turn commits or output-done assumption. |
| [HAVPE firmware, `7f6c0b7`](https://github.com/esphome/home-assistant-voice-pe/tree/7f6c0b726ef0f2d55f737540708ed54ab5d086ba) | XMOS owns AEC; keep physical I2S/reference routing. Its 300 ms wake UI delay is not needed here. |
| [Satellite1 ESPHome, `9814bf5`](https://github.com/FutureProofHomes/Satellite1-ESPHome/tree/9814bf598976060a5a5b999448398877d15333e8) and [XMOS, `5be99cc`](https://github.com/FutureProofHomes/Satellite1-XMOS/tree/5be99cc7d4f7ecce8c02c951b008989b6cd79358) | Preserve 48 kHz physical link, 16 kHz processing and verified DSP plane. Do not add a second AEC or copy media-player buffering. |
| [Espressif ESP-SR, `2f8c4b0`](https://github.com/espressif/esp-sr/tree/2f8c4b0459db5bbb39abd77adae27962d6d94bcb) | Use actual processing chunks and playback reference; keep bounded pre-roll for delayed wake detection. |
| [Xiaozhi custom-board guide, `dd99da0`](https://github.com/78/xiaozhi-esp32/blob/dd99da00dc4c89ed4ab07fcec038c03f13f4de50/docs/custom-board.md) | Copy a matching hardware implementation; board configuration should not select product voice behavior. |
| [HAVPE CAD, `c997371`](https://github.com/NabuCasa/home-assistant-voice-pe/tree/c997371cfabaf67623ad012381eff8aac57c5bf6/KiCad) and [TI TPA6211A1](https://www.ti.com/lit/ds/symlink/tpa6211a1.pdf) | GPIO47 controls active-low amplifier shutdown through a populated pull-down network. Latch it low before startup for silent diagnostics. A schematic is not an acoustic transient measurement. |

Community/fork investigation corroborated hardware ownership and buffer-full
failure modes; it did not establish transferable gain/prefill values. Waveshare
already supported simultaneous capture/playout. M5's shared native I2S0 owner
replaces two competing masters and their handoff. All boards now capture
continuously during a call; absence of AEC does not justify mandatory PTT.
M5's new duplex path has source/build proof but still needs a physical bench run.

Detailed investigation artifacts are local:
`/tmp/gpt-live-board-tuning-research.md`,
`/tmp/gpt-live-board-onboarding-and-upstreams.md`,
`/tmp/gpt-live-official-contract-research.md`, and
`/tmp/gpt-live-havpe-silent-proof-design.md`.

## Adversarial review

| Review | Disposition |
| --- | --- |
| Original plan, Claude Fable 5.1 xhigh | Preserved separately in the linked original plan review. |
| Implementation 1, Fable 5.1 xhigh | Fixed capture-before-ready, mount reset, pre-roll, activation identity and face monotonicity. Corrected the review's mistaken queue-size and speaker-alias assumptions against source. |
| Implementation 2, requested Fable, actual Fable then Opus fallback | Removed the duplicate READY-only microphone gate and app-task FIFO reset. Rejected its claim that OTA rollback into ordinary firmware satisfied the no-sound constraint. |
| Implementation 3, Fable 5.1 xhigh | Fixed quiet-call presence, terminal deduplication, rejected call-start cleanup, required speaker activation, and eviction ending the interrupted call without replay. |
| Implementation 4, Fable 5.1 xhigh | Fixed cancellation before acceptance, queued terminal delivery while unmounted, overflow teardown and stale queue-limit text. The M5 handoff was removed entirely. |
| Implementation 5, Fable 5.1 xhigh | Fixed same-pass end/start, muted remote start and server-ended queued-audio races; focused regressions pass. Failed microphone appends now end the activation explicitly; its injected-failure regression and all 70 host tests pass. |
| Implementation 6, Fable 5.1 xhigh | Confirmed pre-ready socket-close callbacks could race external reconnection; fixed callback ownership and tested discarded-attempt silence. |

The Node package suite passed 38 files / 281 tests, including retained duplicate
handles and failed initial upgrades.

Full transcripts/results are in `/tmp/gpt-live-implementation-review-{1,2,3,4,5,6}/`.
Reviews 4 and 5 used Fable for every main response; their usage metadata also
records small incidental Haiku output (16 and 19 tokens respectively).
Review recommendations are evidence to examine, not automatic requirements.

## Verification

- Final code `382eb8817` passed all 70 host tests and all five ESP-IDF 5.4.2
  targets, with unchanged dependency locks. Logs:
  `/tmp/gpt-live-final-build-*-85d.final.log`. The full repository test run,
  typecheck, lint, format check and knip passed; logs:
  `/tmp/gpt-live-last-{tests,typecheck,lint,format,knip}.log`.
- The activation checkpoint passed all 72 then-current firmware host tests;
  backend activation behavior passed 53 tests and mobile voice-call passed 17.
- Contract-23 backend behavior passed 51 tests after deleting obsolete cases.
  Mobile setup passed six tests. Repository typecheck and knip passed.
- The preceding C checkpoint passed all 71 host tests and all five ESP-IDF 5.4 targets,
  plus silent HAVPE, with fresh explicit SDKCONFIG files. Managed dependency
  locks did not change. Logs: `/tmp/gpt-live-final-build-*.final-api.log`.
- Continuous-capture cleanup passed 70 host tests and all five ESP targets plus
  silent HAVPE. Locks remained unchanged; logs:
  `/tmp/gpt-live-final-build-*.ptt-final.log`. Removed obsolete PTT tests and
  retained activation, mute, cancellation, overflow and ordering regressions.
- Five apparent baseline lint errors were caused by the checkout's shallow
  history, which prevents proving grandfathered lines. Fetching full history
  resolved them without editing unrelated UI code.
- The stable full repository test run passed. OS passed 293 files / 3,071 tests
  with 18 pre-existing expected failures and one skip. Full repository lint,
  typecheck and formatting passed; knip passed at the preceding checkpoint.
- A rejected terminal append recovers on the processor's existing alarm while
  the same incarnation remains resident: one terminal event, no new dial. The
  regression advances the fake clock normally so pending tasks can settle.

Application presence covers intentionally open calls with no microphone traffic.
Successful microphone appends refresh the same lease; ESP and native CLI share
one 20-second quiet heartbeat policy, and mobile suppresses redundant beats too.
The backend accepts an empty heartbeat independently of activation and tests a
100-second quiet call. Provider silence-fill and transport PING/PONG serve
different purposes and remain separate.

## Silent measurements

Passive production HAVPE health showed an idle device, loaded Jarvis WakeNet,
125,257 inference frames, 512-sample chunks (32 ms), maximum inference 9,146 µs,
and zero WakeNet overruns. Free PSRAM was 5,905,736 bytes. This is evidence from
installed earlier firmware, not validation of the new build. No serial port was
opened and no device update was performed to obtain it.

The synthetic fixture says **“Jarvis, say the words violet lantern.”** It was
created with `say -o` and converted to a file: 16 kHz mono PCM16, 2,650.375 ms,
PCM SHA-256 `e0e9fd7d975f5a89aba1c5ba46b0c19ea350f822fdb085e58a3b4c5482360c6a`.
The raw API probe uses complete 20 ms frames, so it sent 2,640 ms.

One direct GPT-Live baseline with 60 ms input batches produced first speech
**1,151 ms after input finished**. Socket opening took 1,744 ms and
`session.started` arrived at 2,295 ms from probe start. It returned “Violet
Lantern.”, received `session.closed: close_requested`, and reported no provider
errors. Output was written to WAV; no audio was played. These are one-run
measurements, not percentiles or a comparison with the full stream path.

The full stream path then completed seven file-backed host turns in one call:
all passed with no concealment, underruns, drops, restarts or callback recycling.
Speech-end to first decoded packet was **1,342 ms median** (1,281–1,404 ms);
speech-end to first nonquiet local speaker submission was **1,550 ms median**
(1,476–1,608 ms). These are local submission timestamps, not acoustic DAC timing.
The direct baseline was a different single run, so subtraction is not a reliable
measurement of transport overhead.

The stream-state audit found one accepted activation, one `host-cli` terminal, no stream
errors, null live runtime, zero processor lag, zero retries and no last error.
Artifacts: `/tmp/gpt-live-silent-host-proof-202609112240332-report.json` and
`/tmp/gpt-live-clean-proof-postcall.json`.

A subsequent Cloudflare audit found `Network connection lost.` errors at socket
teardown despite successful append/read RPCs. Trace
`0730d75771d0504d376855b908835373` aligns with the host terminal at
22:41:33 UTC; two read-only observers show the same pattern. This was reproduced in the short-lived inspection CLI: it released RPC handles
without waiting for physical WebSocket closure. Node now owns and normally closes the physical socket after its last handle;
the CLI waits up to five seconds for the actual close event before its command
runner exits. A production CLI read at 23:29:02–04 UTC completed normally;
the scoped 23:28:50–23:29:20 telemetry query returned zero matching errors
(`/tmp/havpe-cli-dispose-quiet-telemetry.json`). Unrelated alarm errors for another
project are recorded separately.

Earlier proof attempts exposed a stale host binary, an overlong callback key,
unpopulated timing fields, and a legacy project automation that appended removed
Waitrose tools. They are failed diagnostic runs, not passing measurements. The
current host build, short stream-scoped callback keys and measured timing fields
fix the client issues. Project config commit `38c2511f` excludes the new
`/agents/voice/v23/` namespace from only that legacy configured-event mutation.
The isolated guest from config commit `7c93e94a` leaves shared guest files and
old voice histories untouched.

Direct artifacts: `/tmp/gpt-live-silent-fixture/README.md`,
`direct-api-baseline.log`, and `direct-api-output.wav`. The HAVPE digital fixture
completed below. Digital injection cannot prove acoustic wake distance,
echo cancellation, audible quality or microphone-to-room behavior.

### File-only GPT-Live echo loop, 2026-09-11

`tasks/2026-09-11-gpt-live-proof/echo-loopback.ts` is the reproducible raw
probe. It renders input phrases to temporary files with `say -o` and
`afconvert`, feeds PCM16/16 kHz to a direct `gpt-live-1` / `marin` WebSocket
session, and sends `session.close` before continuing to receive until
`session.closed` or a bounded 15-second timeout. A timeout is reported as a
failure. It opens no
recording, microphone, speaker, serial port, board, Iterate backend, or tool.
Run it from `apps/os` with `doppler run --config prd -- pnpm exec tsx
../../tasks/2026-09-11-gpt-live-proof/echo-loopback.ts`.

The raw JSONL from the completed three-case run is
`tasks/2026-09-11-gpt-live-proof/echo-loopback.raw.jsonl`.

| Artifact | SHA-256 |
| --- | --- |
| `tasks/2026-09-11-gpt-live-proof/echo-loopback.ts` (current formatted script) | `47207f62a7cc5f2bf0f5aa02515297d299783e1cd06ca0637f987a50800612f6` |
| `tasks/2026-09-11-gpt-live-proof/echo-loopback.raw.jsonl` (initial three-case run) | `99b598b9618984f747cb05defb0c6c5a4fa5e32f42a0796ecd7cd4d7dfeab5d2` |
| `tasks/2026-09-11-gpt-live-proof/echo-loopback-closed.raw.jsonl` (closure-corrected run) | `369d400fa0db7962ed98cb8ffa87a4ed7a088893c26c60bb0b9a8fc43e7d7dfeab5d2` |
| `tasks/2026-09-11-gpt-live-proof/echo-loopback-mixed.raw.jsonl` (explicit mixed-input run) | `8f877524ce9584936f00f3351bd4ec3ddd2f2e33160714ae35edf5b56f0efd1b` |

The initial script that produced the initial raw file had SHA-256
`87017821380f4314d98de67fb5b44e4d47621d39f1de9b4e6409c6982b7b514a`.
The original raw file above is retained unchanged. The closure-corrected
script SHA-256 is `9437bec3b025df3c705bda0b9ba826bb31ad1c83f9052a0fdbcfde936f59eb67`.
Its separate raw JSONL is
`tasks/2026-09-11-gpt-live-proof/echo-loopback-closed.raw.jsonl`.
All three corrected runs received `session.closed` with `usage.seconds: 25`
and no errors; none hit the close timeout.

The baseline returned one count. With every returned PCM delta fed back after
100 ms at half amplitude, input transcription included the model's own count,
but the model emitted only its original count: no second response, self
interruption, or runaway was observed. In the third case, a separate file
phrase at 10,020 ms replaced the echo at the shared input cadence, interrupted
the count after five, and produced `banana` once. It was not a simultaneous
human-plus-echo test. All three runs had no wire errors.

The fourth case is separate and explicit: at the same 20 ms input cadence it
sums the second human phrase with the delayed half-gain echo and saturates
each PCM16 sample. It mixed 224 frames; input transcription included both
echoed words and the human phrase, and GPT-Live changed from its count to
`Banana.` after `One... two...three...`. It received `session.closed` with
`usage.seconds: 25`, no errors, and no close timeout. This proves only this
synthetic digital overlap, not room echo cancellation or board acoustics.

This is evidence of the model's behavior under a direct, single-channel,
perfect digital loopback over zero input. It is not evidence that room echo,
speaker distortion, microphone coupling, or a board's duplex path needs no
AEC.

### Playback prefill experiment

An isolated host source copy changed total prefill from 300 ms to 200 ms while
retaining the 90 ms DMA lead. Seven file-backed turns all drained with zero
underruns, concealment, starvation, drops or restarts. First decoded packet to
first nonquiet local speaker submission fell from **204 ms median** (300 ms
prefill) to **98 ms median** (200 ms), a 106 ms reduction. Provider response times
varied between runs and are not the basis of this comparison.

Report: `/tmp/gpt-live-prefill-200ms-proof-202609112300308-report.json`.
Postcall state: `/tmp/gpt-live-prefill-200ms-postcall.json`, with null runtime,
zero subscription lag and no stream error. This is file-output timing evidence;
actual hardware DMA and room acoustics still need separate qualification.

The 100 ms candidate reduced packet-to-submission latency further but produced
**12 confirmed starved output buffers** over seven turns. It fails the continuity
criterion even though older summary counters (`underruns` and `framesConcealed`)
were zero. The report must classify those actual output gaps as failures. Keep
200 ms; report: `/tmp/gpt-live-prefill-100ms-proof-202609112304581-report.json`.

### HAVPE digital hardware proof

The exact `85d538152` firmware ran on HAVPE through an app-only OTA, with the
amplifier held in shutdown and every speaker write forced to zero. Real I2S
capture continued; a finite PCM fixture replaced the samples handed to WakeNet
and the capture mailbox. The source and binary hashes, sampled health, durable
events and drained state are archived in
[`havpe-silent-proof.json`](2026-09-11-gpt-live-proof/havpe-silent-proof.json).

| Observation | First wake | Second wake |
| --- | --- | --- |
| Activation to first microphone append | 16 ms | 5 ms |
| Provider opening | 2,094 ms | 838 ms |
| Appends held while opening | 45 | 20 |
| Listener request | Say the words violet lantern | say the words violet lantern |
| Assistant answer | Violet lantern. | Violet lantern. |

The first request finished before provider acceptance and survived intact.
The third scheduled fixture arrived while call two remained open and also
received the correct answer; this is two wake activations and three turns,
not three independent wake trials. The microphone payloads are ephemeral,
so their exact historical batch durations cannot be recovered from the stream.

Both activations have exactly one terminal event. At 23:22:29 UTC the runtime
was null, subscription lag was zero, and retry/error state was clear. Capture,
codec, transport and actual playout fault counters were zero. `spkDrops:2`
records the two normal answer-start queue clears; `spkSupersededMidplay`,
overflow and starvation remained zero.

The fixture was removed by installing an ordinary-name, real-microphone image
with silent output still compiled in. At 23:24:53 UTC it was idle, processing
WakeNet frames, with no fixture fields, null runtime, zero lag and no queue or
transport errors. Its capture saturation counter was one at the first sample
and remained one: one input sample exceeded the fixed x16 gain's PCM16 range
before observation. Its physical cause was not measured. Neither this nor the
digital fixture establishes acoustic gain, room echo or audible quality.
Both temporary firmware tunnels were stopped.

The final installed silent real-microphone image is built from the exact tracked
firmware tree at `382eb8817`, SHA-256
`25ed0be271dc4f85aef132429f6e52376ce9fbdeba703ca2d78274f61860d8df`.
Its 23:35:02 UTC sample was idle and ready with WakeNet loaded, 1,017 inference
frames, zero overruns, null runtime and zero processor lag. Capture saturation
again stood at one before the first observation and did not grow. The final
firmware tunnel is stopped. The installed image deliberately remains silent;
ordinary audible use requires a subsequent normal-output image.

One read-only observer sample failed during the final OTA: its retained runtime
callback crossed the reboot and closed with 1006. Trace
`0a603107a5862eaa9aaa808bba853556` ties the failure to the old hosted
`ProcessorFacet.snapshot` callback, followed by the observer disposing its RPC
connection while sibling reads remained pending. The observer now settles all
of its reads before disposal. This was a bounded diagnostic transition failure;
subsequent final-image samples through 23:35:02 and telemetry through 23:35:35
were clear. It is retained in the raw artifact rather than counted as a passing
sample. Trace/source audit:
`/tmp/havpe-final-382eb8817-telemetry-audit.md`.

## Follow-up cleanup and source review — 2026-09-12

Removed unused microphone sequence counters, the CLI's permanently false
`call_pending` field, unused keyboard timestamps, and test-only microphone/report
APIs. The emitted health sequence, activation FIFO and playback gap detection
remain. A rejected speaker-frame append now ends the affected call through the
existing terminal path; it no longer silently loses audio or an answer-end marker.
The regression proves one terminal event, provider closure and rejection of late
provider audio.

StackChan and Waveshare now share the small ESP-LCD completion helper. Each board
still owns its pixels and panel setup. A failed or timed-out transfer permanently
retires the DMA buffer. Waveshare stops only its display task after a runtime
transfer failure, logs the cause and latches its fault; a startup clear failure
follows the existing fatal initialization path. The completion wait is 50 ms.
No hardware fault injection was performed; source review and ESP-IDF builds do
not establish physical timing under load.

The talking face remains on **StackChan, Waveshare and M5StickS3**. StackChan derives its
mouth envelope from completed I2S DMA; Waveshare uses its local playout sample
clock, and M5StickS3 observes local playout PCM. Waveshare can also consume the
preserved opt-in backend viseme state. That state is not enabled by ordinary
setup. HAVPE, Satellite1 and the CLI have no avatar; M5StickS3's status text is
an explicit avatar-initialization fallback. No hardware was exercised in this pass.

Current primary sources checked against the implementation:

- [GPT-Live WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets?api=live): input starts after `session.started`, stays continuous and ordered, and supports the existing 16 kHz PCM format. Output has no audio-done event or playback timing fields. Keep immediate device capture and opening buffering, provider pacing, local playback accounting and the face's physical sample clock.
- [ESP-IDF 5.4.2 LCD API](https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/api-reference/peripherals/lcd/index.html): queued colour DMA retains the caller's buffer until its completion callback. Share that ownership rule between the two direct-rendered faces; keep panel setup, geometry and rendering board-local.
- [ESP-IDF 5.4.2 I2S](https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/api-reference/peripherals/i2s.html#full-duplex): paired TX/RX share clock signals and compatible configuration. The existing shared codec owner is the default for adding boards; codec-specific setup still needs its hardware facts preserved.

A new target registry would replace only a few lines of each target's CMake
launcher while adding indirection, so the existing common include stays. Keep
the opt-in viseme feature; removing redundant polls needs call-scoped availability
and stale-response handling, not deletion of the classifier. Keep the separately
justified quiet-call presence, provider silence fill and transport PING/PONG.

Local verification: all 70 firmware host tests and all five ESP-IDF 5.4.2 builds
pass, with unchanged dependency locks. Full repository tests pass (OS: 293 files,
3,072 passing tests, 18 existing expected failures and one existing skip), as do
typecheck, lint, formatting and knip. The speaker regression also passes in the
focused 55-test voice-agent suite. Logs: `/tmp/gpt-live-cleanup-*.log`;
StackChan/Waveshare build logs are under `/tmp/gpt-live-final-build/<board>/log/`.
