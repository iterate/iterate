#include "iterate/kit/talk_button.h"

#include <string.h>

static void emit(
    struct iterate_kit_talk_button_result *result,
    enum iterate_kit_talk_button_effect effect) {
  if (result->effect_count < ITERATE_KIT_TALK_BUTTON_MAX_EFFECTS) {
    result->effects[result->effect_count++] = effect;
  }
}

static bool elapsed_at_least(
    uint64_t now_ms, uint64_t since_ms, uint32_t interval_ms) {
  /*
   * A monotonic platform clock should not move backwards, but host fixtures and
   * a wrapped/rebased source can. Treat rollback as no elapsed time rather than
   * letting unsigned subtraction turn it into an immediate gesture.
   */
  return now_ms >= since_ms && now_ms - since_ms >= interval_ms;
}

static bool short_press(
    const struct iterate_kit_talk_button *button, uint64_t now_ms) {
  return now_ms >= button->pressed_since_ms &&
      now_ms - button->pressed_since_ms <= button->maximum_tap_ms;
}

static bool talk_active(enum iterate_kit_talk_button_phase phase) {
  return phase != ITERATE_KIT_TALK_BUTTON_IDLE;
}

static bool talk_locked(enum iterate_kit_talk_button_phase phase) {
  return phase == ITERATE_KIT_TALK_BUTTON_LOCKED ||
      phase == ITERATE_KIT_TALK_BUTTON_LOCKED_FIRST_DOWN ||
      phase == ITERATE_KIT_TALK_BUTTON_LOCKED_WAITING_FOR_SECOND_DOWN ||
      phase == ITERATE_KIT_TALK_BUTTON_LOCKED_SECOND_DOWN;
}

