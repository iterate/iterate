#include "iterate/kit/aec_capture_bridge.h"

#include <limits.h>
#include <string.h>

/*
 * These counters feed unattended physical-run evidence. Saturation means "at
 * least this many"; wraparound would make a worsening long-run fault look as
 * though it recovered. The bridge has one owner, so ordinary loads/stores are
 * sufficient and cheaper than atomics.
 */
static void saturating_increment_u32(uint32_t *value) {
  if (*value != UINT32_MAX) {
    ++*value;
  }
}

static void saturating_add_u64(uint64_t *value, size_t amount) {
#if SIZE_MAX > UINT64_MAX
  const uint64_t converted =
      amount > (size_t)UINT64_MAX ? UINT64_MAX : (uint64_t)amount;
#else
  const uint64_t converted = (uint64_t)amount;
#endif
  if (*value > UINT64_MAX - converted) {
    *value = UINT64_MAX;
  } else {
    *value += converted;
  }
}

static bool distinct_buffers(
    const struct iterate_kit_aec_capture_bridge_options *options) {
  /*
   * Exact overlap validation would itself require byte-range arithmetic that
   * can overflow for hostile pointers. Base equality catches the plausible
   * configuration mistake; the public lifetime contract forbids all overlap.
   */
  return options->near_frame != options->reference_frame &&
      options->near_frame != options->playout_frame &&
      options->near_frame != options->clean_frame &&
      options->near_frame != options->egress_frame &&
      options->reference_frame != options->playout_frame &&
      options->reference_frame != options->clean_frame &&
      options->reference_frame != options->egress_frame &&
      options->playout_frame != options->clean_frame &&
      options->playout_frame != options->egress_frame &&
      options->clean_frame != options->egress_frame;
}

static enum iterate_kit_status reset_epoch(
    struct iterate_kit_aec_capture_bridge *bridge) {
  saturating_increment_u32(&bridge->metrics.epoch_resets);
  saturating_add_u64(
      &bridge->metrics.input_samples_discarded,
      bridge->input_fill);
  saturating_add_u64(
      &bridge->metrics.clean_samples_discarded,
      bridge->egress_fill);
  bridge->input_fill = 0U;
  bridge->egress_fill = 0U;
  bridge->metrics.input_partial_samples = 0U;
  bridge->metrics.egress_partial_samples = 0U;
  bridge->sequence_valid = false;
  bridge->timestamp_valid = false;

  const enum iterate_kit_status status =
      bridge->options.reset_processor(
          bridge->options.processor_context);
  if (status != ITERATE_KIT_OK) {
    /*
     * Local partials are already gone, but the adaptive filter may still carry
     * invalid history. Leave sequence_valid false so no caller can mistake the
     * failed reset for a usable new alignment epoch.
     */
    saturating_increment_u32(
        &bridge->metrics.processor_reset_failures);
  }
  return status;
}

static uint64_t subtract_sample_duration(
    uint64_t end_at_us,
    size_t samples,
    uint32_t sample_rate_hz) {
  /*
   * Firmware frame sizes are tiny, but validate arithmetic here because the
   * public API accepts size_t. Clamping to zero preserves monotonic units and
  * cannot manufacture a huge timestamp through unsigned underflow.
  */
  uint64_t duration_us;
#if SIZE_MAX > UINT32_MAX
  if (samples > UINT64_MAX / 1000000U) {
    duration_us = UINT64_MAX;
  } else {
    duration_us =
        (uint64_t)samples * 1000000U / sample_rate_hz;
  }
#else
  /* A 32-bit size_t cannot overflow uint64_t when multiplied by 1,000,000. */
  duration_us =
      (uint64_t)samples * 1000000U / sample_rate_hz;
#endif
  return duration_us > end_at_us ? 0U : end_at_us - duration_us;
}

