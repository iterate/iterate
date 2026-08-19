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
 * On the ring they are twelve LEDs. On a screen they are the same twelve
 * colours, in the same order, painted by that board's own renderer through
 * `iterate_kit_conversation_lights_for_screen`. Learn it once.
 *
 * This module once painted them itself, as a rail down a frame's left margin
 * or a strip below the face. Every board turned it off — each already had a
 * renderer that knew its own panel — so all three callers passed LIGHTS_NONE
 * and the RGB565 blitter here drew nothing at all. Colours are shared; pixels
 * are the board's business.
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
  /** The banner's breathing period, in milliseconds. */
  ITERATE_KIT_OVERLAY_PULSE_PERIOD_MS = 1400,
};


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

#ifdef __cplusplus
}
#endif

#endif
