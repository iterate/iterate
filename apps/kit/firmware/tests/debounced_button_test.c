#include "iterate/kit/debounced_button.h"

#include <assert.h>
#include <stdbool.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

/*
 * A conversation button is a state-changing control, so admitting switch
 * bounce as several presses can start, stop, then restart /pcm before the
 * user's finger has left the device. This test encodes the safer invariant:
 * only the latest level held for the complete interval produces one edge.
 * It also covers a button held during boot; boot state is baseline, not an
 * instruction to begin an unattended microphone session.
 */
int main(void) {
  struct iterate_kit_debounced_button button;
  bool pressed;
  bool released;

  assert(
      iterate_kit_debounced_button_init(
          &button, false, 30U, 100U) == ITERATE_KIT_OK);

  assert(
      iterate_kit_debounced_button_update(
          &button, true, 110U, &pressed, &released) == ITERATE_KIT_OK);
  assert(!pressed && !released);
  assert(
      iterate_kit_debounced_button_update(
          &button, false, 120U, &pressed, &released) == ITERATE_KIT_OK);
  assert(!pressed && !released);
  assert(
      iterate_kit_debounced_button_update(
          &button, true, 130U, &pressed, &released) == ITERATE_KIT_OK);
  assert(!pressed && !released);
  assert(
      iterate_kit_debounced_button_update(
          &button, true, 159U, &pressed, &released) == ITERATE_KIT_OK);
  assert(!pressed && !released);
  assert(
      iterate_kit_debounced_button_update(
          &button, true, 160U, &pressed, &released) == ITERATE_KIT_OK);
  assert(pressed && !released);
  assert(
      iterate_kit_debounced_button_update(
          &button, true, 200U, &pressed, &released) == ITERATE_KIT_OK);
  assert(!pressed && !released);

  assert(
      iterate_kit_debounced_button_update(
          &button, false, 210U, &pressed, &released) == ITERATE_KIT_OK);
  assert(!pressed && !released);
  assert(
      iterate_kit_debounced_button_update(
          &button, false, 239U, &pressed, &released) == ITERATE_KIT_OK);
  assert(!pressed && !released);
  assert(
      iterate_kit_debounced_button_update(
          &button, false, 240U, &pressed, &released) == ITERATE_KIT_OK);
  assert(!pressed && released);

  /* A backwards clock rebases the candidate and cannot synthesize an edge. */
  assert(
      iterate_kit_debounced_button_update(
          &button, true, 500U, &pressed, &released) == ITERATE_KIT_OK);
  assert(
      iterate_kit_debounced_button_update(
          &button, true, 10U, &pressed, &released) == ITERATE_KIT_OK);
  assert(!pressed && !released);
  assert(
      iterate_kit_debounced_button_update(
          &button, true, 39U, &pressed, &released) == ITERATE_KIT_OK);
  assert(!pressed && !released);
  assert(
      iterate_kit_debounced_button_update(
          &button, true, 40U, &pressed, &released) == ITERATE_KIT_OK);
  assert(pressed && !released);

  assert(
      iterate_kit_debounced_button_init(
          &button, true, 30U, 0U) == ITERATE_KIT_OK);
  assert(
      iterate_kit_debounced_button_update(
          &button, true, 100U, &pressed, &released) == ITERATE_KIT_OK);
  assert(!pressed && !released);
  assert(
      iterate_kit_debounced_button_init(
          &button, false, 0U, 0U) == ITERATE_KIT_INVALID_ARGUMENT);
  return 0;
}
