# Kit v2 — synthesis of the wide-exploration round, and the questions for Jonas

Status: synthesis artifact closing the exploration round, 2026-07-31. Inputs:
the three architecture candidates (`arch-a-event-spine.md`,
`arch-b-pipeline-purist.md`, `arch-c-minimal-delta.md`), the three adversarial
judges (`judge-requirements.md`, `judge-realtime.md`, `judge-simplicity.md`),
the seven recon files in this folder, `../inputs/brief.md` (12 requirements +
late audio-less addendum), and
`../../fable-firmware-architecture-review-2026-07-31.md` (R1–R13). Everything
here is a PROPOSAL for Jonas, not a plan — §2 marks confidence per piece, §3
lists what evidence cannot settle, §4 is the interview sheet.

Facts re-verified on this host today (read-only, see §5 for the full ledger):
the codex v1 agent's **untracked working files include
`components/capabilities/{device_event_stream.h,device_event_stream.c,callback_budget.h,callback_budget.c}`**
(git status, 2026-07-31 — codex is writing the event-delivery machine right
now); `device.h:4` includes `audio.h`; the five delivery booleans are
duplicated verbatim (`device_event_stream.h:73-76` = `metrics.h:315-318`); the
PCM retry gate resets on mere `socket_connected`
(`platforms/iterate_esp_idf/pcm_transport.c:616-618`); IRAM is 16,383/16,384
bytes used (`docs/physical-device-voice-goal.md:352`); candidate C's ten
`wc -l` claims spot-checked exact (`metrics.c` 1,510, `main.cpp` 1,349,
`realtime_playback.hpp` 1,863, `device_event_stream.c` 549).

---

## 1. Scoreboard

| Lens (judge)                       | A — event-spine | B — pipeline-purist | C — minimal-delta |
| ---------------------------------- | --------------: | ------------------: | ----------------: |
| Requirements & product fit         |         **8.5** |                 5.5 |               7.5 |
| Realtime/embedded soundness        |             5.5 |             **8.0** |               7.0 |
| Simplicity, testability, migration |             6.0 |                 4.5 |           **7.5** |
| **Unweighted sum**                 |            20.0 |                18.0 |          **22.0** |

**Each candidate won exactly one lens, and each judge's most-hated candidate
was another judge's winner.** That is the round's signature result, and it is
not noise — it faithfully reflects that the three candidates are optimizations
of three different readings of the brief: A maximizes requirement 8/5 as
worded (the requirements judge verified its wire shapes verbatim against
`packages/iterate/src/processors/schemas.ts:11-92` and scored B at literal
zero on apps/os mirroring); B maximizes the goal doc's audio half (the
realtime judge found it "the only candidate that _is_ the prior-art lesson
set" but the addendum explicitly names its organizing bet the risk); C
maximizes survivability against the live git status (the simplicity judge's
decisive fact: codex is writing `device_event_stream` as untracked files
_today_, so A's plan to delete it and B's plan to reroute it are both racing
uncommitted work, while C generalizes it in place). Where the judges
**agree** is far larger than the scores suggest: all three hybrid
recommendations independently converge on the same composite — C's migration
frame as skeleton, B's audio seam positions clocked by C's nonblocking codec
(which B itself names as its fallback, arch-b §12.1), and A's event _format_,
schema generator, and worker cross-post at some ambition level. Where they
genuinely **disagree** is only two things: how much of A's event machinery
lands in v2.0 versus v2.1 (§3.1), and whether the pipeline mode-machine is
built ahead of StackChan or with it (§3.2).

---

## 2. THE LEADING SYNTHESIS

One sentence: **C's delivery discipline carrying B's audio seams on C's
clocking, with A's event representation everywhere data is at rest or on a
wire — and A's machinery collapse deliberately deferred to a pre-named v2.1
milestone.**

### 2.1 Module tree with provenance

