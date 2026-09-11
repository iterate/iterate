#ifndef ITERATE_KIT_PLATFORMS_BOARD_H
#define ITERATE_KIT_PLATFORMS_BOARD_H

#include "iterate/kit/platforms/i2s_codec.h"
#include "iterate/kit/platforms/led_ring.h"
#include "iterate/kit/platforms/register_script.h"
#include "iterate/kit/voice/loop.h"
#include "iterate/kit/session_grammar.h"

#ifdef __cplusplus
extern "C" {
#endif

/** A GPIO driven at boot, in table order: rails off, reset pulses, the XMOS boot wait. */
struct iterate_kit_gpio_step { int8_t gpio; uint8_t level; uint16_t hold_ms; };

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

/** The call-control posture. gpio -1 means a board callback supplies gestures. */
struct iterate_kit_gpio_button { int8_t gpio; bool active_low; bool tap_wakes; bool tap_ends; };

/** Physical input, normalized before the shared session grammar sees it.
 * A board reports only edges and levels: it does not decide call lifecycle,
 * copy voice intents, or render chimes. GPIO and synthetic taps are merged by
 * board.c with these fields before the grammar runs once per app-loop pass.
 */
struct iterate_kit_board_gestures {
  bool tap;
  bool held;
  bool end_hold;
  bool end_press;
};

/** Flash-resident 16 kHz PCM16LE chimes; NULL = silent. */
struct iterate_kit_board_sounds { const uint8_t *wake; uint32_t wake_bytes; const uint8_t *ended; uint32_t ended_bytes; };

/**
 * THE BOARD, AS DATA. Three things are code because no table can say them:
 * open_codec (version gates, SAR-ADC power modes, read-modify-writes), set_volume
 * (chips with no register to write), and extra (a face, servos, a camera, a fence,
 * a dial, side buttons). board.c runs its own half of each op first, then extra's:
 * extra->start before the codec; extra->present after the ring; board.c reads
 * GPIO and read_gestures, applies the grammar and chimes, then extra->poll handles
 * board-only UI. extra->health is appended; button.gpio >= 0 mounts button.press
 * first, then extra->modules appends the board-only capabilities.
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
  /** Optional non-GPIO controls, called on the app task to fill gestures. */
  void (*read_gestures)(struct iterate_kit_board_gestures *out);
  struct iterate_kit_board_sounds sounds;
  /** Optional hardware sound path. NULL uses the shared I2S codec. */
  void (*play_sound)(const uint8_t *pcm, uint32_t bytes);
  const char *wake_word;                 /**< NULL disables; "jarvis" uses WakeNet. */
  bool (*open_codec)(void);                          /* after I2S enable, before the first sample */
  enum iterate_kit_status (*set_volume)(uint8_t percent, uint8_t *applied);
  const struct iterate_kit_board_ops *extra;
};


/** Run the singleton board forever; startup failure parks in the loop's fault
 * path, including after watchdog enrollment. All extra ops receive NULL context.
 * extra->phase follows the shared ledger; other optional ops pass through.
 */
void iterate_kit_board_run(const struct iterate_kit_board *board);

/** Copy loop facts with omitted greeting, frame sizes and capture stack filled.
 * A zero dry wait becomes two thirds of the table's TX ring when audio supplies
 * a nonzero clock. Explicit values win; the board table is never modified.
 */
struct iterate_kit_board_facts iterate_kit_board_defaults(const struct iterate_kit_board *board);

/** Clamp to ceiling (at most 100), map linearly using signed arithmetic, and
 * report the requested clamped percent, not a lossy register round-trip.
 * Works with increasing or decreasing codes; negative codes use two's complement.
 */
uint8_t iterate_kit_board_volume_code(
    const struct iterate_kit_volume_register *volume, uint8_t ceiling,
    uint8_t percent, uint8_t *applied);
/** Drive each boot step then wait its hold, stopping on the first failed drive.
 * The callback owns GPIO configuration; zero hold does not call wait.
 */
bool iterate_kit_board_boot_steps(
    const struct iterate_kit_gpio_step *steps, size_t count,
    bool (*drive)(int8_t gpio, uint8_t level), void (*wait)(uint16_t ms));
/** Apply the active table's volume control; only successful writes update the
 * reported value. The dial and RPC share this exact path.
 */
enum iterate_kit_status iterate_kit_board_set_volume(uint8_t percent, uint8_t *applied);
/** Nudge by signed percentage points, clamp to 0..100 then the table ceiling,
 * and set through iterate_kit_board_set_volume. Success borrows the ring for
 * a one-second volume bar; failure leaves the reported volume and bar alone.
 * App task only; board-specific mute feedback may immediately replace the bar.
 */
enum iterate_kit_status iterate_kit_board_nudge_volume(int step);
/** Last view copied by board.c before presenting the ring and extra. Initially
 * zero; borrowed singleton storage changes on the next presentation. App task
 * only: poll reads the previous presentation, including call_active/wants_call.
 */
const struct iterate_kit_voice_view *iterate_kit_board_view(void);
/** Last successfully applied percent; startup adopts the board's driver value
 * when extra supplies one, otherwise the table's full-scale initial setting.
 */
uint8_t iterate_kit_board_volume(void);
/** Queue a synthetic tap in the same classifier as every physical control. */
void iterate_kit_board_inject_tap(void);
/** Apply the shared grammar to normalized input. Exposed for focused host
 * tests; board.c is the only firmware caller. */
void iterate_kit_board_apply_gestures(
    struct iterate_kit_session *session,
    const struct iterate_kit_board_gestures *gestures,
    const struct iterate_kit_gpio_button *button,
    enum iterate_kit_voice_turns turns,
    const struct iterate_kit_voice_view *view,
    uint64_t now_ms,
    struct iterate_kit_session_actions *actions);
/** Change the table button and loop posture together. HAVPE's dial changes
 * streams at runtime; a static facts.turns cannot describe its adopted mode.
 */
void iterate_kit_board_set_turns(enum iterate_kit_voice_turns turns);
/** This poll's grammar actions, for HAVPE's mode-reminder overlay. The table
 * has already rendered chimes and intents; extra must not render them twice.
 */
const struct iterate_kit_session_actions *iterate_kit_board_button_actions(void);

#ifdef ESP_PLATFORM
#include "driver/i2c_master.h"
/** Use a bus extra->start already opened (Waveshare's BSP display owns I2C0).
 * The table's pin/speed facts describe that same bus. No second creator or
 * deletion: its lifetime belongs to the BSP. Call before board startup scripts.
 */
void iterate_kit_board_i2c_use(i2c_master_bus_handle_t bus);
/** Use extra's existing native I2C register writer (M5Unified owns its bus
 * through M5GFX, not an IDF master handle). Table scripts/volume still own
 * ordering and mapping; the callback receives the table's bus frequency.
 * Install in extra->start. A board supplies either this or an IDF bus.
 */
void iterate_kit_board_i2c_write_with(
    bool (*write)(uint8_t address, uint8_t reg, uint8_t value, uint32_t hz));
/** Attach to the table's I2C bus at its declared speed. open_codec owns the
 * returned device; scripts use temporary handles, preserving page order.
 */
esp_err_t iterate_kit_board_i2c_device(uint8_t address, i2c_master_dev_handle_t *out);
/** Execute a script in wire order and its settle; fail on the first NACK. */
bool iterate_kit_i2c_write_script(const struct iterate_kit_register_script *script);
#endif

#ifdef __cplusplus
}
#endif
#endif
