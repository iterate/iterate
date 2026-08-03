#ifndef ITERATE_KIT_HAVPE_UI_H
#define ITERATE_KIT_HAVPE_UI_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum havpe_center_button_action {
  HAVPE_CENTER_BUTTON_ACTION_NONE = 0,
  HAVPE_CENTER_BUTTON_ACTION_TOGGLE_CONVERSATION,
  HAVPE_CENTER_BUTTON_ACTION_RESTART_ARMED,
  HAVPE_CENTER_BUTTON_ACTION_RESTART,
};

/**
 * Gesture state layered after electrical debounce.
 *
 * A short press toggles a call on release. A long press first becomes visibly
 * armed, then requests reboot only after release. HAVPE's center button is
 * GPIO0, an ESP32-S3 boot strap: restarting while it is still held low can
 * enter the ROM downloader instead of the application. Keeping this policy in
 * a clock-driven model makes that hardware safety property host-testable.
 */
struct havpe_center_button_gesture {
  uint64_t pressed_at_ms;
  bool held;
  bool restart_armed;
  bool suppress_until_release;
};

void havpe_center_button_gesture_init(
    struct havpe_center_button_gesture *gesture,
    bool initially_pressed,
    uint64_t now_ms);

enum havpe_center_button_action havpe_center_button_gesture_update(
    struct havpe_center_button_gesture *gesture,
    bool pressed_edge,
    bool released_edge,
    uint64_t now_ms,
    uint32_t restart_hold_ms);

#ifdef __cplusplus
}
#endif

#endif
