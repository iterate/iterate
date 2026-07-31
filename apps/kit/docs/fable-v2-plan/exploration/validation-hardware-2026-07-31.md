All three validations are complete. Here is the report.

---

## Task 1 — Waveshare ESP32-S3-Touch-AMOLED-1.8 SD pins: CONFIRMED

Two independent vendor sources, both cloned to `~/src/github.com/waveshareteam/`:

**Vendor BSP (authoritative, the esp-idf examples consume it as managed component `waveshare/esp32_s3_touch_amoled_1_8` ^2.0.3):**
`~/src/github.com/waveshareteam/Waveshare-ESP32-components/bsp/esp32_s3_touch_amoled_1_8/include/bsp/esp32_s3_touch_amoled_1_8.h`

- SD: `BSP_SD_D0 = GPIO3`, `BSP_SD_CMD = GPIO1`, `BSP_SD_CLK = GPIO2` (lines 60-62)
- Mount code is native SDMMC host, explicitly `.width = 1`, d1-d7 = `GPIO_NUM_NC`, no CD/WP, via `esp_vfs_fat_sdmmc_mount` — `.../esp32_s3_touch_amoled_1_8.c:169-191`
- Display (QSPI AMOLED 368x448): CS=12, PCLK=11, DATA0-3 = 4/5/6/7 (h:47-52); touch INT=21, I2C SDA=15/SCL=14 (h:36-37, 57)
- Audio: **ES8311** (single codec, duplex; `es8311_codec_new`, addr `ES8311_CODEC_DEFAULT_ADDR` at `.c:253-277`; esp_codec_dev dep in its `idf_component.yml:7`). I2S: MCLK=16, SCLK=9, LRCLK=45, DOUT=8 (to codec), DSIN=10 (from codec), PA enable=GPIO46 (h:39-44)
- Corroborated by Arduino `pin_config.h` (`~/src/github.com/waveshareteam/ESP32-S3-Touch-AMOLED-1.8/examples/arduino-v2/libraries/Mylibrary/pin_config.h:33-36`): `SDMMC_CLK=2, SDMMC_CMD=1, SDMMC_DATA=3`

**Conflict check: zero overlap.** SD uses {1,2,3}; display {4,5,6,7,11,12}; touch/I2C {14,15,21}; audio {8,9,10,16,45,46}; PMU=AXP2101 on the same I2C. GPIO1/2/3 touch nothing else.

**PSRAM/flash:** vendor `sdkconfig.defaults` (e.g. `.../examples/esp-idf/09_sdmmc/sdkconfig.defaults`): `CONFIG_SPIRAM_MODE_OCT=y`, 80 MHz, `CONFIG_ESPTOOLPY_FLASHSIZE_16MB=y`, QIO — so yes, octal PSRAM (S3R8-class), 16 MB flash.

Minor note: GPIO3 is an S3 strapping pin (JTAG_SEL); vendor uses it for D0 anyway — runtime-safe, just keep it unloaded at reset.

## Task 2 — HA Voice PE audio topology: CONFIRMED (with useful detail)

`~/src/github.com/esphome/home-assistant-voice-pe/home-assistant-voice.yaml`:

- **Two I2S buses, ESP32 is secondary (slave) on both** — the XMOS masters all clocks. Output bus: LRCLK=GPIO7, BCLK=GPIO8, DOUT=GPIO10 (yaml:1487-1493, 1520). Input bus: BCLK=GPIO13, LRCLK=GPIO14, DIN=GPIO15 (yaml:1495-1500, 1505).
- **Mic input: 16 kHz, 32-bit, stereo, `i2s_mode: secondary`, external ADC** (yaml:1502-1512) — i.e. already-processed audio from the XMOS, not raw mics. The two "channels" are XMOS pipeline taps: `voice_kit` component defaults channel 0 = AGC (full AEC→IC→NS→AGC chain), channel 1 = NS (`esphome/components/voice_kit/__init__.py:86-91`; `PipelineStages` enum in `voice_kit/voice_kit.h:49-55`). `voice_assistant` consumes channel 0 (yaml:1801-1802), micro_wake_word consumes channel 1 (yaml:1708-1710). **So yes: the 16 kHz input is post-XMOS echo-cancelled.**
- **XMOS:** `voice_kit` block (yaml:1651-1658): I2C on internal bus (SDA=GPIO5, SCL=GPIO6, yaml:113-115), reset=GPIO4, firmware = `voice-kit-xmos-firmware ffva v1.3.1` DFU'd over I2C. FFVA is XMOS `sln_voice` (cited in `voice_kit.h:63`), which targets xcore.ai — the XU316. Confirmed XMOS; "XU316" specifically comes from the sln_voice target/HA spec, not spelled out in the yaml.
- **Speaker path:** 48 kHz, 32-bit stereo out to an **AIC3204** (TI TLV320AIC3204) DAC configured over I2C (yaml:1514-1527, 1701-1704); mixer + resampler virtual speakers at 48 kHz/16-bit feed it (yaml:1530-1551). Internal amp enable = GPIO47 (yaml:263-268), headphone jack detect = GPIO17, hardware mute switch = GPIO3.
- **SD slot: none.** No sdmmc/sd_card anywhere in the yaml or components dir — as expected.
- **Hosting our C core:** `esp32s3`, board esp32-s3-devkitc-1, **16 MB flash**, **octal PSRAM 80 MHz** (8 MB class) (yaml:58-120), ESP-IDF framework with `SPIRAM_FETCH_INSTRUCTIONS`/`SPIRAM_RODATA` on (yaml:73-76). Plenty of room, but no SD — any SD-dependent tier of the design cannot apply on VPE.

## Task 3 — esp_vfs_fat_create_contiguous_file: CONFIRMED, one NUANCED correction

Local clone `~/src/github.com/espressif/esp-idf` at **v5.5.3**:

- Signature: `esp_err_t esp_vfs_fat_create_contiguous_file(const char* base_path, const char* full_path, uint64_t size, bool alloc_now)` — `components/fatfs/vfs/esp_vfs_fat.h:420`, impl `vfs/vfs_fat.c:1394-1438` (does `f_open(FA_WRITE|FA_OPEN_ALWAYS)` → `f_expand(file, size, alloc_now?1:0)` → `f_close`). Companion `esp_vfs_fat_test_contiguous_file` at h:434.
- **No build opt-in needed:** ESP-IDF hardcodes `#define FF_USE_EXPAND 1` unconditionally in `components/fatfs/src/ffconf.h:46` (unlike upstream FatFs where the default is 0; no Kconfig gate).
- `f_expand` (`src/ff.c:5606-5691`): finds a contiguous free-cluster run; with opt=1 it writes the whole FAT chain immediately (ff.c:5664-5669) and sets `obj.sclust` **and `obj.objsize = fsz`** (ff.c:5679-5680). FR_DENIED if the file is non-zero-size (ff.c:5619) or no contiguous run exists (fragmentation risk — must handle).
- **Appends within the extent touch no FAT metadata: confirmed.** Clusters are pre-chained, so `f_write` inside the extent never calls `put_fat`; only `f_sync`/`f_close` rewrite the one directory-entry sector (size + mtime, `f_sync` at ff.c:4225-4235), and size never changes.
- **NUANCED — correction the plan must absorb:** with `alloc_now=true` the directory entry records the FULL preallocated size at creation (objsize=fsz before any data exists). There is no "stale-small directory size" to scan past — the dir size is stale-_high_ forever and never tracks the append frontier. Consequences: (a) scan-by-CRC over the extent is not merely valid, it's the _only_ way to find the frontier — good for the design; (b) FatFs happily reads the whole extent (no EOF bypass needed), but pre-write contents are whatever garbage was on the card, so CRC framing must be robust to arbitrary bytes; consider pre-erasing or sentinel-stamping. (c) **Do not open the file with mode "a"** — append mode seeks to objsize = end of the full extent; the writer must use "r+" and fseek to its own recovered frontier.

**Verdicts: Task 1 CONFIRMED · Task 2 CONFIRMED · Task 3 CONFIRMED with the stale-high-size nuance above.**
