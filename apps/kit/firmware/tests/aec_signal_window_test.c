#include "iterate/kit/aec_signal_window.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static void test_assert(
    bool condition,
    const char *expression,
    const char *file,
    int line) {
  if (condition) return;
  fprintf(stderr, "%s:%d: assertion failed: %s\n", file, line, expression);
  abort();
}

#define assert(expression) \
  test_assert((expression), #expression, __FILE__, __LINE__)

/*
 * AEC acceptance compares the three signals at identical instants. Sampling
 * each array with a separately advancing cursor would create convincing but
 * physically meaningless suppression ratios. Include INT16_MIN because a
 * narrow negation would overflow and under-report the largest legal sample.
 */
static void aligned_stride_preserves_exact_integer_signal_evidence(void) {
  const int16_t near[] = {INT16_MIN, 111, -400, 222, 800, 333};
  const int16_t reference[] = {-1000, 1, 2000, 2, -3000, 3};
  const int16_t clean[] = {400, 9, -200, 8, 100, 7};
  struct iterate_kit_aec_signal_window window;
  struct iterate_kit_aec_signal_summary summary;

  assert(
      iterate_kit_aec_signal_window_measure(
          near, reference, clean, 6U, 2U, &window) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_aec_signal_window_summarize(
          &window, 2U, &summary) == ITERATE_KIT_OK);
  assert(summary.sample_stride == 2U);
  assert(summary.sampled_samples == 3U);
  assert(summary.near_peak == 32768U);
  assert(summary.reference_peak == 3000U);
  assert(summary.clean_peak == 400U);
  assert(summary.near_mean_absolute == (32768U + 400U + 800U) / 3U);
  assert(summary.reference_mean_absolute == 2000U);
  assert(summary.clean_mean_absolute == 233U);
}

/*
 * The audio task measures outside its platform lock and merges only seven
 * scalars inside it. The diagnostics task then takes and clears that aggregate
 * once. Prove the portable primitive cannot retain an old prompt into the next
 * interval—the exact failure that lifetime peaks caused in the physical rig.
 */
static void merged_window_is_destroyed_after_one_interval_take(void) {
  const int16_t samples[] = {100, -200, 300, -400};
  struct iterate_kit_aec_signal_window first;
  struct iterate_kit_aec_signal_window aggregate = {0};
  struct iterate_kit_aec_signal_window taken;
  struct iterate_kit_aec_signal_window empty;

  assert(
      iterate_kit_aec_signal_window_measure(
          samples, samples, samples, 4U, 1U, &first) ==
      ITERATE_KIT_OK);
  iterate_kit_aec_signal_window_merge(&aggregate, &first);
  iterate_kit_aec_signal_window_merge(&aggregate, &first);
  iterate_kit_aec_signal_window_take(&aggregate, &taken);
  assert(taken.sampled_samples == 8U);
  assert(taken.near_absolute_sum == 2000U);
  assert(taken.near_peak == 400U);

  iterate_kit_aec_signal_window_take(&aggregate, &empty);
  assert(empty.sampled_samples == 0U);
  assert(empty.near_absolute_sum == 0U);
  assert(empty.near_peak == 0U);
}

/* Zero stride would hang the realtime sample walker; reject it explicitly. */
static void zero_stride_is_rejected_before_walking_samples(void) {
  const int16_t sample = 0;
  struct iterate_kit_aec_signal_window window;
  assert(
      iterate_kit_aec_signal_window_measure(
          &sample, &sample, &sample, 1U, 0U, &window) ==
      ITERATE_KIT_INVALID_ARGUMENT);
}

int main(void) {
  aligned_stride_preserves_exact_integer_signal_evidence();
  merged_window_is_destroyed_after_one_interval_take();
  zero_stride_is_rejected_before_walking_samples();
  return 0;
}
