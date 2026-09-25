#include "iterate/kit/touch_tap.h"

#include <assert.h>

/*
 * The FT5x06 reports one finger for many 20 ms polls. One physical touch must
 * start one conversation at its first coherent down sample, not open and close
 * the PCM socket throughout the hold or wait for release before first words.
 */
static void held_touch_emits_exactly_one_activation(void) {
  struct iterate_kit_touch_tap tap;
  iterate_kit_touch_tap_init(&tap, false);
  assert(iterate_kit_touch_tap_update(&tap, true, 0U));
  assert(!iterate_kit_touch_tap_update(&tap, true, 20U));
  assert(!iterate_kit_touch_tap_update(&tap, false, 40U));
  assert(!iterate_kit_touch_tap_update(&tap, false, 70U));
  assert(!iterate_kit_touch_tap_update(&tap, false, 90U));
}

/*
 * The direct-panel task takes ownership after boot. Suppressing an unknown
 * initial contact avoids starting a call merely because a finger or enclosure
 * edge was present while the touch controller initialized.
 */
static void boot_contact_only_establishes_a_clean_baseline(void) {
  struct iterate_kit_touch_tap tap;
  iterate_kit_touch_tap_init(&tap, true);
  assert(!iterate_kit_touch_tap_update(&tap, true, 0U));
  assert(!iterate_kit_touch_tap_update(&tap, false, 20U));
  assert(!iterate_kit_touch_tap_update(&tap, false, 50U));
  assert(iterate_kit_touch_tap_update(&tap, true, 60U));
  assert(!iterate_kit_touch_tap_update(&tap, true, 80U));
  assert(!iterate_kit_touch_tap_update(&tap, false, 100U));
}

/*
 * A transient shared-I2C failure must be omitted by the adapter, not converted
 * into `false`. The state machine therefore still emits its one activation
 * only at the first coherent down sample.
 */
static void omitted_samples_do_not_change_touch_state(void) {
  struct iterate_kit_touch_tap tap;
  iterate_kit_touch_tap_init(&tap, false);
  /* No update here models the failed controller read. */
  assert(iterate_kit_touch_tap_update(&tap, true, 0U));
  assert(!iterate_kit_touch_tap_update(&tap, true, 40U));
  assert(!iterate_kit_touch_tap_update(&tap, false, 60U));
}

/* A zero-contact flicker during one finger contact cannot mint a second edge. */
static void contact_bounce_does_not_emit_a_second_activation(void) {
  struct iterate_kit_touch_tap tap;
  iterate_kit_touch_tap_init(&tap, false);
  assert(iterate_kit_touch_tap_update(&tap, true, 0U));
  assert(!iterate_kit_touch_tap_update(&tap, false, 20U));
  assert(!iterate_kit_touch_tap_update(&tap, true, 30U));
  assert(!iterate_kit_touch_tap_update(&tap, false, 40U));
  assert(!iterate_kit_touch_tap_update(&tap, false, 69U));
  assert(!iterate_kit_touch_tap_update(&tap, false, 70U));
  assert(iterate_kit_touch_tap_update(&tap, true, 90U));
}

/* Debounce is elapsed time, not a sample count when I2C polling slips. */
static void an_irregular_sample_interval_still_requires_a_stable_release(void) {
  struct iterate_kit_touch_tap tap;
  iterate_kit_touch_tap_init(&tap, false);
  assert(iterate_kit_touch_tap_update(&tap, true, 100U));
  assert(!iterate_kit_touch_tap_update(&tap, false, 105U));
  assert(!iterate_kit_touch_tap_update(&tap, false, 200U));
  assert(iterate_kit_touch_tap_update(&tap, true, 201U));
}

int main(void) {
  held_touch_emits_exactly_one_activation();
  boot_contact_only_establishes_a_clean_baseline();
  omitted_samples_do_not_change_touch_state();
  contact_bounce_does_not_emit_a_second_activation();
  an_irregular_sample_interval_still_requires_a_stable_release();
  return 0;
}
