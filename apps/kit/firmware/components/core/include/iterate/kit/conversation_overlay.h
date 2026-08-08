#ifndef ITERATE_KIT_CONVERSATION_OVERLAY_H
#define ITERATE_KIT_CONVERSATION_OVERLAY_H

#include "iterate/kit/conversation_lights.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * ONE STATUS LANGUAGE FOR EVERY SURFACE THIS PRODUCT HAS.
 *
 * A twelve-LED ring, a 320x240 face, a 240x135 face and an AMOLED panel all
 * have to answer the same question — "is this thing connected, and is it
 * listening?" — and they were each answering it differently: the ring glowed
 * one undifferentiated colour, one screen wrote three cryptic characters over
 * the avatar's eye, and one drew the face on top of a text screen it never
 * cleared. A person with two of these devices on a desk could not read either
 * one by the same rules.
 *
 * So the twelve logical lights of `conversation_lights.h` ARE the language.
 * On the ring they are twelve LEDs. On a screen they are the same twelve dots
 * in a rail down the left margin, in the same order, with the same colours.
 * Learn it once.
 *
 * The rail lives in the left margin because that margin is empty in every
 * compiled avatar — measured, not assumed: the narrowest is 18 free columns,
 * and this rail is 8 wide. It therefore never covers a face.
 *
 * NOT-CONNECTED IS NOT A SUBTLE STATE, AND IT IS NOT A CAPTION EITHER. It was
 * a word across the bottom of the face for a while — legible, and wrong: a
 * device with a twelve-LED ring has no way to render a word, so the fleet was
 * saying the same thing two different ways and only three of the four could
 * say it at all. The lights say it now, everywhere, with the SAME animation:
 * a comet walking the twelve positions. One thing to learn, and every surface
 * can show it.
 *
 * Everything here is pure. No clock is read, no memory is allocated, and the
 * caller passes the time so the animation is reproducible in a host test.
 */

enum {
  /** Source columns the always-on rail occupies at the left edge. */
  ITERATE_KIT_OVERLAY_RAIL_WIDTH = 8,
  /** The banner's breathing period, in milliseconds. */
  ITERATE_KIT_OVERLAY_PULSE_PERIOD_MS = 1400,
  /** Source rows a horizontal light strip occupies below the face. */
  ITERATE_KIT_OVERLAY_STRIP_HEIGHT = 14,
};

/**
 * Names the state in the fewest words a person still understands.
 *
 * Lower case because two of the three screens render it beside prose; the
 * pixel renderer here upper-cases it, since its 5x5 alphabet has no
 * descenders. Never returns NULL: every state has something to say.
 */
const char *iterate_kit_conversation_status_word(
    const struct iterate_kit_conversation_visual_state *state);

/**
 * Reports whether this state is one the person has to be told about.
 *
 * True means "this device cannot hold a conversation right now" — offline,
 * still connecting, or with broken audio. It is what raises the banner, and
 * adapters without a screen may use it to decide that dim is not good enough.
 */
bool iterate_kit_conversation_needs_attention(
    const struct iterate_kit_conversation_visual_state *state);

/**
 * The breathing brightness, 0-255, for a surface that needs attention.
 *
 * A steady 255 whenever the device is ready, so a working device never
 * flickers. Otherwise a triangular breath, floored well above black: an LED
 * that reaches zero reads as a device that has died rather than one that is
 * trying. Adapters multiply their colours by this.
 */
uint8_t iterate_kit_conversation_attention_scale(
    const struct iterate_kit_conversation_visual_state *state,
    uint32_t now_ms);

/**
 * Reports whether two snapshots produce the same overlay.
 *
 * The lights alone are not enough to decide this. "Connecting" and "ready"
 * can render twelve identical pixels while the banner says entirely
 * different things, so a display that invalidated on light equality would
 * hold a stale CONNECTING bar over a device that was ready. Use this, not
 * `iterate_kit_conversation_lights_equal`, wherever a screen is involved.
 */
bool iterate_kit_conversation_overlay_equal(
    const struct iterate_kit_conversation_visual_state *left,
    const struct iterate_kit_conversation_visual_state *right);

/**
 * THE ONE PLACE DEVICE STATE BECOMES LIGHTS.
 *
 * `conversation_lights_render` gives the twelve static colours; this adds the
 * only thing a still picture cannot say, which is that the device is BUSY
 * TRYING. Every surface calls this — the HA Voice PE's physical ring and the
 * status rail on all three screens — so there is exactly one answer to "what
 * does connecting look like", and changing it changes every device at once.
 *
 * While the device is ready, this is `conversation_lights_render` and nothing
 * more: a working device does not move.
 *
 * While it is not, one lit pixel walks around all twelve positions, about
 * three quarters of a lap a second. A chase reads as "working on it" from
 * across a room in a way that a colour cannot — three static amber dots were
 * read as a fault, and one dim blue one was read as "still connecting" when
 * it meant the call was live. Motion says trying; stillness says settled.
 */
void iterate_kit_conversation_lights_animate(
    const struct iterate_kit_conversation_visual_state *state,
    uint32_t now_ms,
    struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT]);

/**
 * Where a screen puts the twelve lights, if it puts them anywhere.
 *
 * NOT EVERY SCREEN SHOULD DRAW THEM. The StackChan has a real twelve-pixel LED
 * run on its body, already fed from this same snapshot — painting a second
 * copy down the side of its face was a picture of its own LEDs, which is
 * clutter, not information. A board with real lights renders NONE.
 */
enum iterate_kit_overlay_lights {
  ITERATE_KIT_OVERLAY_LIGHTS_NONE = 0,
  /** A vertical rail in the left margin, for a face with no LEDs beside it. */
  ITERATE_KIT_OVERLAY_LIGHTS_RAIL,
  /**
   * A horizontal strip across the bottom, for a panel with room below the
   * face. The caller makes its frame taller than the face by
   * ITERATE_KIT_OVERLAY_STRIP_HEIGHT and the strip lands in those rows, so
   * the lights scale with the face and are drawn by the same code as
   * everywhere else — rather than by whatever widget toolkit that board
   * happens to use.
   */
  ITERATE_KIT_OVERLAY_LIGHTS_STRIP,
};

/**
 * The twelve lights as a SCREEN should show them.
 *
 * `conversation_lights` is tuned for exposed WS2812s, where 30 of 255 is
 * plainly lit. Behind glass, next to a backlit face, the same numbers read as
 * muddy — so a screen brightens them and gives an unlit light a visible
 * socket. The meaning is untouched: same sectors, same colours, same comet.
 */
void iterate_kit_conversation_lights_for_screen(
    const struct iterate_kit_conversation_visual_state *state,
    uint32_t now_ms,
    struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT]);

/**
 * Draws the lights in the requested layout, and the banner when one is
 * needed, into an RGB565 frame.
 *
 * The frame is the caller's — typically a rendered avatar — and is modified
 * in place; only the left rail and, when raised, the bottom banner are
 * touched. Frames too small for the rail are left entirely alone rather than
 * given a clipped, meaningless fragment of it.
 */
void iterate_kit_conversation_overlay_render(
    const struct iterate_kit_conversation_visual_state *state,
    uint32_t now_ms,
    enum iterate_kit_overlay_lights lights,
    uint16_t *rgb565,
    uint32_t width,
    uint32_t height);

#ifdef __cplusplus
}
#endif

#endif
