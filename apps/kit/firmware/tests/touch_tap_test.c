#include "iterate/kit/touch_tap.h"

#include <assert.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

/*
 * The FT5x06 reports one finger for many 20 ms polls. One physical touch must
 * start one conversation at its first coherent down sample, not open and close
 * the PCM socket throughout the hold or wait for release before first words.
 */
static void held_touch_emits_exactly_one_activation_on_press(void) {
  struct iterate_kit_touch_tap tap;
  iterate_kit_touch_tap_init(&tap, false);
  assert(iterate_kit_touch_tap_update(&tap, true));
  assert(!iterate_kit_touch_tap_update(&tap, true));
  assert(!iterate_kit_touch_tap_update(&tap, false));
  assert(!iterate_kit_touch_tap_update(&tap, false));
}

/*
 * The direct-panel task takes ownership after boot. Suppressing an unknown
 * initial contact avoids starting a call merely because a finger or enclosure
 * edge was present while the touch controller initialized.
 */
static void boot_contact_only_establishes_a_clean_baseline(void) {
  struct iterate_kit_touch_tap tap;
  iterate_kit_touch_tap_init(&tap, true);
  assert(!iterate_kit_touch_tap_update(&tap, true));
  assert(!iterate_kit_touch_tap_update(&tap, false));
  assert(iterate_kit_touch_tap_update(&tap, true));
  assert(!iterate_kit_touch_tap_update(&tap, true));
  assert(!iterate_kit_touch_tap_update(&tap, false));
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
  assert(iterate_kit_touch_tap_update(&tap, true));
  assert(!iterate_kit_touch_tap_update(&tap, true));
  assert(!iterate_kit_touch_tap_update(&tap, false));
}

int main(void) {
  held_touch_emits_exactly_one_activation_on_press();
  boot_contact_only_establishes_a_clean_baseline();
  omitted_samples_do_not_change_touch_state();
  return 0;
}
