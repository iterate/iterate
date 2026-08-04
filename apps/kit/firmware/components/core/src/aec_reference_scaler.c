#include "iterate/kit/aec_reference_scaler.h"

#include <limits.h>

static void note_clip(uint64_t *clipped_samples) {
  if (*clipped_samples != UINT64_MAX) {
    ++*clipped_samples;
  }
}

enum iterate_kit_status iterate_kit_aec_reference_scale(
    const int16_t *input,
    int16_t *output,
    size_t sample_count,
    uint32_t multiplier,
    uint64_t *clipped_samples) {
  if (input == NULL || output == NULL || sample_count == 0U ||
      multiplier == 0U || multiplier > (uint32_t)INT16_MAX ||
      clipped_samples == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  for (size_t index = 0U; index < sample_count; ++index) {
    const int64_t scaled = (int64_t)input[index] * (int64_t)multiplier;
    if (scaled > INT16_MAX) {
      output[index] = INT16_MAX;
      note_clip(clipped_samples);
    } else if (scaled < INT16_MIN) {
      output[index] = INT16_MIN;
      note_clip(clipped_samples);
    } else {
      output[index] = (int16_t)scaled;
    }
  }
  return ITERATE_KIT_OK;
}
