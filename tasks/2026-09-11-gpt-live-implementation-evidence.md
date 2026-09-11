# GPT-Live integration evidence

Implementation branch: `futurehomes-gpt-live`, based on PR #2624 at
`9dd9aea7225cf0818eb508d63736d54fbfb7c8f6`. Verification below distinguishes
completed checkpoints from work still in progress.

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
| Implementation 5, Fable 5.1 xhigh | Fixed same-pass end/start, muted remote start and server-ended queued-audio races; focused regressions pass. Failed microphone appends now end the activation explicitly; its injected-failure regression is next. |

Full transcripts/results are in `/tmp/gpt-live-implementation-review-{1,2,3,4,5}/`.
Reviews 4 and 5 used Fable for every main response; their usage metadata also
records small incidental Haiku output (16 and 19 tokens respectively).
Review recommendations are evidence to examine, not automatic requirements.

## Verification so far

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
22:41:33 UTC; two read-only observers show the same pattern. This remains under
investigation: clean stream state alone does not establish clean operational
telemetry. Unrelated alarm errors for another project are recorded separately.

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
remains to be performed. Digital injection cannot prove acoustic wake distance,
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
| `tasks/2026-09-11-gpt-live-proof/echo-loopback.ts` (current formatted script) | `6a88f8c238cdf21f54573f22199e1ada469d3a64a795553c07b7b5eb9594ca71` |
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
