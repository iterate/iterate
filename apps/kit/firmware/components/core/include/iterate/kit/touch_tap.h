#ifndef ITERATE_KIT_TOUCH_TAP_H
#define ITERATE_KIT_TOUCH_TAP_H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Allocation-free conversion from polled touch levels to one tap event.
 *
 * This deliberately models the whole touch surface as one action. Pixel
 * coordinates belong to rendering, not gesture policy: splitting one small
 * character screen into invisible regions makes the user guess at controls.
 */
struct iterate_kit_touch_tap {
  bool held;
  bool suppress_until_release;
};

/**
 * Initializes a tap detector without manufacturing an event from boot touch.
 *
 * Pass true when the initial controller state is touched or unknown. The
 * first observed release establishes a clean baseline; subsequent presses
 * emit exactly one tap when released.
 */
void iterate_kit_touch_tap_init(
    struct iterate_kit_touch_tap *tap,
    bool initially_touched_or_unknown);

/**
 * Consumes one successful controller sample and returns true once per tap.
 *
 * Do not pass an I2C read failure as `touched=false`: that would turn a bus
 * error into a synthetic release and an unintended UI action. Skip the update
 * on failed samples so the last coherent electrical state remains in force.
 */
bool iterate_kit_touch_tap_update(
    struct iterate_kit_touch_tap *tap, bool touched);

#ifdef __cplusplus
}
#endif

#endif
