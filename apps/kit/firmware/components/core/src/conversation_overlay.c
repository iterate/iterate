#include "iterate/kit/conversation_overlay.h"

#include <stddef.h>

/* The rail's dot geometry, derived from the frame so a smaller panel still
 * gets twelve lights rather than eight and a clipped one. */
enum {
  RAIL_DOT_MARGIN = 2,
  RAIL_DOT_WIDTH = 5,
  RAIL_DOT_MAX_HEIGHT = 5,
  GLYPH_WIDTH = 5,
  GLYPH_HEIGHT = 5,
  /* Source pixels per glyph pixel inside the banner. */
  GLYPH_SCALE = 2,
  GLYPH_ADVANCE = (GLYPH_WIDTH + 1) * GLYPH_SCALE,
};

/*
 * A 5x5 uppercase alphabet, which is the smallest size at which M, N and W
 * stay distinguishable — the 3x5 rail font this replaces could only manage
 * sixteen hand-picked letters, which is why the old status words were
 * three-character codes nobody could read without the source.
 */
static const uint8_t ALPHABET[26][GLYPH_HEIGHT] = {
    {0x0EU, 0x11U, 0x1FU, 0x11U, 0x11U}, /* A */
    {0x1EU, 0x11U, 0x1EU, 0x11U, 0x1EU}, /* B */
    {0x0FU, 0x10U, 0x10U, 0x10U, 0x0FU}, /* C */
    {0x1EU, 0x11U, 0x11U, 0x11U, 0x1EU}, /* D */
    {0x1FU, 0x10U, 0x1EU, 0x10U, 0x1FU}, /* E */
    {0x1FU, 0x10U, 0x1EU, 0x10U, 0x10U}, /* F */
    {0x0FU, 0x10U, 0x13U, 0x11U, 0x0FU}, /* G */
    {0x11U, 0x11U, 0x1FU, 0x11U, 0x11U}, /* H */
    {0x1FU, 0x04U, 0x04U, 0x04U, 0x1FU}, /* I */
    {0x07U, 0x02U, 0x02U, 0x12U, 0x0CU}, /* J */
    {0x11U, 0x12U, 0x1CU, 0x12U, 0x11U}, /* K */
    {0x10U, 0x10U, 0x10U, 0x10U, 0x1FU}, /* L */
    {0x11U, 0x1BU, 0x15U, 0x11U, 0x11U}, /* M */
    {0x11U, 0x19U, 0x15U, 0x13U, 0x11U}, /* N */
    {0x0EU, 0x11U, 0x11U, 0x11U, 0x0EU}, /* O */
    {0x1EU, 0x11U, 0x1EU, 0x10U, 0x10U}, /* P */
    {0x0EU, 0x11U, 0x15U, 0x12U, 0x0DU}, /* Q */
    {0x1EU, 0x11U, 0x1EU, 0x12U, 0x11U}, /* R */
    {0x0FU, 0x10U, 0x0EU, 0x01U, 0x1EU}, /* S */
    {0x1FU, 0x04U, 0x04U, 0x04U, 0x04U}, /* T */
    {0x11U, 0x11U, 0x11U, 0x11U, 0x0EU}, /* U */
    {0x11U, 0x11U, 0x11U, 0x0AU, 0x04U}, /* V */
    {0x11U, 0x11U, 0x15U, 0x1BU, 0x11U}, /* W */
    {0x11U, 0x0AU, 0x04U, 0x0AU, 0x11U}, /* X */
    {0x11U, 0x0AU, 0x04U, 0x04U, 0x04U}, /* Y */
    {0x1FU, 0x02U, 0x04U, 0x08U, 0x1FU}, /* Z */
};

static uint16_t to_rgb565(struct iterate_kit_rgb8 colour) {
  return (uint16_t)(
      ((uint16_t)(colour.red & 0xF8U) << 8U) |
      ((uint16_t)(colour.green & 0xFCU) << 3U) |
      ((uint16_t)colour.blue >> 3U));
}

