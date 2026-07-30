# Fable audio architecture alternatives

Status: independent Fable research report, delivered 2026-07-30. Findings are
proposals until reconciled against source, tests, build evidence, and real
device measurements, per
[`audio-streaming-problem-and-evidence-2026-07-30.md`](./audio-streaming-problem-and-evidence-2026-07-30.md).

This report was produced by an independent reviewer with no authorship stake in
the current code. It is deliberately blunt where the evidence is blunt. Line
numbers reference the working tree as of 2026-07-30; the host TypeScript files
were being actively edited during the review (device-pcm-proxy.ts grew from 729
to 870 lines mid-read), so host citations name the snapshot they were read
against.

## 0. Scope, method, and sources actually inspected

Read in full or in structured depth, first-hand or through parallel research
agents whose citations were spot-verified:

- **This repo**: `apps/kit/firmware/components/{core,capabilities}`,
  `apps/kit/firmware/platforms/{common,iterate_esp_idf,iterate_m5unified}`,
  `apps/kit/firmware/devices/m5sticks3`, `apps/kit/firmware/targets/m5sticks3`
  (main.cpp, sdkconfig), the firmware test suite, `apps/kit/src/voice/`,
  `apps/kit/src/device/`, `apps/kit/scripts/device-e2e.ts`, and the three
  goal/reconciliation/evidence documents.
- **ESP-IDF v5.4.2** at `/Users/jonastemplestein/esp/esp-idf` (tag verified,
  commit `f5c3654a1c2d`): `esp_driver_i2s` (i2s_common.c read line-by-line for
  the ISR/queue/preload/disable semantics), FreeRTOS kernel
  (stream_buffer.c, tasks.c), esp_ringbuf, esp_timer, task/interrupt watchdogs,
  esp-tls, tcp_transport (transport_ws.c), lwIP port + Kconfig, esp_wifi
  headers/Kconfig, heap/PSRAM/DMA docs and source, and the in-tree examples
  (i2s_std, i2s_es8311, A2DP sink).
- **esp-protocols** (`esp_websocket_client` v1.8.0) at
  `~/src/github.com/espressif/esp-protocols`.
- **ESP-ADF** `release/v2.x` (`df98ef2`) at
  `~/src/github.com/espressif/esp-adf`: audio_pipeline/audio_element,
  i2s_stream (IDF5 + legacy), raw_stream, aec/algorithm_stream headers, the
  VoIP/esp-rtc duplex examples, the Coze WS realtime-agent example, volc_rtc,
  and the HTTP-playback examples (esp-adf-libs/esp-sr submodules are
  unpopulated in that checkout).
- **esp-sr v2.4.7** (`master` @ `2f8c4b0`) at
  `~/src/github.com/espressif/esp-sr`: AFE/AEC/NS/AGC/VAD headers plus
  targeted disassembly of the esp32s3 blobs to verify task ownership and
  `afe_config_init` defaults; and **esp-box** (`aae1b7a`) / **esp-skainet**
  (`1741f00`) at `~/src/github.com/espressif/` for the voice-app task
  diagrams and the in-tree full-duplex ES8311/ES7210 BSP init.
- **ESPHome** `dev` (2026.3.0-dev, `31f4b4d00d`) and
  **home-assistant-voice-pe** 26.2.2 (`7f6c0b726e`) at
  `~/src/github.com/esphome/`: voice_assistant, i2s_audio
  microphone/speaker, the audio/media pipeline, micro_wake_word, the Voice PE
  YAML and voice_kit (XMOS) component.
- **M5Unified / StackChan prior art** at `~/src/github.com/m5stack/` and
  `~/src/github.com/iterate/stackchan` (via the two completed Fable reviews in
  the reconciliation ledger and this session's memos; the M5Unified speaker/mic
  task internals cited here were verified in the vendored copy under
  `firmware/targets/m5sticks3/managed_components/m5stack__m5unified`).
- **baresip/re aubuf** at `~/src/github.com/baresip` (adaptive VoIP jitter
  buffer prior art; see §7.5).

Everything below cites file:line. Claims that could not be source-verified are
explicitly labelled.

## 1. Verdict in one page

The portable-core / bounded-queue / generation-fenced direction is right, and
several parts are genuinely strong (the SPSC lane, the WS frame writer with
resumable cursors, the freshness _intent_, the evidence discipline). But the
current realization of the **playback path** and the **cross-task control
plane** is a local maximum of exactly the kind the goal document warns about,
and the first physical failure is what that local maximum looks like in the
field:

1. **The design treats ESP-IDF's I2S driver as an adversary instead of a
   driver.** It rebuilds descriptor identity outside the driver
   (pointer-binding forensics, synthetic tokens, poison protocols), forbids the
   driver's own blocking/elastic write model, and then needs ~4,100 lines
   (`realtime_playback.hpp` 1,482 + `direct_i2s_stereo_output.hpp` 664 +
   `esp_idf_direct_i2s_backend.hpp` 689 + `m5sticks3_direct_audio.cpp/.hpp`
   1,034 + `realtime_owner_control.hpp` 252) to move 640-byte frames into a
   4-descriptor DMA cycle. Espressif's own in-tree template for "network audio
   at unpredictable rate → I2S" — the A2DP sink — is ~150 lines around a byte
   ring, a watermark state machine, and a blocking `i2s_channel_write`
   (`esp-idf/examples/bluetooth/bluedroid/classic_bt/a2dp_sink/main/bt_app_core.c:117-259`).

2. **Every anomaly is treated as a crime, and the punishment is physical.**
   Underrun, freshness violation, partial prebuffer, EOS of every ordinary
   response, and each socket-generation fence all execute
   `resetForPlayback()`, which is amplifier-off + `i2s_channel_disable` +
   **`i2s_del_channel` + `i2s_new_channel` + `i2s_channel_init_std_mode` +
   callback re-registration + 8 ES8311 I²C register writes at 100 kHz** — heap
   alloc/free and blocking I²C on the priority-19 realtime core, at the end of
   every single utterance
   (`realtime_playback.hpp:1026-1048,1230-1268,1270-1312,1314-1338,359`;
   `esp_idf_direct_i2s_backend.hpp:98-143`;
   `m5sticks3_direct_audio.cpp:147-171,288-345`). ESP-IDF supports a cheap,
   allocation-free generation reset — `i2s_channel_disable()` resets the DMA
   cursor and TX queue and `i2s_channel_preload_data()` rebuilds it
   (`esp-idf/components/esp_driver_i2s/i2s_common.c:1194-1222,1228-1260`) —
   and ESPHome ships exactly that recovery in production
   (`esphome/components/i2s_audio/speaker/i2s_audio_speaker.cpp:406-444`). The
   current code never uses it.

3. **The jitter budget is far too small for the punishments attached to it.**
   With 4×20 ms descriptors, IDF's finished-buffer queue holds
   `desc_num − 1 = 3` entries (`i2s_common.c:334`), so **60 ms of audio-owner
   starvation destroys the generation** (queue overflow → poison), and
   `currentContentFrames == 0` (an ordinary network gap of ~80 ms) does the
   same. Meanwhile the same firmware contains structural stall sources larger
   than that budget: flash-cache-off windows during any NVS/flash write freeze
   all non-IRAM code on both cores for tens-to-hundreds of ms
   (`esp-idf/docs/en/api-reference/peripherals/spi_flash/spi_flash_concurrency.rst:31-47`),
   and the control-plane network task is pinned to the audio core
   (`itx_transport.c:71`) despite comments claiming otherwise.

4. **The failure ratchets are one-way.** Nine latches never clear
   (§2.4). One 1-second mailbox timeout latches the PCM transport `FAILED`
   forever; the PCM transport is started exactly once
   (`main.cpp:1014-1037`), so the device needs a reboot. The observed physical
   signature — ~127 ms of tone, three ≤5 ms internal gaps, a phase step, then
   a reconnect and silence until the runner times out — is what this
   architecture produces when any single deadline in a chain of tight
   deadlines slips (§4).

5. **The host proxy polices bounds that do not exist in its actual runtime and
   enforces a media clock three hops upstream of the speaker.** Its
   `bufferedAmount` gate never fires on captun's paired sockets (no such
   property), its Blob mailbox is unreachable (captun normalizes to
   `Uint8Array`), and its post-startup source-underrun rule leaves ~12.5 ms of
   real-clock slack with the endurance fixture while the pinning regression
   runs under fake timers with zero lateness (§4, §6.5).

The materially simpler architectures in §6 keep every product guarantee in the
evidence document — exact 640 B frames, bounded queues with observable
high-water marks, no stale replay, explicit named overload results, boundary
timestamps — with roughly **one quarter of the moving parts**, and they are the
shapes that every shipped comparable system uses (ESP-IDF A2DP sink, ESP-ADF
VoIP, ESPHome speaker, baresip). The critical enabling observation, verified in
IDF source: **with `auto_clear_before_cb`, every completed DMA descriptor is
zeroed inside the driver ISR before reuse
(`i2s_common.c:630-632`), so steady-state underrun plays silence and stale
audio physically cannot replay while the channel stays enabled.** The primary
hazard that motivates the descriptor-forensics fortress is already neutralized
by driver configuration the firmware itself sets
(`m5sticks3_direct_audio.cpp:74-75`).

The single highest-leverage structural change is not the playback rewrite at
all: it is **creating one full-duplex `i2s_std` TX+RX channel pair on one
controller at boot and never deleting it** (§6.1). That one change removes the
reason the half-duplex handoff, the two mailboxes, the lifecycle rendezvous,
the per-PTT mic-task create/destroy, and the per-reset codec reprogramming
exist.

