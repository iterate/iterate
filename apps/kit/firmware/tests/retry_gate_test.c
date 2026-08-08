#include "iterate/kit/retry_gate.h"

#include <assert.h>
#include <stdint.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

/*
 * When an access point is down, reconnecting every event-loop turn burns CPU
 * needed by audio and can hammer both Wi-Fi and the service. A fixed tight
 * retry interval was rejected in favor of an owner-driven exponential gate
 * that starts responsive, caps during long outages, and resets after recovery.
 * This boundary scenario also proves microsecond deadlines saturate rather than
 * wrapping near INT64_MAX and that an impossible delay range is rejected.
 */
int main(void) {
  struct iterate_kit_retry_gate gate;

  assert(
      iterate_kit_retry_gate_init(&gate, 250U, 1000U) ==
      ITERATE_KIT_OK);
  assert(iterate_kit_retry_gate_ready(&gate, 1000000));

  iterate_kit_retry_gate_defer(&gate, 1000000);
  assert(!iterate_kit_retry_gate_ready(&gate, 1249999));
  assert(iterate_kit_retry_gate_ready(&gate, 1250000));

  iterate_kit_retry_gate_defer(&gate, 1250000);
  assert(!iterate_kit_retry_gate_ready(&gate, 1749999));
  assert(iterate_kit_retry_gate_ready(&gate, 1750000));

  iterate_kit_retry_gate_defer(&gate, 1750000);
  assert(!iterate_kit_retry_gate_ready(&gate, 2749999));
  assert(iterate_kit_retry_gate_ready(&gate, 2750000));

  iterate_kit_retry_gate_defer(&gate, 2750000);
  assert(!iterate_kit_retry_gate_ready(&gate, 3749999));
  assert(iterate_kit_retry_gate_ready(&gate, 3750000));

  iterate_kit_retry_gate_reset(&gate);
  iterate_kit_retry_gate_defer(&gate, 4000000);
  assert(!iterate_kit_retry_gate_ready(&gate, 4249999));
  assert(iterate_kit_retry_gate_ready(&gate, 4250000));

  iterate_kit_retry_gate_defer(&gate, INT64_MAX - 1000);
  assert(!iterate_kit_retry_gate_ready(&gate, INT64_MAX - 1));
  assert(iterate_kit_retry_gate_ready(&gate, INT64_MAX));

  iterate_kit_retry_gate_reset(&gate);
  assert(iterate_kit_retry_gate_ready(&gate, 0));
  assert(
      iterate_kit_retry_gate_init(&gate, 1000U, 999U) ==
      ITERATE_KIT_INVALID_ARGUMENT);
  return 0;
}
