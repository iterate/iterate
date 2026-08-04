#ifndef ITERATE_KIT_WAVESHARE_TOUCH_H
#define ITERATE_KIT_WAVESHARE_TOUCH_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * The panel's FT3168, polled by us and never by LVGL.
 *
 * esp_lvgl_port would happily own this controller, and must not: the FT3168
 * sleeps between touches and NACKs every register read while it does, and that
 * port polls it with an INFINITE I2C timeout while holding the bus lock — on the
 * bus the codec, the PMIC and the lower button share. Measured, that is a
 * multi-second stall landing on whatever else needs I2C, which is how a boot
 * that should take five seconds took twenty. So touch is read here, at the app
 * loop's human cadence, in one bounded transaction.
 *
 * ONE TAP MEANS ONE THING, ANYWHERE ON THE GLASS. No coordinates: the decision
 * is the shared `iterate_kit_touch_tap`, which models the whole surface as a
 * single action, because splitting a screen with no drawn controls into
 * invisible regions makes a person guess.
 */

/** Bring up the touch controller. False leaves taps unavailable, not fatal. */
bool waveshare_touch_init(void);

/** Poll the controller; call from the app loop beside the buttons. */
void waveshare_touch_poll(void);

/**
 * One completed tap, taken on release and consumed here.
 *
 * On release rather than on contact, so a finger resting on the glass while the
 * device is picked up is one tap and not a stream of them.
 */
bool waveshare_touch_take_tap(void);

/**
 * Controller reads that failed.
 *
 * Worth publishing because a failed read is deliberately NOT treated as a
 * release — feeding a bus error into the edge detector would turn it into a
 * synthetic tap, and a call nobody asked for. This counter is the only
 * difference between "nobody is touching it" and "we cannot tell".
 */
uint32_t waveshare_touch_read_failures(void);

#ifdef __cplusplus
}
#endif

#endif /* ITERATE_KIT_WAVESHARE_TOUCH_H */
