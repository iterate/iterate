# Independent Fable Max review: fastest sound StackChan port — 2026-07-31

Status: independent review, produced without modifying production code. The
review prompt is retained verbatim in
[`fable-stackchan-fast-port-review-prompt-2026-07-31.md`](./fable-stackchan-fast-port-review-prompt-2026-07-31.md).
This document is evidence, not a decision; the primary agent reconciles it via
the checklist in §9.

Tree state reviewed: branch `c-capabilities` at
`360919756bfc028ac4bb5534caf39f98498c9f6c` (“kit: generalize device flash and
provider evidence”), which landed **during** this review and committed the
device-identity/flash/evidence generalization that was uncommitted when the
review started. Still uncommitted at review end: modified
`apps/kit/firmware/CMakeLists.txt`,
`apps/kit/firmware/devices/stackchan/{stackchan.c,include/iterate/kit/devices/stackchan.h}`,
`apps/kit/scripts/prove-production-m5sticks3-grok*.ts`,
`apps/kit/src/firmware/local-idf-build*.ts`; untracked
`apps/kit/firmware/platforms/iterate_core_s3_audio/` (the new
`core_s3_capture_reserve`), `apps/kit/firmware/tests/core_s3_capture_reserve_test.c`,
`apps/kit/firmware/tests/stackchan_control_test.c`,
`apps/kit/scripts/prove-production-grok-from-device.ts`,
`apps/kit/src/device/production-device-proof.{ts,test.ts}`. The tree is moving;
line numbers below are as-read during this review.

Sources read (source-first, not prose-first): the shared core
(`apps/kit/firmware/components/{core,capabilities}`), the ESP-IDF platform layer
(`apps/kit/firmware/platforms/iterate_esp_idf`, including the audited CoreS3 BSP
override), both targets (`targets/m5sticks3`, `targets/stackchan`), the worker
side (`apps/kit/src/userspace/config-worker`, `apps/kit/src/voice`,
`apps/kit/src/device`), the read-only prior-art checkout
`/Users/jonastemplestein/src/github.com/iterate/stackchan/experiments/02-minimal-realtime-aec`
(4 commits at HEAD `2a7aec9`; everything load-bearing is untracked worktree
state belonging to another worker — nothing was modified), and the pinned
vendor sources that actually determine timing/ownership: ESP-IDF **v5.4.2**
(`~/esp/esp-idf`, tag verified), esp-sr **2.4.7**, esp_codec_dev **1.5.11**,
m5stack_core_s3 BSP **3.0.2** (all under
`targets/stackchan/managed_components/`).

---

## 1. Verdict

**The port is one new component away from sound, and most of the plan on file
is right.** The shared core already models full-duplex end to end — the
`ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC` policy exists and its
interruption-keeps-capture ordering is test-pinned
(`components/core/include/iterate/kit/audio.h:15-19`,
`tests/audio_controller_test.c:245-278`); the 128→512→320 cadence adapter
`aec_capture_bridge` is written and host-proven but wired to nothing
(`aec_capture_bridge.h:100-118`; repo-wide grep: tests only); the 320→128
silence-filling renderer `pcm_clock_playback` exists for exactly this board and
is used by zero targets (`pcm_clock_playback.h:18-24`); the audited BSP seam
(TDM RX + IRAM DMA tap + 5×128 DMA + MIC1|2|3) is hash-pinned and
build-verified (`platforms/iterate_esp_idf/idf_overrides/espressif__m5stack_core_s3/`,
commit `75a53ffac`); the worker already routes `/devices/<id>` streams, mounts,
and evidence by authenticated device identity (`config-worker/worker.ts:202-214`,
commit `360919756`); and the new `core_s3_capture_reserve` (ISR→owner 8×8 ms
hand-off) appeared, host-tested, during this review. What does **not** exist is
the CoreS3 duplex audio owner itself, the codec bring-up sequence, the
`esp_aec` adapter, and the target composition (`targets/stackchan/main/main.c`
is a 21-line BSP-link smoke, `main.c:13-21`).

The fastest sound path is therefore **not** “port the Stick target”; it is:
write one `iterate_core_s3_audio` platform component (two small Core-1 tasks +
bring-up + barriers), compose a Stick-shaped `main` around the unchanged
transports, and drive the existing acceptance harness at it. §4 specifies this
concretely. Nothing in the settled architecture needs re-litigating; the Stick’s
suspend/delete half-duplex I2S lifecycle must explicitly **not** be cloned
(`esp_idf_direct_i2s_backend.hpp:429-445` is pin-fence machinery for a board
that shares mic/speaker pins; CoreS3 does not).

Three places where the written plan is contradicted by evidence, all
resolvable by measurement rather than argument (details §6):

1. **AEC mode.** The portability notes and afe-profile decision say start with
   `FD_LOW_COST` (`stackchan-portability-notes-2026-07-31.md` §Adopt-5). The
   only configuration ever proven on this hardware is
   **`AEC_MODE_FD_HIGH_PERF`** (prior art `main/app_config.h:34-35`,
   `main/audio_pipeline.c:810-813`): best ERLE 21.9 dB, ~14.1 ms avg /
   21.5 ms max per 32 ms frame. The one FD*LOW_COST-era run scored ERLE
   1.3 dB (confounded with 37 dB mic-gain clipping) — i.e. FD_LOW_COST is
   \_unproven*, not _disproven_. Bring both up behind the same fixture and let
   the far-end gate pick; do not assume the cheap mode passes.
2. **NLP level.** The notes say `AGGR`. The proven value is `nlp_level = 2`
   (`app_config.h:55`), which the vendor enum maps to **`VERYAGGR`**
   (`esp-sr/include/esp32s3/esp_aec_nlp.h:9-13`: NORMAL=0, AGGR=1, VERYAGGR=2).
   It is runtime-tunable (`aec_set_nlp_level`, `esp_aec.h:134`) — start from
   the proven value, record what passes.
3. **Reference slot index.** The notes say near=slot 0, reference=slot 1
   (§Adopt-1). Prior art _empirically measured_ exactly that
   (`audio_pipeline.c:37-39`, per-slot peak telemetry, 0.375 ms reference lag,
   21.9 dB ERLE — impossible with a wrong reference). But driver-order
   reasoning says otherwise: `es7210` powers MIC1|MIC2|MIC3 and nothing in the
   driver compacts slots by selection
   (`esp_codec_dev/device/es7210/es7210.c:188-236`), which would put MIC2 at
   index 1 and the MIC3 divider at index 2. Both cannot be true as stated.
   The port must treat the slot map as a **boot-validated measurement**, not a
   constant — the new reserve header already demands this
   (`core_s3_capture_reserve.h:17-19` “re-validating the BSP configuration and
   physical slot mapping”), and §5 F4 specifies the instrument.

Must-fix-before-flash items are in §5.1 — the largest is that **the AW88298
64-BCLK register fix exists nowhere in the Kit tree**, and the stock driver
silently reverts that register on every codec open (§5.1 F1).

---

## 2. Ground truth this review verified

### 2.1 Contract surface (already satisfied for a `stackchan` identity)

- Two independent WebSockets; PCM v1 = mono S16LE 16 kHz, one binary WS message
  per exact 640-byte / 320-sample / 20 ms frame; zero-length binary =
  server→device ordered end-of-response; no header, no in-band control
  (`components/core/include/iterate/kit/pcm_websocket.h:13-31`;
  `config-worker/pcm-proxy.ts:1-29`).
