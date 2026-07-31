# Code/complexity reduction audit — v1 measured, v2 projected

Exploration-round artifact for the kit v2 refactor (brief requirement 1: reduce
code and complexity; requirement 6: keep the best things). All LOC are `wc -l`
on the current `c-capabilities` working tree, 2026-07-31, first-party files
only (build artifacts under `.build/`, `build-host*/`, `managed_components/`
excluded). Every factual claim about existing code carries file:line. Estimates
are labeled with confidence; this is the honest version, including the places
where v2 gets BIGGER.

Companion inputs: `../inputs/brief.md`,
`../../fable-firmware-architecture-review-2026-07-31.md` (R1–R13),
`../inputs/agent-reports/{firmware-core,firmware-audio,host-pipeline}.md`.

---

## 1. v1 as measured

### 1.1 Firmware (`apps/kit/firmware`)

| Module                                    | Production LOC | Notes                                                                                                                                                                                                                                                                       |
| ----------------------------------------- | -------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vendor/capnweb` (lib)                    |      **3,546** | src 2,980 + internal headers 115 + `capnweb.h` 451. Biggest: `session.c` 1,010, `json.c` 479, `value.c` 431, `expression.c` 344                                                                                                                                             |
| `vendor/capnweb` tests+tools              |          1,779 | `session_test.c` 809, `native_peer.c` 693, fuzzer 114, `resource_profile.c` 163                                                                                                                                                                                             |
| `components/core` — control/plumbing half |      **5,812** | itx_mount 594, websocket_text 538, runtime_diagnostics 505+250h, configuration 422, websocket_tx 409+179h, peer 328, itx_connection 275, spsc_ring 257, device_events 198+131h, websocket_rx 190, frame_writer 190, cpu_usage 92, retry_gate 76, atomic.h 74, small headers |
| `components/core` — PCM/audio half        |      **3,888** | pcm_lane 696+229h, peer_delivery_guard 629+256h, uplink_conductor 586+195h, uplink_sender 462+175h, audio 368+159h, pcm_websocket 63+70h                                                                                                                                    |
| `components/capabilities`                 |      **3,472** | **metrics.c 1,510 + metrics.h 391 = 55% of the component**; device_event_stream 549+104h; leds 127, camera 92, servos 90, push_to_talk 83, screen 78, rpc_internal 63, callback_budget 43                                                                                   |
| `platforms/iterate_esp_idf`               |      **5,432** | itx_transport.c 1,624 + 386h, pcm_transport.c 1,181 + 265h, websocket_connection.c 685 + 261h, esp_idf_direct_i2s_backend.hpp 689, policy.h 139, configuration.c 137 + 65h                                                                                                  |
| `platforms/common`                        |      **3,630** | realtime_playback.hpp **1,863**, direct_i2s_stereo_output.hpp 710, **bounded_playback.hpp 389 (dead)**, bounded_capture.hpp 258, realtime_owner_control.hpp 252, 3 small headers                                                                                            |
| `platforms/iterate_m5unified`             |      **1,567** | m5sticks3_direct_audio.cpp 802 + 254h, m5unified.cpp 368 + 143h                                                                                                                                                                                                             |
| `devices/`                                |            625 | m5sticks3 284+133h, stackchan 131+77h                                                                                                                                                                                                                                       |
| `targets/m5sticks3`                       |      **1,349** | one file, `main/main.cpp`; `sampleRuntimeMetrics` alone is :455–924 (~470 LOC)                                                                                                                                                                                              |
| `simulator/`                              |          1,907 | resource_profile.cpp 584, devices/m5sticks3.cpp 460, runner 317+54h, devices/stackchan.cpp 301, hardware 125+66h                                                                                                                                                            |
| **Firmware production total**             |     **31,228** |                                                                                                                                                                                                                                                                             |
| `tests/` (first-party)                    |         18,948 | realtime_playback_test.cpp 1,989, pcm_uplink_conductor_test 1,190, metrics_subscription_test 1,169, direct_i2s_stereo_output_test 1,104, esp_idf_itx_transport_test 982, fakes 1,800+, tcp_transport_host main 282                                                          |
| **Firmware tests total (incl. capnweb)**  |     **20,727** |                                                                                                                                                                                                                                                                             |
| Build system                              |         ~1,640 | root `CMakeLists.txt` **1,008** (38 `add_test`, 39 `add_executable`), 12 more CMakeLists 449, idf_overrides patch machinery 258                                                                                                                                             |

### 1.2 Host (`apps/kit/src` + `scripts`)

| Module                             | Production |      Tests | Notes                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ---------: | ---------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/voice/`                       |      1,445 |      1,488 | device-pcm-proxy.ts **931**, deterministic providers 323, grok-realtime-voice 143                                                                                                                                                                                                                                                                        |
| `src/device/`                      | **11,889** |     11,187 | acoustic-tone-analysis.ts **1,307**, acoustic-prbs31-challenge.ts 1,143, endurance family ≈3,000 prod (target 955, run-manifest 828, validation 659, types 333, ladder 124, evidence-writer 114), local-fetch-websocket-server 697, device-runtime-log 580, macos-pcm16-capture 571, physical-network-\* 1,361, firmware-architecture.test.ts 694 (test) |
| `scripts/` (kit voice/device)      |  **3,987** |          — | device-e2e.ts **1,752** (`runDeviceE2e` = :164–1254, ~1,090 LOC), prove-production-m5sticks3-grok.ts 786, prove-production-m5sticks3-tone.ts 559, voice-e2e.ts 351, sync-firmware-assets 185, test-firmware-websocket 150, flash 84, misc 120                                                                                                            |
| `src/firmware/` (flasher/build TS) |      1,286 |        433 | config-image 270, esptool-cli 238, catalog 147                                                                                                                                                                                                                                                                                                           |
| **Host totals**                    | **18,607** | **13,108** |                                                                                                                                                                                                                                                                                                                                                          |