enum iterate_kit_status iterate_kit_talk_button_init(
    struct iterate_kit_talk_button *button,
    uint32_t maximum_tap_ms,
    uint32_t second_tap_window_ms) {
  if (button == NULL || maximum_tap_ms == 0U ||
      second_tap_window_ms == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(button, 0, sizeof(*button));
  button->maximum_tap_ms = maximum_tap_ms;
  button->second_tap_window_ms = second_tap_window_ms;
  button->phase = ITERATE_KIT_TALK_BUTTON_IDLE;
  button->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_talk_button_reset(
    struct iterate_kit_talk_button *button) {
  uint32_t maximum_tap_ms;
  uint32_t second_tap_window_ms;
  if (button == NULL || !button->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  maximum_tap_ms = button->maximum_tap_ms;
  second_tap_window_ms = button->second_tap_window_ms;
  memset(button, 0, sizeof(*button));
  button->maximum_tap_ms = maximum_tap_ms;
  button->second_tap_window_ms = second_tap_window_ms;
  button->phase = ITERATE_KIT_TALK_BUTTON_IDLE;
  button->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_talk_button_update(
    struct iterate_kit_talk_button *button,
    bool pressed,
    uint64_t now_ms,
    struct iterate_kit_talk_button_result *result) {
  bool pressed_edge;
  bool released_edge;
  if (button == NULL || !button->initialized || result == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(result, 0, sizeof(*result));

  pressed_edge = pressed && !button->sampled_pressed;
  released_edge = !pressed && button->sampled_pressed;
  button->sampled_pressed = pressed;

  if (button->phase == ITERATE_KIT_TALK_BUTTON_WAITING_FOR_SECOND_DOWN &&
      elapsed_at_least(
          now_ms,
          button->second_tap_deadline_ms,
          0U)) {
    /*
     * A lone tap was a bounded short turn. Stop it exactly once, then let a
     * simultaneously arriving new down edge begin an ordinary fresh turn.
     */
    button->phase = ITERATE_KIT_TALK_BUTTON_IDLE;
    emit(result, ITERATE_KIT_TALK_BUTTON_EFFECT_STOP);
  } else if (
      button->phase ==
          ITERATE_KIT_TALK_BUTTON_LOCKED_WAITING_FOR_SECOND_DOWN &&
      elapsed_at_least(
          now_ms,
          button->second_tap_deadline_ms,
          0U)) {
    /* A single tap cannot accidentally leave hands-free capture. */
    button->phase = ITERATE_KIT_TALK_BUTTON_LOCKED;
  }

  switch (button->phase) {
    case ITERATE_KIT_TALK_BUTTON_IDLE:
      if (pressed_edge) {
        button->pressed_since_ms = now_ms;
        button->phase = ITERATE_KIT_TALK_BUTTON_FIRST_DOWN;
        emit(result, ITERATE_KIT_TALK_BUTTON_EFFECT_START);
      }
      break;
    case ITERATE_KIT_TALK_BUTTON_FIRST_DOWN:
      if (released_edge) {
        if (short_press(button, now_ms)) {
          button->second_tap_deadline_ms =
              now_ms + button->second_tap_window_ms;
          button->phase =
              ITERATE_KIT_TALK_BUTTON_WAITING_FOR_SECOND_DOWN;
        } else {
          button->phase = ITERATE_KIT_TALK_BUTTON_IDLE;
          emit(result, ITERATE_KIT_TALK_BUTTON_EFFECT_STOP);
        }
      }
      break;
    case ITERATE_KIT_TALK_BUTTON_WAITING_FOR_SECOND_DOWN:
      if (pressed_edge) {
        button->pressed_since_ms = now_ms;
        button->phase = ITERATE_KIT_TALK_BUTTON_SECOND_DOWN;
      }
      break;
    case ITERATE_KIT_TALK_BUTTON_SECOND_DOWN:
      if (released_edge) {
        if (short_press(button, now_ms)) {
          button->phase = ITERATE_KIT_TALK_BUTTON_LOCKED;
          emit(result, ITERATE_KIT_TALK_BUTTON_EFFECT_LOCKED);
        } else {
          button->phase = ITERATE_KIT_TALK_BUTTON_IDLE;
          emit(result, ITERATE_KIT_TALK_BUTTON_EFFECT_STOP);
        }
      }
      break;
    case ITERATE_KIT_TALK_BUTTON_LOCKED:
      if (pressed_edge) {
        button->pressed_since_ms = now_ms;
        button->phase = ITERATE_KIT_TALK_BUTTON_LOCKED_FIRST_DOWN;
      }
      break;
    case ITERATE_KIT_TALK_BUTTON_LOCKED_FIRST_DOWN:
      if (released_edge) {
        if (short_press(button, now_ms)) {
          button->second_tap_deadline_ms =
              now_ms + button->second_tap_window_ms;
          button->phase =
              ITERATE_KIT_TALK_BUTTON_LOCKED_WAITING_FOR_SECOND_DOWN;
        } else {
          button->phase = ITERATE_KIT_TALK_BUTTON_LOCKED;
        }
      }
      break;
    case ITERATE_KIT_TALK_BUTTON_LOCKED_WAITING_FOR_SECOND_DOWN:
      if (pressed_edge) {
        button->pressed_since_ms = now_ms;
        button->phase = ITERATE_KIT_TALK_BUTTON_LOCKED_SECOND_DOWN;
      }
      break;
    case ITERATE_KIT_TALK_BUTTON_LOCKED_SECOND_DOWN:
      if (released_edge) {
        if (short_press(button, now_ms)) {
          button->phase = ITERATE_KIT_TALK_BUTTON_IDLE;
          emit(result, ITERATE_KIT_TALK_BUTTON_EFFECT_STOP);
          emit(result, ITERATE_KIT_TALK_BUTTON_EFFECT_UNLOCKED);
        } else {
          button->phase = ITERATE_KIT_TALK_BUTTON_LOCKED;
        }
      }
      break;
  }
  return ITERATE_KIT_OK;
}

bool iterate_kit_talk_button_is_active(
    const struct iterate_kit_talk_button *button) {
  return button != NULL && button->initialized && talk_active(button->phase);
}

bool iterate_kit_talk_button_is_locked(
    const struct iterate_kit_talk_button *button) {
  return button != NULL && button->initialized && talk_locked(button->phase);
}