## 2. Critique of the current ownership/task/queue/timing model

### 2.1 The task map as built (not as commented)

| Task                                | Prio  | Core     | Stack        | Owns                                                                                                                     |
| ----------------------------------- | ----- | -------- | ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `iterate_audio`                     | 19    | 1        | 8 KiB static | playback policy + backend + I2S TX channel lifecycle (`m5sticks3_direct_audio.cpp:360-368`)                              |
| `iterate-pcm-net`                   | 5     | 0        | 6 KiB static | PCM WS connect/read/write + uplink conductor (`pcm_transport.c:834-842`)                                                 |
| `iterate-net` (control)             | 5     | **1**    | 3 KiB static | control transport state machine (`itx_transport.c:997-1005`; core = `CONFIG_FREERTOS_NUMBER_OF_CORES - 1`)               |
| `iterate-ws` (esp_websocket_client) | 5     | unpinned | 4 KiB heap   | control socket RX + ping (`esp_websocket_client.c:1475`)                                                                 |
| `mic_task` (M5Unified)              | **2** | unpinned | 2,304 B heap | microphone I2S1 DMA; **created/destroyed on every PTT press/release** (`Mic_Class.cpp:735-763`; `m5unified.cpp:309,331`) |
| `main`                              | 1     | 0        | 8 KiB        | device poll, **capture pump**, button, both transport polls, metrics, screen (`main.cpp:948-1100`)                       |

Against IDF's built-ins (source-verified, v5.4.2 `esp_task.h`/Kconfig):
ipc0/1 = 24 pinned, Wi-Fi = 23 core 0, esp_timer = 22 core 0, sys_evt = 20
core 0, lwIP `tiT` = 18 **unpinned**, tick = 100 Hz, CPU = 160 MHz.

Structural problems visible in the table alone:

- **The audio core is not reserved for audio.** The control network task is
  pinned to core 1 (`itx_transport.c:71`), and unpinned lwIP (prio 18) lands
  on core 1 whenever core 0 is busy — directly contradicting
  `pcm_transport.c:66-71` and `main.cpp:29-31`, which claim network work stays
  on core 0/system tasks.
- **Capture is the lowest-priority audio in the system.** Microphone DMA is
  serviced by M5Unified's unpinned priority-2 task, and completed frames are
  only noticed by the priority-1 main loop's 10 ms poll
  (`main.cpp:959-962` → `audio.c:134-169` → `bounded_capture.hpp:64-196`).
  The uplink freshness deadline (250 ms capture age,
  `esp_idf_websocket_policy.h:41`) therefore rests on the two least
  privileged tasks in the firmware, while playback — which has an 80 ms
  hardware reserve — owns priority 19. Priorities are inverted relative to
  deadline stiffness.
- **The main loop is a hidden audio dependency.** PTT hardware fences, the
  downlink generation barrier, capture pumping, and uplink admission all run
  on the same 10 ms loop as the screen, metrics serialization, Cap'n Web
  polling, and PMIC/button I²C. Worse, `peer_poll` aborts on the first non-OK
  module result and the module order is `[metrics, screen, push_to_talk,
audio]` (`peer.c:195-205`, `m5sticks3.c:99-103`) — a metrics driver error
  skips the microphone pump entirely for that pass.

### 2.2 The state-machine census

Full inventory (agent-verified, spot-checked): **12 named enum state
machines, 5 poll-result machines, 9 latches, 11 generation/sequence counter
families, 10 freshness/deadline policies, 7 retry/deferral mechanisms — 55
distinct control-state mechanisms**, plus **207 named producer-side counters**
and **17 distinct cross-task message/mailbox channels**, for a data plane
whose job is 640-byte frames in and out at 50 Hz. `atomic_saturating_increment`
alone is re-implemented seven times (`pcm_lane.c:60`, `pcm_uplink_sender.c:30`,
`pcm_uplink_conductor.c:30`, `pcm_peer_delivery_guard.c:65`, `spsc_ring.c:42`,
`pcm_transport.c:91`, `itx_transport.c:128`, plus two template variants).

Calibration against shipped systems: ESP-ADF's VoIP example — a complete
full-duplex SIP phone with AEC — runs its audio data plane with two
application tasks, four ring buffers, and one queue
(`esp-adf/examples/protocols/components/av_stream/av_stream.c`). ESPHome's
shipped speaker is one task, one ring buffer, one event group, one enum
(`i2s_audio_speaker.cpp`). baresip's shipped PCM jitter policy is ~30 lines
(`re/rem/aubuf/aubuf.c:241-395`). The kit's playback chain alone (policy +
wrapper + backend + owner: `realtime_playback.hpp` 1,482 +
`direct_i2s_stereo_output.hpp` 664 + `esp_idf_direct_i2s_backend.hpp` 689 +
`m5sticks3_direct_audio.cpp/.hpp` 1,034 + `realtime_owner_control.hpp` 252)
is **4,121 lines**.

### 2.3 The ten knots

**Knot 1 — Descriptor-identity forensics against a driver that already
guarantees the property.** The backend binds DMA buffer pointers to synthetic
tokens during the first callback cycle, verifies every later callback against
the binding, mirrors a pending-timing ledger, and poisons the generation on
any disagreement (`esp_idf_direct_i2s_backend.hpp:470-533, 281-402`). The
hazards it defends against are simpler than it assumes: (a) stale replay
while enabled is impossible because `auto_clear_before_cb` zeroes each
finished buffer inside the driver ISR _before_ `on_sent` runs
(`i2s_common.c:630-632`); (b) writing the wrong descriptor is impossible
because `i2s_channel_write`/`preload_data` consume the driver's own ordered
finished-descriptor queue (`i2s_common.c:1246-1260`). The residual hazard —
the 3-entry queue dropping its oldest pointer after ≥60 ms of owner
starvation — is already reported by the driver's `on_send_q_ovf` callback
with no ledger required.

**Knot 2 — Zero-timeout writes turn scheduling into an invariant.**
`i2s_channel_write(…, 0)` is declared "a semantic requirement, not a tuning
choice" (`m5sticks3_direct_audio.cpp:225-231`), which forces the policy layer
to carry a proof about ISR ordering (correct — I verified auto-clear →
`on_sent` → overflow-pop → queue-push at `i2s_common.c:610-660`) just to
justify classifying a zero-byte write as fatal. A blocking write with a
bounded timeout makes the whole proof unnecessary: the driver queue _is_ the
synchronization, timeout _is_ the underrun signal, and the task sleeps in
exactly the place the current design pays a notification + refill-credit
ledger to approximate.

**Knot 3 — Full physical teardown as the standard reset.** Every EOS of every
ordinary response, every underrun, every freshness incident, every partial
prebuffer timeout, and both halves of every reconnect execute
`resetForPlayback()`: amp-off → `i2s_channel_disable` → **`i2s_del_channel` →
`i2s_new_channel` → std re-init → callback re-registration → 8 ES8311 I²C
writes + 2 PMIC I²C ops at 100 kHz** — on the priority-19 core
(`realtime_playback.hpp:1026-1048, 1230-1268, 1270-1312, 1314-1338, 359`;
`esp_idf_direct_i2s_backend.hpp:98-143`;
`m5sticks3_direct_audio.cpp:147-171, 288-345`). `i2s_new_channel` /
`i2s_del_channel` also heap-allocate/free the channel object and DMA buffers
(`i2s_common.c:238, 320, 463-478`) — so the "allocation-free realtime core"
sits on an allocating per-utterance driver lifecycle. The cheap reset the
driver supports (disable → preload → enable; cursor and TX queue reset by the
driver, `i2s_common.c:1194-1222`) is what ESPHome ships for underrun recovery
(`i2s_audio_speaker.cpp:406-444`). The current code never uses it, and
`direct_i2s_stereo_output.hpp:206-211` explicitly rejects an index-rewind
path.

**Knot 4 — The half-duplex pin handoff drives the whole control plane.** The
TX channel must be deleted before M5Unified's mic can own the shared
MCLK/BCLK/WS pins, so PTT requires synchronous cross-task hardware fences:
one press executes up to three 1-second-bounded rendezvous
(`audio.c:236-273` runs stop + flush; `m5unified.cpp:297-316` suspends a
third time), plus a mic-task create; release adds a busy-wait task join
(`Mic_Class.cpp:755-759`). This is the _only_ reason the dual-mailbox +
semaphore + fail-closed-latch apparatus (`realtime_owner_control.hpp`,
`m5sticks3_direct_audio.cpp:676-732`) exists. The StickS3 codec is wired
full-duplex on one I2S bus; M5Unified's half-duplex model is a library
limitation — its Speaker and Mic are two independent I2S masters with
mutually clobbering ES8311 reset callbacks
(`M5Unified.cpp:511-546` DAC-only vs `:964-991` ADC-only), and M5Stack's own
StackChan product firmware abandons M5Unified audio for exactly this reason,
using one duplex port via esp_codec_dev
(`m5stack/StackChan firmware/main/hal/board/cores3_audio_codec.cc:107`).

**Knot 5 — One 1-second timeout bricks audio until reboot.** The mailbox
fail-closed latch is permanent by design (`realtime_owner_control.hpp:47-51`);
a missed acknowledgement latches `fatal_failure_latched` in the PCM transport
(`pcm_transport.c:891-897`), nothing clears it, and the PCM transport is
started exactly once per boot (`main.cpp:1014-1037`). Silent variant: a
failed `snapshotMetrics` rendezvous returns the stale previous snapshot with
no error (`m5sticks3_direct_audio.cpp:416-421`) — telemetry freezes exactly
when it is most needed.

