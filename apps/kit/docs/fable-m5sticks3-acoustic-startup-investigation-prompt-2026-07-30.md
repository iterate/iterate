# Independent M5StickS3 acoustic startup-loss investigation

You are an independent Claude Fable Max reviewer. Do not edit production code.
Investigate one current, physically reproduced defect and write a source-cited
technical report to
`apps/kit/docs/fable-m5sticks3-acoustic-startup-investigation-2026-07-30.md`.
That report is the only working-tree file you may create or edit. Focus on
materially discriminating experiments and architectural simplifications, not
speculative tuning.

## Working tree and required context

The working tree is:

`/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities`

Read these first:

- `apps/kit/docs/audio-streaming-problem-and-evidence-2026-07-30.md`
- `apps/kit/docs/fable-audio-architecture-alternatives-2026-07-30.md`
- `apps/kit/docs/fable-audio-review-reconciliation-2026-07-30.md`
- `apps/kit/firmware/AGENTS.md`
- `apps/kit/firmware/docs/connected-device-inventory.md`

Then inspect the implementation and tests, especially:

- `apps/kit/scripts/device-e2e.ts`
- `apps/kit/src/voice/deterministic-pcm-tone-provider.ts`
- `apps/kit/src/voice/device-pcm-proxy.ts`
- `apps/kit/src/device/macos-pcm16-capture.ts`
- `apps/kit/src/device/acoustic-tone-analysis.ts`
- `apps/kit/firmware/platforms/common/include/iterate/kit/platforms/realtime_playback.hpp`
- `apps/kit/firmware/platforms/common/include/iterate/kit/platforms/direct_i2s_stereo_output.hpp`
- `apps/kit/firmware/platforms/iterate_esp_idf/include/iterate/kit/platforms/esp_idf_direct_i2s_backend.hpp`
- `apps/kit/firmware/platforms/iterate_m5unified/m5sticks3_direct_audio.cpp`
- `apps/kit/firmware/platforms/iterate_m5unified/include/iterate/kit/platforms/m5sticks3_direct_audio.hpp`
- their focused host tests.

Inspect first-party/prior-art source rather than recalling it:

- ESP-IDF at `/Users/jonastemplestein/esp/esp-idf`, particularly I2S
  standard-mode/DMA/preload/start semantics and any ES8311 example or component;
- M5Unified's current source both in
  `/Users/jonastemplestein/src/github.com/m5stack/M5Unified` and the target's
  `managed_components` copy, including M5StickS3 speaker enable and clock code;
- current Stick prior art under
  `/Users/jonastemplestein/src/github.com/iterate/stackchan/experiments/02-minimal-realtime-aec/firmware-sticks3`;
- any locally available official M5Stack M5StickS3 board examples/schematics,
  ES8311 driver/source, and the codec datasheet if present.

Internet research is allowed, but prefer authoritative source/documentation and
give URLs plus local source symbols/paths where possible.

## Exact physical evidence to explain

The latest fresh firmware run sent exactly 250 mono PCM16LE frames: 320 samples,
640 bytes, 20 ms, 16 kHz, continuous 997 Hz sine, over approximately five
seconds. The device reported:

- downlink accepted 250;
- playback submitted 250;
- playback completed 250;
- flushed, freshness drops, partial-prebuffer drops, underrun flushes/incidents,
  DMA deadline incidents, driver queue overflows/failures, backpressure,
  invalid frames, state errors, and owner-clock regressions: all zero;
- EOS markers consumed 1 and responses 1;
- EOS silence descriptors 3;
- maximum EOF-to-refill 39,375 us; minimum descriptor-reuse lead 20,625 us.

This physically confirms a just-fixed terminal ESP-IDF private finished-pointer
queue issue. Do not conflate that repair with the remaining defect.

The nearby Mac microphone artifact is:

`apps/kit/evidence/m5sticks3-playback/iterate-kit-acoustic-xQVuWR/microphone.pcm16le`

It is 752,640 bytes of 48 kHz mono PCM16LE, SHA-256
`81404dbf6652ffd9045ffc18dbe4f47a3106744ba7675b7e95cbbff7f5c53e94`.
The 997 Hz signal is physically present only from roughly 3.15 s to 7.10 s:
about 3.98 s rather than 5 s. Its level is broadly stable while audible. The
run ended with the deliberate roughly 0.5 s quiet capture tail, so the missing
time appears more likely near startup than as a simple 20% clock-rate error.
The analyzer also reports 99 inactive 5 ms windows and 40 phase
discontinuities, while device software counters remain clean.

The deterministic provider rendered exactly 80,000 nonzero-source samples and
the host proxy emitted 250 frames. Device counters advanced at about 50 frames
per second. Spectrum during the audible section remains about 997 Hz, not the
roughly 1,246 Hz expected from a simple 20 kHz/16 kHz playout-rate mismatch.

Our target currently:

- creates/configures an I2S TX channel with four 320-stereo-frame descriptors;
- configures ES8311 with the same eight registers as M5Unified while clocks and
  the M5PM1-controlled amplifier are off;
- preloads four content frames;
- enables I2S clocks;
- then enables the M5PM1 amplifier GPIO;
- expands each mono frame into duplicated stereo samples;
- uses 16 kHz I2S standard Philips mode, 16-bit stereo, MCLK multiple 128.

M5Unified's M5StickS3 defaults and low-level clock manipulation may differ, and
its speaker enable callback appears to enable the M5PM1 output before writing
the codec register set. Determine what is semantically important rather than
copying it blindly.

## Deliverable

Produce a clear report with:

1. a ranked set of hypotheses for the missing startup audio and the independent
   short gaps/phase discontinuities;
2. what each hypothesis predicts in the existing artifact and metrics;
3. the smallest physical and host-side experiment that distinguishes it from
   the alternatives, including exact instrumentation/counter/timestamp fields;
4. whether codec/amplifier/clock startup ordering or warm-up is documented and
   how shipped first-party code handles it;
5. whether IDF preload/write/descriptor behavior could produce counters which
   claim content while DMA carries silence or repeated data;
6. whether the Mac AVFoundation/Standard microphone processing can plausibly
   erase exactly the first second of a steady tone or create the 5 ms/phase
   findings, and how to test that without trusting subjective hearing;
7. whether our current create/delete-per-response architecture is directly
   responsible, and the simplest create-once alternative that preserves
   half-duplex microphone pin ownership;
8. explicit keep/simplify/delete/defer recommendations and a red-test-first
   sequence.

Separate source-proven facts, measurements, and hypotheses. Do not recommend
increasing buffers merely to hide the symptom. Do not edit anything except the
single report path named above. Do not claim a root cause without a
discriminating proof.