- `/pcm` auth = `Authorization: Bearer` + `x-iterate-project-id` +
  `x-iterate-kit-device-id`, subprotocol `iterate.kit.pcm.v1`
  (`config-worker/routes.ts:74-115`, `worker.ts:144-155`); firmware sends
  exactly these (`platforms/iterate_esp_idf/pcm_transport.c:295-316`). Device
  identity is now one shared grammar (`config-worker/device-id.ts:1-11`).
- **Raw non-PCM Grok events already land in `/devices/<deviceId>`**: the stream
  path is derived from the authenticated PCM handshake identity
  (`config-worker/provider-event-stream.ts:5-14`, `worker.ts:209-214`), with
  the required bounds (64 events / 256 KiB pending / 64 KiB per event / batches
  of 8, `provider-event-stream.ts:17-20`) and non-blocking overflow accounting
  (`:87-108,160-196`). A StackChan gets `/devices/stackchan` purely by
  presenting its device id. The evidence readers and proof CLI are
  parameterized by `--device-id` as of `360919756`
  (`src/device/production-grok-cli-options.ts`,
  `production-grok-provider-events.ts:61-95` filters by stream path first).
- Mount contract: device mounts `{"kit","<deviceId>"}` via `/api` direct to OS;
  the worker invokes `["kit", <deviceId>, ...]` children `subscribeToEvents`,
  `subscribeToMetrics`, `changeColour` using the PCM-authenticated id
  (`worker.ts:451-523`, `device-tools.ts:31-38`). The uncommitted
  `devices/stackchan/stackchan.c` profile adds exactly those children plus
  conversation/PTT modules with the Stick’s state rules, keeping PCM/AEC out of
  the profile; `tests/stackchan_control_test.c` pins remote+physical events
  into one owner queue and PTT-gated-on-conversation.
- Flash/provisioning path is device-parameterized as of `360919756`
  (`scripts/flash.ts --device stackchan`; provisioning region read from the
  compiled partition table in `src/firmware/local-idf-build.ts`, removing the
  per-target constant drift risk). `stackchan` exists in the catalog
  (`src/firmware/catalog.ts:119-122`).

### 2.2 Shared-core pieces that are ready and must be reused unchanged

Transport/lane layer (nothing board-specific): `spsc_ring`, `pcm_lane`
(exactly-once emergence both directions, chunked TLS reassembly directly into
ring slots, EOS ordering, producer/consumer fences — `pcm_lane.c:349-486,
556-598`), `pcm_uplink_conductor`/`sender` (epoch discard, freshness 250 ms /
no-progress 500 ms / frame-send 1000 ms — `esp_idf_websocket_policy.h:31-35`),
`websocket_tx/rx` (no client PING by design; PONG-reply only; control frames
never interleave into a partial data frame — `websocket_tx.c:6-70`),
`esp_idf_pcm_transport` (network task Core 0 prio 6; `device_id` already a
parameter — `esp_idf_pcm_transport.h:60-101`), `itx_transport` (Wi-Fi owner,
`WIFI_PS_NONE` — `itx_transport.c:1122-1128`), and the audio controller with
its full-duplex policy:

- Full-duplex start = `start_capture` + CAPTURE_STARTED with playback
  untouched; `interrupt_playback` = `stop_playback`, `flush_playback`,
  INTERRUPTION **with capture left running** (`audio.c:209-273`;
  `audio_controller_test.c:245-278` — the test comment says reusing the PTT
  shutdown here “would stop capture precisely when AEC needs its
  microphone/reference relationship”).
- The board seam is four synchronous callbacks
  (`start_capture/stop_capture/stop_playback/flush_playback`,
  `audio.h:35-41`) plus egress (`send_event`, `send_pcm` with a strict
  one-borrowed-frame completion protocol, `audio.h:43-60`) plus a polled
  capture driver (`audio.h:68-79`).
- Owner-control primitives to reuse verbatim: `SingleOwnerCommandMailbox`
  (typed one-slot; generation fence = nonblocking poll, lifecycle =
  synchronous 1000 ms fail-closed), `PartialPrebufferWakeDeadline`,
  `BoundedEventCounter` (`realtime_owner_control.hpp`, pinned by
  `realtime_owner_control_test.cpp:70-294`).

The two purpose-built but **unwired** CoreS3 pieces:

- `aec_capture_bridge` — caller-owned storage for 3 DSP frames + 1 wire frame;
  `push_aligned(sequence, captured_through_at_us, near, reference, n)` with
  strict +1 sequence (gap ⇒ epoch+processor reset), monotonic µs timestamps,
  synchronous allocation-free `process` contract, fail-closed **silence** on
  processor failure (“never substitutes the raw microphone” —
  `aec_capture_bridge.h:14-27,135-158`; conservation pinned by
  `aec_capture_bridge_test.c:143-373`). Reset policy in the header: reset on
  I2S restart/DMA overflow/codec reconfig; **not** on network reconnect
  (`aec_capture_bridge.h:153-158`).
- `pcm_clock_playback` — 320→any-chunk reframer with silence fill, per-slot
  age purge, bounded stale-scan per render, EOS classification; header names
  CoreS3’s 128-sample cadence as its motivating case
  (`pcm_clock_playback.h:18-39`).
- New during review: `core_s3_capture_reserve` — fixed 8-deep, 8 ms-granule
  ISR→owner ring for the raw 4-slot TDM chunks (1,024 B per callback,
  `core_s3_capture_reserve.h:17-27`), slot extraction deliberately deferred to
  the consumer outside interrupt context (`:73-77`), epoch/poison semantics
  (`:143`), host-tested (`tests/core_s3_capture_reserve_test.c`).

### 2.3 The audited BSP seam (what the override actually provides)

`platforms/iterate_esp_idf/idf_overrides/espressif__m5stack_core_s3/` holds
byte-identical pristine 3.0.2 sources plus a build-time exact-once textual
patch into `iterate_patched/` (`patch_core_s3.cmake:10-28`), SHA256-pinned
inputs (`CMakeLists.txt:17-63`), `override_path` in the target manifest, and a
`verify-bsp-source-selection` gate in ALL
(`targets/stackchan/CMakeLists.txt:23-31`,
`tests/verify_bsp_source_selection.py:27-61`) — this correctly fixes the prior
art’s silently-revertable in-place `managed_components` patch. The patch
provides:

1. IRAM DMA-completion tap for both directions with per-direction sequence
   counters and overflow counters; callback receives
   `(transmit, sequence, completed_at_us, pcm, bytes)` per completed
   **128-sample** descriptor; “no queue policy; the Iterate CoreS3 platform
   installs one bounded ISR consumer and owns all loss handling”
   (`patch_core_s3.cmake:47-133`; seam header
   `include/iterate/kit/platforms/core_s3_bsp_audio.h:16-52`).
2. `iterate_kit_core_s3_audio_init_tdm_rx(tx_std_config, rx_tdm_config)` —
   std TX + TDM RX channels created together on one controller,
   **`dma_desc_num=5, dma_frame_num=128`** (40 ms retained vs the IDF default
   6×240 = 90 ms; “one 32 ms ESP-SR AEC frame and one 8 ms scheduling
   interval, without turning DMA into a speech FIFO” —
   `patch_core_s3.cmake:135-292`).
3. `es7210_cfg.mic_selected = MIC1|MIC2|MIC3` — three mics is what switches
   the ES7210 to TDM on SDOUT1 (`patch_core_s3.cmake:347-369`;
   `es7210.c:16,177-186` `ENABLE_TDM_MAX_NUM 3`).
4. Stats snapshot + tap install/uninstall with release/acquire publication
   (`patch_core_s3.cmake:294-336`).