**Knot 6 — Overflow policies destroy more than they protect.** Downlink
ring-full does not head-drop; it marks the socket disconnected and requests a
**full reconnect** (`pcm_transport.c:323-343`). One stalled playback
generation therefore fills the 640 ms ring and converts a 100 ms hiccup into
a TLS reconnect storm. Uplink ring-full requests an epoch reset that purges
the whole lane (`pcm_lane.c:190-195`, `pcm_uplink_sender.c:136-193`). The
product requirement — a small explicit jitter allowance, then discard the
affected generation with a counter — is satisfiable with drop-oldest at
1/50th of the blast radius (baresip does precisely this:
`aubuf.c:277-285`).

**Knot 7 — Two WebSocket stacks, two backoff systems, duplicated helpers.**
The control lane still runs `esp_websocket_client` (with the known-unsafe
`CONFIG_ESP_WS_CLIENT_SEPARATE_TX_LOCK=y` in `sdkconfig.defaults:15`), while
the PCM lane runs the owned `websocket_connection` stack. Both carry parallel
`mark_socket_disconnected`/`request_restart`/latch/backoff helpers; ITX
additionally hand-rolls a second Wi-Fi backoff beside the shared retry gate
(`itx_transport.c:556, 600-630`).

**Knot 8 — Eight clock-sanity policies feeding one counter name.** Conductor
(`pcm_uplink_conductor.c:75-101`), sender (`pcm_uplink_sender.c:72-86`),
guard (`pcm_peer_delivery_guard.c:109-129`), playback policy
(`realtime_playback.hpp:245-254, 548-586`), and backend
(`esp_idf_direct_i2s_backend.hpp:309-318, 337-344, 554-565`) each
normalize/reject time regressions differently, and all report into
`owner_clock_regressions`-shaped counters. A diagnosed regression cannot name
its boundary.

**Knot 9 — The borrow-token protocol.** Because SPSC acquire and release are
separately fallible, `RealtimePlayback` carries six flags to release one
borrowed lane slot across **16 distinct failure paths** into **five
non-additive loss buckets** (`realtime_playback.hpp:1340-1402` plus its call
sites; `flushGeneration:306-309` and `stop:406-423` deliberately count the
same frame into two buckets). `main.cpp:482-493` then re-sums five buckets
into one public number. Nothing in the product contract needs this taxonomy;
it exists because a fortress with ~20 exits must classify every exit.

**Knot 10 — Dead weight contradicting the live design.**
`bounded_playback.hpp` (389 lines — a second, contradictory playback model),
`display_refresh_gate.hpp` (60), and the entire `runtime_diagnostics.c`
module (505 lines, 67-field snapshot) are compiled into the target and
referenced by zero production code. Meanwhile 14 playback-detail fields that
`main.cpp:551-648` computes are silently discarded by the metrics serializer,
`subscribeToPlaybackMetrics` exists in firmware
(`capabilities/src/metrics.c:21`) with **no TypeScript counterpart anywhere in
`src/`**, and the endurance judge requires 44 metric names nothing can
produce (`m5sticks3-playback-endurance-target.ts:188-232`) — which is why the
endurance mode runs with `runtime: {}` and fails closed
(`device-e2e.ts:277-286`). Evidence machinery is simultaneously over-built
and unfinished.

### 2.4 The one-way ratchets

Nine latches never clear within a session: PCM-transport fatal
(`pcm_transport.c:254-259`), ITX fatal (`itx_transport.c:270-274`), ITX
protocol-failure generation (`itx_transport.c:95-116`), peer-guard restart
(until generation replace), playback `failed` (no path back; `begin()`
rejects non-stopped, `realtime_playback.hpp:214-217`), wrapper `poisoned`,
backend `ownershipPoisoned_`, and both mailbox fail-closed latches, plus the
audio controller's `playback_flush_pending` (`audio.c:229-231`). Individually
each is defensible; composed, recovery means "replace the generation", and
when generation replacement itself requires a rendezvous with the possibly
stalled task, the system converges on the observed field behavior: dead audio
behind healthy-looking transports.

### 2.5 Timing folklore the code contradicts

- "Network work remains on Core 0/system tasks" (`main.cpp:30-31`) — false
  for the control task (core 1) and unpinned lwIP.
- "Notifications are intentionally coalesced" for the main loop
  (`main.cpp:1095-1099`) — no code ever notifies the main task; it is a plain
  fixed 10 ms sleep. At `CONFIG_FREERTOS_HZ=100`, `pdMS_TO_TICKS()` truncates
  (5 ms → 0 ticks, `projdefs.h:46`), so every sub-10 ms deadline in the
  firmware quantizes to 0–10 ms.
- The audio owner's _task code_ is flash-resident. The IRAM audit correctly
  covers ISRs, but any flash erase/write (NVS, Wi-Fi calibration, future OTA)
  suspends flash cache on both cores for tens to hundreds of ms while the
  other core busy-polls
  (`esp-idf/docs/en/api-reference/peripherals/spi_flash/spi_flash_concurrency.rst:31-47`;
  auto-suspend off by default, `spi_flash/Kconfig:86-94`). The pump, the
  mailbox service, and `i2s_channel_write` all stop for the duration. A 60 ms
  budget cannot survive this class of stall. Only two designs do: tolerate
  (elastic buffer deeper than the stall) or detect-and-resync (silence gap,
  then drop-to-live). The current design does neither — it detects and then
  executes a multi-millisecond allocating physical teardown at exactly the
  moment the system is starved.

## 3. What the current design gets right (must survive any migration)

- **Two independent WebSockets** (control vs PCM). Confirmed by every
  comparable (ESPHome separates concerns per socket; ADF's Coze agent keeps
  WS outside the audio pipeline entirely).
- **The fixed 640 B / 20 ms wire contract with an ordered zero-length EOS**
  and the host's incremental rechunker honoring it
  (`device-pcm-proxy.ts:590-607`) — clean and correct.
- **The SPSC lane with in-slot timestamps** (`pcm_lane.h:41-69`):
  caller-owned storage, acquire/publish/release, drop accounting. It is the
  right primitive — equivalent to IDF ringbuf's zero-copy
  `SendAcquire`/`SendComplete` pattern (`esp_ringbuf/ringbuf.c:984-1031`) with
  tighter semantics and no mux. Keep it unchanged.
- **The owned PCM WebSocket client** (`websocket_connection.c` + tx/rx/frame
  writer): O_NONBLOCK + `TCP_NODELAY` at `websocket_connection.c:303-336`
  (the stock stack never sets NODELAY and pays Nagle one RTT per frame —
  `lwip tcp_priv.h:100-105`), resumable masked-frame cursor, single-writer
  discipline. This correctly implements the tiny-WS memo's decision and
  avoids `esp_websocket_client`'s lock pathology (send holds the same lock
  RX needs, up to `network_timeout_ms` — `esp_websocket_client.c:692-784`).
- **Direct reassembly of fragmented WS delivery into the acquired ring slot**
  (`pcm_lane.c:283-413`) — the F2 fix — exactly right.
- **The driver configuration itself**: `auto_clear_before_cb=true`,
  preload-before-enable, amp-after-enable
  (`m5sticks3_direct_audio.cpp:70-99`,
  `esp_idf_direct_i2s_backend.hpp:168-198`). These are the foundation the
  simpler design builds on.
- **`WIFI_PS_NONE`** (`itx_transport.c:933`): without it, default modem sleep
  adds DTIM-period downlink bursts of 100-300 ms
  (`esp-idf docs/en/api-guides/wifi.rst:1793-1805`). Deserves a pinned
  regression so it can never regress silently.
- **The host evidence discipline** (acoustic capture provenance, exact source
  hashes, fail-closed validation). No shipped ESP32 voice product I inspected
  has an equivalent. Keep the harness; point it at a simpler device.

## 4. The observed physical failure, read architecturally

Signature (evidence doc §physical): ~127.5 ms of audible tone (≈6.4 frames;
4 preloaded + ~2 refills), three internal gaps ≤5 ms, one 0.42 rad phase
step, ~59.9 s of tone missing, PCM session reconnected, runner timed out with
no retained proxy reason. Four mechanisms in the current architecture produce
exactly this shape. Ranked by prior probability and cheapness of
falsification:

**H-A (host): the proxy's post-startup source-underrun rule is a hair
trigger.** After the 3-frame startup watermark, any 20 ms deadline at which
the downlink ring holds <640 B closes the session with 4013
(`device-pcm-proxy.ts:658-672` at the reviewed snapshot). With the endurance
fixture (1000 B per 31.25 ms in, 640 B per 20 ms out, 3-frame start), the
steady-state ring trough is 1040 B — **≈12.5 ms of slack against Node event
-loop + tunnel jitter, sustained for 3,000 consecutive deadlines**. The
composed 60 s regression is green only because Vitest fake timers fire
`setTimeout` with exactly zero lateness while captun delivery stays on real
microtasks. Falsify first: the run's proxy close reason (retention landed
mid-review: `device-pcm-proxy.ts:47-58,793-799`) and a real-clock (non-fake-
timer) host soak of the pacer.

**H-B (device): the peer-delivery guard's idle probe kills playback-only
sessions at ~3 s.** During pure playback the device sends no uplink audio, so
peer evidence can only come from the idle probe: a PING after 2,000 ms idle,
then generation replacement 1,000 ms later if no byte-identical PONG arrives
(`esp_idf_websocket_policy.h:46-47`; `pcm_peer_delivery_guard.h:70-88`). The
audible window in the retained capture ends at 3,010 ms. captun's bridge
relays messages, not control frames, so the PONG depends entirely on whether
the tunnel edge auto-pongs with an echoed payload. Falsify: guard/restart
counters in detailed metrics; a run with the probe interval raised; a direct
captun ping-echo test.

