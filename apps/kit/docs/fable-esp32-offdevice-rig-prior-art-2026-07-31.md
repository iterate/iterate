# Fable prior-art survey: deterministic ESP32 audio/transport testing

Status: durable research record, 2026-07-31. This is an independently produced
Fable Max source survey, condensed without treating its recommendations as
authority.

The complete 39,592-character Fable answer is retained in the Claude CLI
transcript:

```text
/Users/jonastemplestein/.claude/projects/-Users-jonastemplestein--herdr-worktrees-iterate-c-capabilities/b95cc9c2-7ab7-4c27-bf2f-ff13b4372b1e.jsonl
```

Its final assistant message UUID is
`90c1c0ff-fda0-4db7-b2be-9fe6f7991df8`. A separate Claude memory pointer is:

```text
/Users/jonastemplestein/.claude/projects/-Users-jonastemplestein-src-github-com-iterate-iterate/memory/project_kit_offdevice_rig_research_2026_07_30.md
```

The agent read this worktree, ESP-IDF 5.4.2 source at
`/Users/jonastemplestein/esp/esp-idf`, and source-level prior art from roughly
35 projects. Later attempts to give the live agent the narrower control-stall
follow-up prompt failed immediately at Claude's Team monthly-spend gate; the
failure is recorded rather than represented as completed research.

## Main finding

There is no single useful full ESP32-S3 simulator for this product's truth
surface. Espressif QEMU has useful CPU/FreeRTOS/heap/boot fidelity but no
Wi-Fi, I2S, or I2C models. Wokwi is cloud-timed and lacks S3 I2S. Renode has no
ESP32 platform. ESP-IDF's Linux target runs real FreeRTOS and transport/TLS
code, but its wall-clock signal/timer scheduling is deliberately not a
deterministic fault matrix.

The materially simpler design is a layered rig:

1. one small deterministic, virtual-clock, sans-I/O lane at the portable
   boundaries already present in Kit;
2. a lane compiling ESP-IDF's real WebSocket transport parser against a
   scripted parent transport;
3. thin real-stack Linux/QEMU integration lanes for drift that fakes could
   conceal;
4. physical hardware as the only authority for Wi-Fi, I2S/DMA, codec, AEC, and
   acoustic truth.

The key simplification is to avoid building an ESP32 emulator or a giant
scenario framework. Extract one iteration of each platform task loop into a
bounded step function; keep FreeRTOS creation/notification in a thin shell.
Tests can then own time, schedule, stream outcomes, and fake audio cadence
without replacing the production state machines.

## Most directly reusable prior art

The strongest immediately actionable source is ESP-IDF itself:

```text
components/tcp_transport/host_test/main/test_websocket_transport.cpp
```

Espressif compiles the real `transport_ws.c` and installs a scripted fake
parent through `esp_transport_set_func()`, including fragmented and bytewise
reads. This is a much stronger starting point than inventing a fake compatible
WebSocket parser. It can directly express the zero-byte mid-frame and torn
header cases implicated by the current transport investigation.

Other useful patterns, to copy rather than import wholesale:

- wslay/uWebSockets: a chunk-size schedule is the input, including in fuzz
  corpora;
- FoundationDB/Zephyr/TigerBeetle/picoquic: one virtual clock, jump to the next
  event, seed-derived schedules, and printed replay seeds;
- SQLite/curl: fail allocation or socket operation N, repeat until one clean
  no-fault iteration, and assert clean teardown every time;
- mbedTLS: real deterministic in-memory client/server handshakes over
  nonblocking ring-buffer BIOs;
- WebRTC AEC dump and NetEq: retain per-frame timing/arrival metadata from
  hardware and replay it off-device;
- PJSIP/baresip/Zephyr native audio: explicit put/get/loss scripts and
  pull-driven audio clocks rather than wall-clock sleeps;
- GenMC/CBMC: narrowly prove the SPSC atomic protocol and resumable writer,
  rather than model-checking the whole firmware.

## Proposed minimal primitives

The report recommends only a few reusable C99 test supports:

- virtual monotonic clock and next-event queue;
- scripted byte stream with accept-N, deliver-N, would-block, stall-until,
  disconnect, and corruption outcomes;
- server WebSocket-frame builder supporting arbitrary header/payload splits;
- cooperative scheduler for extracted task steps, with explicit and seeded
  schedules;
- counting/fail-at-N allocator;
- fake audio source/sink paced by independently drifting model clocks.

Every scenario should retain seed, virtual time, queue maxima, work-unit
counts, allocation peak, and exact terminal state. Probabilistic tools such as
Toxiproxy/netem remain useful robustness lanes, but their result must be an
invariant rather than a byte-exact schedule claim.

## Critical reconciliation

Accepted:

- build the deterministic rig at existing sans-I/O seams rather than a board
  emulator;
- reuse the real ESP-IDF `transport_ws.c` host-test pattern;
- extract task-loop steps only where a concrete red scheduler test requires
  it;
- use virtual time and exact scripted outcomes for the high-volume fault
  matrix;
- capture real physical timing shapes and replay them;
- keep Linux/QEMU/physical as separate fidelity layers;
- enforce production queue/token/memory budgets in fixture defaults.

Deferred:

- real mbedTLS in-memory handshakes until parser/task-loop tests pay for the
  extra integration;
- QEMU networking and IDF-Linux until the deterministic lane can state the
  invariants those smoke tests should check;
- general-purpose seeded PCT scheduling until at least two real task-step
  interleavings need it.

Rejected:

- emulation-first architecture;
- treating QEMU, IDF-Linux, Wokwi, or a host audio double as acoustic/AEC
  evidence;
- creating all proposed support files before a failing test needs them;
- using queue growth, random sleeps, or probabilistic loss as the primary
  explanation/fix loop.

The immediate application to the current failure is narrower than the report's
full roadmap: first prove control-vs-PCM scheduling and control-transport
stall/restart behavior with one extracted step or scripted fake. Do not build a
framework merely because the survey found rich prior art.