Provenance tags: [A]/[B]/[C] = candidate; [rec:*] = recon file; [R#] = review
recommendation; [J-*] = judge override.

```
vendor/capnweb                     unchanged minus dead responder.c/call_path (−350, audit b4) [C]
components/core                    control plane only, sans-I/O [R3, all three]
  itx_mount / itx_connection / peer / websocket_tx/rx / frame_writer
  spsc_ring / retry_gate / configuration (+deviceId TLV, +clamped knob tags) [C §3.3]
  atomic.h + named acquire/release variants (8 hand copies die) [R8, audit a1]
  device_events → WIDENED in place: A's 64-B slot format, sequence at publish,
    interned type table                                     [A §1.1 slot + C §3.3 vehicle, J-simplicity graft 1]
  device_event_types.def + metrics_schema.def → ONE generator (C enum + URI
    strings + payload packers + TS zod + SD dictionary + wire fixtures) [A §3.1, R7/R10, J-simplicity graft 2]
  event_relay.{h,c}                A's tributary as the single audited
    ISR/cross-core marshalling module (renamed; no coined nouns) [A §3.3, J-realtime graft, J-simplicity §2.2.4]
  event_sd_log.{h,c}               portable SD sink core [rec:sd-event-logging §6, C §3.4]
  device_profile.h                 two-tier profile [rec:hardware-plugability §3, R6]
  runtime_diagnostics              KEPT for v2.0 (wart ledger row 2) [C §9.3]
components/audio                   linkable only on audio boards [R3; addendum discharge]
  pcm_websocket / pcm_lane / uplink conductor+sender / peer_delivery_guard
                                   moved VERBATIM (strongest code in tree, review §5) [all three]
  audio_codec.h                    B's properties vector (duplex, reference_channels,
    input_echo_cancelled, gain ceiling) on C's NONBLOCKING next_event contract
                                   [B §2.1 properties + C §3.2 clocking; decision D1]
  audio_processor.h                frame_spec/frame_spec_revision/process(mic,ref,out),
    fail-closed silence, B's chunk re-framing spec [B §2.2 + C §3.1; R2; decision D3]
  processors/null.c, fake (tests)  now; timestamp_echo.c with the pcm.v2 wave [B §5.1]
  audio controller                 v1 logic adapted; peer.h include broken [R3];
    mode machine grows at StackChan under B's "policy row, zero new states" test [J-simplicity graft 6]
components/capabilities            unchanged mechanism [C]
  device_event_stream              GENERALIZED IN PLACE on top of codex's landing
    version: any event type, same five-invariant machine [C §6.2; decision D6]
  metrics                          sampler survives; schema regenerated from .def;
    file split sample/subscriptions [C; audit a2 −2,260]
  push_to_talk / leds / servos / screen / CAMERA KEPT [C; goal doc :108-110,:208-210]
  callback_budget, rpc_internal    verbatim
components/analysis                DEFERRED until StackChan hardware [goal doc :635;
                                   then stackchan 40-B IR verbatim, rec:stackchan-autopsy §4]
devices/<board>/                   composition roots + profile.{h,c} incl. per-board
                                   event-class rows [A §5 row 4 + rec:hardware §3]
platforms/iterate_esp_idf          itx_transport minus Wi-Fi; + wifi_station.c on
                                   retry_gate [R13 — also the ESPHome-adapter prerequisite, B §7];
                                   pcm_transport: gate-reset-on-confirmed-delivery +
                                   socket wakeup [R5/req 10]; m5sticks3_codec.c (PDM RX,
                                   fence inside, on audio owner) [R1]; sd_block_store.c
                                   (lands with Waveshare bring-up) [rec:sd §1.4]
platforms/common                   RealtimePlayback + DirectI2sStereoOutput UNTOUCHED
                                   until Waveshare provides the codec vtable's second
                                   customer [C §3.2; J-realtime "playback rule"; decision D2]
targets/<board>/main               main.cpp ≈700 after R6/R7 [C §6.2]
host: worker DeviceLane split + upstream-session.ts + stream-outbox.ts +
  KitDeviceProcessor (userspace-hosted, guestbook shape, zero apps/os changes)
                                   [rec:proxy §1, rec:os-streams §5/§13; all three]
host: rig — device-e2e.ts FROZEN; scenarios as siblings; phase-runner extracted
  at the 4th scenario [C §9.3; J-simplicity]; kit-checkride.ts [rec:testing §4]
```

### 2.2 The load-bearing interface decisions (with evidence and confidence)

**D1 — The codec contract is nonblocking `next_event`, not a blocking beat.
Confidence: HIGH.** All three judges land here. B's blocking `next_beat` is
its signature move and its own risk register names C's shape as the fallback
(arch-b §9.2, §12.1). The realtime judge found the blocking design's deepest
hole — no beats when route=IDLE on a half-duplex board, so a PTT press waits
out the timeout (judge-realtime §2.2.1) — while C's notify-driven owner has no
such hole and keeps L1 as pure function calls. The review names sans-I/O
host-testability our biggest edge over all prior art (review §3), and a
nonblocking contract is the only shape hostable inside ESPHome's `loop()`
scheduler (rec:hardware-plugability §5). Cost, honestly: each platform impl
internally re-creates a blocking loop (~100 LOC extra per board,
rec:hardware §7.1).

**D2 — Half-codec now, playback folds at Waveshare, byte-identical gate.
Confidence: HIGH.** Capture + route move (R1 forces it); the 3.6 k-LOC
descriptor-identity playback stack (`realtime_playback.hpp` 1,863 +
`direct_i2s_stereo_output.hpp` 710 + 3,093 LOC of tests) keeps its exact call
topology until a second codec customer exists (arch-c §3.2). The realtime
judge scored this "zero risk to proven playback" vs B's "medium (harness
rewired, gated)" (judge-realtime §4 table). If the fold happens earlier, B's
M2 acceptance (tone + PRBS thresholds unchanged, byte-identical) is the gate.
Admitted cost: a "third asymmetry era" until Waveshare — wart ledger row 7,
which uniquely has a date rather than a trigger (arch-c §9.3).

**D3 — Processor seam ships now with B's realtime rulebook baked into the
contract, implementations later. Confidence: HIGH on the seam, MEDIUM on the
re-framing detail.** `frame_spec()/frame_spec_revision()/process(mic,ref,out)`

