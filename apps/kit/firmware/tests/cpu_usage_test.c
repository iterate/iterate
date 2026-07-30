#include "iterate/kit/cpu_usage.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static void test_assert(
    bool condition,
    const char *expression,
    const char *file,
    int line) {
  if (condition) {
    return;
  }
  fprintf(stderr, "%s:%d: assertion failed: %s\n", file, line, expression);
  abort();
}

#define assert(expression) \
  test_assert((expression), #expression, __FILE__, __LINE__)

/*
 * FreeRTOS exposes cumulative idle time per core, while the public metric is
 * whole-device utilisation. Summing idle capacity over two cores avoids
 * reporting one fully busy core as 100% of a dual-core device. Pin idle,
 * saturated-busy, and intermediate cases so dashboards remain comparable when
 * task affinity changes.
 */
static void dual_core_idle_time_becomes_total_cpu_permille(void) {
  struct iterate_kit_cpu_usage_meter meter;
  int64_t cpu_permille = 123;

  assert(
      iterate_kit_cpu_usage_meter_init(&meter, 2U) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_cpu_usage_meter_sample(
          &meter, 1000U, 1500U, &cpu_permille) ==
      ITERATE_KIT_OK);
  assert(cpu_permille == -1);

  assert(
      iterate_kit_cpu_usage_meter_sample(
          &meter, 2000U, 3000U, &cpu_permille) ==
      ITERATE_KIT_OK);
  assert(cpu_permille == 250);

  assert(
      iterate_kit_cpu_usage_meter_sample(
          &meter, 3000U, 5000U, &cpu_permille) ==
      ITERATE_KIT_OK);
  assert(cpu_permille == 0);

  assert(
      iterate_kit_cpu_usage_meter_sample(
          &meter, 4000U, 5000U, &cpu_permille) ==
      ITERATE_KIT_OK);
  assert(cpu_permille == 1000);
}

/*
 * Two diagnostics reads can land in the same scheduler tick. Dividing a
 * zero-duration interval is impossible, but emitting “unknown” or 100% would
 * create a false spike every time sampling jitter aligns with that boundary.
 * Reuse the last completed interval until new elapsed time exists; the initial
 * sample remains explicitly unavailable because it has no prior baseline.
 */
static void repeated_samples_reuse_the_last_stable_value(void) {
  struct iterate_kit_cpu_usage_meter meter;
  int64_t cpu_permille;

  assert(
      iterate_kit_cpu_usage_meter_init(&meter, 1U) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_cpu_usage_meter_sample(
          &meter, 1000U, 900U, &cpu_permille) ==
      ITERATE_KIT_OK);
  assert(cpu_permille == -1);
  assert(
      iterate_kit_cpu_usage_meter_sample(
          &meter, 2000U, 1700U, &cpu_permille) ==
      ITERATE_KIT_OK);
  assert(cpu_permille == 200);
  assert(
      iterate_kit_cpu_usage_meter_sample(
          &meter, 2000U, 1700U, &cpu_permille) ==
      ITERATE_KIT_OK);
  assert(cpu_permille == 200);
}

/*
 * Idle time increasing faster than wall time times core count means the
 * scheduler counters reset, wrapped, or came from mismatched snapshots. A
 * tempting clamp to 0% CPU would hide that instrumentation defect as excellent
 * performance. Classify it and clear the output instead so endurance telemetry
 * never launders an impossible observation.
 */
static void impossible_scheduler_counters_are_explicit_errors(void) {
  struct iterate_kit_cpu_usage_meter meter;
  int64_t cpu_permille;

  assert(
      iterate_kit_cpu_usage_meter_init(&meter, 2U) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_cpu_usage_meter_sample(
          &meter, 1000U, 1000U, &cpu_permille) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_cpu_usage_meter_sample(
          &meter, 2000U, 3001U, &cpu_permille) ==
      ITERATE_KIT_STATE_ERROR);
  assert(cpu_permille == -1);
}

int main(void) {
  dual_core_idle_time_becomes_total_cpu_permille();
  repeated_samples_reuse_the_last_stable_value();
  impossible_scheduler_counters_are_explicit_errors();
  return 0;
}
