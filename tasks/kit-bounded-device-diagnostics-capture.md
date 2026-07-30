---
status: in-progress
priority: high
size: large
dependsOn: []
---

# Build bounded high-fidelity device diagnostics capture

Iterate Kit's physical test proof needs a durable, machine-readable record of
device logs, metrics, and timing events without allowing observability work to
delay PCM capture or playback or to create an unbounded ESP32 memory backlog.

This task owns the outer diagnostics layer. Realtime audio code may publish
only fixed-cost counters and bounded records. Export, formatting, persistence,
and retention are lower-priority policies selected by the target and test
controller.

## Required shape

- Define a small allocation-free core diagnostics producer with monotonic
  sequence numbers, monotonic timestamps, stable event identifiers,
  severity/classification, and fixed-size payloads.
- Keep current-value/lifetime metrics as directly readable snapshots. Use a
  separately bounded lossy event ring only for diagnostics whose ordering is
  important.
- Overflow is explicit: never block audio, never overwrite without a counter,
  and publish the exact lost-record count plus the first/last affected
  sequence. A diagnostic exporter must be safe to starve indefinitely.
- Provide outer sinks for:
  - Cap'n Web live metrics/diagnostics subscriptions;
  - host-side durable JSONL or another replayable artifact;
  - optional microSD batching on targets that have a card and can afford the
    lower-priority I/O.
- Do not put FatFS, SDMMC, Cap'n Web encoding, string formatting, filesystem
  I/O, or network writes on an audio-critical path.
- The nearby computer is the authoritative test recorder through a Cap'n Web
  callback/subscription. Device-local microSD is an optional resilience sink,
  not the default source of truth. Do not add a custom firmware-side USB/JTAG
  diagnostics writer.
- Include boot/session identity, firmware version, device identity, connection
  generation, audio epoch, and capture/playback frame sequence where those
  fields permit cross-layer correlation.
- Apply explicit sampling/cardinality policies. Per-frame latency can be
  summarized in fixed-memory histograms while anomalies and bounded trace
  windows retain individual records.
- Record producer cost, exporter cost, exporter queue depth/high-water/drops,
  free/minimum heap, internal RAM and PSRAM separately, task stack
  high-water marks, and CPU/task utilization.
- Inventory every buffering layer and label each reported value as:
  - `observed`, when the device can read an exact current depth;
  - `derived_bound`, when protocol acknowledgements bound bytes that may exist
    across several opaque layers;
  - `capacity`, when only a configured maximum is available;
  - `unavailable`, when an ESP-IDF, TLS, Wi-Fi, codec, or peripheral layer has
    no supported probe.
- Exact owned metrics include application PCM rings, retained WebSocket frame
  bytes, diagnostic rings, image/photo transfer windows, and audio/DMA
  ownership exposed by each hardware adapter.
- Treat peer-unconfirmed PCM frames/bytes and oldest capture age as the
  portable end-to-end bound over WebSocket, mbedTLS, lwIP, and Wi-Fi queues.
  Never infer peer receipt merely from a successful local socket write.
- An optional, isolated ESP-IDF diagnostic probe may inspect lwIP TCP
  `snd_buf`, `snd_queuelen`, `unsent`, and `unacked` in physical debug builds.
  Private lwIP structures must not become a correctness dependency or leak
  into the portable core.

## Acceptance proof

1. Deterministic host tests starve every exporter while capture and playback
   continue. Audio deadlines and queue bounds remain unchanged; diagnostics
   report their own exact loss.
2. A fixed-memory/zero-steady-state-allocation gate covers diagnostic
   production, snapshot reads, and overflow handling.
3. A CPU work-unit or cycle budget proves that producing one routine PCM
   observation has bounded cost. Rich string/JSON encoding is measured only in
   the background exporter.
4. Reconnect, packet-loss, memory-pressure, queue-full, interruption, and
   restart scenarios produce stable classified records and can be replayed by
   seed or captured trace.
5. The TypeScript physical-device runner subscribes as soon as the mounted
   Cap'n Web target is reachable, writes a durable artifact on the computer,
   and reports callback sequence gaps rather than hiding them.
6. Optional microSD tests cover absent card, full card, slow writes, removal,
   corruption/write error, rotation, and reboot recovery. Every failure
   degrades only that sink and is visible through another sink.
7. One-, two-, and ten-minute physical reports include a manifest, firmware
   size, resource summary, time-series metrics, classified log records, gap
   counters, and enough correlation data to explain every audio drop/restart.
8. Tests assert that every buffer listed in the inventory has a metric or an
   explicit `unavailable` reason; reports cannot silently omit opaque queues
   or present a configured capacity as current occupancy.

## Source requirement

> and you need to have some system to generate and pull logs of metrics and log lines / diagnostics from the device - and possibly even write them to microsd card if there is one - but that should be decided on the "outer layer" - but once you get to device testing, it's just super important that you can do tests with very high fidelity logs and metrics streams without blowing out each device's memory
>
> if you can't get to this right now, you should put this in a task markdown file

Clarification:

> We don't want the firmware-side USB JTAG diagnostics writer.
>
> All I said is you should have metrics and diagnostics that you should either get by just providing a callback function to a Captain Web endpoint on the device or if there's an SD card maybe in the future we just write everything to an SD card.

## Progress ledger

This section is the durable hand-off for work performed against this task. It
records both evidence and deliberately deferred scope so that a later physical
run cannot silently inherit assumptions from an earlier USB layout or review.

