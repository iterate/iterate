# Prior-art research report supplied by Jonas (2026-07-31)

Provenance: produced by a separate research agent WITHOUT live web verification
(its own sourcing note says version pins, CPU/latency figures, and 2025–2026
activity status are directional and must be verified). Jonas's instructions on
receipt: (1) trawl every item and compare against PLAN.md and its decisions,
potentially reopening them; (2) check whether we can do WebRTC — "as I
understand it, UDP on Cloudflare Worker" — possibly using the ESP WebRTC
example, which might be cleaner.

---

> **Sourcing note:** Live web search/fetch was unavailable during this research pass (both the primary tool and the delegated subagent returned hard tool failures, and the enrichment pass could add nothing). This report is therefore built from established domain knowledge of these codebases and ESP-IDF internals. GitHub repo paths and ESP-IDF Kconfig symbols are high-confidence; **specific version pins, exact CPU%/latency figures, and 2025-2026 activity status should be treated as directional and verified against the live README/docs before you commit architecture.** I flag confidence inline. Given an expert audience, I've kept it dense and skipped basics.

## TL;DR

- **Best starting point today: Espressif's `esp-webrtc-solution` (esp_webrtc + esp_peer + esp_capture) on ESP32-S3 for a shipping voice device, or the ESP32-P4-Function-EV-Board if you need video or CPU headroom.** Combine it with `esp-sr` AFE for AEC/NS/VAD/wake word, driven by an **ES7210 4-channel ADC in I2S TDM mode with a hardware loopback reference channel** — this is the single most important design decision for working AEC.
- **The load-management pattern that works: pin Wi-Fi/lwIP to core 0 (PRO_CPU) and the entire audio/AFE chain to core 1 (APP_CPU); hand off I2S DMA completion to the read task via `xTaskNotifyFromISR` (not a queue); keep hot audio code and the Wi-Fi RX path in IRAM; hold an `esp_pm_lock` at `ESP_PM_APB_FREQ_MAX` for the duration of a call; keep latency-critical buffers in internal SRAM (not PSRAM); and never touch flash (OTA/SPIFFS/NVS) mid-stream.** On S3 the audio-vs-Wi-Fi cache/bus contention is the real enemy; on P4+C6 the Wi-Fi radio load is physically offloaded to the C6, which materially changes the calculus in your favor.
- **If starting today: S3 = mature, proven, integrated Wi-Fi, best-documented AEC path via esp-sr on the ES7210/ES8311 combo. P4 = more CPU/DSP headroom and offloaded Wi-Fi, better for video + heavier DSP, but the P4+C6 ESP-Hosted-over-SDIO stack is newer and adds transport latency you must budget for.**

## Key Findings

1. **Espressif has converged on a real WebRTC stack.** `esp-webrtc-solution` (components `esp_webrtc`, `esp_peer`, `esp_capture`, plus a `media_lib` layer) is the modern, officially-supported way to do bidirectional real-time media + network on S3 and P4. It ships an **OpenAI Realtime API demo, a WHIP publishing demo, and P2P video-call demos.** This supersedes rolling your own on top of raw `libpeer`.
2. **`esp-sr` AFE is the pragmatic AEC choice on ESP32**, not SpeexDSP and definitely not full WebRTC AEC3. AFE bundles AEC + NS + BSS/MISO + AGC + VAD + WakeNet + MultiNet, and exposes two profiles: an SR profile (speech recognition / far-field wake) and a **VC (voice communication) profile — the one you want for full-duplex calling.**
3. **The AEC reference-channel alignment is the make-or-break detail.** AFE needs the mic channel(s) interleaved with a playback reference channel described by a channel-format string (e.g. `"MMNR"` = 2 mics, 1 null, 1 reference). The clean way is a **hardware reference** from the ES7210 TDM ADC; the fragile way is a software loopback copy of the DAC buffer, which requires you to nail the echo-path delay manually.
4. **Audio-vs-Wi-Fi contention on S3 is dominated by cache/bus sharing between PSRAM, flash, and Wi-Fi DMA**, not just CPU scheduling. The fixes are IRAM placement, internal-SRAM buffers, octal (not quad) PSRAM, limiting AMPDU burstiness for latency, and `esp_pm_lock` to stop DFS from moving the APB clock under I2S.
5. **ESP32-P4's architecture (dual RISC-V @ up to 400 MHz, DSP/SIMD extensions, no built-in radio, Wi-Fi via ESP32-C6 over SDIO/ESP-Hosted) is genuinely better for this workload** because Wi-Fi driver/ISR load lives on the C6, not on the cores doing AEC — at the cost of SDIO transport latency and a newer, less battle-tested host stack.
6. **The new I2S driver family (`driver/i2s_std.h`, `driver/i2s_tdm.h`, `driver/i2s_pdm.h`, componentized as `esp_driver_i2s`) is mandatory for new work; legacy `driver/i2s.h` is deprecated in IDF v5.x** and cannot cleanly express the multi-slot TDM channel layout that hardware-reference AEC needs.