### 1.3 Grand totals

|              | Production |      Tests |     Build |      Total |
| ------------ | ---------: | ---------: | --------: | ---------: |
| Firmware     |     31,228 |     20,727 |     1,640 |     53,595 |
| Host         |     18,607 |     13,108 |         — |     31,715 |
| **v1 total** | **49,835** | **33,835** | **1,640** | **85,310** |

Context worth keeping in mind: about **41% of the firmware production LOC is
the audio path** (core PCM half 3,888 + platforms/common playback 3,630 +
m5unified 1,567 + esp_idf pcm_transport+backend 2,135 ≈ 11.2k) and it is the
best-tested, most physically-proven code in the tree. The reduction targets
below deliberately avoid it except where code is literally dead.

---

## 2. Reduction opportunities

### (a) Known duplication from the review

#### a1. Atomics helpers — copy-pasted in EIGHT files, not six

The review said six; measurement says eight. `atomic.h` (74 LOC,
`components/core/include/iterate/kit/atomic.h`) exists and its own comment
argues for centralizing ("Centralizing the compare/exchange loops prevents a
seemingly harmless plain increment from being copied…", atomic.h:28–32). Local
static copies of `atomic_saturating_increment` / `atomic_update_max` /
load/store/exchange wrappers:

| File                                            | Lines                                                      |
| ----------------------------------------------- | ---------------------------------------------------------- |
| `components/core/src/spsc_ring.c`               | :42, :55                                                   |
| `components/core/src/pcm_lane.c`                | :60, :73                                                   |
| `components/core/src/pcm_uplink_sender.c`       | :30, :43                                                   |
| `components/core/src/pcm_uplink_conductor.c`    | :30, :43                                                   |
| `components/core/src/pcm_peer_delivery_guard.c` | :65, :78, :95                                              |
| `components/core/src/websocket_tx.c`            | :47                                                        |
| `platforms/iterate_esp_idf/pcm_transport.c`     | :76–115 (load/store/exchange/increment/max — five helpers) |
| `platforms/iterate_esp_idf/itx_transport.c`     | :139–169                                                   |

Each copy is 25–45 LOC with its own reasoning comment (verbatim-duplicated
"Incident counters survive unattended endurance runs…" text, e.g.
itx_transport.c:139–145). Fix: extend `atomic.h` with the named
acquire/release variants the transports legitimately need
(`iterate_kit_atomic_store_release_u32`, `_load_acquire_u32`,
`_exchange_relaxed_u32`) — the header's "do not extend ambiguously" rule is
satisfied by _named_ memory-order variants.

**Delta: −250 deleted, +30 in atomic.h → net −220. Risk: low-medium**
(memory-order-sensitive code, but the change is mechanical and every file has
a host test; `atomic_test.c` extends to cover the new helpers).

#### a2. The metrics/diagnostics schema — not triplicated; SIX device-side copies plus three host parsers

This is the single largest complexity concentration in the codebase. The same
counter families exist as:

1. **Platform metrics structs** — `esp_idf_itx_transport.h:108–163`,
   `esp_idf_pcm_transport.h` (equivalent block).
2. **Capability sample structs** — `metrics.h:33–282` (391-line header;
   `playback_metrics_sample` alone has ~50 fields).
3. **Cap'n Web expression builder** — `metrics.c:83–920` (~838 LOC of
   `set_integer_field` calls with hand-counted key lengths: `"sent", 4U` at
   metrics.c:351–353, `"consecutiveSendDeferrals", 24U` at :405–407, mixed
   with `sizeof("…")-1` style — 28 `sizeof("` occurrences in the same file).
