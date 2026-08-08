#ifndef ITERATE_KIT_TALK_BUTTON_H
#define ITERATE_KIT_TALK_BUTTON_H

#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Semantic effects emitted by the one-button talk gesture reducer.
 *
 * START/STOP own microphone intent. LOCKED/UNLOCKED are presentation facts:
 * a screen, light, or sound adapter may acknowledge the mode without becoming
 * another owner of capture. One input sample can emit two ordered effects (for
 * example STOP then UNLOCKED), so callers must consume the result in order.
 */
enum iterate_kit_talk_button_effect {
  ITERATE_KIT_TALK_BUTTON_EFFECT_START = 0,
  ITERATE_KIT_TALK_BUTTON_EFFECT_STOP,
  ITERATE_KIT_TALK_BUTTON_EFFECT_LOCKED,
  ITERATE_KIT_TALK_BUTTON_EFFECT_UNLOCKED,
};

enum { ITERATE_KIT_TALK_BUTTON_MAX_EFFECTS = 2 };

struct iterate_kit_talk_button_result {
  enum iterate_kit_talk_button_effect
      effects[ITERATE_KIT_TALK_BUTTON_MAX_EFFECTS];
  size_t effect_count;
};

enum iterate_kit_talk_button_phase {
  ITERATE_KIT_TALK_BUTTON_IDLE = 0,
  ITERATE_KIT_TALK_BUTTON_FIRST_DOWN,
  ITERATE_KIT_TALK_BUTTON_WAITING_FOR_SECOND_DOWN,
  ITERATE_KIT_TALK_BUTTON_SECOND_DOWN,
  ITERATE_KIT_TALK_BUTTON_LOCKED,
  ITERATE_KIT_TALK_BUTTON_LOCKED_FIRST_DOWN,
  ITERATE_KIT_TALK_BUTTON_LOCKED_WAITING_FOR_SECOND_DOWN,
  ITERATE_KIT_TALK_BUTTON_LOCKED_SECOND_DOWN,
};

/**
 * Allocation-free reducer for momentary and latched push-to-talk.
 *
 * A down edge starts talking immediately. Releasing a press longer than
 * `maximum_tap_ms` stops immediately. A shorter release keeps the same turn
 * open for `second_tap_window_ms`: a second short tap locks it, while timeout
 * stops it. Keeping one turn open across the inter-tap gap avoids manufacturing
 * a tiny committed turn for the first half of a double tap.
 *
 * While locked, one short tap is ignored after the same bounded window and a
 * second short tap stops and unlocks. A long accidental press while locked
 * leaves the lock alone. This asymmetry is deliberate: entering the mode
 * requires an idle button and leaving it must not happen because somebody
 * merely rested a finger on the control.
 *
 * The owner must call update on every poll, not only edges, because timeout is
 * an input. Physical and remotely injected levels may use the same instance;
 * their ordering is then exactly the owner's call order.
 */
struct iterate_kit_talk_button {
  uint64_t pressed_since_ms;
  uint64_t second_tap_deadline_ms;
  uint32_t maximum_tap_ms;
  uint32_t second_tap_window_ms;
  enum iterate_kit_talk_button_phase phase;
  bool sampled_pressed;
  bool initialized;
};

enum iterate_kit_status iterate_kit_talk_button_init(
    struct iterate_kit_talk_button *button,
    uint32_t maximum_tap_ms,
    uint32_t second_tap_window_ms);

enum iterate_kit_status iterate_kit_talk_button_update(
    struct iterate_kit_talk_button *button,
    bool pressed,
    uint64_t now_ms,
    struct iterate_kit_talk_button_result *result);

/** Clears gesture state without emitting capture effects. */
enum iterate_kit_status iterate_kit_talk_button_reset(
    struct iterate_kit_talk_button *button);

bool iterate_kit_talk_button_is_active(
    const struct iterate_kit_talk_button *button);
bool iterate_kit_talk_button_is_locked(
    const struct iterate_kit_talk_button *button);

#ifdef __cplusplus
}
#endif

#endif
