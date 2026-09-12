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
/** Render the shared physical-ring animation at <=20 Hz. First paint is
 * mandatory even for black; later identical pixels skip I/O. true means
 * displayed or unchanged; false means throttled or refresh failed. */
bool iterate_kit_led_ring_present(
    const struct iterate_kit_conversation_visual_state *state, int64_t now_us);
/** Overlay a dim white volume bar, or one red light at zero, for hold_ms.
 * Muted, failed, and restart-armed visual states outrank this overlay. */
void iterate_kit_led_ring_show_volume(uint8_t percent, uint32_t hold_ms);

#ifdef __cplusplus
}
#endif
#endif
