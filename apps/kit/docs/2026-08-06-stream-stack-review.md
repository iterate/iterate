# The Kit voice stack: deep review, target architecture, and test strategy

2026-08-06, on `stream-for-audio` (PR #2376 plus the uncommitted working tree).

**Method.** Fourteen-agent review: ten parallel deep readers (core transport, audio+AEC,
device compositions, host CLI, userspace worker, avatar/viseme, tests/CI, docs-vs-reality,
ESP-IDF alignment, working tree), three designers (target layering, test architecture,
simplification audit), one adversarial critic who re-verified the designers' riskiest claims
against the repo. Every factual claim below carries a `path:line` citation from a reader who
opened the file; where a designer's proposal failed the critic's check, the corrected version
appears here and the wrong one is listed in §9 so it doesn't come back.

---

## 0. TL;DR

The stack is much healthier than it feels. The seams are right, the hard correctness
inventions are real and live in exactly one place each, the ESP-IDF usage is _better_ than
best practice (deviations are deliberate, measured, and use sanctioned override seams), and
the Mac C CLI was never deleted — it is the closest artifact in the tree to your stated
north star. What is wrong is almost entirely **one disease with four symptoms**: the four
`*_device.c` composition files are the same ~1,500-line program pasted four times, and
everything that touches them — new features, supervision fixes, the host CLI, testing —
pays a 4× (really 5×, counting the CLI's hand-copy) wiring tax. The uncommitted tree makes
the products better and the disease worse: it deletes per-board duplicates at the
display layer while adding ~8 new verbatim blocks per board to the app loop, with
copy-paste artifacts (misindented tick calls) proving the hand-sync has already broken.

The plan, in one breath: land the safety net (CI compiles the four IDF targets, hermetic
proofs promoted to CI, `grokBaseUrl` passthrough for the C client — verified one small
change); split the uncommitted tree into three commits and land it; delete the dead code;
split `voicelab_stream.c` along its natural seams; hoist the quadruplicated machinery into
shared modules **full-duplex boards first, the half-duplex Stick later, StackChan last**;
make the host CLI _be_ that shared code instead of a copy; then build the hermetic AEC
bench that finally measures the one invariant everything stakes itself on — with zero
cloud, zero Grok, and corrected per-board oracles. Net effect: ~5,500–6,000 lines deleted,
five recurring failure classes get structural countermeasures, and the edit-to-confidence
loop drops from "flash and read counters over prd" to under two minutes on a Mac for
everything except acoustics.

---

## 1. The system today

### 1.1 Three tiers

```
┌────────────────────────────────────────────────────────────────────────┐
│ USERSPACE  voice-agent.ts (4,034 lines) in the user's config repo      │
│            VoiceBridge DO ↔ Grok realtime WS; visemes; back office;    │
│            warm-up handshake; redial ladder; one append lane down      │
├────────────────────────────────────────────────────────────────────────┤
│ PLATFORM   os.iterate.com/api — streams, Cap'n Web, capability host    │
│            (unchanged by this review; the wire contract is small)      │
├────────────────────────────────────────────────────────────────────────┤
│ DEVICES    4 ESP32-S3 boards + Mac C CLI + Node CLI, all speaking      │
│            ONE Cap'n Web WebSocket: mic-frame appends up,              │
│            spk-frame/viseme batches down into an exported callback     │
└────────────────────────────────────────────────────────────────────────┘
```

There is exactly one socket and everything on it is Cap'n Web wire protocol — mic frames
are one-way `append` RPCs with hand-`snprintf`'d JSON args (`voicelab_stream.c:1196-1246`);
spk frames arrive as `processEventBatch` calls into an exported callback capability with a
constrained-consumer contract of 16 events / 13,000 bytes per batch
(`voicelab_stream.c:785-944`). The ad-hoc part is the JSON event schema _inside_ those
payloads: hand-serialized in C, hand-parsed in TS, **no shared schema artifact between the
two implementations** — the same structural setup that produced the flasher/TLV incident.

### 1.2 The wire vocabulary

| Direction | Event                                                                       | Durability | Notes                                                                                               |
| --------- | --------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------- |
| up        | `voice-agent/mic-frame`                                                     | ephemeral  | mu-law base64, 4 frames/append (`voice_device_profile.h:79`)                                        |
| up        | `voice-agent/turn`                                                          | —          | PTT edges → provider buffer clear/commit (VA:2547-2632)                                             |
| up        | `voice-agent/ping`, `say`, `context-added`, `call-ended/accepted`           | mixed      | VA:2689-2697 lists the bridge's exact subscription                                                  |
| up        | `voice-agent/call-requested`                                                | durable    | loose-parsed; **already accepts `grokBaseUrl`** (VA:579-589)                                        |
| down      | `voice-agent/spk-frame`                                                     | ephemeral  | `{callId, answer, frame, seq, …}` — no server pacing, the listener owns the clock (VA:1171-1197)    |
| down      | `voice-agent/viseme`                                                        | ephemeral  | `{answer, playoutSamples, viseme 0-14, confidence}`, same append batch as its frames (VA:1279-1286) |
| down      | `voice-agent/grok-event`                                                    | ephemeral  | slimmed projection — full `response.done` once overflowed the device token pool (VA:2234-2288)      |
| down      | `call-accepted/ended/failed`, `pong`, `turn-committed`, `bridge-redialling` | mixed      | R5 §1                                                                                               |

Wire geometry is defined once: 320 samples / 20 ms / 640 bytes PCM16 at 16 kHz
(`voice_device_profile.h:51-55`). mu-law + base64 + 4-per-append exists because every
one-way append costs 2 WS messages against a ~25–50 msg/s TLS ceiling
(`voicelab_stream.h:24-38`).

### 1.3 The firmware as built (who calls whom)

```
targets/<board>/main ─▶ devices/<board>/*_device.c  (2,075–2,981 lines each ← the problem)
                              │ composes
      ┌───────────────────────┼───────────────────────────────┐
      ▼                       ▼                               ▼
 components/audio        components/core                 components/
 audio_codec seam        voicelab_stream.c (1,641 ← god) capabilities/ avatar/
 audio_processor seam    audio_playout ─ pure, 1 copy    camera servos face
 aec_capture_bridge      voice_playback_clock ─ pure     health PTT   sprites
 scaler/selector/hp      peer.c / itx_mount / itx_conn
      │                  websocket_{tx,rx,text,frame}
      ▼                  spsc_ring / retry_gate
 devices/<board>/*_audio.c    │
 (I2S drivers, fences)        ▼
                 platforms/iterate_esp_idf | platforms/darwin
                 (net task, TLS/WS dial, reconnect policy ×2)
                              │
                    vendored capnweb C (pin aee32b39, caller-owned arenas)
```

Load-bearing facts about this picture, all verified:

- **The Cap'n Web C implementation is real** — FetchContent pin of
  `github.com/iterate/capnweb` subdir `c`, ~3k lines, fully caller-supplied arenas
  (`capnweb.h:251-278`); `peer.c` dispatches static generated method tables with
  duplicate-path rejection at init and no allocation (`peer.c:5-24`).
- **Everything is static or caller-owned.** Heap is rejected in core so a hostile peer
  cannot grow parser/import/export state without a profile-visible limit
  (`itx_connection.c:15-18`). `voice_device_profile.h` is the single size ledger:
  arenas, 64×16 KiB inbox + 64×8 KiB outbox (PSRAM via `EXT_RAM_BSS_ATTR`), 40-slot
  outbox reserve so mic audio can't starve mandatory replies, 960 KB speaker ring.
  Nothing unbounded was found. Core creates exactly one task (ESP) or none (darwin).
- **Liveness is four coherently tiered mechanisms**: TCP keepalive 10s (last-resort
  dead-peer detection only), WS PONG reply-only, app-level ping proving the whole
  device→platform→bridge loop, and evidence-with-deadline on `last_batch_ms` /
  `last_bridge_ms` — the instrument built from a measured 68s
  dead-downlink-while-socket-healthy incident (`voicelab_stream.h:233-269`).
- **The play/clear decisions are pure and singular**: `audio_playout.c` (three-way
  IGNORE/APPEND/REPLACE over `{call, answer, frame}`, with the restart-at-zero and
  abandoned-answer latches from measurement), `voice_playback_clock.c` (prefill gate,
  no-debt conceal, skip-not-trim catch-up). One copy each. What is quadruplicated is the
  _machinery around_ them (§2.1).

### 1.4 Feature matrix

|                 | Waveshare S3 AMOLED          | M5StickS3                                                         | HAVPE                                  | StackChan CoreS3                                        |
| --------------- | ---------------------------- | ----------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------- |
| Screen          | AMOLED + LVGL, avatar        | 240×135 + face                                                    | none — 12-px LED ring is the display   | 320×240, avatar owns display                            |
| Touch           | on-screen talk/call          | no                                                                | no                                     | whole-screen tap = call toggle                          |
| AEC             | none (PTT is the echo story) | none needed — hardware half-duplex, mic can't run during playback | XMOS hardware AEC, ref private to XMOS | esp-sr VOIP AEC, divider reference on ES7210 TDM slot 1 |
| Buttons         | 2 (BOOT=PTT, PWR=tap)        | 2 (hold=PTT, side=call)                                           | 1 (GPIO0: hold=PTT, tap=call)          | 0 (touch only)                                          |
| Servos / camera | no / no                      | no / no                                                           | no / no                                | 2 servos, chunked camera                                |
| Turn-taking     | manual PTT                   | manual PTT                                                        | manual PTT                             | open mic + server VAD (recorded A2 exception)           |
| Viseme lane     | **wired** (only board)       | face, mouth never moves                                           | no face                                | `on_viseme = NULL`, envelope-only mouth                 |

The echo invariant ("the device cannot hear itself") is met by **four different
mechanisms**: PTT-drop, physical half-duplex, XMOS silicon, and esp-sr. Any AEC bench has
to prove a different thing per board (§4.3).

### 1.5 What is already right (don't churn these)

- The `audio_codec` / `audio_processor` seams and the fail-closed rule — "raw microphone
  audio must never leak around a failed echo canceller" (`audio_processor.h:56-68`),
  applied twice on StackChan. Right altitude: `has_reference_channel` /
  `capture_is_echo_cancelled` are exactly the two facts the portable layer needs.
- The correctness inventions in `voicelab_stream.c`: exported-callback `openConnection`
  with a constrained-consumer contract, offset dedupe across recycle overlap,
  make-before-break recycle at 600 batches vs the platform's ~1000-push ceiling, bridge-id
  filtering so a stale bridge can't end a newer bridge's call, evidence-deadline liveness.
  These _are_ your "local stream processor deciding when to clear the buffer." Keep them
  intact through any split.
- The ESP-IDF work is not fighting the platform (§2.10) — it is a careful, documented,
  measured set of deviations using sanctioned seams.
- The avatar component: platform-independent, allocation-free, audio-first (animation may
  degrade, never delay audio), atlases in flash DROM (~45 KB, zero RAM), mouth clocked off
  _physical_ DMA completion, single-writer seqlock with `snapshot_races` as tripwire.
- `verify_core_boundary.cmake` — compile-enforced seams, honest about being a second line
  of defence. (It has two gaps to widen, §2.6, but the mechanism is proven.)
- The server half already matches the north star's shape: device sends mic frames + turn
  edges, receives self-describing frames it plays on its own clock. `voice-agent.ts`
  imports only the published SDK surface (one platform-internal leak: the hard-coded
  trusted `wakeStreamProcessor` expression, VA:3602-3611).
- The host CLI's determinism rig: process-wide virtual clock, `--sealed` bit-for-bit
  replay, seeded fault schedules (CPU stall, clock skew/jitter, wire throttle/stall/reset,
  mic faults, per-frame DROP/DUPLICATE/REORDER) injected upstream of the _shipping_
  classifier path, underrun silence written into recordings so a WAV can't hide a stall.

---

## 2. What needs improving

Ranked by (blast radius × recurrence), not by how annoying each is in isolation.

### 2.1 The 4× wiring tax — the disease

Measured by diffing after normalizing board-name tokens:

- **m5sticks3 vs havpe: 2,004 of havpe's 2,075 lines are identical.** These are one
  program with a fence and an amplifier toggled.
- Four-way common core ≈ **1,500 lines × 4 ≈ 6,000 of the fleet's 9,564 device.c lines**.
- Near-verbatim quadruplicates: the runtime mega-struct (~50 counters), `on_speaker_pcm`,
  the `abandon_speaker_audio` funnel, `on_control`, `playback_task` + `capture_task`
  (~250 lines each), `initialise_rings`/`initialise_connection`, the health emitter,
  clock/conversation identity, `park_with_fault`, and the **entire `run()` supervision
  ladder** — `waveshare_device.c:2286-2975` vs `stackchan_device.c:1890-2388` are
  line-for-line the same _including comment text_.
- The audio layer adds its own copies: the absolute-deadline starvation ledger ×4, the
  depth-1 mailbox `codec_read`/`codec_write` adapter verbatim ×3, and three separate
  implementations of saturating gain (`aec_reference_scaler.c:23-35`,
  `aec_uplink_selector.c:7-21`, HAVPE's inline ×16 at `havpe_audio.c:353-365`).
- The uncommitted tree adds ~8 more verbatim blocks per board (`preparing_ahead`,
  `park_with_fault`, transport-retry loop, watchdog-edge reset, eager-prepare, split
  backoffs, heap health fields, `set_fault`) — and the sync is _already_ broken:
  misindented `havpe_ui_tick();` / `m5sticks3_ui_tick();` calls inside the pasted retry
  loops are copy-paste artifacts.

Every future fix to call lifecycle, liveness, or health costs four hand-synchronized
edits today (five with the host CLI, §2.5). The two most expensive bugs of the
consolidation week were both duplicates, not logic errors (consolidation.md:514).

### 2.2 `voicelab_stream.c` is a god-module

1,641 lines owning, with line ranges: mu-law both directions (83-138, 233-267), base64
(140-229), spk-frame decode + seq-gap accounting (269-352), viseme parse (354-392), a
**transcript engine** (394-444, 468-591), a **Grok realtime protocol interpreter**
matching provider event names verbatim (446-592), batch dispatch + liveness stamps
(594-710), connection open/recycle/make-before-break (712-944), **its own auth chain**
(946-1164), appends (1168-1272), call control (1274-1387), turn markers, ping,
**provisioning** (1477-1542), release-ledger close (1544-1597). The target's "tiny local
stream processor" is real — roughly batch-dispatch + spk-frame handling + appends +
recycle, ~500 lines — but it's wrapped in everything else. Split plan in §3.2.

### 2.3 Provider vocabulary on-device

The device parses Grok's event names (`input_audio_buffer.speech_started`,
`response.done`, …) at `voicelab_stream.c:446-592`. The bridge already translates for
audio and visemes; it should translate for control too, emitting device-neutral events
(`speech-started`, `answer-done`, `transcript-delta`). Today a provider rename means a
fleet reflash. **Migration caveat (critic-verified):** reflashing is manual and fragile
(a CoreS3 dropped off the USB tree mid-flash; the console port reboots the S3), so this
is _not_ a one-shot clean break — the bridge must dual-emit both vocabularies for a
window and drop the old one after the last board confirms (§6 step 6).

### 2.4 Nobody owns the connection story end-to-end

- **Five copies of `on_session_ended` reach directly into voicelab privates** — hand-
  clearing `state`, `failure`, and six `has_*` flags (`waveshare_device.c:591-602`,
  havpe 325, m5 328, stackchan 342, `cli_capabilities.c:189`). Wants to be one
  `iterate_kit_voicelab_session_ended()`.
- Device code now also writes `runtime.voicelab.last_batch_ms` directly ×4 to re-arm the
  downlink watchdog (uncommitted tree) — a reach into another module's watchdog state.
- **Duplicate auth chain**: `itx_mount` and `voicelab_stream` each independently run
  `authenticate → projects.get` on the _same_ session per generation
  (`itx_mount.c:25-27` vs `voicelab_stream.c:1097-1164`), plus duplicated
  fail/release/take-result helpers. Two authenticate RPCs per generation for no reason.
- The ESP and darwin transports re-implement the same reconnect/generation/mount-deadline
  policy machine (1,783 vs 659 lines). **Critic's caution, adopted:** this is _not_ pure
  textual duplication — the ESP three-generation handshake exists because policy runs on
  the net task and callbacks cross to the app task. Merging the conductors is a
  concurrency redesign; the honest near-term move is extracting only the pure
  generation/mount-deadline arithmetic into shared functions and leaving both conductors.

### 2.5 The host CLI is a copy of the device, not the device

`host_cli/main.c` (2,245 lines) _reimplements_ the device app loop — it literally
cross-references "the device's copy of this branch" (`main.c:1355-1357`). Consequences:
loop fixes proven on the CLI are re-implemented, not proven, on ESP; board compositions
never compile on darwin; the CLI's device-profile table has only 2 of 5 rows
(`cli_device_profile.c:78-103`); the AEC seam on host is empty (`reference = NULL`,
passthrough — `main.c:657`), so a live Mac session hears itself and the flagship
invariant is unexercisable off-hardware; and the C binary has no hermetic provider lane —
`talk.ts` builds and drives it but **defaults to production** voice-test with a real xAI
secret (`talk.ts:33-47`).

Two stale beliefs corrected: the C client is **not** TLS-only — `configuration.c:163-166`
builds `ws://`/`http://` URLs, so it can dial local `pnpm dev` directly (the `wire.ts:9-13`
claim is stale, though hardware may still want the TLS proxy). And **no earlier Mac CLI
was ever deleted** — git history shows only three small deletions in `apps/kit`, each
superseded the same commit; this CLI grew in place and is worth building on.

### 2.6 The learning loop

What exists is fast where it exists: host C suite 59 tests / **4.5s warm** with
ASan/UBSan; kit vitest 24 tests / 0.33s; voicelab vitest 120 tests / 1.1s, including one
complete hermetic realtime session against `local-fake-grok`. The holes:

- **The four `*_device.c` compositions have zero tests at any level.** Only three device
  files ever reach a host test. The M5 half-duplex fence, the supervision ladder, the
  abandon-funnel ordering: proven only by flashing and talking.
- **Nothing in CI compiles the ESP-IDF targets.** A PR can be green while breaking all
  four board builds. There is no CI-built firmware artifact anywhere (the catalog's
  releases are deliberately empty; phase-4 boards were provisioned from a hand-built
  image).
- **Portable core tests are APPLE-gated**: `itx_outbox_sender` and
  `websocket_frame_reader` — core modules — are tested only inside `if(APPLE)`
  (`tests/CMakeLists.txt:144`); Linux CI has never run them.
- **`kit-cli-proof.mts` is wired to nothing** — the provider-hermetic full-conversation
  proof (TS voice-cli ↔ local dev ↔ real config-repo worker ↔ fake Grok) runs only when
  someone remembers.
- StackChan **double-talk is unmeasured** — flagged three times in the log, still open;
  the esp-sr uplink selector's switched policy is dark (fed a documented zero activity
  plane, `stackchan_processor.c:59-65`), so its hangover machinery executes but never
  selects.
- Hardware observation is a trap zone by construction: console port resets the S3, JTAG
  was actively harmful twice; the honest path — RPC capabilities + counters over the
  stream — exists and is the right one, but it currently requires prd/preview.
- `verify_core_boundary.cmake` misses `components/audio`'s other public headers
  (`aec_capture_bridge.h` et al. survive only via the REQUIRES backstop) and scans only
  core.
- Every fresh CI tree does a **non-shallow network clone** of the pinned capnweb.

### 2.7 Dead code and doc rot

- `face_driver.c` + `FACE_ALGORITHM_ENVELOPE`: a pluggable-algorithm vtable with one
  algorithm and zero consumers, including tests (~170 LOC with plumbing). The literal
  "invented framework" smell.
- `face_stage.c` cue/gesture machinery: nothing anywhere constructs a `face_stage_cue_t`
  (~200–250 of 305 LOC).
- Waveshare `avatar_request_slug/next/count/slug_at` and StackChan's
  `avatar_request_sprite_set` RPC: dead selection APIs; the live path is physical
  buttons. Wire-or-kill decision needed (§7).
- `slugprobe.tmp.ts` is **git-tracked** with a hardcoded project id — exactly what
  `.tmp` naming exists to prevent. `shot.tmp.mts` superseded by `boards.ts`.
- `apps/kit/clients/resilient.ts` + `rpc-ownership.ts` are **byte-identical** copies of
  the voicelab files with no drift test.
- `greet` param: accepted, placed on the Grok URL, never read (greeting was deliberately
  removed).
- Doc rot that will mislead the next author: `apps/kit/README.md:51-63` still documents
  the JSON config partition that the TLV fix made false; `voicelab/README.md:25-34` and
  PRESSURE.md use the retired `voicelab/*` event vocabulary. This is the exact class
  that produced the flasher incident (an encoder written against stale docs).

### 2.8 The recurring failure classes (fix the causes, not the instances)

The log's history shows four classes that keep coming back; each needs a structural
countermeasure, not another sweep:

1. **Dark instruments** (~6 instances): counters that structurally cannot fire —
   `spkStarvedMs` never credited; `capFailed`/`spkFailed` incrementing behind the same
   gate that disables the direction, so a dead mic reads like a quiet one; AEC bridge
   metrics with no reader on the only AEC board. _Cause:_ instruments declared beside
   features with no test forcing them to move. _Countermeasure:_ the counter-liveness
   gate, §4.4.
2. **Tests green by construction**: a passthrough test asserting values it wrote; a
   drift test comparing two unrelated values that both happened to equal 4; interrupt
   tests accepting two frames first, hiding the frame-0 latch bug. _Cause:_ assertions
   derived from implementation behavior. _Countermeasure:_ mutation-on-review as a
   standing gate (one demonstrated killed mutation per new oracle) — cultural, but it is
   the thing that caught every instance so far.
3. **Encoder/decoder pairs sharing only the magic**: the flasher wrote JSON where
   firmware reads TLV; C and TS today share no schema artifact for the event JSON.
   _Countermeasure:_ golden-vector corpora consumed by both sides (config TLV, mu-law,
   event JSON, playout classifier).
4. **Believed rather than proved**: comments claiming 12/8/6 where the value is 4; the
   "one byte of IRAM free" myth. _Countermeasure:_ the log's "Measured:" discipline —
   which the uncommitted tree has lapsed on (11 modified files, two new modules, no log
   entry).

### 2.9 Misplaced modules

`components/core` should be socket + RPC + local stream processor, but currently also
holds `conversation_overlay.c` (a bitmap-font pixel renderer), `conversation_lights.c`,
`talk_button.c`, `touch_tap.c`, and the new `face_wake.c` — while `face_doze.c` (its
twin) lives in `avatar`. Dependency-clean, host-tested, so not urgent — but the pixel
renderer in the transport layer blurs the boundary the repo enforces by compiler.
Meanwhile `talk_button`/`touch_tap` sit _underused_: three boards re-implement debouncing
per board. Both new modules also note quality items: `overlay_equal` (the function whose
misuse caused the 1 Hz face-blackout repaint) is untested, and both boards hold
`face_wake` state in function-local `static`s — quietly recreating the hidden singleton
its header was designed against.

### 2.10 ESP-IDF alignment — mostly a non-problem

Direct answer to "are we working at cross purposes with ESP32 best practice?": **no.**
The deep read found a stack that is unusually well-aligned, with every deviation
deliberate and documented in place:

- **Task topology is sane**: clean core split (network=0, audio=1), monotone priority
  ladder (I2S DMA owner 23 > playback 17 > capture 16 > app/net 5 > UI 2/3), lwIP pinned
  to core 0 with the measurement written next to the symbol, static stacks where
  reconnect-time fragmentation matters.
- **I2S: new `i2s_std`/`i2s_tdm` driver everywhere**, never legacy.
- **`esp_websocket_client` replaced, justifiably**: its hidden task + mutex-serialized
  sends can't give a single steady-state owner. The replacement keeps IDF for the hard
  parts (DNS/TLS/upgrade) and owns the socket single-threaded. Four textual patches to
  IDF v5.4's `tcp_transport` are load-bearing, each an ordinary nonblocking-transport
  bugfix, guarded by exact-once FATAL_ERROR checks — **upstream candidates**.
- **esp-sr: raw `esp_aec` instead of AFE is a documented integration path**, chosen
  because AFE's feed/fetch model implies esp-sr-owned tasks, which the single-owner
  design forbids. Cost accepted knowingly (no esp-sr NS/AGC; no filter reset — destroy/
  recreate, counted).
- **CoreS3 BSP forked at 3.0.2 via the official `override_path` seam**, every input file
  SHA256-pinned, because upstream has no TDM-reference path.
- sdkconfig: the shared voice lane is identical across boards with measurements inline
  (FREERTOS_HZ=1000, IRAM-safe ISRs, 32 KB TCP buffers, PSRAM TLS allocs).

Real gaps, all cheap: (a) `alignas(16)` missing on the AEC scratch planes —
`esp_aec.h` requires 16-byte alignment (`stackchan_processor.c:49-51`); (b) StackChan
runs the 16 KB default instruction cache while the other three force 32 KB — backwards,
since it is the only board executing code from PSRAM; (c) StackChan omits
`SPIRAM_MALLOC_RESERVE_INTERNAL` while being the board that just hit internal-heap
exhaustion (mbedtls AES alloc failure at internalFree=4,603); (d) **no OTA anywhere** —
frozen donor partition offsets are a conscious trade, but "always connected, never
crash" at fleet scale eventually implies updatability without a USB cable (§7).

---

## 3. Target architecture

Diff from today, not greenfield. Names below that don't exist yet (`voice_link`,
`call_control`, `wire_codec`) are working names for the split files — rename at will.

