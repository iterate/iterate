---
state: draft
priority: high
size: large
tags: [kit, firmware, esp32, satellite1, refactor]
---

# One board table for the fleet, and the Satellite1 as its first example

A board in `apps/kit/firmware` should be a constant table of hardware facts
plus a few lines of code for what a table cannot say. Today it is ~2,000–3,500
lines per board, because each board was made by copying the previous one and
the shared loop hoisted policy but never plumbing. Four independent audits on
2026-09-09 measured the same thing: of havpe's 3,460 lines, ~450 are FreeRTOS
tasks, mailboxes and the starvation ledger, ~330 are chip and XMOS control,
and ~90 are pins and boot order. The ledger exists four times verbatim
(`havpe_audio.c:236-336`, `waveshare_audio.c:524-649`,
`m5sticks3_audio.cpp:151-174,808-876`, `stackchan_audio.c:307-385`); the
`phase()` switch and the `health()` snprintf loop are byte-identical in all
four device files.

This task takes the maximal consolidation: the composition file goes too, not
only the audio plumbing. The FutureProofHomes Satellite1 on the bench (ESP32-S3
N16R8 + XMOS XU316, 24-pixel ring, four buttons, TAS2780 amp, PCM5122
line-out, Wi-Fi) is the first board written against the table and the proof
that a new board is ~300 lines.

All LOC figures below are estimates from reading, not measurements. Report
the real per-PR breakdown in each PR body.

## Doctrine that shapes it

- The board owns its hardware facts and nothing else. Every user-visible
  behaviour stays in `components/core`.
- No new framework nouns. `iterate_kit_board_ops` and `iterate_kit_board_facts`
  already exist; the table is `struct iterate_kit_board` and the entry is
  `iterate_kit_board_run()`. Chips keep their part numbers. The starvation
  ledger keeps its name.
- Providing a field is the claim. `gpio = -1`, `count = 0`, `NULL` mean "no
  such hardware", the idiom `loop.h` already uses for ops.
- Pure pieces get a table test (`{inputs…, becomes}` rows). ESP-bound pieces
  are proven on the bench.
- Every commit keeps all four existing targets building and the host suite
  green. Each step below is one PR with its LOC delta in the body.
- Licence: FutureProofHomes' ESPHome sources are GPLv3; ours is AGPL, so a
  close translation of their TAS2780, PCM5122 and SPI code is fine. Translate
  into our C with a credit line; do not vendor the ESPHome runtime, the shim
  costs more than the drivers.

## Where things land

| Piece | Location | Why there |
|---|---|---|
| `struct iterate_kit_board`, `iterate_kit_board_run`, register scripts, ring, button wiring, phase, health, run order | `platforms/iterate_esp_idf/components/board/` (own IDF component beside `core_s3_board`, REQUIRES `voice audio core capabilities esp_driver_i2s esp_driver_i2c esp_driver_gpio espressif__led_strip`) | ESP-bound; avoids a `voice → iterate_esp_idf` cycle |
| I2S channels, hardware tasks, mailboxes, play_sound, counters, format conversion | `platforms/iterate_esp_idf/components/board/i2s_codec.c` | ESP-bound |
| Starvation ledger (pure, caller supplies the lock) | `components/audio/src/starvation_ledger.c` + table test | host-testable, StackChan's own task can call it |
| PCM wire formats (16 k ↔ 48 k Q31, keep-every-nth) | `components/audio/src/pcm_format.c` (moved from `devices/havpe/voice_pe_pcm_format.c`) + existing test re-pointed | pure |
| Button debounce + tap/hold/end-hold | `components/core/src/button.c` + table test (from `havpe_ui.c:116-129,467-515`) | pure, rhymes with `touch_tap.c` |
| XMOS device-control framing (`{resource, command\|0x80, length, payload}`) | `components/core/src/xmos_control.c` (from `voice_pe_hardware_config.c:201-312`) + tests moved | pure; both XMOS boards speak it |
| XMOS transports: I2C (havpe) and SPI (Satellite1) | `platforms/iterate_esp_idf/components/board/xmos_i2c.c`, `xmos_spi.c` | ESP-bound |
| Chip scripts and volume maps: AIC3204, TAS2780, PCM5122 | `platforms/iterate_esp_idf/components/board/codecs/` | shared between boards, host-tested via a recording I2C fake |
| `iterate_kit_health_append_fields` | `components/capabilities/src/health.c` | replaces five identical loops incl. `voice_loop.c:2383-2400` |
| `iterate_kit_voice_view_lights` | `components/voice/src/voice_loop.c` | replaces four view→lights copies |
| `microphone_muted` in `iterate_kit_conversation_visual_state` | `components/core` conversation lights | Satellite1 has a hardware mic cut; what it looks like is policy |

## The interface (`iterate/kit/platforms/board.h`)