Today exactly one caller exists: the 21-line link-proof `main.c`. Nothing calls
`init_tdm_rx` or `set_tap` yet.

### 2.4 Vendor facts that bound the design (IDF 5.4.2 / esp-sr 2.4.7 / codec_dev 1.5.11)

- **Standalone AEC**: `aec_create_from_config({mic_num, ref_num, out_num,
filter_length, sample_rate, caps, mode, nlp_level})`; 16 kHz only;
  filter*length 4 recommended; separate **planar** mic/ref pointers
  (`esp_aec.h:39-96`); frame size must be **queried** via
  `aec_get_chunksize()` (`esp_aec.h:58,141`); buffers 16-byte aligned
  (`esp_afe_aec.h:53-54`); memory placement only controllable via `.caps`;
  implementation is a prebuilt lib that **spawns no tasks** (verified `nm`
  over `libesp_audio_processor.a`: no `xTaskCreate*`) — the synchronous
  `aec_capture_bridge` process contract fits it exactly. It has internal
  time-delay estimation (`dios_ssp_aec_tde\*\*`objects present), so small fixed
TX/RX phase offsets are tolerated. **No`model`/srmodels partition is
needed for standalone AEC** (esp-sr `CMakeLists.txt:102-126`wires`srmodels.bin`only for the model-based nets) — the current`partitions.csv` without a model partition is fine until vadnet/wakenet is
  wanted.
- **Duplex clock ownership**: on S3 (HW v2) both channels share BCLK/WS with
  RX forced slave off the TX unit’s internal loopback
  (`esp_driver_i2s/i2s_std.c:114-125`, `i2s_tdm.c:122-136`,
  `hal/esp32s3/.../i2s_ll.h:1096-1099`); the wire geometry is defined by the
  TX slot config (`bclk = rate × total_slot × slot_bits`, `i2s_std.c:39`).
  IDF explicitly does not guarantee TX/RX DMA phase alignment in duplex
  (`i2s_common.h:104-109`) — hence the tap + sequence pairing.
- **How the proven 64-BCLK bus actually arises** (this reconciles the prior
  art with the driver sources): prior art opened the speaker codec dev first
  (channel=1 ⇒ std 2×16 = 32 BCLK) and the mic second (channel=4, TDM 4×16 =
  64 BCLK); `esp_codec_dev`’s data-if then **disabled, widened, and re-enabled
  the TX peer to 2×32-bit slots** to reconcile total bits
  (`platform/audio_codec_data_i2s.c:432-518`, esp. the literal comment “Open
  with 4ch 16bit firstly, then open with 2ch 16bit, need extend slot bits to
  2ch 32bit”; RX set_fs reconfigures the paired TX because “TX is master”,
  `:409-430`). The AW88298 then mis-frames — its power-on `REG06 = 0x3CC8`
  assumes 32 BCLK/frame (“I2SBCK=0 (BCK mode 16\*2)”, `aw88298.c:220-225`) —
  which is exactly why prior art’s read-modify-write-verify of **reg 0x06,
  mask 0x30, value 0x20 (64×fs BCK)** is applied **after both codec opens**
  (`audio_pipeline.c:41-43,174-208,463-474`). Critically, the driver’s
  `aw88298_set_bits_per_sample` clears bits[7:4] of REG06 — including the
  I2SBCK field [5:4] — on every `esp_codec_dev_open`/`set_fs`
  (`aw88298.c:55-75`), so the fix **reverts on every open** and must be
  re-applied afterwards, every time.
- `es7210` traps: open() defaults **all four** analog channels to 30 dB gain
  (`es7210.c:457`) — including the divider/reference input (clipping risk;
  prior art ran near≈25 dB, reference 0 dB); gain masks use **physical mic
  numbering**, not TDM data order (`audio_pipeline.c:446-452`); a record open
  with `channel<=2 && channel_mask==0` in TDM mode silently halves the bit
  setting (`es7210.c:485-488`) — record must open with channel=4.
- `esp_codec_dev_open` is a silent no-op when already open (rate change needs
  close→open, `esp_codec_dev.c:153-156`); TX disable is deferred while RX runs
  (`audio_codec_data_i2s.c:572-595`) — codec close is **not** a playback
  barrier; `i2s_channel_read` surfaces data only at DMA-buffer EOF and drops
  oldest on queue overflow (`i2s_common.c:334,581-612`) — the tap, not
  blocking reads, is the capture authority (consistent with the settled
  Adopt-3 fact).

### 2.5 Prior-art proven numbers — and the exact boundary of what is proven

From the read-only checkout (untracked state; if that worktree is lost, the
proven firmware is lost — the facts below are the durable copy). `R` below
abbreviates
`/Users/jonastemplestein/src/github.com/iterate/stackchan/experiments/02-minimal-realtime-aec`;
prior-art source citations without a leading path (e.g. `audio_pipeline.c`,
`app_config.h`, `realtime_client.c`) are under `R/firmware-ws/main/`, and the
patched vendor copies under `R/firmware-ws/managed_components/`:

- Best confirmed AEC: **ERLE 21.9 dB**, correlation-leakage −57.2 dB, spectral
  leakage −32.8 dB, clean clipping 0%, at mic gain 25 dB / NLP 2 / reference
  offset 0 ms (`R/local/aec-runs/20260729-dma-tap-repeat-1/best/report.json`).
  Other passes 13.2–16.4 dB. Convergence ≤ ~0.6–0.75 s. Hardware reference
  lag **0.375 ms** with DMA-pair timing; tuned software reference delay = 0.
- AEC cost (FD_HIGH_PERF): 14.087 ms avg / 21.5 ms max per 32 ms frame
  (~44% of one core avg), requiring `COMPILER_OPTIMIZATION_PERF` and
  64 KB/64 B data cache (`R/firmware-ws/sdkconfig.defaults:27-39`); AEC state
  in PSRAM via `.caps = MALLOC_CAP_SPIRAM|8BIT` (`audio_pipeline.c:803-817`);
  all PCM frame buffers 16-byte-aligned internal
  (`audio_pipeline.c:167-172,849-856`).
- Timing architecture proven: completed TX+RX DMA descriptors as the only
  timing authority; 8-deep ISR tap queues (8 ms granules); sequence pairing
  with skip-older-on-mismatch; 743 pairs / 0 drops / 0 skips / 0 overflows in
  the best run (`audio_pipeline.c:486-614`, `tuning.json`).
- Live full-duplex: 5 real Grok turns with **server VAD** start/stop on the
  physical device, binary PCM both directions
  (`R/firmware-ws/local/live-trials/20260729T-current-uplink12/events.jsonl`,
  169 events) — barge-in-grade suppression is achievable with FD_HIGH_PERF.
- **Not proven anywhere**: on-device near-end and double-talk captures (every
  `suite.json` contains only `"far"`), and the semantic echo-erasure gate — in
  every tuning run the AEC-clean channel still transcribed the far-end
  sentence (similarity 0.96–1.0 vs the 0.25 gate;
  `accepted_and_left_active: false`). Energy-domain ERLE ≥12 dB does **not**
  imply ASR-proof echo removal. The Kit gates
  (`stackchan-portability-notes-2026-07-31.md` §Physical-acceptance-4) are
  energy/correlation gates and are achievable; do not silently add a semantic
  gate, and do not claim semantic erasure.
