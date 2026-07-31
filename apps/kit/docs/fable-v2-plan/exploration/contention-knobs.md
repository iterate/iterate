# Call-time realtime discipline: the verified knob list (S3 targets)

Date: 2026-07-31. Scope: turns §2/§4 of the prior-art report
(`inputs/jonas-prior-art-report-2026-07-31.md`) into concrete, verified,
plan-ready configuration, with **v1's actual current state as the baseline**.

Verification sources (everything checked live, nothing taken from the report on
trust):

- **Kconfig ground truth:** local clone `~/src/github.com/espressif/esp-idf`
  at tag **v5.5.3** (`2c211b2367`). Note: v1 builds against **IDF 5.4.2**
  (`targets/m5sticks3/dependencies.lock`), the clone is 5.5.3; every symbol
  below uses the `ESP_WIFI_*` naming that has been stable across all of IDF
  5.x (the rename off the v4 `ESP32_WIFI_*` names is recorded in
  `components/esp_wifi/sdkconfig.rename:6-28`). Where a help-text number is
  quoted, it is from the 5.5.3 tree.
- **v1 baseline:** `apps/kit/firmware/targets/m5sticks3/sdkconfig.defaults`
  (11 deliberate lines) and the generated `sdkconfig` (what everything
  actually resolved to), plus the linker map
  `targets/m5sticks3/build/iterate-kit-m5sticks3.map` and the transport /
  audio sources. All paths below relative to `apps/kit/firmware/` unless
  rooted.
- **Reference stacks (local clones, real shipping configs):** HA Voice PE
  (`~/src/github.com/esphome/home-assistant-voice-pe/home-assistant-voice.yaml`),
  xiaozhi (`~/src/github.com/78/xiaozhi-esp32/sdkconfig.defaults*`),
  Espressif's own voice examples (`~/src/github.com/espressif/esp-skainet`).

---

## 1. Three findings that reframe the report before any knob is touched

### 1.1 The Wi-Fi IRAM options the report tells us to enable are already on

`CONFIG_ESP_WIFI_IRAM_OPT` and `CONFIG_ESP_WIFI_RX_IRAM_OPT` are **default-y
in IDF 5.x** and are set in v1's resolved config (`sdkconfig:1292,1294`).
§4's "enable `CONFIG_ESP32_WIFI_IRAM_OPT` / `CONFIG_ESP32_WIFI_RX_IRAM_OPT`"
is (a) v4-era names and (b) a no-op recommendation — we are already paying
their cost. The _live_ question is the opposite one: whether to **disable**
them to buy back internal RAM (xiaozhi ships `CONFIG_ESP_WIFI_IRAM_OPT=n`
and `CONFIG_ESP_WIFI_RX_IRAM_OPT=n` — `xiaozhi-esp32/sdkconfig.defaults:27-28`
— explicitly to fund audio memory). Verdict on the report: **NUANCED**
(mechanism right, names stale, recommendation vacuous as written).

### 1.2 "One byte of IRAM free" is not a link ceiling — it is a DIRAM budget

Verified from the linker map and `components/esp_system/ld/esp32s3/memory.ld.in`:

- On S3, `iram0_0_seg` starts at `0x40370000 + icache size` and spans the
  leftover of SRAM0 **plus the shared D/IRAM**. With v1's 16 KB instruction
  cache (`sdkconfig:1144`), the instruction-only leftover block is exactly
  16,384 bytes.
- v1's IRAM code totals **96,000 bytes** (`.iram0.vectors` 0x403 +
  `.iram0.text` 0x1728f, `_iram_end = 0x4038b700`, map lines 44524, 44639).
  It fills the 16 KB pure block **and spills 79,616 bytes into shared
  D/IRAM** — that spill is exactly the `.dram0.dummy` fill of 0x13700 at map
  line 49839, the linker's mechanism for stealing DRAM address space 1:1.
