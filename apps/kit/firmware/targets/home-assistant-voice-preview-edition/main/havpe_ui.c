#include "havpe_ui.h"

#include <stddef.h>

void havpe_center_button_gesture_init(
    struct havpe_center_button_gesture *gesture,
    bool initially_pressed,
    uint64_t now_ms) {
  if (gesture == NULL) return;
  *gesture = (struct havpe_center_button_gesture){
    .pressed_at_ms = now_ms,
    .held = initially_pressed,
    .restart_armed = false,
    /* A finger present at boot is a baseline, not a remote microphone intent. */
    .suppress_until_release = initially_pressed,
  };
}

enum havpe_center_button_action havpe_center_button_gesture_update(
    struct havpe_center_button_gesture *gesture,
    bool pressed_edge,
    bool released_edge,
    uint64_t now_ms,
    uint32_t restart_hold_ms) {
  if (gesture == NULL || restart_hold_ms == 0U ||
      (pressed_edge && released_edge)) {
    return HAVPE_CENTER_BUTTON_ACTION_NONE;
  }

  if (pressed_edge) {
    gesture->pressed_at_ms = now_ms;
    gesture->held = true;
    gesture->restart_armed = false;
    gesture->suppress_until_release = false;
    return HAVPE_CENTER_BUTTON_ACTION_NONE;
  }

  if (released_edge) {
    if (!gesture->held) return HAVPE_CENTER_BUTTON_ACTION_NONE;
    const bool clock_is_monotonic = now_ms >= gesture->pressed_at_ms;
    const bool held_long_enough =
        clock_is_monotonic &&
        now_ms - gesture->pressed_at_ms >= restart_hold_ms;
    const bool restart = gesture->restart_armed || held_long_enough;
    const bool suppressed = gesture->suppress_until_release;
    gesture->held = false;
    gesture->restart_armed = false;
    gesture->suppress_until_release = false;
    if (suppressed) return HAVPE_CENTER_BUTTON_ACTION_NONE;
    return restart
        ? HAVPE_CENTER_BUTTON_ACTION_RESTART
        : HAVPE_CENTER_BUTTON_ACTION_TOGGLE_CONVERSATION;
  }

  if (!gesture->held || gesture->restart_armed ||
      gesture->suppress_until_release) {
    return HAVPE_CENTER_BUTTON_ACTION_NONE;
  }
  if (now_ms < gesture->pressed_at_ms) {
    /* A test clock rollback must earn the complete hold interval again. */
    gesture->pressed_at_ms = now_ms;
    return HAVPE_CENTER_BUTTON_ACTION_NONE;
  }
  if (now_ms - gesture->pressed_at_ms < restart_hold_ms) {
    return HAVPE_CENTER_BUTTON_ACTION_NONE;
  }
  gesture->restart_armed = true;
  return HAVPE_CENTER_BUTTON_ACTION_RESTART_ARMED;
}