- Init-order facts a port must copy: I2C → channels (std TX + TDM RX created
  together, callbacks registered before enable) → speaker codec init (this is
  what powers AXP2101 ALDO rails + AW9523 amp enable; mic-only init talks I2C
  to an unpowered ES7210 — `m5stack_core_s3.c:129-163,335-407`) → mic codec
  init → opens → **REG06 fix** → per-channel gains; RX runs from codec open,
  so **2 priming frames** must be drained or the mic permanently trails
  playback (`audio_pipeline.c:622-636`); the TX tap delivers 128 mono samples
  (256 B) despite the stereo slot config — size-validate and count, don’t
  assume (`audio_pipeline.c:497-503`).
- Prior-art behaviors that are already on the reject list and stay there
  (12 s + 4 s FIFOs, drop-newest clean uplink, 5 s blocking sends on the
  control task, per-frame heap, portMAX_DELAY mutex on the audio path, HTTP
  diagnostics server): confirmed present in the prior art
  (`realtime_client.c:39-42,271-273,501-503,654-709`;
  `audio_pipeline.c:643,737,744-747`) and all structurally excluded by the
  bounded Kit lane — nothing new to add to the reject list.

---

## 3. What is genuinely missing (the gap list)

1. **`platforms/iterate_core_s3_audio` owner(s)** — only the capture reserve
   exists. Missing: the Core-1 task(s) that install the tap, drain the
   reserve, pair TX/RX chunks, run AEC through `aec_capture_bridge`, submit
   uplink to the lane, render downlink via `pcm_clock_playback` into
   `i2s_channel_write`, execute the downlink generation barrier, and expose a
   metrics snapshot.
2. **The bring-up sequence** (§4 step 1) — nobody has written the
   channel-init + rails + opens + REG06 + gains + priming order in Kit code.
3. **`esp_aec` adapter** — an `iterate_kit_aec_process_fn` wrapping
   `aec_create_from_config`/`aec_process`, with `.caps` placement policy and
   `aec_get_chunksize()` feeding the bridge’s DSP frame size. Nothing in the
   tree touches esp-sr headers yet.
4. **Target composition** — a Stick-shaped `main` for stackchan (rings, device
   profile, both transports with `device_id "stackchan"`, mount
   `{"kit","stackchan"}`, conversation-gated PCM lifecycle, 10 ms owner loop),
   plus CMake wiring: `devices/stackchan` needs an IDF component CMakeLists;
   `targets/stackchan/CMakeLists.txt` EXTRA_COMPONENT_DIRS and
   `main/CMakeLists.txt` REQUIRES currently include neither the device profile
   nor `iterate_core_s3_audio` (`targets/stackchan/CMakeLists.txt:6-12`,
   `main/CMakeLists.txt:4-6`).
5. **Realtime ELF audit for the stackchan target** — the Stick has
   `audit_m5sticks3_realtime_elf.cmake` in ALL; stackchan has only the BSP
   verifier, and its own sdkconfig comments promise the audit before physical
   acceptance (`targets/stackchan/sdkconfig.defaults:43-45`).
6. **Worker-side turn policy for continuous uplink** (§5.2 A1) and the local
   bridge’s server-vad downlink latch (§5.2 A2).

---

## 4. Shortest clean implementation path (proposal)

The steps are ordered so every flash has a falsifiable physical gate, matching
the acceptance order already recorded in the portability notes.

### Step 0 (parallel, no firmware dependency): decide the turn policy

Full-duplex + provider VAD requires a deliberate worker decision because the
production session hardcodes `turn_detection: {type: null}` with a comment
saying re-enabling VAD requires redesigning the two-button contract
(`config-worker/providers.ts:183-204`), and `inputStarted()` never sends
`input_audio_buffer.clear` (`config-worker/pcm-proxy.ts:298-324`). A
continuously-streaming device under the current manual-turn contract commits
**its own speaker echo plus all room audio since the previous commit** as the
next turn. Recommended v1: a per-session input-mode selected by device profile
(stackchan ⇒ `server_vad`, per the settled goal decision “VAD devices
configure `server_vad`” — `physical-device-voice-goal.md` §Audio), with the
worker mapping provider speech-started events to the same discard path
`inputStarted()` uses today, and sending the zero-length end-marker after
purge (mechanism already exists for interrupted `response.done`,
`pcm-proxy.ts:469-481`). Device-side stale tail is then bounded by the 8-frame
/160 ms lead — acceptable v1; a device-local flush trigger is follow-up (§5.3).

### Step 1: codec bring-up + slot-map/64-BCLK proof (first flash)

Extend `targets/stackchan/main` (still a probe, not yet the product main) to:

1. `bsp_i2c_init` → `iterate_kit_core_s3_audio_init_tdm_rx(tx_std_cfg,
rx_tdm_cfg)` — 16 kHz, MCLK 256×fs; RX TDM slots 0-3, 16-bit; TX std
   Philips. Add the geometry assertion of §5.1 F2.
2. `bsp_audio_codec_speaker_init()` (powers ALDO1/2/3 + AW9523 amp enable) →
   `bsp_audio_codec_microphone_init()` → `esp_codec_dev_open(play, {16 k,
16-bit, mono})` → `esp_codec_dev_open(record, {16 k, 16-bit, channel=4,
full mask})`.
3. **`iterate_kit_aw88298_enter_64bclk()`**: RMW-verify reg 0x06 mask 0x30 →
   0x20 via `esp_codec_dev_write_reg`, executed after _every_ open/set_fs
   (§5.1 F1).
4. Set per-channel ES7210 gains (near 25 dB, reference 0 dB) using physical
   mic numbering; drain 2 priming RX frames.
5. Install the tap → reserve; run the slot-map instrument (§5.1 F4): play a
   deterministic tone from a static buffer while logging per-slot one-second
   peaks + tap/pair/skip/overflow counters.

Physical gate (= portability-notes step 2): Mac hears the tone (64-BCLK
speaker operation proven); per-slot peaks unambiguously identify the near mic
slot (responds to `say`) and the reference slot (tracks the tone, silent when
TX silent); counters advance with zero overflow. Retain the log as evidence.

### Step 2: the CoreS3 duplex audio owner (the one new component)

Two small Core-1 tasks plus the ISR tap — this is the shape the portability
notes already settled (“The highest-priority audio-I/O path only services DMA
and publishes fixed-size completed chunks. One DSP owner pairs chunks,
assembles exactly one processor frame, runs AEC, and publishes only current
clean PCM” — §Adapt), and it matches the evidence doc’s preferred create-once
/dedicated-writer direction (`audio-streaming-problem-and-evidence-2026-07-30.md:1000-1021`).
The “single duplex audio task” sentence there is anti-Stick-lifecycle, not
anti-split; do not clone the Stick’s suspend/delete fence either way.

- **ISR tap (both directions)**: size-validate, copy into
  `core_s3_capture_reserve` (RX raw 4-slot chunk) and a mirror TX-reference
  reserve entry (128 mono samples), stamp `completed_at_us` + sequence, wake
  the DSP owner. Everything IRAM-audited (§5.1 F5). The TX tap is the
  reference source — it is what physically left DMA, which is stronger than
  tapping the writer’s input.
- **Playback writer task, Core 1, prio 19** (mirror the Stick owner’s slot):
  create-once channel; consume 20 ms lane frames through `pcm_clock_playback`
  (128-sample renders) into blocking `i2s_channel_write`; the driver DMA queue
  (5×128 = 40 ms) is the only synchronization; underrun = renderer silence
  fill + counter (auto-clear covers the DMA tail). Owns the
  `downlink_generation_barrier` execution: fence = discard lane downlink +
  reset renderer partial state + count, **no channel teardown, no codec
  close** (codec close doesn’t even stop TX while RX runs —
  `audio_codec_data_i2s.c:572-595`). Wired to `downlink_ready` →
  `xTaskNotifyGive` exactly like the Stick
  (`esp_idf_pcm_transport.h:88-100`).
