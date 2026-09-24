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
 * Colours are shared; pixels are the board's business — each board already
 * has a renderer that knows its own panel.
 *
 * NOT-CONNECTED IS NOT A SUBTLE STATE, AND IT IS NOT A CAPTION EITHER. A
 * device with a twelve-LED ring has no way to render a word, so a caption
 * would say the same thing two different ways, on only some devices. The
 * lights say it everywhere, with the SAME animation: a comet walking the
 * twelve positions. One thing to learn, and every surface can show it.
 *
 * Everything here is pure. No clock is read, no memory is allocated, and the
 * caller passes the time so the animation is reproducible in a host test.
 */

/**
 * Reports whether two snapshots produce the same overlay: the same lights and
 * the same overlay class (failed, connecting, idle, in call, speaking,
 * listening). "Connecting" and "ready" can render twelve identical pixels, so
 * a display that invalidated on light equality alone would hold a stale
 * picture over a device whose state changed. Use this, not
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
 * TRYING. The status rail on the screen devices calls this, so there is
 * exactly one answer to "what does connecting look like" there, and changing
 * it changes every screen at once.
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
