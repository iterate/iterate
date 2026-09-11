#include "iterate/kit/button.h"

enum {
  BUTTON_DEBOUNCE_MS = 30,
};

void iterate_kit_button_update(
    struct iterate_kit_button *button, bool pressed, uint64_t now) {
  if (pressed != button->level_pressed) {
    button->level_pressed = pressed;
    button->changed_at_ms = now;
  }
  if (pressed != button->debounced_pressed &&
      now - button->changed_at_ms >= BUTTON_DEBOUNCE_MS) {
    button->debounced_pressed = pressed;
    if (pressed) {
      button->press_pending = true;
    }
  }
}

void iterate_kit_button_inject_press(struct iterate_kit_button *button) { button->press_pending = true; }

bool iterate_kit_button_take_press(struct iterate_kit_button *button) {
  const bool pressed = button->press_pending;
  button->press_pending = false;
  return pressed;
}