- **DSP owner task, Core 1, prio 17–18** (below the writer, above everything
  else on Core 1): drain reserve → pair TX/RX by sequence (skip older on
  mismatch, count) → de-interleave near/ref using the **boot-validated** slot
  indices → `aec_capture_bridge_push_aligned` → bridge egress copies exact
  320-sample frames → submit to lane (`..._submit_uplink_at` with ms
  timestamps from the same monotonic clock the transport uses — §5.1 F9) →
  `notify_uplink`. Owns AEC lifecycle (create at conversation start, reset per
  bridge policy) and the metrics snapshot. Worst-case AEC (21.5 ms) never
  blocks TX refill because the writer preempts.
- **Capture gating**: the audio controller keeps lifecycle authority
  (`FULL_DUPLEX_AEC` mode); `start_capture`/`stop_capture` toggle an atomic
  the DSP owner honors; `stop_playback`/`flush_playback` post the fence to the
  writer. The controller’s polled `capture_driver` seam and the async
  `send_pcm` completion protocol are both bypassed (the bridge egress is a
  synchronous copy) — record that decision in the component header rather than
  routing CoreS3 audio through a poll shim that fits neither the tap nor the
  bridge. (The controller’s async completion machinery is already vestigial in
  practice: the only real implementation completes synchronously,
  `targets/m5sticks3/main/main.cpp:423`.)
- **Failure posture**: reserve/tap overflow ⇒ counted drop of oldest (never
  block ISR); pairing loss ⇒ counted skip; sustained loss ⇒ bridge sequence
  gap ⇒ epoch+AEC reset (already the bridge contract); downlink ring full ⇒
  transport reconnect (existing `pcm_transport.c:347-366` policy). No new
  queue anywhere; the only new storage is the two fixed reserves + bridge
  workspace + renderer state.

Host tests before flashing: an owner host-rig test driving fake tap events
through reserve→pair→bridge with a stub processor (assert conservation,
epoch resets, slot extraction), and a writer test against the existing
`pcm_clock_playback` + fake lane (fence mid-response, EOS, silence fill).
The mailbox/deadline primitives come from `realtime_owner_control.hpp`
unchanged.

### Step 3: deterministic full-duplex loopback through the local userspace `/pcm`

Same bridge and tone/PRBS providers the Stick used
(`src/voice/deterministic-pcm-*.ts`), now with capture running throughout:
device plays N deterministic downlink frames while continuously uplinking
clean frames. Gates: exact downlink conservation (accepted = submitted =
completed, zero drops/flushes), continuous uplink cadence (50 frames/s ±
bounded jitter, zero reserve/pair losses), Mac-oracle tone continuity, and an
automatic network-validity verdict — all existing harness machinery, now
pointed at `--device-id stackchan`. This is portability-notes step 3 and needs
§5.2 A2 fixed first if any server-vad-mode text turns are used.

### Step 4: measured AEC (portability-notes step 4)

Evidence path without any USB diagnostics protocol (§6.8): bounded PSRAM
three-channel capture pulled over Cap'n Web + host analysis with self-test
fixtures. Runs: far-end only (device plays deterministic speech-shaped
signal), near-end only (Mac `say`, device TX silent), double-talk. Gates
exactly as recorded: ERLE ≥12 dB after 750 ms, correlation and transfer-gain
reduction ≥6 dB, near-end attenuation no worse than 8 dB, raw/clean
similarity ≥0.80, clipping ≤0.1%.

### Step 5: live Grok full-duplex + barge-in, then the deployed worker

Local bridge first (server-vad mode exists there), then the production worker
with the Step-0 policy: audible replies, spoken barge-in with bounded flush,
`/devices/stackchan` stream readback for the raw event evidence, zero
unexplained counter drift, network-valid interval. Power the Stick down for
every StackChan acoustic run (single active PCM session per project —
`worker.ts:79,191-196` — and the boards can hear each other,
`physical-device-voice-goal.md` §Performance).

### Deletions and refusals that keep the path short

- **Do not port** `RealtimePlayback`/`DirectI2sStereoOutput`/
  `EspIdfDirectI2sBackend` (~3,260 lines of Stick-specific
  descriptor-identity + pin-fence machinery) to CoreS3. The writer +
  `pcm_clock_playback` replaces all of it on this board. This also finally
  gives `pcm_clock_playback` its first real consumer; if instead the C++
  stack were ported, `pcm_clock_playback` should be deleted — the repo
  currently compiles two competing playback stacks with one used by zero
  targets, and carrying both forward unwired is the worst outcome.
- Exclude `voicelab_stream` (waveshare-probe-only) and `runtime_diagnostics`
  (no target uses it; its snapshot schema hardcodes assumptions) from the
  stackchan link, or gate them out of `components/core` for device builds.
- Remove (or at minimum never call) the untimestamped lane entry points
  `iterate_kit_pcm_lane_receive_downlink`/`downlink_acquire` — they stamp
  `received_at_ms = 0`, which makes every frame look infinitely stale to the
  age-purging renderer (`pcm_lane.c:330-347,488-495`).
- No second state machine for full-duplex (use `FULL_DUPLEX_AEC`), no
  esp_websocket_client, no ADF, no Opus, no seekaudio engine, no HTTP
  diagnostics server on-device, no firmware USB/JTAG diagnostics writer, no
  ISR-pull renderer unless the writer measurably misses deadlines — all
  previously settled; nothing found in this review justifies reopening any of
  them.

---

## 5. Defect ledger

### 5.1 Must fix before first flash (F1–F9)

The bar: anything that would make the first physical audio result untrustworthy
or unobservable.

- **F1 — The AW88298 64-BCLK fix does not exist in Kit, and it self-reverts.**
  Repo-wide grep finds no writer of AW88298 reg 0x06 outside the pristine
  vendor copies. The stock driver powers on in 32-BCLK mode
  (`aw88298.c:220-225`) and `aw88298_set_bits_per_sample` clears the I2SBCK
  field on every open/set_fs (`aw88298.c:55-75`). Required: an
  RMW-verify helper (mask 0x30 → 0x20) invoked after **every**
  `esp_codec_dev_open`/`set_fs` of the speaker path, with the verify failure
  latched and visible. Without this the speaker is silent or garbled under the
  4-slot TDM bus and the whole Step-1 gate is unfalsifiable.
- **F2 — Clock geometry is unasserted on a one-bus board.**
  `iterate_kit_audio_init_channels` validates only pointer-ness
  (`patch_core_s3.cmake` replacement, arg checks) and will accept a TX/RX pair
  whose frame geometries disagree; the wire follows the TX channel
  (`i2s_std.c:39,104`) and `esp_codec_dev`’s open-time reconfiguration can
  change it again (`audio_codec_data_i2s.c:409-518`). Required: after the
  final codec open, assert/log the effective geometry (16 kHz, 64
  BCLK/frame both directions) and fail loudly on mismatch; document in the
  seam header that codec-dev opens, not `init_tdm_rx`, finalize the wire.
- **F3 — Init-order silent no-op.** The preserved idempotency guard
  (`if (i2s_tx_chan && i2s_rx_chan) return ESP_OK;`) means any earlier
  `bsp_audio_codec_*_init()` (which self-init via plain `bsp_audio_init`)
  causes the later `init_tdm_rx` to return **ESP_OK having configured std
  mono 22.05 kHz with no reference channel** — precisely the silent
  misconfiguration class the link-time verifier was built to kill, reappearing
  at runtime. Required: return `ESP_ERR_INVALID_STATE` on mode mismatch (a
  one-line patch-text change) and enforce bring-up order TDM-init →
  speaker-init (rails) → mic-init (mic-only init would address an unpowered
  ES7210 — `m5stack_core_s3.c:129-163,375-407`).
