# SD-card event/log sink — exploration (requirement 5)

Status: v2-plan exploration artifact, 2026-07-31. Topic: brief requirement 5 —
"adds a new feature to (if present) write logs to an SD card (in case we are
not listening)" — plus its interlock with requirement 8 (events shaped
`{path, type, payload}` "from the earliest moments — these could be logged on
SD card etc").

Governing constraints already settled elsewhere and treated as law here:

- Goal doc observability split (`apps/kit/docs/physical-device-voice-goal.md:298-312`):
  microSD is "a separately selectable outer sink on targets that provide a
  card"; "a stalled or absent sink never blocks audio and never creates an
  unbounded device queue"; "every sink records explicit sequence gaps and
  drop/overflow counts"; "do not add a custom firmware-side USB/JTAG
  diagnostics writer"; the nearby computer stays the authoritative recorder.
- Logging is bounded background work, never on the audio-critical path
  (`physical-device-voice-goal.md:182-185`).
- The full required shape + acceptance ladder for the diagnostics outer layer,
  including the exact microSD failure matrix (absent card, full card, slow
  writes, removal, corruption, rotation, reboot recovery), already exists in
  `tasks/kit-bounded-device-diagnostics-capture.md` (Required shape; Acceptance
  proof items 1–8). This exploration is the SD-specific half of that task.

---

## 1. Hardware truth: the four boards

Summary table first, receipts below.

| Board                               | SD slot              | Interface                                  | Pins                                   | Conflicts                                                                                                                      | Card power                           |
| ----------------------------------- | -------------------- | ------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| M5StickS3                           | **No**               | —                                          | —                                      | —                                                                                                                              | —                                    |
| StackChan (M5Stack CoreS3)          | **Yes** (microSD/TF) | **SPI only** (SD-SPI mode)                 | SCLK=36, MOSI=37, MISO=35, **TF CS=4** | **Shares the SPI bus with the LCD** (LCD CS=3, and LCD D/C is _the same_ GPIO35 as MISO, 3-wire SPI); AXP2101 ALDO4 must be on | AXP2101 ALDO4 3.3 V                  |
| Home Assistant Voice PE             | **No**               | —                                          | —                                      | —                                                                                                                              | —                                    |
| Waveshare ESP32-S3-Touch-AMOLED-1.8 | **Yes** (TF)         | **SDMMC 1-bit** (native host, GPIO matrix) | CLK=2, CMD=1, D0=3                     | **None** — disjoint from QSPI display (4,5,6,7,11,12), I2S (8,9,10,16,45), I2C (14,15)                                         | always-on 3.3 V rail (AXP2101 board) |
| (bonus) simulator                   | N/A                  | fake block store                           | —                                      | —                                                                                                                              | —                                    |

So: exactly **one of four boards has a zero-conflict native SD path**
(Waveshare), **one has a shared-bus SPI path** (StackChan/CoreS3), and **two
have no card at all**. "(if present)" is doing real work in the requirement —
the sink must be a genuinely optional module that costs nothing when absent.

### 1.1 M5StickS3 — no SD slot

- xiaozhi's board dossier for the same hardware enumerates the complete
  peripheral set — I2C0 (G47/G48), M5PM1 PMIC, CO5300 LCD on SPI
  (G39/G40/G41/G45, BL G38), ES8311 on I2S0 (G14–G18), KEY1 G11, BMI270 IMU,
  IR TX G46/RX G42 — and there is **no TF/SD entry**
  (`~/src/github.com/78/xiaozhi-esp32/main/boards/m5stack/stick-s3/README.md`,
  "Hardware" section, complete list).
- M5Unified's board support for `board_M5StickS3` configures speaker/mic/PMIC
  pins but never assigns `sd_spi_*`/`sd_mmc_*` pin-table entries for it
  (`~/src/github.com/m5stack/M5Unified/src/M5Unified.cpp:2417-2433`; the only
  `_get_pin_table[sd_spi_*]` writes are for Atom SPK base and Core2/older
  boards, `M5Unified.cpp:2460-2462, 2746-2748`).
- Our inventory confirms 8 MiB flash / 8 MiB PSRAM
  (`apps/kit/firmware/docs/connected-device-inventory.md:33-38`; xiaozhi
  README: PSRAM 8MB, Flash 8MB), and the current partition table leaves ~5.9
  MiB of flash unused (`apps/kit/firmware/targets/m5sticks3/partitions.csv`:
  factory 2 MiB at 0x10000 + one 4 KiB `iterate_kit` data partition). §3.5
  explains why we should still _not_ log to that flash.

**Consequence:** the first physical target never exercises the sink. The SD
feature must be provable off-device (host tests + simulator fake) and on the
Waveshare board, not on the Stick.

### 1.2 StackChan / M5Stack CoreS3 — SD present, SPI-mode, shared bus

Autodetect code in M5GFX is the ground truth for the wiring
(`~/src/github.com/m5stack/M5GFX/src/M5GFX.cpp:1512-1524`):

```cpp
m5gfx::i2c::writeRegister8(i2c_port, axp_i2c_addr, 0x95, 33 - 5); // ALDO4 set to 3.3v // for TF card slot
bus_cfg.pin_mosi = GPIO_NUM_37;
bus_cfg.pin_miso = GPIO_NUM_35;
bus_cfg.pin_sclk = GPIO_NUM_36;
bus_cfg.pin_dc   = GPIO_NUM_35;   // MISOとLCD D/CをGPIO35でシェアしている
...
_set_sd_spimode(bus_cfg.spi_host, GPIO_NUM_4);   // TF CS = GPIO4
id = _read_panel_id(bus_spi, GPIO_NUM_3);        // LCD CS = GPIO3
```