### 3.1 Layer map

```
L6  targets/<board>/main + devices/<board>/     board root: codec driver, processor
    (~350-500 lines/board, was 2,075-2,981)     composition, ops impls, constants,
                                                storage, quirks (fence, XMOS park)
L5  features: components/avatar (+face_wake      per-board capabilities over shared
    beside face_doze), components/status         implementations; overlay/lights move
    (overlay+lights), capabilities/, input       out of core; talk_button/touch_tap
    (talk_button, touch_tap as the ONLY          become the only debouncers
    debouncers)
L4  components/audio: codec seam, fail-closed    unchanged seams + hoisted helpers:
    processor seam, aec bridge/scaler/selector   ONE starvation ledger, ONE mailbox
                                                adapter, ONE saturating gain
L3  components/core, the actual kernel:          NEW shared machinery replacing the
    - voice_link.c      (split from voicelab_    4× copies: supervision ladder,
      stream: frame pump, recycle, liveness)     playback/capture tasks + abandon
    - call_control.c    (call lifecycle,         funnel, health emitter, session_
      prepare-ahead, bridge-id filter)           ended()/feed_watchdog() APIs
    - voice_playout     (existing pure trio
      + ONE shared task pair + funnel)
    - health emitter    (shared table + per-
      board extras + liveness gate)
L2  vendored capnweb C, itx_connection,          dedupe: ONE authenticate→projects.get
    itx_mount (absorbs auth + provisioning)      chain per generation
L1  websocket_{frame,tx,rx,text}, spsc_ring,     already right; widen the boundary
    retry_gate                                   check to all audio headers
L0  platforms/{iterate_esp_idf,darwin}           keep BOTH conductors (task-ownership
                                                is real, §2.4); share only the pure
                                                generation/deadline arithmetic
```

