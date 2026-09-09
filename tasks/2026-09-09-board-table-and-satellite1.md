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
    health; `echoRawPeak` vs `echoCleanPeak` with `voicelab aec`;
    `voicelab boards --only satellite1`; then `voicelab latency`.

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
  /* XMOS emits each 16 kHz sample three times. slot 0 = AEC+IC+NS+AGC, slot 1 = AEC+IC+NS.
   * Uplink starts on slot 1 at x16, havpe's measured lesson (AGC re-triggers server VAD);
   * the bench decides. */
  .capture_shape = {.bits = 32, .slots = 2, .uplink_slot = 1, .diagnostic_slot = 0, .ratio = 3},
  .capture_gain = 16,
  .amplifier_gpio = -1,                           /* TAS2780 is I2C, and TX never stops: it is the AEC reference */
};

static const struct iterate_kit_board board = {
  .facts = { .stream_path = "/agents/voice/satellite1", .client_path = "/clients/satellite1",
             .conversation_id = "sat1dev", /* greeting, instructions, peer_description, hints as havpe */
             .speaker = {.ceiling = 100}, .speaker_dry_wait_ms = 40,
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
XMOS only reports, so it sets `microphone_muted` on the visual state and a
`micMuted` health field. Read only status byte 1; the shipped XMOS build's
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

## Open bench decisions

- Which XMOS tap is the uplink (slot 1 NS at x16 vs slot 0 AGC at x1).
  `voicelab aec` decides; the table makes it a one-line change.
- GPIO16 MCLK: all audits say leave the pad unused on a slave; nobody has
  scoped it. Verify on first flash.
- The Voice PE capture DMA geometry: 320×5 today vs the shared 480×6. Keep
  two geometries in the table only if the bench shows a difference.

## Numbers (estimates)

| | before | after |
|---|---|---|
| havpe | 3,460 | ~600 |
| waveshare_s3_amoled | 2,979 | ~1,650 |
| m5sticks3 | 2,040 | ~1,200 |
| stackchan | 6,234 | ~5,400 |
| boards total | 14,713 | ~8,850 |
| shared added (board.h/.c ~600, i2s_codec ~520, led_ring ~130, button ~110, pcm_format ~170, xmos_control ~140, ledger ~110, health ~30, tests ~300) | | ~+1,700 (~450 moved) |
| fleet net | | ≈ −4,400 |
| Satellite1 | (copy: ~3,000) | ~300 board + ~90 target + ~400 shared chip code |

## Instruction fixes that fell out

- `.agents/skills/adding-a-kit-device-or-sprite/SKILL.md` points at
  `apps/kit/docs/2026-08-06-stream-stack-review.md`, which is not in the tree,
  and describes `capture_is_echo_cancelled` / `capture_clock_is_hardware_owned`
  properties that were deleted. Rewrite Part 1 around the table once step 13
  lands.