```c
/** One I2C register write; was iterate_kit_voice_pe_register_write. */
struct iterate_kit_register_write { uint8_t address; uint8_t value; };

/** A register script and when board.c runs it. Settle is the chip's own soft-start (AIC3204: 2500 ms). */
struct iterate_kit_register_script {
  uint8_t i2c_address;
  const struct iterate_kit_register_write *writes;
  size_t count;
  uint16_t settle_ms;
  enum { ITERATE_KIT_SCRIPT_BEFORE_I2S, ITERATE_KIT_SCRIPT_AFTER_I2S } when;
};

/** A GPIO driven at boot, in table order: rails off, reset pulses, the XMOS boot wait. */
struct iterate_kit_gpio_step { int8_t gpio; uint8_t level; uint16_t hold_ms; };

/** How 16 kHz mono PCM16 sits on the wire. `ratio` = wire frames per 16 kHz sample: 1, or 3 on a 48 kHz bus. */
struct iterate_kit_pcm_shape {
  uint8_t bits;            /* 16 or 32 */
  uint8_t slots;           /* 1 or 2 */
  uint8_t uplink_slot;     /* capture: the microphone */
  int8_t diagnostic_slot;  /* capture: -1, or the tap feeding micRawPeak/echoRawPeak */
  uint8_t ratio;
};

/** Everything the shared I2S codec needs. IDF's own config structs ARE the pin/rate/slot table. */
struct iterate_kit_i2s_codec_facts {
  i2s_port_t playback_port;
  i2s_port_t capture_port;               /* == playback_port: ONE duplex controller; else two */
  i2s_role_t role;
  i2s_std_config_t playback;             /* .gpio_cfg.mclk = I2S_GPIO_UNUSED when the DSP drives it */
  i2s_std_config_t capture;
  uint16_t dma_frames;                   /* per descriptor; bytes <= 4092, checked at start */
  uint8_t dma_descriptors;
  struct iterate_kit_pcm_shape playback_shape;
  struct iterate_kit_pcm_shape capture_shape;
  uint8_t capture_gain;                  /* fixed, saturating, counted as captureGainClipped; 1 = none */
  int8_t amplifier_gpio;                 /* -1: no rail to gate */
  bool amplifier_gated;                  /* true: ARRIVED raises, QUIET drops; false: raised once after start */
  uint16_t amplifier_settle_ms;
};

/** Volume as a register: 100 % writes full_code, 0 % writes floor_code, linear between. */
struct iterate_kit_volume_register {
  uint8_t i2c_address;
  uint8_t page_register;   /* 0xff = no paging */
  uint8_t page;
  uint8_t registers[2];
  uint8_t register_count;  /* 0: use board->set_volume */
  int16_t full_code;
  int16_t floor_code;
};

/** A WS2812 ring. pixels is a multiple of ITERATE_KIT_CONVERSATION_LIGHT_COUNT; each light repeats pixels/12 times. */
struct iterate_kit_led_ring { int8_t gpio; uint8_t pixels; led_pixel_format_t order; int8_t power_gpio; };

/** The one GPIO button the shared grammar reads. gpio -1: extra->poll runs the grammar instead. */
struct iterate_kit_gpio_button { int8_t gpio; bool active_low; bool tap_wakes; bool tap_ends; };

/** Flash-resident 16 kHz PCM16LE chimes; NULL = silent. */
struct iterate_kit_board_sounds { const uint8_t *wake; uint32_t wake_bytes; const uint8_t *ended; uint32_t ended_bytes; };

/**
 * THE BOARD, AS DATA. Three things are code because no table can say them:
 * open_codec (version gates, SAR-ADC power modes, read-modify-writes), set_volume
 * (chips with no register to write), and extra (a face, servos, a camera, a fence,
 * a dial, side buttons). board.c runs its own half of each op first, then extra's:
 * extra->start before the codec; extra->present after the ring; extra->poll after the
 * table button (it may OR into the intent, or own the grammar when button.gpio is -1);
 * extra->health and extra->modules appended.
 */
struct iterate_kit_board {
  struct iterate_kit_board_facts facts;    /* .speaker.set_volume/.volume filled by board.c */
  struct { int8_t sda; int8_t scl; uint32_t hz; } i2c;
  const struct iterate_kit_gpio_step *boot;          size_t boot_count;
  const struct iterate_kit_register_script *scripts; size_t script_count;
  const struct iterate_kit_i2s_codec_facts *audio;   /* NULL: extra->start supplies the codec */
  struct iterate_kit_volume_register volume;
  struct iterate_kit_led_ring ring;
  int8_t status_led_gpio;                            /* mirrors view->link_ready */
  struct iterate_kit_gpio_button button;
  struct iterate_kit_board_sounds sounds;
  bool (*open_codec)(void);                          /* after I2S enable, before the first sample */
  enum iterate_kit_status (*set_volume)(uint8_t percent, uint8_t *applied);
  const struct iterate_kit_board_ops *extra;
};

void iterate_kit_board_run(const struct iterate_kit_board *board);
```

Fixed bring-up order in `iterate_kit_board_run`, one for the fleet: ring →
`extra->start` → boot GPIO steps → I2C bus → `BEFORE_I2S` scripts (each with
its settle) → I2S channels, TX preloaded with silence, enabled → `AFTER_I2S`
scripts → `open_codec` → amplifier raised → hardware tasks → hand
`{codec, passthrough}` to the loop. The loop still decides when this runs
relative to the radio via `facts.radio_before_codec`.

Library the runner is made of, for boards that are more than a table:
`iterate_kit_i2s_codec_start(facts, &codec)`,
`iterate_kit_i2s_codec_start_over(read, write, ctx, ring_ms, &codec)` (the
same tasks over a blocking read/write the board owns: esp_codec_dev, M5.Mic),
`iterate_kit_i2s_codec_phase`, `iterate_kit_i2s_codec_play_sound`,
`iterate_kit_i2s_codec_health`, `iterate_kit_i2c_write_script`,
`iterate_kit_led_ring_start/present/borrow`, `iterate_kit_voice_view_lights`.

Start-time checks replace the per-board `_Static_assert`s and park with a
fault through the existing path (never an early `return` after
`esp_task_wdt_add`): descriptor bytes ≤ 4092, `rate / ratio == 16000`,
`pixels % 12 == 0`, ports vs pins consistent.

## Steps (one PR each, all boards green after every one)

Phase 0, pure hoists, behaviour-identical:

1. `iterate_kit_health_append_fields` in `capabilities/health.c` + test. Five
   call sites: `havpe_device.c:464-477`, `waveshare_device.c:336-349`,
   `m5sticks3_device.c:273-286`, `stackchan_device.c:906-916`,
   `voice_loop.c:2383-2400`. ≈ −60.
2. `core/button.c` + table test, `havpe_ui.c:116-129,467-515` moved verbatim
   with a `take_press` for Waveshare's press-edge button
   (`waveshare_buttons.c:91-114`). ≈ −90.
3. `iterate_kit_voice_view_lights` in the loop; replaces `havpe_ui.c:229-262`,
   `waveshare_display.c:131-148`, `m5sticks3_board.cpp:163-176`,
   `stackchan_device.c:279-300`. Delete the dead setters `havpe_ui.c:264-343`
   and `m5sticks3_board.cpp:412-453` (the view is one value, `loop.h:53-67`).
   ≈ −220.
4. `audio/pcm_format.c`: move `voice_pe_pcm_format.[ch]` + test, add
   `iterate_kit_pcm_shape` (bits/slots/ratio/uplink/diagnostic). Add one
   stride-3 row. Net 0, enables Satellite1.
