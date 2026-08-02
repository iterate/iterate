#include "havpe_ui.h"

#include <stddef.h>
#include <string.h>

enum {
  NETWORK_SECTOR_START = 0,
  SPEAKER_SECTOR_START = 3,
  MICROPHONE_SECTOR_START = 6,
};

static void fill_sector(
    struct havpe_ui_rgb pixels[HAVPE_UI_RING_LED_COUNT],
    uint8_t start,
    uint8_t count,
    struct havpe_ui_rgb colour) {
  for (uint8_t offset = 0U;
       offset < HAVPE_UI_RING_SECTOR_LED_COUNT;
       ++offset) {
    pixels[start + offset] = offset < count
        ? colour
        : (struct havpe_ui_rgb){0U, 0U, 0U};
  }
}

/*
 * Three coarse logarithmic bands are enough for a three-pixel meter. Scanning
 * or smoothing more precisely would spend realtime-owner cycles on visual
 * precision the hardware cannot display. The low threshold rejects codec
 * floor noise while ordinary speech still advances the first pixel.
 */
static uint8_t pcm_peak_level(uint32_t peak) {
  if (peak >= 4096U) return 3U;
  if (peak >= 1024U) return 2U;
  if (peak >= 256U) return 1U;
  return 0U;
}

static void render_network(
    const struct havpe_ring_ui_input *input,
    struct havpe_ui_rgb pixels[HAVPE_UI_RING_LED_COUNT]) {
  if (input->network == HAVPE_UI_NETWORK_DISCONNECTED) {
    fill_sector(
        pixels,
        NETWORK_SECTOR_START,
        3U,
        (struct havpe_ui_rgb){32U, 0U, 0U});
    return;
  }
  if (input->network == HAVPE_UI_NETWORK_CONNECTING) {
    fill_sector(
        pixels,
        NETWORK_SECTOR_START,
        3U,
        (struct havpe_ui_rgb){30U, 10U, 0U});
    return;
  }

  uint8_t bars = 1U;
  struct havpe_ui_rgb colour = {28U, 2U, 0U};
  if (!input->has_wifi_rssi || input->wifi_rssi_dbm >= -60) {
    bars = 3U;
    colour = (struct havpe_ui_rgb){0U, 30U, 2U};
  } else if (input->wifi_rssi_dbm >= -70) {
    bars = 2U;
    colour = (struct havpe_ui_rgb){8U, 28U, 0U};
  } else if (input->wifi_rssi_dbm >= -80) {
    colour = (struct havpe_ui_rgb){30U, 10U, 0U};
  }
  fill_sector(pixels, NETWORK_SECTOR_START, bars, colour);
}

static void render_audio(
    const struct havpe_ring_ui_input *input,
    struct havpe_ui_rgb pixels[HAVPE_UI_RING_LED_COUNT]) {
  if (!input->conversation_active) return;

  if (input->pcm_failed) {
    fill_sector(
        pixels,
        SPEAKER_SECTOR_START,
        3U,
        (struct havpe_ui_rgb){42U, 0U, 0U});
    fill_sector(
        pixels,
        MICROPHONE_SECTOR_START,
        3U,
        (struct havpe_ui_rgb){42U, 0U, 0U});
    return;
  }
  if (!input->pcm_ready) {
    fill_sector(
        pixels,
        SPEAKER_SECTOR_START,
        3U,
        (struct havpe_ui_rgb){24U, 7U, 0U});
    fill_sector(
        pixels,
        MICROPHONE_SECTOR_START,
        3U,
        (struct havpe_ui_rgb){24U, 7U, 0U});
    return;
  }

  const uint8_t speaker_level = pcm_peak_level(input->speaker_peak);
  const uint8_t microphone_level = pcm_peak_level(input->microphone_peak);
  fill_sector(
      pixels,
      SPEAKER_SECTOR_START,
      speaker_level,
      (struct havpe_ui_rgb){0U, 10U, 52U});
  /*
   * One dim microphone pixel means “the clean capture gate is listening”, not
   * “sound was measured”. Speech replaces that baseline with a 1–3 pixel
   * meter. This makes silence distinguishable from an idle/disconnected call.
   */
  fill_sector(
      pixels,
      MICROPHONE_SECTOR_START,
      microphone_level == 0U ? 1U : microphone_level,
      microphone_level == 0U
          ? (struct havpe_ui_rgb){0U, 5U, 3U}
          : (struct havpe_ui_rgb){0U, 45U, 12U});
}

void havpe_ring_ui_render(
    const struct havpe_ring_ui_input *input,
    struct havpe_ui_rgb pixels[HAVPE_UI_RING_LED_COUNT]) {
  if (pixels == NULL) return;
  memset(pixels, 0, sizeof(*pixels) * HAVPE_UI_RING_LED_COUNT);
  if (input == NULL) return;

  if (input->restart_armed) {
    /* Whole-ring magenta is intentionally outside the three-sector grammar. */
    for (uint8_t index = 0U; index < HAVPE_UI_RING_LED_COUNT; ++index) {
      pixels[index] = (struct havpe_ui_rgb){36U, 0U, 28U};
    }
    return;
  }

  render_network(input, pixels);
  render_audio(input, pixels);
}

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