static enum iterate_kit_status copy_clean_frame(
    struct iterate_kit_aec_capture_bridge *bridge,
    uint64_t processing_frame_end_at_us) {
  size_t clean_offset = 0U;
  while (clean_offset < bridge->options.processing_frame_samples) {
    const size_t output_space =
        bridge->options.egress_frame_samples - bridge->egress_fill;
    const size_t clean_remaining =
        bridge->options.processing_frame_samples - clean_offset;
    const size_t copied =
        output_space < clean_remaining ? output_space : clean_remaining;
    memcpy(
        bridge->options.egress_frame + bridge->egress_fill,
        bridge->options.clean_frame + clean_offset,
        copied * sizeof(*bridge->options.clean_frame));
    bridge->egress_fill += copied;
    clean_offset += copied;
    bridge->metrics.egress_partial_samples = bridge->egress_fill;

    if (bridge->egress_fill != bridge->options.egress_frame_samples) {
      continue;
    }

    const size_t samples_after_output =
        bridge->options.processing_frame_samples - clean_offset;
    const uint64_t output_end_at_us = subtract_sample_duration(
        processing_frame_end_at_us,
        samples_after_output,
        bridge->options.sample_rate_hz);
    const enum iterate_kit_status status =
        bridge->options.copy_egress(
            bridge->options.egress_context,
            bridge->options.egress_frame,
            bridge->options.egress_frame_samples,
            bridge->options.sample_rate_hz,
            output_end_at_us);
    if (status != ITERATE_KIT_OK) {
      /*
       * The full frame includes any clean prefix retained from the previous
       * DSP result. Keeping either it or this result's remaining suffix would
       * replay old conversation after the socket becomes writable. Account
       * for and abandon both in one policy boundary.
       */
      saturating_increment_u32(
          &bridge->metrics.egress_copy_failures);
      saturating_add_u64(
          &bridge->metrics.clean_samples_discarded,
          bridge->options.egress_frame_samples);
      saturating_add_u64(
          &bridge->metrics.clean_samples_discarded,
          samples_after_output);
      bridge->egress_fill = 0U;
      bridge->metrics.egress_partial_samples = 0U;
      return status;
    }

    saturating_increment_u32(
        &bridge->metrics.egress_frames_copied);
    saturating_add_u64(
        &bridge->metrics.egress_samples_copied,
        bridge->options.egress_frame_samples);
    bridge->egress_fill = 0U;
    bridge->metrics.egress_partial_samples = 0U;
  }
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status process_frame(
    struct iterate_kit_aec_capture_bridge *bridge,
    uint64_t frame_end_at_us,
    bool discard_clean,
    bool *egress_failed) {
  saturating_increment_u32(&bridge->metrics.processor_frames);
  enum iterate_kit_status result = bridge->options.process(
      bridge->options.processor_context,
      bridge->options.near_frame,
      bridge->options.reference_frame,
      bridge->options.playout_frame,
      bridge->options.clean_frame,
      bridge->options.processing_frame_samples);
  if (result != ITERATE_KIT_OK) {
    /*
     * Never turn "AEC unavailable" into unannounced raw microphone mode. A
     * complete silence frame keeps timing deterministic while the explicit
     * error/counter lets the outer diagnostics policy fail the run.
     */
    memset(
        bridge->options.clean_frame,
        0,
        bridge->options.processing_frame_samples *
            sizeof(*bridge->options.clean_frame));
    saturating_increment_u32(
        &bridge->metrics.processor_failures);
    saturating_add_u64(
        &bridge->metrics.processor_silence_samples,
        bridge->options.processing_frame_samples);
  }
  saturating_add_u64(
      &bridge->metrics.clean_samples_produced,
      bridge->options.processing_frame_samples);

  if (discard_clean) {
    /*
     * One oversized DMA delivery can contain several complete DSP frames. If
     * egress rejected an earlier frame from this same delivery, attempting a
     * later one would leapfrog loss and make one callback look current while
     * it still represents the same stalled scheduling interval.
     */
    saturating_add_u64(
        &bridge->metrics.clean_samples_discarded,
        bridge->options.processing_frame_samples);
    return result;
  }

  const enum iterate_kit_status copy_status =
      copy_clean_frame(bridge, frame_end_at_us);
  if (copy_status != ITERATE_KIT_OK) {
    *egress_failed = true;
    result = copy_status;
  }
  return result;
}

enum iterate_kit_status iterate_kit_aec_capture_bridge_init(
    struct iterate_kit_aec_capture_bridge *bridge,
    const struct iterate_kit_aec_capture_bridge_options *options) {
  if (bridge == NULL || options == NULL ||
      options->sample_rate_hz == 0U ||
      options->processing_frame_samples == 0U ||
      options->egress_frame_samples == 0U ||
      options->near_frame == NULL ||
      options->reference_frame == NULL ||
      options->playout_frame == NULL ||
      options->clean_frame == NULL ||
      options->egress_frame == NULL ||
      options->processing_frame_capacity <
          options->processing_frame_samples ||
      options->egress_frame_capacity < options->egress_frame_samples ||
      options->process == NULL ||
      options->reset_processor == NULL ||
      options->copy_egress == NULL ||
      !distinct_buffers(options)) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  memset(bridge, 0, sizeof(*bridge));
  bridge->options = *options;
  bridge->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_aec_capture_bridge_push_aligned(
    struct iterate_kit_aec_capture_bridge *bridge,
    uint32_t sequence,
    uint64_t captured_through_at_us,
    const int16_t *near_samples,
    const int16_t *reference_samples,
    const int16_t *playout_samples,
    size_t sample_count) {
  if (bridge == NULL || !bridge->initialized ||
      near_samples == NULL || reference_samples == NULL ||
      playout_samples == NULL ||
      sample_count == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  if (bridge->timestamp_valid &&
      captured_through_at_us <
          bridge->last_captured_through_at_us) {
    /*
     * A uint64 monotonic clock cannot legitimately move backwards during one
     * boot. Do not relabel the chunk with a synthetic time; reject it so the
     * outer layer can classify the hardware/timestamp defect explicitly.
     */
    saturating_increment_u32(
        &bridge->metrics.timestamp_regressions);
    saturating_add_u64(
        &bridge->metrics.input_samples_discarded,
        sample_count);
    return ITERATE_KIT_STATE_ERROR;
  }

  if (bridge->sequence_valid &&
      sequence != bridge->last_sequence + 1U) {
    saturating_increment_u32(
        &bridge->metrics.sequence_discontinuities);
    const enum iterate_kit_status reset_status = reset_epoch(bridge);
    if (reset_status != ITERATE_KIT_OK) {
      saturating_add_u64(
          &bridge->metrics.input_samples_discarded,
          sample_count);
      return reset_status;
    }
  }
  bridge->last_sequence = sequence;
  bridge->last_captured_through_at_us = captured_through_at_us;
  bridge->sequence_valid = true;
  bridge->timestamp_valid = true;

  enum iterate_kit_status result = ITERATE_KIT_OK;
  bool discard_clean_for_rest_of_call = false;
  size_t source_offset = 0U;
  while (source_offset < sample_count) {
    const size_t frame_space =
        bridge->options.processing_frame_samples - bridge->input_fill;
    const size_t source_remaining = sample_count - source_offset;
    const size_t copied =
        frame_space < source_remaining ? frame_space : source_remaining;
    memcpy(
        bridge->options.near_frame + bridge->input_fill,
        near_samples + source_offset,
        copied * sizeof(*near_samples));
    memcpy(
        bridge->options.reference_frame + bridge->input_fill,
        reference_samples + source_offset,
        copied * sizeof(*reference_samples));
    memcpy(
        bridge->options.playout_frame + bridge->input_fill,
        playout_samples + source_offset,
        copied * sizeof(*playout_samples));
    bridge->input_fill += copied;
    source_offset += copied;
    saturating_add_u64(
        &bridge->metrics.input_samples_accepted, copied);
    bridge->metrics.input_partial_samples = bridge->input_fill;

    if (bridge->input_fill !=
        bridge->options.processing_frame_samples) {
      continue;
    }

    const size_t samples_after_frame = sample_count - source_offset;
    const uint64_t frame_end_at_us = subtract_sample_duration(
        captured_through_at_us,
        samples_after_frame,
        bridge->options.sample_rate_hz);
    bool egress_failed = false;
    const enum iterate_kit_status process_status = process_frame(
        bridge,
        frame_end_at_us,
        discard_clean_for_rest_of_call,
        &egress_failed);
    bridge->input_fill = 0U;
    bridge->metrics.input_partial_samples = 0U;

    if (process_status != ITERATE_KIT_OK) {
      if (result == ITERATE_KIT_OK || egress_failed) {
        result = process_status;
      }
    }
    if (egress_failed) {
      discard_clean_for_rest_of_call = true;
    }
  }
  return result;
}

enum iterate_kit_status iterate_kit_aec_capture_bridge_reset(
    struct iterate_kit_aec_capture_bridge *bridge) {
  if (bridge == NULL || !bridge->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  return reset_epoch(bridge);
}

const struct iterate_kit_aec_capture_bridge_metrics *
iterate_kit_aec_capture_bridge_metrics(
    const struct iterate_kit_aec_capture_bridge *bridge) {
  if (bridge == NULL || !bridge->initialized) {
    return NULL;
  }
  return &bridge->metrics;
}
