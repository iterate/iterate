#include "iterate/kit/microphone_flush.h"

#include <assert.h>

int main(void) {
  /* The first frame leaves immediately, including after a delayed mount. */
  assert(iterate_kit_microphone_flush_frames(0, true, 0, 9000) == 0);
  assert(iterate_kit_microphone_flush_frames(1, true, 0, 9000) == 1);
  /* A partial live batch has a clock deadline, regardless of capture cadence. */
  assert(iterate_kit_microphone_flush_frames(1, true, 9000, 9049) == 0);
  assert(iterate_kit_microphone_flush_frames(1, true, 9000, 9050) == 1);
  assert(iterate_kit_microphone_flush_frames(2, true, 9000, 9050) == 2);
  /* Release drains a tail immediately; backlog is bounded per append. */
  assert(iterate_kit_microphone_flush_frames(2, false, 9000, 9001) == 2);
  assert(iterate_kit_microphone_flush_frames(250, true, 9000, 9001) == 8);
  /* Reinitializing a clock must not hold a pending batch indefinitely. */
  assert(iterate_kit_microphone_flush_frames(1, true, 9000, 1) == 1);
  return 0;
}
