# Fable Max: localise and simplify the physical ESP32 station outage

Act as an independent embedded networking, real-time audio, and ESP-IDF
architect. Work in:

`/Users/jonastemplestein/.herdr/worktrees/iterate/c-capabilities`

Do not edit implementation or tests. Write your complete, source-cited report
to:

`apps/kit/docs/fable-esp32-station-outage-research-2026-07-31.md`

## Measured problem

The M5StickS3 uses two independent WebSockets:

- Cap'n Web control/capabilities on `/api`;
- a deliberately simple binary PCM lane on `/pcm`.

PCM16 mono is 16 kHz, exactly one 640-byte / 20 ms WebSocket message. The
device's PCM task is Core 0 priority 6; control networking is Core 0 priority
5; the audio owner is Core 1 priority 19. Queues and freshness are bounded.
The host fails closed at eight outstanding send callbacks / 5,120 payload
bytes and uses a TCP hard reset; stale speech is never replayed.

Some 60-second runs are acoustically perfect. Under the latest 20 Hz
`getDiagnostics` control load, both WebSockets independently stop receiving
device-side progress after roughly 22 seconds of continuous audio. The host
does not observe PCM user-space backpressure until several seconds later
because macOS can accept about 131 KiB into its TCP send buffer.

The newest matched run added 10 Hz ICMP to the Stick:

- the apparent 44.9% loss consists of exactly two contiguous intervals;
- the first is the expected approximately 17.5-second device reset/reboot
  interval before mounting;
- the second is approximately 17.2 seconds and overlaps the coupled PCM and
  control stall;
- replies are continuous immediately before and after it;
- playback is continuous before abrupt truncation rather than accumulating a
  playable backlog;
- the previous short postmortem deadline destroyed the server before the
  station recovered, so the retained ESP-IDF disconnect reason was not read.

Read the exact evidence first:

- `apps/kit/evidence/m5sticks3-playback/direct-lan-tone-60s-diagnostics-churn20-inbox8-ping-physical-20260731-0414/observation.md`
- its `run.log` and `ping.log`
- `apps/kit/docs/audio-streaming-problem-and-evidence-2026-07-30.md`
- `apps/kit/docs/fable-esp32-receive-stall-reconciliation-2026-07-31.md`

## Required source trawl

Inspect the actual implementation and build configuration, especially:

- `apps/kit/firmware/platforms/iterate_esp_idf/`
- `apps/kit/firmware/targets/m5sticks3/`
- `apps/kit/firmware/devices/m5sticks3/`
- relevant firmware tests and host E2E diagnostics code
- the selected local ESP-IDF source under
  `/Users/jonastemplestein/esp/esp-idf`, including Wi-Fi event/reconnect
  behavior, station disconnect reason codes, watchdog/task starvation,
  esp_websocket_client, esp_transport, lwIP, TCP/IP mailbox, power-save, and
  FreeRTOS scheduling/core affinity
- the local M5Stack/M5Unified/M5StickS3 driver code actually selected by the
  build
- authoritative ESP-IDF documentation and issues
- materially relevant third-party ESP32 audio/WebSocket implementations and
  failure reports; prefer source over summaries

## Questions

1. Rank mechanisms that can make the entire ESP32 station address unreachable
   for approximately 17 seconds under this load. Separate an actual Wi-Fi
   disconnect, task/driver starvation, watchdog/reset, AP station eviction,
   power-save interaction, heap/resource failure, and host/AP-path failure.
2. For each plausible mechanism, name the smallest non-perturbing
   discriminator already present or worth adding. Prefer retained counters and
   one-shot postmortem state over serial logging, periodic logging, or queues.
3. Explain the exact ESP-IDF reconnect timing that could yield roughly 17
   seconds, with source paths/lines and reason-code behavior. State where the
   timing does not match.
4. Challenge the current two-network-task architecture. Propose materially
   different designs, explicitly prioritising simplifications that delete
   scheduling, queue, polling, or reconnect policy. Compare:
   - the current separate task per WebSocket;
   - one network owner using socket readiness;
   - direct sockets/sans-I/O WebSocket framing;
   - esp_websocket_client event/task ownership;
   - moving affinity/priorities;
   - any credible alternative found in source or prior art.
5. Preserve the non-negotiable audio contract: incoming PCM must be playable
   ASAP; captured mic PCM must be sent ASAP; interruption and network recovery
   discard stale data; buffers are bounded; metrics expose latency/depth/drop
   causes; audio remains top priority; RAM/CPU/code size matter.
6. Design the smallest red-first off-device and physical A/B sequence that
   identifies the cause. Include a router-control ping, retained Wi-Fi reason,
   reset/watchdog provenance, and any source-level fault injection that can
   reproduce it without pretending a simulator models the RF stack.
7. Identify any local maximum: where is the code solving complexity it created
   itself, and what refactor could produce a materially smaller and more
   reliable system?

Rank recommendations by evidence and expected information gain. Estimate RAM,
CPU, task-stack, and code-size effects where credible. Clearly separate:

- measured facts;
- source-supported inference;
- speculation;
- safe diagnostic changes;
- candidate fixes requiring an A/B proof.

Do not recommend larger audio buffers, stale retries, or hiding the failure
behind reconnect. Do not assume either the firmware, AP, or host is innocent.
