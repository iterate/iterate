#include "havpe_ui.h"

#include <assert.h>
#include <stdint.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

/*
 * GPIO0 is a boot strap, so the long-hold action must be armed while held but
 * emitted only after release. This test is the regression barrier against a
 * seemingly faster `esp_restart()` that instead boots the ROM downloader.
 */
static void long_press_restarts_only_after_release(void) {
  struct havpe_center_button_gesture gesture;
  havpe_center_button_gesture_init(&gesture, false, 0U);
  assert(
      havpe_center_button_gesture_update(
          &gesture, true, false, 100U, 3000U) ==
      HAVPE_CENTER_BUTTON_ACTION_NONE);
  assert(
      havpe_center_button_gesture_update(
          &gesture, false, false, 3099U, 3000U) ==
      HAVPE_CENTER_BUTTON_ACTION_NONE);
  assert(
      havpe_center_button_gesture_update(
          &gesture, false, false, 3100U, 3000U) ==
      HAVPE_CENTER_BUTTON_ACTION_RESTART_ARMED);
  assert(gesture.restart_armed);
  assert(
      havpe_center_button_gesture_update(
          &gesture, false, false, 5000U, 3000U) ==
      HAVPE_CENTER_BUTTON_ACTION_NONE);
  assert(
      havpe_center_button_gesture_update(
          &gesture, false, true, 5010U, 3000U) ==
      HAVPE_CENTER_BUTTON_ACTION_RESTART);
}

/*
 * Moving ordinary toggles to release is intentional: a press cannot both open
 * a microphone session and later become a reboot. It costs only the duration
 * of a human tap and makes the two gestures mutually exclusive.
 */
static void short_press_toggles_once_on_release(void) {
  struct havpe_center_button_gesture gesture;
  havpe_center_button_gesture_init(&gesture, false, 0U);
  assert(
      havpe_center_button_gesture_update(
          &gesture, true, false, 100U, 3000U) ==
      HAVPE_CENTER_BUTTON_ACTION_NONE);
  assert(
      havpe_center_button_gesture_update(
          &gesture, false, true, 180U, 3000U) ==
      HAVPE_CENTER_BUTTON_ACTION_TOGGLE_CONVERSATION);
  assert(
      havpe_center_button_gesture_update(
          &gesture, false, false, 200U, 3000U) ==
      HAVPE_CENTER_BUTTON_ACTION_NONE);
}

/* A button held across boot is baseline and must do nothing until released. */
static void suppresses_boot_held_button(void) {
  struct havpe_center_button_gesture gesture;
  havpe_center_button_gesture_init(&gesture, true, 10U);
  assert(
      havpe_center_button_gesture_update(
          &gesture, false, false, 10000U, 3000U) ==
      HAVPE_CENTER_BUTTON_ACTION_NONE);
  assert(
      havpe_center_button_gesture_update(
          &gesture, false, true, 10010U, 3000U) ==
      HAVPE_CENTER_BUTTON_ACTION_NONE);
}

/*
 * Production uses a monotonic ESP timer, but the pure gesture model is also a
 * host-test seam. A synthetic clock rollback must restart the complete hold
 * interval; carrying elapsed time across it could turn a short tap into a
 * reboot in a simulator or alternate platform.
 */
static void clock_rollback_restarts_the_hold_interval(void) {
  struct havpe_center_button_gesture gesture;
  havpe_center_button_gesture_init(&gesture, false, 0U);
  assert(
      havpe_center_button_gesture_update(
          &gesture, true, false, 5000U, 3000U) ==
      HAVPE_CENTER_BUTTON_ACTION_NONE);
  assert(
      havpe_center_button_gesture_update(
          &gesture, false, false, 1000U, 3000U) ==
      HAVPE_CENTER_BUTTON_ACTION_NONE);
  assert(
      havpe_center_button_gesture_update(
          &gesture, false, false, 3999U, 3000U) ==
      HAVPE_CENTER_BUTTON_ACTION_NONE);
  assert(
      havpe_center_button_gesture_update(
          &gesture, false, false, 4000U, 3000U) ==
      HAVPE_CENTER_BUTTON_ACTION_RESTART_ARMED);
}

int main(void) {
  long_press_restarts_only_after_release();
  short_press_toggles_once_on_release();
  suppresses_boot_held_button();
  clock_rollback_restarts_the_hold_interval();
  return 0;
}
