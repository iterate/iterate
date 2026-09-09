#ifndef ITERATE_KIT_PLATFORMS_LED_RING_H
#define ITERATE_KIT_PLATFORMS_LED_RING_H

#include "iterate/kit/platforms/led_ring_pixels.h"
#include "led_strip.h"

#ifdef __cplusplus
extern "C" {
#endif

/** WS2812 hardware facts. Each logical light repeats pixels/12 times;
 * power_gpio -1 means an always-powered ring, otherwise raise and settle 20 ms.
 */
struct iterate_kit_led_ring {
  int8_t gpio;
  uint8_t pixels;
  led_pixel_format_t order;
  int8_t power_gpio;
};

/** Start the singleton RMT ring (10 MHz, no DMA), after validating pixel count.
 * A power rail must be raised before refresh: RMT success with an unpowered
 * ring is a dark device reporting health. Call once from the app task.
 */
bool iterate_kit_led_ring_start(const struct iterate_kit_led_ring *facts);
/** Render the shared attention animation or a borrowed overlay at <=20 Hz.
 * First paint is mandatory even for black; later identical pixels skip I/O.
 * true means displayed/unchanged; false means throttled or refresh failed and
 * the app must retain its invalidation. now_us is the monotonic app clock.
 */
bool iterate_kit_led_ring_present(
    const struct iterate_kit_conversation_visual_state *state, int64_t now_us);
/** Borrow the twelve logical lights for hold_ms from now, replacing a prior
 * overlay. Positive holds are for dial gestures; zero borrows exactly the
 * next successful presentation (HAVPE's idle quadrant, recalculated by its
 * board). NULL releases the borrow, including a throttled one-shot. Copies
 * pixels, so a stack array is safe. App task only.
 */
void iterate_kit_led_ring_borrow(const struct iterate_kit_rgb8 lights[12], uint32_t hold_ms);

#ifdef __cplusplus
}
#endif
#endif
