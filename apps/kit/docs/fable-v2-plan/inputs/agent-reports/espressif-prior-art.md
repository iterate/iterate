All research is complete. Here is the full report.

---

# Prior-art study: ESP-ADF pipelines, ESP-SR AFE, the i2s_channel driver, and SeekAudio AEC

Repos studied (all local clones; activity noted per §7):

- `/Users/jonastemplestein/src/github.com/espressif/esp-adf` (branch `release/v2.x`, last commit 2026-07-24)
- `/Users/jonastemplestein/src/github.com/espressif/esp-sr` (master, last commit 2026-07-20, CHANGELOG head = v2.4.6)
- `/Users/jonastemplestein/src/github.com/espressif/esp-skainet` (master, 2026-02-14) — the canonical AFE application examples
- `/Users/jonastemplestein/src/github.com/espressif/esp-idf` (v5.5.3)
- `/Users/jonastemplestein/src/github.com/seekaudio/seekaudio_aec_test` (main, 2026-07-19; primary SeekAudio artifact — the older `esp32_aec_test` no longer exists)

---

## 1. The canonical Espressif load model: capture + AEC + playback + network on ESP32-S3

### 1.1 The AFE feed/fetch two-task pattern (the core idiom)

Every Espressif voice product follows one shape: **a feed task that pushes interleaved mic+ref PCM into the AFE, and a fetch task that blocks on the AFE's output ringbuffer**. The AFE additionally spawns its **own internal processing task** ("se task") whose core/priority you control via config — so the real topology is _three_ tasks minimum, not two.

Canonical form, from `esp-sr/docs/en/audio_front_end/README.rst:202-216` and duplicated in `esp-skainet/examples/voice_communication/main/main.c:152-154`:

```c
xTaskCreatePinnedToCore(&feed_Task,  "feed",   8*1024, afe_data, 5, NULL, 0);
xTaskCreatePinnedToCore(&detect_Task,"detect", 8*1024, afe_data, 5, NULL, 0);  // skainet: both core 0
// docs variant: fetch on core 1 with 4KB stack (README.rst:214-215)
```