Dependency rule: L(n) includes only L(<n), enforced by the widened
`verify_core_boundary.cmake` plus IDF `REQUIRES` mirrored in the host build.

Grok's event vocabulary moves **server-side entirely** (§3.4). The transcript engine
becomes a small L5 `transcript_view` consuming neutral deltas on boards with screens.

### 3.2 The `voicelab_stream.c` split (five pieces, by existing line ranges)

1. **`wire_codec.c`** — mu-law + base64 (83-267). ~300 lines of pure functions,
   trivially testable, reused by the host CLI.
2. **`voice_link.c`** — spk-frame decode, viseme parse, batch dispatch + liveness
   stamps, open/recycle/make-before-break, appends, turn markers, ping (269-392,
   594-944, 1168-1272, 1389-1475). All the load-bearing correctness inventions land
   here **intact**.
3. **`call_control.c`** — call start/end/forget + bridge-id filter (1274-1387),
   absorbing the prepare-ahead/two-backoff machine currently pasted ×4, and exporting
   `feed_watchdog()` so boards stop writing `last_batch_ms` directly.
4. **Into `itx_mount`** — the duplicate auth chain (946-1164), provisioning
   (1477-1542), release-ledger close (1544-1597).
5. **Deleted from device** — the Grok interpreter + transcript engine (394-592), replaced
   by the bridge's neutral control events.

