#include "iterate/kit/button.h"

#include <assert.h>

int main(void) {
  struct iterate_kit_button button = {0};
  /* A stable down edge is immediate; release is inert. */
  iterate_kit_button_update(&button, true, 0U);
  iterate_kit_button_update(&button, true, 30U);
  assert(iterate_kit_button_take_press(&button));
  iterate_kit_button_update(&button, false, 900U);
  iterate_kit_button_update(&button, false, 930U);
  assert(!iterate_kit_button_take_press(&button));
  /* Synthetic presses share the same consumable edge. */
  iterate_kit_button_inject_press(&button);
  assert(iterate_kit_button_take_press(&button));
  return 0;
}