and `M5GFX.cpp:1563-1564` ("TF card CS" / "LCD CS" comments). The StackChan
variant is the same board with an extra I/O-expander at 0x6F
(`M5GFX.cpp:1533-1540`, `board_M5StackChan`), and M5Unified treats
CoreS3/CoreS3SE/StackChan identically for speaker wiring
(`M5Unified.cpp:2403-2415`).

Facts that matter for the design:

- **SPI mode only.** The TF socket's D1/D2 are not wired to the S3; native
  4-bit (or even 1-bit) SDMMC is impossible. Max realistic throughput ~1
  MB/s-class (see §4.2 numbers).
- **The SD shares its SPI bus with the LCD**, including the ugly detail that
  the LCD D/C line _is_ the SD's MISO (GPIO35, LCD driven 3-wire). Every SD
  transaction must hold a bus lock the display driver respects. With ESP-IDF's
  own `spi_master` + `sdspi` + `esp_lcd`, bus sharing is a supported,
  first-class arrangement (device-level acquire), but **M5GFX/LovyanGFX drives
  the bus with its own code**, so mixing "display via M5GFX" with "SD via
  ESP-IDF sdspi" on one physical bus is exactly the kind of two-owners bug the
  v1 review keeps hunting. Options in §7.4.
- `_set_sd_spimode` exists because a card left in SD-native mode would jam the
  shared bus; M5GFX defensively sends the card to SPI mode at panel probe.
- **Card power is a PMIC rail (ALDO4)**; a brownout-style power event
  (cf. the ES8311 0x32=0xBF incident on the Stick) can cut card power mid-write
  — torn-write handling is not theoretical on this board.
- A display refresh burst and an SD write cannot overlap (one bus): a 250 ms
  card stall (§4.2) with the bus held would freeze the face renderer. The
  adapter must acquire the bus **per bounded chunk**, never for a whole batch.

### 1.3 Home Assistant Voice Preview Edition — no SD slot

