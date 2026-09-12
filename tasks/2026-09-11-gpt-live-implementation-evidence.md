---
state: done
priority: high
size: large
tags: [voice, evidence, gpt-live]
---

# GPT-Live implementation evidence

Detailed chronology, raw silent fixtures, reviews and intermediate checkpoints
were saved before consolidation at
[`backup/futurehomes-gpt-live-reviewed-20260912`](https://github.com/iterate/iterate/tree/backup/futurehomes-gpt-live-reviewed-20260912)
(`192b779c`). This record states final evidence, not that history.

## Verified deployment before PR-size cleanup (12 September)

| Deployed artifact or version | Exact identifier |
| --- | --- |
| HAVPE app binary SHA-256 | `999f60fe358fd229acd463ff03e9808916bbcad535272f22d0e7e29cddc5ab28` |
| Production OS Worker version | `a1baef0c-9e0d-4314-97a0-0fb6f746402d` |
| Published Kit Worker version | `acfd8c74-bb50-4c49-b98b-72c877d366e6` |
| Recorded five-target build marker | `73cc3e…e398303` |
| HAVPE air-path record | `/tmp/havpe-natural-hangup-1789217263842.json` |

These are deployed artifact/version identifiers, not current source revisions.
At that checkpoint, published Kit assets matched their verified manifests; all
five ESP32-S3 targets built, and Kit's five-device proof passed. PR-size cleanup
changes source, so it needs new fingerprints/builds before another deployment.
They are not a claim that every physical board was exercised.

## What was exercised

- Pre-cleanup root checks: 4,555 JavaScript tests and 72 firmware host tests
  passed (21 expected JavaScript failures and one skip).
- Final source cleanup: 4,561 JavaScript tests and 72 firmware host tests pass.
  Five regressions prove that provider close, session close, refusal, dial error
  and opening timeout cannot forward one call's queued PCM to its successor.
  Opening queues now belong to that call; reducer version 24.0.1 rebuilds old
  terminal state from the journal. Kit source installs generate their worker
  reference configuration, with stable source hashes and no-op repeat installs.
- Host firmware regressions: continuous/pre-call capture, activation fencing,
  terminal delivery, append failure, speaker prefill, mute/end clearing,
  board controls, display DMA failure and ring rendering.
- ESP-IDF 5.4.2 builds: HAVPE, Satellite1, StackChan, M5StickS3 and Waveshare.
- Preview: client-mode GPT-Live, same-stream Agent delegation, commentary,
  background work and model-decided hang-up.
- HAVPE: silent diagnostic routing before normal output, then final normal
  image. Air proof activation `f8fc27929c8dde45410499f8a156d665`: lookup
  `item_ENHR98Ri7vsHWIGeBJwjV`, then separate hang-up
  `item_ENHRNVbz8zKHV9ilFHFrS`, `Goodbye`, `the Agent hung up`, and idle with
  `voicelabFailure: none` plus zero call-window frame, mic, AEC, protocol,
  send/receive and codec failures.
  A separate opening start→immediate-end stayed idle with no later mic/speaker writes.
- File-driven echo: no self-response loop under the tested delayed/scaled
  own-output fixture. It supports deleting PTT policy, not a room-AEC claim.

## Verified behaviour

Capture starts before acceptance and buffered prefix reaches the provider.
The fixed Live contract carries continuous PCM and activation-fences terminal,
speaker and microphone paths. Local/remote end clears queued playout/capture;
late callbacks cannot revive it. The Agent/VoiceAgent share one stream;
commentary reaches only its activation and Agent work may outlive the call.
The installer publishes complete ESP32-S3 target manifests, including
bootloader, partition table, initialized OTA data and wake-model assets where
required.

## Retained source decisions

| Source | Decision |
| --- | --- |
| [GPT-Live WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets?api=live) | Wait for `session.started`, keep continuous ordered PCM and local playout accounting. |
| [GPT-Live delegation](https://developers.openai.com/api/docs/guides/live-delegation?delegation-mode=client) | Use client delegation/Live IDs; no second task protocol. |
| [ESP-IDF I2S duplex](https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/api-reference/peripherals/i2s.html#full-duplex) | Share compatible TX/RX clocks where required, notably M5StickS3. |
| [ESP-IDF LCD DMA](https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/api-reference/peripherals/lcd/index.html) | Retain colour buffers until DMA completion. |
| [HAVPE](https://github.com/esphome/home-assistant-voice-pe) / [Satellite1](https://github.com/FutureProofHomes/Satellite1-ESPHome) | Preserve actual codec/reference/DSP ownership, not their product turn policy. |
| [ESP Web Tools](https://esphome.github.io/esp-web-tools/) / [ESP-IDF partitions](https://docs.espressif.com/projects/esp-idf/en/latest/esp32s3/api-guides/partition-tables.html) | Publish complete target manifests, including OTA data for OTA-only tables. |

## Standby benchmark

Three matched Preview-12 Agent pairs compared a settled harmless standby turn
with no standby. One warmed work turn read cached input but was slower; median
control minus standby was −2 ms to request, −869 ms to settlement and −1,417
ms to same-stream callback. Automatic warmup remains disabled. Back-to-back
standby/work left no open/pending request: the first runnable turn included
the work context; only its redundant later delayed intent was ignored while
that request was open. Raw results remain in
`/tmp/gpt-live-agent-standby-benchmark/`.

## Limits

Satellite1, StackChan, M5StickS3 and Waveshare have source/build coverage but
need their own physical sessions. Digital PCM proves routing/timing, not wake
acoustics, room AEC, loudness or photometry. HAVPE queue/codec counters do not
replace a calibrated room recording. Prompt caching is opportunistic; this
negative benchmark is sufficient to avoid product warmup, not a universal law.