static uint8_t scale_channel(uint8_t channel, uint8_t scale) {
  return (uint8_t)(((uint32_t)channel * (uint32_t)scale) / 255U);
}

static void fill_rectangle(
    uint16_t *rgb565,
    uint32_t width,
    uint32_t height,
    uint32_t x,
    uint32_t y,
    uint32_t rectangle_width,
    uint32_t rectangle_height,
    uint16_t colour) {
  if (x >= width || y >= height) return;
  if (rectangle_width > width - x) rectangle_width = width - x;
  if (rectangle_height > height - y) rectangle_height = height - y;
  for (uint32_t row = 0U; row < rectangle_height; ++row) {
    uint16_t *const destination = rgb565 + (y + row) * width + x;
    for (uint32_t column = 0U; column < rectangle_width; ++column) {
      destination[column] = colour;
    }
  }
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
  if (state->network == ITERATE_KIT_NETWORK_DISCONNECTED) return "offline";
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

/* The banner's own colour: red when something is broken or gone, amber while
 * the device is still working on it. Deliberately the same two meanings the
 * network sector of the light renderer already uses. */
static struct iterate_kit_rgb8 attention_colour(
    const struct iterate_kit_conversation_visual_state *state) {
  if (state != NULL && !state->media_failed &&
      state->network != ITERATE_KIT_NETWORK_DISCONNECTED) {
    return (struct iterate_kit_rgb8){255U, 156U, 24U};
  }
  return (struct iterate_kit_rgb8){255U, 64U, 48U};
}

static void draw_word(
    uint16_t *rgb565,
    uint32_t width,
    uint32_t height,
    uint32_t x,
    uint32_t y,
    const char *word,
    uint16_t colour) {
  for (size_t index = 0U; word[index] != '\0'; ++index) {
    const char character = word[index];
    const uint32_t left = x + (uint32_t)index * (uint32_t)GLYPH_ADVANCE;
    if (character == ' ') continue;
    if (character < 'a' || character > 'z') continue;
    {
      const uint8_t *const rows = ALPHABET[(size_t)(character - 'a')];
      for (uint32_t row = 0U; row < (uint32_t)GLYPH_HEIGHT; ++row) {
        for (uint32_t column = 0U; column < (uint32_t)GLYPH_WIDTH; ++column) {
          if ((rows[row] & (uint8_t)(1U << ((uint32_t)GLYPH_WIDTH - 1U - column))) == 0U) {
            continue;
          }
          fill_rectangle(
              rgb565,
              width,
              height,
              left + column * (uint32_t)GLYPH_SCALE,
              y + row * (uint32_t)GLYPH_SCALE,
              (uint32_t)GLYPH_SCALE,
              (uint32_t)GLYPH_SCALE,
              colour);
        }
      }
    }
  }
}

static uint32_t word_width(const char *word) {
  size_t length = 0U;
  while (word[length] != '\0') ++length;
  if (length == 0U) return 0U;
  /* Every glyph but the last carries its trailing gap. */
  return (uint32_t)length * (uint32_t)GLYPH_ADVANCE -
      (uint32_t)GLYPH_SCALE;
}

static void draw_banner(
    const struct iterate_kit_conversation_visual_state *state,
    uint32_t now_ms,
    uint16_t *rgb565,
    uint32_t width,
    uint32_t height) {
  const struct iterate_kit_rgb8 colour = attention_colour(state);
  const uint8_t scale = iterate_kit_conversation_attention_scale(state, now_ms);
  const char *const word = iterate_kit_conversation_status_word(state);
  const uint32_t banner_top = height - (uint32_t)ITERATE_KIT_OVERLAY_BANNER_HEIGHT;
  const struct iterate_kit_rgb8 background = {
    scale_channel(colour.red, scale) / 5U,
    scale_channel(colour.green, scale) / 5U,
    scale_channel(colour.blue, scale) / 5U,
  };
  const struct iterate_kit_rgb8 foreground = {
    scale_channel(colour.red, scale),
    scale_channel(colour.green, scale),
    scale_channel(colour.blue, scale),
  };
  const uint32_t text_width = word_width(word);
  uint32_t text_x = 0U;

  fill_rectangle(
      rgb565,
      width,
      height,
      0U,
      banner_top,
      width,
      (uint32_t)ITERATE_KIT_OVERLAY_BANNER_HEIGHT,
      to_rgb565(background));
  /* A hard bright edge, so the banner reads as a bar and not as a smudge on
   * the bottom of the face. */
  fill_rectangle(
      rgb565, width, height, 0U, banner_top, width, 2U, to_rgb565(foreground));
  if (text_width < width) text_x = (width - text_width) / 2U;
  draw_word(
      rgb565,
      width,
      height,
      text_x,
      banner_top + ((uint32_t)ITERATE_KIT_OVERLAY_BANNER_HEIGHT -
                    (uint32_t)GLYPH_HEIGHT * (uint32_t)GLYPH_SCALE + 2U) /
          2U,
      word,
      to_rgb565(foreground));
}

static void draw_rail(
    const struct iterate_kit_conversation_visual_state *state,
    uint32_t now_ms,
    uint16_t *rgb565,
    uint32_t width,
    uint32_t height) {
  struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT];
  const uint32_t pitch =
      height / (uint32_t)ITERATE_KIT_CONVERSATION_LIGHT_COUNT;
  const uint32_t dot_height = pitch > (uint32_t)RAIL_DOT_MAX_HEIGHT
      ? (uint32_t)RAIL_DOT_MAX_HEIGHT
      : pitch - 1U;
  const uint32_t top = (height -
      pitch * (uint32_t)ITERATE_KIT_CONVERSATION_LIGHT_COUNT + pitch -
      dot_height) / 2U;
  const uint8_t scale = iterate_kit_conversation_attention_scale(state, now_ms);

  iterate_kit_conversation_lights_animate(state, now_ms, pixels);
  for (uint32_t index = 0U;
       index < (uint32_t)ITERATE_KIT_CONVERSATION_LIGHT_COUNT;
       ++index) {
    /*
     * A DARK LIGHT IS STILL A LIGHT. The renderer leaves whole sectors black
     * to mean "nothing here", and twelve positions with three of them lit is
     * only readable if the unlit ones have a visible socket to be unlit in.
     */
    const struct iterate_kit_rgb8 light = pixels[index];
    const bool lit = light.red != 0U || light.green != 0U || light.blue != 0U;
    const struct iterate_kit_rgb8 shown = lit
        ? (struct iterate_kit_rgb8){
              scale_channel(light.red, scale),
              scale_channel(light.green, scale),
              scale_channel(light.blue, scale)}
        : (struct iterate_kit_rgb8){20U, 20U, 24U};
    fill_rectangle(
        rgb565,
        width,
        height,
        (uint32_t)RAIL_DOT_MARGIN,
        top + index * pitch,
        (uint32_t)RAIL_DOT_WIDTH,
        dot_height,
        to_rgb565(shown));
  }
}

void iterate_kit_conversation_overlay_render(
    const struct iterate_kit_conversation_visual_state *state,
    uint32_t now_ms,
    uint16_t *rgb565,
    uint32_t width,
    uint32_t height) {
  if (rgb565 == NULL) return;
  /*
   * Refuse rather than clip. A rail with four of its twelve lights off the
   * bottom edge is not a smaller rail, it is a lie about which sector is
   * which — and the panels this runs on are all comfortably above these
   * bounds, so a frame that fails this test is a wiring mistake worth
   * showing as a missing overlay.
   */
  if (width < (uint32_t)ITERATE_KIT_OVERLAY_RAIL_WIDTH ||
      height < (uint32_t)ITERATE_KIT_CONVERSATION_LIGHT_COUNT * 2U ||
      height < (uint32_t)ITERATE_KIT_OVERLAY_BANNER_HEIGHT) {
    return;
  }
  if (iterate_kit_conversation_needs_attention(state)) {
    draw_banner(state, now_ms, rgb565, width, height);
  }
  draw_rail(state, now_ms, rgb565, width, height);
}
