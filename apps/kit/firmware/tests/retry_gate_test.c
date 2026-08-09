#include "iterate/kit/retry_gate.h"

#include "iterate/kit/voice_device_profile.h"

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
/*
 * THE VOICELAB REMOUNT BACKOFF, WITH THE DEVICE'S OWN BUDGET.
 *
 * All four boards ran this gate and none of them ever reset it, so the delay
 * only ever grew: five transient failures walked it to the 30s ceiling and
 * left it there for the rest of the boot, and a board that had been healthy
 * for an hour still took thirty seconds to notice the next failed mount. The
 * constants are read from voice_device_profile.h — the same table the devices
 * initialise the gate from — so a change to the budget moves this test with
 * it instead of leaving a stale number behind.
 */
static void remounting_recovers_its_responsiveness(void) {
  const int64_t initial_us =
      (int64_t)ITERATE_KIT_VOICE_REMOUNT_RETRY_MS * 1000;
  const int64_t maximum_us =
      (int64_t)ITERATE_KIT_VOICE_REMOUNT_RETRY_MAX_MS * 1000;
  struct iterate_kit_retry_gate gate;
  int64_t now_us = 0;
  int attempt;

  assert(
      iterate_kit_retry_gate_init(
          &gate,
          (uint32_t)ITERATE_KIT_VOICE_REMOUNT_RETRY_MS,
          (uint32_t)ITERATE_KIT_VOICE_REMOUNT_RETRY_MAX_MS) ==
      ITERATE_KIT_OK);

  /* A board that has just come up may remount at once. */
  assert(iterate_kit_retry_gate_ready(&gate, now_us));

  /* Five failures is what a single access-point blip can produce, and it is
   * exactly what used to pin the board at the ceiling. */
  for (attempt = 0; attempt < 5; ++attempt) {
    iterate_kit_retry_gate_defer(&gate, now_us);
    now_us += maximum_us;
  }
  iterate_kit_retry_gate_defer(&gate, now_us);
  assert(!iterate_kit_retry_gate_ready(&gate, now_us + maximum_us - 1));
  assert(iterate_kit_retry_gate_ready(&gate, now_us + maximum_us));

  /*
   * THE FIX. A mount that reached READY is the evidence the gate waits for,
   * so the next failure is owed a prompt attempt — not the ceiling the old
   * faults earned.
   */
  iterate_kit_retry_gate_reset(&gate);
  assert(iterate_kit_retry_gate_ready(&gate, now_us));
  iterate_kit_retry_gate_defer(&gate, now_us);
  assert(!iterate_kit_retry_gate_ready(&gate, now_us + initial_us - 1));
  assert(iterate_kit_retry_gate_ready(&gate, now_us + initial_us));
}

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
  remounting_recovers_its_responsiveness();
  return 0;
}