**H-C (device): destructive-reset thrash.** Any single underrun / deadline
miss / queue overflow executes the full teardown-rebuild (Knot 3), each pass
inserting a multi-millisecond gap (channel delete/create + codec I²C) and
rejoining the tone at arbitrary phase — matching the three ≤5 ms gaps and the
0.42 rad phase step inside the audible window. Repeated resets then either
(a) hit a driver/I²C failure and latch `failed`, or (b) starve the ring until
ring-full triggers the transport's full-reconnect policy
(`pcm_transport.c:323-343`) — "PCM session reconnected". If a lifecycle
rendezvous timed out anywhere in that storm, Knot 5 latches the transport
dead, which matches "never recovered".

**H-D (device): a flash-cache stall.** One NVS/Wi-Fi-driver flash write
freezes the flash-resident pump for ≥60 ms → 3-entry queue overflow → poison
→ teardown (§2.5). Falsify with the driver-queue-overflow counter and by
correlating against NVS activity.

None of these are exotic. H-A and H-B are first-class architecture findings
in their own right (the host enforcing a hard media clock it cannot keep; a
liveness probe whose transport cannot carry the evidence it demands); H-C is
the cost model of §2.3 doing what it is specified to do.

## 5. What the shipped comparables actually do

One paragraph each; details and citations in §7.

- **ESP-IDF A2DP sink** (in-tree): 32 KB byte ring, 3-state
  PREFETCHING/PROCESSING/DROPPING watermark machine, prio-22 consumer
  blocking in `i2s_channel_write(portMAX_DELAY)`; producer drops with a
  counter when the ring is full. (`bt_app_core.c:117-259`.)
- **ESP-ADF VoIP** (Espressif's engineered 20 ms duplex): 20 ms element rb,
  60 ms drop-newest network jitter buffer, 160 ms AEC reference rb, audio
  tasks prio 21 split across cores, taskless I2S elements, underrun = stall
  the write / driver auto-clear silence — never a teardown; `FREERTOS_HZ=1000`,
  240 MHz. (`av_stream.c`.)
- **ESPHome / Voice PE** (highest-volume shipped S3 voice device): never
  attempts realtime bidirectional streaming — uplink is wake-word-gated 32 ms
  chunks best-effort over one TCP connection; TTS is an HTTP fetch behind
  ~1 s prebuffer; AEC lives on a separate XMOS chip. Its _speaker_ mechanism
  is one prio-19 task + 100 ms ring + 4×15 ms DMA + underrun
  disable/preload/re-enable + `on_sent` ISR timestamps as passive position
  tracking. Its capture is a prio-23 task doing blocking 16 ms reads with
  synchronous memcpy fan-out. Uplink RB drops oldest; downlink RB blocks
  producer. (`i2s_audio_speaker.cpp`, `i2s_audio_microphone.cpp`,
  `voice_assistant.cpp`.)
- **baresip** (decades of VoIP field time): downlink policy ≈30 lines —
  prime to `wish`, underrun → silence + re-prime, overrun → drop **oldest**,
  startup trim; TX is an absolute-deadline 20 ms ticker that on underrun
  _skips and advances the timestamp_, never shipping old mic audio late;
  drift = two EMAs + ±20 ms re-anchor over a 10 s window. No resampling.
  (`re/rem/aubuf/aubuf.c:241-395`; `baresip/src/audio.c:853-913`;
  `baresip/src/jbuf.c:326-407`.)
- **iterate/stackchan experiment 02** (in-house prior art, already written):
  the codec write/read pair _is_ the clock; network feeds a bounded
  StreamBuffer; underrun = zero-fill + counter; barge-in = one
  `xStreamBufferReset`; DMA-tap face feed; deliberately shrunk ISR queues
  with the rationale written into the source ("a 16-entry queue retained
  128 ms of stale audio… and could itself mask scheduling problems",
  `firmware-ws/main/audio_pipeline.c:44-50`). Its half-duplex StickS3 sibling
  used the M5Unified idiom this report recommends leaving.
- **esp-box / esp-skainet** (Espressif voice reference apps): three tasks
  (feed core 0, fetch core 1, handler), full-duplex std TX+RX pair from **one
  `i2s_new_channel` call** with identical std config on both directions
  (`esp-skainet/components/hardware_driver/boards/esp32s3-box-3/bsp_board.c:281-287`),
  esp_codec_dev on a shared-clock bus. M5Stack's own StackChan product
  firmware uses the same duplex single-port shape and does not use M5Unified
  for audio.

The pattern across every one of them: **an elastic bounded buffer between
network and speaker; a blocking or clock-driven writer; underrun = silence +
counter (+ cheap re-prime); overload = drop with a counter; hardware torn
down never (or only at true session teardown).** No shipped system meets
anomalies with channel deletion, and none tracks descriptor identity outside
the driver.

## 6. Alternative architectures

All variants below share one substrate change and keep: both WebSockets, the
PCM v1 wire contract, the SPSC lane rings and their counters, the owned PCM
WebSocket client, WIFI_PS_NONE, and the metrics/evidence discipline
(re-pointed at fewer, better counters). RAM figures assume today's static
rings (32-slot uplink ≈20.7 KB, 32-slot downlink ≈21 KB) unless stated.

### 6.1 The substrate: one full-duplex I2S pair, created once, never deleted

Create `i2s_new_channel(&chan_cfg, &tx, &rx)` on I2S0 at boot — both
directions, one controller, shared BCLK/WS/MCLK, identical
`i2s_std_config_t` at 16 kHz — exactly the esp-skainet/esp-box BSP shape
(`bsp_board.c:281-287`) and the ES8311 example
(`esp-idf/examples/peripherals/i2s/i2s_codec/i2s_es8311/main/i2s_es8311_example.c:75-98`,
which also demonstrates the read→write echo loop with no delays). Program the
ES8311 once for simultaneous ADC+DAC via the maintained registry driver
(`espressif/es8311` component, used by esp_codec_dev) instead of the current
8-register DAC-only poke (`m5sticks3_direct_audio.cpp:313-345`). DIN moves
from "unused" to G16 (`m5sticks3_direct_audio.cpp:99` currently sets
`I2S_GPIO_UNUSED`; the board wires DIN on the same bus — this is the
kit's own prior hardware finding and the M5Unified maintainer's
recommendation for duplex).

What this one change deletes, mechanically:

- the TX-channel delete/create lifecycle and both of its I²C reconfiguration
  paths (Knot 3);
- the suspend/resume lifecycle commands, the dual mailboxes, the command
  semaphore, and the fail-closed latches (Knot 4, Knot 5) — PTT becomes a
  policy bit, not a hardware ownership transfer;
- M5Unified's Mic task (created/destroyed per press, prio 2, stale-DMA
  resume, spurious reinit) and the `BoundedCapture` two-slot bridge built to
  compensate for it;
- the "capture pumps through the main loop" dependency (Knot on
  `peer_poll` ordering) — capture gets its own task;
- and, later, it _creates_ the sample-synchronous speaker reference AEC
  needs (the mic and speaker share one clock domain; the reference is the
  frames the audio task just wrote).

Mode policy on the Stick: half-duplex PTT = "while capture-gated, discard
downlink and mute amp; while playing, drop mic frames before the lane." Both
are one predicate at one call site each, host-testable.

Startup pop discipline (the real reason the current code re-inits the codec
per generation) is handled the boring way: configure codec once at boot with
amp off; amp on only after the first preload+enable; amp off on stop. The amp
GPIO toggle (2 I²C ops) is the only per-session hardware action left.

### 6.2 Architecture A — bounded ring + blocking writer (recommended first step)

The A2DP-sink/ESPHome/ADF shape, using the existing downlink lane ring as the
elastic buffer.

Prose task/core diagram:

- **`audio-out` task, prio 19, core 1, ~4 KB** (replaces
  policy+wrapper+backend+owner): loop —
  1. take one frame from the downlink lane (`downlink_acquire_at`); if
     empty, block on task notification with a bounded wait;
  2. freshness: if `now − received_at > maxAgeMs`, drop-oldest until fresh
     (aubuf trim; counter `freshness_frames_dropped`), never touching
     hardware;
  3. mono→stereo expand into the one scratch frame (unchanged);
  4. `i2s_channel_write(tx, scratch, 1280, &written, pdMS_TO_TICKS(40))` —
     blocking; the driver's descriptor queue is the synchronization;
  5. write timeout ⇒ underrun incident counter; policy decides silence-gap
     (do nothing; auto_clear plays zeros) vs resync (`i2s_channel_disable` →
     `preload` fresh + zero-pad → `enable`) when the gap exceeded a named
     threshold;
  6. EOS marker ⇒ drain remaining frames, then either keep the channel
     running on auto-clear silence (full-duplex future; keeps AEC reference
     alive — the esp-skainet player writes zeros on pause for exactly this
     reason, `esp_skainet_player.c:110-111`) or amp-off+disable (today's
     half-duplex power policy);
  7. generation flush / interruption ⇒ `discard_downlink` + disable →
     zero-preload → enable. Allocation-free, single-digit microseconds to
     ~1 ms, no I²C except amp.
