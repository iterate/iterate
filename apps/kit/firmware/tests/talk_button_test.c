#include "iterate/kit/talk_button.h"

#include <assert.h>

enum {
  MAXIMUM_TAP_MS = 220,
  SECOND_TAP_WINDOW_MS = 320,
};

static struct iterate_kit_talk_button_result update(
    struct iterate_kit_talk_button *button, bool pressed, uint64_t now_ms) {
  struct iterate_kit_talk_button_result result;
  assert(
      iterate_kit_talk_button_update(button, pressed, now_ms, &result) ==
      ITERATE_KIT_OK);
  return result;
}

static void assert_effect(
    struct iterate_kit_talk_button_result result,
    enum iterate_kit_talk_button_effect effect) {
  assert(result.effect_count == 1U);
  assert(result.effects[0] == effect);
}

/*
 * The normal path must react on the down edge, not after a hold threshold: the
 * beginning of "hey" is speech, not disposable gesture-recognition latency.
 * A human-length release stops in the same sample and never enters lock mode.
 */
static void hold_is_immediate_momentary_talk(void) {
  struct iterate_kit_talk_button button;
  assert(
      iterate_kit_talk_button_init(
          &button, MAXIMUM_TAP_MS, SECOND_TAP_WINDOW_MS) == ITERATE_KIT_OK);

  assert_effect(update(&button, true, 100U), ITERATE_KIT_TALK_BUTTON_EFFECT_START);
  assert(update(&button, true, 500U).effect_count == 0U);
  assert_effect(update(&button, false, 501U), ITERATE_KIT_TALK_BUTTON_EFFECT_STOP);
  assert(!iterate_kit_talk_button_is_active(&button));
  assert(!iterate_kit_talk_button_is_locked(&button));
}

/*
 * A double tap is one continuous turn. Stopping on the first release would
 * commit a tiny empty utterance and start a second turn after the mode cue;
 * retaining the start across the gap makes the gesture itself side-effect free.
 */
static void double_tap_locks_one_continuous_turn(void) {
  struct iterate_kit_talk_button button;
  assert(
      iterate_kit_talk_button_init(
          &button, MAXIMUM_TAP_MS, SECOND_TAP_WINDOW_MS) == ITERATE_KIT_OK);

  assert_effect(update(&button, true, 0U), ITERATE_KIT_TALK_BUTTON_EFFECT_START);
  assert(update(&button, false, 80U).effect_count == 0U);
  assert(update(&button, false, 300U).effect_count == 0U);
  assert(update(&button, true, 350U).effect_count == 0U);
  assert_effect(update(&button, false, 420U), ITERATE_KIT_TALK_BUTTON_EFFECT_LOCKED);
  assert(iterate_kit_talk_button_is_active(&button));
  assert(iterate_kit_talk_button_is_locked(&button));
}

/*
 * A short accidental tap cannot leave the microphone active forever. The
 * inter-tap wait is bounded, emits exactly one STOP, and does not replay it on
 * later polls.
 */
static void lone_tap_stops_at_the_bounded_deadline(void) {
  struct iterate_kit_talk_button button;
  assert(
      iterate_kit_talk_button_init(
          &button, MAXIMUM_TAP_MS, SECOND_TAP_WINDOW_MS) == ITERATE_KIT_OK);

  assert_effect(update(&button, true, 0U), ITERATE_KIT_TALK_BUTTON_EFFECT_START);
  assert(update(&button, false, 70U).effect_count == 0U);
  assert(update(&button, false, 389U).effect_count == 0U);
  assert_effect(update(&button, false, 390U), ITERATE_KIT_TALK_BUTTON_EFFECT_STOP);
  assert(update(&button, false, 900U).effect_count == 0U);
  assert(!iterate_kit_talk_button_is_active(&button));
}

/*
 * Leaving hands-free mode is deliberately a double tap too. One tap, or a
 * long press that might simply be a resting finger, keeps capture locked; only
 * the second short release emits ordered STOP then UNLOCKED effects.
 */
static void locked_mode_requires_a_double_tap_to_leave(void) {
  struct iterate_kit_talk_button button;
  struct iterate_kit_talk_button_result result;
  assert(
      iterate_kit_talk_button_init(
          &button, MAXIMUM_TAP_MS, SECOND_TAP_WINDOW_MS) == ITERATE_KIT_OK);
  (void)update(&button, true, 0U);
  (void)update(&button, false, 50U);
  (void)update(&button, true, 100U);
  (void)update(&button, false, 150U);
  assert(iterate_kit_talk_button_is_locked(&button));

  assert(update(&button, true, 1000U).effect_count == 0U);
  assert(update(&button, false, 1400U).effect_count == 0U);
  assert(iterate_kit_talk_button_is_locked(&button));

  assert(update(&button, true, 2000U).effect_count == 0U);
  assert(update(&button, false, 2050U).effect_count == 0U);
  assert(update(&button, true, 2100U).effect_count == 0U);
  result = update(&button, false, 2150U);
  assert(result.effect_count == 2U);
  assert(result.effects[0] == ITERATE_KIT_TALK_BUTTON_EFFECT_STOP);
  assert(result.effects[1] == ITERATE_KIT_TALK_BUTTON_EFFECT_UNLOCKED);
  assert(!iterate_kit_talk_button_is_active(&button));
  assert(!iterate_kit_talk_button_is_locked(&button));
}

int main(void) {
  hold_is_immediate_momentary_talk();
  double_tap_locks_one_continuous_turn();
  lone_tap_stops_at_the_bounded_deadline();
  locked_mode_requires_a_double_tap_to_leave();
  return 0;
}
