#ifndef ITERATE_KIT_PLATFORMS_LED_RING_PIXELS_H
#define ITERATE_KIT_PLATFORMS_LED_RING_PIXELS_H

#include "iterate/kit/conversation_lights.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Repeat each of twelve logical lights into pixels/12 adjacent LEDs.
 * pixels must be a positive multiple of twelve, and out must hold that many
 * RGB values. Invalid arguments return false without touching out.
 */
bool iterate_kit_led_ring_repeat(
    const struct iterate_kit_rgb8 lights[12], uint8_t pixels,
    struct iterate_kit_rgb8 *out);
/** Render twelve logical volume lights, clamping percent to 100: a rounded
 * dim white bar (16,16,16) over dim unlit white (1,1,1), or one red (16,0,0)
 * light at zero. The caller supplies all twelve output pixels; the repeat
 * helper maps them to hardware. */
void iterate_kit_led_ring_render_volume(
    uint8_t percent, struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT]);
/** Paint once before comparing: a black-initialized cache does not establish
 * that hardware was ever cleared. Afterwards equal logical pixels are clean.
 */
bool iterate_kit_led_ring_dirty(
    bool painted, const struct iterate_kit_rgb8 shown[12],
    const struct iterate_kit_rgb8 next[12]);

#ifdef __cplusplus
}
#endif
#endif