### 2026-07-30

- The host Cap'n Web compatibility gate is green through the real JavaScript
  `RpcSession` and the sanitized C peer:
  `pnpm --dir apps/kit firmware:test:capnweb` passes seven interop cases after
  native CTest. The typed known-failure cases execute and assert their exact
  protocol status; they are not skipped.
- Both ESP-IDF WebSocket gates are green:
  `firmware:test:websocket:control` proves the repository patch with 93
  assertions across nine cases and separately proves the two expected failures
  against stock ESP-IDF.
- All four ESP32-S3 boards on the shared hub are now positively identified.
  Stable native USB/JTAG serial identity is the selection authority:
  - StackChan/CoreS3 `68:EE:8F:D8:53:20`, observed at
    `/dev/cu.usbmodem11101`;
  - free M5StickS3 `70:04:1D:D5:45:88`, observed at
    `/dev/cu.usbmodem11201`;
  - Waveshare touch device `1C:DB:D4:7A:16:C8`, observed at
    `/dev/cu.usbmodem11301`;
  - Home Assistant Voice Preview Edition `D8:3B:DA:46:20:34`, observed at
    `/dev/cu.usbmodem11401`.
  All four use VID:PID `303a:1001`, so neither VID/PID nor the ephemeral port
  suffix distinguishes them. The complete evidence and re-plug/flash safety
  procedure is in
  `apps/kit/firmware/docs/connected-device-inventory.md`.
- Read-only ROM/flash-header probes identified the Waveshare app as
  `phone_s3_box_3` and the Voice Preview Edition app as
  `voice-pe-speaker-reference` version `2026.2.4`. The probes changed no flash,
  but did reset those two devices. StackChan was not opened or reset because
  another agent owned it.
- The agreed test seams for the first diagnostics slice are:
  1. a portable C `offer snapshot -> bounded pump -> short-write sink` API;
  2. the existing TypeScript `parseDeviceRuntimeLogLine` and
     `assessDeviceRuntimeMetrics` boundary consuming the C-formatted output;
  3. the Cap'n Web callback/subscription recorder consuming the bounded
     snapshots.
  Tests must observe those public seams rather than private formatter helpers.
- A proposed custom USB Serial/JTAG diagnostics writer and all of its tests
  were removed after the architecture was clarified. USB console behavior is
  not part of the diagnostics design. Device metrics leave through Cap'n Web
  callbacks/subscriptions; optional SD persistence remains an outer target
  policy for later.
- The portable slice now exists as
  `iterate_kit_runtime_diagnostics_{init,offer,pump,metrics}`. It owns one
  snapshot and one 896-byte line, allocates nothing, makes at most one sink
  call per pump, retains short-write suffixes exactly, and classifies both
  zero-progress stalls and impossible sink return counts. The complete
  `pnpm --dir apps/kit firmware:test:diagnostics` gate is green through the
  native C tests and the real TypeScript parser/health assessor.
- Host layout is 1,304 bytes on the current 64-bit ABI and is gated below
  1,400 bytes; the exact ESP32 layout still has to be captured from the target
  build/runtime log. Saturated maximum-width wire lines are pinned at 830
  bytes for system, 594 for control, and 851 for PCM, leaving 44 usable bytes
  plus the formatter NUL in the 896-byte storage.
- Wraparound and starvation regressions are green. Hardware work accumulators
  use intentional modulo-2^32 subtraction across wrap; nine skipped cadences
  advance baselines so the next accepted report describes one current
  interval rather than the outage. Exporter incident counters are carried on
  the next report so the loss remains remotely observable.
- Still outstanding in this task: the ordered fixed-record diagnostic event
  ring and exact loss interval, buffer-inventory completeness gate, optional
  microSD policy, and a passing one/two/ten-minute physical proof. The portable
  C slice is only the allocation-free metric snapshot/export foundation and
  must not be described as satisfying those later acceptance items.
- The host playback ladder now generates a run-keyed dual-carrier PRBS31
  source, derives its canonical PCM16 byte length and SHA-256 with at most an
  8 KiB encoding buffer, independently reopens and verifies the retained
  source artifact with at most a 64 KiB read buffer, and persists both that
  source identity and the independently recorded acoustic-capture identity.
- A complete source hash, frame count, and end marker are explicitly
  insufficient for realtime acceptance. Each stage now requires separate
  bounded cadence summaries from the host provider clock and the device
  ingress clock: full frame/gap spans, early/late counts, min/max and
  p50/p95/p99 inter-frame gaps, maximum absolute-media-deadline lateness, and
  missed-deadline count. Internally inconsistent summaries fail before a
  manifest can be accepted.
- The measured public-tunnel regression is retained as a failing-mode test:
  3,000 correct frames and an exact SHA/EOS still fail when device ingress
  observes 81 gaps below 15 ms, 75 above 25 ms, p95 31.44 ms, p99 52.7 ms,
  and a 100.5 ms maximum. The ladder records the failure and does not advance
  beyond the first one-minute idle stage.
- The off-device command-path test exercises the complete acceptance matrix
  (one, two, and ten minutes, each idle and under capability churn) without
  waiting in wall-clock time. It verifies exact first-stage source and capture
  hashes plus durable per-stage JSONL manifests. This proves orchestration and
  judgment only; a physical pass still requires the M5StickS3 capability to
  supply real device-ingress cadence, load, metrics, and acoustic evidence.
