#include "iterate/kit/pcm_high_pass.h"

#include <limits.h>
#include <string.h>

static int16_t clamp_sample(
    int32_t sample,
    uint64_t *clipped_samples) {
  if (sample > INT16_MAX) {
    if (*clipped_samples != UINT64_MAX) {
      ++*clipped_samples;
    }
    return INT16_MAX;
  }
  if (sample < INT16_MIN) {
    if (*clipped_samples != UINT64_MAX) {
      ++*clipped_samples;
    }
    return INT16_MIN;
  }
  return (int16_t)sample;
}

enum iterate_kit_status iterate_kit_pcm_high_pass_init(
    struct iterate_kit_pcm_high_pass *filter,
    uint16_t decay_q15) {
  if (filter == NULL || decay_q15 == 0U || decay_q15 > INT16_MAX) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(filter, 0, sizeof(*filter));
  filter->decay_q15 = decay_q15;
  return ITERATE_KIT_OK;
}

void iterate_kit_pcm_high_pass_reset(
    struct iterate_kit_pcm_high_pass *filter) {
  if (filter == NULL) {
    return;
  }
  /*
   * Clipping is lifetime evidence, not signal history. Preserve it across a
   * reconnect/capture discontinuity so a reset cannot make a rail incident
   * disappear from the next diagnostics sample.
   */
  filter->previous_input = 0;
  filter->previous_output = 0;
}

enum iterate_kit_status iterate_kit_pcm_high_pass_process(
    struct iterate_kit_pcm_high_pass *filter,
    const int16_t *input,
    int16_t *output,
    size_t sample_count) {
  if (filter == NULL || input == NULL || output == NULL ||
      sample_count == 0U || filter->decay_q15 == 0U ||
      filter->decay_q15 > INT16_MAX) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  for (size_t index = 0U; index < sample_count; ++index) {
    const int16_t current_input = input[index];
    /*
     * Q15 keeps the hot path to one bounded 32-bit multiply per sample—about
     * 16k multiplies/s—without floating point, allocation, or an audio queue.
     * C99 signed division truncates toward zero, allowing a constant offset to
     * decay fully to zero instead of becoming a small fixed-point limit cycle.
     * The worst product is 32767*32767 and therefore remains inside int32_t.
     */
    const int32_t feedback =
        ((int32_t)filter->decay_q15 *
         (int32_t)filter->previous_output) /
        32768;
    const int32_t unbounded_output =
        (int32_t)current_input - (int32_t)filter->previous_input + feedback;
    const int16_t current_output =
        clamp_sample(unbounded_output, &filter->clipped_samples);
    output[index] = current_output;
    filter->previous_input = current_input;
    filter->previous_output = current_output;
  }
  return ITERATE_KIT_OK;
}