- **`audio-in` task, prio 21-23, core 1, ~4 KB** (ESPHome's capture shape):
  blocking `i2s_channel_read(rx, buf, 640, &read, 25 ms)` → PTT predicate →
  `pcm_lane_submit_uplink_at` → notify PCM net task. The read _is_ the frame
  clock; no M5Unified, no main-loop pump, no two-buffer recorder ledger.
- **`iterate-pcm-net`, prio 5, core 0** — unchanged (conductor/sender/guard,
  simplified per §10).
- **`iterate-net` control, prio 5, core 0** (moved off the audio core —
  one-line fix regardless of everything else, `itx_transport.c:71`).
- **main loop, prio 1, core 0** — loses all audio duties except translating
  the button edge into the PTT policy bit.
- **I2S ISR** — retained _only_ as passive instrumentation: `on_sent`
  timestamps feed the existing log2-histogram/EOF-age metrics;
  `on_send_q_ovf` increments the underrun-observability counter. Neither
  gates the data path.

Startup policy: preload min(prebufferFrames, available) + zero-pad remainder
(`i2s_channel_preload_data` supports partial fills and rebuilds the free
queue, `i2s_common.c:1241-1247`), enable, amp on. `prebufferFrames` is the
named knob (default 2 = 40 ms; the current design forces 4 = 80 ms and a
200 ms partial-prebuffer death sentence).

Deadline observability without a fortress: one **task-watchdog user handle
per stage** (`esp_task_wdt_add_user`/`esp_task_wdt_reset_user`,
`esp-idf/components/esp_system/task_wdt/task_wdt.c:681-741`) — "audio-out
wrote a frame", "audio-in read a frame" — fed with a sub-second
`esp_task_wdt_init` timeout gives a supervised deadline-miss detector with a
weak-symbol ISR hook, replacing bespoke deadline machinery.

Estimated size: writer ≈200 lines, capture ≈120 lines, plus ~80 lines of I2S
setup — replacing 4,121 lines of playback chain plus the M5Unified capture
path. All policy branches (freshness trim, underrun/resync threshold, EOS,
flush) are pure functions over the lane + a 6-call driver seam
(reset/preload/enable/write/disable/amp) — directly host-testable with a fake
that models a blocking queue, no descriptor identities required.

### 6.3 Architecture B — ISR-pull ("render callback")

Delete the playback task from the data path entirely. `on_sent` hands the ISR
the just-cleared DMA buffer pointer and its size (`i2s_common.c:624-635`);
the ISR pulls the next frame straight from the downlink lane (SPSC consume
from ISR is legal for a single consumer), expands mono→stereo directly into
`evt.dma_buf`, and releases the slot. Ring empty ⇒ leave the zeros
auto-clear already wrote (that _is_ the silence policy) and bump an underrun
counter. A tiny control task (or the existing main loop) handles start
gating, EOS, amp, and flush.

- Latency: the floor — a received frame plays within ≤2 descriptor periods
  (20-40 ms) of arrival with prebuffer 1-2. No task scheduling in the path at
  all, so display/Cap'n Web/metrics/logging _cannot_ starve it; even
  flash-cache-off windows don't stop it if the fill path is IRAM-resident
  (the I2S ISR already runs cache-off under `CONFIG_I2S_ISR_IRAM_SAFE=y`,
  which the target sets — the fill function, SPSC ops, and lane storage are
  already audited IRAM/DRAM candidates under the existing post-link audit).
- Cost: ~5-10 µs of memcpy/expansion per 20 ms in ISR context; fill code +
  ring accessors must be IRAM (`i2s_common.c:397` already enforces IRAM for
  the callback); freshness policy must use a pre-computed age bound (no
  divisions, no logging).
- Risk: the ISR context is the one environment the host rig cannot execute;
  the fill function stays a pure C function tested on host, but its
  ISR-integration is only physically testable. Debugging a defect there is
  meaningfully harder than in a task.

Verdict: hold as the escalation path if Architecture A's measured
worst-case owner latency (EOF-to-refill histograms, which the passive ISR
instrumentation keeps producing) ever shows task scheduling to be the
limiting factor. Do not start here; A's measurement decides whether B is
ever needed. B and A share the substrate, the lane, and the policies — the
migration between them is small.

### 6.4 Architecture C — one audio service task, device-clocked (simplest credible; the StackChan endpoint)

Collapse capture and playback into **one task owning both directions of the
duplex pair** — iterate/stackchan experiment 02's `audio_task`, ADF VoIP's
algorithm loop, and baresip's port model:

- **`audio` task, prio 21, core 1, ~6 KB**: loop —
  1. `i2s_channel_read(rx, micFrame, 640, &n, 25 ms)` — on the shared-clock
     duplex bus this completes every 20 ms; **the codec is the metronome**;
  2. if capturing: submit micFrame to the uplink lane (+notify net);
  3. pull ≤1 frame from the downlink lane (freshness-trim first); if none,
     use the zero frame; if EOS/flush pending, run that policy;
  4. `i2s_channel_write(tx, spkFrame, 1280, &n, 25 ms)` — writes zeros during
     silence so the TX clock (and later the AEC reference) never stops;
  5. (StackChan tranche) every 512 accumulated samples, call
     `aec_process(mic512, ref512, clean512)` with the reference taken from
     the frames written in step 4 through a small calibratable delay ring;
     feed `clean` to the uplink lane instead of raw mic.
- Control = two atomic policy bits (captureEnabled, playbackMuted) + one
  4-slot command SPSC for rare lifecycle ops (start/stop/flush) — no
  rendezvous mailboxes; metrics snapshot via a seqlock the task publishes
  once per second.
- Everything else as in 6.2.

Why this is the _product's_ simplest credible design rather than just the
Stick's: the AEC contract (esp-sr v2.4.7) is caller-task feed/fetch — **the
library creates no tasks** (verified: zero `xTaskCreate` imports across all
11 blobs) — with 16 kHz PCM16 chunks of 512 samples (SR/FD) at
~19-31 KB internal + 64-90 KB PSRAM and 7-20% CPU for the LOW_COST modes
(`esp-sr/docs/en/acoustic_echo_cancellation/README.rst:138-184`,
`include/esp32s3/esp_aec.h`). One device-clocked task that already touches
both directions in the same iteration is precisely the shape that drops
`aec_process` in without any new cross-task alignment machinery; mic-vs-ref
skew is bounded by construction (same loop, same clock domain) instead of
measured across queues. Note the re-blocking obligation: 320-sample frames →
512-sample AEC chunks needs two small accumulators (one per direction);
that is ~40 lines, not a framework.

Trade-off vs 6.2: one task means a slow speaker write can delay a mic read by
up to its timeout. On a shared-clock duplex bus read and write complete in
lockstep, so in practice each blocks ≤1 frame period; the loop's worst-case
period is bounded at ~2 frame periods, which the uplink freshness budget
(250 ms) absorbs ~6× over. 6.2's two-task split avoids even that coupling at
the cost of one more task and one more notification edge. Either is
defensible; start with 6.2 on the Stick (it perturbs less at once), converge
on 6.3 when AEC lands, or adopt 6.3 immediately for StackChan bring-up.

### 6.5 The host side: a relay, not a metronome

The device owns the media clock (its DMA + its freshness policy). The host
proxy should stop enforcing one. Concretely (against
`device-pcm-proxy.ts` at the reviewed snapshot):

- **Keep**: auth/subprotocol handling, session replacement, the incremental
  rechunker into exact 640 B frames, ordered zero-pad + EOS on
  `response.done`, PTT commit fence (`input_audio_buffer.commit` +
  `response.create` after the last relayed frame), `response.created`
  suppression fencing, close-reason provenance (`onSocketClose`, landed
  mid-review — wire it into the harness), and the failure _names_.
- **Replace fatal-with-drop**: the downlink ring becomes drop-oldest with a
  high-water + dropped-bytes counter (baresip `aubuf.c:277-285` semantics)
  sized generously (e.g. 500 ms — it is upstream elasticity, not the latency
  bound; the device's freshness policy is the latency bound). A provider
  chunk larger than the ring is a drop+count, not a 4013. Overflow closes
  nothing.
- **Delete**: the 20 ms absolute-grid pacer as an _enforcement_ mechanism,
  the startup watermark, the post-startup source-underrun kill, the Blob
  single-in-flight mailboxes (unreachable in the actual runtime — captun
  normalizes to `Uint8Array`), and the `bufferedAmount` gate (the property
  does not exist on captun's paired sockets; the real egress queue is
  captun's internal promise chain, which the gate cannot see). Forward
  frames as the ring yields them, at most N frames ahead of realtime if
  burst-shaping proves necessary on the real tunnel — but as a _shaping_
  knob with a counter, never a session-fatal classification.
- **Measure instead of enforce**: per-session counters (frames relayed,
  dropped-oldest, largest burst, provider chunk-size histogram, close
  provenance) exported to the harness. Host pacing _evidence_ the endurance
  manifest wants is measured at the device ingress anyway.

This is ~200-250 lines against today's 870, keeps every stated guarantee in
the evidence doc's product-shape section, and removes both host-side failure
modes implicated in §4 (H-A directly; H-B's blast radius, because a
reconnect no longer also has to re-run a watermark/pacer state machine).

### 6.6 Implications matrix

Current = as built today. A/B/C = §6.2/§6.3/§6.4 on the §6.1 substrate.

| Dimension                                          | Current                                                                | A (ring+blocking writer)                                                                                  | B (ISR-pull)                                            | C (one audio task)                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| Startup latency (receive→sound)                    | 80 ms forced (4-frame preload) + 60 ms host watermark ≈140 ms/response | prebuffer knob ×20 ms (default 40 ms), no host watermark                                                  | 20-40 ms                                                | 40 ms default                                         |
| Steady receive→DMA-start                           | ~20-60 ms                                                              | same (ring usually ≤1-2 frames)                                                                           | minimum (≤2 descriptors)                                | same as A                                             |
| Underrun tolerance                                 | 0 — any miss destroys generation (teardown ~ms + rebuffer 80 ms)       | silence-gap ride-through up to named threshold; resync = disable/preload/enable (~µs-1 ms)                | infinite ride-through (zeros), resync optional          | as A                                                  |
| Stale-audio recovery                               | teardown + 640 ms ring purge, or full reconnect on ring-full           | drop-oldest trim at dequeue + flush = discard+disable/preload/enable                                      | same policies at ISR boundary                           | same                                                  |
| Behavior under 100 ms flash-cache stall            | queue overflow → poison → teardown; possible mailbox latch (permanent) | 640 ms ring absorbs; ≤5 zero frames audible; counter                                                      | inaudible if ring non-empty (ISR keeps running)         | as A                                                  |
| RAM (audio path, excl. rings)                      | 5 KB DMA + ~2.6 KB objects + 8 KB task stack + mailboxes               | 5-7.7 KB DMA (4-6 desc) + 1.3 KB scratch + 2×4 KB stacks                                                  | 5 KB DMA + 1.3 KB scratch (+ tiny ctl task)             | 5-7.7 KB DMA + 2.6 KB frames + 6 KB stack             |
| Allocations after boot                             | per reset: i2s_del/new_channel heap churn                              | zero                                                                                                      | zero                                                    | zero                                                  |
| CPU (audio path)                                   | 3 copies + ledger/poison bookkeeping + per-reset I²C                   | 3 copies; task sleeps in driver                                                                           | 3 copies in ISR (~5-10 µs/20 ms)                        | 3-4 copies (+AEC 7-20% when enabled)                  |
| Cross-task machinery                               | 2 mailboxes + semaphore + 4 notify targets + edges/atomics             | 2 notify edges (net→out, in→net)                                                                          | 1 notify edge + ctl commands                            | 1 notify edge + 2 policy bits + cmd ring              |
| Instrumentation                                    | 44+ playback counters, EOF ledger mandatory to run                     | EOF timestamps/histograms passive; ~12 counters cover the contract; TWDT user handles for deadline misses | same, minus write-call timing                           | same + AEC metrics                                    |
| Host-testability                                   | high (its main virtue) — but tests pin fortress semantics              | high — policies are pure fns over lane + 6-call blocking-driver fake                                      | policy pure fns testable; ISR integration physical-only | high; loop is deterministic given scripted read/write |
| Portability (Waveshare/HA-VoicePE/ESPHome adapter) | driver seam is 9 exotic ops incl. descriptor tokens                    | driver seam ≈ i2s read/write/preload/enable/disable — matches ESPHome/ADF/esp_codec_dev shapes            | needs per-target ISR hook — least portable              | same seam as A                                        |
| AEC path                                           | undefined; reference timing would cross 3 layers                       | possible (ref = written frames + measured queue depth)                                                    | hard (ref alignment in ISR)                             | natural — same-loop mic+ref, bounded skew             |
| Failure blast radius                               | generation/teardown/reboot-latch                                       | frame-level (drop/silence), session only on real socket death                                             | frame-level                                             | frame-level                                           |
| Est. device audio LOC                              | ~4,100 (+M5Unified mic path)                                           | ~400                                                                                                      | ~250 (+ctl)                                             | ~450 (+AEC ~150)                                      |

## 7. Mechanisms worth adopting (paths, symbols, URLs)

All ESP-IDF paths relative to `/Users/jonastemplestein/esp/esp-idf` (v5.4.2).
Doc URLs are the versioned official pages
(`https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/...`).

### 7.1 ESP-IDF I2S driver, used as designed

- **Blocking write as the pacing primitive**: `i2s_channel_write()`
  (`components/esp_driver_i2s/i2s_common.c`, decl
  `include/driver/i2s_common.h`) — copies into descriptors as the driver's
  finished-buffer queue yields them; timeout in ticks; partial byte count on
  timeout. The queue depth is `dma_desc_num − 1` (`i2s_common.c:334`).
- **Deterministic start**: `i2s_channel_preload_data()`
  (`i2s_common.c:1228-1275`) — resets/refills the free-descriptor queue on
  first use, supports partial preloads, returns bytes loaded;
  `i2s_channel_enable()` starts the clock. Preload-until-full idiom:
  `examples/peripherals/i2s/i2s_basic/i2s_std/main/i2s_std_example_main.c:85-92`.
- **Cheap generation reset**: `i2s_channel_disable()` stops DMA, resets
  `dma.curr_ptr`/`rw_pos`, and resets the TX msg queue (`i2s_common.c:1194-1222`)
  → re-preload (fresh + zero-pad) → enable. Field-proven as ESPHome's underrun
  recovery (`esphome/components/i2s_audio/speaker/i2s_audio_speaker.cpp:406-444`).
- **Stale-replay immunity**: `auto_clear_before_cb` zeroes each finished
  buffer inside the ISR before callbacks (`i2s_common.c:630-632`) — already
  set by the target; this is the license to treat underrun as silence.
- **Passive EOF instrumentation**: `i2s_event_callbacks_t.on_sent` /
  `on_send_q_ovf` (`include/driver/i2s_common.h`; IRAM required,
  `i2s_common.c:396-397`) — keep the existing timestamping thunks
  (`m5sticks3_direct_audio.cpp:241-262`) as metrics-only sources; `q_ovf` is
  the driver-native starvation detector.
- **Full-duplex pair**: `i2s_new_channel(&cfg, &tx, &rx)` — one controller,
  shared clock (`include/driver/i2s_common.h:124`); reference wiring:
  `esp-skainet/components/hardware_driver/boards/esp32s3-box-3/bsp_board.c:281-287`
  and `examples/peripherals/i2s/i2s_codec/i2s_es8311/main/i2s_es8311_example.c:71-111`
  (echo task = blocking read→write loop, no delays: `:151-182`).
- Docs: `api-reference/peripherals/i2s.html`.

### 7.2 FreeRTOS / system facilities

- **Task notifications** as the only wake primitive (already used):
  `vTaskNotifyGiveFromISR`/`ulTaskNotifyTake` — cheapest signal in the kernel
  (5 bytes/TCB/slot; one kernel-lock acquisition;
  `components/freertos/FreeRTOS-Kernel/tasks.c:5719-6239`). Caveat verified:
  `CONFIG_FREERTOS_TASK_NOTIFICATION_ARRAY_ENTRIES` defaults to **1**, and
  stream buffers + esp_timer internally use index 0 — a reason to keep
  avoiding stream buffers on notified tasks (§8).
- **Task Watchdog user handles as deadline-miss detectors**:
  `esp_task_wdt_add_user`/`esp_task_wdt_reset_user`
  (`components/esp_system/task_wdt/task_wdt.c:681-741`), ms-resolution via
  `esp_task_wdt_init`, weak `esp_task_wdt_isr_user_handler` hook
  (`include/esp_task_wdt.h:174-180`). One user handle per audio stage
  replaces bespoke deadline machinery; note the all-subscribers-must-reset
  semantic (`task_wdt.c:101-110`).
- **Tick rate**: raise `CONFIG_FREERTOS_HZ` to 1000 (ADF VoIP and esp-box
  do); at 100 Hz `pdMS_TO_TICKS(<10 ms)` truncates to 0
  (`include/freertos/projdefs.h:46`) and every bounded wait quantizes to
  10 ms. Also measure 240 MHz (`CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ=240`; every
  Espressif voice reference runs 240).
- **Core hygiene**: pin the control network task to core 0
  (`itx_transport.c:71` currently core 1); optionally pin lwIP to core 0
  (`CONFIG_LWIP_TCPIP_TASK_AFFINITY`) per the official guidance that prio ≥19
  pinned core 1 is then never preempted by built-ins
  (`docs/en/api-guides/performance/speed.rst:196-265`). Allocate the I2S
  channel from the pinned audio task so its interrupt lands on core 1
  (`esp_intr_alloc.h:123` — already done today; keep).
- **lwIP sizing**: `CONFIG_LWIP_TCP_SND_BUF_DEFAULT` 5760 means only ~4
  frames (~80 ms) of un-ACKed uplink before `select()` blocks
  (`TCP_SNDLOWAT` math, `lwip/src/include/lwip/opt.h:1400-1419`); raise for
  RTT ≳80 ms paths. `TCP_NODELAY` already set on the PCM socket — keep a
  config regression (Nagle otherwise holds each 640 B frame one RTT,
  `lwip/src/include/lwip/priv/tcp_priv.h:100-105`).

### 7.3 ESPHome mechanisms (field-proven on this exact SoC)

- Speaker task shape + underrun re-prime + `on_sent` position timestamps:
  `esphome/components/i2s_audio/speaker/i2s_audio_speaker.cpp:245-468,692-711`.
- Capture task shape (blocking 16 ms reads, prio 23, synchronous memcpy
  fan-out): `esphome/components/i2s_audio/microphone/i2s_audio_microphone.cpp:346-378`.
- The ring-buffer primitive pair — drop-oldest `write()` for capture-side
  freshness vs lossless `write_without_replacement()` for playback:
  `esphome/core/ring_buffer.{h,cpp}` (wraps IDF `RINGBUF_TYPE_BYTEBUF`).
- Reset-don't-drain staleness at every state transition
  (`voice_assistant.cpp` `clear_buffers_()`), and the priority ladder
  (capture 23 > playback 19 > inference 3 > decode 1).
- Docs: https://esphome.io/components/speaker/i2s_audio.html

### 7.4 ESP-ADF / esp-sr (numbers and the AEC contract; adopt patterns, not the framework)

- VoIP tuning constants as calibration for a 20 ms lane: element rb = 1 frame
  (20 ms), network jitter rb = 3 frames (60 ms, drop-newest on overflow —
  prefer baresip's drop-oldest), AEC reference rb = 8 frames (160 ms), audio
  tasks prio 21 split across cores
  (`esp-adf/examples/protocols/components/av_stream/av_stream.c:295,547,551,410,557`).
- Stock i2s_stream underrun policy = bounded block then **write zeros and
  keep going** (`esp-adf/components/audio_stream/i2s_stream_idf5.c:528-551`)
  — corroborates silence-not-teardown.
- `i2s_stream_sync_delay()` (`i2s_stream_idf5.c:729-745`) — the
  reference-delay alignment idea for AEC tuning.
- esp-sr v2.4.7 AEC: standalone `aec_create(16000, 4, 1, mode)` /
  `aec_process(in, ref, out)` (`esp-sr/include/esp32s3/esp_aec.h:39-141`),
  no model partition needed; **the library creates no tasks** (verified
  across all 11 blobs — feed/fetch run in caller tasks;
  `esp_afe_sr_iface.h:100-124`); chunk 512 samples (SR/FD) or 256 (VOIP);
  SR_LOW_COST ≈18.8 KB internal + 64 KB PSRAM, 7.2% CPU; FD_LOW_COST
  ≈30.9 KB + 90 KB, 19.6%
  (`esp-sr/docs/en/acoustic_echo_cancellation/README.rst:138-184`). Only
  VOIP modes carry a built-in delay estimator (TDE objects in
  `libesp_audio_processor.a`); SR/FD misalignment must fit the adaptive
  filter — plan the calibratable reference-delay ring (exp-02 already has
  one). Docs: https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/audio_front_end/README.html
- Reject the pipeline framework itself (§8), but note ADF's own WS voice
  agent keeps the WebSocket **outside** the pipeline and bridges with
  callbacks (`esp-adf/examples/ai_agent/coze_ws_app`), validating the kit's
  custom-WS-client direction.

### 7.5 baresip and in-house prior art

- **aubuf downlink policy** (reimplement, ~30 lines):
  prime-to-`wish`; underrun → emit silence + re-prime to `wish`; overrun →
  drop **oldest**; live-startup trim to `wish`; `or/ur` counters
  (`baresip/re/rem/aubuf/aubuf.c:241-395`). Defaults: play buffer 20-160 ms
  (`baresip/src/config.c:54`).
- **TX discipline**: absolute-deadline ticker; on underrun **skip the packet
  and advance the timestamp** — never ship old mic audio late; timestamps by
  sample counting (`baresip/src/audio.c:853-913,388-399`). The kit's uplink
  conductor already approximates this; keep that semantic through any
  simplification.
- **Drift policy**: RFC3550 jitter EMA + adapt only after ≥3 late packets +
  ±20 ms re-anchor over a 10 s window (`baresip/src/jbuf.c:326-407`) — the
  entire drift answer is ~45 lines and involves no resampling. Relevant when
  provider-clock-vs-codec-clock drift eventually surfaces in 10-minute runs.
- **iterate/stackchan experiment 02**: device-clocked duplex `audio_task`,
  bounded StreamBuffers, barge-in = `xStreamBufferReset`, DMA-tap face feed,
  shrunk ISR queues with reasoning in-source
  (`firmware-ws/main/audio_pipeline.c:44-50,610-681,1214-1219`), the
  3-channel AEC capture/validation contract (`docs/aec-validation.md`), and
  the three pluggable face drivers the goal doc asks about
  (`face_animator.c` envelope, `face_viseme.c` MFCC/Gaussian,
  `face_spectral.c` Goertzel). This is in-house proof that the simple shape
  meets the product's own quality bar.

## 8. Mechanisms that look attractive but should be rejected

1. **`esp_websocket_client` for any realtime lane** — already decided for
   PCM; this review adds source-verified reasons to keep it away: send holds
   the same recursive lock RX needs for up to `network_timeout_ms` (10 s
   default), so uplink head-of-line-blocks downlink
   (`esp-protocols/components/esp_websocket_client/esp_websocket_client.c:692-784,1191-1392`);
   `WEBSOCKET_TX_LOCK_TIMEOUT_MS` is passed as **ticks** (250 "ms" = 2.5 s at
   100 Hz, `:1121,1290,1343`); the "fix", `SEPARATE_TX_LOCK=y` (still set in
   `sdkconfig.defaults:15`), drives one `mbedtls_ssl_context` from two tasks
   with `CONFIG_MBEDTLS_THREADING_C=n`; zero-byte transport writes abort the
   connection (`:742-766`). Plan its retirement from the control lane too
   (deferred, §10).
2. **`esp_timer` as an audio pacer** — the callback task is priority 22 on
   core 0, serialized, and the default periodic-timer policy on lateness is
   **burst catch-up** (`components/esp_timer/src/esp_timer.c:412-422,456-463`);
   its interrupt is fixed at level 1 on S3. If a hardware tick is ever
   needed, use gptimer (auto-reload in ISR, configurable priority,
   `components/esp_driver_gptimer/src/gptimer.c:441-474`) — but Architectures
   A-C need no timer at all: the DMA/codec clock paces.
3. **FreeRTOS stream/message buffers for the PCM lanes** — strict
   single-reader/single-writer with assert-only enforcement, **partial
   reads/writes** (no framing), and internal use of task-notification index 0
   which collides with the firmware's own notify usage
   (`components/freertos/FreeRTOS-Kernel/stream_buffer.c:39-53,919,1185,68-197`).
   The existing `spsc_ring` is strictly better for framed slots; IDF
   `esp_ringbuf` NOSPLIT + `SendAcquire`/`SendComplete` is the only
   comparable alternative (zero-copy, framed, event-list-based —
   `components/esp_ringbuf/ringbuf.c:984-1031`) and still buys nothing over
   `spsc_ring`.
4. **The ADF pipeline framework on-device** — task-per-element (3.5-8 KB
   stack each), 8 KB default inter-element rbs (256 ms at 16 kHz),
   malloc-heavy config, opaque lifecycle, **no WebSocket element exists**,
   and Espressif's own realtime WS agent bypasses the pipeline for network
   I/O. Mine its examples for constants; do not adopt the framework.
5. **PSRAM anywhere in the realtime path** — DMA descriptors cannot live in
   PSRAM on S3; `MALLOC_CAP_SPIRAM|MALLOC_CAP_DMA` does not even match a heap
   in v5.4.2 (`components/esp_psram/esp_psram.c:392`,
   `components/esp_hw_support/dma/esp_dma_utils.c:161-169` — the docs page
   claiming otherwise is wrong); PSRAM becomes unreachable exactly during
   flash-cache-off stalls. Internal DRAM for rings/scratch (as today) is
   correct; PSRAM is fine for the _host-facing_ diagnostics only.
6. **M5Unified Speaker/Mic for the realtime path** — resampler always-on,
   ~93 ms hidden DMA + zero-flush tail, priority-2 unpinned tasks,
   producer-blocking as the queue bound, `playRaw` returning true on failure
   (`Speaker_Class.cpp:1044`), per-`begin()` spurious full reinit and up to
   ~32 ms of stale RX DMA on PTT resume with no flush
   (`Mic_Class.cpp:712-724,587-604`) — the last one is a stale-audio-replay
   violation on uplink by itself. Keep M5Unified for button/display/PMIC
   only. (Two of its internals are worth copying, not calling: the idle
   zero-flush-then-park pattern, `Speaker_Class.cpp:555-577`, and
   control-by-descriptor stop.)
7. **Host-side hard media-clock enforcement** — §4 H-A and §6.5. Pacing
   evidence: yes; pacing enforcement with session-fatal classification
   against an in-process socket with no backpressure signal: no.
8. **Descriptor-identity ledgers and poison protocols** — Knot 1. The driver
   API (write/preload consuming its own ordered queue) plus
   `auto_clear_before_cb` plus `on_send_q_ovf` already provide every
   guarantee the ledger proves, at zero lines.
9. **Half-duplex as hardware ownership transfer** — Knot 4. Policy bit, not
   channel lifecycle.
10. **A second "adaptive jitter buffer" research project** — baresip deleted
    its adaptive aubuf module; the shipped policy is fixed-window with
    event-driven headroom bumps. Start fixed (2-frame wish, generous max,
    drop-oldest); add the 3-late-packets rule only when 10-minute-run
    evidence demands it.

## 9. Recommended migration sequence

Ordered so every step keeps the vertical proofs green (38 host C tests, 88+
TS tests, the physical smoke), introduces red tests before behavior changes,
and can stop at any boundary with the system no worse than today. The
endurance harness itself is playback-implementation-agnostic (it consumes
device metrics + Mac capture) and survives unchanged apart from the metric
contract in step 6.

1. **Close the diagnosis loop on the 127 ms failure first (no behavior
   change).** Wire the just-landed `onSocketClose` provenance into
   `local-device-peer-server.ts` / `device-e2e.ts` so a proxy close is
   _retained_, not converted into a run abort; add the missing TS parse
   branch for `subscribeToPlaybackMetrics` (or explicitly park it — see
   step 6); then re-run a **5-10 s** tone. This adjudicates H-A vs H-B vs
   H-C/D from §4 with data. Red test that exists already and should be made
   real-clock: the composed 60 s proxy regression re-run without fake timers
   (expect it to fail against the current underrun-kill — that failure _is_
   the finding).
2. **One-line/config hardening with pinned regressions (independently
   shippable).** Control task to core 0; `CONFIG_FREERTOS_HZ=1000`;
   240 MHz measured A/B; `WIFI_PS_NONE` regression; delete
   `CONFIG_ESP_WS_CLIENT_SEPARATE_TX_LOCK=y`. Each gets a
   config/`firmware-architecture.test.ts`-style assertion first.
3. **Host relay simplification (§6.5), red-first.** New proxy tests: provider
   burst larger than the ring → oldest dropped + counter + session alive;
   real-clock pacing lateness → no close; overflow classifications become
   counters. Delete the watermark/underrun-kill/pacer-enforcement/Blob-
   mailbox/bufferedAmount tests _with_ the code they pin. Keep rechunk, EOS,
   PTT fence, suppression, provenance tests verbatim. This can land before
   any firmware change and removes the H-A failure mode.
4. **Device substrate + Architecture A behind a target switch.**
   - 4a. Red host tests for the new `PlaybackWriter` policy against a fake
     blocking driver (6 calls): partial-prebuffer start + zero-pad; underrun
     → silence counter, resync threshold → disable/preload/enable; freshness
     drop-oldest trim; EOS drain; flush; counter contract. Reuse the lane
     tests as-is.
   - 4b. Red host tests for the capture loop (scripted `i2s_channel_read`
     fake): PTT gating, freshness at submit, no M5Unified.
   - 4c. Implement on the duplex substrate (§6.1) with the es8311 registry
     driver; keep the old path compiling behind `ITERATE_KIT_AUDIO=fortress`
     until step 7.
   - 4d. Physical A/B with the existing short-run harness: 10 s tone, then
     PTT loop. New red physical assertions: ≥100 PTT cycles with **zero
     channel deletes** (assert via a new counter) and capture continuity
     across every transition; no first-frame loss on generation flush.
5. **Uplink path consolidation.** Keep sender semantics (retain-exact-frame
   on deferral, bounded restart, never-head-drop-silently) and the guard's
   _concept_; fix the H-B trap: the idle probe must not demand evidence the
   transport cannot carry — either (a) verify captun/tunnel pong-echo
   end-to-end and pin it with a host test, or (b) count proxy-originated
   control-lane heartbeats as peer evidence. Collapse the
   conductor/sender/guard triple's three time-normalization policies into
   one shared helper with per-boundary counters (Knot 8).
6. **Metric contract rebuild (breaking, by design).** Define the new device
   counter set (~12 playback + existing uplink/transport + TWDT stage
   misses), name the mapping old→new explicitly in the contract doc, update
   `kit-device-contract.ts` + `device-runtime-log.ts` + the endurance
   required-metrics list in one PR, and delete the 44-name judge entries that
   reference fortress-only counters. The `zeroErrorMetrics` gate keeps its
   role but over the new, smaller vocabulary; add `downlink_dropped_oldest`
   and `underrun_silence_frames` as _bounded-nonzero_ (budgeted) rather than
   zero-required, per the evidence doc's own "named drop with a counter"
   requirement.
7. **Delete the fortress** (realtime_playback / stereo-output wrapper /
   descriptor backend / owner-control mailboxes / bounded_capture +
   M5Unified mic glue / dead modules per §10), with their tests. This is the
   step that removes ~4-5 k lines and the 9 latches.
8. **Endurance ladder** exactly as specified in the evidence doc: 1 → 2 → 10
   minutes, idle then under capability-churn load, PRBS/dual-carrier
   challenge added so periodic-tone blindness cannot hide skips — unchanged
   harness, new device.
9. **StackChan tranche**: adopt Architecture C on the duplex substrate;
   re-block 320→512; `aec_create(16000, 4, 1, AEC_MODE_SR_LOW_COST)` first
   (cheapest), FD mode if interruption quality demands NLP; calibratable
   reference-delay ring; exp-02's 3-channel capture contract as the physical
   AEC rig. Half-duplex Stick and full-duplex StackChan then share every
   line of the audio path except the mode policy and the AEC stage.

## 10. Keep / simplify / delete / defer

| Module                                                                               | Disposition                          | Rationale                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spsc_ring.c`                                                                        | **Keep**                             | correct, minimal, ISR-compatible; the system's best primitive                                                                                                                             |
| `pcm_lane.c`                                                                         | **Keep**                             | fragmented-reassembly-into-slot + EOS-in-band are right; unchanged under A/B/C                                                                                                            |
| `websocket_frame_writer/tx/rx.c`, `websocket_connection.c`                           | **Keep**                             | the owned PCM client is the correct direction; NODELAY/nonblocking already right                                                                                                          |
| `retry_gate.c`, `configuration.c`, `device_events.c`, `peer.c`, itx/capnweb stack    | **Keep**                             | out of audio scope; fix `peer_poll` first-error-starves-audio ordering when touched                                                                                                       |
| `pcm_uplink_sender.c`                                                                | **Keep, trim**                       | retain exact-frame deferral + bounded restart + freshness; fold its private clock-normalizer into the shared one                                                                          |
| `pcm_peer_delivery_guard.c`                                                          | **Simplify**                         | keep barrier-PING concept + confirmation-age; fix idle-probe evidence path (H-B); cut the policy count (interval/hard-window/delay/age/probe×2 → interval + age + probe)                  |
| `pcm_uplink_conductor.c`                                                             | **Simplify**                         | fairness bound + composition stays; delete its third time-normalization; likely mergeable into the transport loop after mailboxes go                                                      |
| `pcm_transport.c`                                                                    | **Simplify**                         | drop-oldest instead of reconnect on ring-full; delete barrier polling once flush is a direct lane+writer call; single restart path; make start retryable (un-latch Knot 5's blast radius) |
| `itx_transport.c`                                                                    | **Simplify (deferred)**              | core-0 pin now; single backoff; `esp_websocket_client` retirement is a later tranche                                                                                                      |
| `audio.c` (controller)                                                               | **Simplify**                         | PTT becomes two policy bits + amp/mute calls; `playback_flush_pending` latch and triple-suspend collapse away                                                                             |
| `capabilities/metrics.c`                                                             | **Simplify**                         | serialize the new ~12-counter playback set; stop computing-then-dropping 14 fields                                                                                                        |
| `realtime_playback.hpp`                                                              | **Delete** (step 7)                  | replaced by ~200-line writer policy; its genuinely good ideas (freshness age, EOS-in-band, generation fence, saturating counters) survive in the writer                                   |
| `direct_i2s_stereo_output.hpp`                                                       | **Delete**                           | stereo expansion survives as one function; descriptor tokens/poison do not                                                                                                                |
| `esp_idf_direct_i2s_backend.hpp`                                                     | **Delete**                           | replaced by ~80-line ops (create-once, preload, blocking write, disable/enable, amp) + passive ISR metrics                                                                                |
| `realtime_owner_control.hpp` (mailboxes)                                             | **Delete**                           | no cross-task hardware rendezvous remains on the duplex substrate                                                                                                                         |
| `bounded_capture.hpp` + M5Unified mic glue                                           | **Delete** (after 4c)                | replaced by the blocking-read capture task                                                                                                                                                |
| `bounded_playback.hpp`, `display_refresh_gate.hpp`                                   | **Delete now**                       | dead code, zero production references, contradicts the live model                                                                                                                         |
| `runtime_diagnostics.c`                                                              | **Delete now** (or consciously wire) | 505 lines / 67 fields compiled and never instantiated                                                                                                                                     |
| Host `device-pcm-proxy.ts` pacer/watermark/underrun-kill/Blob-mailbox/bufferedAmount | **Delete** (step 3)                  | §6.5; keep rechunk/EOS/fence/suppression/provenance                                                                                                                                       |
| `pcm-frame-pacer.ts`                                                                 | **Keep (demoted)**                   | still correct for the tone _provider fixture's_ self-pacing; no longer a proxy enforcement mechanism                                                                                      |
| `subscribeToPlaybackMetrics` TS contract                                             | **Defer, then rebuild**              | build it once against the new counter set (step 6), not the fortress's 44 names                                                                                                           |
| microSD outer sink                                                                   | **Defer**                            | unchanged from evidence doc                                                                                                                                                               |
| AEC / full-duplex StackChan                                                          | **Defer to step 9**                  | on Architecture C; esp-sr standalone AEC, no ADF                                                                                                                                          |

## 11. Closing note on the review discipline

The goal document asks reviewers to hunt for "a substantially simpler
architecture rather than local cleanup" and for "tests that pass only because
the difficult real behavior is absent." Both are present findings: the
simpler architecture is the one every shipped comparable uses (§5-§6), and
the flagship composed regression is green under fake timers against a policy
that has ~12.5 ms of real-world slack (§4 H-A). The current system's genuine
achievement — its evidence discipline and host-testability — is fully
portable to the simpler design; nothing about provability requires the
fortress. What the fortress actually purchased was certainty about
micro-invariants of a driver whose macro-behavior was never allowed to do its
job.

Sources: see §0. Primary trees inspected: this repo (`apps/kit` firmware +
host), `~/esp/esp-idf` (v5.4.2), `~/src/github.com/espressif/{esp-adf,
esp-protocols, esp-sr, esp-box, esp-skainet}`,
`~/src/github.com/esphome/{esphome, home-assistant-voice-pe}`,
`~/src/github.com/m5stack/{M5Unified, StackChan, StackChan-BSP}`,
`~/src/github.com/iterate/stackchan`, `~/src/github.com/baresip/{re, baresip}`.
