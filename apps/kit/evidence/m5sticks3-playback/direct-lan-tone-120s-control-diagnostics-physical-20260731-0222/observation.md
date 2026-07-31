# M5StickS3 two-minute playback with retained control diagnostics

## Result

**PASS.** The physical M5StickS3 accepted and audibly completed all 6,000
20 ms PCM frames in a 120-second deterministic-tone response. Neither
WebSocket reconnected. Every playback incident/failure/drop/reset counter was
zero, and the independent Mac microphone recording contained no internal gap
or phase discontinuity.

This is a clean two-minute direct-LAN continuity proof. It is not evidence that
the earlier intermittent bidirectional outages are fixed: this run did not
exercise a reconnect, injected network impairment, microphone uplink, or
concurrent display/CPU load.

## Identity and invocation

- Date: 2026-07-31 (Europe/London)
- Device: M5StickS3, ESP32-S3-PICO-1 revision 0.2
- Stable USB serial/MAC: `70:04:1D:D5:45:88`
- Enumerated port for this run: `/dev/cu.usbmodem11201`
- Host direct-LAN endpoint: `192.168.0.169:58685`
- Firmware configuration partition at `0x210000` was read and preserved.
- The mounted capability description included
  `subscribeToMetrics`, `subscribeToPlaybackMetrics`, `getDiagnostics`,
  `renderOnScreen`, and `pushToTalk`.

The run used:

```sh
ITERATE_KIT_VERBOSE_METRICS=1 \
ITERATE_KIT_ACOUSTIC_OUTPUT_DIRECTORY="$PWD/apps/kit/evidence/m5sticks3-playback/direct-lan-tone-120s-control-diagnostics-physical-20260731-0222" \
pnpm --dir apps/kit device:e2e -- \
  --no-flash \
  --port /dev/cu.usbmodem11201 \
  --build-directory firmware/targets/m5sticks3/build \
  --direct-lan-host 192.168.0.169 \
  --direct-lan-port 58685 \
  --tone-playback-only \
  --playback-duration-ms 120000 \
  --mount-timeout-ms 180000 \
  --exit-after-remote-proof \
  --device-clocked-downlink \
  --device-clocked-startup-frames 7
```

No serial monitor was attached during playback because prior physical evidence
showed that a serial reader can perturb the realtime result.

## Exact conservation and continuity evidence

The terminal device sample reported:

- downlink accepted: 6,000;
- playback submitted: 6,000;
- playback completed: 6,000;
- generation/freshness/partial-prebuffer/underrun/fatal frames flushed or
  dropped: zero;
- underrun, freshness, partial-prebuffer, DMA-deadline, queue-overflow,
  driver, write-backpressure, state, and protocol incidents: zero;
- generation-fence and lifecycle acknowledgement timeouts: zero;
- end-of-stream markers/responses: one/one;
- application downlink high-water: 6 frames;
- playback/DMA high-water: 4 frames;
- receive-to-DMA-start samples: 6,000, maximum 173 ms;
- downlink-interarrival samples: 5,999, maximum 80 ms;
- maximum successful-refill call duration: 94 us;
- minimum successful-refill reuse lead: 59,431 us;
- PCM receive calls/chunks: 30,067 / 6,060.

The host `/pcm` bridge reported 6,001 messages carrying 3,840,000 audio bytes,
a maximum send-callback payload ownership of 4,480 bytes/seven callbacks,
maximum callback latency of 1.834 ms, and zero bytes/callbacks still owned at
close. It closed normally with code 1000. The Cap'n Web `/api` connection
remained healthy for the proof and closed intentionally with code 3000 when
the main stub was disposed. No `control_reconnect_diagnostics` record exists
because no replacement generation was needed.

The CoreAudio recording analysis reported:

- observed tone span: 119,955 ms for 120,000 ms expected;
- missing tone: 45 ms, at the response boundary rather than as an internal
  hole;
- internal gaps: zero;
- longest internal gap: 0 ms;
- phase discontinuities: zero;
- maximum phase-step error: 0.07629 radians, below the 0.1-radian threshold;
- coherent tone-window ratio: 1.0;
- amplitude coefficient of variation: 0.05596;
- maximum amplitude step: 0.49444 dB;
- assessment: passed.

This acoustic oracle matters because device and transport counters alone
cannot prove that continuous DMA output became continuous air-pressure output.

## Runtime and compiled-resource evidence

The flashed ESP-IDF 5.4.2 target artifacts were:

- `iterate-kit-m5sticks3.bin`: 1,157,200 bytes,
  SHA-256 `bffbb54b5c8ecbfc9d62bee10a7da095756b353ea08629e0d2602e12f98be6d0`;
- `iterate-kit-m5sticks3.elf`: 17,380,900 bytes,
  SHA-256 `80ac7991e587e8fbc8fec9b21f92897a389c03ca4bb3e6c1ae9f18d2bd59d78e`;
- reported linked image segments: 1,157,078 bytes;
- flash text/data: 803,108 / 237,624 bytes;
- static DIRAM: 209,831 of 341,760 bytes (61.4%), leaving 131,929 bytes;
- DIRAM `.bss` / text / data: 109,896 / 79,507 / 20,428 bytes;
- RTC FAST: 52 bytes;
- real-target and realtime-ELF audits: passed.

Relative to the immediately preceding target build, the one-shot retained
control-diagnostics work cost 1,584 application-image bytes and 672 static
DIRAM bytes; reported IRAM use was unchanged.

At the terminal physical sample:

- free internal/DMA heap: 140,259 bytes;
- run minimum free internal/DMA heap: 123,535 bytes;
- largest free internal/DMA block: 49,152 bytes;
- free PSRAM: 8,384,776 bytes;
- audio-owner/main/control-network/PCM-network stack headroom:
  6,644 / 2,344 / 960 / 4,296 bytes;
- CPU: 262 permille at the terminal sample and approximately 280–301 permille
  through steady playback;
- maximum observed control/PCM network work-cycle counts:
  3,366,027 / 4,332,359.

There is no observed monotonic heap decline during the two-minute steady
section. The 960-byte control-task headroom is nonzero and its exhaustion
counter stayed zero, but it is sufficiently small to remain an explicit
longer-run/load-test watchpoint.

## Artifact ledger

- `run.log`: 415,959 bytes, SHA-256
  `248d7c974ec1fc179dc39d2333ab5e07f18219017cc5c716114c85d3dcbc2f29`
- `iterate-kit-acoustic-xQVag1/microphone.pcm16le`: 11,640,832 bytes,
  SHA-256
  `25a4ab767dc74370b0eee14a8580b4a752701b7661d861b0b9f966bbe7995132`

The raw log contains the complete one-second metric series and acoustic
provenance/markers, rather than only the terminal summary quoted here.