4. **`getDiagnostics` snprintf formatter** — `metrics.c:1001–1207` (~206 LOC,
   one giant format string plus a conditional network sibling).
5. **`runtime_diagnostics` snapshot + console line formatter** —
   `runtime_diagnostics.h:57–131` (a _third_ struct spelling of the same
   counters: `websocket_errors` vs `last_websocket_error_type` vs
   `control_receive_failures`) + `runtime_diagnostics.c` (505 LOC).
6. **The target's hand-mapping** — `targets/m5sticks3/main/main.cpp:455–924`:
   `sampleRuntimeMetrics` is ~470 LOC of
   `sample->audio.uplink.sent = saturatingMetricValue(pcm.uplink_frames_sent)`
   field-by-field transcription from (1) into (2).

Host side, hand-mirrored again: `src/device/kit-control-diagnostics.ts` (104,
strict zod at schemaVersion 3), `src/device/kit-playback-metrics.ts` (132),
and the console-line parser inside `src/device/device-runtime-log.ts` (580).

**v2 shape — one X-macro field table** (R7, extended further than the review
took it):

```c
/* components/core/include/iterate/kit/metrics_schema.def
 * One row per counter: (family, c_name, wireKey, type, surfaces)
 * surfaces is a bitmask: SAMPLE | DIAG_JSON | CONSOLE | HOST  */
KIT_METRIC(uplink, sent,                    "sent",                    U32, S|C|H)
KIT_METRIC(uplink, dropped,                 "dropped",                 U32, S|C|H)
KIT_METRIC(uplink, consecutive_send_deferrals,
                                            "consecutiveSendDeferrals",U32, S|H)
KIT_METRIC(control, websocket_errors,       "websocketErrors",         U32, S|D|C|H)
/* … */
```

Expansions: (i) the sample struct (replaces most of metrics.h), (ii) a
~120-LOC generic expression emitter looping the table (replaces the 838-LOC
builder — key lengths become `sizeof(wireKey)-1` by construction), (iii) the
snprintf format assembled from the table (replaces the 206-LOC formatter and
the runtime_diagnostics line formatter), (iv) a tiny generator emitting the
zod schema for TS (replaces the three hand parsers and converts
"firmware field change breaks host parse" from a runtime discovery into a
codegen diff). The 470-LOC main.cpp mapping disappears differently: the
platform sampler writes the canonical struct _directly_ (the struct IS the
table expansion), leaving ~80 LOC of genuinely target-specific glue (stack
headroom queries, has_audio wiring).

The existing maximum-width serialization regression
(`metrics_subscription_test.c`, the 1536-byte
`ITERATE_KIT_METRICS_DIAGNOSTICS_EXPRESSION_CAPACITY` proof at
metrics.h:357–364) carries over unchanged as the guard that the generated
serializers still fit the 2 KiB control slot.

