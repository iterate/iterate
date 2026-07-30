#ifndef ITERATE_KIT_RETRY_GATE_H
#define ITERATE_KIT_RETRY_GATE_H

#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Cooperative exponential-backoff gate for a single owner task.
 *
 * The gate never sleeps, allocates, retries, or adds jitter; an outer event
 * loop asks `ready()` before attempting work. Keeping delay policy separate
 * prevents reconnect code from blocking unrelated audio or capability work.
 * Times are monotonic microseconds; delays are configured in milliseconds.
 */
struct iterate_kit_retry_gate {
  int64_t ready_at_us;
  uint32_t initial_delay_ms;
  uint32_t next_delay_ms;
  uint32_t maximum_delay_ms;
  bool initialized;
};

enum iterate_kit_status iterate_kit_retry_gate_init(
    struct iterate_kit_retry_gate *gate,
    uint32_t initial_delay_ms,
    uint32_t maximum_delay_ms);

/**
 * Schedules the next attempt and doubles the following delay, saturating at
 * `maximum_delay_ms`. Call once per failed attempt; repeated calls without an
 * attempt deliberately advance the backoff again.
 */
void iterate_kit_retry_gate_defer(
    struct iterate_kit_retry_gate *gate,
    int64_t now_us);

/** Restores immediate readiness after a genuinely healthy connection. */
void iterate_kit_retry_gate_reset(
    struct iterate_kit_retry_gate *gate);

/** Pure, non-blocking readiness check; false also represents invalid state. */
bool iterate_kit_retry_gate_ready(
    const struct iterate_kit_retry_gate *gate,
    int64_t now_us);

#ifdef __cplusplus
}
#endif

#endif
