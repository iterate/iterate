All research complete. Here is the full report.

---

# esphome-intercom realtime-audio study (for our ESP32-S3 kit firmware)

## 0. Branch situation and where the code actually lives

`audio-core-v2` does not exist anywhere in the org. `git ls-remote` on `n-IA-hane/esphome-intercom` shows only `dev`, `main`, PR heads, and tags. The name almost certainly refers to the **"audio core"** — a family of files literally named `audio_core_*.{h,cpp}` — which lives in a **sibling repo**, `n-IA-hane/esphome-audio-stack`, that the intercom YAMLs pull in as an external component (`audio_stack_components_source: "../../../../esphome-audio-stack/esphome/components"`, `yamls/full-experience/single-bus/generic-s3-full-aec.yaml:43,152-153`). I studied `dev` of all four repos, now cloned at:

- `/Users/jonastemplestein/src/github.com/n-IA-hane/esphome-intercom` (dev, `51e28fa`) — device YAMLs, forked `speaker`/`voice_assistant`/`ring_buffer` ESPHome components, HA `voip_stack` custom component (Python)
- `/Users/jonastemplestein/src/github.com/n-IA-hane/esphome-audio-stack` (dev, `d03a546`) — **the audio core**: `esp_audio_stack` (I2S owner + realtime task), `esp_aec` (standalone ESP-SR AEC), `esp_afe` (full AFE pipeline)
- `/Users/jonastemplestein/src/github.com/n-IA-hane/esphome-voip-stack` (dev) — device-side call/media component (`voip_stack`): SIP/RTP transport, TX/RX media tasks, jitter buffer
- `/Users/jonastemplestein/src/github.com/n-IA-hane/esphome-runtime-controller` (dev)

All paths below are absolute-relative to those roots; `audio_pipeline.cpp` means `esphome-audio-stack/esphome/components/esp_audio_stack/audio_pipeline.cpp`.

## 1. Audio task architecture

**One permanent, parked realtime task.** A single FreeRTOS task `"audio_stack"` is created once in `setup()` and never destroyed (`esp_audio_stack.cpp:399-411`). Rationale in the comment: creating it at boot "reserves the stack/TCB before Wi-Fi/API/VA/MWW churn can fragment internal RAM, and removes xTaskCreate from the first wake-word/audio activation path." Defaults (`esp_audio_stack.h:811-813`):

```cpp
uint8_t task_priority_{19};  // Above lwIP(18), below WiFi(23)
int8_t  task_core_{0};       // Core 0: canonical Espressif AEC pattern; -1 = unpinned
uint32_t task_stack_size_{8192};
```

The task body is a two-level loop (`audio_pipeline.cpp:512-547`): the outer `audio_task_()` parks on `ulTaskNotifyTake(pdTRUE, portMAX_DELAY)` when `audio_stack_running_` is false, services deferred requests (buffer prealloc, speaker-ring reset), and notifies any `audio_state_waiter_`; the inner `audio_session_()` runs one session and returns on stop **or on processor frame-spec change** so the outer loop re-enters with fresh geometry.

**Cadence is DMA-owned, not timer-owned.** There is no `vTaskDelay` in the loop; blocking `i2s_channel_read/write` (or `esp_codec_dev`) with `portMAX_DELAY` paces the loop (`audio_pipeline.cpp:956-958,1576`). The closing comment is explicit (`audio_pipeline.cpp:917-919`):

```cpp
// RX/TX cadence is owned by the blocking codec/I2S DMA operations above.
// Do not append a tick-based delay: it compounds frame latency (especially
// at a 100 Hz FreeRTOS tick) and vTaskDelay is not a cross-core clock.
```

**Frame sizes.** Without a processor: `DEFAULT_FRAME_SIZE = 256` samples = **16 ms @ 16 kHz** (`audio_pipeline.cpp:45`). With ESP-SR attached, the processor dictates the frame via `frame_spec()` (typically 512 samples = 32 ms at 16 kHz; the log at `audio_pipeline.cpp:586-591` prints "`(%ums @ %uHz)`"). The I2S bus frame is `input_frame_size * ratio` for multi-rate setups (48 kHz bus → 16 kHz processing, `audio_pipeline.cpp:612`).

**The snapshot pattern — verbatim** (`audio_pipeline.cpp:790-816`): every per-frame-mutable atomic is read exactly once per frame into a plain-struct `AudioTaskCtx`, and the frame body uses only the snapshot:

```cpp
// Snapshot atomic state for this frame (avoids repeated .load() in sample loops)
ctx.input_gain_q31 = this->input_gain_q31_.load(std::memory_order_relaxed);
ctx.input_gain_boost = this->input_gain_boost_.load(std::memory_order_relaxed);
ctx.mic_gain_q31 = this->mic_gain_q31_.load(std::memory_order_relaxed);
ctx.mic_gain_boost_db = this->mic_gain_boost_db_.load(std::memory_order_relaxed);
ctx.hot_output_volume_q31 = this->hot_output_volume_q31_.load(std::memory_order_relaxed);
ctx.speaker_running = this->speaker_running_.load(std::memory_order_relaxed);
ctx.speaker_paused = this->speaker_paused_.load(std::memory_order_relaxed);
ctx.mic_running = this->has_mic_consumers_.load(std::memory_order_relaxed);
...
ctx.processor_enabled = this->processor_enabled_.load(std::memory_order_relaxed);
ctx.processor_ready = ctx.processor_enabled && this->processor_ != nullptr && this->processor_->is_initialized();
ctx.now_ms = millis();
```

Notable refinements: volume arrives as a **pre-converted Q31 fixed-point value** cached on change by `update_hot_output_volume_()` (`esp_audio_stack.cpp:173-187`), "so the audio task does not spend every frame converting float→fixed" (`audio_pipeline.cpp:1696-1697`); `processor_ready` is cached in the snapshot "to avoid a virtual call per frame" (`esp_audio_stack.h:541`). `AudioTaskCtx` itself (`esp_audio_stack.h:458-558`) is partitioned by comment into "Invariants (set once at task start)", "Frame sizing", "Working buffers", "Loop mutable state", and "Per-iteration snapshots from atomics".