- **Stacks**: 8 KB feed, 4–8 KB fetch. **Priority 5** in the examples (i.e., _modest_ — the AFE's internal task is the one that gets high priority).
- The feed task's loop is trivially `read_i2s → afe->feed()`; feed() only copies into the AFE's input ringbuffer, so its cost is low. All DSP happens on the AFE's internal task.
- The fetch task blocks in `afe->fetch()` (default internal timeout 2000 ms; `fetch_with_delay()` for custom, `esp_afe_sr_iface.h:106-124`).
- Buffer sizing is always derived, never hardcoded: `get_feed_chunksize() * get_feed_channel_num() * sizeof(int16_t)` (README.rst:117-124). Chunk is 512 samples/32 ms @16 kHz for SR/FD types, 256 samples/16 ms for VC (per the frame lengths in the AEC benchmark note, `acoustic_echo_cancellation/README.rst:180-183`).

### 1.2 Core split and priorities in production-grade code (ADF)

ADF's `algorithm_stream` (the AFE wrapped as a pipeline element) encodes Espressif's real-world tuning, `esp-adf/components/audio_stream/algorithm_stream.c:144-148` and `algorithm_stream.h:35-38`:

| Task                     | Core  | Priority                     | Stack                                    | Source                                                                               |
| ------------------------ | ----- | ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------ |
| AFE internal ("se") task | **1** | **21**                       | (internal)                               | `afe_perferred_core = 1`, `afe_perferred_priority = 21` (algorithm_stream.c:146-147) |
| algo fetch task          | **0** | 18                           | 5 KB (`ALGORITHM_FETCH_TASK_STACK_SIZE`) | algorithm_stream.c:195-196, header :35-37                                            |
| algo element (feed side) | 0     | configurable, example uses 5 | 8 KB, **stack in PSRAM**                 | algorithm_stream.h:38,120; algorithm_examples.c:180                                  |
| i2s_stream reader/writer | 0     | **23**                       | 3.5 KB                                   | `i2s_stream.h:44-48`                                                                 |
| fatfs/consumer elements  | 1     | 5                            | —                                        | algorithm_examples.c:204-205                                                         |
| memory alloc mode        | —     | —                            | `AFE_MEMORY_ALLOC_MORE_PSRAM`            | algorithm_stream.c:148                                                               |

Priority ordering that emerges: **I2S DMA servicing (23) > AFE DSP (21) > fetch/consumers (18/5)**. Wi-Fi/LwIP tasks live at their IDF defaults (wifi task prio 23 pinned to core 0 by default) — i.e., Espressif puts **I2S + network on core 0 and the heavy AFE math on core 1**, keeping the two cores' hard-real-time domains separate. The AEC-only `aec_stream` element uses the same numbers (task prio 21, core 0, 8 KB stack, PSRAM stack — `aec_stream.h:31-46`), but there the AEC runs synchronously inside the element task.

### 1.3 How playback and capture run concurrently, and where the reference comes from

The ADF `algorithm` example (`examples/advanced_examples/algorithm/main/algorithm_examples.c`) is the definitive template. Two independent pipelines:

- **Play**: `mp3_decoder → resample_filter →(write_cb)→ i2s_stream_writer` — note the writer element runs _taskless_ (`task_stack = -1`, line 152), its work happens in the filter's write callback.
- **Record**: `(read_cb: i2s_stream_reader) → algorithm_stream(AEC/NS/AGC) → wav_encoder → fatfs`.

The AEC **reference signal** is obtained one of two ways:

1. **Hardware loopback (preferred)** — `RECORD_HARDWARE_AEC` boards (S3-Box, S3-Box-3, Korvo2-v3, Korvo-2L: `components/audio_board/*/board_def.h`) wire the codec so the I2S RX stream _already contains_ the DAC playback in one slot: "32 bits = 16 bits for mic + 16 bits for ref" (algorithm_examples.c:52). The app just declares `input_format = "RM"` and feeds; zero software bookkeeping, ~zero skew.
2. **Software tap (TYPE2)** — boards without loopback tee the playback path: the i2s write callback `rb_write()`s every buffer into a dedicated reference ringbuffer _at the same moment it goes to I2S_ (algorithm_examples.c:118-136), and the algorithm element merges it with mic input via a "multi input ringbuffer" (`ALGORITHM_STREAM_INPUT_TYPE2`, diagram at algorithm_stream.h:69-88), interleaving software-side (algorithm_stream.c:245-276). Ref ringbuffer size: `ALGORITHM_STREAM_RINGBUFFER_SIZE = 1024` bytes (header:37).

**The alignment contract is stated three times across the tree** (algorithm example README:146, voip README:115, algorithm_stream.h:191-192): _the recording signal must lag the reference by ~0–10 ms_. `algo_stream_set_delay()` pre-loads silence into the ref ringbuffer to shift alignment (algorithm_stream.c:362-375), and `debug_input` mode dumps interleaved mic/ref WAV to SD so you measure the actual offset with an audio tool. This is the entire alignment methodology — measure once per hardware design, then hard-code the delay.

### 1.4 The full VoIP stack (adds network)

`examples/protocols/voip` runs SIP/RTP (G711A @8 kHz) + AEC concurrently on one chip. Its `av_stream` component (`examples/protocols/components/av_stream/av_stream.c`) shows the sizing for a real duplex-voice + network system:

- 20 ms frames: `PCM_FRAME_SIZE 320` bytes = 20 ms @8 kHz mono (av_stream.h:43).
- Decode-side ringbuffer 3×framesize; **reference ringbuffer 8×framesize** (av_stream.c:547-551) — the ref buffer is deliberately deep because playback and capture clocks aren't the same task.
- Software ref path: decoder task writes each played frame into `ringbuf_ref` (av_stream.c:491); capture callback reads it with a bounded, non-fatal timeout and interleaves "RM" (av_stream.c:170-178) — **ref starvation degrades AEC, never blocks capture**.
- Hardware-ref boards skip all of it (`_have_hardware_ref`, av_stream.c:144-152).
- AEC on core 0, encoder/filter/fatfs on core 1 (av_stream.c:301-360), `AFE_TYPE_VC_8K` for the 8 kHz codec path (av_stream.c:319).
- Memory for the whole example: 392 KB total / 236 KB internal / 156 KB PSRAM on LyraT-Mini (voip README:14-24) — a useful whole-system envelope.
- The main loop just prints `audio_sys_get_real_time_stats()` every 15 s (voip_app.c:207-211) — CPU-per-task telemetry is built into their bring-up hygiene.

---

## 2. AFE modes, measured costs, and which fits what

### 2.1 Types and modes (`esp-sr/include/esp32s3/esp_afe_config.h:27-39`)

- `AFE_TYPE_SR` — wake-word/recognition front-end; linear AEC only (no nonlinear echo suppression).
- `AFE_TYPE_VC` — voice communication, 16 kHz, includes nonlinear (NLP) echo suppression.
- `AFE_TYPE_VC_8K` — same at 8 kHz input.
- `AFE_TYPE_FD` — **full-duplex conversation**: linear + nonlinear, tuned for barge-in ("play and listen simultaneously").
- Each × `AFE_MODE_LOW_COST` / `AFE_MODE_HIGH_PERF`.

The processing pipelines actually instantiated per config (benchmark doc, `docs/en/benchmark/README.rst:29-54`): e.g. `MR, FD, LOW_COST` → `|AEC(FD_LOW_COST)| → |VAD(vadnet1_medium)| → |WakeNet|`; `MR, VC, LOW_COST` → `|AEC(VOIP_LOW_COST)| → |NS(nsnet2)| → |VAD(vadnet1_medium)|`.

### 2.2 Measured budgets — full AFE on ESP32-S3 (`docs/en/benchmark/README.rst:62-120`)

| Config (input, type, mode) | Internal RAM | PSRAM        | Feed CPU (1 core) | Fetch CPU (1 core) |
| -------------------------- | ------------ | ------------ | ----------------- | ------------------ |
| MR, SR, LOW_COST           | 60.1 KB      | 739.7 KB     | 8.8 %             | 9.8 %              |
| MR, SR, HIGH_PERF          | 49.1 KB      | 775.8 KB     | 9.3 %             | 9.8 %              |
| **MR, FD, LOW_COST**       | **60.2 KB**  | **777.7 KB** | **12.1 %**        | **9.8 %**          |
| MR, FD, HIGH_PERF          | 49.2 KB      | 813.8 KB     | 12.5 %            | 9.8 %              |
| MR, VC, LOW_COST           | 48.7 KB      | 819.7 KB     | 30.6 %            | 4.7 %              |
| MR, VC, HIGH_PERF          | 91.1 KB      | 822.2 KB     | 32.2 %            | 4.7 %              |
| MMNR (2-mic), SR, LOW_COST | 79.1 KB      | 1153.7 KB    | 23.7 %            | 22.9 %             |
| MMNR, FD, HIGH_PERF        | 68.1 KB      | 1238.5 KB    | 30.4 %            | 22.9 %             |

(The AEC work is accounted in the _feed_ column; wake/VAD models in _fetch_. Caveat: the esp32p4 doc section repeats identical numbers, so treat them as indicative, not lab-grade.)

### 2.3 Standalone AEC only (no AFE wrapper) — S3 @240 MHz (`docs/en/acoustic_echo_cancellation/README.rst:140-183`)

| Mode            | Internal RAM | PSRAM       | ms/frame    | CPU        |
| --------------- | ------------ | ----------- | ----------- | ---------- |
| SR_LOW_COST     | 18.8 KB      | 64.0 KB     | 2.29/32     | 7.2 %      |
| SR_HIGH_PERF    | 8.2 KB       | 100.1 KB    | 4.51/32     | 14.1 %     |
| VOIP_LOW_COST   | 26.9 KB      | 64.1 KB     | 4.37/16     | 27.3 %     |
| VOIP_HIGH_PERF  | 69.2 KB      | 66.6 KB     | 5.05/16     | 31.6 %     |
| **FD_LOW_COST** | **30.9 KB**  | **90.0 KB** | **6.28/32** | **19.6 %** |
| FD_HIGH_PERF    | 20.3 KB      | 126.2 KB    | 8.08/32     | 25.3 %     |

(Note: the S3 table's footnote says "ESP32-P4 @ 240 MHz" while listing S3 cache options — a doc typo; the numbers are the S3 block.) Espressif's own recommendation: **`AEC_MODE_FD_LOW_COST` is the best balance** (README.rst:30-32).

### 2.4 Hard constraints

- **16 kHz / int16 only** for everything except VC_8K (`esp_afe_sr_iface.h:96`, `esp_aec.h:60`); SR/FD frame = 512 samples (32 ms), VOIP = 256 (16 ms).
- **PSRAM is effectively mandatory**: 0.74–1.24 MB PSRAM per AFE config (table above); ADF's S3 sdkconfig enables octal PSRAM @80 MHz (`examples/advanced_examples/algorithm/sdkconfig.defaults.esp32s3`). Standalone AEC alone (64–126 KB PSRAM) is the only configuration that could squeak by without PSRAM.
- NS/VAD/wake models load from a flash partition ("model", `srmodels.bin`); pure AEC + WebRTC-VAD/NS needs no model partition (`algorithm_stream.c:150`, `esp_afe_config.h:113` — null `vad_model_name` = WebRTC VAD).
- Output buffers for `afe_aec_process` must be 16-byte aligned (`esp_afe_aec.h:54`, AEC doc:89-91).
- The modern config surface is `afe_config_init(input_format, models, type, mode)` then tweak fields (`aec_init`, `vad_init`, `agc_init`, `afe_perferred_core/priority`, `afe_ringbuf_size`, `memory_alloc_mode`, `afe_linear_gain`, `vad_min_speech_ms`…) then `afe_config_check()` which resolves conflicts (`esp_afe_config.h:94-187`).

### 2.5 Which mode for us

- **Full-duplex voice call (our main mode)**: `AFE_TYPE_FD` + `AFE_MODE_LOW_COST`, input `"RM"`, wakenet off, VAD on. ~60 KB internal + ~780 KB PSRAM + ~22 % of one core (feed+fetch combined, AEC portion ~20 %). If we want the leaner path: standalone `afe_aec_create("RM", 4, AFE_TYPE_FD, AFE_MODE_LOW_COST)` (≈31 KB/90 KB/19.6 %) + `vad_create_with_param()` (WebRTC VAD, near-free, 8/16/32 kHz, 10-30 ms frames — `esp_vad.h:23,104-126`) and skip NS initially. `aec_stream.c` proves the synchronous-wrapper pattern: one task calling `afe_aec_process()` per 32 ms frame is a legitimate production topology (aec_stream.c:94-113).
- **Wake-word listening mode**: `AFE_TYPE_SR` + LOW_COST (linear AEC good enough to keep wake detection alive during playback).
- **Push-to-talk**: no AEC at all; optionally standalone WebRTC VAD for endpointing.
- Filter length: 4 for S3 (`esp_afe_aec.h:38-40`).

---

## 3. ADF pipeline structure: what to imitate, what is baggage

### 3.1 Anatomy

ADF composes `audio_element`s (each = one FreeRTOS task + input/output ringbuffer + open/process/close vtable) linked by byte ringbuffers (`DEFAULT_PIPELINE_RINGBUF_SIZE = 8 KB`, `audio_pipeline.h:43`; element defaults: 2 KB stack, prio 5, core 0, `audio_element.h:177-187`). Any element's input or output can be replaced by a **callback** instead of a ringbuffer (`audio_element_set_read_cb` / `set_write_cb`), which the AEC examples use to fuse stages into one task and to tee the reference. Events flow over a separate `audio_event_iface` queue to a central listener loop.

### 3.2 Worth imitating

1. **Callback-fused stages over task-per-stage.** Espressif's own examples bypass their framework's task model where latency matters: the i2s writer runs taskless inside the resampler's write callback; the i2s reader is inlined into the AEC element's read callback (algorithm_examples.c:151-152, 194, 240). The lesson: **one task per clock domain, not per module**.
2. **Tap the playback stream at the last point before the driver** for the AEC reference, into a small dedicated ringbuffer, written with zero/short timeout so playback never blocks on the tap (i2s_write_cb, algorithm_examples.c:118-136; av_stream.c:487-494 logs-and-drops on overflow).
3. **Non-fatal ref underrun**: zero-fill the reference and keep capturing (av_stream.c:170-178).
4. **Derived buffer sizes** from `get_feed_chunksize()` etc., never constants.
5. **The 0–10 ms mic-lags-ref contract + a debug interleave dump mode** as a first-class feature for alignment bring-up (debug_input, algorithm_stream.h:196-200).
6. **Small, deep ref buffering in frames**: 8× frame for ref vs 3× for decode (av_stream.c:547-551) — asymmetric on purpose.
7. **Task-level CPU stats in the idle loop** during bring-up (voip_app.c:208).
8. **Stacks in PSRAM for DSP-heavy tasks** (`stack_in_ext = true` everywhere in algo/aec stream configs) — internal RAM is the scarce resource.

### 3.3 ADF-framework baggage (do not copy)

- The element/ringbuffer/URI/event-iface machinery itself: tag-string linking (`audio_pipeline_link(&{"algo","wav_encoder","fatfs_stream"})`), `AEL_MSG_CMD_REPORT_*` status events, URI-dispatched I/O, the multi-step deinit dance (algorithm_examples.c:316-338 — six ordered teardown calls). It exists so arbitrary decoders/filters can be recombined at runtime; our pipeline is fixed and host-testable, so a plain frame-function core (like `aec_stream.c`'s `_aec_process`: read exact frame → `afe_aec_process` → write) gives the same behavior without the framework.
- Byte-oriented 8 KB ringbuffers between every stage add latency and hide frame boundaries; the AFE already contains its own frame-aligned ringbuffer (`afe_ringbuf_size` in frames, `esp_afe_config.h:141`, plus `ringbuff_free_pct` backpressure telemetry in every fetch result, `esp_afe_sr_iface.h:49`).
- ADF's newer `aec_stream`/`algorithm_stream` are licensed "MIT-ESPRESSIF" — **Espressif-hardware-only** (aec_stream.h:1-24). Fine for us on ESP32, but a reason not to port that code into the portable host-testable core; the pattern is trivial to reimplement.

---

## 4. The i2s_channel driver (`esp_driver_i2s`) for production full-duplex audio

### 4.1 Concrete advantages over the legacy driver / M5Unified's classes

The legacy `driver/i2s.h` is formally deprecated ("will no longer be supported in the future", compile-time `#warning` — `esp-idf/components/driver/deprecated/driver/i2s.h:8-27`). The new API (`esp_driver_i2s/include/driver/i2s_common.h`) gives:

1. **True full-duplex channel pairs**: `i2s_new_channel(&cfg, &tx, &rx)` allocates TX+RX on one controller sharing BCLK/WS (i2s_common.h:110-136; docs "Full-duplex", i2s.rst:902-976). On S3 (HW v2) the two controllers have independent RX/TX channels (i2s.rst:46-48). One shared clock domain = sample-count coherence between capture and playback paths, which is the foundation of a stable AEC delay.
2. **Explicit DMA sizing**: `dma_desc_num` × `dma_frame_num` with a documented engineering procedure — `interrupt_interval = dma_frame_num / sample_rate`, buffer ≤4092 bytes, `dma_desc_num > polling_cycle / interrupt_interval`, `recv_buffer_size > dma_desc_num * dma_buffer_size` (i2s.rst:1210-1224). Defaults 6×240 frames (i2s_common.h:22-31). For 16 kHz/16-bit stereo, 6×256 ≈ 96 ms of DMA depth at 16 ms/interrupt — tune deliberately.
3. **ISR event callbacks**: `on_sent`, `on_recv`, and — critical — **`on_recv_q_ovf` / `on_send_q_ovf` overflow callbacks** (i2s_common.h:41-54), so underrun/overrun becomes an observable event instead of silent corruption. Our firmware already uses `on_sent`/overflow callbacks in `m5sticks3_direct_audio.cpp:144-150,263-290`.
4. **`i2s_channel_preload_data()`** — fill TX DMA before enable so the first samples out are real audio, not a zero-burst (i2s_common.h:243-265); we already use this (m5sticks3_direct_audio.cpp:214-226).
5. **`auto_clear_after_cb/before_cb`** — DMA auto-zeroes on TX starvation, so underrun plays silence, not a looped stale buffer (i2s_common.h:68-76).
6. **`i2s_channel_tune_rate()`** — fine MCLK tuning at runtime to chase producer/consumer clock drift (i2s_common.h:267-283); directly relevant to long-lived raw-PCM-over-websocket sessions where the network clock and the DAC clock diverge.
7. Versus **M5Unified's Speaker/Mic classes**: those are half-duplex by construction (install/uninstall the driver when switching direction, software mixer, own gain stages). Our codebase already documents this and bypasses them: the direct path "hands provider PCM to I2S without M5Unified's software" and manages disable-ordering conflicts with M5Unified's mic explicitly (`apps/kit/firmware/platforms/iterate_m5unified/m5sticks3_direct_audio.cpp:23-25,169-186`). The prior-art conclusion is the same one we already reached: own the I2S channel(s) with the new driver; use M5Unified only for board init.

### 4.2 Getting a clean AEC reference via loopback

- **Internal digital loopback exists**: "Data will loopback internally if DIN and DOUT are set to a same GPIO" (i2s.rst:27). So a second RX channel on the _other_ controller, with its `din` set to the TX channel's `dout` GPIO, captures exactly what went to the amp — a bit-true reference with fixed hardware latency. On S3: STD-mode TX on I2S0 + STD RX (mic) — if the mic is I2S/TDM.
- **PDM caveat**: PDM full-duplex on one controller is impossible (different TX/RX clocks — i2s.rst:905), and S3 PDM RX lives on specific controllers (S3 supports PDM TX ×2 lines and PDM RX ×4 lines, `soc_caps.h:234-239`). With a PDM mic + I2S amp (M5StickS3-class), the layout is: controller A = PDM RX (mic), controller B = STD TX (amp) — clocks are _not_ shared, so the reference must be taken in software at the write boundary (ADF TYPE2 pattern, §3.2.2) or via a third channel looping back `dout`. Given only two controllers and a PDM mic, **the software tap is the realistic path on our hardware**; an ES8311-style codec board can instead use the codec/board hardware loopback (`RECORD_HARDWARE_AEC` boards interleave ref into the RX slots — §1.3).
- Either way the ref-vs-mic skew is then _constant per design_, satisfying the AEC's 0–10 ms window measured once via the debug-dump method.

---

## 5. SeekAudio assessment: real option or not?

**What it is**: `seekaudio_aec_test` is a well-built, reproducible A/B benchmark harness (MIT for the harness) pitting "SeekAudio AEC" against esp-sr's FD-AEC on ESP32-S3 — same board, same Microsoft-AEC-Challenge-derived material, automated AECMOS/ERLE report tooling. Active (last commit 2026-07-19). Sibling repos `seekAudioNS` (2025-04, Windows .exe demo of their NS) and `seekAudioAFC` (2025-11, Android howling-suppression demo) show a small real audio-DSP shop, not vaporware.

**Claimed results** (README_EN.md:25-39, evaluation report): vs esp-sr FD-AEC baseline — CPU 28.1 % vs 60.5 % (WebRTC-NS tier), FE single-talk ERLE 21.5 dB vs 9.7 dB, AECMOS composite 3.85 vs 3.48, at 75 KB internal + 193 KB PSRAM.

**Skeptical findings (verified in the repo):**

1. **The core is a closed binary blob**: `components/seekaudio_aec/lib/libseekaudio_aec.a` (841 KB), all internal symbols obfuscated to `_s000005…` (verified with `nm`). **Evaluation-only license**: no product use, no redistribution outside forks, may include "time- or usage-limited trial restrictions" (components/seekaudio_aec/LICENSE.txt). The shipped build is literally `VERSION_LIMIT`: ~10 create/destroy cycles per boot plus a **date lock** (bench_config.h:50-60). Production use requires a commercial license from seekaudio.cn.
2. **It is built _on top of_ esp-sr, not a replacement**: `nm -u` shows the blob's undefined symbols include `aec_create_from_config`, `aec_linear_process`, `aec_destroy`, `aec_get_chunksize` (esp-sr) and `dsps_fft2r_*` (esp-dsp) — i.e., **SeekAudio reuses Espressif's linear AEC front-end and replaces only the NLP/residual-echo + NS post-stages with their AI models** (their architecture doc's "z⁻¹ cross-frame feedback" NLP network, docs/article/README_EN.md:19-32). It hard-pins `esp-sr==2.4.5` / `esp-dsp==1.8.0` for ABI (main/idf_component.yml). So adopting it still means shipping esp-sr, plus a blob, plus a version pin.
3. **The baseline CPU numbers look pessimistic vs Espressif's own docs**: they measure B1 (esp-sr FD-AEC + ns_pro) at 60.5 % CPU, while Espressif's doc says FD_LOW_COST AEC ≈19.6 % + NS. Part of the gap is PSRAM placement (their own `B_AEC_INTERNAL_SRAM=1` toggle cuts B CPU by 10–15 points at ~130-200 KB internal SRAM cost, README_EN.md:136) and part is that B runs AEC+NLP+NS while marketing copy compares against "the official baseline". Methodology is honest and reproducible (esp_timer measurement, bench_port.c), but the headline "half the compute" is _vs their measured config_, not vs Espressif's published budget.
4. Fixed constraints match esp-sr's: 32 ms frames, 16 kHz-only (loudly documented, seekaudio*aec.h:29-49), 1 mic + 1 ref only. API shape is a clean drop-in analog of `afe_aec*\*` (`create(fmt,type)/process/get_chunksize/destroy` + a near-end 4-state classifier).

**Verdict**: _Real technology, credible benchmark, wrong procurement shape for us right now._ The echo-suppression quality gain (esp. double-talk/barge-in ERLE) is plausibly real and the near-state classifier is attractive for turn-taking, but: proprietary blob, eval-only license with kill-switches, esp-sr pinning, and it defeats our portable host-testable core (no host build of the blob). Treat it as a **benchmarked fallback if FD_LOW_COST's residual echo proves insufficient on our speaker-near-mic hardware**, entering a commercial-license conversation only then. Their harness (MIT) and report tooling are independently useful as an AEC evaluation methodology to copy.

---

## 6. Lessons for us (distilled)

1. **Three-task audio topology**: I2S-feed task (core 0), AFE internal DSP task (core 1, prio ~21), fetch/consumer task (core 0, prio ~18); network stays on core 0. Priorities: I2S (23) > AFE (21) > fetch (18) > app (5). [algorithm_stream.c:144-148; i2s_stream.h:46; skainet main.c:152-154]
2. **feed() is cheap, fetch() blocks**: treat the AFE as a sans-io frame processor with an internal ringbuffer; our portable core can mirror exactly this contract (`feed(frame) / fetch() → {pcm, vad_state}`), which also makes host-testing trivial. [esp_afe_sr_iface.h:100-124]
3. **Pick `AFE_TYPE_FD` + LOW_COST for duplex voice; `AFE_TYPE_SR` for wake; nothing for PTT.** Budget ~22 % of one S3 core + 60 KB internal + 0.78 MB PSRAM for the full AFE; or ~20 % + 31 KB/90 KB for standalone FD-AEC + free WebRTC VAD. [benchmark/README.rst:62-120; aec README:140-183]
4. **PSRAM (octal, 80 MHz) is a hard prerequisite** for any AFE config; put DSP task stacks in PSRAM too. [sdkconfig.defaults.esp32s3; aec_stream.h:41]
5. **16 kHz / int16 / fixed 256-or-512-sample frames end-to-end**; resample at the edges only (their VoIP resamples 8 k↔16 k around the codec). [esp_afe_sr_iface.h:96; av_stream.c]
6. **Reference tap at the last software point before the DMA write**, small dedicated frame ringbuffer (~8 frames deep), zero-timeout writes, log-and-drop on overflow, zero-fill on underrun — never let ref plumbing stall either capture or playback. [algorithm_examples.c:118-136; av_stream.c:170-178,491-494,547-551]
7. **Enforce and _measure_ the 0–10 ms mic-after-ref window**: ship a debug mode that records interleaved mic/ref for offline skew measurement, and a configurable ref pre-delay (silence pre-load) to trim it. [algorithm README:144-146; algorithm_stream.c:362-375]
8. **One task per clock domain, callbacks to fuse modules** — copy ADF's examples (which bypass ADF's own task-per-element model), not ADF's framework. Skip ringbuffer-chains between DSP stages; call `afe_aec_process()` synchronously in the capture-rate task like `aec_stream.c` does. [algorithm_examples.c:151-152,240; aec_stream.c:94-113]
9. **Use the new `i2s_channel` driver exclusively** (legacy is deprecated): full-duplex pair on one controller when the mic is I2S; explicit `dma_desc_num`/`dma_frame_num` sizing via the documented formula; register `on_recv_q_ovf`/`on_send_q_ovf` and surface them as metrics; `preload` before enable; `auto_clear` for silence-on-underrun. We already do most of this on the TX path — extend it to RX. [i2s_common.h:22-283; i2s.rst:1189-1224; m5sticks3_direct_audio.cpp]
10. **`i2s_channel_tune_rate()` is the answer to network-vs-DAC clock drift** for continuous PCM-over-websocket playback — plan it into the playback buffer-depth controller rather than resampling. [i2s_common.h:267-283]
11. **On PDM-mic hardware the AEC reference must come from the software tap** (PDM can't share a duplex clock); on ES8311-class boards prefer hardware loopback where the RX stream carries mic+ref interleaved ("RM"), which is what all of Espressif's S3 reference designs (`RECORD_HARDWARE_AEC`) do. [i2s.rst:27,905; board_def.h grep; algorithm_examples.c:50-52]
12. **AGC belongs after AEC and is part of the AFE** (`agc_target_level_dbfs = -3` default) — relevant to our uncommitted −18 dB output-gain fix: Espressif's pattern is separate input AGC (AFE) and codec-side output volume, with per-channel analog gains set at the codec (e.g. ref channel 24 dB vs mic 33 dB on Korvo2). [algorithm_stream.h:152-155; algorithm_examples.c:162-165]
13. **VAD comes free with the AFE and includes `vad_cache`** (the buffered audio from before the speech trigger) so the first syllable isn't lost — use that instead of building our own pre-roll. [esp_afe_sr_iface.h:33-35; esp_afe_config.h:110-121]
14. **Watch `ringbuff_free_pct` in every fetch result** as the canonical backpressure signal (>0.5 = falling behind) — cheap to export into our metrics capability. [esp_afe_sr_iface.h:49]
15. **SeekAudio: benchmark-credible but blob+eval-license+esp-sr-pinned; not compatible with a host-testable portable core.** Keep as a quality fallback; steal their evaluation harness methodology (AECMOS + ERLE + on-device CPU/RTF report) for our own AEC acceptance tests. [seekaudio_aec_test LICENSE, idf_component.yml, nm output]

## 7. Activity/maturity notes

| Project                    | Last commit                 | Verdict                                                                                                                  |
| -------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| esp-adf                    | 2026-07-24 (`release/v2.x`) | Actively maintained, production framework; new `aec_stream` is recent (2025 license header) and uses current AFE v2 APIs |
| esp-sr                     | 2026-07-20 (master, v2.4.6) | Very active; FD-AEC added in 2.4.3 (registry line 2.4.x, 2026-04) — the FD type is _new_ this year, expect API movement  |
| esp-skainet                | 2026-02-14                  | Maintained examples repo; the voice_communication example is the canonical minimal AFE-VC app                            |
| esp-idf                    | v5.5.3 (2026-02)            | Stable LTS-line; `esp_driver_i2s` is the supported path, legacy driver deprecated                                        |
| seekaudio_aec_test         | 2026-07-19                  | Active, polished, but the engine is an eval-only obfuscated blob with usage/date locks; harness itself MIT and reusable  |
| seekAudioAFC / seekAudioNS | 2025-11 / 2025-04           | Demo-grade side repos; confirm the vendor is real but small                                                              |
