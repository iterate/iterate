#include "iterate/kit/touch_tap.h"

#include <stddef.h>

void iterate_kit_touch_tap_init(
    struct iterate_kit_touch_tap *tap,
    bool initially_touched_or_unknown) {
  if (tap == NULL) return;
  *tap = (struct iterate_kit_touch_tap){
    .held = initially_touched_or_unknown,
    .suppress_until_release = initially_touched_or_unknown,
  };
}

bool iterate_kit_touch_tap_update(
    struct iterate_kit_touch_tap *tap, bool touched) {
  if (tap == NULL) return false;
  if (tap->suppress_until_release) {
    if (!touched) {
      tap->held = false;
      tap->suppress_until_release = false;
    }
    return false;
  }
  if (touched) {
    tap->held = true;
    return false;
  }
  if (!tap->held) return false;
  tap->held = false;
  return true;
}
