#include "iterate/kit/debounced_button.h"

#include <stddef.h>

enum iterate_kit_status iterate_kit_debounced_button_init(
    struct iterate_kit_debounced_button *button,
    bool initially_pressed,
    uint32_t debounce_ms,
    uint64_t now_ms) {
  if (button == NULL || debounce_ms == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  button->candidate_since_ms = now_ms;
  button->debounce_ms = debounce_ms;
  button->candidate_pressed = initially_pressed;
  button->stable_pressed = initially_pressed;
  button->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_debounced_button_update(
    struct iterate_kit_debounced_button *button,
    bool sampled_pressed,
    uint64_t now_ms,
    bool *pressed_edge,
    bool *released_edge) {
  if (button == NULL || !button->initialized || pressed_edge == NULL ||
      released_edge == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  *pressed_edge = false;
  *released_edge = false;

  if (sampled_pressed != button->candidate_pressed) {
    /*
     * Replace the candidate rather than storing every bounce. The requirement
     * is the newest continuously-held intent, not a historical edge stream.
     */
    button->candidate_pressed = sampled_pressed;
    button->candidate_since_ms = now_ms;
    return ITERATE_KIT_OK;
  }
  if (sampled_pressed == button->stable_pressed) {
    return ITERATE_KIT_OK;
  }
  if (now_ms < button->candidate_since_ms) {
    /*
     * A reset test or wrapped platform clock must earn a fresh debounce
     * interval. Unsigned underflow here would otherwise manufacture a press.
     */
    button->candidate_since_ms = now_ms;
    return ITERATE_KIT_OK;
  }
  if (now_ms - button->candidate_since_ms < button->debounce_ms) {
    return ITERATE_KIT_OK;
  }

  button->stable_pressed = sampled_pressed;
  *pressed_edge = sampled_pressed;
  *released_edge = !sampled_pressed;
  return ITERATE_KIT_OK;
}