## Details

### 1. Ranked shortlist of prior art (what to steal from each)

**Tier 1 — build on these directly**

- **`espressif/esp-webrtc-solution`** — _The modern reference._ Components: `esp_webrtc` (session/orchestration), `esp_peer` (peer-connection abstraction: ICE / DTLS-SRTP / RTP, with a default implementation and the ability to sit over libpeer), `esp_capture` (capture→encode graph, Opus for audio, H.264 on P4). Ships an **OpenAI Realtime demo**, a **WHIP** ingest demo, and P2P video demos. Targets ESP32-S3 and ESP32-P4. _Steal:_ the whole signaling/transport layer, the capture-graph structure, and its demonstrated integration of Opus + AFE. Confidence: high on existence/structure; **verify the exact IDF pin (believed v5.4+) and the current P4 demo matrix in the README.**
- **`espressif/esp-sr`** (docs: `docs.espressif.com/projects/esp-sr`) — _The DSP front end._ AFE feed/fetch model: you `feed()` interleaved multi-channel PCM and `fetch()` cleaned mono + VAD/wake state. Frame/chunk size is queried at runtime via `get_feed_chunksize()` / `get_fetch_chunksize()` (commonly 16 ms @ 16 kHz = 256 samples — verify for your model pack). _Steal:_ the VC config for full-duplex, and the exact channel-format string that matches your ES7210 slot map.
- **ES7210 (4-ch ADC, TDM) + ES8311 (mono codec/DAC)** as used on **ESP32-S3-Korvo-2** and **ESP32-S3-BOX-3** — _The canonical hardware AEC topology._ The ES7210 carries mics + a playback loopback in TDM slots so AFE gets a time-aligned reference for free. _Steal:_ the schematic topology and the `i2s_tdm` slot configuration.

**Tier 2 — strong references / building blocks**

- **`openai/openai-realtime-embedded-sdk`** — ESP32-S3 (esp-box) client for the OpenAI Realtime API over WebRTC, built on `libpeer`, Opus, needs PSRAM. _Steal:_ concrete end-to-end wiring of an LLM voice loop; a good contrast to Espressif's own esp-webrtc OpenAI demo.
- **`sepfy/libpeer`** — Lightweight C WebRTC (DTLS-SRTP via mbedTLS, ICE, SCTP datachannel, RTP). The de-facto embedded WebRTC lib underneath the OpenAI SDK. _Steal:_ use it if you need a smaller footprint than esp_webrtc or want to understand the transport internals.
- **ESPHome voice pipeline** (`voice_assistant`, `micro_wake_word`, `i2s_audio`, `speaker`/`media_player`, `microphone`) and **Home Assistant Voice Preview Edition (Voice PE)** hardware — ESP32-S3, dual-mic, on-device streaming wake word via TFLite-Micro (`micro_wake_word`), streams to HA server for STT/intent/TTS. _Steal:_ a genuinely hand-tuned, shipped S3 audio+network design and its ring-buffer/latency handling. **Verify whether Voice PE does on-device AEC and via what mechanism (software vs. a dedicated part) — this is contested and I could not confirm it live.**
- **`toverainc/willow`** (+ Willow Inference Server) — S3 (Korvo-2/BOX) firmware using esp-sr AFE, streaming to self-hosted inference. _Steal:_ AFE-to-network streaming patterns. **Flag: activity appeared to slow in 2024 — treat as reference, not an active upstream; verify last-commit date.**

**Tier 3 — legacy / caution**

- Classic-ESP32 SIP/RTP/doorbell projects (G.711 over UDP): mostly IDF v4.x-era, legacy `driver/i2s.h`, no real AEC. Useful only for RTP/SIP framing ideas. **Legacy — do not base new work on these.**
- **`esp-adf` vs `esp-gmf`:** esp-adf is the mature but historically IDF-lagging pipeline framework (audio_element/pipeline/event graph). `esp-gmf` (General Multimedia Framework) is the newer, more modular successor paired with `esp_audio_codec`, designed for recent IDF v5.x. Prefer GMF for new work but **verify its maturity — it was newer/maturing as of my knowledge.**

### 2. Load-management craft (concrete knobs)