- The complete factory ESPHome config declares no SD/TF component of any kind;
  its storage is the 16 MiB flash and its I/O budget is spent on dual I2S
  buses, LED ring, rotary encoder, mute switch and the Grove port
  (`~/src/github.com/esphome/home-assistant-voice-pe/home-assistant-voice.yaml:58-62`
  board `esp32-s3-devkitc-1`, flash 16MB; `:1487-1522` the two i2s buses; grep
  for `sd`/`sdmmc`/`sd_card` over the repo's yaml = zero hits).
- ESPHome core does not even ship an SD component (SD support exists only as
  community external components), which is consistent with the brief's stance
  that ESPHome devices share an adapter with less low-level code.

**Consequence:** the eventual ESPHome adapter (brief hard constraint) never
links the SD sink. The sink must not be entangled with the portable core's
mandatory surface.

### 1.4 Waveshare ESP32-S3-Touch-AMOLED-1.8 — SD present, native SDMMC 1-bit, zero conflicts

Waveshare's own engineering-sample repo is unambiguous
(`github.com/waveshareteam/ESP32-S3-Touch-AMOLED-1.8`,
`examples/arduino/libraries/Mylibrary/pin_config.h`):

```c
// SD
const int SDMMC_CLK = 2;
const int SDMMC_CMD = 1;
const int SDMMC_DATA = 3;
```

- One data line ⇒ **1-bit SDMMC** on the S3's native SDMMC host (S3 routes
  SDMMC through the GPIO matrix, so arbitrary pins are fine — esp-idf
  perf_benchmark README, "On ESP32-S3, SDMMC peripheral is connected to GPIO
  pins using GPIO matrix").
- Display is QSPI (LCD_SDIO0..3 = 4,5,6,7, SCLK=11, CS=12), audio ES8311 I2S
  (MCLK 16, BCLK 9, WS 45, DO 8, DI 10, PA 46), touch I2C (14/15) — **no pin
  overlap with SD at all** (same file). xiaozhi's two board ports for this
  hardware confirm the same map and simply don't use the SD slot
  (`~/src/github.com/78/xiaozhi-esp32/main/boards/waveshare/esp32-s3-touch-amoled-1.8{,-v2}/config.h`).
- Waveshare ships an ESP-IDF SDMMC demo for this exact board
  (`examples/esp-idf/09_sdmmc/main/sd_card_example_main.c` — BSP mount, FAT
  file ops, unmount), so the bring-up cost is a solved problem.
- Wiki confirms the slot's purpose ("Onboard TF card slot … suitable for data
  logging"), AXP2101 PMU, PCF85063 RTC (docs.waveshare.com/ESP32-S3-Touch-AMOLED-1.8).
- No card-detect (CD) or write-protect line is wired on either board ⇒
  hot-plug is detected by I/O errors and re-probe, not by interrupt.

**Consequence: the Waveshare board is the reference target for the SD sink**,
and — given our inventory shows it as the not-yet-brought-up board with a
factory demo still on it (`connected-device-inventory.md:37`) — the sink lands
together with (or immediately after) its v2 bring-up.

---

## 2. What the sink actually stores: one stream, not two

v1 already contains, in latent form, everything the sink should persist:

- **Events** — today a 2-byte compact record (type, source) in a bounded
  single-owner queue (`components/core/include/iterate/kit/device_events.h:27-34,54-64`),
  fanned out to the Cap'n Web `subscribeToEvents` stream with boot-local
  sequence + coalescing counters
  (`components/capabilities/include/iterate/kit/capabilities/device_event_stream.h:20-34`).
  Requirement 8 upgrades this to `{path, type, payload}`-shaped events "from
  the earliest moments"; the SD sink is defined as a consumer of _that_ record,
  whatever v2's event core turns out to be.
- **Metrics snapshots** — the 1 Hz cadence
  (`targets/m5sticks3/main/main.cpp:997`), the runtime-diagnostics snapshot
  struct (`components/core/include/iterate/kit/runtime_diagnostics.h:57-131`),
  and its ≤851-byte formatted line with a pinned 896-byte cap
  (`runtime_diagnostics.h:14-24`).
- **A sink abstraction precedent** — `runtime_diagnostics` already defines the
  exact contract we want: a nonblocking byte sink that may accept any prefix,
  zero-means-backpressure, never allocates or waits, with stall/skip metrics
  (`runtime_diagnostics.h:133-158`) and a pump with a per-call byte budget
  (`runtime_diagnostics.h:236-240`).

Design position: **the SD sink persists the unified v2 event stream (events +
snapshot-carrying events), not a separate "log file" concept.** Printf-style
text logs stay on the console; anything worth persisting is an event. This is
requirement 8's "on-device data structure expressed as events … these could be
logged on SD card" taken literally, and it means the SD card, the Cap'n Web
subscription, and the future os-stream cross-post are three sinks of one
producer — the architecture review's R7 single-source schema discipline
(`fable-firmware-architecture-review-2026-07-31.md`, R7) then covers all three
instead of adding a fourth hand-maintained schema.

A note on scale so the rest of the doc has numbers to stand on:

| Producer                                                              | Rate             | Bytes/record (binary) | Steady bandwidth |
| --------------------------------------------------------------------- | ---------------- | --------------------- | ---------------- |
| Button/PTT/lifecycle events                                           | bursty, ≪10/s    | ~24–48 B              | ~0–500 B/s       |
| Reconnect/failure classified records                                  | bursty           | ~32–64 B              | ~0               |
| 1 Hz metrics snapshot (binary struct, §5)                             | 1/s              | ~300–400 B            | ~0.4 KB/s        |
| Optional bounded trace windows (per-frame summaries during incidents) | 50/s while armed | ~24 B                 | ~1.2 KB/s armed  |
| **Total steady state**                                                |                  |                       | **≈ 0.5–2 KB/s** |

Even the armed-trace worst case is ~2 orders of magnitude below the slowest SD
path (~1 MB/s, §4.2). The problem is never throughput; it is **latency spikes,
power loss, and card absence** — which is why the whole design below is about
bounded decoupling, not speed.

---

## 3. Storage-stack options (a)

### 3.1 FATFS on native SDMMC (Waveshare) — recommended default

`esp_vfs_fat_sdmmc_mount()` with `sdmmc_host_t` slot on GPIO matrix pins,
1-bit width. Mount config (`~/src/github.com/espressif/esp-idf/components/fatfs/vfs/esp_vfs_fat.h:73-98`):
`format_if_mount_failed=false` (a corrupt card is evidence — never auto-format
it; formatting is a host/human action), `max_files=2`,
`allocation_unit_size=64*1024` when we do format (large AU = fewer FAT
updates, better sequential writes, README's own note).

- Interop: card mounts on any laptop — the whole point of "in case we are not
  listening" is that a human pulls the card and reads it.
- Frequencies: `SDMMC_FREQ_DEFAULT` 20 MHz, `SDMMC_FREQ_HIGHSPEED` 40 MHz
  (`components/sdmmc/include/sd_protocol_types.h:215-216`). Start at default
  20 MHz for margin on a no-pullup-datasheet board; 1-bit @ 20 MHz is still
  ≥1 MB/s-class — 3 orders above need.
- Power-loss: FAT is not transactional. Mitigation is §5/§6's format layer
  (preallocated contiguous segments + CRC-framed blocks + bounded fsync
  cadence), _not_ trusting the FS.

### 3.2 FATFS on SDSPI shared bus (StackChan/CoreS3) — required there, with a bus-ownership decision

Same VFS/FAT layers over `sdspi_host` on the LCD's SPI bus, TF CS GPIO4. The
esp-idf sdspi device participates in `spi_master` bus arbitration, so _if the
display is also an `esp_lcd`/`spi_master` device_, sharing is supported and
each SD transaction transparently interleaves with display flushes. The
conflict is organizational: v1 uses M5GFX for the Stick display. For CoreS3 in
v2 the choice is:

1. **Display on esp_lcd (ILI9342C is supported) + SD on esp-idf sdspi** — both
   under `spi_master`, arbitration for free, and it advances the v2 goal of
   shrinking M5Unified to board-init-only (the direction
   `platforms/iterate_m5unified/m5sticks3_direct_audio.cpp:23-25` already took
   for audio). Cost: reimplement StackChan face rendering primitives on
   esp_lcd or run LovyanGFX _on top of_ an esp_lcd-owned panel IO.
2. Keep M5GFX for display and route SD through M5GFX's own SD-mode helpers
   (Arduino `SD.h` idiom) — rejected: drags Arduino-flavored FS ownership into
   an ESP-IDF firmware and gives the sink a different backend per board.
3. Mutex at our layer: our own lock that both the display adapter and SD
   adapter take. Workable but hand-rolled bus arbitration is exactly the class
   of invariant-by-convention v2 is trying to delete.

Exploration verdict: (1) when StackChan lands; the sink's portable core (§6)
is identical either way, only the ~50-line `block_store` adapter differs.

### 3.3 littlefs on SD — rejected

- Measured order-of-magnitude penalty vs FAT on SD-class media (0.7 s vs 10 s
  reference workload; NXP community "Use LittleFS as SD card file system").
- Its copy-on-write wear-leveling exists _for raw NOR_; an SD card already has
  an FTL, so we'd pay double metadata traffic for redundant guarantees.
- Card is unreadable on a laptop without special tooling — defeats the
  requirement's "we are not listening" scenario.
- Its power-loss atomicity is real, but §5's CRC-framed blocks give us the
  needed property (detect torn tail, lose ≤ one batch) at zero FS exoticism.

### 3.4 Raw block ring on a fixed LBA range (no filesystem) — strongest crash story, rejected as primary, kept as a _format_ idea

Write 512-byte-aligned self-describing blocks straight via
`sdmmc_write_sectors()` into a reserved region; recovery = binary search for
the sequence-number wrap point (classic flight-recorder design; this is what
serious black-box loggers do).

- Torn-write-safe by construction; no FAT, no metadata, no mount.
- But: the card looks empty/corrupt on a laptop (or needs a partition table +
  a "why is there a 28 GB RAW partition" conversation), every ingest needs our
  tool, and coexistence with the user's own card content is hostile.
- **Steal its skeleton, not its address space:** §5 keeps the
  self-describing CRC block + monotonic sequence design, but places the blocks
  inside preallocated contiguous FAT files (`esp_vfs_fat_create_contiguous_file`,
  `esp_vfs_fat.h:420`, backed by FatFs `f_expand`, enabled in esp-idf:
  `components/fatfs/src/ffconf.h:46` `FF_USE_EXPAND=1`). Contiguity means the
  FAT chain never changes while appending — the FS metadata is effectively
  frozen except the directory entry's size field at fsync — so we get raw-ring
  crash characteristics _and_ a normal file a human can copy.

### 3.5 Internal SPI-NOR flash ring (for the SD-less boards) — rejected for v1, documented because it will come up

Tempting: the Stick has ~5.9 MiB unused flash and no SD. But:

- **Writing NOR flash suspends the flash cache**; any task executing from
  flash stalls for the duration of the erase/program. v1 already treats this
  as an audio hazard: `CONFIG_I2S_ISR_IRAM_SAFE=y` exists precisely because
  "EOF metadata and owner wakeups must not be deferred by flash/cache stalls"
  (`targets/m5sticks3/sdkconfig.defaults:18-19`). NOR sector erase is ~tens of
  ms; program+erase bursts during a live PCM session are exactly the stall
  class we spent a week exorcising.
- IRAM is at 1 byte free (`physical-device-voice-goal.md:352-354`; review
  §4.5) — we cannot afford the IRAM-resident write path that a
  cache-suspension-safe logger wants.
- Flash wear on a soldered part is a different risk class than a removable
  card.
- The correct SD-less resilience feature is much smaller: a **RTC-noinit
  last-gasp buffer** (a few KB surviving soft reset, flushed as events at next
  boot) plus esp-idf's stock core-dump-to-flash partition. Neither touches the
  realtime path. Listed in §10 as a v2-optional follow-on, not part of this
  sink.

### 3.6 Decision

**FATFS + preallocated contiguous segment files + our own CRC block framing**,
over native SDMMC 1-bit on Waveshare and sdspi-on-shared-bus on StackChan.
One portable format/policy core; per-board `block_store` adapters; boards
without a card simply don't construct the module.

---

## 4. Write-path realtime discipline (b)

### 4.1 Topology

```
producers (any owner task)            sink owner task (background)         card
──────────────────────────           ───────────────────────────────      ─────
event core publish ──► SPSC ring ──► batcher ──► block framer ──► block_store.write ──► FATFS ──► SDMMC/DMA
   (nonblocking,        (PSRAM,        (8 KiB)      (4 KiB blocks,     (blocking OK —
    drop+count on        64–256 KiB)                 CRC32C)            only this task waits)
    full)
```

- Producers do exactly one `spsc_ring` publish — the existing lock-free,
  allocation-free, never-waits contract (`spsc_ring.h:22-40`). Ring full ⇒
  drop-new + saturating counter, identical policy to every other v1 queue.
  Audio tasks never learn the sink exists.
- One **sink owner task**: priority **2** (above idle, below control-net 5 /
  pcm-net 6 / audio 19 — the goal doc's "bounded background work" tier,
  `physical-device-voice-goal.md:182-185`), core 0, 4 KiB static stack.
  Blocking inside `fwrite`/`fsync` is _fine here and only here_: the SDMMC
  driver blocks on an interrupt-driven semaphore, so a stalled card costs this
  task's schedule slot, not CPU. (This is also how ADF splits its record
  pipeline: capture/AEC on one core, encoder+fatfs writer as separate
  lower-tier elements — `inputs/agent-reports/espressif-prior-art.md:55,72`.)
- **No IRAM_ATTR anywhere in the sink** (review §4.5: 1 byte free), no ISR
  participation, nothing on core 1 (audio owner's core).

### 4.2 The stall reality on cheap cards (real numbers)

The reason the ring exists, with sources:

| Observation                                                        | Number                                                                                            | Source                                                                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| SD spec write-busy allowance per write command                     | up to **250 ms** busy                                                                             | SD Physical Layer Simplified Spec write timeout (the value hosts must tolerate; esp-idf's own data timeout defaults are derived from it)             |
| Typical cheap-card write latency, sequential 512 B–8 KiB appends   | 1–10 ms                                                                                           | SdFat community measurements (greiman/SdFat issue #129: "recording ~2800 sets/s until the card's buffer is full and takes several ms to transfer")   |
| Occasional garbage-collection stalls (FTL erase behind the scenes) | **100–400+ ms**, worst reports ≈ 1 s on aged/no-name cards                                        | greiman/SdFat issues #129/#434 and the entire existence of his `RingBuf`/`LowLatencyLogger` designs, built to ride out multi-hundred-ms busy periods |
| ESP32 4-bit SDMMC @ 40 MHz, FATFS sequential write                 | **≈ 2.3 MB/s** (8.4 MB/s read)                                                                    | pschatzmann.ch ESP32 SD benchmarks 2025                                                                                                              |
| ESP32 SPI-mode @ 20 MHz, FATFS sequential write                    | **≈ 1.0 MB/s** (1.7 MB/s read)                                                                    | same source — this is the CoreS3-class bound; Waveshare 1-bit SDMMC sits between                                                                     |
| Small-write penalty                                                | 512 B random writes collapse to **kB/s-class**; ≥8–64 KiB sequential chunks needed for full speed | esp-idf perf_benchmark example + espressif/esp-idf issue #11628                                                                                      |
| newlib default FILE buffering on esp-idf                           | **128 B** — must `setvbuf` or write page-multiples yourself                                       | blog.drorgluska.com ESP32 SD card optimization                                                                                                       |

Design consequences, each mechanical:

1. **Ring capacity buys stall tolerance.** At the 2 KB/s steady rate (§2), a
   64 KiB PSRAM ring absorbs a **32-second** total stall; even the armed-trace
   3 KB/s case gets >20 s. Budget: 64 KiB ring (PSRAM — audio uses zero PSRAM
   today, review §2/§4.5, so this is free headroom) + 2×8 KiB batch buffers in
   **internal DMA-capable RAM** (SDMMC DMA wants internal buffers; writing
   straight from PSRAM forces driver bounce-copies) + 4 KiB stack ≈ **80 KiB
   PSRAM + ~20 KiB internal** worst case.
2. **Batch to 8 KiB, write page-multiples, bypass FILE buffering** (direct
   `write()` on the VFS fd, or `setvbuf` 8 KiB). One 8 KiB write @ 1 MB/s ≈
   8 ms typical, 250 ms+ worst — all absorbed by this task alone.
3. **fsync cadence = every 4 batches (32 KiB) or 5 s, whichever first.** With
   contiguous preallocation, `fsync` costs the data flush + one directory
   sector (size field); the FAT chain never changes (§3.4). Bounded loss
   window: ≤5 s of events after power cut — and §5's block CRC makes the torn
   tail _detectable_ rather than silently corrupt.
4. **On CoreS3, the bus lock is held per SDSPI transaction** (spi_master
   arbitration), so a 250 ms card-internal stall does not freeze display
   flushes — the card is busy, the bus is idle-released between polling
   commands. Verify on hardware during StackChan bring-up (rig test, §8).
5. **Explicit starvation safety**: the acceptance test from the task doc
   ("Deterministic host tests starve every exporter while capture and playback
   continue", `tasks/kit-bounded-device-diagnostics-capture.md` acceptance 1)
   is directly implementable because producers only touch the SPSC ring.

### 4.3 Sequence gaps and drop accounting

Goal doc: "every sink records explicit sequence gaps and drop/overflow
counts" (`physical-device-voice-goal.md:309`). Mechanism:

- Every event record carries the producer's boot-local `sequence` (the
  device-event stream already has exactly this concept + coalescing counters,
  `device_event_stream.h:20-34`).
- Ring-full drops happen _before_ the sink sees the record, so the sink writes
  a synthetic **gap record** `{first_lost_seq, last_lost_seq, lost_count}`
  whenever the next dequeued sequence isn't contiguous — cheap because
  sequences are already monotonic.
- Producer-side saturating drop counters additionally ride the normal 1 Hz
  metrics snapshot (which the sink also persists), so even a gap the sink
  cannot see (dropped gap record — ring full at that instant) is bounded by
  the counter delta between adjacent snapshots.
- The same numbers surface over Cap'n Web metrics so a _live_ host notices a
  degraded card without pulling it (task-doc acceptance 6: "Every failure
  degrades only that sink and is visible through another sink").

---

## 5. On-card format (c)

### 5.1 Options considered

|                                   | JSONL                                                                               | Length-prefixed binary records in CRC blocks             | Verbatim C structs dumped                             |
| --------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------- |
| Producer cost                     | high (format on device; the 851 B diagnostics line is precedent but it's 1 Hz-only) | ~memcpy                                                  | memcpy                                                |
| Size                              | 3–5× binary                                                                         | 1×                                                       | 1×                                                    |
| Torn-tail handling                | line-based: last partial line dropped — workable                                    | block CRC: exact                                         | none without extra framing                            |
| Schema evolution                  | self-describing                                                                     | needs ids+versioning (solved by R7 single-source schema) | fragile: silent struct drift across firmware versions |
| Host effort                       | none                                                                                | small decoder keyed by schema hash                       | same, but hash is load-bearing                        |
| Laptop-only inspection (no tools) | yes                                                                                 | no                                                       | no                                                    |

**Choice: binary records inside self-describing CRC blocks, plus embedded
dictionary records so the card is decodable without the firmware source.**
JSONL loses on principle, not cost: the device would be the only producer in
the system formatting JSON nobody reads until a host ingests it anyway — and
the host decoder is ~250 LOC once. The "verbatim struct" option is the same
bytes as our choice _minus_ the discipline that makes them decodable in six
months; rejected explicitly.

### 5.2 Block and record layout

Everything little-endian (native S3), CRC32C (software table, ~1 KiB const —
flash, not IRAM).

```
Segment file  = [segment header block] [data block]*      (preallocated contiguous, 4 MiB)
Block         = 4096 B, self-contained:
   u32 magic 'IKB1'
   u32 crc32c            over bytes 8..4095
   u64 boot_id           (random per boot, also in segment header)
   u32 block_seq         (monotonic per boot)
   u32 first_record_seq
   u16 record_count
   u16 payload_bytes
   u8  payload[4064]     packed records, zero-padded tail
Record        = u16 total_len | u16 type_id | u64 t_mono_us | u32 seq | payload
Special records:
   TIME_ANCHOR   {wall_ms, source: server|sntp|rtc}   at segment start + every change
   DICTIONARY    {type_id, path+name string}          for every type id used, at segment start
   GAP           {first_lost_seq, last_lost_seq, lost_count}
   SNAPSHOT      the packed metrics snapshot (R7-generated layout, schema_hash in segment header)
```

Segment header block: format version, schema hash (FNV-1a of the R7 X-macro
expansion — the same generator that already has to exist to kill the
metrics-schema triplication emits it for free), device serial (the stable ROM
MAC that is our board identity authority, `connected-device-inventory.md:14-19`),
firmware version/app descriptor, boot_id, boot reason. This is exactly the
correlation set the task doc demands ("boot/session identity, firmware
version, device identity, connection generation, audio epoch…").

Crash forensics with this layout:

- Power cut mid-block ⇒ last block fails CRC ⇒ ingest reports "torn tail,
  N records in last valid block, previous block seq K" — never garbage.
- Power cut between fsyncs ⇒ FAT dir entry may still show the old size, but
  because segments are preallocated the _data_ blocks are already on the card;
  ingest scans the whole preallocated extent by magic+CRC, not by file size —
  recovering up to the last completed 8 KiB batch even when FAT metadata is
  stale. (This is the raw-ring recovery trick, §3.4, ported into a FAT file.)
- Reboot writes a fresh segment with a new boot_id; the previous boot's tail
  is never appended to (append-only per boot ⇒ no read-modify-write of old
  data, ever).

### 5.3 Rotation and retention

- Segment = 4 MiB, `IK<boot8><nnn>.BIN` under `/sdcard/iteratekit/` (8.3-safe
  names; LFN disabled saves code + heap).
- Preallocate the _next_ segment while the current one is half full
  (`esp_vfs_fat_create_contiguous_file`, `esp_vfs_fat.h:420`) so rotation
  itself never blocks on cluster allocation.
- Retention: keep newest N segments (default: min(256 segments = 1 GiB, 50% of
  card capacity)); delete-oldest at rotation, in the sink task, one unlink per
  rotation (bounded metadata op every ~2000 s at steady rate).
- At 2 KB/s steady state a 4 MiB segment holds ~35 minutes; 1 GiB retention ≈
  6 days of continuous evidence. Card wear: ≤0.2 GB/day — irrelevant against
  any card's endurance.

---

## 6. Module sketch (d)

Follows the v1 house style exactly: caller-owned storage, options struct with
borrowed pointers, `sizeof()`-visible state struct, vtable for the platform
seam (cf. `screen.h:22-27` driver vtable; `device_events.h:54-64` options;
`runtime_diagnostics.h:133-147` sink contract; `retry_gate.h` for re-probe
backoff).

### 6.1 Portable core — `components/core` (or v2's `components/diagnostics`)

```c
/* iterate/kit/event_log_sink.h — portable, sans-I/O, allocation-free. */

/**
 * Bounded block store behind the SD (or any) persistence adapter.
 *
 * Every function is called only from the sink owner task and may block that
 * task; the portable core never calls it from a producer context. write()
 * covers exactly one 4 KiB block sequence; sync() makes previously accepted
 * blocks durable. A store reports capacity once and never grows. All
 * failures are classified, not retried here — the pump owns retry policy via
 * its retry gate.
 */
struct iterate_kit_block_store {
  void *context;
  enum iterate_kit_status (*open_segment)(void *context,
                                          const struct iterate_kit_segment_identity *identity);
  enum iterate_kit_status (*write_blocks)(void *context,
                                          const void *blocks,
                                          size_t block_count);
  enum iterate_kit_status (*sync)(void *context);
  enum iterate_kit_status (*close_segment)(void *context);
  /* Absent/removed/full/corrupt discovery; also the hot-unplug probe. */
  enum iterate_kit_status (*probe)(void *context,
                                   struct iterate_kit_block_store_health *health);
  enum iterate_kit_status (*delete_oldest_segment)(void *context);
};

struct iterate_kit_event_log_sink_options {
  /* All storage borrowed for the module lifetime, v1 idiom. */
  struct iterate_kit_spsc_ring *ring;        /* producers publish records here */
  uint8_t *batch_storage;                    /* 2 × batch_bytes, internal RAM  */
  size_t batch_bytes;                        /* default 8192                   */
  struct iterate_kit_block_store store;      /* platform adapter, may be absent*/
  struct iterate_kit_event_log_policy policy;/* fsync cadence, segment bytes,
                                                retention, probe backoff — the
                                                R6 runtime-tunable knob struct */
  struct iterate_kit_segment_identity identity; /* boot_id, serial, schema hash */
};

struct iterate_kit_event_log_sink_metrics {
  uint32_t records_persisted;
  uint32_t records_dropped_ring_full;   /* producer-side, sampled */
  uint32_t gap_records_written;
  uint32_t blocks_written;
  uint32_t sync_calls;
  uint32_t write_failures;
  uint32_t probe_failures;
  uint32_t segments_rotated;
  uint32_t segments_deleted;
  uint64_t maximum_write_stall_ms;      /* the SdFat-legend number, measured */
  uint64_t maximum_sync_stall_ms;
  uint8_t  state;                       /* ABSENT / MOUNTED / DEGRADED / DISABLED */
};

enum iterate_kit_status iterate_kit_event_log_sink_init(
    struct iterate_kit_event_log_sink *sink,
    const struct iterate_kit_event_log_sink_options *options);

/**
 * One bounded pump turn for the sink owner task: dequeue up to the batch
 * budget, frame at most one block run, issue at most one store call, advance
 * the fsync/rotation/probe state machines by one step. now_ms is monotonic
 * and only measures store stalls. Never called by producers.
 */
enum iterate_kit_status iterate_kit_event_log_sink_pump(
    struct iterate_kit_event_log_sink *sink, uint64_t now_ms);

void iterate_kit_event_log_sink_metrics(
    const struct iterate_kit_event_log_sink *sink,
    struct iterate_kit_event_log_sink_metrics *metrics);
```

Internals worth pinning now:

- The pump is a **flat state machine** (UNMOUNTED → PROBING → OPENING →
  STREAMING → SYNCING → ROTATING → DEGRADED), one bounded store call per turn,
  re-probe scheduling via an embedded `iterate_kit_retry_gate`
  (`retry_gate.h:13-27`; initial 1 s, max 30 s) — no hidden loops, so the
  virtual-clock host harness can walk every transition deterministically.
- Producer API is _just the ring_: v2's event core publishes each committed
  event to every attached sink ring. No `#ifdef SD` anywhere in producers.
- Absent card cost: options carry a zeroed `store` (or the device simply never
  constructs the sink) — the Stick and HA-Voice-PE builds link none of this,
  which the review's target layout makes a link-time truth ("control stack
  without audio lane" argument, review §5, applies verbatim to the sink).

Estimated size: portable core ~500–650 LOC C + ~150 LOC header comments in
house style; block framer is ~120 LOC of it.

### 6.2 ESP-IDF adapter — `platforms/iterate_esp_idf/sd_block_store.c`

```c
/* Sketch; error paths elided. Style per esp_idf_itx_transport.h. */
struct iterate_kit_esp_idf_sd_block_store {
  sdmmc_card_t *card;
  char mount_point[16];          /* "/sdcard" */
  int  segment_fd;               /* current preallocated segment */
  struct iterate_kit_esp_idf_sd_pins pins;   /* board data, not code:
        Waveshare: {.mode=SDMMC_1BIT, .clk=2, .cmd=1, .d0=3}
        CoreS3:    {.mode=SDSPI, .host=SPI2_HOST /* shared with esp_lcd */,
                    .cs=4} */
};

static enum iterate_kit_status sd_open_segment(void *context,
    const struct iterate_kit_segment_identity *identity) {
  /* esp_vfs_fat_create_contiguous_file(base, path, SEGMENT_BYTES, true)   — esp_vfs_fat.h:420
     open(path, O_WRONLY) + write header block + fsync                      */
}
static enum iterate_kit_status sd_write_blocks(void *context,
    const void *blocks, size_t count) {
  /* write(fd, blocks, count * 4096): batch buffer lives in internal
     DMA-capable RAM so the SDMMC driver takes the zero-copy path. */
}
static enum iterate_kit_status sd_probe(void *context, ...) {
  /* Unmounted: esp_vfs_fat_sdmmc_mount() with format_if_mount_failed=false.
     Mounted: cheap sdmmc_get_status() — this is the hot-unplug detector,
     since neither board wires card-detect (§1). */
}
```

Mount/hot-plug policy (task-doc acceptance 6 failure matrix):

| Condition              | Behavior                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No card at boot        | probe fails ⇒ state ABSENT, retry-gated re-probe (1 s → 30 s), zero other cost                                                                                                        |
| Card inserted later    | probe succeeds ⇒ mount ⇒ new segment; events from before mount are simply not on the card (the ring only smooths seconds, not minutes — SD is a resilience sink, not a replay buffer) |
| Card removed mid-write | write/sync error ⇒ classify, `esp_vfs_fat_sdcard_unmount()`, state ABSENT, re-probe cycle; counters + state visible over Cap'n Web                                                    |
| Card full              | preallocate fails ⇒ delete-oldest until space or floor reached; if still failing, DEGRADED with counter                                                                               |
| Corrupt FS             | mount fails without formatting ⇒ DISABLED (distinct from ABSENT so a human learns to look at the card), still re-probed slowly in case the user swaps cards                           |
| Reboot                 | new boot_id ⇒ new segment; prior segments untouched                                                                                                                                   |

Adapter estimate: ~300–400 LOC including the two pin tables and mount dance
(Waveshare's own 09_sdmmc demo is the reference for the mount half).

### 6.3 Wiring (target layer)

`targets/waveshare_amoled_18/main.cpp` (future) composes: static ring storage
(PSRAM attr), static batch buffers (internal), `sd_block_store` instance,
sink task `xTaskCreatePinnedToCore(sink_task, "iterate-sdlog", 4096, &rt, 2, .., 0)`
whose loop is `pump(); vTaskDelay(pdMS_TO_TICKS(50))` — 20 Hz pump is 160
KB/s ceiling, 80× steady need, and keeps the task invisible in CPU stats.
(A follow-up refinement: block on a ring-doorbell task notification instead of
the 50 ms tick — consistent with R5's "kill the tick-polls" — but the tick
version is acceptable for a background sink and simpler to bring up first.)

---

## 7. Where this sits in the v2 module map

- The sink is the third consumer of the single event/metrics schema (R7):
  Cap'n Web live export, host durable JSONL, SD segments. One X-macro table
  emits: C structs, capnweb builders, `getDiagnostics` formatter, **binary
  record packers + the schema hash + the TS decoder table** (§9).
- It reuses, unchanged: `spsc_ring` (§4.1), `retry_gate` (§6.1),
  the metrics/evidence conventions (`buffer_metrics.h` evidence-typed depths),
  and the options/vtable idioms.
- It adds two genuinely new pieces: the block framer (portable, ~120 LOC,
  property-testable) and the `block_store` vtable with its ESP-IDF adapter.
- CoreS3 specifics (§3.2 bus decision) are contained entirely inside that
  board's `block_store` construction — the portable core cannot tell SDMMC
  from SDSPI from a host-test fake.

---

## 8. Testing story (three layers, per brief requirement 7)

1. **Host unit (fast):**
   - Block framer: property tests — every prefix of a valid stream decodes to
     a prefix of the records; a torn tail never yields a record not written;
     CRC flips are always detected. (Same style as `pcm_websocket_test.c` /
     `spsc_ring_test.c`.)
   - Sink pump against a **fake block store** with scripted behavior: stall
     N ms (virtual clock), fail-once, fail-forever, disappear-mid-write,
     capacity exhaustion — asserting the §6.2 state machine and that
     producers' ring metrics alone reflect the damage. This is the task-doc
     acceptance 1 "starve every exporter" test, and it slots into the existing
     virtual-clock fault-harness pattern
     (`tests/pcm_realtime_fault_harness_test.c`).
   - Zero-steady-state-allocation gate as for every other module (acceptance 2).
2. **Rig (device beside the computer):** Waveshare board + provisioned card;
   host drives a scripted session (tone playback + PTT events), then asserts
   over Cap'n Web that `records_persisted`/`blocks_written` advance and
   `maximum_write_stall_ms` stays sane; then the _host-side_ ingest tool (§9)
   reads back the same run over the device's normal file-transfer path — or,
   v1 of the rig, the human moves the card — and the two evidence streams
   (live subscription JSONL vs SD decode) must reconcile record-for-record
   modulo explicit gap records. On CoreS3: same, plus display-liveness assert
   during forced card stalls (cheap card + bulk copy in background is a
   reliable stall generator).
3. **Human-in-the-loop:** pull the card mid-sentence, watch the device keep
   talking and the metrics show DEGRADED→ABSENT; reinsert, watch remount +
   new segment; power-cut mid-run, laptop-mount the card, run ingest, confirm
   torn-tail report identifies the exact loss window.

---

## 9. Host tooling (e)

`apps/kit/scripts/sd-ingest.ts` (CLI via the normal doppler-backed script
pattern), ~250 LOC + generated decoder table:

```ts
// pnpm --dir apps/kit kit sd-ingest /Volumes/NO_NAME --out .evidence/sd-<serial>/
// 1. scan <mount>/iteratekit/IK*.BIN oldest→newest
// 2. per segment: parse header block; look up schema by embedded hash
//    (generated table; unknown hash ⇒ decode structurally via DICTIONARY
//    records and emit type ids instead of names — never refuse)
// 3. stream 4 KiB blocks: verify crc32c; on first bad block in the *middle*
//    classify segment DAMAGED and keep going (skip-scan by magic); a bad
//    *tail* is the normal torn-write case and reported as such
// 4. emit records as JSONL {tMonoUs, wallMs?, seq, path, type, payload},
//    wall-clock reconstructed from TIME_ANCHOR records (piecewise-linear)
// 5. write a manifest.jsonl mirroring the endurance evidence-writer shape —
//    fsync raw records before the manifest that judges them, exactly per
//    playback-endurance-evidence-writer.ts:70-80's crash-boundary reasoning
// 6. report: segments, records, gaps ({firstLostSeq,lastLostSeq,count} +
//    counter-delta bounds), torn tails, time-anchor coverage
```

The JSONL record shape deliberately matches what the live Cap'n Web
subscription writer produces, so downstream analysis (and the eventual
requirement-8 cross-post of device events into an apps/os stream) consumes
one format regardless of whether evidence arrived live or by sneakernet. The
decoder table is emitted by the same R7 generator that builds the firmware
packers — schema drift between card and tool becomes a build error, not a
runtime mystery.

---

## 10. Not doing (and why)

- **No USB/JTAG diagnostics writer** — goal doc prohibition, verbatim
  (`physical-device-voice-goal.md:306`).
- **No littlefs/SPIFFS on SD** — §3.3; slow, redundant under an FTL,
  laptop-hostile.
- **No raw-partition ring as the primary store** — §3.4; its crash behavior is
  adopted _inside_ FAT files instead.
- **No logging to internal NOR flash** in this feature — §3.5; cache-suspension
  stalls are an audio hazard v1 already engineered against
  (`sdkconfig.defaults:18-19`), IRAM has 1 byte free, and the SD requirement
  says "if present", not "emulate one". RTC-noinit last-gasp + esp-idf core
  dump partition are the SD-less follow-on, tracked separately.
- **No auto-format of unmountable cards** — a corrupt card is evidence;
  formatting is a host/human action (`format_if_mount_failed=false`).
- **No exFAT / no >32 GiB first-class support** — FAT32 only in v1; big cards
  get reformatted by the provisioning step. Avoids extra FatFs config surface.
- **No long filenames, no per-file timestamps beyond anchor records** — 8.3
  names; wall time lives _inside_ the format where it's actually trustworthy.
- **No panic-handler SD writes** — FATFS/SDMMC are not usable with interrupts
  disabled; the crash story is the torn-tail bound + (later) core dump
  partition, not heroics in the panic path.
- **No audio PCM to SD in v1** — bandwidth is trivially sufficient (32 KB/s vs
  ≥1 MB/s), but it explodes retention math, drags privacy questions in, and
  the goal doc names the nearby computer as the high-fidelity recorder. Listed
  as a future explicit-policy feature (e.g. incident-armed 10 s pre-roll dump),
  not a default.
- **No on-device log _reading_ RPC in v1** (serving segments back over Cap'n
  Web). Worth doing eventually (rig layer 2 wants it); v1 ships
  pull-the-card + live subscription, which already covers "not listening" and
  "listening" respectively.
- **No encryption** in v1 — but see open question 3; this needs an explicit
  product decision, not a silent default either way.
- **No card-detect interrupt plumbing** — neither board wires CD (§1);
  probe-on-error + retry gate is the whole mechanism.

## 11. Open questions for Jonas (condensation round inputs)

1. **CoreS3 bus ownership** (§3.2): commit to esp_lcd for the StackChan
   display so SD/display share `spi_master` arbitration natively? This
   interacts with how much StackChan face-rendering code v2 keeps.
2. **Is the Waveshare bring-up the right vehicle** for landing the sink
   (it's the only zero-conflict SD board, but also an un-brought-up target)?
   Alternative: land portable core + host tests + simulator fake now, adapter
   with the board later.
3. **Privacy/retention posture**: SD segments will contain transcription-ish
   events and connection metadata on a removable, unencrypted card in an
   office. Default-on for dev devices with 1 GiB retention? Default-off
   outside test fleets? Encrypt-at-rest is possible (AES-CTR per segment,
   device-held key) but breaks pull-the-card-into-a-laptop simplicity.
4. **Does the 1 Hz snapshot go to SD verbatim** (my recommendation: yes — it
   is the cheapest way to bound invisible-gap analysis, §4.3) or only deltas/
   incidents to cut steady-state bytes by ~5×?