- fail-closed silence (`esp_afe.cpp:1612-1615` rule, verbatim) with null +
  fake impls host-tested in v2.0. Crucially, the contract must adopt B's
  chunk-size re-framing position — `samples_per_frame` may be 512 (32 ms,
  `aec_get_chunksize`, stackchan `audio_pipeline.c:826`) while the wire stays
  320/20 ms, and the pipeline owns the re-framing — because the realtime judge
  showed C's own text contradicts esp-sr's actual API (fixed `320` in C §3.1 vs
  the engine-dictated chunk; judge-realtime §3.2.1). This is a paper decision
  today, zero implementation, and it is what stops the seam dying on first
  contact with StackChan. Also imported as contract text: complete-frames-only
  reference, ref-ring reset on session edges, 0–10 ms mic-lags-ref predelay,
  hardware TDM reference preferred over the software tap (stackchan discovery,
  `audio_pipeline.c:446-482`, supersedes R11's assumption).

**D4 — One 64-byte interned event slot; one `.def` X-macro generator serving
events AND metrics AND the SD dictionary AND TS. Confidence: HIGH.** A's slot
(`type_id` u16 intern + 40-B packed payload + sequence + boot_epoch +
origin timestamp + handler_status, `_Static_assert == 64`) replaces C's 8-B
payload, which the simplicity judge showed has zero headroom (incident payload
already doesn't fit; judge-simplicity graft 1). The single generator is the
biggest complexity win in every candidate (−2,260 combined, audit a2) and the
only defensible answer to the schema being spelled in ~7 places today
(`metrics.c:83-920` builder, `:1001-1207` formatter, `main.cpp:455-924`
sampler, three host parsers). Boot-moment-zero vocabulary
(`booted`/`config-loaded`/`wifi-*` from slot 1, A §1.6) comes with it — it is
a few table rows and it is what makes the SD card answer requirement 5's "what
happened while we weren't listening" from the first instruction.

**D5 — Wire and stream shapes are apps/os-verbatim, decided now. Confidence:
HIGH.** Serializer emits `StreamEventInput` field-for-field
(`{type, payload?, metadata?, idempotencyKey?, ephemeral?}` — verified against
`packages/iterate/src/processors/schemas.ts:11-92` by judge-requirements
§5.2); device coordinates ride `metadata.device` (never `source`, which is
platform-reserved provenance, schemas.ts:17-22); no `path` in the slot
(`offset/createdAt/path` are assigned at commit, schemas.ts:87-92);
idempotency key `kit-device:<deviceId>:<bootEpoch>:<sequence>` makes
at-least-once anywhere compose to exactly-once on-stream; stream path
`/kit/devices/<id>`; worker replaces its two `wouldPostToStream:true` seams
(`worker.ts:245-253`, `:269`) with real appends through a bounded drop-oldest
outbox; `KitDeviceProcessor` hosted in userspace (guestbook shape,
`createProcessorHost` — zero apps/os PRs, promotion later is a file move).
Prerequisite that no candidate disputes: **deviceId** (efuse-MAC TLV tag) +
NVS bootEpoch — two Sticks on one project collide on the fixed mount path
today (`itx_mount.c:123-157`).

**D6 — Delivery topology: generalize codex's machine in place; ONE machine,
TWO data sources; the full collapse is a pre-named v2.1 milestone.
Confidence: MEDIUM — this is the round's most contested call (§3.1).** The
sampler and diagnostics snapshot stay outside the event core (audit §2c
Option B); `device_event_stream`'s five-invariant machine — which codex is
literally writing as untracked files right now — is generalized to carry any
event type rather than deleted (C §6.2). A's metrics side-slot (seqlock,
"spine carries a reference, never the sample") is declined for v2.0: two of
three judges overrode it, and A itself calls it "a compromise wearing a
design's clothes" (arch-a §10.6). The collapse to one delivery machine is
scheduled as v2.1's single milestone, triggered by wart-ledger condition #1
(the _third_ time a delivery bug/feature must be fixed in more than one
machine) or by codex's event work landing stable — whichever first — verified
by A's M2 parallel-ledger diff device (run spine and legacy side-by-side, rig
diffs the two ledgers before anything is deleted; arch-a §9 M2). Standing
merge conditions on ANY event infrastructure, from the realtime judge and
adopted here as law: (i) a specified torn-read/atomic-cursor protocol for
every cross-task ring reader — my concrete proposal: the ring is
single-writer AND single-drainer (the owner task drains all cursors into
per-sink SPSC relays; the SD pump and capnweb sink never touch ring slots
cross-task), which makes the hazard structurally impossible the way C's
topology already is; (ii) IRAM-delta-zero (one byte free today); (iii) an
internal-RAM ledger entry composing each addition against the 77.8 KiB free
internal heap vs the 31–60 KB the AEC future needs (goal doc :347, review
§4.5).

**D7 — `iterate.kit.pcm.v2`: the 16-byte little-endian header (xiaozhi
BinaryProtocol2 layout) with timestamp echo AND the type-2 in-band commit,
subprotocol-negotiated, shipped early. Confidence: HIGH on shape (all three
candidates specified the identical header independently), MEDIUM on timing.**
`{u16 version, u16 type, u32 reserved, u32 timestamp_ms, u32 payload_bytes}`
(from `78/xiaozhi-esp32/main/protocols/protocol.h:17-24`; LE deliberately —
S16LE payload, LE both ends, htons buys interop with nobody). ~60 LOC
firmware + ~40 LOC worker, zero IRAM, v1 peers unaffected via
`Sec-WebSocket-Protocol`. The realtime judge wants it early because the
type-2 zero-length uplink commit kills the cross-socket commit race (release
edge racing final frames up a different socket — `device-pcm-proxy.ts:402-413`
compensates today) and makes a PTT turn survive control-lane loss (the
degraded matrix's worst row, rec:proxy §2.2). Timestamp echo makes
requirement 9 a measurable transport property (rig scenario: echoed-stamp
alignment vs PRBS31 correlation ground truth ±0.5 ms) before any server DSP
exists. Both timestamp domains already exist on-device
(`realtime_playback.hpp:83-99`).

**D8 — Session economics: DeviceLane/upstream split with policy V-B.
Confidence: HIGH on shape, MEDIUM on parameters.** Worker device lane lives
with the device socket; upstream NO_UPSTREAM→DIALING→ACTIVE→DRAINING→COOLDOWN
with DO `storage.setAlarm` (eviction-proof); 2 s/64 KB preroll ring (xiaozhi
`wake_word_audio_cache.cc:26-27` shape) masks the ~300–850 ms dial under press
duration; 90 s idle window ≈ $4.16/day vs $115/day always-on at $0.08/min;
rotation at ~25 min under the 30-min xAI cap; transcript replay via
`conversation.item.create` turns hangup into a pause, not amnesia. C's
operational details adopted (requirements judge called them best-in-round):
pre-minted 300 s secret pool, **await `session.updated`** (today
fire-and-forget, `providers.ts:145-166`), provider-death → clean device EOS
instead of the 1011 cascade — which deletes the `#suppressDownlink` defect
class structurally. Parameters are provisional until the billing-unit
measurement (§5, ledger row 1).

### 2.3 The rest of the composite (lower altitude, broadly uncontested)

- **SD sink**: rec:sd-event-logging design wholesale — `block_store` vtable,
  4 KiB CRC32C blocks inside preallocated contiguous 4 MiB FAT segments
  (`esp_vfs_fat_create_contiguous_file`, crash recovery scans by magic+CRC not
  file size), UNMOUNTED→…→DEGRADED pump on `retry_gate`, 64 KiB PSRAM ring
  (>30 s stall absorption at ≤2 KB/s steady), prio-2 core-0 task, producers
  only ever touch an SPSC. **On-card record = the 64-B slot verbatim** +
  DICTIONARY/TIME_ANCHOR/GAP/SNAPSHOT records (A's simplification, endorsed by
  judge-requirements as the only design answering req 5 as worded). Portable
  core + fake block store + simulator now; hardware adapter with the Waveshare
  bring-up — the only zero-conflict SD board (SDMMC 1-bit CLK=2/CMD=1/D0=3;
  StackChan's SPI-mode card shares the LCD bus and waits for the
  esp_lcd-vs-M5GFX decision). `readSdEvents` is pull-only; never auto-replay
  (HOL-blocks live PTT; idempotency keys make lazy backfill converge).
- **Resilience ladder** (req 10): the four surgical fixes all candidates share
  — PCM gate reset on first _confirmed delivery_ not socket connect
  (verified defect, `pcm_transport.c:616-618`); fleet jitter in the platform
  wrapper (`retry_gate.c:6-12` says it belongs there); retryable
  `pcm_transport_start` (today once-ever, `main.cpp:1262-1284`); Wi-Fi backoff
  unified on retry_gate (R13). Plus reboot as the explicit last rung (no
  control READY 15 min OR fatal latch → SD fsync → reboot). Plus A's graft the
  requirements judge insisted on: **every rung transition is an event**, so
  the degraded matrix is observable by construction and `wifi-lost
{reason, rssi}` becomes a durable fact — the station-outage incident showed
  the host currently _discards_ the Wi-Fi reason the churn replies carry.
- **Testing**: L1 — golden event-log diffs (drive scenario, serialize, diff
  canonical JSONL), null/fake processor contract tests, pthread-fakes promoted
  to a merge RULE with the two documented holes closed
  (`websocket_connection.c` errno classifier/URL parser, `peer.c` unwrap),
  fuzz on `websocket_rx`/TLV, golden-replay corpus of real rig captures;
  budget ≤5 s native / ≤30 s vitest warm. L2 — `device-e2e.ts` FROZEN, four
  additive sibling scenarios: **uplink echo loop as the R1 regression gate in
  B's sharp formulation (pre-fix firmware must FAIL it under
  `--control-churn-hz` load; post-fix must not)**, AEC three-phase proof
  (ERLE ≥10 dB / near-end damage <3 dB, goal doc :317-321), barge-in stopwatch
  (≤250 ms initial budget), timestamp-echo alignment; plus one no-acoustics
  scenario for the audio-less class. L3 — `kit-checkride.ts`, <5 min, ~8
  frozen steps asserted against the event stream, including the AP-kill drill
  and the SD-ledger-vs-host-evidence diff. One frozen acceptance/threshold
  module per device (today the six acoustic numbers live in ≥3 files).