Plus the two API functions that end the struct-poking: `voicelab_session_ended()`
(replaces five copies) and `feed_watchdog()` (replaces four reach-ins).

### 3.3 The device.c shrink — **needs your explicit sign-off**

The mechanism: hoist the quadruplicated machinery into named kernel functions
parameterized by **one flat struct of function pointers + scalars**, filled once at boot
in each board's own file. The evidence it works without a framework: all four UI
vocabularies are already the identical 4-state enum, and StackChan already hand-wrote
exactly this shape internally (`stackchan_device.c:387-469` — the `stackchan_ui_*` shim
_is_ the ops table). Per-board expression needed: 7 ui fns, 3 input fns, 4-5 audio fns
(`amplifier` is NULL on HAVPE/StackChan; the capture fence pair exists only on M5), and
~10 config scalars (`DMA_RING_CREDIT_MS` 90/120/60/40, `SPEAKER_DRY_WAIT_MS` 60/80/40/25,
turn mode, viseme callback or NULL, extra capability modules, health-extras array).

**Why sign-off:** the standing rule is "rhyming compositions, no frameworks, three
device roots a reader can diff" (IMPLEMENTATION-LOG:738-741). A flat ops struct filled
inline is a composition parameter, not a lifecycle framework — but that judgment is
yours to make, not this report's to assume. The critic flagged both designers for
treating the StackChan shim as settled permission. Honest statement of the trade: after
the hoist, a board file is a ~350-500 line declaration of what makes it different; what
you lose is the ability to read one file top-to-bottom and see the whole program; what
you gain is that the program exists once, is host-testable, and the CLI can _be_ it.