- **Core split:** Wi-Fi + lwIP on core 0. Set `CONFIG_ESP32_WIFI_TASK_CORE_ID=0` and `CONFIG_LWIP_TCPIP_TASK_AFFINITY` to core 0; `xTaskCreatePinnedToCore(..., APP_CPU_NUM /*1*/)` for the I2S read, AFE feed/fetch, and encoder tasks. This keeps the ~priority-23 Wi-Fi task from preempting audio on the same core.
- **Priorities & ISR discipline:** I2S DMA completion is handled in ISR → hand off with a **direct-to-task notification (`xTaskNotifyFromISR`)**, not a queue, to the I2S read task (high prio, e.g. 20-22). AFE compute task moderate-high; network TX task lower. Never block or run DSP in ISR context; keep ISRs to a notify + return.
- **DMA tuning (new driver):** set `dma_desc_num` (buffer count, 3-8) and `dma_frame_num` (frames/buffer) so one DMA buffer ≈ one AFE frame (16 ms). More/larger buffers absorb Wi-Fi jitter at the cost of latency and RAM.
- **Inter-stage buffering:** FreeRTOS StreamBuffer / ADF ringbuf between capture → AFE → encoder → net, sized to hold worst-case Wi-Fi jitter (budget ~100-200 ms of buffering somewhere in the path, biased toward the network side so DSP stays deterministic).
- **Watchdog:** long AFE compute or a blocked network send can trip the Task WDT (`CONFIG_ESP_TASK_WDT`) — ensure the audio task yields and that no stage busy-waits on the network.
- **Measurement:** `vTaskGetRunTimeStats` for per-task CPU, `esp_cpu_get_cycle_count()` around DSP stages, GPIO-toggle-and-scope for jitter, SEGGER SystemView for scheduling traces, `esp_perfmon` for counter-based profiling. **I could not verify specific published CPU%/jitter/latency figures — measure on your own board and model pack.**

### 3. AEC specifics

- Use the **VC (voice communication) AFE profile** for full-duplex calling (the SR profile is tuned for wake-word/command recognition, not conversational echo).
- **Reference feed:** hardware TDM reference via ES7210 is strongly preferred; software loopback works only if you can guarantee a stable, bounded playback→capture delay. AFE AEC tolerates a bounded echo-path delay on the order of tens of ms — **verify the exact tolerance for your model version.**
- **CPU:** AEC is the heaviest AFE stage; on S3 the AFE chain consumes a large fraction of one 240 MHz core, which is exactly why you isolate it on core 1. On P4 the higher clock + DSP extensions give meaningful headroom. **Exact CPU% per stage for S3 vs P4 needs live verification — do not quote a number you haven't measured.**
- **Alternatives:** SpeexDSP (`libspeexdsp`) MDF AEC runs on S3 and is lighter but lower quality and worse with variable delay — a fallback, not a first choice. **Full WebRTC APM/AEC3 is impractical on S3** (FP/RAM/CPU cost) and only marginally plausible on P4; I am aware of no well-known shipped AEC3-on-ESP32 project — verify before assuming it exists. esp-sr's AEC wins on ESP32 precisely because it's tuned for the silicon and integrates the ES7210 hardware reference.

### 4. Audio vs Wi-Fi contention (the hard part)

- **IRAM:** enable `CONFIG_ESP32_WIFI_IRAM_OPT` and `CONFIG_ESP32_WIFI_RX_IRAM_OPT` (and `CONFIG_ESP_WIFI_SLP_IRAM_OPT` if using sleep); mark hot audio ISR/DSP functions `IRAM_ATTR`. This prevents flash-cache-miss stalls in the audio path. IRAM is finite — you're trading Wi-Fi RX speed against audio code residency, so profile both.
- **PSRAM/cache contention (the big one on S3):** Wi-Fi DMA, flash cache, and PSRAM share bus/cache bandwidth. Keep latency-critical audio buffers in **internal SRAM**; use **octal PSRAM** (roughly double the bandwidth of quad) if buffers must live in PSRAM; avoid `CONFIG_SPIRAM_FETCH_INSTRUCTIONS`/`CONFIG_SPIRAM_RODATA` (running code/rodata from PSRAM hurts real-time).
- **Wi-Fi buffers:** prefer static RX buffers (`CONFIG_ESP_WIFI_STATIC_RX_BUFFER_NUM`) for determinism over dynamic; consider disabling/limiting AMPDU aggregation (`CONFIG_ESP_WIFI_AMPDU_*`) to cut burst jitter that hurts real-time audio.
- **Flash stalls:** OTA writes and SPIFFS/NVS reads **disable the flash cache**, stalling any non-IRAM code → audio glitches. Do not run OTA or filesystem I/O during an active call, and keep the audio path in IRAM.
- **Power management:** with `CONFIG_PM_ENABLE`/DFS the APB clock can shift mid-stream and corrupt I2S timing. Acquire an **`esp_pm_lock` of type `ESP_PM_APB_FREQ_MAX`** (and disable light sleep) for the duration of a call, release when idle.
- **Evidence:** there are numerous `espressif/esp-idf` GitHub issues and esp32.com forum threads documenting exactly these Wi-Fi/PSRAM/I2S-dropout debugging sessions. **I could not retrieve specific issue numbers/URLs live — search `github.com/espressif/esp-idf/issues` for "I2S Wi-Fi dropout / PSRAM glitch" and the esp32.com audio subforum.**