5. `core/xmos_control.c`: move the pure command builders and their tests from
   `voice_pe_hardware_config.c:201-312`; drop the `voice_pe_` prefix. Net 0.
6. `audio/starvation_ledger.c` (pure, lock outside) + table test;
   `iterate_kit_i2s_codec_phase` replaces the four `phase()` switches.
   All four boards adopt. ≈ −330.

Phase 1, the shared I2S codec, havpe first:

7. `board/i2s_codec.c` part 1: tasks, mailboxes, seam, play_sound, ISR
   counters over blocking read/write (`_start_over`). havpe adopts
   (`havpe_audio.c:140-213,339-371,373-573,577-593,994-1024`). Flash, then
   `voicelab boards --only havpe`. ≈ −400.
8. Waveshare adopts `_start_over` with esp_codec_dev wrappers. Delete its
   descriptor-level ISR ledger (`waveshare_audio.c:383-521`) and the three
   `dma*` health rows (`waveshare_device.c:293-312`); grep `apps/os` voicelab
   for readers first. ≈ −500.
9. M5StickS3 adopts: playback write + `M5.Mic` read; the half-duplex fence
   stays in `extra->capture_fence`, and a fenced write returns `UNAVAILABLE`
   = skip with no ledger credit (`m5sticks3_audio.cpp:213-216` today).
   ≈ −350.
10. `i2s_codec.c` part 2: channels from `iterate_kit_i2s_codec_facts`
    (`havpe_audio.c:806-917`, `m5sticks3_audio.cpp:359-424`), the duplex
    `if` on `capture_port == playback_port`, silence preload, the
    every-nth capture path. havpe + M5 adopt. ≈ −150.
11. `board/led_ring.c` from `havpe_ui.c:148-180,386-465`: power rail, RMT,
    12→N repeat, dirty gate, 20 Hz, `borrow` for the dial overlays.
    ≈ −80 (havpe keeps `render_volume`/`render_quadrant`).
12. `board/codecs/aic3204.c` + `xmos_i2c.c`: `voice_pe_hardware_config.c:33-95`,
    `havpe_audio.c:595-655,657-734`; tests re-pointed in
    `tests/CMakeLists.txt:221-242`. Net 0.

Phase 2, the table:

13. `board.h` + `board.c`: the runner. havpe becomes table (~200) +
    `open_codec` (~70: XMOS 1.3.1 gate, pipeline stages, VNR) + `extra`
    (~250: dial, modes, NVS, overlays, `aec.setStage`, `xmosVnr`/`dialMode`
    health). `havpe_registers.c` stays pure for its tests. 3,460 → ~600.
14. Waveshare → table (AXP2101 script `waveshare_audio.c:350-381`, amp GPIO)
    + `extra` (display, avatar, expander button owning the grammar).
    2,979 → ~1,650.
15. M5StickS3 → table (ES8311 script `m5sticks3_audio.cpp:335-344`, volume
    reg 0x32 full 0x9B) + `extra` (face, fence, PMIC amp bit in phase). Table
    lives in a `.c`; the `.cpp` files keep their `extern "C"` surface.
    2,040 → ~1,200.
16. StackChan → table (facts) + `extra` (nearly everything: TDM audio via
    `audio = NULL`, avatar, body, camera, image, processor). Drop its
    `phase`, renderer, run, ledger. Check the duplicate saturating atomics
    (`core_s3_capture_reserve.c:20-55` vs `stackchan_avatar.c:303-333`)
    against `iterate/kit/atomic.h`. 6,234 → ~5,400.

Phase 3, the Satellite1:

17. `board/codecs/tas2780.c` and `pcm5122.c` + `xmos_spi.c` + host tests
    against a recording I2C/SPI fake. TAS2780: the page 0/1/0xFD script
    (`tas2780.cpp:277-338`), chip id `0x05 == 0x41`, `activate` =
    ACTIVE_MUTED → 100 ms → SAR reads `0x52..0x55` (`vbat1s = raw/128`,
    `pvdd = raw/64`) → PVDD ≥ 7.4 V mode 2 else 2.9 < VBAT1S ≤ 5.5 mode 0 →
    rewrite `0x03/0x04/0x71` → ACTIVE; DVC `0x1A` 0..0xC8, mute 0xC9. PCM5122
    (the shipped config uses UPSTREAM ESPHome's driver, not the deleted
    in-repo one): reset `0x01 = 0x10`, 20 ms, `0x01 = 0`; `0x25` RMW set bit 3
    clear bit 1; `0x28` = I2S | ALEN, and set ALEN for **32-bit** (upstream
    defaults to 16-bit and the YAML does not override, which latches only the
    top 16 bits of each 32-bit slot; choose 32 deliberately); `0x2A = 0x11`
    stereo; page 1 `0x02 = 0` analog gain 0 dB; `0x0D` RMW bits[6:4] = 001 PLL
    from BCK; mute `0x03 = 0x11` / unmute `0`; volume `0x3D`/`0x3E` =
    `0x30 - dB*2`, range 0 dB (0x30) to −52.5 dB (0x99); jack detect = GPIO3
    via reg `0x77`. SPI: `[resource, cmd|0x80, len+1]`
    padded to the 4-byte status report, retry ×3 on 7, NOP second transfer
    for reads, mode 3, 8 MHz. ≈ +400.
18. `devices/satellite1/` + `targets/satellite1/` (table below). Register
    in `tools/generate-sounds.sh`, `apps/os/scripts/voicelab/boards.ts`
    `BOARDS`, `apps/kit/src/firmware/catalog.ts` (device entry; release once
    a build exists). ≈ +300 board, +90 target.
19. `microphone_muted` in `iterate_kit_conversation_visual_state`, animated
    in `conversation_lights` (dim red, breathing off). Satellite1 sets it
    from the XMOS status register. ≈ +40 core, host test row.
20. Bench, in this order: `health()` over the stream; XMOS version in
    health; inspect `echoRawPeak` versus `echoCleanPeak` where the board has
    a real raw tap; then run `voicelab boards --only satellite1` and inspect
    `health()` again. The procedure uses no `voicelab aec` or `voicelab
    latency` command.

## The Satellite1 as a table

