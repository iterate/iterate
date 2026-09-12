#include "iterate/kit/touch_tap.h"

#include <stddef.h>

enum {
  TOUCH_RELEASE_DEBOUNCE_MS = 30,
};

void iterate_kit_touch_tap_init(
    struct iterate_kit_touch_tap *tap,
    bool initially_touched_or_unknown) {
  if (tap == NULL) return;
  *tap = (struct iterate_kit_touch_tap){
    .held = initially_touched_or_unknown,
  };
}

bool iterate_kit_touch_tap_update(
    struct iterate_kit_touch_tap *tap, bool touched, uint64_t now_ms) {
  if (tap == NULL) return false;
  if (!tap->held) {
    if (!touched) return false;
    tap->held = true;
    return true;
  }
  if (touched) {
    tap->release_pending = false;
    return false;
  }
  if (!tap->release_pending) {
    tap->release_pending = true;
    tap->release_started_at_ms = now_ms;
    return false;
  }
  if (now_ms - tap->release_started_at_ms < TOUCH_RELEASE_DEBOUNCE_MS) {
    return false;
  }
  tap->held = false;
  tap->release_pending = false;
  return false;
}