### 5. Write-ups & talks

- **Espressif DevCon** (annual, 2023-2025) has talks on ESP-ADF, esp-sr voice, ESP32-P4, and more recently WebRTC/OpenAI Realtime and `esp-gmf`; videos are on Espressif's YouTube channel. **Exact 2025 talk titles/links need live verification.**
- **Espressif developer blog** (`developer.espressif.com/blog`) covers the P4 launch, ESP-Hosted, esp-webrtc, and the OpenAI Realtime demo. **Verify specific posts.**

### 6. ESP32-P4 angle

- **Silicon:** dual-core RISC-V up to 400 MHz + an LP core, DSP/SIMD extensions, large internal SRAM, high-bandwidth PSRAM interface, hardware H.264, MIPI-CSI/DSI. **No integrated radio.**
- **Connectivity:** Wi-Fi/BLE via an external **ESP32-C6** running **`esp-hosted` (esp-hosted-mcu)** over **SDIO** (fast) — this is the topology on the ESP32-P4-Function-EV-Board.
- **Why it helps audio+AEC:** the Wi-Fi MAC/PHY, driver, and ISR load live on the C6, so the P4's two cores don't fight the Wi-Fi stack for CPU the way a single S3 does — much cleaner isolation for AEC-heavy full-duplex audio. The P4 mainly runs SDIO transport + lwIP.
- **The trade-off:** SDIO transport + the host-side ESP-Hosted stack add latency and cap throughput vs. S3's integrated radio, and the whole P4+C6 path is newer and less battle-tested. Also note ESP-DSP optimized kernels benefit both, but the P4's DSP extensions give it the bigger DSP ceiling. **Verify current 2026 maturity of esp-webrtc/esp-sr on P4 and the ESP-Hosted latency budget.**

## Recommendations

**Stage 0 — hardware:** Choose the ES7210 (4-ch TDM ADC) + ES8311 (codec/DAC) topology so AEC gets a hardware reference. If you deviate from this, you are signing up to solve software-loopback delay alignment yourself. Prototype on ESP32-S3-Korvo-2 or ESP32-S3-BOX-3.

**Stage 1 — software baseline (S3):** Start from `esp-webrtc-solution` (transport) + `esp-sr` AFE in the VC profile (DSP), new `i2s_tdm` driver + `esp_codec_dev`. Get a clean one-way stream working first, then enable AEC and confirm reference alignment before tuning anything else.

**Stage 2 — load isolation:** Pin Wi-Fi/lwIP to core 0, all audio to core 1; ISR→task via `xTaskNotifyFromISR`; latency-critical buffers in internal SRAM; octal PSRAM; `esp_pm_lock(ESP_PM_APB_FREQ_MAX)` during calls; `IRAM_ATTR` on hot audio code + `CONFIG_ESP32_WIFI_IRAM_OPT`; static Wi-Fi RX buffers; limit AMPDU if you see jitter. Measure per-task CPU with run-time stats and jitter with a GPIO+scope.

**Stage 3 — decide S3 vs P4:** Stay on S3 if audio-only and the CPU budget holds (measure AFE headroom first). Move to **P4+C6** if you add video, need multi-mic beamforming + AEC + codec simultaneously, or if S3 CPU/contention measurements show you're out of margin.

**Thresholds that change the plan:**

- If per-frame AFE + encode consistently exceeds ~60-70% of one core, or you see periodic dropouts that survive the IRAM/SRAM/PM fixes → go P4.
- If OTA/telemetry must run _during_ calls → you _must_ have the audio path fully in IRAM, or move to P4+C6 where the network work is offloaded.
- If AEC quality is poor → **first verify reference-channel time alignment** (hardware TDM slot mapping, playback→capture delay) before blaming the algorithm or swapping in SpeexDSP.

## Caveats

- **This report was produced without live web verification** due to an environment-wide tool failure (search, fetch, and the enrichment pass all returned errors). Repo paths and Kconfig symbols are reliable; **version numbers, exact CPU/latency/frame-size figures, current repo activity, and specific talk/issue URLs must be confirmed** against the live READMEs, `docs.espressif.com/projects/esp-sr`, and GitHub before architectural commitment.
- Willow and many SIP/RTP hobby repos may be stale/abandoned — verify last-commit dates.
- Home Assistant Voice PE's on-device AEC handling is uncertain in my sources.
- No verified evidence of a production WebRTC AEC3 port to ESP32; treat any such claim skeptically until you see a repo that builds and runs it on target.
- `esp-gmf` vs `esp-adf` maturity and the exact IDF pins of `esp-webrtc-solution` should be checked live — these are moving fast in the 2024-2026 window.
