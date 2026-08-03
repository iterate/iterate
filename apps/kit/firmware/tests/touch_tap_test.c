#include "iterate/kit/touch_tap.h"

#include <assert.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

/*
 * A level-polled controller may report the same finger for many cycles. One
 * physical touch must advance one sprite, not race through the catalogue at
 * the display task's 50 Hz input cadence.
 */
static void held_touch_emits_exactly_one_tap_on_release(void) {
  struct iterate_kit_touch_tap tap;
  iterate_kit_touch_tap_init(&tap, false);
  assert(!iterate_kit_touch_tap_update(&tap, true));
  assert(!iterate_kit_touch_tap_update(&tap, true));
  assert(iterate_kit_touch_tap_update(&tap, false));
  assert(!iterate_kit_touch_tap_update(&tap, false));
}

/*
 * The direct-panel task takes ownership after boot. Suppressing an unknown
 * initial contact avoids an unattended sprite change merely because a finger
 * or enclosure edge was present while the controller initialized.
 */
static void boot_contact_only_establishes_a_clean_baseline(void) {
  struct iterate_kit_touch_tap tap;
  iterate_kit_touch_tap_init(&tap, true);
  assert(!iterate_kit_touch_tap_update(&tap, true));
  assert(!iterate_kit_touch_tap_update(&tap, false));
  assert(!iterate_kit_touch_tap_update(&tap, true));
  assert(iterate_kit_touch_tap_update(&tap, false));
}

int main(void) {
  held_touch_emits_exactly_one_tap_on_release();
  boot_contact_only_establishes_a_clean_baseline();
  return 0;
}
