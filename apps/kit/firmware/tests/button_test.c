#include "iterate/kit/button.h"

#include <assert.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

static void held_at_boot_requires_release_before_a_press_can_activate(void) {
  struct iterate_kit_button button = {0};
  iterate_kit_button_update(&button, true, 0U);
  iterate_kit_button_update(&button, true, 30U);
  iterate_kit_button_update(&button, true, 900U);
  assert(!iterate_kit_button_take_press(&button));

  iterate_kit_button_update(&button, false, 1000U);
  iterate_kit_button_update(&button, false, 1029U);
  assert(!iterate_kit_button_take_press(&button));
  iterate_kit_button_update(&button, false, 1030U);
  assert(!iterate_kit_button_take_press(&button));

  iterate_kit_button_update(&button, true, 1100U);
  iterate_kit_button_update(&button, true, 1129U);
  assert(!iterate_kit_button_take_press(&button));
  iterate_kit_button_update(&button, true, 1130U);
  assert(iterate_kit_button_take_press(&button));
}

static void released_boot_baseline_then_press_emits_once(void) {
  struct iterate_kit_button button = {0};
  iterate_kit_button_update(&button, false, 0U);
  iterate_kit_button_update(&button, false, 29U);
  assert(!iterate_kit_button_take_press(&button));
  iterate_kit_button_update(&button, false, 30U);

  iterate_kit_button_update(&button, true, 100U);
  iterate_kit_button_update(&button, true, 130U);
  assert(iterate_kit_button_take_press(&button));
  assert(!iterate_kit_button_take_press(&button));
}

static void bounces_do_not_arm_or_emit_until_the_level_is_stable(void) {
  struct iterate_kit_button button = {0};
  iterate_kit_button_update(&button, false, 0U);
  iterate_kit_button_update(&button, false, 30U);

  iterate_kit_button_update(&button, true, 100U);
  iterate_kit_button_update(&button, false, 110U);
  iterate_kit_button_update(&button, true, 120U);
  iterate_kit_button_update(&button, true, 149U);
  assert(!iterate_kit_button_take_press(&button));
  iterate_kit_button_update(&button, true, 150U);
  assert(iterate_kit_button_take_press(&button));

  iterate_kit_button_update(&button, false, 200U);
  iterate_kit_button_update(&button, true, 210U);
  iterate_kit_button_update(&button, false, 220U);
  iterate_kit_button_update(&button, false, 250U);
  assert(!iterate_kit_button_take_press(&button));
}

int main(void) {
  held_at_boot_requires_release_before_a_press_can_activate();
  released_boot_baseline_then_press_emits_once();
  bounces_do_not_arm_or_emit_until_the_level_is_stable();
  /* Synthetic presses share the same consumable edge. */
  struct iterate_kit_button button = {0};
  iterate_kit_button_inject_press(&button);
  assert(iterate_kit_button_take_press(&button));
  return 0;
}
