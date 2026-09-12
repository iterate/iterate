#ifndef ITERATE_KIT_BUTTON_H
#define ITERATE_KIT_BUTTON_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Debounced down-edge classifier. Zero-initialize; serialize updates and takes.
 * Supply monotonic milliseconds. It ignores the boot level until a stable
 * release arms the next down edge, so a held GPIO0 cannot start a call.
 */
struct iterate_kit_button {
  bool initialized;
  bool level_pressed;
  bool debounced_pressed;
  bool armed_after_release;
  uint64_t changed_at_ms;
  bool press_pending;
};

/** Sample a level with 30 ms debounce; a stable release arms presses. */
void iterate_kit_button_update(
    struct iterate_kit_button *button, bool pressed, uint64_t now_ms);
/** Consume the debounced down-edge once. */
bool iterate_kit_button_take_press(struct iterate_kit_button *button);
/** Queue one synthetic down edge. */
void iterate_kit_button_inject_press(struct iterate_kit_button *button);

#ifdef __cplusplus
}
#endif

#endif
