#include "iterate/kit/face_wake.h"

#include <stddef.h>

bool iterate_kit_face_awake(
    struct iterate_kit_face_wake *wake,
    bool conversation_active,
    uint64_t now_ms) {
  if (wake == NULL) return conversation_active;
  if (conversation_active) {
    wake->last_active_ms = now_ms;
    wake->ever_active = true;
    return true;
  }
  /*
   * Never awake before the first call. Boot is not a conversation, and a
   * device that has been sitting on a shelf since power-on should look like
   * one.
   */
  if (!wake->ever_active) return false;
  /*
   * Unsigned subtraction, so a clock that has gone backwards (it cannot on
   * these boards, but this function has no way to check) expires the tail
   * rather than latching the face awake forever.
   */
  return now_ms - wake->last_active_ms <
      (uint64_t)ITERATE_KIT_FACE_AWAKE_TAIL_MS;
}