**Delta: device −2,164 / +460 (table + emitters + glue) → net ≈ −1,700;
host −816 (three parsers) / +250 (generated schema + generator) → net ≈ −560
counting only the parsing halves of device-runtime-log.ts.
Combined net ≈ −2,260. Risk: medium** — serialization-size proofs must be
regenerated; the failure mode ("new counter must be threaded through five
files", review §5) becomes "add one table row". Biggest single win in the
audit.

#### a3. `withTimeout` ×3 + `waitForOpen` ×2 (host)

Definitions: `scripts/device-e2e.ts:1342`, `scripts/voice-e2e.ts:332`,
`src/device/control-mount-diagnostics.ts:157`; `waitForOpen` in
`src/voice/grok-realtime-voice.ts:114` and
`src/userspace/config-worker/providers.ts:272`. One `src/device/async.ts`.
**Delta: net −40. Risk: trivial.**

#### a4. Dual acoustic analyzers

`src/device/acoustic-tone-analysis.ts` contains two full implementations of
the same metric pipeline: in-memory `analyzeAcousticTonePcm16` (:172–318 plus
shared helpers :952–1198) and the O(1)-memory streaming
`analyzeAcousticTonePcm16Artifact` (:319–900: `ArtifactToneWindowReader` :488,
`FirstToneAnalysisPass` :711, `PhaseContinuityPass` :844), with an equivalence
claim maintained by fixtures (host-pipeline report §6.12). The streaming
analyzer subsumes the in-memory one: feed a `Uint8Array` through a
memory-backed reader.

```ts
export function analyzeAcousticTonePcm16(pcm: Int16Array, opts: ToneAnalysisOptions) {
  // Same passes, memory-backed reader; one pipeline, two entry points.
  return runToneAnalysisPasses(new MemoryToneWindowReader(pcm), opts);
}
```

**Delta: −300 production, −150 test (equivalence fixtures become
golden-output tests of one pipeline) → net −450. Risk: low-medium** — the
acoustic oracle is acceptance-critical; keep the recorded-fixture outputs
byte-identical across the merge.

#### a5. CMake: ~38 copy-pasted test stanzas + two source lists per component

Root `CMakeLists.txt` (1,008 LOC) contains 38 `add_test`/39 `add_executable`
blocks of identical shape (~700–800 LOC), and re-enumerates every
`components/core/src/*.c` (root :14–32) and `components/capabilities/src/*.c`
(root :47–55) that `components/*/CMakeLists.txt` list again for the IDF build
— a new file must be added twice or silently miss one build. The
`add_iterate_kit_simulator` function (root :126) proves the pattern already
exists in-tree.

```cmake
function(add_iterate_kit_test name)
  cmake_parse_arguments(T "" "" "SOURCES;LIBS" ${ARGN})
  add_executable(${name} ${T_SOURCES})
  target_link_libraries(${name} PRIVATE ${T_LIBS})
  add_test(NAME ${name} COMMAND ${name})
endfunction()
# sources single-sourced:
include(components/core/sources.cmake)      # sets KIT_CORE_SOURCES
```

**Delta: −710 build LOC (1,008 → ≈300 root + 2 shared sources.cmake). Risk:
low** — pure build mechanics, verified by the suite still running 38 tests.

#### a6. itx_transport.c vs pcm_transport.c scaffolding

Both ESP shells re-implement: network-task lifecycle, `wake_network_task`,
`mark_socket_connected/disconnected`, `remember_platform_error`,
stack-headroom sampling, retry_gate wiring (`itx_transport.c` vs
`pcm_transport.c:76–164` maps). Plus the Wi-Fi backoff duplicated _within_
itx_transport (:757–768 and :775–784, while `retry_gate` is used for the
WebSocket in the same function — review R13). **Do not merge the two
transports** — their scheduling policies differ deliberately (control :5 vs
PCM :6 priority, different discard semantics; `esp_idf_websocket_policy.h:36–52`
pins the relationship). Extract only: (i) Wi-Fi station management ~250 LOC
into its own module using retry_gate (deletes the twice-duplicated inline
backoff, −30), (ii) small shared helpers (−120).

**Delta: net −150 (plus a −250 _move_ that shrinks the 1,624-LOC file).
Risk: medium** — the generation handshake must not be touched; it is covered
by `esp_idf_itx_transport_test.c` (982 LOC) on host.

### (b) Dead / superseded code

#### b1. `bounded_playback.hpp` — verified dead

`platforms/common/include/iterate/kit/platforms/bounded_playback.hpp` (389
LOC) is referenced by exactly one file: its own test
(`tests/bounded_playback_test.cpp:1`, 383 LOC) plus the root CMake stanza
(:313). No production include anywhere (grep over components/platforms/
devices/targets/simulator: only build-artifact hits). Superseded by
`realtime_playback.hpp`. **Delta: −772 (+2 CMake lines). Risk: none.**

#### b2. `websocket_text` egress/ingress adapters — production uses only outbox/inbox

`websocket_text.c` (538 LOC) ships four adapters. Production usage (grep over
all non-test code): `itx_transport.c` uses **inbox** (:551, :945, :1259) and
**outbox** (:948, :997, :1262) only. `egress`/`ingress` are referenced by
`tests/websocket_text_test.c` alone; the ingress control-frame validation
branch (`websocket_text.c:174–189`) is unreachable in production because the
transport `continue`s on `RECEIVE_CONTROL` before feeding the inbox
(`itx_transport.c:570–573`). They were kept for the abandoned
`esp_websocket_client` event shape (review §5 item 10; the header comment at
`websocket_text.h:63` describes that API). The no-backcompat rule applies.

**Delta: −230 production, −250 test (websocket_text_test.c 413 shrinks to the
outbox/inbox portion already duplicated in websocket_mailbox_test.c 248 —
merge those two files while there). Risk: low.** Re-adding an event-shaped
ingress later is a bounded, well-understood job if a future platform's WS API
delivers whole messages.

#### b3. Managed-client dead diagnostic fields

`esp_idf_itx_transport.h:144–158` admits the TLS/HTTP tuple fields "remain
zero" under the taskless adapter; :284 keeps "event-only managed-client
subfields … for schema compatibility". They propagate into
`metrics.h:147–158`, the expression builder, the snprintf formatter, and the
host zod parser. Pre-1.0, consumers in-monorepo: delete the rows. Under a2's
table this is literally deleting table rows. **Delta: −100 across six
surfaces. Risk: low** (host parser regenerated in the same change).

#### b4. capnweb: shipped-but-unused API surface

Verified zero production callers (components/platforms/devices/targets/
simulator) for:

- **`capnweb_responder_*` deferred-reply setters** — `responder.c` (149 LOC)
  - 8 declarations in capnweb.h:373–397. (The deferred `getDiagnostics` reply
    uses `capnweb_reply_set_borrowed_expression` + release callback, not the
    responder.) The `struct capnweb_responder` handle embedded in
    `capnweb_call` (capnweb.h:116–125) stays; only the set-later machinery goes.
- **`capnweb_session_call_path`** — firmware exclusively uses
  `capnweb_session_call_expressions` (5 call sites). `call.c:143–194` keeps
  `call_path` + the argument-less `capnweb_session_call` wrapper (~90 LOC).

All six wire message types (`push/pull/resolve/reject/release/abort`,
session.c:841–872) are exercised — none prunable. The `bytes` expression form
is used only by camera (`camera.c:52–59` → `capnweb_reply_set_bytes`); it goes
only if camera goes (see e-below). The TS interop suite +
`c-interop-known-failures.ts` ledger pins the compat profile — update it in
the same commit.

**Delta: −250 lib, −100 native tests. Risk: low-medium** (interop ledger and
session_test.c touch-ups; the C ABI is consumed only in-repo).

### (c) STRUCTURAL: events as the spine (requirement 8)

Today there are four separately-built "something happened, someone needs to
hear about it" machines:

| Subsystem                                             |  LOC | Shape                                                                                                                                                                                                                |
| ----------------------------------------------------- | ---: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/device_events` (198c+131h)                      |  329 | bounded SPSC-ish queue of 2-byte `{type,source}` + handler + observer, single-task (device_events.h:75–85)                                                                                                           |
| `capabilities/device_event_stream` (549c+104h)        |  653 | single-subscriber capnweb push: callback slot, `call_in_flight`, `callback_budget_reserved`, `release_pending`, coalescing queue, post-subscribe snapshot (device_event_stream.h:64–78)                              |
| `capabilities/metrics` scheduler half (~500 of 1,510) | ~500 | subscriber slots with THE SAME five booleans (`occupied/call_in_flight/callback_budget_reserved/release_pending` — metrics.h:312–320), interval pacing, fan-out, drop-dead-subscriber (metrics.c:922–988, 1208–1461) |
| `core/runtime_diagnostics` (505c+250h)                |  755 | snapshot struct → 3 fixed console lines → byte-budgeted nonblocking pump + retained report                                                                                                                           |

The delivery machinery of rows 2 and 3 is structurally identical and written
twice; rows 1 and 4 are bespoke plumbing that an event log with sinks
subsumes. Proposed v2 core:

```c
/* components/core/include/iterate/kit/event_log.h — sketch */
struct kit_event {
  uint64_t monotonic_ms;
  uint32_t sequence;        /* boot-local, per log */
  uint16_t path;            /* interned: "kit/button", "kit/pcm/uplink", … */
  uint16_t type;            /* "pttStarted", "generationDied", "wifiLost"… */
  uint8_t  payload[24];     /* fixed small union; big payloads NOT allowed */
};
struct kit_event_log {     /* single-writer bounded ring, drop-oldest,     */
  struct kit_event *slots; /* per-sink cursors; a slow sink loses OLD      */
  uint32_t capacity;       /* events and can see how many (seq gap) —      */
  uint32_t head;           /* exactly device_event_stream's coalescing     */
  /* per-sink read cursors + loss counters */
};
```

Sinks (each a cursor + consume function, all on the owning task):

1. **capnweb subscriber sink** — the generic callback-capability delivery
   machinery written ONCE (~350 LOC): slot bookkeeping, never-overlap,
   callback budget, release_pending, drop-dead-subscriber. Both
   `subscribeToEvents` and `subscribeToMetrics` become parameterizations.
2. **console sink** (~150) — replaces runtime_diagnostics' pump; same
   byte-budget discipline.
3. **SD sink** (new feature, requirement 5 — counted in §3).
4. **retained-latest views** (~100) — newest event per (path,type);
   `getDiagnostics` becomes "serialize the retained-latest incident + the
   latest metrics sample", keeping its one-in-flight latch and 1536-byte
   buffer.

**The metrics honesty problem.** Metrics are ~120-field periodic samples, not
events; three options:

- **Option A — metrics as full snapshot events.** Every interval, append one
  event whose payload is the sample. Rejected: the sample is ~600 B wide;
  either every 32-byte slot balloons 20× (RAM: 64-slot log goes 2 KiB →
  40 KiB) or the log grows variable-size slots (kills the fixed-slot
  simplicity that makes the SPSC proof easy). Do not do this.
- **Option B — sampler stays; incidents become events (recommended).** The
  periodic sampler and latest-state sample live OUTSIDE the log (exactly
  today's `sample()` driver, metrics.h:284–293). The log carries _state
  transitions_: generation deaths, restarts, threshold crossings, transport
  state changes, button edges. The capnweb sink delivers both: sample
  subscriptions read the latest sample on their interval; event subscriptions
  drain the log. One delivery machine, two data sources.
- **Option C — snapshot side-slot.** A "metricsSampled" event carries
  {sequence, pointer-generation} referencing a double-buffered sample slot;
  the SD sink dereferences it to write periodic samples to card. Useful ONLY
  for the SD sink (where periodic samples on card genuinely matter for
  "not listening" forensics); cheap (+60) if wanted.

This is also exactly the apps/os stream shape the brief asks for (path, type,
payload, seq, ts) — the on-device log becomes the local truncated head of the
device's stream, and the host `/pcm` worker cross-posts from the same
vocabulary.

\*\*Delta (Option B): delete 329 + 653 + ~500 + ~600 (runtime_diagnostics
minus what retained-latest keeps) ≈ −2,082; add core 350 + capnweb sink 350

- console sink 150 + retained-latest 100 = +950 → net ≈ −1,130 production.**
  Tests: `m5sticks3_events_test` 537 + `metrics_subscription_test` 1,169 +
  `runtime_diagnostics_test` 738 + `device_events_test` 191 = 2,635 consolidate
  to ≈1,900 (event-core tests + one sink-machinery suite + retained
  serialization regressions) → **−700 test. Risk: HIGH\*\* — this rewires the
  control plane's correctness core. Mitigations: the capnweb sink must preserve
  the five delivery invariants verbatim (never-overlap, budget admission,
  release_pending ownership, coalescing-with-visible-loss, post-subscribe
  snapshot — all currently pinned by metrics_subscription_test.c and
  m5sticks3_events_test.c, which port over); do it as its own milestone with
  both old and new passing the same behavioral suite.

### (d) websocket_text four adapters → two

Covered as b2 (−480 incl. tests). The residual file is ~300 LOC of
outbox/inbox that could further fold into `spsc_ring` companions, but that
coupling isn't worth it — the ring is used by PCM lanes too and must stay
payload-agnostic.

### (e) Simulator vs fakes overlap; speculative capability breadth

`tests/fakes/` (≈1,900 LOC with headers) fakes ESP-IDF so _real platform
adapters_ compile on host; `simulator/` (1,907) is a deterministic
control-plane model of _device profiles_. Different purposes — keep both.
Real overlaps:

- **Two resource-profile benchmarks**: `simulator/resource_profile.cpp` (584)
  and `vendor/capnweb/tools/resource_profile.c` (163) measure adjacent things
  with duplicated harness scaffolding → one tool, two profiles. **−150,
  risk low.**
- **Speculative hardware surface**: `targets/` contains only m5sticks3. The
  m5sticks3 device wires 5 modules (m5sticks3.c:158–165); `leds/servos/camera`
  capabilities (309c + 177h) exist for StackChan, which today is
  simulator-only (devices/stackchan 208, simulator/devices/stackchan.cpp 301).
  StackChan is on the hub roadmap (goal doc) — **keep leds/servos**. Camera
  (160 LOC + the capnweb `bytes` reply path it alone uses) has no near-term
  acceptance test → **defer camera: −160 now, re-add with a target. Risk:
  low** (it's a leaf).

### (f) The two composition monoliths

- **`targets/m5sticks3/main/main.cpp` (1,349)**: the ~470-LOC
  `sampleRuntimeMetrics` (:455–924) dies with a2. The static_assert blocks
  (:169–219) and the constant farm (:65–160) become the R6
  `iterate_kit_audio_profile`/device-profile struct — mostly a _move_ (+the
  knobs become data), −100 net. Boot + main loop (:1117–1349) is fine as-is.
  **Residual main.cpp ≈ 700. Net beyond a2: −100.**
- **`scripts/device-e2e.ts` (1,752; `runDeviceE2e` :164–1254)** plus
  `prove-production-m5sticks3-tone.ts` (559) and `-grok.ts` (786): the prove-_
  scripts already import the shared `src/device/_` helpers (verified imports:
acoustic analysis, capture, network-run, diagnostics parsers), so the
duplication is orchestration-phase-level, not helper-level: each re-builds
mount → subscribe → capture → analyze → evidence sequencing with its own
deadline handling. Extract a phase-runner (`src/device/run-phases.ts`:
mount, subscriptions, capture session, analysis, evidence emit) and express
all three CLIs as phase lists. Also replaces the stringly
`console.log key=json` evidence protocol with one typed emitter (the
  host-pipeline report's smell #8). **Delta: −600 across the three
  (medium confidence), device-e2e.ts lands ≈ 900. Risk: medium** — this is
  the physical-evidence path; refactor after a green physical run and re-run
  the tone proof.

### (g) capnweb surface used vs shipped

Covered as b4 (−350). Additional finding for completeness: the firmware calls
24 distinct `capnweb_*` functions; the header exports ~55. Beyond
responder/call_path, the unused remainder is thin wrappers whose deletion
buys little and costs interop-ledger churn — not worth it. All six message
types are load-bearing; the JSON tokenizer/value/expression layers are fully
exercised by mount + metrics + event stream.

---

## 3. ANTI-reductions — where v2 adds code

Honest list, with the deletions they partially fund:

| Addition                                                           |                     Est. LOC | Funded by / notes                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------ | ---------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audio_processor` seam + null processor (R2; req 3/4/9 groundwork) |         +350 prod, +250 test | Nothing deleted today; this is the price of StackChan AEC and viseme taps having a place to land. Portable C vtable: `frame_spec()/frame_spec_revision()/process(mic,ref,out)` + fail-closed silence rule (stolen shape: esphome-audio-stack `audio_core_processor.h:66–118`, xiaozhi `audio_engine.h`) |
| esp_sr AEC adapter (when StackChan lands — NOT initial v2)         |         +700 prod, +300 test | future line item, listed so the roadmap LOC story stays honest                                                                                                                                                                                                                                          |
| SD log sink (requirement 5)                                        |         +400 prod, +200 test | consumes the §2c event log; bounded writer, preallocated file rotation, write-behind on the low-prio task; plus Option C side-slot +60 if periodic samples wanted on card                                                                                                                               |
| Event-log core + sinks (§2c)                                       |                         +950 | already netted inside the −1,130                                                                                                                                                                                                                                                                        |
| Unified codec interface + esp_driver_i2s RX capture (R1; req 4)    |                    +500 prod | deletes `bounded_capture.hpp` 258 + M5Unified recorder pump path ≈ 200 → **net +50**; kills the capture priority orphan as a side effect                                                                                                                                                                |
| Runtime tuning profile struct (R6; req 4)                          |                         +200 | mostly moves existing constants; knobs reported through metrics                                                                                                                                                                                                                                         |
| Wire-constant generator (R10)                                      |                         +150 | one table → C header + TS module; converts the architecture test's "header contains literal" into cross-language equality                                                                                                                                                                               |
| Timestamp-echo fields for server-side AEC (R11; req 9)             |        +80 device, +150 host | protocol groundwork only                                                                                                                                                                                                                                                                                |
| **Anti-reduction total (initial v2, excl. esp_sr)**                | **≈ +1,280 prod, +650 test** |                                                                                                                                                                                                                                                                                                         |

---

## 4. Projected net LOC, v1 → v2

Production deltas (firmware): −220 (a1) −1,700 (a2 device) −150 (a6) −389
(b1) −230 (b2) −100 (b3) −250 (b4) −1,130 (c) −100 (f-main) −160 (camera)
−150 (e-profiles) = **−4,579**; additions +1,280 → **net −3,300**.
Host production: −40 (a3) −300 (a4) −560 (a2 host) −600 (f-e2e) = −1,500;
+150 (ts-echo) → **net −1,350**.

|                     |         v1 | v2 projected |                                                  Δ |
| ------------------- | ---------: | -----------: | -------------------------------------------------: |
| Firmware production |     31,228 | **≈ 27,900** |                                               −11% |
| Firmware tests      |     20,727 |     ≈ 19,600 | −5% (−1,783 consolidation, +650 new-feature tests) |
| Build system        |      1,640 |        ≈ 930 |                                               −43% |
| Host production     |     18,607 |     ≈ 17,250 |                                                −7% |
| Host tests          |     13,108 |     ≈ 12,950 |                                                −1% |
| **Total**           | **85,310** | **≈ 78,600** |                                            **−8%** |

The candid read: **v2 is meaningfully smaller only where schema and delivery
machinery are duplicated (those shrink 30–60%); total LOC drops a modest ~8%
while gaining SD logging, the processor seam, runtime knobs, the event spine,
and AEC groundwork.** If someone wants a headline like "−30%", the only
honest routes are cutting test coverage or cutting the audio path's proven
policy code — both are the parts requirement 6 says to keep. The complexity
reduction is real and larger than the LOC reduction: the number of
places-a-counter-must-be-spelled drops from ≈7 to 1, and the number of
bespoke delivery machines drops from 4 to 1.

---

## 5. Top-10 highest-leverage deletions

| #   | Deletion                                                                                                                                                  |                    Net LOC | Risk     | Prereq                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------: | -------- | -------------------------------------------------------------------- |
| 1   | Metrics/diagnostics schema → one X-macro table (kills expression builder metrics.c:83–920, snprintf :1001–1207, main.cpp:455–924 sampler, 3 host parsers) |                 **−2,260** | medium   | none — do first, everything else touches these files less afterwards |
| 2   | Event-spine collapse: device_events + device_event_stream + metrics scheduler + runtime_diagnostics → one log + sinks                                     | **−1,130** prod, −700 test | **high** | #1 (retained serialization)                                          |
| 3   | `bounded_playback.hpp` + its test                                                                                                                         |                       −772 | none     | none                                                                 |
| 4   | CMake: `add_iterate_kit_test()` + single source lists                                                                                                     |               −710 (build) | low      | none                                                                 |
| 5   | device-e2e / prove-production-\* phase-runner consolidation                                                                                               |                       −600 | medium   | green physical run to diff against                                   |
| 6   | websocket_text egress/ingress (incl. unreachable control-frame branch websocket_text.c:174–189) + test merge                                              |                       −480 | low      | none                                                                 |
| 7   | Dual acoustic analyzer merge (streaming subsumes in-memory)                                                                                               |                       −450 | low-med  | golden fixtures preserved                                            |
| 8   | capnweb responder.c + call_path + native-test trims                                                                                                       |                       −350 | low-med  | interop ledger update                                                |
| 9   | Atomics helpers ×8 → atomic.h named variants                                                                                                              |                       −220 | low-med  | none                                                                 |
| 10  | Dead managed-client fields + camera deferral + resource-profile merge                                                                                     |                       −410 | low      | #1 makes the field deletion a table-row edit                         |

Sum ≈ **−8,100** (the remainder of §4's delta is smaller items and moves).

---

## 6. Roads NOT taken (and why)

- **Merging itx_transport and pcm_transport into one generic network shell.**
  ~500 LOC savings on paper; rejected because the two lanes' scheduling and
  discard policies are deliberately different (policy.h:36–52 pins the
  priority relationship; conductor-driven purge vs generation-replace
  semantics differ), and a genericized shell would re-introduce the
  configuration-over-code framework smell the review's "refuse ADF elements"
  section warns about. Extract helpers only (a6).
- **Metrics as full snapshot events (Option A in §2c).** Blows the fixed-slot
  event log 20× or forces variable-size slots; the sampler is the right tool
  for periodic wide samples. Keep the sampler, make _incidents_ events.
- **Rewriting `realtime_playback.hpp` (1,863) / the audio path for size.**
  It is the physically-proven crown jewel with descriptor-identity tests
  (realtime_playback_test.cpp 1,989); every line was bought with an incident
  (brownout, silence-recovery, generation poison). Untouched except via the
  codec-interface seam.
- **Deleting `host-paced` mode + pacer outright (−150).** R9 flips the
  default to device-clocked; keeping host-paced as an explicitly-requested
  comparison path preserves the tunnel-cadence diagnosis capability
  (public-pcm-tunnel-cadence.live.test.ts depends on the model). Revisit
  after StackChan.
- **Pruning the four-adapter websocket_text to zero by moving framing into
  spsc_ring.** Couples the byte-ring to capnweb message semantics; the ring
  is shared with PCM lanes and must stay payload-agnostic.
- **Deleting the firmware-architecture.test.ts text-grep suite (694) once
  core/audio components split.** The split converts several checks to
  link-time truths, but ~two-thirds of the suite pins non-structural
  invariants (register writes, priority literals, IRAM discipline) that have
  no other cheap tripwire. Trim, don't delete (−150 at most, counted nowhere
  above).
- **Cutting the endurance family (~4,400 prod+test) into the phase-runner.**
  Tempting, but it encodes acceptance _policy_ (thresholds, conserved
  incidents), not plumbing; merge only its evidence-emission with the typed
  emitter from f. Revisit in the condensation round once the event spine's
  host-side story (structured log ingestion replacing device-runtime-log.ts
  console parsing) is decided — that could unlock another ≈ −500.

---

## 7. Sequencing note for the plan round

Cheap-and-safe first (3, 4, 6, 9, 10, a3), then #1 (schema table) as the
enabling move, then #2 (event spine) as its own reviewed milestone gated on
the ported behavioral suites, with #5/#7 running host-side in parallel. The
anti-reduction items (processor seam, codec interface, SD sink, tuning
profile) each land WITH the deletion that funds them where one exists, so the
tree never carries both copies for long.
