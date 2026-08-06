#include "iterate/kit/barge_in.h"

#include <stddef.h>

void iterate_kit_barge_in_observe(
    struct iterate_kit_barge_in *gate, uint32_t peak, uint64_t now_ms) {
  if (gate == NULL) return;
  if (peak >= (uint32_t)ITERATE_KIT_BARGE_IN_FLOOR) {
    gate->loud_at_ms = now_ms;
    gate->ever_loud = true;
  }
}

void iterate_kit_barge_in_forget(struct iterate_kit_barge_in *gate) {
  if (gate == NULL) return;
  gate->ever_loud = false;
  gate->loud_at_ms = 0U;
}

bool iterate_kit_barge_in_person_present(
    const struct iterate_kit_barge_in *gate, uint64_t now_ms) {
  if (gate == NULL) return true;
  /* Never heard anything loud at all: no evidence anybody is here. */
  if (!gate->ever_loud) return false;
  {
    /*
     * Unsigned subtraction with the future treated as "just now", the same
     * rule the supervision deadlines use: a stamp taken one millisecond ahead
     * of this reading must not underflow into a gate that never opens again.
     */
    const uint64_t since =
        gate->loud_at_ms > now_ms ? 0U : now_ms - gate->loud_at_ms;
    return since <= (uint64_t)ITERATE_KIT_BARGE_IN_WINDOW_MS;
  }
}

bool iterate_kit_barge_in_admit(
    struct iterate_kit_barge_in *gate, uint64_t now_ms) {
  if (gate == NULL) return true;
  if (!iterate_kit_barge_in_person_present(gate, now_ms)) {
    ++gate->rejected;
    return false;
  }
  ++gate->admitted;
  return true;
}
