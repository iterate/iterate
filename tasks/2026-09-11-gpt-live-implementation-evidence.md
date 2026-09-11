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
failure modes; it did not establish transferable gain/prefill values. M5 and
Waveshare retain local capture/playout exclusion because no working acoustic
AEC path was proved. Board names alone are not AEC evidence.

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
| Implementation 4, Fable 5.1 xhigh | In progress: final capture, queue and lifecycle audit. |

Full transcripts/results are in `/tmp/gpt-live-implementation-review-{1,2,3,4}/`.
Review recommendations are evidence to examine, not automatic requirements.

## Verification so far

- The activation checkpoint passed all 72 then-current firmware host tests;
  backend activation behavior passed 53 tests and mobile voice-call passed 17.
- Contract-23 backend behavior passed 51 tests after deleting obsolete cases.
  Mobile setup passed six tests. Repository typecheck and knip passed.
- Final C checkpoint passed all 71 host tests and all five ESP-IDF 5.4 targets,
  plus silent HAVPE, with fresh explicit SDKCONFIG files. Managed dependency
  locks did not change. Logs: `/tmp/gpt-live-final-build-*.final-api.log`.
- Five apparent baseline lint errors were caused by the checkout's shallow
  history, which prevents proving grandfathered lines. Fetching full history
  resolved them without editing unrelated UI code.
- The full test run passed every other workspace and 292 OS test files; its
  only failure was a concurrently edited terminal-recovery regression. A stable
  full rerun remains required.

Application presence remains necessary for quiet M5/Waveshare/mobile calls.
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

Artifacts: `/tmp/gpt-live-silent-fixture/README.md`, `direct-api-baseline.log`,
and `direct-api-output.wav`. HAVPE digital fixture and stream-path comparisons
remain to be performed. Digital injection cannot prove acoustic wake distance,
echo cancellation, audible quality or microphone-to-room behavior.