- **F4 — Slot map must be measured, not assumed** (§1 item 3). Required at
  bring-up (and cheap to keep permanently): per-slot one-second peak counters
  from the reserve consumer + a boot-time validation mode that plays a known
  tone and requires (a) reference slot correlates with TX, (b) near slot
  responds to room audio, (c) remaining slots are quiet; refuse to start AEC
  on ambiguity. Also set the reference channel’s analog gain explicitly
  (open() defaults all channels to 30 dB, `es7210.c:457`; the divider input
  clipping would corrupt the reference invisibly) using **physical** mic
  numbering for the mask (`audio_pipeline.c:446-452`).
- **F5 — No realtime ELF audit for the stackchan target.** The tap ISR now
  runs a 1 KiB memcpy + CAS counters in interrupt context by design
  (`core_s3_capture_reserve.h:73-77`); with `CONFIG_I2S_ISR_IRAM_SAFE` these
  run with flash cache disabled. Port the Stick’s post-link audit
  (`targets/m5sticks3/CMakeLists.txt:22-35`) to the stackchan ELF before any
  physical claim; the target’s own sdkconfig comment already promises this
  (`targets/stackchan/sdkconfig.defaults:43-45`).
- **F6 — Record open geometry.** Open the ES7210 codec dev with `channel=4`
  (or an explicit mask): the driver’s 2-channel TDM fetch path silently halves
  bit settings (`es7210.c:485-488`) and changes capture geometry.
- **F7 — AEC engine selection must follow the fixture, not the note.** Bring
  up `FD_HIGH_PERF` (proven: 21.9 dB, 44%/core) and `FD_LOW_COST`
  (unproven) behind the same far-end fixture; pick by measured gate margin
  vs CPU budget; record the choice and the NLP level actually used
  (proven start: `VERYAGGR`). Query `aec_get_chunksize()` — never hardcode
  512 (`esp_aec.h:58`; bridge takes it as a parameter).
- **F8 — Tap uninstall race.** `set_tap(NULL)` clears the callback
  (release) then user_data (relaxed) (`patch_core_s3.cmake:326-329`); an
  in-flight ISR can observe old-callback/new-userdata. Either quiesce DMA
  before uninstall or make the consumer tolerate a NULL context; document in
  the seam header.
- **F9 — One monotonic clock.** The conductor latches FAILED (fatal, sticky —
  `pcm_transport.c:254-259,626,845-848`) on any owner clock regression; the
  DSP owner must derive lane timestamps from the same `esp_timer` source as
  the transport (µs→ms division in one place), never from a second clock.
  While in the area: the fatal latch’s invisibility is a known production
  defect (reconnect review §0.1-0.2) — the port at minimum must surface
  `fatal_failure_latched` in the stackchan metrics snapshot so a latched lane
  is distinguishable from silence.

### 5.2 Must fix before acceptance can be claimed (A1–A6)

- **A1 — Worker turn/echo policy** (Step 0). Without server VAD (or
  `input_audio_buffer.clear` at turn start, or device-VAD-synthesized edges),
  every StackChan turn includes committed playback echo and stale room audio
  (`providers.ts:183-204`; `pcm-proxy.ts:298-324`). Barge-in currently exists
  only as a PTT-edge (`device-events.ts` → `inputStarted()`); a provider-VAD
  session needs the worker to translate provider speech-start into the same
  cancel+purge and an end-marker to the device. Also review the fatal
  10,240-byte uplink egress cap under continuous 32 KB/s uplink: any
  > 320 ms provider-egress stall now kills the session
  > (`worker.ts:33`, `pcm-proxy.ts:388-396`) — previously masked by PTT duty
  > cycle.
- **A2 — Local bridge server-vad downlink latch** (verified in source during
  this review): `#suppressDownlink` is set by `requestTextResponse`
  (`device-pcm-proxy.ts:531`) but its only clear lives in the
  `push-to-talk` branch of `response.created` handling (`:671-677`); in
  `server-vad` mode (`:279-284`) one text-prompted turn blackholes all
  subsequent downlink audio (`:711`). The deterministic and live local
  acceptance runs for StackChan go through this bridge; fix (clear on
  `response.created` regardless of input mode, or scope suppression to the
  cancelled response) with a red test before Step 3/5 runs use text turns.
- **A3 — Session exclusivity + acoustic isolation.** One `#activePcm` per
  project (a StackChan `/pcm` connect evicts a live Stick session with 4001,
  `worker.ts:79,191-196`) and one project-wide `kit-pcm-mode` key
  (`worker.ts:32`). For acceptance: run one device, power the other down
  (also required acoustically). Multi-device coexistence is real follow-up
  work, not a flag.
- **A4 — Provider tool surface is Stick-shaped.** The session offers exactly
  one `changeColour` tool whose description hardcodes the M5StickS3 display
  (`providers.ts:189-203`), and `executeKitDeviceTool` rejects other names
  (`device-tools.ts:27-29`). Fine for the audio slice; either parameterize
  the description by device or accept the oddity knowingly in evidence.
- **A5 — Downlink barrier semantics on a never-torn-down channel.** The
  barrier’s contract (“OK promises old hardware playback can no longer
  occur”, `esp_idf_pcm_transport.h:76-92`) must be satisfied by
  drain+discard+renderer-reset, not channel deletion (the BSP has no deinit
  path; TX disable defers while RX runs). Pin this with a host test around
  `pcm_clock_playback` + writer fence before flashing interruption runs.
- **A6 — AEC reset wiring.** Route resets per the bridge header: codec/I2S
  reconfig and DMA overflow reset the processor+epoch; network reconnect must
  **not** (`aec_capture_bridge.h:153-158`); conversation start is a
  capture-session edge that resets the reference ring (v2 D3). The reserve’s
  epoch/poison path exists — connect it, and count every reset by cause.

### 5.3 Follow-up (not blocking this slice)

- Near-end/double-talk gates: prior art never captured them on-device; expect
  the near-end similarity ≥0.80 gate to need mic-gain/NLP iteration, and keep
  the semantic-transcription result informational (never a silent gate).
- Device-local barge-in flush trigger (WebRTC VAD “UI edges” from v2 plan) to
  shrink the bounded 160 ms stale tail after provider-VAD interruptions.
- Inherited platform defects tracked elsewhere and unchanged by this port:
  sticky fatal latch escalation (Option A plan), Wi-Fi double-defer ladder +
  30 s watchdog hole + Wi-Fi-blind PCM retry gate (reconnect review §0.5),
  PCM-start-gated-on-control-READY, 10 ms downlink discovery tick, worker
  subscription re-subscribe strand. The port must not _widen_ any of them
  (the stackchan owner adds no new dependence on control-plane liveness).
- Multi-device PCM coexistence per project; promoting device events/metrics
  from `wouldPostToStream` logs to durable streams if acceptance evidence
  wants them.
- PSRAM discipline: `FREERTOS_TASK_CREATE_ALLOW_EXT_MEM` is enabled
  board-wide with only a comment constraining use
  (`targets/stackchan/sdkconfig.defaults:13-16`); keep all audio task stacks
  internal (prior art ran its DSP task on a PSRAM stack — do not copy), and
  extend the ELF audit if a static check is cheap.
