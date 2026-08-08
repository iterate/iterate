#include "iterate/kit/aec_uplink_selector.h"

#include <limits.h>
#include <stdbool.h>
#include <string.h>

static int16_t saturating_multiply(
    int16_t sample,
    uint32_t multiplier,
    uint64_t *clipped_samples) {
  const int64_t amplified = (int64_t)sample * (int64_t)multiplier;
  if (amplified > INT16_MAX) {
    (*clipped_samples)++;
    return INT16_MAX;
  }
  if (amplified < INT16_MIN) {
    (*clipped_samples)++;
    return INT16_MIN;
  }
  return (int16_t)amplified;
}

enum iterate_kit_status iterate_kit_aec_uplink_selector_init(
    struct iterate_kit_aec_uplink_selector *selector,
    enum iterate_kit_aec_uplink_policy policy,
    size_t processed_hangover_frames,
    uint32_t raw_gain_multiplier,
    uint32_t processed_gain_multiplier) {
  if (selector == NULL ||
      (policy != ITERATE_KIT_AEC_UPLINK_PLAYBACK_SWITCHED &&
       policy != ITERATE_KIT_AEC_UPLINK_CONSTANT_PROCESSED) ||
      raw_gain_multiplier == 0U ||
      raw_gain_multiplier > (uint32_t)INT16_MAX ||
      processed_gain_multiplier == 0U ||
      processed_gain_multiplier > (uint32_t)INT16_MAX) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(selector, 0, sizeof(*selector));
  selector->policy = policy;
  selector->processed_hangover_frames = processed_hangover_frames;
  selector->raw_gain_multiplier = raw_gain_multiplier;
  selector->processed_gain_multiplier = processed_gain_multiplier;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_aec_uplink_selector_process(
    struct iterate_kit_aec_uplink_selector *selector,
    const int16_t *near_samples,
    const int16_t *playout_samples,
    const int16_t *processed_samples,
    int16_t *output_samples,
    size_t sample_count) {
  if (selector == NULL || near_samples == NULL || playout_samples == NULL ||
      processed_samples == NULL || output_samples == NULL || sample_count == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  bool far_end_active = false;
  if (selector->policy == ITERATE_KIT_AEC_UPLINK_PLAYBACK_SWITCHED) {
    for (size_t index = 0U; index < sample_count; ++index) {
      if (playout_samples[index] != 0) {
        far_end_active = true;
        break;
      }
    }
  }

  if (far_end_active) {
    selector->processed_hangover_remaining =
        selector->processed_hangover_frames;
  }
  const bool use_processed =
      selector->policy == ITERATE_KIT_AEC_UPLINK_CONSTANT_PROCESSED ||
      far_end_active || selector->processed_hangover_remaining > 0U;
  if (use_processed) {
    for (size_t index = 0U; index < sample_count; ++index) {
      output_samples[index] = saturating_multiply(
          processed_samples[index],
          selector->processed_gain_multiplier,
          &selector->clipped_samples);
    }
    selector->processed_frames++;
    if (!far_end_active && selector->processed_hangover_remaining > 0U) {
      selector->processed_hangover_remaining--;
    }
    return ITERATE_KIT_OK;
  }

  /*
   * Apply only a memoryless saturating gain: it cannot queue, smear, or alter
   * phoneme timing. CoreS3 deliberately leaves analogue gain low enough that
   * loudspeaker echo does not rail the AEC input; retained near-only captures
   * therefore need a separate digital calibration to cross provider VAD's
   * measured floor. This is not the old worker-wide gain: raw and processed
   * branches have independent measured multipliers, and clipping is counted.
   */
  for (size_t index = 0U; index < sample_count; ++index) {
    output_samples[index] = saturating_multiply(
        near_samples[index],
        selector->raw_gain_multiplier,
        &selector->clipped_samples);
  }
  selector->raw_frames++;
  return ITERATE_KIT_OK;
}
