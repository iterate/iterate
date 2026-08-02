#include "havpe_ui.h"

#include <assert.h>
#include <stdbool.h>
#include <stdint.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

static bool is_colour(
    const struct havpe_ui_rgb *pixel,
    uint8_t red,
    uint8_t green,
    uint8_t blue) {
  return pixel->red == red && pixel->green == green && pixel->blue == blue;
}

/*
 * The ring is useful only if each physical sector answers one question without
 * erasing the other two. Pin the index ownership and RSSI bar boundaries so a
 * future aesthetic change cannot silently make network quality look like mic
 * activity—or start using the reserved quarter before it has a meaning.
 */
static void renders_independent_three_pixel_sectors(void) {
  struct havpe_ui_rgb pixels[HAVPE_UI_RING_LED_COUNT];
  const struct havpe_ring_ui_input input = {
    .network = HAVPE_UI_NETWORK_CONNECTED,
    .has_wifi_rssi = true,
    .wifi_rssi_dbm = -66,
    .conversation_active = true,
    .pcm_ready = true,
    .microphone_peak = 5000U,
    .speaker_peak = 1200U,
  };

  havpe_ring_ui_render(&input, pixels);
  assert(pixels[0].green > 0U && pixels[1].green > 0U);
  assert(is_colour(&pixels[2], 0U, 0U, 0U));
  assert(pixels[3].blue > 0U && pixels[4].blue > 0U);
  assert(is_colour(&pixels[5], 0U, 0U, 0U));
  assert(pixels[6].green > 0U && pixels[7].green > 0U &&
         pixels[8].green > 0U);
  for (uint8_t index = 9U; index < HAVPE_UI_RING_LED_COUNT; ++index) {
    assert(is_colour(&pixels[index], 0U, 0U, 0U));
  }
}

/*
 * Silence during a ready call is not idle: XMOS capture remains open for
 * server-side VAD. A dim listening marker must survive while the speaker
 * sector stays dark, otherwise “waiting for speech” is indistinguishable from
 * a dead /pcm lane.
 */
static void distinguishes_listening_silence_from_idle(void) {
  struct havpe_ui_rgb pixels[HAVPE_UI_RING_LED_COUNT];
  struct havpe_ring_ui_input input = {
    .network = HAVPE_UI_NETWORK_CONNECTED,
    .conversation_active = true,
    .pcm_ready = true,
  };

  havpe_ring_ui_render(&input, pixels);
  assert(is_colour(&pixels[3], 0U, 0U, 0U));
  assert(pixels[6].green > 0U);

  input.conversation_active = false;
  havpe_ring_ui_render(&input, pixels);
  for (uint8_t index = 3U; index < 9U; ++index) {
    assert(is_colour(&pixels[index], 0U, 0U, 0U));
  }
}

/* A failed realtime socket must not masquerade as quiet listening. */
static void makes_pcm_failure_unambiguously_red(void) {
  struct havpe_ui_rgb pixels[HAVPE_UI_RING_LED_COUNT];
  const struct havpe_ring_ui_input input = {
    .network = HAVPE_UI_NETWORK_CONNECTED,
    .conversation_active = true,
    .pcm_failed = true,
  };

  havpe_ring_ui_render(&input, pixels);
  for (uint8_t index = 3U; index < 9U; ++index) {
    assert(pixels[index].red > 0U);
    assert(pixels[index].green == 0U && pixels[index].blue == 0U);
  }
}

/*
 * Connection state and radio quality answer different questions on the same
 * three pixels. While Cap'n Web is still mounting, amber must win over a good
 * RSSI: green bars would otherwise claim the device is usable when its RPC
 * surface is absent. Once mounted, the exact bar boundaries make weakening
 * Wi-Fi visible without inventing false precision on a twelve-pixel ring.
 */
static void renders_connection_state_before_rssi_quality(void) {
  struct havpe_ui_rgb pixels[HAVPE_UI_RING_LED_COUNT];
  struct havpe_ring_ui_input input = {
    .network = HAVPE_UI_NETWORK_CONNECTING,
    .has_wifi_rssi = true,
    .wifi_rssi_dbm = -45,
  };

  havpe_ring_ui_render(&input, pixels);
  for (uint8_t index = 0U; index < 3U; ++index) {
    assert(pixels[index].red > 0U && pixels[index].green > 0U);
  }

  input.network = HAVPE_UI_NETWORK_CONNECTED;
  input.wifi_rssi_dbm = -60;
  havpe_ring_ui_render(&input, pixels);
  assert(pixels[0].green > 0U && pixels[1].green > 0U &&
         pixels[2].green > 0U);

  input.wifi_rssi_dbm = -70;
  havpe_ring_ui_render(&input, pixels);
  assert(pixels[0].green > 0U && pixels[1].green > 0U);
  assert(is_colour(&pixels[2], 0U, 0U, 0U));

  input.wifi_rssi_dbm = -80;
  havpe_ring_ui_render(&input, pixels);
  assert(pixels[0].red > 0U);
  assert(is_colour(&pixels[1], 0U, 0U, 0U));
}

/*
 * A reboot gesture is safety-critical and must dominate every ordinary status
 * sector. Whole-ring magenta gives the user one unmistakable chance to cancel
 * by continuing to hold; no stale network or audio pixel may survive it.
 */
static void restart_arm_supersedes_all_status(void) {
  struct havpe_ui_rgb pixels[HAVPE_UI_RING_LED_COUNT];
  const struct havpe_ring_ui_input input = {
    .network = HAVPE_UI_NETWORK_CONNECTED,
    .conversation_active = true,
    .pcm_ready = true,
    .microphone_peak = UINT32_MAX,
    .speaker_peak = UINT32_MAX,
    .restart_armed = true,
  };

  havpe_ring_ui_render(&input, pixels);
  for (uint8_t index = 0U; index < HAVPE_UI_RING_LED_COUNT; ++index) {
    assert(pixels[index].red > 0U && pixels[index].blue > 0U);
    assert(pixels[index].green == 0U);
  }
}

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
  renders_independent_three_pixel_sectors();
  distinguishes_listening_silence_from_idle();
  makes_pcm_failure_unambiguously_red();
  renders_connection_state_before_rssi_quality();
  restart_arm_supersedes_all_status();
  long_press_restarts_only_after_release();
  short_press_toggles_once_on_release();
  suppresses_boot_held_button();
  clock_rollback_restarts_the_hold_interval();
  return 0;
}