- `ITERATE_KIT_VOICELAB_FRAME_BYTES` duplicates the PCM v1 frame constant
  (`voicelab_stream.h:14-21`); fold or static-assert equality when next
  touching that file.

---

## 6. Dimension review (the prompt’s explicit checklist)

### 6.1 Direct-DMA cadence — sound, with one addition

5 descriptors × 128 samples (8 ms) per direction, tap on completed
descriptors, 8-deep reserve (64 ms) — proven numbers (0 overflows over the
best run) and the right shape: DMA never becomes a speech FIFO (40 ms
retained), and the 8 ms granule feeds both the 32 ms AEC frame and the 20 ms
wire frame without either being baked into the driver layer. Addition: keep
the prior art’s explicit ISR size validation (TX 256 B mono / RX 1,024 B
4-slot) as counters — geometry drift then shows up as a counted mismatch, not
corruption (`audio_pipeline.c:497-503` precedent). Verify `auto_clear` is set
on the TX channel in the override init (pristine BSP sets it;
`m5stack_core_s3_idf5.c:51-53`) so underrun is silence, never replay.

### 6.2 Task/core/priority ownership

Proposed map (rationale in §4 step 2):

| Task                    | Core         | Prio | Role                                                                          |
| ----------------------- | ------------ | ---- | ----------------------------------------------------------------------------- |
| I2S tap (ISR)           | 1 (DMA intr) | —    | validate, copy to reserves, stamp, wake DSP                                   |
| `iterate_audio_writer`  | 1            | 19   | blocking 128-sample I2S writes from `pcm_clock_playback`; fence executor      |
| `iterate_audio_dsp`     | 1            | 17   | pair → AEC (≤21.5 ms) → bridge → lane uplink; AEC lifecycle; metrics snapshot |
| `iterate-pcm-net`       | 0            | 6    | unchanged (`esp_idf_websocket_policy.h:29-30`)                                |
| `iterate-net` (control) | 0            | 5    | unchanged                                                                     |
| main/app loop           | 0            | 1    | buttons, device poll, transports reconcile, metrics — unchanged pattern       |

Audio work is entirely on Core 1 (nothing else runs there); network stays on
Core 0; the compile-time PCM>control priority proof stays. AEC’s worst frame
cannot delay TX refill (writer preempts DSP). This is also the D2/R1 fix by
construction: capture finally has a real owner clocked by DMA completion, not
the 10 ms main-loop tick that is the Stick’s known “capture priority orphan”.

### 6.3 Bounded queues end-to-end (StackChan datapath)

| Stage              | Bound                                     | Overflow policy                                                          |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------------------ |
| RX DMA             | 5×128 (40 ms)                             | driver drops oldest + tap overflow counter                               |
| capture reserve    | 8×8 ms                                    | counted drop-oldest, epoch poison                                        |
| TX-ref reserve     | 8×8 ms                                    | same                                                                     |
| bridge workspace   | 3 DSP frames + 1 wire frame, caller-owned | conservation-counted discard                                             |
| uplink lane        | 32×20 ms (640 ms)                         | drop-newest + epoch reset request (`pcm_lane.h:113-122`)                 |
| sender             | 1 retained frame                          | freshness 250 ms / no-progress 500 ms / frame-send 1000 ms               |
| downlink lane      | 32×20 ms                                  | producer backpressure ⇒ generation reconnect (`pcm_transport.c:347-366`) |
| renderer           | 1 partial wire frame                      | age purge per slot; silence fill                                         |
| TX DMA             | 5×128 (40 ms)                             | auto-clear silence                                                       |
| worker reservoir   | 400×20 ms (8 s)                           | terminal close 4000 (`pcm-proxy.ts:685-700`)                             |
| worker→device lead | 8×20 ms then 20 ms grid                   | grid restart, never catch-up burst (`pcm-proxy.ts:1011-1019`)            |

No seconds-long queue exists anywhere on the device; every stage has a named
counter; the only multi-second store is the worker’s reservoir, which is
generation-scoped and purged on interruption/detach (`pcm-proxy.ts:886-903`).
This satisfies the prompt’s freshness requirement structurally: after outage
or overload, recovery is epoch/generation reset to current audio at every
layer.

### 6.4 Capture/reference alignment

Clock-synchronous by construction (one I2S bus; hardware divider reference),
sequence-paired at DMA-completion granularity, skip-older-on-mismatch,
measured 0.375 ms residual lag handled inside the AEC’s internal TDE, and
alignment loss is a counted event that degrades to bridge epoch reset — no
timestamps are trusted that the hardware didn’t produce. Two conditions
guard it: F4 (slot identity measured at boot) and the bridge’s same-completion
requirement (`aec_capture_bridge.h:139-141`) — the tap delivers TX and RX in
separate callbacks, so the pairing step (sequence equality) is the alignment
proof, exactly as prior art did it (`audio_pipeline.c:559-608`).

### 6.5 AEC reset semantics

Bridge-owned and already specified: +1 sequence discipline; gap ⇒ epoch +
processor reset; monotonic-timestamp violation ⇒ chunk rejected without state
drift; processor failure ⇒ auditable silence, never raw mic; resets on I2S
restart/DMA overflow/codec reconfig; **no reset on network reconnect** —
reconnect purges transport state only, preserving filter convergence
(`aec_capture_bridge.h:135-158`). Add (A6): conversation-start session edge
resets the reference ring; count resets by cause in the snapshot.

### 6.6 Interruption semantics

Device-initiated (physical/remote event): existing controller ordering —
`stop_playback`, `flush_playback`, INTERRUPTION event, capture keeps running
(`audio.c:236-273`); writer executes fence (drain + discard + renderer reset);
worker discards its queue on `inputStarted` and cancels an observed response
(`pcm-proxy.ts:298-324`). Provider-VAD-initiated: requires A1; device-side
tail bounded to the 160 ms lead. Accounting: `suspendedFramesFlushed`-style
counters do not apply (no suspend on CoreS3); instead the fence path uses the
lane discard counters + `generationFramesFlushed` equivalents in the writer
snapshot. The device acknowledges nothing on the wire — fences are proven by
counters plus the acoustic oracle, as on the Stick.

### 6.7 Observable failure metrics

Extend the 1 Hz target snapshot (existing `subscribeToMetrics` machinery) with
the StackChan audio section: tap events/overflows per direction, reserve
depth/high-water/drops, pair count + sequence skips, AEC µs avg/max +
over-budget count (CPU-only, excluding DMA wait — prior art conflated them,
`audio_pipeline.c:694-757`), per-slot peak levels (the standing slot-map
sentinel), clean-uplink frames, renderer silence insertions + age purges,
fence executions + acknowledgement timeouts, AEC resets by cause,
`fatal_failure_latched`, heap floors (internal + PSRAM separately), and both
audio task stack floors. All fixed-cost counters in the existing coherent
snapshot pattern; nothing logs from the audio path.

### 6.8 Falsifiable AEC measurement without a USB diagnostics protocol

The prior art proved the methodology but delivered it over an on-device HTTP
server — which Kit correctly forbids alongside firmware USB writers
(`physical-device-voice-goal.md` §observability). The Kit-shaped equivalent,
sanctioned by the portability notes (“a synchronized capture may use bounded
PSRAM and be pulled by a test capability”):

1. A bounded PSRAM three-channel ring (raw near / hardware reference /
   AEC-clean from the **same DSP frame**, written by the DSP owner — the same
   task that runs AEC, exactly as prior art required to expose timing bugs,
   `aec-validation.md:7-19`). 10 s ≈ 960 KB of the 8 MB PSRAM; armed and
   pulled, never streamed.