**Per-frame flags decide the work** (`audio_pipeline.cpp:929-941`): `need_rx_processing` (a mic consumer exists), `need_rx_drain` (RX open but nobody listening — still read the DMA queue so it can't build backpressure), `need_tx_audio`, and `clock_only_tx` (full-duplex shares clocks, so TX writes silence whenever the stack owns TX even with no playback; `process_tx_clock_only_` at `audio_pipeline.cpp:1665-1680`).

**Error escalation is counted, not immediate**: I2S read/write failures are throttled-logged and only after >100 consecutive failures latch `has_i2s_error_` and stop the session (`audio_pipeline.cpp:962-991,1580-1602`), with `INVALID_STATE` counted separately because it appears benignly during own-teardown.

**Telemetry is compile-time stripped**: the entire per-frame timing/underrun/heap block exists only when `USE_ESP_AUDIO_STACK_TELEMETRY && ESPHOME_LOG_LEVEL >= DEBUG` — "zero runtime cost" otherwise (`audio_pipeline.cpp:667-680,859-915`). When on, it reports frame-interval avg/max, underruns, AFE feed/fetch counters and queue peaks every N frames.

## 2. AEC integration (ESP-SR AFE)

Two interchangeable processors implement one interface, `AudioProcessor` (`audio_core_processor.h:66-118`): `EspAec` (standalone `afe_aec_*`, AEC only) and `EspAfe` (full AFE: AEC+NS+VAD+AGC+SE, via ESP-SR direct path for single-mic or the GMF manager for dual-mic).

**Task topology and placement.** The realtime audio task (prio 19, core 0) calls `processor_->process()` inline; ESP-SR's own workers are configured onto **core 1** away from it (`esp_afe.h:388-396` defaults: esp-sr internal task core 1 prio 5; feed task core 0 prio 5; fetch task core 1 prio 5; all YAML-tunable). Passed straight into the Espressif configs at `esp_afe.cpp:332-334` (`cfg->afe_perferred_core/priority`) and `esp_afe.cpp:407-412` (GMF `feed_task_setting`/`fetch_task_setting`). The single-mic direct path creates its own `"afe_fetch"` worker with `xTaskCreateStaticPinnedToCore` on a heap-provided static stack (`esp_afe.cpp:1940-1963`).

**process() is a bounded, non-blocking bridge, never a DSP call** (`esp_afe.cpp:1435-1643`). Step 1 stages the interleaved `[mic, ref]` frame — ideally straight into a NOSPLIT ring slot to skip a copy (`gmf_direct_frame`, `esp_afe.cpp:1540-1554`) — and feeds when a full AFE chunk is assembled. Step 2 does a zero-timeout read of `fetch_output_ring_`; **on miss it emits silence, never raw mic**:

```cpp
// Step 2: ... Non-blocking: if nothing is ready we emit silence,
// never raw pre-AFE mic. MWW, VA and call components must only see processed
// AFE output while this component is active.   (esp_afe.cpp:1612-1615)
```

The same fail-closed rule appears in the consumer: a configured-but-unavailable processor zero-fills output during init/teardown/realloc failure (`audio_pipeline.cpp:1286-1297`).

**The fetch worker is fully event-driven** (`esp_afe.cpp:1902-1938`): parked on a task notification between activations; inside an activation it blocks on a **counting semaphore given by each successful feed** — "A feed completion owns the cadence of this worker. Do not wake on a timer merely to discover that no frame arrived" — and `stop()` gives the same semaphore, "so both data and lifecycle changes are events." Stop/start uses a quiesce handshake (`direct_fetch_quiesced_` + stop-waiter notification + draining leftover semaphore tokens so stale tokens can't trigger fetches on restart, `esp_afe.cpp:1985-2028`).

**Reference-signal handling — three modes**, selected in YAML (`esp_audio_stack/__init__.py:476-482`):

1. **Hardware reference**: stereo I2S loopback (ES8311 digital feedback, "sample-aligned", `esp_audio_stack.cpp:1434-1436`) or a dedicated TDM slot — the ref arrives interleaved in RX and is deinterleaved alongside the mic (`process_rx_stereo_ref_`/`process_rx_tdm_`, `audio_pipeline.cpp:1043-1110`). "Hardware-synced reference, no speaker gating needed" (`audio_pipeline.cpp:1301`).
2. **`ring_buffer`** (Espressif/ADF TYPE2 software reference): each TX frame is decimated to the processor rate **on the TX side** and pushed into a small ring (default 80 ms, `esp_audio_stack.h:775`); the AEC pops one ref frame per mic frame (`fill_mono_aec_reference_`, `audio_pipeline.cpp:1439-1464`).
3. **`previous_frame`**: keep just the last converted TX frame as the ref — lighter, one-frame-delay assumption (`audio_pipeline.cpp:1783-1797`).

Two hard-won correctness rules on the TX ref path (`audio_pipeline.cpp:1728-1737`): the reference is saved **only from complete frames** — "Decimation only runs on a complete frame … otherwise the converter state would absorb zero-padding and pollute the next valid frame's reference for ~32 samples"; and partial ring reads count as underrun so a half-real/half-silent frame is never used as reference — "otherwise the AEC adaptive filter sees a half-real / half-silent signal and fails to correlate with the mic" (`audio_pipeline.cpp:1689-1693`).

**About the claimed "only run AEC when speaker active in last ~250 ms" trick: it is not in this code.** I searched all four repos; no time-based AEC gating exists on `dev`. The current design is deliberately the opposite — when playback is idle the ref is zero-filled and the processor still runs, so consumers never flip between processed and raw surfaces (`audio_pipeline.cpp:1354-1363`: "When playback is idle, fill*mono_aec_reference*() zero-fills the ref and we still call the processor"). The real activity-gating that does exist operates at a coarser level: (a) `set_processing_active(false)` parks the whole AFE (GMF jobs + esp-sr worker) when the last mic consumer leaves — added because the idle AFE "was monopolising CPU1 long enough to trip the loopTask 30s watchdog" (`esp_audio_stack.cpp:1569-1581`); (b) the ref ring is reset on every mic-session edge so playback history can't misalign AEC (`audio_pipeline.cpp:800-809`). If a 250 ms gate existed historically, it has been engineered away in favor of "always run, fail closed".

**AEC lifecycle safety** (`esp_aec.cpp`): HIGH_PERF modes get a pre-flight check for contiguous DMA-capable internal RAM (40 KB per 4 filter taps) because "esp-sr HIGH_PERF modes silently calloc the FFT cos/sin tables … and return a half-init handle on OOM, which then crashes process() with LoadProhibited" (`esp_aec.cpp:34-48,82-97,243-256`). Mode switches build the **new handle first and roll back on failure** (`esp_aec.cpp:258-282`). `process()` takes the handle mutex with a **0-tick timeout** — on contention it outputs silence rather than blocking the audio task (`esp_aec.cpp:168-187`).

**Lock-free drain protocol for reconfig vs hot path** (`esp_afe.h:92-105,407-419`, `esp_afe.cpp:1441-1451`): `process()` publishes `process_busy_` (seq*cst), checks `drain_request*`, and bails with silence; the config path flips `drain*request*`, waits for `process*busy*`to clear, then tears down/rebuilds. The header documents why seq_cst: "release/acquire on different atomics would allow both cores to observe false and enter teardown/process concurrently." Mode changes are queued to a dedicated`"afe_reinit"`task (prio 4, core 0,`xQueueOverwrite` depth-1 latest-wins) so the ESPHome main loop never blocks on a ~70 ms rebuild (`esp_afe.cpp:1662-1743`; the 70 ms figure is in `FeatureControl::RESTART_REQUIRED`, `audio_core_processor.h:23`).

## 3. Ring buffer design

**`CapsRingBuffer` — placement-audited rings** (`audio_core_ring_buffer_caps.h`). Wraps ESPHome's ring buffer with caller-controlled heap caps and two policies: `INTERNAL` ("always internal RAM. Use for anything in the audio hot path") and `PREFER_PSRAM` (fallback to internal). Every creation logs name/size/policy/**verified actual placement** via `esp_ptr_internal` — "This makes memory policy auditable at boot" (`:21-34,225-229`). A NOSPLIT variant provides frame-atomic queues for the AFE bridge.

**Sizes** are duration-based, not magic byte counts:

- Speaker ring: `bytes_per_second * buffer_duration_ms` (default 500 ms), min 2048 B, PREFER_PSRAM — justified inline: "staging buffer between API play() and the i2s write path, not realtime-critical itself (the task drains it at priority 19)" (`esp_audio_stack.cpp:374-390`).
- AEC ref ring: default 80 ms at processor rate, min 4 frames; placement YAML-switchable with measured tradeoffs: "internal saves ~13.6 us/frame on Core 0 (R+W ~1 KB each), PSRAM saves ~3-5 KB internal RAM" (`audio_pipeline.cpp:406-414`).
- AFE feed ring ~12 KB / fetch ring ~4 KB, defaults internal, with measured per-frame deltas in the comments (`esp_afe.h:400-403`).

**Overflow semantics differ by role, deliberately.** The speaker ring uses `write_without_replacement` so a full buffer pushes backpressure up to the ESPHome pipeline (`esp_audio_stack.cpp:1653`), and `play()` trims to whole PCM frames — "a partial must never split an interleaved PCM frame" (`:1643-1651`). The AEC ref ring uses drop-oldest `write()` — "which is the right backpressure here: keep the most recent reference window" (`audio_pipeline.cpp:1776-1779`). The VoIP mic TX ring keeps the newest audio and counts every dropped frame (`voip_audio.cpp:114-143`).

**Reset is a request flag, never a cross-thread call.** `stop_speaker()` just sets `request_speaker_reset_` (`esp_audio_stack.cpp:1622`); the audio task services it at loop-top/park points via `service_speaker_reset_()` (`:263-278`), which also invalidates the AEC ref state. So reset happens only at frame boundaries, on the owning task — "avoids concurrent access."

**Surviving Wi-Fi spikes** is layered: the audio task never blocks on the network; the VoIP TX queue is intentionally tiny when `esp_audio_stack` owns realtime buffering — only 6 frames: "Keep only enough VoIP queue to bridge scheduler jitter into the network task" (`voip_audio.cpp:69-79`); TX is capture-clocked, draining every complete frame on mic-callback notification with no timer ("cadence jitter belongs in the receiver jitter buffer, not a TX timer", `voip_audio.cpp:161-174`); and the RX side absorbs jitter in a fixed-slot sequence-indexed `RtpJitterBuffer` (16 slots max, prebuffer, window realign on large sequence jumps, late/missing/duplicate counters, `rtp_jitter_buffer.h:126-249`) with the playout task clocking **silence into I2S after a 60 ms gap** so the sink never stalls or pops (`kRxSilenceAfterMs = 60`, `voip_stack.h:89`; `voip_audio.cpp:367-414`).

## 4. Mode switching (listening / speaking / duplex)

The core has no modal state machine; it derives the mode per frame from two orthogonal facts — _are there mic consumers_ and _is the speaker running/paused_ — snapshotted from atomics (§1). Transitions:

- **Consumer registry** (`esp_audio_stack.cpp:1493-1592`): consumers (microphone wrapper, call TX, MWW…) register opaque tokens under a FreeRTOS mutex; the _edge_ actions (first-in: start stack + wake processor; last-out: park processor, stop stack if no playback) happen outside the lock. Registration survives internal stop/start cycles so a frame-spec-driven session restart doesn't drop consumers (`esp_audio_stack.h:347-351`).
- **stop() is deferred**: it only flips atomics and sets `teardown_pending_`; `loop()` deletes I2S channels once `audio_task_idle_` is observed — "polling audio*task_idle* here would block the main task for up to 600 ms … starving network/UI/LVGL" (`esp_audio_stack.cpp:1471-1474,477-482`). `start()` first completes any pending teardown, refusing to restart on a half-closed bus (`:1384-1397`).
- **Park/wake handshake**: waiters register a task handle in `audio_state_waiter_` and the audio task notifies on both park and wake edges (`wait_audio_task_state_`, `esp_audio_stack.cpp:1362-1377`; task side `audio_pipeline.cpp:522-540`) — bounded waits, no polling.
- **Pause ≠ stop**: a paused speaker zero-fills TX but "must not drain speaker*buffer*" (`audio_pipeline.cpp:1717-1721`).
- **Processor graph changes** (SR↔VC↔FD, feature toggles) ride the `frame_spec_revision()` counter: the audio session notices mid-loop and restarts itself with fresh geometry, and because buffers are worst-case preallocated "the restart does not touch the heap" (`audio_pipeline.cpp:833-856`).
- **Call level** (`voip_stack`): a `CallState` FSM plus `audio_devices_active_`; the TX/RX media tasks spin only when `IN_CALL` and otherwise park on notifications (`voip_audio.cpp:150-158,338-343`). Half-duplex-style behavior (their analogue to PTT gating) is achieved with AFE `vad_mute_playback` and speaker pause, not by tearing the duplex pipeline down.

## 5. ESPHome component-model integration and the module boundary

The layering is unusually clean and maps directly onto our "portable host-testable core + device modules" goal:

- **`AudioProcessor` (pure-virtual header, zero ESP dependencies** — `audio_core_processor.h`) is the seam between the I2S/task owner and DSP. It carries `frame_spec()` + `frame_spec_revision()`, `process(mic, ref, out, mic_channels)`, `feature_control()/set_feature()` (with an explicit taxonomy: NOT_SUPPORTED / BOOT_ONLY / RESTART_REQUIRED / LIVE_TOGGLE), `telemetry()`, and lifecycle hints (`set_processing_active`, `wants_background_input`). Swapping AEC-only for full-AFE is a YAML `processor_id` change.
- **`esp_audio_stack`** is the singleton hardware owner: I2S/codec, the realtime task, all buffers, gain staging. It exposes a narrow consumer API: `register_mic_consumer/unregister`, `add_mic_data_callback`, `play()/start_speaker()/stop_speaker()`, state triggers.
- **Platform wrappers are thin adapters**: `microphone/esp_audio_stack_microphone.cpp` and `speaker/esp_audio_stack_speaker.cpp` only translate ESPHome's async `start()/stop()` semantics into registry calls, with counting-semaphore listener refcounts and all state transitions in `loop()` ("start() only registers interest; loop() performs the state transition", mic `:64-66`). The mic wrapper preallocates its callback vector at setup — "Do not grow this vector in on*audio_data*(): that callback runs in the parent audio task" (mic `:32-36`) — and even works around ESPHome's mute path allocating a temp vector (`:113-120`).
- **YAML → codegen → compile-time pruning**: Python config validation computes which RX/reference/TX paths a device actually needs and emits `add_define(...)` flags (`__init__.py:644-668`: `MONO_RX`, `MULTI_RX`, `STEREO_REF`, `TDM_BUS`, `RING_REF`, `PREVIOUS_FRAME_REF`, `32BIT`, `HARDWARE_CODEC`…), so each build contains only its own hot path. Cores, priorities, stack sizes, buffer durations, and every PSRAM placement decision are YAML keys, not constants.
- The intercom repo forks upstream ESPHome components (`speaker`, `voice_assistant`) with **documented minimal diffs** and an explicit upstream baseline commit + verification recipe (`esphome-intercom/esphome/components/speaker/UPSTREAM.md`, `voice_assistant/UPSTREAM.md`) — each patch has a Reason and an "Upstream path".

## 6. Memory strategy

The overarching rule: **the realtime path never allocates**; everything is placed deliberately, early, and audibly logged.

- **Worst-case preallocation on the audio task itself**: `setup()` requests prealloc via a flag + task notify; the parked task runs `preallocate_audio_buffers_from_task_()` (`audio_pipeline.cpp:640-663`) — "moves heap pressure out of the first media/call activation" (`:151-153`) while keeping heavy heap work off the ESPHome setup thread (`esp_audio_stack.cpp:413-417`). Buffers persist across session restarts: "Subsequent restarts … reuse the same pointers without any heap_caps_alloc calls, eliminating SPIRAM fragmentation that previously caused 'Failed to allocate AEC output buffer' after a few reconfigures" (`audio_pipeline.cpp:691-695`). Dual-mic capacity is allocated unconditionally when possible "so the task can flip between MR (1 mic) and MMR (2 mic) without reallocating" (`:144-148`).
- **Fail-closed on prealloc failure**: "refusing cold-path allocation" — the session refuses to start rather than allocate late (`audio_pipeline.cpp:660-661,720-724`). Similarly, a missing mono-AEC ref buffer fails the whole allocation because the AEC "would silently run with a zero reference … and stay degraded until reboot" (`:481-492`).
- **DSP handles pre-opened**: ALC, bit converters, channel converters, and rate converters are created with the rest of the graph "so a later positive mic gain never allocates from the realtime audio loop" (`audio_pipeline.cpp:234-237,186-281`).
- **Placement is a per-buffer decision with numbers attached**: hot rings internal by default, big staging rings PSRAM (`buffers_in_psram`, `aec_ref_ring_in_psram`, `feed/fetch_ring_in_psram`, each annotated with measured us/frame vs KB tradeoffs — `esp_afe.h:398-403`, `audio_pipeline.cpp:410-413`); task stacks optionally PSRAM through one helper `start_pinned_task()` that folds `xTaskCreatePinnedToCore` and static-stack creation into one audited call (`audio_core_task_utils.h:33-63`); ESP-SR itself is told `AFE_MEMORY_ALLOC_MORE_PSRAM` by default (`esp_afe.h:386`).
- **Auditability**: `log_memory_snapshot_("after_speaker_ring" / "after_audio_buffer_prealloc" …)` prints free/largest-block for internal, DMA, and PSRAM at each milestone (`esp_audio_stack.cpp:280-287`), and every ring logs its verified placement (§3).

## 7. Lessons for our firmware (portable C core + device modules, duplex AEC/VAD + PTT, PCM over websocket)

1. **One permanent parked audio task; start/stop toggles an atomic, never creates/destroys the task.** Pre-create at boot to reserve stack before network churn fragments internal RAM. (`esp_audio_stack.cpp:399-411`; `audio_pipeline.cpp:518-547`)
2. **Let blocking I2S DMA own the loop cadence; never add tick-based delays** — at a 100 Hz tick a `vTaskDelay(1)` costs 10 ms, and "vTaskDelay is not a cross-core clock." (`audio_pipeline.cpp:917-919`)
3. **Snapshot all config atomics once per frame into a context struct**; precompute hot values on _change_ (float volume → Q31; `processor_ready` cached to skip a per-frame virtual call). Our C core's frame function should take a plain `ctx` struct exactly like `AudioTaskCtx`. (`audio_pipeline.cpp:790-816`; `esp_audio_stack.cpp:173-187`; `esp_audio_stack.h:534-557`)
4. **Fail closed on the mic surface**: whenever the configured processor can't run (init, teardown, ring miss, alloc failure), emit silence — never leak raw pre-AEC mic to consumers, and never silently switch surfaces. (`esp_afe.cpp:1612-1629`; `audio_pipeline.cpp:1286-1297,1354-1363`)
5. **Bridge realtime→DSP with bounded non-blocking rings + an event-driven fetch worker** — feed completion (a semaphore give) is the fetch task's clock; stop gives the same semaphore; no polling timers anywhere. (`esp_afe.cpp:1902-1938`, staging at `:1503-1610`)
6. **Guard the DSP handle with a drain handshake, not a hot-path mutex**: `process_busy_`/`drain_request_` seq_cst pair; the hot path's only lock is zero-timeout try-lock with a silent-frame fallback. Run reconfiguration on a dedicated low-priority task with a depth-1 latest-wins queue. (`esp_afe.h:92-105,407-419`; `esp_aec.cpp:183-187`; `esp_afe.cpp:1662-1743`)
7. **Version the frame geometry** (`frame_spec_revision()`): the audio loop polls the counter and restarts its session on change, and because buffers are worst-case preallocated the restart is heap-free. This is how they make "AFE mode change mid-call" safe. (`audio_core_processor.h:100-103`; `audio_pipeline.cpp:833-856`)
8. **AEC reference discipline**: convert the TX reference to processor rate on the TX side; store/save only _complete_ frames (padding pollutes converter state for ~32 samples and decorrelates the adaptive filter); reset the ref ring on every capture-session edge; treat partial speaker reads as underrun for reference purposes. (`audio_pipeline.cpp:1728-1798,1689-1693,800-809`)
9. **Per-role overflow policy**: playback ring = no-overwrite (backpressure upstream); AEC ref ring = drop-oldest (freshness); network TX ring = tiny (≈6 frames), keep-newest, count drops. Never frame-split PCM on partial writes. (`esp_audio_stack.cpp:1637-1656`; `audio_pipeline.cpp:1776-1780`; `voip_audio.cpp:69-143`)
10. **Ring resets are requests serviced by the owning task at frame boundaries**, signalled with an atomic flag — no cross-thread `reset()` ever. (`esp_audio_stack.cpp:263-278,1616-1622`)
11. **Deferred teardown**: `stop()` flips flags; the main loop deletes I2S only after observing the audio task parked; `start()` completes pending teardown first. Avoids both main-loop stalls (up to 600 ms) and half-closed-bus restarts. (`esp_audio_stack.cpp:1450-1491,1384-1397`)
12. **Preallocate worst-case, fail closed, and pre-open every DSP handle** so the realtime loop performs zero allocations for the process lifetime; verify HIGH_PERF-style big-alloc feasibility with a `largest_free_block` pre-flight instead of letting the vendor lib half-init. (`audio_pipeline.cpp:140-510,640-663`; `esp_aec.cpp:36-48,82-97`)
13. **Make memory placement explicit and auditable**: a ring/task-creation helper that takes a placement policy, verifies where the allocation landed (`esp_ptr_internal`), and logs it at boot; heap snapshots at every lifecycle milestone. (`audio_core_ring_buffer_caps.h:21-34,203-232`; `esp_audio_stack.cpp:280-287`)
14. **Priorities that worked in production**: audio I/O task 19 (above lwIP 18, below Wi-Fi 23) on core 0; DSP workers prio 5 with feed on core 0 / fetch + esp-sr on core 1; network media tasks prio 5 on core 0; reconfig worker prio 4. Every one YAML-overridable. (`esp_audio_stack.h:811-812`; `esp_afe.h:388-396`; `voip_stack.h:602`)
15. **For our PCM-over-websocket receive path**, copy the playout-task shape: capture-clocked TX with no timer; RX with a small fixed-slot jitter window + prebuffer, and — crucially — **clock silence into the speaker after a ~60 ms gap** on an established stream so I2S never stalls or pops during Wi-Fi outages, while initial prebuffering stays quiet. (`voip_audio.cpp:145-174,335-418`; `rtp_jitter_buffer.h`)
16. **Compile out unused paths from config** (their codegen `add_define` pattern → our Kconfig/CMake defines): only the RX/ref/TX variants a device actually uses exist in its binary, which keeps the hot loop's branch surface and the test matrix honest. (`esp_audio_stack/__init__.py:644-668`)

One honest caveat to relay: the specific "AEC gated on speaker activity in the last ~250 ms" technique attributed to this project does not exist on the current `dev` branches of any of its repos; the shipped design intentionally runs the processor continuously with a zero-filled reference when playback is idle, and gates at the coarser consumer/pipeline level instead (§2). If we want the 250 ms gate for CPU savings, we would be adding something this author appears to have deliberately moved away from — worth weighing their stated reason (surface consistency for downstream consumers) against our CPU budget.