- **Audio-less devices (the addendum)**: discharged structurally by R3 +
  dropping `device.h`'s `audio.h` include + `features.has_audio`; an
  e-ink/buttons board links `core + capabilities + platform control half` with
  zero audio objects; negative link test in CI; class-4 task model is two
  tasks plus an optional SD pump. All three candidates converged here —
  no dispute.
- **Kept per settled goal-doc decisions** (C was the only fully compliant
  candidate): camera capability stays (photo is a first-class capability and
  Cap'n Web compatibility test, goal doc :108-110/:208-210 — A and B both
  deleted it); avatar/analysis deferred (goal doc :635) with the stackchan
  40-B `face_render_key_t` + stage cues adopted verbatim when StackChan lands;
  wire v1 pristine (v2 negotiated alongside).
- **The gap no candidate designed**: the ESPHome adapter the goal doc settles
  ("Any ESPHome device should ultimately share an ESPHome adapter") — all
  three treat HA Voice PE as native ESP-IDF. The condensed plan must carry at
  least the sketch from rec:hardware-plugability §5: adapter ticks from
  ESPHome's `loop()` (nonblocking portable core — D1 makes this legal), R13
  Wi-Fi extraction and R3 split are the two structural prerequisites (both
  independently justified), configuration stays caller-supplied, control-only
  link set is the first scope ("purpose-built Iterate firmware should own
  voice", `tasks/esphome-iterate-device-adapter.md:174-178`). Design for it,
  don't build it — but say so in the plan.
- **LOC honesty for the condensed plan**: the audited ceiling is ≈ −8 %
  total without cutting proven audio policy or tests (audit §4); this
  composite lands roughly −3…−5 % in v2.0 (C's base + A's generator + the
  seams) with the collapse's additional −1,130 banked for v2.1. The honest
  headline is the complexity number: counter-spelling sites ≈7→1, event-type
  spelling ∞→1, delivery machines 4→2 in v2.0 → 1 in v2.1.

### 2.4 Wave sketch (C's frame, composite content)

| Wave                  | Content                                                                                                                                                                                              | Codex collision                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 0 (today)             | verified-dead deletions (bounded_playback −772, websocket_text halves −480, capnweb prune −350), atomics R8, CMake helper −710, R9 host proxy defect fixes, device-clocked default                   | ~zero (2-line root-CMake coordination)                  |
| 1                     | R3 split + `device.h` include drop + negative link test; R13 wifi_station; R4 chores (IRAM audit, PSRAM enable+smoke, placement audits); `.def` generator scaffold + deviceId/bootEpoch provisioning | mechanical moves; one quiet window                      |
| 2                     | m5sticks3_codec.c (R1 capture move + fence inside + esp_driver_i2s PDM RX); R5 socket wakeups; ladder fixes; **uplink echo-loop scenario as its own gate**                                           | audio files — after codex checkpoint                    |
| 3                     | R7 metrics regeneration + file split; R6 profiles; R10 wire constants; main.cpp sampler death                                                                                                        | **gated on the named codex metrics checkpoint (§4 Q1)** |
| 4                     | event widening (A slot format) + generalized event stream + goldens; SD portable core + fake + simulator; worker DeviceLane + outbox + KitDeviceProcessor; pcm.v2 header + ts-echo; checkride        | low firmware / medium worker                            |
| 5 (boards; post-v2.0) | Waveshare (SD hardware + playback fold + codec economy test: ~200–300 LOC or the seam failed), StackChan (AEC per D3, hardware TDM ref, analysis component), HA VPE                                  | —                                                       |
| v2.1 (pre-named)      | delivery-machine collapse at wart trigger #1, verified by the parallel-ledger diff; optional wire break to StreamEventInput-shaped subscription batches                                              | —                                                       |

Every wave ends with the tone proof green (invariant, not milestone); the
wart ledger (arch-c §9.3) is carried into the final plan as a standing review
item.

---

## 3. DISPUTED TERRITORY — where evidence cannot settle it

1. **Event-model ambition (the round's central fight).** The requirements
   judge scored A 8.5 because it is "the only design that discharges reqs 8
   and 5 as worded"; the realtime judge scored the same design 5.5 because it
   adds the most new lock-free machinery with the least concurrency
   specification and concentrates event liveness on the most starvable task;
   the simplicity judge showed A's additions are ~2× underestimated
   (~1,800–2,200 LOC realistic vs 1,250 claimed) and its two riskiest
   cutovers race codex's uncommitted files. All three facts are true
   simultaneously. What decides it is not evidence but two things only Jonas
   owns: how literally to read requirement 8's "ideally … from the earliest
   moments", and risk appetite while v1 is mid-flight. The synthesis's D6
   (format now, machinery later) is a bet that the format is 80 % of the
   value at 20 % of the risk — but if Jonas reads req 8 maximally, A's
   one-machine end state belongs in v2.0 and the plan absorbs the HIGH-risk
   cutover with A's M2 parallel-ledger mitigation.
2. **When the pipeline/mode machine exists.** B builds one-pipeline/
   three-modes now with only MANUAL_STOP shipping on hardware (the simplicity
   judge's "textbook speculative generality — four seams ahead of their
   second customer"); C defers mode machinery to StackChan (the realtime
   judge's counter: C's AEC paragraph "would not survive a design review
   against esp-sr's actual API", i.e. deferral banks risk exactly where
   hardware risk peaks). D3's compromise — contract designed now on paper,
   machinery at StackChan — is a genuine middle, but whether the paper
   contract is enough discipline is a judgment call, not a fact.
3. **The wire break.** Retiring the flat `DeviceEvent` shape
   (`device-events.ts:1-9`) for StreamEventInput-shaped batches is a clean
   pre-1.0 break, but it is the only fleet-lockstep firmware+worker deploy
   any candidate requires, and it lands while codex's v1 worker is the
   production consumer. Now (A M5), with the v2.1 collapse (synthesis
   default), or never-unless-forced — timing is purely Jonas's appetite.
4. **SD on-card format.** Binary slot-verbatim CRC blocks (crash-exact,
   3–5× denser, decodable only via `sd-ingest`) vs JSONL (a human with a
   laptop reads it — requirement 5's "in case we are not listening" spirit).
   The engineering evidence favors binary on every measurable axis
   (rec:sd §5.1); the requirement's _spirit_ is legibility. Value-laden;
   flagged by A itself (arch-a §12 Q4).
5. **Stick full-duplex ambition.** Server-side AEC beyond timestamp echo
   (speak-state gating → WASM speex-MDF at ~$0.0014/session-hour) is a
   product decision about whether barge-in-during-speech on the Stick
   matters; the exploration priced the ladder but cannot rank it.
6. **HA VPE's track.** The goal doc settles "ESPHome devices should
   ultimately share an ESPHome adapter"; the adapter task doc settles
   "selected hardware (incl. HA VPE) gets purpose-built Iterate firmware"
   (`tasks/esphome-iterate-device-adapter.md`). Both are "settled" documents
   pointing opposite directions for the same board. Needs an explicit call.
7. **How hard requirement 1 binds.** "Reduces the amount of code" scored
   literally kills C (−1.9 %) and crowns A (−8 %); scored as complexity
   concentration it reverses. The judges could not settle this because it is
   a definition, not a finding.

---

## 4. OPEN QUESTIONS FOR JONAS

Grouped; each with why it matters / provisional recommendation / what changes
if you answer differently. Designed to be answerable without reading the
exploration files.

### A. Scope & sequencing vs the in-flight v1

**Q1. Name the codex checkpoint that gates the schema wave.** The metrics
X-macro (R7) is the single biggest complexity win in every candidate (−2,260)
and every candidate leaves it dateless ("after codex stabilizes") — while
codex is editing `metrics.{c,h}` and `main.cpp` today. _Provisional:_ wave 3
gates on codex's current metrics/events work merging to a named commit; the
final plan writes that commit hash in. _If you say "codex finishes within a
week":_ the delivery-machine collapse (Q5) also becomes schedulable inside
v2.0 — the simplicity judge's collision penalty on A drops a full grade.

**Q2. Is v2 executed by codex after v1 lands, by a parallel agent
new-files-first, or by re-briefing codex mid-flight?** This decides whether
wave design optimizes for zero-collision (parallel) or for sequence
(handoff). _Provisional:_ parallel new-files-first for waves 0–1 now, rewires
after the checkpoint. _If handoff:_ waves 2–3 can be aggressive and several
"generalize in place" choices could become "replace" cheaply.

**Q3. Does requirement 1 bind literally (total LOC must drop meaningfully)
or as complexity concentration?** The audited honest ceiling is −8 % without
cutting proven audio/test code; the synthesis lands −3…−5 % in v2.0.
_Provisional:_ complexity reading (spelling sites 7→1, machines 4→2→1). _If
literal:_ pull the v2.1 collapse into v2.0 (+risk), delete host-paced mode,
camera, and the analyzer duplication immediately.

**Q4. Do you accept ONE fleet-lockstep wire break (control-lane event batch
shape → StreamEventInput-verbatim), and when?** It is allowed pre-1.0 and
in-monorepo, but it forces a coordinated firmware+worker deploy exactly once.
_Provisional:_ bundle it with the v2.1 collapse milestone, not v2.0. _If
"now":_ wave 4 grows the break plus the lockstep ceremony; the rig's
event-witness upgrade arrives earlier.

### B. Event-model ambition

**Q5. Format-now/machinery-later (synthesis default) or the full one-machine
spine in v2.0?** Concretely: do we keep four bounded delivery machines
(generalized event stream, metrics scheduler, diagnostics pump, SD pump)
until the wart trigger fires, or collapse to one `event_subscription` machine
now? _Provisional:_ defer; pre-name the v2.1 milestone; carry the trigger
("third cross-machine delivery fix") in the plan. _If collapse-now:_ adopt
A's M2 parallel-ledger diff as the mandatory gate and accept racing codex's
uncommitted `device_event_stream` files.

**Q6. Do RPC commands become events?** A's operational line: anything two
sources can race on (PTT, gain change, route/mute toggles) goes through the
event core so the total order arbitrates; imperative side effects
(screen.renderPng, servos.move) stay direct calls with optional outcome
facts; reads never. _Provisional:_ adopt A's line. _If "only PTT, as today":_
future racy knobs each reinvent ordering; if "everything":\* every capability
module pays event amplification.

**Q7. Is resume/replay (`subscribeToEvents({afterSequence})`, ≤64-slot RAM
replay) required in v2.0, or is gap-fact + snapshot enough?** Short
control-plane outages currently produce a durable gap where replay would
restore up to 64 events. _Provisional:_ put the resume argument in the wire
contract now (cheap, mirrors `openConnection({replayAfterOffset})`),
implement when the widened ring lands. _If "must have day one":_ the ring
work moves into wave 4's critical path.

**Q8. Confirm three cheap-but-sticky representation choices:** 40-byte
payloads (not 8); no `path` field in the on-device slot (one device = one
stream; platform assigns path at commit); device coordinates in
`metadata.device` (never `payload`, never `source`). _Provisional:_ yes to
all three — each was verified against `schemas.ts` and each is annoying to
migrate later. _If you want per-slot paths_ (maximalist req-8 reading): +2 B
interned path column now, sub-streams (`/kit/devices/<id>/voice`) become
expressible.

### C. SD & storage

**Q9. On-card format: binary slot-verbatim CRC blocks + `sd-ingest` CLI, or
JSONL a laptop can read?** Binary wins crash-exactness (torn tail =
CRC-detected, never garbage), 3–5× density, and zero publisher-side
formatting; JSONL wins the pull-the-card-into-a-laptop story req 5's spirit
implies. Sub-question: does the 1 Hz metrics snapshot go to card as SNAPSHOT
records (bounds invisible-gap analysis between adjacent snapshots)?
_Provisional:_ binary + ingest, snapshots yes. _If JSONL:_ ~3–5× card
bandwidth (still trivial), snprintf on the publisher path, torn-tail
ambiguity accepted, ingest tool still needed for gap math.

**Q10. Privacy posture for SD:** segments will hold transcription-adjacent
events and connection metadata on a removable, unencrypted card. Default-on
for dev devices with ~1 GiB retention? Encrypt-at-rest (breaks laptop
readability)? _Provisional:_ default-on for the dev fleet, no encryption in
v2.0, provisioning flag to disable. _If encryption required:_ AES-CTR per
segment + device-held key lands with the sink, and Q9's JSONL option dies.

### D. Session economics & cost policy

**Q11. Confirm policy V-B defaults:** 90 s idle window, drain at turn
boundary, rotate ~25 min (30-min xAI cap), transcript replay across hangups
(≈ last 20 turns retained in the DO). Replay is the user-visible difference
between "pause" and "amnesia" — but it means retaining transcripts
server-side. _Provisional:_ all yes. _If no replay:_ hangup = context loss;
`T_idle` should then lengthen (cost up) to compensate.

**Q12. Authorize the billing-unit measurement before freezing `T_idle`:**
open a session, send nothing for 10 min, read the bill — per-connected-minute
vs per-processed-audio-minute changes the economics ~10× (V-B's $4/day
assumes connected-minute). _Provisional:_ yes, before the plan freezes
numbers. _If skipped:_ freeze conservative (short window), revisit.

**Q13. In-band commit: does the type-2 uplink frame replace the control-lane
PTT commit path outright (one truth) or run belt-and-braces alongside?** One
truth is cleaner and kills the cross-socket race class permanently; alongside
is safer during transition. _Provisional:_ ship alongside in wave 4, retire
the control-lane path one release later. Also confirms D7's early-shipping of
the pcm.v2 header generally. _If "keep wire pristine until server AEC has
pull":_ the commit race and the PCM-up/control-down dead mode survive v2.0.

### E. AEC ownership

**Q14. Is barge-in-during-speech on the M5StickS3 a product goal?** The
Stick can never do device AEC (PDM mic, no reference). Ladder: timestamp
echo (groundwork, D7) → worker speak-state gating (~30 LOC, half-duplex-ish)
→ worker WASM speex-MDF (true barge-in, ~1–3 % core, benchmark first).
_Provisional:_ ship gating; WASM only on demonstrated product pull. _If
"yes, true barge-in":_ the WASM benchmark and the rig-side speexdsp evidence
run move into v2.0.

**Q15. Confirm the StackChan AEC plan:** hardware TDM reference first (ES7210
slot 1 MIC3 is wired across the speaker output — stackchan's verified
discovery supersedes the review's software-tap assumption), standalone
FD_LOW_COST + WebRTC VAD (not full AFE) behind the processor seam, gated on
the R4 chores (IRAM clawback — one byte free today — PSRAM enable + smoke,
placement audits) landing in waves 1–2. _Provisional:_ yes. _If full AFE
(wake word etc.):_ budget jumps to 60 KB internal + up to 780 KB PSRAM +
feed/fetch task split — a different resource plan.

**Q16. Who owns AEC chunk re-framing, decided now on paper?** esp-sr
dictates 512-sample/32 ms chunks; the wire is 320/20 ms. B's answer (the
pipeline re-frames behind `frame_spec`) goes into the seam contract text in
v2.0 with zero implementation. _Provisional:_ yes — it is the difference
between a seam that survives StackChan bring-up and one reworked mid-bring-up.
_If deferred:_ accept seam rework at maximum-hardware-risk time.

### F. Testing investment

**Q17. Accept the frozen-e2e rule?** `device-e2e.ts` (1,752 LOC,
physically proven) stays frozen; new scenarios land as sibling scripts over
shared helpers; the phase-runner is extracted only when the FOURTH additive
scenario lands (they are exactly four: uplink echo, AEC proof, barge-in,
ts-echo alignment). _Provisional:_ yes — the only frame that survives the
live git status. _If decompose-now:_ −600 LOC sooner, at refactor risk on the
physical-evidence path with no green-run diff to protect it.

**Q18. Rig cadence: scheduled nightly (tone + 1-min endurance rung,
nonblocking reports) on the hub Mac, or strictly human-initiated? And
checkride cadence — per-flash?** The threshold-erosion risk of gating PRs on
physical acoustics is real; nightly-with-reports gets trend data without
statistical pressure on the frozen thresholds. _Provisional:_ nightly
nonblocking + checkride per-flash (<5 min budget was chosen for that). _If
strictly manual:_ regressions like capture starvation surface only when
someone remembers.

**Q19. Is an audio-less target a CI citizen now?** Negative link test
(core-only executable, no audio symbols) + one simulator scenario + one
no-acoustics rig scenario, before any e-ink hardware exists. _Provisional:_
yes — it is the addendum's cheapest structural guarantee. _If no:_ the
guarantee is a link test only, and the first e-ink bring-up discovers the
gaps.

### G. Board roadmap

**Q20. Confirm board order: Waveshare before StackChan.** Waveshare is the
SD landing vehicle (only zero-conflict slot), the codec-seam payoff test
(ES8311 shared impl, ~0 new codec LOC target), and the playback-fold trigger
(D2). StackChan brings AEC + avatar but its SD shares the LCD SPI bus and its
audio is the maximum-risk phase. _Provisional:_ Waveshare first. _If
StackChan first:_ the playback fold and D3's implementations land under AEC
pressure simultaneously — schedule slack accordingly; SD hardware waits.

**Q21. HA Voice PE: purpose-built Iterate firmware or the ESPHome adapter
track?** The goal doc and the adapter task doc point opposite ways (§3.6).
Also: the adapter itself — is design-for-it (R3+R13 prerequisites + a sketch
in the plan) enough for v2, with build-it deferred until the HA integration
validates the device-stream model? _Provisional:_ purpose-built firmware for
VPE; adapter designed-for, not built; sketch mandatory in the condensed plan.
_If adapter-track for VPE:_ the control-only link set and nonblocking codec
become hard blockers rather than nice properties, and VPE audio ("must be
realtime") needs an answer the adapter's first scope explicitly excludes.

**Q22. Confirm two settled-decision reversals the candidates attempted:**
camera stays (goal doc makes photo a first-class capability and compat test —
A and B both deleted it); avatar/analysis defers until the voice slices work
(goal doc :635 — B wanted +1,100 LOC of analyser early; when it lands, the
stackchan 40-B render key + stage cues are adopted verbatim rather than
redesigned). _Provisional:_ keep camera, defer avatar, adopt-verbatim later.
_If you want the avatar earlier:_ land spectral+envelope only (integer,
112 B state), keep MFCC host-side.

### H. Team/agent workflow

**Q23. Will you carry the wart ledger as a standing review item?** Eight
named warts, each with carried cost and a measurable redesign trigger (e.g.
"third cross-machine delivery fix ⇒ collapse"). The triggers are review
discipline, not mechanism — if nobody owns them, minimal-delta degrades to
v1.5-forever and the two-year simplicity ranking inverts toward A.
_Provisional:_ the ledger goes into the final plan verbatim with an owner.
_If not:_ choose Q5's collapse-now instead — deferred-with-no-trigger is the
worst of both.

**Q24. Who declares the quiet windows?** The two real rewires (wave 2 audio
files, wave 3 schema) each need a codex-quiet window. Options: Jonas calls
it; codex's task list gates it; or a convention (v2 agent PRs only into
named waves, codex acks). _Provisional:_ explicit per-wave ack from you in
the task doc. _If laissez-faire:_ expect one lost-work incident per rewire
(the superset-worktree lesson).

**Q25. What does "done" mean for v2.0?** Candidate proof set: full ladder
green (tone → PRBS → endurance rung 3) + all four new rig scenarios green +
checkride pass on Stick + Waveshare bring-up with SD ledger diff + the
negative link test + KitDeviceProcessor live on a dashboard. _Provisional:_
that list, frozen in the plan. _If you want less:_ say which proof to drop —
each maps to a requirement.

---

## 5. VALIDATION LEDGER

Claims still needing verification, with method — respecting the
no-touching-v1 rule (read-only in the worktree; anything active runs from the
scratchpad or against external services, never builds/tests/mutates this
tree).

**Verified on this host today (no further action):**

| Claim                                                                                     | How verified                                                                                                                                                           |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex is writing `device_event_stream.{h,c}` + `callback_budget.{h,c}` as untracked files | `git status --porcelain \| grep '^??'`                                                                                                                                 |
| `device.h:4` includes `audio.h` (audio-less link set blocked in v1)                       | `sed -n '1,8p' components/core/include/iterate/kit/device.h`                                                                                                           |
| Five-boolean delivery duplication                                                         | grep in `device_event_stream.h:73-76` and `metrics.h:315-318`                                                                                                          |
| PCM gate resets on `socket_connected` (req-10 defect)                                     | `sed -n '610,622p' platforms/iterate_esp_idf/pcm_transport.c`                                                                                                          |
| IRAM 16,383/16,384 bytes used                                                             | `grep -n IRAM ../docs/physical-device-voice-goal.md` (:352)                                                                                                            |
| C's LOC ground truth (10/10 also verified by judge-simplicity)                            | `wc -l` on metrics.c (1,510), main.cpp (1,349), realtime_playback.hpp (1,863), device_event_stream.c (549)                                                             |
| `StreamEventInput` field names / `source` reserved / path-at-commit                       | judge-requirements §5.2 against `packages/iterate/src/processors/schemas.ts:11-92` (re-checkable: `sed -n '10,95p' <repo>/packages/iterate/src/processors/schemas.ts`) |

**Open — verify before or during condensation:**

| #   | Claim                                                                                                                                      | Why it matters                                                                                                                  | Method (v1-safe)                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | xAI bills per _connected_ minute (not per processed-audio minute); mints are free/unlimited; 30-min session cap                            | Sets `T_idle` economics ~10× (Q12)                                                                                              | Standalone script in the scratchpad (doppler-supplied key): mint secret, open session, send nothing 10 min, close; read team billing next day. No worktree involvement                                      |
| 2   | Cold-dial budget 300–850 ms from a CF DO (mint 150–450 + WS 100–250 + session.updated 30–150)                                              | Preroll sizing, press-masking claim (D8)                                                                                        | Scratchpad TS script against `api.x.ai` with per-phase timestamps, 20 dials; later re-measure from the deployed worker                                                                                      |
| 3   | A's spine additions ≈1,250 LOC (simplicity judge audits 1,800–2,200)                                                                       | Sizes the v2.1 collapse honestly                                                                                                | Only resolvable by prototyping `log.{h,c}` + `event_subscription` in the scratchpad in house style; optional — the synthesis does not depend on it in v2.0                                                  |
| 4   | DO hibernation: workerd answers RFC 6455 PINGs at the runtime layer without waking the DO (idle Stick ⇒ near-zero DO duration cost)        | $0.135/day/device claim; V-B economics                                                                                          | Cloudflare docs check + a minimal test worker (scratchpad deploy to a dev account), observe wall-clock duration billing with a ping-only client                                                             |
| 5   | WASM speex-MDF ≈0.2–0.6 ms per 20 ms frame in workerd                                                                                      | Q14's cost line                                                                                                                 | Scratchpad: compile speexdsp MDF to WASM, 60 s PCM fixture benchmark in workerd — only if Q14 answers "true barge-in"                                                                                       |
| 6   | Waveshare SD pins CLK=2/CMD=1/D0=3, SDMMC 1-bit, zero display/audio conflict                                                               | SD landing vehicle (Q20)                                                                                                        | Read-only check of `waveshareteam/ESP32-S3-Touch-AMOLED-1.8` clone under `~/src/github.com/` (clone if absent — outside this worktree); physical confirm at bring-up                                        |
| 7   | CoreS3 hardware AEC reference is real on OUR StackChan unit (ES7210 TDM slot 1 = MIC3 across speaker out) + AW88298 reg 0x06=0x20 needed   | D3's "hardware ref first" plan                                                                                                  | Source verified in the stackchan clone (`audio_pipeline.c:446-482,174-208`); physical verification is a StackChan bring-up step (interleaved mic/ref debug dump, 0–10 ms window)                            |
| 8   | HA VPE input is 16 kHz already-echo-cancelled post-XMOS; output DAC domain 48 kHz                                                          | `input_echo_cancelled` property + VPE codec impl                                                                                | Read-only: `~/src/github.com/esphome/home-assistant-voice-pe/home-assistant-voice.yaml` (i2s sections); confirm at bring-up                                                                                 |
| 9   | 77.8 KiB free internal heap at idle; composition vs event core (+~2–7 KiB) + AEC (31–60 KB) leaves margin                                  | Merge condition (iii) in D6                                                                                                     | Goal-doc figure verified; live re-measure is a bring-up step (`getDiagnostics` heap fields on the running Stick — read-only RPC, but wait for a codex-quiet window before touching the shared device)       |
| 10  | The uplink echo-loop scenario actually fails on pre-R1 firmware under `--control-churn-hz` load (the pre-fix-must-fail property)           | Validates the R1 regression gate is a real detector, not a formality                                                            | Run once against current firmware when wave 2 opens — requires the rig + device, so post-checkpoint; the scenario lands as a sibling script, never edits `device-e2e.ts`                                    |
| 11  | `esp_vfs_fat_create_contiguous_file` freezes the FAT chain so preallocated-extent scan-by-CRC recovers past stale directory size           | SD crash-forensics story                                                                                                        | Read-only: `~/src/github.com/espressif/esp-idf/components/fatfs/` (`esp_vfs_fat.h:420`, `FF_USE_EXPAND=1` in `ffconf.h:46`) — cited but not independently traced; then fake-block-store host test in wave 4 |
| 12  | Grok pricing $0.08/min for `grok-voice-think-fast-2.0`; `grok-voice-latest` alias moves 2026-08-05                                         | Cost table in the plan                                                                                                          | Web-only sources today (aicostcheck/eesel); confirm against the actual bill in ledger row 1's measurement                                                                                                   |
| 13  | The `#suppressDownlink` defect (`device-pcm-proxy.ts:429`) and the oversized-provider-message admission are still live in the current tree | Wave-0 fix list accuracy (codex may have touched `device-pcm-proxy.ts` — it is NOT in the modified set, but re-check at wave 0) | `git status` + `sed -n '425,435p' apps/kit/src/voice/device-pcm-proxy.ts` at wave-0 time                                                                                                                    |

---

_This synthesis is the input to the grilling round (§4) and then to the
condensed plan. Nothing in it authorizes touching v1: the codex agent's
files, builds, and the physical device remain off-limits until the named
checkpoints in §2.4._