Two corrections baked in from the critic:

- **Boards keep owning storage.** StackChan's runtime is PSRAM-resident while its
  transport deliberately is not (`stackchan_device.c:294-300`); the kernel takes
  pointers, never declares placement.
- **Honest arithmetic:** fleet device lines drop ~9,600 → ~2,600, but the kernel gains
  ~1,500–2,000 new (shared, tested) lines. Net deletion ≈ 5,500–6,000, not 8,000.

Sketch of a target board root (HAVPE), with the boot-failure path corrected so parking
happens _after_ UI ops exist (parking before the surface can display the fault would
recreate the indistinguishable-from-dead class that `park_with_fault` was built to kill):

```c
static iterate_kit_voice_rings rings EXT_RAM_BSS_ATTR;   /* board owns placement */

static const iterate_kit_board_config cfg = {
  .dma_ring_credit_ms = 60, .speaker_dry_wait_ms = 40,
  .turn_mode = ITERATE_KIT_TURNS_MANUAL, .on_viseme = NULL,
  .mount_name = "kit.havpe", .health_extra = havpe_health_fields,
};
static const iterate_kit_board_ops ops = {
  .ui    = { /* the 7-fn StackChan-shim shape over the ring driver */ },
  .input = { .talk_held = boot_button_held, .take_call_toggle = boot_button_tap },
  .audio = { .amplifier = NULL /* XMOS rail never drops */,
             .note_flush = havpe_audio_note_flush,
             .dma_draining = havpe_audio_draining },
};

void app_main(void) {
  havpe_ui_init();                              /* fault surface first */
  if (havpe_audio_init() != OK)                 /* XMOS 3s boot, fail-closed */
    iterate_kit_park_with_fault(&ops, "audio"); /* fault is now visible */
  iterate_kit_device_run(&cfg, &ops, &rings,
      iterate_kit_audio_processor_passthrough(), havpe_codec());
}
```

StackChan differs in exactly: bridge-composed processor, `turns="vad"`, `talk_held`
returning false, servo/camera modules, avatar-owned display, 8 KiB capture stack.

### 3.4 The userspace worker

`voice-agent.ts` needs no re-architecture — the wire contract is small and clean, and
the bridge already owns redial, supersession, warm-up, and the one ordered append lane.
Changes: (a) emit the neutral control vocabulary alongside `grok-event` during the
migration window, then drop the raw projection; (b) delete the dead `greet` param;
(c) its inline recycling implementation **stays** (it can only import the SDK, and its
constants differ for measured reasons) — the TS-side dedup is `watch.ts` adopting
`resilient.ts`, leaving two implementations with a stated boundary instead of three by
accident.

### 3.5 The wire contract gets an artifact

One schema source for the event JSON consumed by both sides as golden vectors — not a
shared codegen framework, just checked-in corpora each side's tests must round-trip
(§2.8 class 3). Same treatment for config TLV, mu-law, and the playout classifier
(whose deliberate C/TS twin stays, per decision D8, but gains shared vectors instead of
parity-by-hand).

---

## 4. Testing: the ladder

Design premise: proof mass moves down the gradient from "flash and read counters over
prd" toward the 4.5s host loop. CF workers and Grok appear **only in L7**; everything
else runs against nothing, or local `pnpm dev` + `local-fake-grok` (settled decision
D15: the test loop is local dev, no bespoke endpoint).

### 4.1 The pyramid