Facts from `Satellite1-ESPHome` (MIT YAML): `config/common/core_board.yaml:33-61`,
`speaker.yaml:18-41`, `led_ring.yaml:11-18`, `buttons.yaml:34-106`,
`satellite1.base.yaml:124-135`; XMOS channel layout from
`Satellite1-XMOS/satellite-xmos-firmware/src/main.c:187-215`.

```c
enum { PIN_XMOS_RESET = 4, PIN_ACTION = 0, PIN_STATUS_LED = 45, PIN_RING = 21,
       I2C_TAS2780 = 0x3F, I2C_PCM5122 = 0x4D,
       SPI_CLK = 12, SPI_MOSI = 11, SPI_MISO = 13, SPI_CS = 10 };

/* GPIO4 LOW = XMOS running from its own flash; open_codec polls its version. */
static const struct iterate_kit_gpio_step boot[] = { {PIN_XMOS_RESET, 0, 0} };

static const struct iterate_kit_register_script scripts[] = {
  {I2C_TAS2780, tas2780_base,  TAS2780_BASE_COUNT,  0,  ITERATE_KIT_SCRIPT_BEFORE_I2S},
  {I2C_PCM5122, pcm5122_reset, 2,                   20, ITERATE_KIT_SCRIPT_BEFORE_I2S},
  {I2C_PCM5122, pcm5122_open,  PCM5122_OPEN_COUNT,  0,  ITERATE_KIT_SCRIPT_AFTER_I2S},
};

static const struct iterate_kit_i2s_codec_facts audio = {
  /* ONE duplex bus the XMOS masters: LRCLK 7, BCLK 8; MCLK 16 is the XMOS's, unused here. */
  .playback_port = I2S_NUM_0, .capture_port = I2S_NUM_0, .role = I2S_ROLE_SLAVE,
  .playback = { .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(48000),
                .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
                .gpio_cfg = {.mclk = I2S_GPIO_UNUSED, .bclk = 8, .ws = 7, .dout = 9, .din = 15} },
  .capture = { /* same bus */ },
  .dma_frames = 480, .dma_descriptors = 6,        /* 3840 B / 10 ms, 60 ms ring: havpe's TX geometry */
  .playback_shape = {.bits = 32, .slots = 2, .ratio = 3},
  /* XMOS v1.0.3 emits each 16 kHz sample three times. Slot 0 is AGC; slot 1
   * is AEC+IC+NS. Neither is raw. Current calibration uses NS slot 1 at x32,
   * coupled to the TAS2780 60% volume ceiling. */
  .capture_shape = {.bits = 32, .slots = 2, .uplink_slot = 1, .diagnostic_slot = -1, .ratio = 3},
  .capture_gain = 32,
  .amplifier_gpio = -1,                           /* TAS2780 is I2C, and TX never stops: it is the AEC reference */
};

static const struct iterate_kit_board board = {
  .facts = { .stream_path = "/agents/voice/satellite1", .client_path = "/clients/satellite1",
             .conversation_id = "sat1dev", /* greeting, instructions, peer_description, hints as havpe */
             .speaker = {.ceiling = 60}, .speaker_dry_wait_ms = 40,
             .processing_frame_samples = 320, .capture_chunk_samples = 320, .capture_stack_bytes = 4096,
             .turns = ITERATE_KIT_VOICE_TURNS_SERVER_VAD, .radio_before_codec = true },
  .i2c = {.sda = 5, .scl = 6, .hz = 400000},
  .boot = boot, .boot_count = 1,
  .scripts = scripts, .script_count = 3,
  .audio = &audio,
  .volume = {.i2c_address = I2C_TAS2780, .page_register = 0x00, .page = 0x00,
             .registers = {0x1A}, .register_count = 1, .full_code = 0x00, .floor_code = 0xC8},
  .ring = {.gpio = PIN_RING, .pixels = 24, .order = LED_PIXEL_FORMAT_GRB, .power_gpio = -1},
  .status_led_gpio = PIN_STATUS_LED,
  .button = {.gpio = PIN_ACTION, .active_low = true, .tap_wakes = true, .tap_ends = true},
  .sounds = { /* generated */ },
  .open_codec = satellite1_open_codec,   /* SPI version gate (resource 240, cmd 88), TAS2780 activate */
  .set_volume = NULL,
  .extra = &satellite1_extra,            /* the three XMOS side buttons */
};
```

The four buttons: the action button on GPIO0 is the table button and runs the
grammar. Vol+, Vol− and Mute live on XMOS port IN_A bits 0/2/3 (inverted),
read from status register byte 1 by polling `iterate_kit_xmos_spi_status` at
the 25 ms control poll in `extra->poll` (~40 lines): Vol± = speaker ±5 with the
ring borrowed for a volume bar (havpe's dial arithmetic,
`havpe_device.c:279-287`); Mute is a hardware cut of the mic rail that the
XMOS only reports (bit 3, NOT inverted: the vendor's `buttons.yaml` says
`inverted: false`, unlike Vol±), so it sets `microphone_muted` on the visual
state and a `micMuted` health field. Read only status byte 1; the shipped XMOS build's
bytes 0 and 3 are noise (3-byte buffer copied as 10).

