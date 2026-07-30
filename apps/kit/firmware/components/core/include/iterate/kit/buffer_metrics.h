#ifndef ITERATE_KIT_BUFFER_METRICS_H
#define ITERATE_KIT_BUFFER_METRICS_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * How much evidence supports a buffer-depth value.
 *
 * Buffer telemetry must not imply precision the platform does not provide.
 * In particular, ESP-IDF exposes our own queues but hides live occupancy in
 * parts of mbedTLS and the Wi-Fi driver.
 *
 * OBSERVED:
 *   current/high-water are exact for storage owned by this process.
 * DERIVED_BOUND:
 *   current/high-water are conservative upper bounds inferred from an ordered
 *   peer acknowledgement; they may exceed the bytes actually still buffered.
 * CAPACITY_ONLY:
 *   configured capacity is known, but live current/high-water are not.
 * UNAVAILABLE:
 *   neither a useful live depth nor a stable capacity is exposed.
 */
enum iterate_kit_buffer_metric_evidence {
  ITERATE_KIT_BUFFER_OBSERVED = 0,
  ITERATE_KIT_BUFFER_DERIVED_BOUND,
  ITERATE_KIT_BUFFER_CAPACITY_ONLY,
  ITERATE_KIT_BUFFER_UNAVAILABLE,
};

/**
 * Logical queued bytes, not necessarily the RAM footprint of the container.
 *
 * For OBSERVED and DERIVED_BOUND, all three byte fields are meaningful. For
 * CAPACITY_ONLY only `capacity_bytes` is meaningful. UNAVAILABLE deliberately
 * leaves every byte field zero; consumers must inspect `evidence` rather than
 * interpreting zero as an empty buffer.
 */
struct iterate_kit_buffer_metrics {
  enum iterate_kit_buffer_metric_evidence evidence;
  uint32_t current_bytes;
  uint32_t high_water_bytes;
  uint32_t capacity_bytes;
};

#ifdef __cplusplus
}
#endif

#endif
