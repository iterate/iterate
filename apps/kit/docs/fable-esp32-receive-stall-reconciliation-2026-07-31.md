# Reconciliation: Fable ESP32 receive-stall research

Status: engineering decision record, 2026-07-31. This reconciles the
independent report
[`fable-esp32-receive-stall-research-2026-07-31.md`](./fable-esp32-receive-stall-research-2026-07-31.md)
against the retained physical evidence and current source. The report is
research input, not an authority.

## Bottom line

The report found a materially simpler and better explanation for the repeated
`4013` signature. The approximately 160 ms / eight-frame observation is the
shape of the **host user-space ownership gate after the kernel stops accepting
more data**. It is not evidence that the device application stopped reading
for only 160 ms.

The strongest current reconstruction is:

1. playback and the device PCM reader are healthy until an abrupt loss of
   progress;
2. both application sockets become unobservable within the same one-second
   interval in the schema-5 failure;
3. the Mac kernel continues accepting paced audio from Node for roughly four
   seconds;
4. only after that hidden capacity fills do eight `ws.send()` callbacks remain
   outstanding long enough for the user-space 5,120-byte gate to close;
5. the acoustic recordings consequently contain about 4.15-4.20 seconds of
   terminal silence before the runner stops them.

This changes where the next work belongs. It does **not** justify another
audio queue, a larger freshness budget, a larger startup reserve, or a
redesign of the measured PCM polling loop. The immediate work is to make peer
progress and connection death honest, preserve the causal incident across
reconnect, and hard-abort stale kernel state.

## Independently checked facts

The following load-bearing report claims were checked again from this
worktree and machine rather than accepted from the prose:

- `sysctl` on the test Mac reports `net.inet.tcp.sendspace=131072` and
  `net.inet.tcp.recvspace=131072`.
- The flashed target configuration records a 5,760-byte TCP receive window,
  six receive-mailbox entries, 32 dynamic Wi-Fi RX buffers, a six-entry RX
  block-ack window, a 100 Hz FreeRTOS tick, and a 160 MHz CPU.
- At 50 frames/s and 644 WebSocket wire bytes per unmasked 640-byte PCM
  payload, 131,072 bytes alone represent about 4.07 seconds of media. Adding
  only the configured device TCP window gives about 4.25 seconds. This is the
  right order and closely matches the acoustic terminal-silence invariant.
- In the schema-5 `0134` run, every delivered one-second sample through
  sequence 44 advances `pcmReceiveCalls` at roughly 248 calls/s,
  `pcmReceiveChunks` at roughly 50 chunks/s, and `downlinkAccepted` at
  50 frames/s. The next control sample never arrives.
- The separate `/api` control socket and `/pcm` evidence cease being
  observable in the same interval in that run. A PCM-reader-only stall would
  instead leave later control samples showing frozen PCM counters.
- The four retained `4013` microphone recordings have no internal tone gaps
  before the terminal loss and have approximately 4.15-4.20 seconds of
  terminal silence. Passing controls have only the ordinary recorder teardown
  tail.
- The bridge removes a payload from its exact ledger in the `ws.send()`
  callback. On Node/ws that callback establishes that user-space ownership can
  be released after the bytes enter the socket write path; it does not
  establish application receipt by the ESP32.

The byte arithmetic is compelling corroboration, not a packet-level proof of
exact kernel occupancy. TCP auto-sizing, congestion state, retransmissions,
device receive state, and WebSocket framing all affect the precise hidden
capacity. The loopback experiment demonstrates the callback blind spot, but a
loopback socket is not the physical Wi-Fi path. A packet capture remains the
clean way to make the transport reconstruction exact.

## Corrections to the report

### “Firmware is exonerated” is too broad

The evidence substantially excludes one narrow hypothesis: the PCM
application reader gradually slows or disappears while the rest of the
device and its control connection remain healthy. It does not exonerate the
device endpoint as a whole.

The final delivered counter sample proves that the PCM task was polling until
the last observable second. It cannot prove that the task continued polling
during the subsequent unobservable interval. A device Wi-Fi driver failure,
tcpip-thread wedge, shared network-stack failure, radio disassociation, AP
failure, or Mac-side radio interruption can all still remove both sockets.
The report itself assigns nonzero probability to a device Wi-Fi/lwIP wedge.
Until the retained ESP-IDF error tuple, Wi-Fi disconnect reason, or a packet
capture names the layer, the correct term is **bidirectional endpoint/path
outage**, not proven environmental RF failure.

### Several timeline events are reconstructions, not observations

The inferred outage start, accepted-frame count at that instant, device idle
probe firing, RST behavior, and exact kernel backlog are consistent with the
measurements but were not directly retained. They remain hypotheses with
strong numerical support. Durable notes and acceptance output must label them
as such.

### A WebSocket PONG is transport progress, not full audio acceptance

A PCM-socket PING/PONG barrier is attractive because it can detect a dead
path while the kernel is still accepting audio. Ordering makes a returned
PONG strong evidence that the peer WebSocket parser reached the barrier. It
does not by itself prove that all preceding frames were admitted to the
freshness-bounded PCM lane or scheduled for playback. Those remain separate
conservation counters.

Therefore the next protocol change should not blindly replace all progress
semantics with PING/PONG. First prove the current failure layer using the
retained control incident and passive capture. If a transport barrier is then
added, its contract must be named narrowly: parser progress by a deadline,
paired with the existing application acceptance and playback counters.