`open_codec`: SPI2 mode 3 at 8 MHz; poll `{240, 0xD8}` up to 4 s at 250 ms
until a non-zero version (fail closed, as havpe's gate); then TAS2780
`activate` as in step 17. Without USB-PD it lands in mode 0 at 5 V, quieter
and working. `xmosMajor/Minor/Patch`, `ampPowerMode`, `ampPvddCentiVolts` in
health.

Target: copy `targets/havpe/` (same N16R8: 16 MB flash, octal PSRAM 80 MHz,
USB-Serial-JTAG console, IRAM-safe I2S/GDMA ISRs, config partition at
0x510000); add `esp_driver_spi`. Board ROM MAC `14:C1:9F:4F:D2:14`; flash with
`idf.py -p "$(tools/port-for-mac.sh 14:C1:9F:4F:D2:14)" flash`.

Not in v1: FUSB302B USB-PD (20 V for amp mode 2; port from PD_Micro, MIT,
when wanted), the XMOS flasher (ship with the vendor image, gate on version),
LD2450 radar, AHT20, LTR-303, jack auto-switch.

## Measured results and remaining acceptance

The consolidation is complete enough to assess as a board-table design. The
source measurements taken during the work were: `devices/` changed from 14,713
to 10,943 lines including the 313-line Satellite1; shared code added 3,958
lines; the fleet's net change was +188. Per board the source counts changed
from 3,460 to 1,004 (HAVPE), 2,979 to 2,077 (Waveshare), 2,040 to 1,545 (M5),
and 6,234 to 6,004 (StackChan). These replace the earlier estimates and are
historical measurements, not a claim about the current worktree.

Settled root `typecheck`, `lint`, `knip`, and full `pnpm test` pass
(`/tmp/futurehomes-final-*.log`), as do all five final release builds and 72 C
tests (`/tmp/futurehomes-*-release-build.log`). The preceding prime firmware was
cable-flashed to both boards with the WakeNet history fix (destroy and recreate the model rather than call
`clean()`); each completed three call cycles with no reset, stable heap, and
wake frames resuming after a call. See
`/tmp/futurehomes-havpe-reset-cycles.json` and
`/tmp/futurehomes-satellite1-reset-cycles.json`. HAVPE's 5 ms status-log spam
is fixed, its status pointer remained stable, and its final flash completed.

The health-room regression is fixed by raising the health cap from 2,816 to
6,144; the greater-than-4 KiB regression passes. All five health-room builds
and 72 host tests pass, and both boards are flashed with it.

The final host suite (72 tests), all five IDF builds, and the Satellite1
volume-60 rebuild passed. The latest actual CLI final three-turn proof passed
(`/tmp/futurehomes-cli-final-talk.log`). Earlier release instrumentation also
recorded 1,818–1,840 ms completion drain, 852–896 ms first audio, 27 received
packets, and zero sequence gaps, drops, starvation, recycle, or failure.
Its final-tail fix pads only after `answer_done` and drains; a partial answer
now fails durably as `watchdog-stalled`. A Release/NDEBUG side-effect review
and full Release build passed.

Production OS `e68dcae4-a8da-44ea-a204-826b05169fd1` deployed at 06:23 via
the safe integration of `4f7ccc` and the prior v4 work; all rollout smokes
passed (`/tmp/futurehomes-production-final-rollout-authorized.log`). Local
voice artifact config commit `20a70476` (SHA prefix `a1b9c3b`) is installed;
both parent streams were explicitly restarted and their open-mic setup is
healthy (`/tmp/futurehomes-production-{satellite1,havpe}-{parent-restart,setup}.log`).

The exact new-board recipe is four files and 264 lines: device C (229), device
CMake (6), target CMake (8), and defaults (21), excluding generated assets and
lockfiles.

The tuning audit preserves HAVPE's pre-table `8f019cc43` topology from
`devices/havpe/havpe_audio.c`: separate XMOS-clocked slave I2S controllers,
TX 48 kHz Q31 480×6, RX 16 kHz Q31 320×5, processed/raw slots 0/1, x16 gain,
40 ms speaker dry wait, preload and continuous idle TX reference. VNR remains
health-only; there is no ESP-side AGC or loudness gate. Satellite's NS slot 1,
gain 32-before-PCM16, no raw diagnostic tap, and TAS2780 cap 60 are intentional
hardware tuning. Source equality cannot prove AEC or acoustic latency: release
needs repeated board evidence with counters, transcription, and no far-only
turns/self-barge; actual speaker-start timing needs board-clock or external
acoustic measurement.

HAVPE final release is flashed and passed: barge call-up in 3.753 s with the
full story prompt, interruption partly recognized in Japanese, `pineapple`,
one supersession, and playout generation 4/4; AEC delivered an exact full
prompt with one created/done over 3,064 frames (61.28 s), 3,059 continuously
(61.18 s), zero self-barge/starvation/runtime errors, same session/call, and
idle return; quiet ran 46.175 s, then completed the full `banana` prompt,
answer, and idle return (`/tmp/futurehomes-havpe-release-{barge,aec,quiet}.json`).
The health-room repeat AEC passed 3,499 frames (69.98 s), 3,491 continuous
(69.82 s), one created/done, zero self-barge/starvation/runtime errors, and
idle return (`/tmp/futurehomes-havpe-healthroom-repeat-aec.json`).

Satellite1's NS channel is real; the old silence conclusion was a room-noise
measurement error. Gain 16 missed prefixes. At NS slot 1 gain 64, volume 70
and then 65 both failed strict repeated barge transcription (the 65 run heard
`bimetal`), although the model answered `pineapple`; neither is acceptance.
At volume 60 (TAS DVC 80, −40 dB), two independent wake-and-barge runs passed
the full prompt, `So, say the word pineapple instead`, supersession, and a new
played `pineapple` answer (`/tmp/futurehomes-satellite1-volume60-{barge,repeat-barge}.json`).
That is not final acceptance: the later NS-slot-1 gain-64 long run failed at
62 s with a late self-transcript, two responses, and supersession despite zero
starvation and runtime DMA (`/tmp/futurehomes-satellite1-final60-aec.json`).

The latest Satellite firmware returns to NS slot 1 at gain 32 with output cap
60 (TAS DVC 80, −40 dB), after fixing Q31 gain before PCM16 conversion; the old
path discarded low bits. Raw/pregain health is retained. Its barge proof heard
and answered `pineapple` with one supersession
(`/tmp/futurehomes-satellite1-precision32-barge.json`), but the full
interruption ASR was partly garbled in Japanese, so this is not a perfect
transcription claim. Its AEC proof passed 3,249 played frames (64.98 s), 3,233
continuous (64.66 s), one created/done, two audio-done, zero tools/errors, all
runtime-failure deltas zero, the same session/call, and return to idle
(`/tmp/futurehomes-satellite1-precision32-aec.json`). The prompt ASR missed
`Tell me a`; the documented keyword criterion passed, but this is not a
full-prompt claim. Runtime DMA is zero and warmup is 8/8. Final release barge
passed: 2.978 s call-up, full story prompt, `So say the word pineapple instead`,
one supersession, and playout generation 4/4
(`/tmp/futurehomes-satellite1-release-barge.json`). Release AEC completed with
2,974 frames (59.48 s), 2,971 continuous (59.42 s), and zero self-barge,
starvation, or runtime failures (`/tmp/futurehomes-satellite1-release-aec.json`).
Its health-room-ready quiet proof passed 45.107 s, then a full `banana` prompt,
answer, and idle return (`/tmp/futurehomes-satellite1-healthroom-ready-quiet.json`).
The post-rollout repeat AEC passed 3,089 frames (61.78 s), 3,058 continuous
(61.16 s), zero self-barge/starvation/runtime failure, same call/session and
idle return (`/tmp/futurehomes-satellite1-postrollout-repeat-aec.json`). The
latest barge pass is recorded in
`/tmp/futurehomes-satellite1-postrollout-barge.json`.

HAVPE’s actual CoreAudio three-turn speaker timing was 2,160/1,960/1,980 ms
(median 1,980 ms), with eight total short turns and zero self-barge
(`/tmp/futurehomes-havpe-acoustic-latency.json` plus waveform PNG). The valid
Satellite post-rollout acoustic probe produced five audible replies, but the
overall probe failed because the fifth transcript arrived late; the probe now
waits for it (`/tmp/futurehomes-satellite1-postrollout-acoustic.json` and PNG).
Its nine-turn acoustic soak measured 1,820–2,080 ms (median 1,960 ms) and
recorded 300 seconds of CoreAudio without clock drop
(`/tmp/futurehomes-satellite1-soak-acoustic.json` and PNG). The broader
12-turn soak yielded nine good replies with zero self-barge, starvation, or
runtime failure on one session, but the actual call closed after about 60 s.
The durable reason was `Grok's socket closed` at 06:37:50.479 even though the
provider was OpenAI (`/tmp/futurehomes-satellite1-soak-latency.json` and
`/tmp/futurehomes-satellite1-soak-ended-events-small.log`).
This is not a passed long soak. The provider-close path subsequently gained
durable close recording and one bounded reconnect per call in voice-agent v20;
the exact two-close preview proof passes and v20 is installed on both streams.

The matched-latency evidence is still incomplete and is not a pass. The Mac C
ten-minute run completed 102 turns: speech end to first packet was p50 1,593
ms, p90 1,984 ms, max 5,943 ms. Its non-quiet run was p50 1,653 ms, p90 2,053
ms, max 16,559 ms, with 189 starved-buffer events and nine underruns in the
room path despite zero wire gaps and no reconnect. HAVPE's first ten-minute
run failed at turn 20 after 19 clean turns, on the same connection, with one
sequence gap/regression and one superseded response; actual acoustic delay of
13,020 ms was confirmed. After correcting the direct Node runner to send
continuous zero PCM while awaiting a reply, two ten-minute runs completed:
160 turns at median/max 1,428/1,689 ms, and 173 turns with the later HAVPE
session snapshot at 1,381/1,798 ms. Last-third median increases were 114 and
136 ms. These are received non-quiet PCM endpoints, without physical playback.
The matched raw Node run using Satellite's DTO production session snapshot
(SHA `e4f72dc…c97`) completed 169 turns: received non-quiet p50 1,377.5 ms,
p90 1,523.4 ms, p99 1,966 ms, max 1,988.9 ms, and +89.8 ms first-to-last-third
drift (`/tmp/futurehomes-direct-openai-satellite-dto-matched-10m.jsonl`). It
is also not a physical-playback measure.

The second HAVPE run stopped at an expected delivery callback batch-budget
renewal, which the probe now distinguishes from a WebSocket replacement. It
then falsely rebooted under a PONG-only watchdog despite inbound frames.
Deterministic regression tests reproduce the watchdog and suppressed-keepalive
bugs; both fixes pass, all five targets build, and HAVPE survives more than
twelve unpolled idle minutes with seven PONGs. A third HAVPE run on that
firmware still had a 10,110 ms acoustic stall and an actual WebSocket loss
after 37 turns. Cloudflare recorded a 1006 close followed by a Durable Object
storage reset; the initiating cause remains unproven. Detailed evidence and
benchmark budgets are in the [VoiceLab README](../apps/os/scripts/voicelab/README.md#matched-latency-benchmark).

Satellite's 59-turn run is discarded for AEC and acoustic evidence because the
non-target HAVPE woke. In the new isolated attempt at 2026-09-10T09:06:58.588,
a prompt received no VAD or response for 45 s; room level was unchanged, with
651 native appends, zero errors, a read-only trace proof, and no reset. Two
subsequent three-turn runs passed with a PCM tap: 1,100 frames over 22 s, three
VAD pairs, peak 2,333, and estimated board-send-to-tap median/max 92.5/465.5
ms. This is not ten-minute acceptance. The subsequent isolated Satellite ten-minute run
completed 96 correct turns over one WebSocket and provider session, each with
one VAD pair, response, and audio-done, and zero runtime faults
(`/tmp/futurehomes-satellite1-dto-prd-10m.json`). It nevertheless fails the
latency budget: turn 3's playback bound was 9,197 ms and turn 41's was 3,211
ms; first-/last-third medians were 1,838/1,825 ms (−13 ms). HAVPE was parked
for the whole run, then restored to normal RUN health
(`/tmp/futurehomes-havpe-dto-prd-restored-ready2.json`). The room clock was
valid to 10.34 ms with zero drops. Known-waveform regressions now cover quiet
responses, noise alone, a short click preceding the reply, and actual late
audio. The corrected analyzer reports 94 of 96 turns at median 1,870 ms and
first-to-last-third change +30 ms; turns 38 and 82 remain unmeasurable at the
highest threshold. Per-turn threshold sensitivity is retained, and acoustic
acceptance remains incomplete. Reviewed failures are 9,200 ms at turn 3 and
3,230 ms at turn 41 (`/tmp/futurehomes-satellite1-dto-prd-acoustic-confirmed.json`).

The established backend recovery fixes are deployed to production from the
current-base integration checkout. Further latency experiments are isolated
to preview 6. A twelve-call preview reproduction showed a plain DTO RPC leak:
both inner and outer layers retained an object until session cleanup, while a
primitive control released per call. The shared helper's native-object path is
now green for 100/100 calls (activation 29–48 ms; invocation 36–57 ms) on
preview `85151b9c`; nested callable functionality is 8/8 green, but its native
lifetime until session cleanup remains explicitly unresolved. The proven DTO
fix deployed to production as `dfe1177a-157c-4039-878b-c656cff30330`; standard
deploy and smokes pass (`/tmp/futurehomes-dto-prd-deploy.log`). Temporary
`/repros` diagnostics were stripped from production only. Full OS
route/schema/template/typecheck validation and 23 focused tests pass. The
production native guard is now 100/100 Satellite `health()` calls at
09:18:24.508–09:18:34.980, with activation 47–108 ms and invocation 56–143 ms
released per call before two seconds of idle cleanup
(`/tmp/production-satellite1-health-100-proof.json`,
`/tmp/100-activateLiveCapability.json`, and
`/tmp/100-invokeLiveCapability.json`).

The ten-minute minimal backend probes do not support a strong mutation-only
attribution: read-vs-append measured read max 465 ms and ephemeral max 2,417
ms; empty-append-vs-ephemeral measured empty max 1,812 ms and ephemeral max
502 ms, with zero subscriptions and all 60,000 events settled. The exact
correlated 30,000-event ten-minute probe also had zero errors and 1,601 ms max;
its worst tagged event had native body 0 ms, native wall 80 ms, and CPU 0.
Missing parent-call propagation prevents an upstream exact join, so the next
preview probe adds the same probe ID to the ingress span. No storage
optimization was implemented.

The correlated append run had 22,150 successful paired appends before a `1006`
at 09:57:36.059Z. Its owning root `GET /api` request exceeded the 32,000 ms CPU
limit at 09:57:35.554Z (445,429 ms wall), 505 ms earlier, which explains that
peer close (`/tmp/futurehomes-correlated-close-full.json`). The earlier
defaults connection has the same CPU-limit shape
(`/tmp/futurehomes-defaults-close-discover.json`). This does not explain the
HAVPE capability-pager close: its socket turn was 47 ms / 0 CPU, with a
separate later retryable dispose error and storage reset
(`/tmp/futurehomes-havpe-close-root-audit.json`).

A candidate is now deploying to preview: move `/api` WebSocket Cap'n Web
handling into one `ItxSessionDurableObject` per connection, accept it normally,
and forward from the root. Its deployment log is
`/tmp/futurehomes-itx-session-do-preview-deploy.log`. There is no green
long-run proof. This candidate neither explains nor resolves the audio-latency
stalls or the HAVPE pager close; original acceptance remains unmet. All five
Fable max reviews completed; the fifth is
`/tmp/futurehomes-fable-review-5.log`. Final settled validation and repeated
hardware acceptance remain required.

The final acceptance path no longer uses `getEventPage()` after a
`MAX_SAFE_INTEGER` limit-one read: it derives `streamMaxOffset` and opens a
replay cursor. Cursor state is only processed/scanned-through, never the head;
refreshes run every 10 s with at most three retries and a 60 s deadline.
Preview 6 controlled-fault exact-once and poison-terminal (three restarts)
proofs pass. An autonomous alarm proof shows revival at 05:34:55.047, 22.027 s
before the observer at 05:35:17.074, after 63 s with no source-call wait and
exactly one effect (`/tmp/facet-alarm-proof-observer.json`). Native quota was
not reproduced: a local CLI 10,050-fanout attempt ended without a result and
is not evidence.

Satellite1's XMOS was not reflashed: read-only readback confirmed the vendor
fixed-delay v1.0.3 image at
`/tmp/futurehomes-satellite1-xmos-installed.bin` (MD5
`5f5788ecb240082f61acd36f247ea3b2`; SHA-256
`7e3a5d97ca3e90df953c0b2ef575b5d5dcb89c5d84a59e621a3bc7cf2cfd0d52`). A
temporary ESP application held GPIO4 to reset XMOS and switch the ESP SPI bus
to direct access to XMOS's external boot flash for diagnostic readback only.
It released GPIO4 low and restored the normal ESP firmware; no XMOS flash was
performed. A cold-DSP readback re-confirmed the same known image
(`/tmp/futurehomes-satellite1-agc60-cold-dsp-readback.log`).

Both vendor reviews are complete and corrected:
[DSP review](2026-09-10-satellite1-vendor-dsp-review.md) and
[board review](2026-09-10-satellite1-vendor-board-review.md). Their main
recommendations are already adopted; no XMOS upgrade is indicated. Smaller DMA
and DC-filter changes remain measurement-gated candidates.

The remaining release acceptance is deliberately ordered:

1. For a board stream, install the correct voice agent with `voicelab talk
   --setup-only`; include `--open-mic` for an open-mic board. Preserve the
   existing board custom tools and stream configuration; setup-only must not
   blindly overwrite them. The command refuses an accidental posture change.
   Only pass `--flip-turn-posture` when intentionally migrating an existing
   stream; do not manually append a configured event.
2. Cable-flash a wake-word target with `idf.py flash`, including
   `srmodels.bin`, then inspect `health()` for model load, frame movement,
   detection, bounded worker time, and a coherent failure state. OTA cannot
   install the model partition. An OTA/release path therefore needs an
   explicitly verified model-partition strategy before it can carry a
   wake-word image.
3. Run `voicelab boards --only <name>` against each connected board and read
   `health()` before and after it. Confirm a transcript, played response,
   no unexplained capture/playback failures, and the board's measured signal
   path. Satellite1's NS slot 1 is a live uplink plane; it still has no raw
   ESP tap, so `echoRawPeak` is not an AEC oracle.
4. Isolate an AEC or wake-word bench acoustically. Put every non-target MCU in
   downloader mode before saying the wake word, using its MAC-resolved port:
   `esptool --port "$(tools/port-for-mac.sh <ROM-MAC>)" --before usb-reset
   --after no-reset read-mem 0x6000403c`; restore it with `--before no-reset
   --after hard-reset read-mem 0x6000403c`. Otherwise another board can hear
   the word and invalidate the result.
5. Satellite1's flashed volume-60 startup cap is verified: a request for 100
   returns 60. The latest common warmup accounting activates separate TX/RX
   flags only after their first successful hardware transfer; Satellite1 boot
   reports runtime TX/RX 0, flat warmup 10/8, and all other fault/drop/starve
   counters 0, including after a failed ASR
   (`/tmp/futurehomes-satellite1-{calibrated-boot,verified-barge}.json`).
   Final acceptance requires repeated full-length AEC runs with no
   self-interruption, plus a primary measurement from speech end to actual
   speaker start. The safe production rollout is complete. Keep acceptance
   open for Satellite’s call-lifecycle diagnosis and repeated long soak,
   post-rollout latency evidence, HAVPE’s post-rollout quiet proof, and final
   telemetry review. The latest CLI three-turn physical proof is complete.
6. Compare latency under matched server-VAD conditions for three persistent
   ten-minute clients: a direct Node script on this Mac, the Mac C CLI, and an
   ESP32 board. For every turn, record speech end → first audio *received* and
   speech end → first audio *actually played* as separate measures. Demonstrate
   comparable results rather than assuming the observed 1.5–2 s is acceptable,
   and inspect time-bucketed results for drift; do not claim a drift guarantee
   until that long-run evidence exists.

The supported verification commands are `voicelab device`, `voicelab boards`,
`voicelab talk`, and `voicelab transcript`; the earlier `voicelab aec` and
`voicelab latency` steps were not CLI commands and are removed from this plan.

## Design round 2: "adding a new ESP32 device should be easy" (2026-09-09, evening)

Four independent designs, each under a different constraint, against the six real axes of difference (topology, echo cancellation, input, output, chips, power). Reports in the session scratchpad (`design2/report-{A,B,C,D}.md`).

| | A: the table absorbs every axis | B: three seams (codec, input, output as ops + context) | C: three families (profiles that fill the table) | D: delete and move only |
|---|---|---|---|---|
| Shape | enums for topology/echo/chips/inputs/outputs; a pure posture rule | the hardware tasks pump a codec; `inputs[]`/`outputs[]` of ops structs; one gesture struct, one grammar | `dsp_audio` / `codec_audio` / `processor_audio` profiles, each a component that fills the table | the table untouched; the periphery consolidated |
| Sixth board | ~110 lines | ~95 + files | ~80 (C says: a wash vs today's table) | ~71 lines in 4 files (today: 445 lines in 12 files + 4 touches) |
| Fleet net | ≈ −1,000 (+2,900 shared, ~900 new) | ≈ −2,150 | ≈ −1,500 (−1,200 of it family 2) | ≈ −700 |
| Cost | header 136→300; fixed enums with one implementation per value; boot-time validation | reworks `i2s_codec.c`'s tasks and StackChan's audio path; a UX change to StackChan's menu | two layers; ten fields repeated in three headers; family 3 has one member | Kconfig split over two files; `main/`-less targets are unusual |

**Decision.** D now, B later, A and C not.

- **D lands as chunk 7 (step 23).** The measured cost of a new board is the periphery, not the table: 245 of 445 lines are verbatim copies (target CMake, `main/`, the device header, the manifest, partitions, 61 identical sdkconfig lines, make-sounds.py, four `.gitignore`s, the CMake guard), and the table already writes the sixth board in ~60 lines. Every step is a move or a deletion with a mechanical proof (sdkconfig key→value maps equal, partition offsets equal, generated sounds byte-identical), the ESP-IDF facts it leans on were verified in the 5.4.2 source, and none of it changes behaviour, so it is safe to land with three boards off the bench.
- **B is the right shape for the six axes and waits for a bench.** Ops structs with a context rhyme with `iterate_kit_audio_codec` and `iterate_kit_board_ops`, which is this codebase's idiom, and one gesture struct with one grammar removes the four grammar copies. But its codec seam re-plumbs the shared hardware tasks and StackChan's TDM path, which cannot be proven without the M5StickS3, the Waveshare and the StackChan connected; the three review rounds so far caught regressions on exactly those boards. Take it up in a chunk when they are on the desk, input and output seams first (no audio path), codec seam last.
- **A is rejected**: a fixed list of kinds with one implementation per value (TDM_MASTER, ES7210_AW88298_BSP, two ES8311 values) is the framework the doctrine forbids, and it trades compile-time typing for boot-time validation of tagged rows. Its one durable insight, posture derived from facts instead of restated per board, lands in its smallest form as D's board.c defaults.
- **C is rejected**: profiles are spec-objects layered over the table (profile → table → ops), three headers repeating ten fields, and C's own numbers say the sixth board is a wash. Its `core/mode.c` observation (HAVPE and StackChan carry the same NVS/adopt code) is real and goes with B's chunk.


## 2026-09-11 — shared frontend client controls

Jonas approved implementing all three frontend structural opportunities and
explicitly allowed a large refactor while the backend is revamped separately.

- Both the ESP app task and macOS CLI now run the portable `voice_uplink`
  controller for turn admission, mic batches, release snapshots, tail flushing,
  and bounded failure handling. The CLI's adapter owns source preparation and
  reporting; the ESP adapter owns capture-fence/view updates and atomic capture
  permission. Platform transports retain their different concurrency ownership.
- Board input callbacks now return normalized gestures. `board.c` alone applies
  session grammar, copies intent, and orders end/wake chimes. Board-specific
  dial/menu behavior and dedicated audio paths remain with the devices.
- HAVPE and StackChan use common provider-mode validation, adoption, and NVS
  persistence with their existing defaults and namespaces. Persistence failure
  is reported without leaving live mode configuration partially applied.

The shared uplink also closes behavior gaps exposed by the extraction: open-mic
CLI sessions no longer emit PTT markers; failed audio/marker publication is
terminal and observable; release flushing is capped to the queued-frame snapshot; and a held button cannot continuously reopen turns after its limit.
Host controller tests cover these cases plus buffered speech, empty dials,
backpressure, and commit bounds. CLI adapter and existing ESP-loop tests exercise
the actual platform integrations. This is a source/build change; these refactored
images have not been flashed, and no backend deployment is part of this work.

Validation completed: 77/77 host tests pass with sanitizers, including the new
uplink and provider-mode tests and the existing ESP voice-loop integration
tests. All five ESP-IDF targets build: HAVPE, Satellite1, M5StickS3, StackChan,
and Waveshare S3 AMOLED. Final source review verified both chime assets in every
board table and consumption of coincident hardware/injected taps. `git diff
--check` passes. Build logs and binary hashes are in
`/tmp/futurehomes-client-refactor-*.log` and
`/tmp/futurehomes-client-refactor-firmware-artifacts.json`. Changes remain local
and uncommitted; no firmware flash, backend deployment, push, or PR was performed.
