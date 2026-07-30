#include "iterate/kit/cpu_usage.h"

#include <limits.h>
#include <string.h>

/*
 * ESP scheduler idle counters are cheaper and less intrusive than sampling
 * every task, which matters while measuring an audio-first system. Treat the
 * sum of per-core idle deltas as unused capacity over a monotonic wall-time
 * interval. The result is an aggregate diagnostic signal, not cycle attribution
 * and not proof that the audio task met its deadlines.
 */
enum iterate_kit_status iterate_kit_cpu_usage_meter_init(
    struct iterate_kit_cpu_usage_meter *meter,
    uint32_t core_count) {
  if (meter == NULL || core_count == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(meter, 0, sizeof(*meter));
  meter->core_count = core_count;
  meter->last_cpu_permille = -1;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_cpu_usage_meter_sample(
    struct iterate_kit_cpu_usage_meter *meter,
    uint64_t wall_time,
    uint64_t aggregate_idle_time,
    int64_t *cpu_permille) {
  uint64_t elapsed;
  uint64_t idle;
  uint64_t capacity;
  uint64_t busy;
  if (meter == NULL ||
      meter->core_count == 0U ||
      cpu_permille == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  *cpu_permille = -1;
  if (!meter->has_baseline) {
    /*
     * A single absolute idle count says nothing about utilization. Publish -1
     * for the first sample rather than inventing load since boot from counters
     * that may have different reset epochs.
     */
    meter->previous_wall_time = wall_time;
    meter->previous_idle_time = aggregate_idle_time;
    meter->has_baseline = true;
    return ITERATE_KIT_OK;
  }
  if (wall_time < meter->previous_wall_time ||
      aggregate_idle_time < meter->previous_idle_time) {
    /*
     * Counter reset/wrap is a sampling-state fault. Do not silently clamp it
     * and, crucially, do not advance the baseline: a later coherent sample can
     * still be diagnosed against the last accepted point.
     */
    return ITERATE_KIT_STATE_ERROR;
  }
  elapsed = wall_time - meter->previous_wall_time;
  idle = aggregate_idle_time - meter->previous_idle_time;
  if (elapsed == 0U) {
    if (idle != 0U) {
      return ITERATE_KIT_STATE_ERROR;
    }
    *cpu_permille = meter->last_cpu_permille;
    /*
     * Multiple subscribers may cause observation without clock advancement.
     * Reusing the stable value avoids divide-by-zero and avoids turning
     * scheduler timing into artificial load spikes.
     */
    return ITERATE_KIT_OK;
  }
  if (elapsed > UINT64_MAX / meter->core_count) {
    /* Reject rather than overflow aggregate multi-core capacity. */
    return ITERATE_KIT_LIMIT;
  }
  capacity = elapsed * meter->core_count;
  if (idle > capacity) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (capacity > UINT64_MAX / 1000U) {
    return ITERATE_KIT_LIMIT;
  }
  busy = capacity - idle;
  meter->last_cpu_permille =
      (int16_t)((busy * 1000U) / capacity);
  meter->previous_wall_time = wall_time;
  meter->previous_idle_time = aggregate_idle_time;
  *cpu_permille = meter->last_cpu_permille;
  return ITERATE_KIT_OK;
}
