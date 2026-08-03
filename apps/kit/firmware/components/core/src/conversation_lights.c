#include "iterate/kit/conversation_lights.h"

#include <stddef.h>
#include <string.h>

enum {
  NETWORK_SECTOR_START = 0,
  SPEAKER_SECTOR_START = 3,
  MICROPHONE_SECTOR_START = 6,
};

static void fill_sector(
    struct iterate_kit_rgb8
        pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT],
    uint8_t start,
    uint8_t count,
    struct iterate_kit_rgb8 colour) {
  for (uint8_t offset = 0U;
       offset < ITERATE_KIT_CONVERSATION_LIGHT_SECTOR_COUNT;
       ++offset) {
    pixels[start + offset] = offset < count
        ? colour
        : (struct iterate_kit_rgb8){0U, 0U, 0U};
  }
}

/*
 * Three coarse logarithmic bands match the three-pixel physical display. More
 * precision would spend realtime-owner work and imply information the output
 * cannot show. The floor rejects codec noise while ordinary speech still
 * advances the first pixel. Callers pass an already-computed peak so this
 * renderer never scans PCM or competes with an audio deadline.
 */
static uint8_t pcm_peak_level(uint32_t peak) {
  if (peak >= 4096U) return 3U;
  if (peak >= 1024U) return 2U;
  if (peak >= 256U) return 1U;
  return 0U;
}

static void render_network(
    const struct iterate_kit_conversation_visual_state *state,
    struct iterate_kit_rgb8
        pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT]) {
  if (state->network == ITERATE_KIT_NETWORK_DISCONNECTED) {
    fill_sector(
        pixels,
        NETWORK_SECTOR_START,
        3U,
        (struct iterate_kit_rgb8){32U, 0U, 0U});
    return;
  }
  if (state->network == ITERATE_KIT_NETWORK_CONNECTING) {
    fill_sector(
        pixels,
        NETWORK_SECTOR_START,
        3U,
        (struct iterate_kit_rgb8){30U, 10U, 0U});
    return;
  }

  uint8_t bars = 1U;
  struct iterate_kit_rgb8 colour = {28U, 2U, 0U};
  if (!state->has_wifi_rssi || state->wifi_rssi_dbm >= -60) {
    bars = 3U;
    colour = (struct iterate_kit_rgb8){0U, 30U, 2U};
  } else if (state->wifi_rssi_dbm >= -70) {
    bars = 2U;
    colour = (struct iterate_kit_rgb8){8U, 28U, 0U};
  } else if (state->wifi_rssi_dbm >= -80) {
    colour = (struct iterate_kit_rgb8){30U, 10U, 0U};
  }
  fill_sector(pixels, NETWORK_SECTOR_START, bars, colour);
}

static void render_audio(
    const struct iterate_kit_conversation_visual_state *state,
    struct iterate_kit_rgb8
        pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT]) {
  if (!state->conversation_active) return;

  if (state->media_failed) {
    fill_sector(
        pixels,
        SPEAKER_SECTOR_START,
        3U,
        (struct iterate_kit_rgb8){42U, 0U, 0U});
    fill_sector(
        pixels,
        MICROPHONE_SECTOR_START,
        3U,
        (struct iterate_kit_rgb8){42U, 0U, 0U});
    return;
  }
  if (!state->media_ready) {
    fill_sector(
        pixels,
        SPEAKER_SECTOR_START,
        3U,
        (struct iterate_kit_rgb8){24U, 7U, 0U});
    fill_sector(
        pixels,
        MICROPHONE_SECTOR_START,
        3U,
        (struct iterate_kit_rgb8){24U, 7U, 0U});
    return;
  }

  const uint8_t speaker_level = pcm_peak_level(state->speaker_peak);
  const uint8_t microphone_level = pcm_peak_level(state->microphone_peak);
  fill_sector(
      pixels,
      SPEAKER_SECTOR_START,
      speaker_level,
      (struct iterate_kit_rgb8){0U, 10U, 52U});
  /*
   * One dim microphone pixel means “capture is listening”, not “sound was
   * measured”. Speech replaces that baseline with a 1–3 pixel meter. This is
   * what lets silence remain distinguishable from an idle or dead /pcm lane.
   */
  if (state->microphone_listening) {
    fill_sector(
        pixels,
        MICROPHONE_SECTOR_START,
        microphone_level == 0U ? 1U : microphone_level,
        microphone_level == 0U
            ? (struct iterate_kit_rgb8){0U, 5U, 3U}
            : (struct iterate_kit_rgb8){0U, 45U, 12U});
  }
}

void iterate_kit_conversation_lights_render(
    const struct iterate_kit_conversation_visual_state *state,
    struct iterate_kit_rgb8
        pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT]) {
  if (pixels == NULL) return;
  memset(
      pixels,
      0,
      sizeof(*pixels) * ITERATE_KIT_CONVERSATION_LIGHT_COUNT);
  if (state == NULL) return;

  if (state->restart_armed) {
    /* Whole-output magenta intentionally supersedes the sector grammar. */
    for (uint8_t index = 0U;
         index < ITERATE_KIT_CONVERSATION_LIGHT_COUNT;
         ++index) {
      pixels[index] = (struct iterate_kit_rgb8){36U, 0U, 28U};
    }
    return;
  }

  render_network(state, pixels);
  render_audio(state, pixels);
}