| #   | Lane                                                               | Proves                                                                                                                                                                                                                                                                     | Deps                                 | Runtime       | When                                  |
| --- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------- | ------------------------------------- |
| L0  | Host C unit (exists)                                               | module invariants, ASan/UBSan                                                                                                                                                                                                                                              | none (shallow-clone the capnweb pin) | ~5s           | pre-commit + CI                       |
| L1  | TS unit + **cross-language goldens** (exists + new vectors)        | mu-law/classifier/TLV/event-JSON parity C↔TS                                                                                                                                                                                                                               | none                                 | ~1.5s         | pre-commit + CI                       |
| L2  | **Host-composed device app** (new; unlocked by the §3.3 hoist)     | mount order, capability registration, abandon-funnel ordering, supervision ladder, turn edges, health emitter — the ~1,500×4 lines with zero tests today                                                                                                                   | none                                 | seconds       | pre-commit + CI                       |
| L3a | **C CLI hermetic, sans-network** (new)                             | full transport+voicelab stack over `fake_posix_websocket.c` with canned bridge scripts + checked-in fault schedules: the Wi-Fi outage ladder, the 68s dead-downlink incident, the ~1300-push recycle — incidents become permanent regression tests, `--sealed` bit-for-bit | none                                 | seconds       | CI                                    |
| L3b | **C CLI ↔ local dev ↔ fake Grok** (new; needs W4)                  | the C binary holding a real conversation through the real config-repo worker                                                                                                                                                                                               | pnpm dev                             | ~1 min        | CI                                    |
| L4  | **ESP-IDF compile lane** (new)                                     | all four `idf.py` targets build; emits the CI firmware artifact that has never existed                                                                                                                                                                                     | container                            | minutes       | CI                                    |
| L5  | **Counter-liveness gate** (new, §4.4)                              | every health field has a registered mover                                                                                                                                                                                                                                  | none                                 | seconds       | CI                                    |
| L6  | **Hardware bench** (new, §4.3)                                     | AEC/echo policy per board, zero cloud; smoke conversation vs local dev over the hub, counters read via RPC (never the console port)                                                                                                                                        | hardware + pnpm dev                  | ~10 min/board | nightly + pre-merge for audio changes |
| L7  | End-to-end (exists: `prove`, `sessions` 10/10, `soak`, `pressure`) | the whole product                                                                                                                                                                                                                                                          | CF + Grok + hardware                 | hours         | nightly / pre-release                 |

Standing gate, not a lane: **mutation on review** — one demonstrated killed mutation per
new oracle, plus a periodic sweep over the pure cores. It is what caught every
green-by-construction test so far.

### 4.2 The Mac lane, as work items

- **W4 first — it is verified and tiny.** The bridge already loose-parses `grokBaseUrl`
  from `call-requested` and threads it to the Grok dial (VA:584, :3069, :3320); the C
  client just never sends it (`voicelab_stream.c:1322-1328`). One JSON field + one
  `--grok-base-url` flag = the C binary goes hermetic. Simultaneously flip `talk.ts`
  defaults to local dev + fake Grok with `--prd --real-grok` as the opt-in — today it is
  a prod footgun by default.
- **W1 — the CLI becomes the device app** (keystone; lands with §3.3): `targets/host_cli`
  becomes the fifth board — darwin ops instead of ESP ops — and deletes most of the
  2,245-line reimplementation. After W1 a loop fix proven on the Mac **is** proven on
  ESP, because it is the same translation unit. L2's fakes are the CLI's darwin ops
  minus CoreAudio.
- **W2** — fill the device-profile table (add stackchan/havpe/m5sticks3 rows,
  drift-tested like the waveshare row) so the CLI can wear any board's bounded sizes.
- **W3** — AEC seam on host, honestly scoped: a darwin fake codec with
  `has_reference_channel=true` synthesizing echo as a delayed/attenuated/drifting copy
  of its own playout exercises the **entire shipped chain** (high-pass → scaler → bridge
  cadence → fail-closed silencing → selector policy with a live activity plane — the
  currently-dark switched policy finally executes); a SpeexDSP canceller behind the same
  seam is a numeric stand-in. **This does not prove esp-sr numerics** — that is L6-only.
- **W5** — test `cli_conversation.c` (443 lines every report claim rests on) and the
  health JSON; post-W1, "test main.c" reduces to L2.
- **W6** — check in PCM corpora (the "Hey pal" barge-in corpus exists) under `corpora/`;
  `--mic <corpus> --sealed --fault-schedule <json>` replays incidents bit-for-bit;
  assert report distributions against tolerance bands.
- **W7** — link avatar + overlay + null camera/servo/LED into the host composition so
  the viseme lane and the new overlay/face_wake run on every CI pass; assert
  `faceFrames` moves (this is also the Waveshare phase-3 exit criterion the flash
  denylist stranded).

### 4.3 The hermetic AEC bench (corrected oracles)

Your spec, made concrete: play known speech through the device's own speaker and prove
the uplink is near-silent; then play different known speech from a Mac beside it during
device playback and prove _that_ comes through intelligibly. No CF, no Grok.

**Ingress, two modes sharing all scoring:**

- **Bench-over-stream (primary):** device connects to local `pnpm dev`; a driver script
  on the Mac appends ordinary `spk-frame` events carrying the known clip — entering at
  exactly the seam the network does — and reads `mic-frame` appends off the same stream.
  **Costed honestly (critic):** the device IGNOREs spk-frames for a call it hasn't
  adopted (`audio_playout.c:102-103`), drops uplink when `!talking`, and escalates to
  recycle/restart on silence — so the driver must fabricate `call-accepted` (with a
  bridgeId), answer pings, and keep batch liveness. It is a **partial bridge emulator**
  and must be drift-pinned against the real bridge (a shared conformance vector set),
  or it becomes the third protocol implementation the kill list just removed.
- **Bench-in-flash (fallback, literally zero network):** a ~3s known clip (~48 KB
  mu-law) in DROM; a `bench.run()` RPC plays it through `on_speaker_pcm` and accumulates
  scores into counters surfaced by `health()`. Survives a broken lab Wi-Fi.

