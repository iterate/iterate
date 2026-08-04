#include "iterate/kit/aec_signal_window.h"

#include <limits.h>
#include <string.h>

static uint32_t sample_magnitude(int16_t sample) {
  /* Widen before negation: -INT16_MIN is not representable in int16_t. */
  const int32_t wide = sample;
  return wide < 0 ? (uint32_t)-wide : (uint32_t)wide;
}

static uint64_t saturating_add_u64(uint64_t left, uint64_t right) {
  return right > UINT64_MAX - left ? UINT64_MAX : left + right;
}

static uint32_t maximum_u32(uint32_t left, uint32_t right) {
  return left > right ? left : right;
}

enum iterate_kit_status iterate_kit_aec_signal_window_measure(
    const int16_t *near_samples,
    const int16_t *reference_samples,
    const int16_t *clean_samples,
    size_t sample_count,
    size_t sample_stride,
    struct iterate_kit_aec_signal_window *window) {
  size_t index;
  if (near_samples == NULL || reference_samples == NULL ||
      clean_samples == NULL || window == NULL || sample_count == 0U ||
      sample_stride == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  memset(window, 0, sizeof(*window));
  for (index = 0U; index < sample_count; index += sample_stride) {
    const uint32_t near = sample_magnitude(near_samples[index]);
    const uint32_t reference =
        sample_magnitude(reference_samples[index]);
    const uint32_t clean = sample_magnitude(clean_samples[index]);
    window->sampled_samples++;
    window->near_absolute_sum += near;
    window->reference_absolute_sum += reference;
    window->clean_absolute_sum += clean;
    window->near_peak = maximum_u32(window->near_peak, near);
    window->reference_peak =
        maximum_u32(window->reference_peak, reference);
    window->clean_peak = maximum_u32(window->clean_peak, clean);
  }
  return ITERATE_KIT_OK;
}

void iterate_kit_aec_signal_window_merge(
    struct iterate_kit_aec_signal_window *aggregate,
    const struct iterate_kit_aec_signal_window *observation) {
  if (aggregate == NULL || observation == NULL) {
    return;
  }
  /*
   * Saturation preserves “at least this much” if diagnostics are absent for an
   * implausibly long interval. Wraparound could instead turn overload into a
   * quiet-looking window. Normal one-second windows are many orders of
   * magnitude below these limits.
   */
  aggregate->sampled_samples = saturating_add_u64(
      aggregate->sampled_samples, observation->sampled_samples);
  aggregate->near_absolute_sum = saturating_add_u64(
      aggregate->near_absolute_sum, observation->near_absolute_sum);
  aggregate->reference_absolute_sum = saturating_add_u64(
      aggregate->reference_absolute_sum,
      observation->reference_absolute_sum);
  aggregate->clean_absolute_sum = saturating_add_u64(
      aggregate->clean_absolute_sum, observation->clean_absolute_sum);
  aggregate->near_peak = maximum_u32(
      aggregate->near_peak, observation->near_peak);
  aggregate->reference_peak = maximum_u32(
      aggregate->reference_peak, observation->reference_peak);
  aggregate->clean_peak = maximum_u32(
      aggregate->clean_peak, observation->clean_peak);
}

void iterate_kit_aec_signal_window_take(
    struct iterate_kit_aec_signal_window *aggregate,
    struct iterate_kit_aec_signal_window *window) {
  if (aggregate == NULL || window == NULL || aggregate == window) {
    return;
  }
  *window = *aggregate;
  memset(aggregate, 0, sizeof(*aggregate));
}

static uint32_t bounded_mean(uint64_t sum, uint64_t count) {
  if (count == 0U) {
    return 0U;
  }
  const uint64_t mean = sum / count;
  return mean > UINT32_MAX ? UINT32_MAX : (uint32_t)mean;
}

enum iterate_kit_status iterate_kit_aec_signal_window_summarize(
    const struct iterate_kit_aec_signal_window *window,
    size_t sample_stride,
    struct iterate_kit_aec_signal_summary *summary) {
  if (window == NULL || summary == NULL || sample_stride == 0U ||
      sample_stride > UINT32_MAX) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  *summary = (struct iterate_kit_aec_signal_summary){
    .sample_stride = (uint32_t)sample_stride,
    .sampled_samples = window->sampled_samples > UINT32_MAX
        ? UINT32_MAX
        : (uint32_t)window->sampled_samples,
    .near_peak = window->near_peak,
    .reference_peak = window->reference_peak,
    .clean_peak = window->clean_peak,
    .near_mean_absolute = bounded_mean(
        window->near_absolute_sum, window->sampled_samples),
    .reference_mean_absolute = bounded_mean(
        window->reference_absolute_sum, window->sampled_samples),
    .clean_mean_absolute = bounded_mean(
        window->clean_absolute_sum, window->sampled_samples),
  };
  return ITERATE_KIT_OK;
}
