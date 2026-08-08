#include "iterate/kit/retry_gate.h"

#include <limits.h>
#include <stddef.h>

/*
 * Reconnect backoff is represented as a timestamp gate instead of a sleep.
 * The owner loop can therefore continue servicing audio, GPIO events, metrics,
 * and already-live connections while a failed dependency cools down. This
 * utility intentionally adds no random jitter: fleet-level jitter policy needs
 * entropy/device identity and belongs in the outer platform layer.
 */
enum iterate_kit_status iterate_kit_retry_gate_init(
    struct iterate_kit_retry_gate *gate,
    uint32_t initial_delay_ms,
    uint32_t maximum_delay_ms) {
  if (gate == NULL ||
      initial_delay_ms == 0U ||
      maximum_delay_ms < initial_delay_ms) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  gate->ready_at_us = 0;
  gate->initial_delay_ms = initial_delay_ms;
  gate->next_delay_ms = initial_delay_ms;
  gate->maximum_delay_ms = maximum_delay_ms;
  gate->initialized = true;
  return ITERATE_KIT_OK;
}

void iterate_kit_retry_gate_defer(
    struct iterate_kit_retry_gate *gate,
    int64_t now_us) {
  int64_t delay_us;
  uint32_t next_delay_ms;
  if (gate == NULL || !gate->initialized) {
    return;
  }
  delay_us = (int64_t)gate->next_delay_ms * 1000;
  if (now_us > INT64_MAX - delay_us) {
    /*
     * Saturation is safer than wraparound: wrap would turn a clock near its
     * limit into immediate retry and potentially an unbounded failure loop.
     */
    gate->ready_at_us = INT64_MAX;
  } else {
    gate->ready_at_us = now_us + delay_us;
  }
  next_delay_ms = gate->next_delay_ms;
  if (next_delay_ms <
      gate->maximum_delay_ms - next_delay_ms) {
    /*
     * Compare before doubling so uint32_t overflow cannot make severe,
     * repeated failures appear to have a short delay again.
     */
    next_delay_ms *= 2U;
  } else {
    next_delay_ms = gate->maximum_delay_ms;
  }
  gate->next_delay_ms = next_delay_ms;
}

void iterate_kit_retry_gate_reset(
    struct iterate_kit_retry_gate *gate) {
  if (gate != NULL && gate->initialized) {
    gate->ready_at_us = 0;
    gate->next_delay_ms = gate->initial_delay_ms;
  }
}

bool iterate_kit_retry_gate_ready(
    const struct iterate_kit_retry_gate *gate,
    int64_t now_us) {
  return gate != NULL &&
      gate->initialized &&
      now_us >= gate->ready_at_us;
}