### The one-hertz metrics stream is not a freshness gate

`downlinkAccepted` is useful device truth and excellent postmortem evidence.
At one sample per second, over a control connection that can die with the PCM
path, it cannot enforce a sub-second PCM freshness policy. It should remain a
diagnostic and acceptance signal, not become the realtime data-plane
conductor.

## Recommendations accepted now

- Keep the exact `ws.send()` ledger, but describe it as a user-space
  ownership/resource bound. Stop claiming it alone proves peer freshness.
- Do not increase any host or device audio queue in response to this incident.
- Keep device-clocked pacing, fixed rings, generation fences, the seven-frame
  experimental startup watermark, and the current bounded receive loop while
  they continue to meet measured deadlines.
- Preserve a control-transport incident across reconnect and expose it through
  a one-shot capability. This is already implemented with a caller-owned
  640-byte reply buffer, no log queue, no idle wire traffic, and a
  generation-aware host observer.
- A reconnect during an endurance proof remains a test failure. Reconnecting
  only lets the harness retrieve the causal snapshot; it must never turn an
  interrupted run green.
- On a freshness failure, the host must eventually use a hard socket abort
  whose tested contract makes old kernel-buffered speech undeliverable. A
  graceful WebSocket close is not sufficient for this policy.
- Retain the rolling device history and terminal snapshots in artifacts.
- Use packet capture and independent reachability probes during a bounded
  failure-hunting run when they can be collected without perturbing device
  audio.

## Recommendations deferred or rejected

- Do not increase the lwIP receive mailbox merely because the six-slot
  refused-data cliff exists. It is a real latent amplifier, but the current
  failures do not implicate it. Change it only after a deterministic test or
  packet trace shows that signature.
- Do not pin tasks, change CPU frequency, change the FreeRTOS tick, disable
  AMPDU, or move to UDP without evidence tied to an observed failure.
- Do not split RX and TX into separate transport owners. That would discard a
  useful single-owner invariant and add stacks/state without a measured need.
- Do not replace the current receive polling loop as a response to these
  outages. A socket-driven wakeup remains a possible later CPU/jitter A/B, not
  a causal fix.
- Do not treat a clean minute as acceptance. The observed incident rate
  requires repeated and longer runs before reliability claims.

## Work implemented before the next physical run

The following red-first work now exists locally:

- schema-5 cumulative PCM lower-read and byte-chunk counters;
- exact ESP-IDF control-WebSocket error tuple retained across reconnect,
  including generation, error type, TLS fields, transport `errno`, handshake
  status, close status, Wi-Fi disconnect count, and last Wi-Fi reason;
- a one-shot `getDiagnostics()` capability using fixed caller-owned storage;
- strict TypeScript parsing and named error classification;
- generation-aware mount observation that waits for a replacement session,
  retrieves its retained incident, logs it, and still fails the endurance run;
- C tests for normal, overlapping, and maximum-width diagnostics replies;
- TypeScript tests for parsing, reconnect observation, and real C-peer
  capability exposure.

The complete firmware host suite passes 38/38, the focused TypeScript suites
pass 30/30, and `apps/kit` type-checks. The real target and realtime-ELF audits
also pass. The retained diagnostics path adds 1,584 image bytes and 672 static
DIRAM bytes relative to the immediately preceding build, with reported IRAM
unchanged.

The resulting image was flashed after re-identifying the Stick by its stable
USB serial/MAC. A two-minute device-clocked direct-LAN physical run then
accepted, submitted, and completed all 6,000 frames. All incident counters
remained zero, neither WebSocket reconnected, and the Mac acoustic oracle
found zero internal gaps and zero phase discontinuities. Full evidence is in
[`direct-lan-tone-120s-control-diagnostics-physical-20260731-0222/observation.md`](../evidence/m5sticks3-playback/direct-lan-tone-120s-control-diagnostics-physical-20260731-0222/observation.md).
This is a successful instrumentation/continuity proof, not a root-cause
finding: because no connection failed, the retained incident branch was not
exercised and the earlier bidirectional outage remains unexplained.

## Next evidence sequence

1. Treat the completed clean two-minute proof as the continuity baseline, not
   as evidence that the intermittent outage is fixed.
2. Add a deterministic red host test for hard-aborting a stale/freshness-failed
   socket, then implement the smallest close-path change that guarantees old
   kernel-buffered speech cannot be delivered after reset.
3. Run bounded fault-injection tests for stalled callbacks, kernel-accepted
   backlog, delayed delivery, socket replacement, and immediate fresh-audio
   recovery.
4. Repeat the physical ladder under bounded lower-priority load. If either
   socket reconnects, retrieve the exact retained diagnostics from the
   replacement generation and fail the run.
5. If the retained tuple does not localize the layer, use a bounded Mac packet
   capture and AP/device reachability probes rather than changing firmware
   queues speculatively.
6. Continue to longer playback only after the deterministic recovery
   contracts are green, then build the equivalent microphone/PTT ladder.

This sequence adopts the report's architectural simplification: the measured
audio data path stays small and stable while observability and close semantics
become honest. It rejects the report's strongest causal overclaim and leaves
the endpoint/network layer unresolved until the next physical evidence names
it.
