#ifndef ITERATE_KIT_AEC_SIGNAL_WINDOW_H
#define ITERATE_KIT_AEC_SIGNAL_WINDOW_H

#include "iterate/kit/status.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Allocation-free signal evidence shared by any local-AEC device profile.
 *
 * The accumulator has no lock because locking policy belongs to the hardware
 * scheduler: CoreS3 and the Voice Preview Edition do not share an ISR/task
 * topology. A realtime owner measures into a stack-local window, then merges
 * that fixed-size result inside its shortest available platform critical
 * section. A low-rate diagnostics owner atomically takes and clears the same
 * aggregate. Keeping sample walking outside the lock is the key contract.
 */
struct iterate_kit_aec_signal_window {
  uint64_t sampled_samples;
  uint64_t near_absolute_sum;
  uint64_t reference_absolute_sum;
  uint64_t linear_absolute_sum;
  uint64_t clean_absolute_sum;
  uint32_t near_peak;
  uint32_t reference_peak;
  uint32_t linear_peak;
  uint32_t clean_peak;
};

struct iterate_kit_aec_signal_summary {
  uint32_t sample_stride;
  uint32_t sampled_samples;
  uint32_t near_peak;
  uint32_t reference_peak;
  uint32_t linear_peak;
  uint32_t clean_peak;
  uint32_t near_mean_absolute;
  uint32_t reference_mean_absolute;
  uint32_t linear_mean_absolute;
  uint32_t clean_mean_absolute;
};

/** Measures aligned near/reference/linear/final positions into a fresh window. */
enum iterate_kit_status iterate_kit_aec_signal_window_measure(
    const int16_t *near_samples,
    const int16_t *reference_samples,
    const int16_t *linear_samples,
    const int16_t *clean_samples,
    size_t sample_count,
    size_t sample_stride,
    struct iterate_kit_aec_signal_window *window);

/** Merges a precomputed local window; the caller supplies synchronization. */
void iterate_kit_aec_signal_window_merge(
    struct iterate_kit_aec_signal_window *aggregate,
    const struct iterate_kit_aec_signal_window *observation);

/** Copies and clears an aggregate while the caller owns its synchronization. */
void iterate_kit_aec_signal_window_take(
    struct iterate_kit_aec_signal_window *aggregate,
    struct iterate_kit_aec_signal_window *window);

/** Converts exact sums to an integer-only public summary. */
enum iterate_kit_status iterate_kit_aec_signal_window_summarize(
    const struct iterate_kit_aec_signal_window *window,
    size_t sample_stride,
    struct iterate_kit_aec_signal_summary *summary);

#ifdef __cplusplus
}
#endif

#endif