**Device-side work items** (from the audio reader's gap list): (B1) a processed-egress
tap so bench mode routes uplink even where the talking-gate discards it today; (B2)
bench-mode enable for the raw/reference planes (HAVPE extracts then discards
`raw_plane`; StackChan's raw branch is unreachable under CONSTANT_PROCESSED); (B3) the
local PCM source at `on_speaker_pcm`; (B4) carry the per-chunk
`playback_content_active` bit into uplink events so the scorer segments automatically.
A bench mode needs one new device-side switch on PTT boards: bypass the `!talking` drop.

**Scoring runs on the Mac.** Never raw energy as a speech oracle (dead-end table: "VAD
firing is spectral, not energetic") — time-aligned normalized cross-correlation against
the known clips, searched over ±250 ms lag, plus a calibrated residual floor (uplink RMS
during playout, in dB above a 500 ms pre-roll room floor). Thresholds are **ratchets**:
first green run's measured value minus margin becomes the gate; improvements re-ratchet.

Per board — four different theorems, matching §1.4:

| Board     | What the bench proves     | Oracle                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| StackChan | esp-sr actually cancels   | ERLE vs the **divider reference** (the one board where echo-path energy is knowable) — divider-era history ran 13–16 dB, DMA-tap prior art 33–50, so the ratchet has headroom; residual ≤ ~6 dB above floor; `aecResets == 0`; `processor_silence_samples == 0` (fail-closed never fired)                                                                                                                                                                         |
| HAVPE     | XMOS output is echo-free  | **No ERLE claim is formable** — the reference is private to the XMOS and mic-side echo energy is unknowable. Honest metrics: NCC of uplink vs played clip (ratchet toward ~0) + residual-above-floor; assert `captureGainClipped` bounded (the ×16 make-up gain)                                                                                                                                                                                                  |
| Waveshare | the _policy_, both halves | PTT not held during playback → uplink frame count **exactly 0** (the `!talking` drop is the whole echo story). PTT held → record NCC/residual as the documented baseline (~0 dB expected) — this number is the standing instrument for the deferred D-AEC decision on the ES8311's unused DAC-in-ADC reference ("cheapest AEC on the table")                                                                                                                      |
| M5StickS3 | the fence                 | **Not** `codec_read` returning UNAVAILABLE — that fires on any empty mailbox and would stay green with the fence deleted (the critic caught this as a fresh green-by-construction oracle). Honest oracle: capture mailbox receives **zero frames** during playback; `audioModeSwitches` equals the scripted count exactly; handoff latency ≤ ~60 ms including the discarded settling frame; first post-handoff frame's NCC vs the played clip ≈ 0 (no tail bleed) |

**Double-talk phase (StackChan + HAVPE only** — the other two are structurally
incapable and the echo phase already proved it): Mac plays a different known clip
beside the device during device playback (`boards.ts`'s air path exists). Metrics: NCC
of uplink vs the far clip against a per-rig calibration (gate = ~70% of a no-playback
capture, since absolute NCC through air varies with placement); local ASR (whisper.cpp,
no cloud) key-phrase match as the metric that catches esp-sr's known failure mode —
ducking that mangles barge-in speech into un-transcribable mush, which correlation
under-penalizes (treat the ASR gate as nightly-informative first; promote to blocking
only after flake data); and a leak check — NCC vs the _device's own_ clip must stay
under the echo-phase gate even during double-talk. This finally measures the
thrice-flagged "double-talk unmeasured" item and gives the CONSTANT_PROCESSED→switched
selector migration its oracle.

### 4.4 The counter-liveness gate (ends the dark-instrument class)

Three clauses plus the tier the critic forced:

1. **Every counter ships with its mover.** A checked-in table maps every health field →
   the test that moves it; a drift test enumerates the emitted health JSON (the emitter
   is already a `{name,value}` pair loop) and fails on any field absent from the table.
   Adding a counter without a mover is a red build. Attach it to the single hoisted
   emitter so it is written once.
2. **Count at detection, never behind the gate.** Failure counters increment in the
   branch that _observes_ the failure, before any escalation gate — the grep-able rule
   that would have caught `capFailed`/`spkFailed` freezing at the threshold.
3. **Must-move/never-move contracts in every endurance lane**: `framesSent`,
   `spkWrites`, `faceFrames`, `last_batch_ms` must advance; `lostFrames`,
   `snapshot_races`, `aecResets`, `processor_silence_samples`, starvation events must
   not. A counter that satisfies neither contract in any lane is dead surface — delete.
4. **A hardware-mover tier.** Hardware-only counters (`aecResets`, `camStarted`,
   `audioModeSwitches`, XMOS fields) cannot have host movers; as written the gate would
   either block CI or breed stub movers — itself a dark-instrument recurrence. Their
   mover of record is the L6 bench, checked nightly, and the table says so explicitly.

### 4.5 Harness consolidation: 21 commands → 9

| Keep (new shape)                                   | Absorbs                                                        | Notes                                                                                                                                |
| -------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `voicelab local`                                   | local, client(fake), kit-cli-proof, new kit-c-proof            | the hermetic lane, in CI                                                                                                             |
| `voicelab talk`                                    | talk, client(live), probe as `talk --text`                     | **defaults local+fake**; `--prd --real-grok` opt-in                                                                                  |
| `voicelab bench`                                   | bench                                                          | push-ceiling instrument                                                                                                              |
| `voicelab devbench`                                | _(new)_ + loudness + boards' air path                          | the L6 bench                                                                                                                         |
| `voicelab device`                                  | device, shot, chronology (`device log`), reveal (`device key`) | board utility                                                                                                                        |
| `voicelab endure --profile soak\|sessions\|stress` | soak, sessions, stress, reliability                            | one endurance harness to keep honest                                                                                                 |
| `voicelab prove`                                   | prove, boards' transcript smoke                                | L7 apex                                                                                                                              |
| `voicelab pressure`                                | pressure                                                       | captun; nightly                                                                                                                      |
| `voicelab deploy` / `wire`                         | deploy, wire                                                   | plumbing (wire stays: hardware may still want the TLS proxy even though the C client speaks plain ws:// — `configuration.c:163-166`) |

Kill: `bridge.ts` (its isolation job is done — the worker bridge is proven and local
`pnpm dev` runs the real worker, so it no longer buys "CF off the path"); `matrix.ts` +
`direct.ts` + `grok.ts` **as a cluster** (direct imports grok; measure the provider
latency floor once more, write the number into a doc, then delete all three); both
`.tmp` scripts; the byte-identical client copies (ownership direction per §5).

---

## 5. Kill list (ordered by value density)

| #   | Item                                                                                                                                                                                                                                                       | LOC out                                | Effort | Risk / note                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Hoist the device.c common core (§3.3)                                                                                                                                                                                                                      | ~4,500 net of ~1,500-2,000 kernel adds | M–L    | needs sign-off; ordering per §6                                                                                             |
| 2   | Dead avatar surface: `face_driver`, producer-less `face_stage` cues, unwired selection RPCs                                                                                                                                                                | ~600                                   | S      | grep-proven zero consumers; sprite-set RPC is wire-or-kill (§7)                                                             |
| 3   | `voicelab_session_ended()` + `feed_watchdog()` APIs                                                                                                                                                                                                        | ~80                                    | S      | deletes 5 struct-poke sites + 4 reach-ins; **do before #1** — it shrinks what the hoist touches                             |
| 4   | Byte-identical TS copies (`resilient.ts`, `rpc-ownership.ts`)                                                                                                                                                                                              | ~300                                   | S      | **kit owns the file**, voicelab imports it (shipped client code must not import from a scripts dir); move the tests with it |
| 5   | Audio machinery dedup: starvation ledger ×4, mailbox adapter ×3, saturating gain ×3                                                                                                                                                                        | ~500                                   | S–M    | plain shared functions, no ops struct needed                                                                                |
| 6   | Voicelab script cull (§4.5)                                                                                                                                                                                                                                | ~1,500+                                | S      | check importers before deleting the direct/grok/matrix cluster                                                              |
| 7   | Duplicate auth chain → one authenticated-project-session                                                                                                                                                                                                   | ~100                                   | S      | one RPC round-trip per generation recovered                                                                                 |
| 8   | Grok vocabulary off-device                                                                                                                                                                                                                                 | ~150 C + bridge change                 | M      | **dual-emit window required** (§6 step 6)                                                                                   |
| 9   | `.tmp` scripts, `greet` param, stale README sections (both)                                                                                                                                                                                                | ~100 + docs                            | S      | doc rot is the flasher-incident class                                                                                       |
| 10  | Hygiene: `alignas(16)` AEC planes, StackChan 32 KB icache + SPIRAM reserve, `overlay_equal` test, `face_wake` static-state ×2, camera-init mid-session stall (measure or move), shallow-clone capnweb in CI, widen boundary regex, un-APPLE portable tests | —                                      | S each | each is a named sharp edge from a reader                                                                                    |

Keep-on-notice: `inject_starvation` (the bench is its natural caller — kill only if the
bench doesn't claim it); inert-but-measured constants (`nlp_level`, raw ×6 gain) whose
comments carry evidence; `fake-grok` vs `local-fake-grok` (disjoint jobs, no merge);
the C/TS playout-classifier twin (decision D8 — add shared vectors, don't merge).

---

## 6. Migration plan

Re-ordered after the critic's attack. Every step ends with all four boards + host CLI
conversational; the fence board hoists **late**, and the only wire break gets a
dual-emit window. Steps 0–2 are risk-free and independent of the sign-off in §3.3.

0. **Land the working tree first, split in three** — otherwise every hoist diff is
   unreviewable: (a) the internal-heap fix as one commit (camera assert + lazy sensor +
   PSRAM framebuffer + heap health fields) plus `boards.ts`, deleting both `.tmp`
   scripts; (b) overlay/face_wake + the four display rewires + test — a real net
   convergence (−374 duplicated lines) — optionally relocating `face_wake` beside
   `face_doze` and overlay/lights to `components/status` first (10-minute moves);
   (c) the device.c strands (park/retry/prepare-ahead/backoffs) — commit with the
   extraction filed as the immediate next task, because it is the 4th+ re-cloning of
   the app loop. Write the missing IMPLEMENTATION-LOG entry.
1. **Safety net.** CI compiles all four IDF targets (espressif container, emits the
   first-ever firmware artifact); un-APPLE the portable tests; promote
   `kit-cli-proof.mts` to CI; **W4** (`grokBaseUrl` + `talk` default flip) — the
   single cheapest step toward hermetic C, verified end-to-end already.
2. **Deletions + doc truth.** Kill-list rows 2, 4, 6, 7, 9; fix both stale READMEs.
   Grep + CI green; one `boards.ts` conversation smoke per board.
3. **Split `voicelab_stream.c`** (§3.2) + ship the two APIs (row 3). Same wire, same
   behavior; `prove` + `sessions` per board.
4. **Hoist the audio pump + HAL helpers** (rows 1-partial, 5): one shared
   playback/capture task pair + abandon funnel; shared ledger/mailbox/gain. The
   counter-liveness gate lands **in the same step** so hoisted instruments cannot go
   dark. Board order: **Waveshare → HAVPE → M5Stick (fence) → StackChan (bridge)** —
   the shared pump is proven on full-duplex boards before it must absorb the
   half-duplex fence contract, and StackChan's bridge variant goes last. Each board
   flashed and conversation-proven before the next starts.
5. **Hoist the supervision ladder + health emitter; shrink device.c** (§3.3), same
   board order. L2 (host-composed device app) becomes possible here.
6. **Vocabulary migration with a dual-emit window.** Bridge emits neutral control
   events _alongside_ `grok-event`; boards reflash one at a time on their own
   schedule; the raw projection is deleted only after the last board confirms.
   Hermetic proof first (`local` + kit-cli-proof), then `prove` on hardware.
7. **Host CLI becomes the kernel** (W1, W2, W5, W7; delete the main.c copy by
   replacement, never by deletion first). The Mac binary is now the daily loop.
8. **The AEC bench** (§4.3, both ingress modes, per-board oracles) + a double-talk
   case in `endure`. The one invariant the architecture stakes itself on finally has
   a number, refreshed nightly, with zero cloud.

---

## 7. Decisions needed from you

1. **The ops-struct sign-off** (§3.3): does a flat board-ops table filled inline in each
   board's root violate the rhyme rule, or is it what the StackChan shim already
   proved acceptable? Everything in §6 steps 4–7 hangs on this. My recommendation:
   accept it, with the constraint that boards keep `main()`, keep storage ownership,
   and the struct stays flat (no nesting, no lifecycle hooks).
2. **Sprite-set RPC: wire or kill.** The remote-provability theme argues wire; a dead
   RPC on the capability surface argues kill. Pick one this PR.
3. **OTA.** Frozen donor offsets vs fleet updatability without a USB cable. Not urgent;
   becomes urgent the day there are more boards than desks.
4. **The ES8311 DAC-in-ADC reference on Waveshare** ("cheapest AEC on the table",
   deferred by D-AEC): the bench's PTT-held baseline is the instrument that keeps this
   decision honest — promote only if that number ever matters.
5. **Doc reconciliation:** fold the recorded StackChan open-mic exception (A2) and the
   flashed-after-all history back into consolidation-plan.md, which still orders the
   opposite; and resume the IMPLEMENTATION-LOG discipline for the working tree.

## 8. Settled decisions this review does not reopen

One lane, `/pcm` retired (Waveshare 10/10 is the anchor) · PTT stays, with StackChan's
recorded open-mic exception · mu-law + base64 in JSON, Opus refused twice with the
reopen trigger written down · the bridge is a Durable Object, never a processor
(hosted processors never receive ephemeral events) · no server pacing — the listener
owns the clock, identity `(callId, answer, frame)` · WebRTC tried and reversed
same-day · visemes server-side, no device fallback (measured bad) · `host_cli` = C
parity/fault rig, TS client = product client, both stay · test loop = local `pnpm dev`,
no bespoke endpoint (D15) · ESP-ADF/GMF refused (seam placement transfers, machinery
does not) · energy gates as speech oracles refused, forever.

## 9. What this report deliberately does not claim (critic's ledger)

- That the M5 fence is provable via `codec_read` returning UNAVAILABLE — that oracle is
  green with the fence deleted; the honest one is in §4.3.
- That a HAVPE ERLE is measurable — no reference exists on the ESP side of the XMOS.
- That the darwin AEC lane proves "the device cannot hear itself" — darwin exercises
  the shipped _chain_ with a stand-in canceller; esp-sr numerics are hardware-only.
- That the device.c hoist is mere transcription — it is a concurrency, placement, and
  diffability change, which is why §7.1 exists.
- That the C client needs the TLS proxy (stale) — or that `wire.ts` is dead (hardware
  may still want it).
- That the bench driver is "just a script" — it is a partial bridge emulator and is
  budgeted and drift-pinned as one (§4.3).
- That ~8,000 lines get deleted — the honest net is ~5,500–6,000 after kernel adds.
