# Fable review: fastest clean Home Assistant Voice PE vertical slice

Write the durable result to
`apps/kit/docs/fable-havpe-fastest-native-audio-review-2026-08-02.md` and do not
edit any other file. This is a bounded independent review, not an implementation
task.

## Objective

Find the shortest production-shaped route from the already-proven Iterate Kit
StackChan slice to a real Home Assistant Voice Preview Edition (HAVPE) proof:

- custom freshly-flashed firmware;
- the existing Cap'n Web capability connection to `os.iterate.com/api`;
- the existing production userspace `/pcm` path and real
  `grok-voice-think-fast-2.0`;
- Grok server-side VAD;
- continuous microphone input processed by the HAVPE's local XMOS hardware AEC;
- returned audio audibly played at high volume;
- interruption, exact bounded-buffer accounting, runtime memory/CPU metrics,
  and interval-aligned network validity;
- maximum reuse of the portable Kit core, PCM transport, capability modules,
  and production proof harness already used by M5StickS3 and StackChan.

Do not propose face/avatar work yet. Do not turn this into a generic DSP
framework. The acceptance target is one honest HAVPE vertical slice.

## Source to inspect deeply

Use first-party source, not installed package output:

- Iterate worktree:
  `/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities`
- HAVPE source:
  `/Users/jonastemplestein/src/github.com/esphome/home-assistant-voice-pe`
- ESPHome source:
  `/Users/jonastemplestein/src/github.com/esphome/esphome`
- ESP-IDF source:
  `/Users/jonastemplestein/esp/esp-idf`

At minimum inspect:

- `apps/kit/firmware/targets/stackchan/main/main.c`
- `apps/kit/firmware/platforms/iterate_core_s3_audio/**`
- the portable PCM lane, clocked playback, capture turn, interruption, metrics,
  WebSocket, and ESP-IDF transport code/tests;
- `home-assistant-voice.yaml`;
- first-party `voice_kit` and `aic3204` implementations;
- ESPHome's current I2S secondary/slave microphone and speaker setup;
- relevant ESP-IDF I2S standard-mode documentation/source and constraints.

Known hardware contract to verify rather than assume: internal I2C SDA GPIO5,
SCL GPIO6; XMOS reset GPIO4 and I2C address 0x42; processed microphone I2S at
16 kHz, signed 32-bit stereo on WS GPIO14/BCLK GPIO13/DIN GPIO15 with ESP32 as
secondary/slave; playback I2S at 48 kHz signed 32-bit stereo on WS GPIO7/BCLK
GPIO8/DOUT GPIO10 with ESP32 secondary/slave; AIC3204 at 0x18; speaker amplifier
enable GPIO47; XMOS channel 0 should expose the full AEC→IC→NS→AGC result.

## Questions

1. Should the first slice be native ESP-IDF with a small HAVPE hardware/audio
   owner, or an ESPHome external component wrapping the C core? Compare actual
   implementation/risk/time, then make one recommendation.
2. What is the smallest correct I2S owner design when both buses are driven by
   XMOS clocks? Give exact IDF channel/slot/DMA settings and task priorities.
3. The wire lane is mono PCM16 16 kHz while playback hardware needs stereo
   signed 32-bit 48 kHz. Is exact 3:1 sample repetition acceptable for the first
   spoken proof, or is linear/polyphase conversion materially necessary? Name
   the cheapest correct conversion and its measurable quality gate.
4. Which AIC3204 initialization ordering/register writes are indispensable,
   including the asynchronous 2.5 s analogue soft-start and high but safe
   volume?
5. What XMOS reset/config/version checks are indispensable without embedding a
   DFU image? How do we prove the configured capture channel is actually the
   processed AEC channel rather than raw/NS-only audio?
6. Which exact pieces should be shared or extracted now, and which should stay
   device-specific? Explicitly identify deletions/simplifications that avoid
   copying the 976-line StackChan target or inventing a broad abstraction.
7. Give a staged physical bring-up ladder (codec tone → clean microphone →
   deterministic network → production Grok) with hard counters/failure
   attribution at each stage.
8. Identify every likely board-bricking, silent-audio, clocking, bit-alignment,
   overflow, backlog, reconnect, or AEC-proof trap. Cite source paths/lines.

Conclude with:

- a recommended minimal file/module plan;
- explicit non-goals/deletions;
- the first five red tests/contracts to write;
- a ranked, bounded execution checklist that can land within hours rather than
  expanding into open-ended research.

