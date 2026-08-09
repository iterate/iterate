#include "iterate/kit/conversation_overlay.h"

#include <stddef.h>

static uint8_t scale_channel(uint8_t channel, uint8_t scale) {
  return (uint8_t)(((uint32_t)channel * (uint32_t)scale) / 255U);
}

const char *iterate_kit_conversation_status_word(
    const struct iterate_kit_conversation_visual_state *state) {
  if (state == NULL) return "starting";
  /*
   * Order matters and mirrors the light renderer's: a broken speaker while
   * the network is fine is still a device that cannot hold a conversation,
   * and hiding that behind a cheerful "ready" is how a dead board looked
   * healthy until somebody tried to talk to it.
   */
  if (state->media_failed) return "audio fault";
  if (state->network == ITERATE_KIT_NETWORK_CONNECTING) return "connecting";
  if (!state->media_ready) return "connecting";
  if (!state->conversation_active) return "ready";
  if (state->speaker_peak >= 256U) return "speaking";
  if (state->microphone_listening) return "listening";
  return "in call";
}

bool iterate_kit_conversation_needs_attention(
    const struct iterate_kit_conversation_visual_state *state) {
  if (state == NULL) return true;
  return state->media_failed ||
      state->network != ITERATE_KIT_NETWORK_CONNECTED || !state->media_ready;
}

bool iterate_kit_conversation_overlay_equal(
    const struct iterate_kit_conversation_visual_state *left,
    const struct iterate_kit_conversation_visual_state *right) {
  /*
   * Pointer comparison on the words is exact, not a shortcut: every branch of
   * the selector returns one of a fixed set of string literals, so two states
   * that say the same thing return the identical pointer.
   */
  return iterate_kit_conversation_status_word(left) ==
      iterate_kit_conversation_status_word(right) &&
      iterate_kit_conversation_lights_equal(left, right);
}

uint8_t iterate_kit_conversation_attention_scale(
    const struct iterate_kit_conversation_visual_state *state,
    uint32_t now_ms) {
  enum { FLOOR = 70U, CEILING = 255U, SPAN = CEILING - FLOOR };
  if (!iterate_kit_conversation_needs_attention(state)) return 255U;
  {
    const uint32_t phase = now_ms % (uint32_t)ITERATE_KIT_OVERLAY_PULSE_PERIOD_MS;
    const uint32_t half = (uint32_t)ITERATE_KIT_OVERLAY_PULSE_PERIOD_MS / 2U;
    /* Triangular rather than sinusoidal: no floating point, no table, and at
     * this period the difference is not visible on an LED. */
    const uint32_t rising = phase < half ? phase : (uint32_t)ITERATE_KIT_OVERLAY_PULSE_PERIOD_MS - phase;
    return (uint8_t)(FLOOR + (rising * (uint32_t)SPAN) / half);
  }
}

enum {
  /* One lap of the twelve positions, in milliseconds. */
  CONNECTING_CHASE_PERIOD_MS = 1400,
};

static struct iterate_kit_rgb8 attention_colour(
    const struct iterate_kit_conversation_visual_state *state);

void iterate_kit_conversation_lights_animate(
    const struct iterate_kit_conversation_visual_state *state,
    uint32_t now_ms,
    struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT]) {
  iterate_kit_conversation_lights_render(state, pixels);
  if (!iterate_kit_conversation_needs_attention(state)) return;
  {
    /*
     * The chase overwrites the whole ring rather than decorating a sector,
     * because "not connected" is not a detail about the network sector — it
     * is the only thing about this device worth saying, and the sectors it
     * would otherwise show are all meaningless until it is fixed.
     */
    const struct iterate_kit_rgb8 colour = attention_colour(state);
    const uint32_t position =
        ((now_ms % (uint32_t)CONNECTING_CHASE_PERIOD_MS) *
         (uint32_t)ITERATE_KIT_CONVERSATION_LIGHT_COUNT) /
        (uint32_t)CONNECTING_CHASE_PERIOD_MS;
    for (uint32_t index = 0U;
         index < (uint32_t)ITERATE_KIT_CONVERSATION_LIGHT_COUNT;
         ++index) {
      /* The head is full brightness, the one behind it a quarter: a comet,
       * so the DIRECTION reads too and a stalled chase is obvious. */
      const uint32_t behind =
          (index + (uint32_t)ITERATE_KIT_CONVERSATION_LIGHT_COUNT - position) %
          (uint32_t)ITERATE_KIT_CONVERSATION_LIGHT_COUNT;
      const uint8_t level = behind == 0U ? 255U : (behind == 1U ? 64U : 0U);
      pixels[index].red = scale_channel(colour.red, level);
      pixels[index].green = scale_channel(colour.green, level);
      pixels[index].blue = scale_channel(colour.blue, level);
    }
  }
}

/* Red when something is broken, amber while the device is still working on
 * it. Deliberately the same two meanings the network sector of the light
 * renderer already uses. */
static struct iterate_kit_rgb8 attention_colour(
    const struct iterate_kit_conversation_visual_state *state) {
  if (state != NULL && !state->media_failed) {
    return (struct iterate_kit_rgb8){255U, 156U, 24U};
  }
  return (struct iterate_kit_rgb8){255U, 64U, 48U};
}

void iterate_kit_conversation_lights_for_screen(
    const struct iterate_kit_conversation_visual_state *state,
    uint32_t now_ms,
    struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT]) {
  enum { SCREEN_GAIN_PERCENT = 260 };
  iterate_kit_conversation_lights_animate(state, now_ms, pixels);
  for (uint32_t index = 0U;
       index < (uint32_t)ITERATE_KIT_CONVERSATION_LIGHT_COUNT;
       ++index) {
    struct iterate_kit_rgb8 *const light = &pixels[index];
    if (light->red == 0U && light->green == 0U && light->blue == 0U) {
      /* The socket: an unlit light must still hold its place. */
      *light = (struct iterate_kit_rgb8){28U, 28U, 34U};
      continue;
    }
    {
      const uint32_t red = ((uint32_t)light->red * SCREEN_GAIN_PERCENT) / 100U;
      const uint32_t green =
          ((uint32_t)light->green * SCREEN_GAIN_PERCENT) / 100U;
      const uint32_t blue = ((uint32_t)light->blue * SCREEN_GAIN_PERCENT) / 100U;
      light->red = (uint8_t)(red > 255U ? 255U : red);
      light->green = (uint8_t)(green > 255U ? 255U : green);
      light->blue = (uint8_t)(blue > 255U ? 255U : blue);
    }
  }
}