2. A test-only Cap'n Web capability on the stackchan target: `armAecCapture`,
   `aecCaptureStatus`, and chunked `readAecCapture` (the bounded-chunk photo
   pattern from the goal doc); pulls happen after the acoustic interval ends,
   so measurement can’t perturb the measured path.
3. Host: port `aec_lab.py`’s metric definitions (ERLE over far-active windows,
   lag-aligned correlation-leakage reduction, band-limited transfer-gain
   reduction, near-mode gain/similarity — `R/tools/aec_lab.py:209-441`)
   **including the six-fixture self-test** (known-good/known-bad synthetic
   far/near/double must classify correctly before any device data is trusted,
   `aec_lab.py:624-747`; also required by notes §Adopt-6).
4. The nearby-Mac SoX capture and the network-validity verdict continue as the
   independent oracles, unchanged from the Stick harness.

This yields the required falsifiability: the fixtures can fail the analyzer,
the analyzer can fail the device, and no new transport is invented.

---

## 7. Minimal test/evidence sequence to physical proof

- **R0 (host, before any flash):** existing suites green (`spsc_ring`,
  `pcm_lane`, conductor/sender, `aec_capture_bridge`, `pcm_clock_playback`,
  `core_s3_capture_reserve`, `stackchan_control_test`) plus the two new host
  rigs from §4 step 2 (owner pipeline with stub processor; writer fence).
  ELF audit target added (F5).
- **R1 (first flash):** bring-up + slot-map/64-BCLK proof per §4 step 1.
  Evidence: serial log with geometry assertion, REG06 verify, per-slot peaks,
  tap counters; Mac tone recording. Gate = notes step 2.
- **R2 (second flash):** deterministic full-duplex loopback via local
  userspace `/pcm` (§4 step 3): exact conservation both directions +
  continuity oracle + network verdict, capture running throughout.
- **R3:** AEC captures far / near / double with the §6.8 rig; gates from notes
  step 4; retain raw three-channel WAV + report JSON per run.
- **R4:** live Grok full-duplex + spoken barge-in through the local bridge
  (A1 policy, A2 fixed): audible replies, cancelled response, bounded flush
  counters, fresh-epoch mic turn, no drift over ≥8 turns (mirror the Stick’s
  eight-turn precedent).
- **R5:** the same through the deployed config worker on a fresh project:
  `/devices/stackchan` stream readback (sequence continuity, transcripts,
  lifecycle, any tool call), previous-session snapshot checks, network-valid
  interval, Stick powered down. This is the acceptance run.
- **R6 (after acceptance):** 1-minute → 2-minute → 10-minute endurance per the
  goal ladder, idle then under bounded capability load — unchanged policy.

Every run through the already-generalized harness (`--device-id stackchan`,
device-scoped evidence dirs) so Stick evidence cannot poison StackChan runs
(`production-grok-provider-events.ts:61-95`).

---

## 8. What this review checked and did not find

To bound the negative space: no unbounded queue, hidden allocation, or
blocking call was found in the shared-core audio path (the reject-list
behaviors exist only in the prior-art checkout); the BSP override’s patched
init is faithful to the proven prior-art configuration except as flagged in
F1–F3/F8; the worker’s PCM protocol has no PTT-gating on uplink and needs no
change for continuous microphone transit (A1 is about _turn semantics_, not
transport); and the `/devices/stackchan` observability requirement is already
met at HEAD. The Stick’s proven playback/uplink evidence is untouched by this
plan — no shared file the Stick links changes except additive core reuse.

---

## 9. Reconciliation checklist for the primary agent

Dispose of each item explicitly (accept / reject with reason / defer with
owner). Nothing here is self-executing.

**Decisions**

- [ ] D-1 Confirm the two-task Core-1 owner shape (writer 19 / DSP 17) or
      choose single-task render-first with a measured deadline counter as the
      arbiter (§4 step 2, §6.2).
- [ ] D-2 Confirm bypassing the audio controller’s polled capture driver +
      async `send_pcm` completion for CoreS3 (synchronous bridge-egress →
      lane), recorded in the component header (§4 step 2).
- [ ] D-3 Pick the Step-0 turn policy (server_vad in worker vs
      device-VAD-synthesized edges vs commit+clear) before R4 (§5.2 A1).
- [ ] D-4 AEC mode/NLP by fixture: FD_HIGH_PERF (proven) vs FD_LOW_COST
      (unproven), NLP from `VERYAGGR` start (§5.1 F7). Update the portability
      notes if FD_LOW_COST loses — they currently state it as the start.

**Must fix before first flash**

- [ ] F-1 Implement `aw88298` REG06 64-BCLK RMW-verify, re-applied after every
      speaker open/set_fs; failure latched + visible.
- [ ] F-2 Assert/log final bus geometry after codec opens; fail on mismatch.
- [ ] F-3 `init_tdm_rx` returns an error on already-inited-wrong-mode; enforce
      bring-up order (TDM init → speaker init → mic init).
- [ ] F-4 Boot-time slot-map validation + per-slot peaks + explicit reference
      channel gain (physical numbering) before AEC may start.
- [ ] F-5 Port the realtime ELF audit to the stackchan target (tap ISR +
      reserve in the audited graph).
- [ ] F-6 Record codec-dev open uses channel=4 (or explicit mask).
- [ ] F-8 Fix/document the `set_tap(NULL)` uninstall race.
- [ ] F-9 One monotonic clock for lane timestamps; surface
      `fatal_failure_latched` in stackchan metrics.

**Must fix before acceptance**

- [ ] A-1 Worker turn/echo policy implemented + tested (incl. uplink
      backpressure headroom review under continuous capture).
- [ ] A-2 Local bridge `#suppressDownlink` server-vad latch: red test + fix
      before any server-vad text-turn run.
- [ ] A-3 Acceptance runs: single device, Stick powered down (eviction +
      acoustics).
- [ ] A-5 Host-pin the drain+discard downlink barrier on the never-torn-down
      channel.
- [ ] A-6 Wire AEC resets by cause (reconnect ≠ reset; session edge resets
      reference ring).

**Build/composition**

- [ ] C-1 `devices/stackchan` becomes an IDF component; target
      EXTRA_COMPONENT_DIRS/REQUIRES include it + `iterate_core_s3_audio`.
- [ ] C-2 Exclude/gate `voicelab_stream` + `runtime_diagnostics` from the
      stackchan link; do not port the C++ playback triple; delete
      `pcm_clock_playback` only if (against this recommendation) the C++
      stack is ported instead.
- [ ] C-3 Remove or fence the untimestamped lane entry points
      (`receive_downlink`/`downlink_acquire`).
- [ ] C-4 Update `stackchan-contract.ts` to mirror the firmware manifest
      (conversation/pushToTalk/subscribeToEvents currently missing from the
      TS contract).
- [ ] C-5 Verify TX `auto_clear` survives the override init path.

**Evidence**

- [ ] E-1 Implement the §6.8 PSRAM capture + Cap'n Web pull + `aec_lab`-port
      with fixture self-test before R3.
- [ ] E-2 Keep the semantic-transcription result informational; gates remain
      the notes’ energy/correlation numbers.
- [ ] E-3 Copy the durable prior-art numbers (§2.5) into the portability notes
      or a sibling doc if the read-only worktree is at risk — the proven
      firmware exists only as another worker’s untracked state.
- [ ] E-4 Correct the portability notes’ slot-1 reference claim to “empirical,
      revalidate at boot” once F-4’s instrument reports on real hardware.
