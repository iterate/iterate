#ifndef ITERATE_KIT_CPU_USAGE_H
#define ITERATE_KIT_CPU_USAGE_H

#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Allocation-free CPU utilization meter. The platform supplies one monotonic
 * wall clock and the sum of every CPU core's scheduler idle-time counter in
 * the same units. The meter is single-owner state; neither input is sampled or
 * synchronized by this abstraction.
 *
 * Aggregate capacity is `elapsed * core_count`, so 1000 permille means all
 * cores busy and 500 may mean one of two cores continuously busy. This is a
 * scheduler-level estimate, not task attribution or cycle-accurate profiling.
 */
struct iterate_kit_cpu_usage_meter {
  uint64_t previous_wall_time;
  uint64_t previous_idle_time;
  uint32_t core_count;
  int16_t last_cpu_permille;
  bool has_baseline;
};

enum iterate_kit_status iterate_kit_cpu_usage_meter_init(
    struct iterate_kit_cpu_usage_meter *meter,
    uint32_t core_count);

/**
 * Returns aggregate utilization from 0 to 1000. The first sample establishes
 * a baseline and returns -1. Repeated identical samples return the last stable
 * value without dividing by zero. Regressing clocks, impossible idle totals,
 * and arithmetic overflow are reported and do not advance the baseline.
 */
enum iterate_kit_status iterate_kit_cpu_usage_meter_sample(
    struct iterate_kit_cpu_usage_meter *meter,
    uint64_t wall_time,
    uint64_t aggregate_idle_time,
    int64_t *cpu_permille);

#ifdef __cplusplus
}
#endif

#endif