- Therefore: **new `IRAM_ATTR` code links fine.** The 16,383/16,384 figure in
  `docs/physical-device-voice-goal.md:352-354` is the pure-IRAM block, which
  is _always_ ~full once code spills past it — that is the linker doing its
  job, not a crisis. The real, finite budget is **DIRAM**: segment
  341,760 bytes (`dram0_0_seg len 0x53700`), 199,295 statically used
  (58.31 %), 142,465 static free, ~77.8 KiB runtime internal heap free at
  idle (goal doc:347). The architecture review's "any new `IRAM_ATTR` will
  not link" (review §4.5) is **REFUTED**; the plan's D6 rule "zero net IRAM
  growth" should be restated as **"every IRAM byte is a DIRAM byte — account
  it against the 31–60 KB internal the AEC needs"**. The R4 clawback chore is
  still right, but it is a DIRAM ledger, not a link-failure firefight.

### 1.3 The pm_lock recommendation is moot in v1 — and would not even compile away quietly

`CONFIG_PM_ENABLE` is **not set** (`sdkconfig:1080`). With PM off there is no
DFS, no APB shifting, no light sleep, and no tickless idle
(`FREERTOS_USE_TICKLESS_IDLE` _depends on_ `PM_ENABLE`,
`components/freertos/Kconfig:319-323` — the symbol does not even appear in
v1's sdkconfig). Moreover `esp_pm_lock_create()` returns
`ESP_ERR_NOT_SUPPORTED` when PM is off (`components/esp_pm/pm_locks.c:52-53`),
so "hold an `esp_pm_lock` during calls" cannot be sprinkled in defensively —
it would error. Verdict: **MOOT today; CONFIRMED-correct advice if and only
if PM is ever enabled** (battery pressure), at which point
`ESP_PM_APB_FREQ_MAX`/`ESP_PM_CPU_FREQ_MAX`/`ESP_PM_NO_LIGHT_SLEEP`
(`components/esp_pm/include/esp_pm.h:47-57`) land in the same commit.

### 1.4 (Bonus) What the report never mentions but the references shout

v1 runs the CPU at **160 MHz** (`sdkconfig:1137` — the IDF default) with
`-Os` (`sdkconfig.defaults:1`) and **PSRAM clocked at 40 MHz**
(`sdkconfig:1104` — also the default). Every shipping S3 voice stack we can
read runs **240 MHz** (xiaozhi `sdkconfig.defaults.esp32s3:3`, 8 of
esp-skainet's examples) and **80 MHz PSRAM** (15 esp-skainet examples,
xiaozhi), and all three reference stacks enlarge the caches (HA VPE yaml
66-69: icache 32 KB, dcache 64 KB, 64-B lines; xiaozhi: icache 32 KB,
64-B dcache lines; esp-skainet: 9 examples with all three). The esp-sr CPU
budgets the plan quotes (~20 % of a core for AEC) are measured at 240 MHz —
at 160 MHz they are ~1.5×. These are bigger levers than most of §4.

---

## 2. The knob table

Stages refer to PLAN.md §2. "v1 today" is the resolved `sdkconfig` in the
worktree right now. DIRAM costs are 1:1 with IRAM placement per §1.2.

| #   | Knob                          | Verified symbol (IDF 5.x)                                                                                                                                                                                                                             | v1 today                                                                                                                          | v2 recommendation                                                                                                                                                                                                                                                                                                                                                                                             | Stage                             | Risk                                                                                                                                              |
| --- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Wi-Fi task core pin           | choice `ESP_WIFI_TASK_CORE_ID` → `CONFIG_ESP_WIFI_TASK_PINNED_TO_CORE_0` (`esp_wifi/Kconfig:235`). Report's `CONFIG_ESP32_WIFI_TASK_CORE_ID` never existed; v4 name was `ESP32_WIFI_TASK_PINNED_TO_CORE_0` (`sdkconfig.rename:23`)                    | Core 0 (default, `sdkconfig:1288`)                                                                                                | Keep. Already correct                                                                                                                                                                                                                                                                                                                                                                                         | —                                 | none                                                                                                                                              |
| 2   | lwip tcpip task affinity      | choice → `CONFIG_LWIP_TCPIP_TASK_AFFINITY_CPU0`; value symbol `CONFIG_LWIP_TCPIP_TASK_AFFINITY` (`lwip/Kconfig:883-904`)                                                                                                                              | **NO affinity** — tcpip floats across both cores (`sdkconfig:1648-1651`, value 0x7FFFFFFF)                                        | **Set CPU0.** The one §2 recommendation that is a real delta. Keeps tcpip (prio 18) off core 1's cache and cycles; audio task is prio 19 so preemption was never the issue — pollution is                                                                                                                                                                                                                     | 1                                 | negligible; core 0 already hosts wifi task + both net tasks                                                                                       |
| 3   | Wi-Fi IRAM opt                | `CONFIG_ESP_WIFI_IRAM_OPT` (`esp_wifi/Kconfig:274`; disabling saves ">10 Kbytes of IRAM", costs throughput)                                                                                                                                           | **y** (default)                                                                                                                   | Keep on for v2.0. Re-decide at the R4 DIRAM ledger: disabling frees >10 KB DIRAM (xiaozhi precedent). Our PCM is 32 kB/s/direction — throughput is not our constraint, but IRAM-resident Wi-Fi code also reduces flash-cache pressure, which we do care about                                                                                                                                                 | 1 (audit) / 5 (re-decide for AEC) | disabling risks more flash-cache misses in hot path                                                                                               |
| 4   | Wi-Fi RX IRAM opt             | `CONFIG_ESP_WIFI_RX_IRAM_OPT` (`Kconfig:292`; disabling saves ">17 Kbytes")                                                                                                                                                                           | **y** (default)                                                                                                                   | Same as #3. Together #3+#4 are a **~27 KB DIRAM** reserve we can raid if the AEC budget (31–60 KB internal) cannot close any other way                                                                                                                                                                                                                                                                        | 1 / 5                             | same as #3                                                                                                                                        |
| 5   | Wi-Fi extra IRAM opt          | `CONFIG_ESP_WIFI_EXTRA_IRAM_OPT` (`Kconfig:283`; ">5 Kbytes", default n on S3)                                                                                                                                                                        | n                                                                                                                                 | Leave off. Throughput-only benefit, DIRAM cost                                                                                                                                                                                                                                                                                                                                                                | —                                 | none                                                                                                                                              |
| 6   | Wi-Fi sleep IRAM opt          | `CONFIG_ESP_WIFI_SLP_IRAM_OPT` (`Kconfig:343`; +7.3 KB over IRAM_OPT)                                                                                                                                                                                 | n                                                                                                                                 | Leave off — meaningless while `WIFI_PS_NONE` is set at `platforms/iterate_esp_idf/itx_transport.c:1122`                                                                                                                                                                                                                                                                                                       | —                                 | none                                                                                                                                              |
| 7   | lwip IRAM opts                | `CONFIG_LWIP_IRAM_OPTIMIZATION` (~10 KB, "improve UDP/TCP throughput by >10% for single core mode, doesn't help too much for dual core", `lwip/Kconfig:82-91`) and `CONFIG_LWIP_EXTRA_IRAM_OPTIMIZATION` (~17 KB, TCP part)                           | both off (`sdkconfig:1551-1552`)                                                                                                  | Leave off. We are dual-core and bandwidth-trivial; 27 KB DIRAM is worth more to AEC than lwip speed                                                                                                                                                                                                                                                                                                           | —                                 | none                                                                                                                                              |
| 8   | Power management / DFS        | `CONFIG_PM_ENABLE` (`esp_pm/Kconfig:14`); locks `ESP_PM_APB_FREQ_MAX` etc. (`esp_pm.h:47-57`); `FREERTOS_USE_TICKLESS_IDLE` gated on it                                                                                                               | **off** — no DFS, no light sleep, no tickless; pm_lock calls would return `ESP_ERR_NOT_SUPPORTED` (`pm_locks.c:52`)               | Keep off through v2.0 (mains-powered dev fleet). Write into the profile struct docs: _if_ PM is ever enabled, the same commit adds call-scoped `ESP_PM_APB_FREQ_MAX` + `ESP_PM_NO_LIGHT_SLEEP` locks                                                                                                                                                                                                          | — (doc note in 3)                 | enabling PM without locks would corrupt I2S timing — that is why it stays a single atomic change                                                  |
| 9   | CPU frequency                 | `CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ_240` (`sdkconfig:1136-1139`)                                                                                                                                                                                         | **160 MHz**                                                                                                                       | **Raise to 240** with a before/after rig pass. All reference voice stacks use 240; esp-sr budgets assume it. Caveat: this board has a brownout history under audio load (rail-sag) — run the endurance rung and the tone proof at 240 before keeping it                                                                                                                                                       | 1 (flip + measure)                | +power draw, brownout margin on the Stick; revert is one line                                                                                     |
| 10  | Compiler optimization         | `CONFIG_COMPILER_OPTIMIZATION_PERF` vs `_SIZE`                                                                                                                                                                                                        | `-Os` (`sdkconfig.defaults:1`)                                                                                                    | Keep `-Os` globally (flash-code footprint = cache pressure); apply `-O2` per-component to the audio/DSP components when real DSP lands (component-level `target_compile_options`), like xiaozhi does for its P4 build                                                                                                                                                                                         | 5                                 | image growth; none if scoped per-component                                                                                                        |
| 11  | Wi-Fi static RX (DMA) buffers | `CONFIG_ESP_WIFI_STATIC_RX_BUFFER_NUM` (~1.6 KB each, allocated at `esp_wifi_init`, "hardware use these buffers to receive all 802.11 frames", `Kconfig:26-41`)                                                                                       | 10 (= 16 KB internal)                                                                                                             | Keep 10. See verdict below — the report's "prefer static RX for determinism" misreads this knob: there is **no static-vs-dynamic choice on RX**; both layers always exist (static = DMA ring, dynamic = driver→lwip copies). If DIRAM gets desperate: 10→6 is xiaozhi-proven (they ship 3–6) but shrink only with the rig watching downlink jitter                                                            | 5 (only if ledger demands)        | too few → packet drops under burst, retransmits, jitter                                                                                           |
| 12  | Wi-Fi dynamic RX buffer cap   | `CONFIG_ESP_WIFI_DYNAMIC_RX_BUFFER_NUM` (`Kconfig:42`)                                                                                                                                                                                                | 32                                                                                                                                | Keep 32 (it is a cap, not a static cost; only ~allocated under load)                                                                                                                                                                                                                                                                                                                                          | —                                 | none                                                                                                                                              |
| 13  | Wi-Fi TX buffer type/count    | choice `ESP_WIFI_TX_BUFFER` → `CONFIG_ESP_WIFI_DYNAMIC_TX_BUFFER`, `_NUM` (`Kconfig:78-118`; "If PSRAM is enabled, Static should be selected" applies to the `SPIRAM_TRY_ALLOCATE_WIFI_LWIP` configuration, which v1 does not use — `sdkconfig:1115`) | Dynamic, 32                                                                                                                       | Keep                                                                                                                                                                                                                                                                                                                                                                                                          | —                                 | none                                                                                                                                              |
| 14  | AMPDU aggregation             | `CONFIG_ESP_WIFI_AMPDU_TX_ENABLED`, `CONFIG_ESP_WIFI_AMPDU_RX_ENABLED`, `CONFIG_ESP_WIFI_RX_BA_WIN` (`Kconfig:175-213`)                                                                                                                               | TX y, RX y, BA win 6 (`sdkconfig:1283-1286`)                                                                                      | **Do not globally disable in v2.0.** First do the surgical version: tag the `/pcm` socket `IP_TOS` precedence 6 → **AC_VO, which never aggregates** (official table + sample code, `docs/en/api-guides/wifi.rst:2887-2907`). Global `AMPDU_TX=n` is the measured-escalation path if the rig's jitter scenario correlates stalls with aggregation; `RX_BA_WIN` 6→3 (xiaozhi ships 3) is the downlink half-step | 4 (QoS tag) / 5 (escalation)      | AC_VO shares its queue with mgmt frames — fine at 32 kB/s, do not put bulk traffic there; global disable cuts throughput for everything incl. OTA |
| 15  | SPIRAM XIP                    | `CONFIG_SPIRAM_FETCH_INSTRUCTIONS`, `CONFIG_SPIRAM_RODATA`, helper `CONFIG_SPIRAM_XIP_FROM_PSRAM` (`esp_psram/esp32s3/Kconfig.spiram:48-81`)                                                                                                          | all off                                                                                                                           | **Keep off at every stage** — pre-AEC there is nothing to gain (audio path has zero PSRAM traffic to protect code from), post-AEC the AFE streams 90–780 KB of model data from PSRAM and instruction-fetch traffic on the same octal bus raises tail latency. Full analysis §3 below — this is a genuine judgment call where HA VPE chose the other side                                                      | — (decision point recorded for 5) | forgoing the flash-write-concurrency benefit — covered instead by the no-flash-writes invariant (§4.1)                                            |
| 16  | PSRAM clock                   | `CONFIG_SPIRAM_SPEED_80M` (`Kconfig.spiram:83-108`; 120 M octal is explicitly experimental/temperature-unstable)                                                                                                                                      | **40 MHz** (default)                                                                                                              | **Set 80 MHz** as part of stage 1's "enable + smoke-test PSRAM" chore (R4-ii). 15 esp-skainet examples + xiaozhi ship 80 M. Never 120 M on octal                                                                                                                                                                                                                                                              | 1                                 | needs the PSRAM smoke test that stage 1 already schedules                                                                                         |
| 17  | Flash auto-suspend            | `CONFIG_SPI_FLASH_AUTO_SUSPEND` (`spi_flash/Kconfig`, "READ DOCS FIRST"; depends `SOC_SPI_MEM_SUPPORT_AUTO_SUSPEND` — S3 = 1 per `soc/esp32s3/include/soc/soc_caps.h:550` — and specific flash-chip support + bootloader support)                     | off                                                                                                                               | Leave off. Chip-specific, bootloader-coupled, and unnecessary once the no-flash-writes-during-audio invariant holds                                                                                                                                                                                                                                                                                           | —                                 | enabling on an unsupported flash chip = corruption                                                                                                |
| 18  | Task watchdog                 | `CONFIG_ESP_TASK_WDT_TIMEOUT_S`, `_CHECK_IDLE_TASK_CPU0/1` (`sdkconfig:1215-1220`); `CONFIG_INT_WDT_TIMEOUT_MS` (`sdkconfig:2235`)                                                                                                                    | TWDT 5 s watching both idle tasks; INT WDT 300 ms                                                                                 | **Keep exactly as is.** AFE frames are 10–32 ms — 2 orders under 5 s; no headroom problem exists. The core-1 idle-task watch is a _feature_: it is the built-in capture-starvation/busy-loop canary. Do not subscribe audio tasks to the TWDT; do not raise to 10 s (xiaozhi does; we prefer fast-fail)                                                                                                       | —                                 | none                                                                                                                                              |
| 19  | I2S ISR flash-safety          | `CONFIG_I2S_ISR_IRAM_SAFE`                                                                                                                                                                                                                            | **y** (`sdkconfig.defaults:19`, with rationale comment)                                                                           | Keep — this is what lets I2S DMA completions fire during any cache-disabled window (mechanism §4.1)                                                                                                                                                                                                                                                                                                           | —                                 | none                                                                                                                                              |
| 20  | Cache geometry                | `CONFIG_ESP32S3_INSTRUCTION_CACHE_32KB`, `CONFIG_ESP32S3_DATA_CACHE_64KB`, `CONFIG_ESP32S3_DATA_CACHE_LINE_64B`                                                                                                                                       | 16 KB icache / 32 KB dcache / 32-B lines (`sdkconfig:1144-1163`)                                                                  | Benchmark icache 32 KB on the rig; all three reference stacks chose it (HA VPE yaml:67-69, xiaozhi, 9× esp-skainet). Costs: icache 32 KB eats the 16 KB pure-IRAM block → +16,384 B effective DIRAM use; dcache 64 KB costs 32 KB DRAM. Decide against the R4 DIRAM ledger, after AEC's 31–60 KB is reserved                                                                                                  | 2 (benchmark) / 5 (decide)        | internal heap 77.8 KiB → ~61 KiB (icache) → ~29 KiB (both) — dcache 64 KB probably unaffordable                                                   |
| 21  | Wi-Fi power save              | runtime API `esp_wifi_set_ps(WIFI_PS_NONE)` (not a Kconfig)                                                                                                                                                                                           | Called at `itx_transport.c:1122` with a written rationale                                                                         | Keep; promote to call-time invariant (§4.3)                                                                                                                                                                                                                                                                                                                                                                   | —                                 | battery cost, accepted                                                                                                                            |
| 22  | Runtime measurement           | `CONFIG_FREERTOS_GENERATE_RUN_TIME_STATS` + `_RUN_TIME_COUNTER_TYPE_U64` + esp_timer source (`sdkconfig.defaults:21-23`), `CONFIG_FREERTOS_USE_TRACE_FACILITY` (`sdkconfig:1425`)                                                                     | all on; per-core CPU%% already derived from `ulTaskGetIdleRunTimeCounterForCore` (`platforms/iterate_m5unified/m5unified.cpp:33`) | Make permanent (§5): per-task `uxTaskGetSystemState` snapshot into the event/metrics schema + `esp_cpu_get_cycle_count()` around every processor stage                                                                                                                                                                                                                                                        | 2/3                               | stats tick cost is already being paid                                                                                                             |

---

## 3. The SPIRAM_FETCH_INSTRUCTIONS / SPIRAM_RODATA decision (report vs HA VPE vs us)

The report says avoid (§4: "running code/rodata from PSRAM hurts real-time").
The IDF 5.5.3 help text sells the opposite: with both enabled, "code that
requires execution during an MSPI1 Flash operation can forgo being placed in
IRAM … codes that need to be executing during Flash operation can continue
working normally" (`esp_psram/esp32s3/Kconfig.spiram:56-81`), and the flash
concurrency doc confirms the cache then stays enabled during flash writes
(`docs/en/api-reference/peripherals/spi_flash/spi_flash_concurrency.rst:22,43`).

**CONFIRMED: HA Voice PE ships production voice firmware with both enabled**,
with its reasoning in-file: "Both enabled allows instructions to execute while
a flash operation is in progress without needing to be placed in IRAM.
Considerably speeds up mWW at the cost of using more PSRAM"
(`home-assistant-voice-pe/home-assistant-voice.yaml:71-75`). The
esphome-audio-stack AFE docs go further and recommend it as an IRAM
substitute (`esphome-audio-stack/esphome/components/esp_afe/README.md:559`).
Espressif's own esp-skainet voice examples, meanwhile, do **not** enable it.

Why we still say **off at every stage**:

- **Pre-AEC (stages 0–4):** v1's audio path touches zero PSRAM and the whole
  hot path already fits internal. XIP would add PSRAM bus traffic and PSRAM
  capacity use for exactly no benefit — the problems it solves (flash-write
  concurrency, IRAM scarcity) are handled by the no-flash-writes invariant
  (§4.1) and the DIRAM ledger (§1.2).
- **Post-PSRAM-enable / AEC (stage 5):** the AFE continuously fetches
  90–780 KB of model weights from PSRAM. Adding icache miss-fill traffic to
  the same octal MSPI bus is precisely the "cache/bus sharing" contention §4
  of the report warns about — the report is _right_ here, and HA VPE's
  counter-example is explained by its different constraints: it wants OTA and
  NVS writes while listening (an always-on appliance), runs BLE, and tuned for
  wake-word throughput, not conversational tail latency.
- **Recorded escape valve:** if the stage-5 DIRAM ledger cannot close for
  AEC even after raiding knobs #3/#4, XIP-from-PSRAM is the documented
  alternative that relieves IRAM/DIRAM pressure at PSRAM-bandwidth cost —
  and if it is ever enabled, `SPIRAM_SPEED_80M` (#16) becomes mandatory, not
  advisory. Verdict on the report's "avoid": **NUANCED — right default for
  us, but it is a tradeoff with a shipping counter-example, not a law.**

---

## 4. Call-time invariants (for PLAN.md — each with its mechanism)

1. **No internal-flash writes while an audio session is active.** No NVS
   commits, no OTA, no SPIFFS, no partition writes. Mechanism: any SPI1
   flash write/erase disables both caches; while disabled, **all other tasks
   are suspended, non-IRAM interrupts are disabled, and the other core spins
   in a busy loop** until the operation completes
   (`spi_flash_concurrency.rst:31,47` — "The way that these APIs disable the
   caches suspends all the other tasks… The other core will be polling in a
   busy loop"). A single NVS commit mid-call = a guaranteed multi-ms
   audio-pipeline freeze on _both_ cores. v1 already conforms: Wi-Fi
   credentials stay in RAM (`esp_wifi_set_storage(WIFI_STORAGE_RAM)`,
   `itx_transport.c:1113`), NVS is written only at provisioning/first-boot
   recovery (`itx_transport.c:1024-1037`), and there is no OTA code in the
   tree. Enforcement: rig scenario asserts no flash-write event records occur
   between capture-session start/end events; future OTA schedules itself in
   D8's provider-idle window.
2. **SD-card writes are exempt from invariant 1 — by bus, not by policy.**
   The cache-stall constraint applies to the SPI0/1 bus that firmware
   executes from ("operations to SPI1 will cause significant influence…",
   `spi_flash_concurrency.rst:8`). The Waveshare SD slot is native SDMMC
   1-bit (verified: PLAN.md §8 item 6), a separate peripheral — SD/FATFS
   writes never disable the cache. **CONFIRMED: SD logging during calls is
   safe by construction.** One guard: never attach an SD card via the SPI1
   bus on any future board (the doc's constraint covers "other SPI slave
   devices" on SPI1 too).
3. **Wi-Fi power save off whenever a session can start:** `WIFI_PS_NONE` at
   connect (`itx_transport.c:1122`). Mechanism: modem sleep delays RX until
   DTIM beacons — incompatible with 20 ms bidirectional cadence.
4. **Clocks are fixed by construction:** PM/DFS disabled (`sdkconfig:1080`).
   The pm-locks discipline is intentionally _absent_ (it would error,
   `pm_locks.c:52`) and must arrive in the same commit that ever enables PM.
5. **Core/priority map is law:** audio task prio 19 on core 1
   (`platforms/iterate_m5unified/include/iterate/kit/platforms/m5sticks3_direct_audio.hpp:171-172`);
   Wi-Fi task core 0 (`sdkconfig:1288`); main task core 0
   (`sdkconfig.defaults:6`); control/PCM network tasks prio 5/6 core 0
   (`esp_idf_websocket_policy.h:29-30`, `NETWORK_TASK_CORE=0` at
   `itx_transport.c:82`, `pcm_transport.c:71`); after knob #2, lwip pinned
   core 0. Rule: nothing ≥ prio 19 on core 1 except audio; no audio work on
   core 0. (The closed-source Wi-Fi task runs near the top of the 25-level
   range — `configMAX_PRIORITIES = 25`,
   `freertos/config/include/freertos/FreeRTOSConfig.h:93` — which is
   harmless while it is core-0-pinned.)
6. **ISRs that must survive cache-off windows are IRAM-safe:**
   `CONFIG_I2S_ISR_IRAM_SAFE=y` (`sdkconfig.defaults:19`). Mechanism:
   non-IRAM ISRs are simply not executed while caches are disabled and fire
   late afterwards (`spi_flash_concurrency.rst:78`).
7. **Every new IRAM_ATTR is a DIRAM ledger entry** (mechanism §1.2), recorded
   next to the 31–60 KB AEC reservation — replaces D6's "zero net IRAM
   growth (one byte free)" wording.
8. **TCP_NODELAY proven, not assumed, on both sockets** — v1 refuses to run
   if it cannot be set (`platforms/iterate_esp_idf/websocket_connection.c:321-327`).

---

## 5. Measurement kit: what to bake in permanently

Already on and partially consumed — keep forever:

- `FREERTOS_GENERATE_RUN_TIME_STATS` + U64 counter + esp_timer source
  (`sdkconfig.defaults:21-23`) and `FREERTOS_USE_TRACE_FACILITY`
  (`sdkconfig:1425`).
- Per-core CPU%% from idle counters
  (`ulTaskGetIdleRunTimeCounterForCore`, `m5unified.cpp:33`).
- The playback pipeline's own realtime counters — `dma_deadline_miss_incidents`,
  `receive_to_dma` latency min/max — already first-class metrics
  (`components/capabilities/include/iterate/kit/capabilities/metrics.h:51,70-71`).

Add permanently (stages 2–3, through the generated event schema):

- **Per-task runtime snapshot:** periodic `uxTaskGetSystemState` diff →
  per-task CPU%% as metric fields (the config cost is already paid; today only
  idle tasks are read).
- **Per-stage cycle counts:** `esp_cpu_get_cycle_count()`
  (`components/esp_hw_support/include/esp_cpu.h:181`, force-inlined register
  read, ~free) around capture handoff, `process()` (the D3 audio-processor
  call), and encode — reported as metric fields so every physical run records
  its DSP cost. This is the instrument that later decides the ~60–70 %-of-core
  "go P4" threshold with data.

Rig-only (never in the shipped image):

- **`perfmon`** (Xtensa performance counters — cache misses, stalls;
  component is xtensa-arch-gated, so S3 qualifies:
  `components/perfmon/CMakeLists.txt:9`) — a rig build flavor for the
  contention scenarios; this is the tool that would prove/disprove an
  AMPDU-vs-cache hypothesis instead of guessing.
- **SEGGER SystemView** (`CONFIG_APPTRACE_SV_ENABLE`,
  `components/app_trace/Kconfig:205`) — scheduling-trace debug builds only;
  note the Stick's console already occupies USB-Serial-JTAG
  (`sdkconfig.defaults:7`), so the apptrace transport needs checking before
  anyone plans on it.
- GPIO-toggle-and-scope stays the ground truth for jitter (report §2,
  CONFIRMED as practice — it is how the existing acoustic ladder works).

---

## 6. Verdict summary on the report's §2/§4 claims

| Report claim                                                       | Verdict                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Symbol names (`CONFIG_ESP32_WIFI_*`)                               | **STALE** — v4-era; 5.x names verified above; rename table `esp_wifi/sdkconfig.rename`                                                                                                                                                                                                                                                                                    |
| Pin Wi-Fi task core 0 + lwip affinity                              | **CONFIRMED** — but only the lwip half is a real change for v1 (knobs #1–2)                                                                                                                                                                                                                                                                                               |
| Enable Wi-Fi IRAM/RX-IRAM opts                                     | **VACUOUS** — already default-on; live question is whether to _disable_ (knobs #3–4)                                                                                                                                                                                                                                                                                      |
| IRAM is finite / audio-vs-Wi-Fi IRAM tradeoff                      | **NUANCED** — real, but it is a DIRAM budget, not a 16 KB cliff (§1.2)                                                                                                                                                                                                                                                                                                    |
| Prefer static Wi-Fi RX buffers over dynamic                        | **MISREAD** — no such RX choice exists; static DMA ring and dynamic copies coexist (knob #11)                                                                                                                                                                                                                                                                             |
| Limit/disable AMPDU for latency                                    | **CONFIRMED as lever, REFRAMED as remedy** — AC_VO QoS tagging is the surgical form (`wifi.rst:2887-2910`); official docs call global disable a debugging measure (`wifi.rst:4262`); community evidence of 10.7 s AMPDU-TX tail latencies exists ([esp32.com t=27573](https://esp32.com/viewtopic.php?t=27573), numbers via search snippet — thread itself is bot-walled) |
| `esp_pm_lock(APB_FREQ_MAX)` during calls, disable light sleep      | **MOOT in v1** (PM off; locks would error) — correct iff PM is ever enabled (§1.3)                                                                                                                                                                                                                                                                                        |
| Avoid `SPIRAM_FETCH_INSTRUCTIONS`/`RODATA`                         | **NUANCED** — right for us at every stage, but HA VPE ships the opposite for stated reasons; recorded as a stage-5 escape valve (§3)                                                                                                                                                                                                                                      |
| OTA/SPIFFS/NVS "reads disable flash cache"                         | **NUANCED** — writes/erases (and SPI1 driver ops) disable it; ordinary cached reads do not; SD is on another bus entirely (§4.1–4.2)                                                                                                                                                                                                                                      |
| Never touch flash mid-stream                                       | **CONFIRMED** — promoted to invariant #1 with the exact suspension mechanism cited                                                                                                                                                                                                                                                                                        |
| Task WDT risk from long AFE frames                                 | **OVERSTATED** — 10–32 ms frames vs 5 s TWDT; the useful WDT fact is the core-1 idle watch as starvation canary (knob #18)                                                                                                                                                                                                                                                |
| Measurement kit (runtime stats, cycle counts, SystemView, perfmon) | **CONFIRMED, largely already present in v1**; gaps and rig-only tools in §5                                                                                                                                                                                                                                                                                               |

Sources beyond the local clones: [esp32.com t=27573 — AMPDU TX latency tails](https://esp32.com/viewtopic.php?t=27573), [ESP-IDF Wi-Fi driver guide (AMPDU/QoS)](https://docs.espressif.com/projects/esp-idf/en/v5.1-beta1/esp32/api-guides/wifi.html) (matching the local `wifi.rst` text quoted above).
