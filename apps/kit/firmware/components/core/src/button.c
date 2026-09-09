#include "iterate/kit/button.h"

enum {
  BUTTON_DEBOUNCE_MS = 30,
  /* Shorter is a tap (call toggle); longer is push-to-talk. */
  BUTTON_TAP_THRESHOLD_MS = 250,
  /* The deliberate hang-up: long enough that no press meaning "talk" or
   * "wake" wanders across it, short enough to answer a person who means it. */
  BUTTON_END_HOLD_MS = 800,
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
      button->pressed_since_ms = now;
      button->talk_latched = false;
    } else if (!button->talk_latched) {
      /* Released before the threshold: a completed tap. */
      button->tap_pending = true;
    } else {
      button->talk_latched = false;
    }
  }
  if (button->debounced_pressed && !button->talk_latched &&
      now - button->pressed_since_ms >= BUTTON_TAP_THRESHOLD_MS) {
    button->talk_latched = true;
  }
  if (button->debounced_pressed && !button->end_hold_latched &&
      now - button->pressed_since_ms >= BUTTON_END_HOLD_MS) {
    button->end_hold_latched = true;
    button->end_hold_pending = true;
  }
  if (!button->debounced_pressed) button->end_hold_latched = false;
}

void iterate_kit_button_inject_tap(struct iterate_kit_button *button) { button->tap_pending = true; }

bool iterate_kit_button_take_end_hold(struct iterate_kit_button *button) {
  const bool held = button->end_hold_pending;
  button->end_hold_pending = false;
  return held;
}

bool iterate_kit_button_held(const struct iterate_kit_button *button) {
  return button->talk_latched && button->debounced_pressed;
}

bool iterate_kit_button_take_tap(struct iterate_kit_button *button) {
  const bool tapped = button->tap_pending;
  button->tap_pending = false;
  return tapped;
}

bool iterate_kit_button_take_press(struct iterate_kit_button *button) {
  const bool pressed = button->press_pending;
  button->press_pending = false;
  return pressed;
}
