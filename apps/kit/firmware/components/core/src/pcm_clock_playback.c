#include "iterate/kit/pcm_clock_playback.h"

#include <limits.h>
#include <string.h>

/*
 * Endurance evidence needs monotonic "at least" counters. Wrapping a fault
 * counter after a long unattended run would manufacture an apparent recovery.
 * This object has one owner, so atomics would add cost without correctness.
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

static uint32_t bounded_u32(uint64_t value) {
  return value > UINT32_MAX ? UINT32_MAX : (uint32_t)value;
}

static void clear_retained(
    struct iterate_kit_pcm_clock_playback *playback) {
  playback->retained_offset = 0U;
  playback->retained_count = 0U;
  playback->retained_received_at_ms = 0U;
  playback->metrics.retained_samples = 0U;
}

static void note_discarded_samples(
    struct iterate_kit_pcm_clock_playback *playback,
    size_t samples) {
  saturating_add_u64(
      &playback->metrics.input_samples_discarded, samples);
}

static void finish_with_silence(
    struct iterate_kit_pcm_clock_playback *playback,
    struct iterate_kit_pcm_clock_playback_result *result,
    size_t silence_samples,
    bool ended_in_this_render) {
  if (silence_samples == 0U) {
    return;
  }
  result->silence_samples += silence_samples;
  if (ended_in_this_render) {
    /*
     * Padding after the ordered marker makes a short final device chunk safe
     * for fixed-size DMA. It is neither provider audio nor an underrun.
     */
    saturating_add_u64(
        &playback->metrics.end_padding_silence_samples,
        silence_samples);
    return;
  }
  if (playback->metrics.response_active) {
    saturating_increment_u32(
        &playback->metrics.underrun_incidents);
    saturating_add_u64(
        &playback->metrics.underrun_silence_samples,
        silence_samples);
  } else {
    saturating_add_u64(
        &playback->metrics.idle_silence_samples,
        silence_samples);
  }
}

static enum iterate_kit_status remember_first_error(
    enum iterate_kit_status current,
    enum iterate_kit_status candidate) {
  return current == ITERATE_KIT_OK ? candidate : current;
}

static enum iterate_kit_status release_frame(
    struct iterate_kit_pcm_clock_playback *playback) {
  const enum iterate_kit_status status =
      iterate_kit_pcm_lane_downlink_release(
          playback->options.lane);
  if (status == ITERATE_KIT_OK) {
    saturating_increment_u32(
        &playback->metrics.frames_released);
  } else {
    saturating_increment_u32(
        &playback->metrics.lane_failures);
  }
  return status;
}

enum iterate_kit_status iterate_kit_pcm_clock_playback_init(
    struct iterate_kit_pcm_clock_playback *playback,
    const struct iterate_kit_pcm_clock_playback_options *options) {
  if (playback == NULL || options == NULL ||
      options->lane == NULL || !options->lane->initialized ||
      options->retained_frame == NULL ||
      options->retained_frame_capacity <
          ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME ||
      options->maximum_frame_age_ms == 0U ||
      options->maximum_lane_items_per_render == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(playback, 0, sizeof(*playback));
  playback->options = *options;
  playback->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_pcm_clock_playback_render(
    struct iterate_kit_pcm_clock_playback *playback,
    uint64_t now_ms,
    int16_t *destination,
    size_t sample_count,
    struct iterate_kit_pcm_clock_playback_result *result) {
  if (playback == NULL || !playback->initialized ||
      destination == NULL || result == NULL || sample_count == 0U ||
      sample_count > SIZE_MAX / sizeof(*destination) ||
      destination == playback->options.retained_frame) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  memset(result, 0, sizeof(*result));
  memset(destination, 0, sample_count * sizeof(*destination));
  enum iterate_kit_status final_status = ITERATE_KIT_OK;
  size_t output_offset = 0U;
  size_t lane_items_examined = 0U;
  bool ended_in_this_render = false;

  while (output_offset < sample_count) {
    if (playback->retained_offset < playback->retained_count) {
      const size_t retained =
          playback->retained_count - playback->retained_offset;
      const size_t output_remaining = sample_count - output_offset;
      const size_t copied =
          retained < output_remaining ? retained : output_remaining;
      memcpy(
          destination + output_offset,
          playback->options.retained_frame +
              playback->retained_offset,
          copied * sizeof(*destination));
      output_offset += copied;
      playback->retained_offset += copied;
      result->content_samples += copied;
      saturating_add_u64(
          &playback->metrics.content_samples_rendered, copied);
      if (!result->receive_timing_valid) {
        result->oldest_received_at_ms =
            playback->retained_received_at_ms;
        result->receive_timing_valid = true;
      }
      result->newest_received_at_ms =
          playback->retained_received_at_ms;
      playback->metrics.retained_samples =
          playback->retained_count - playback->retained_offset;
      if (playback->retained_offset == playback->retained_count) {
        clear_retained(playback);
      }
      continue;
    }

    if (lane_items_examined >=
        playback->options.maximum_lane_items_per_render) {
      /*
       * Do not peek by acquiring one more item: even a peek changes ring
       * ownership. A configured bound is an unconditional deadline contract,
       * so the remaining edge is silence whether another item exists or not.
       */
      saturating_increment_u32(
          &playback->metrics.stale_scan_budget_exhaustions);
      break;
    }

    const void *frame = NULL;
    size_t frame_bytes = 0U;
    uint64_t received_at_ms = 0U;
    const enum iterate_kit_status acquire_status =
        iterate_kit_pcm_lane_downlink_acquire_at(
            playback->options.lane,
            &frame,
            &frame_bytes,
            &received_at_ms);
    if (acquire_status == ITERATE_KIT_UNAVAILABLE) {
      break;
    }
    if (acquire_status != ITERATE_KIT_OK) {
      saturating_increment_u32(
          &playback->metrics.lane_failures);
      final_status = remember_first_error(
          final_status, acquire_status);
      break;
    }
    ++lane_items_examined;

    if (frame == NULL && frame_bytes == 0U) {
      const enum iterate_kit_status marker_release =
          iterate_kit_pcm_lane_downlink_release(
              playback->options.lane);
      if (marker_release != ITERATE_KIT_OK) {
        saturating_increment_u32(
            &playback->metrics.lane_failures);
        final_status = remember_first_error(
            final_status, marker_release);
        break;
      }
      saturating_increment_u32(
          &playback->metrics.end_markers_consumed);
      saturating_increment_u32(
          &playback->metrics.response_ends);
      playback->metrics.response_active = false;
      result->end_of_response = true;
      ended_in_this_render = true;
      break;
    }

    if (frame == NULL ||
        frame_bytes != ITERATE_KIT_PCM_V1_FRAME_BYTES) {
      /*
       * pcm_lane normally makes this shape unreachable. Keep the boundary
       * defensive because a corrupted caller-owned ring must not reach I2S.
       */
      note_discarded_samples(
          playback, ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME);
      const enum iterate_kit_status bad_release =
          iterate_kit_pcm_lane_downlink_release(
              playback->options.lane);
      if (bad_release != ITERATE_KIT_OK) {
        saturating_increment_u32(
            &playback->metrics.lane_failures);
      }
      final_status = remember_first_error(
          final_status, ITERATE_KIT_STATE_ERROR);
      continue;
    }

    saturating_increment_u32(&playback->metrics.frames_acquired);
    if (now_ms < received_at_ms) {
      /*
       * A monotonic receive timestamp cannot be in the future. Dropping is
       * safer than saturating its age to zero, which would label corrupt old
       * audio as maximally fresh.
       */
      saturating_increment_u32(
          &playback->metrics.timestamp_regressions);
      note_discarded_samples(
          playback, ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME);
      const enum iterate_kit_status release_status =
          release_frame(playback);
      if (release_status != ITERATE_KIT_OK) {
        final_status = remember_first_error(
            final_status, release_status);
        break;
      }
      final_status = remember_first_error(
          final_status, ITERATE_KIT_STATE_ERROR);
      continue;
    }

    const uint64_t age_ms = now_ms - received_at_ms;
    if (age_ms > playback->options.maximum_frame_age_ms) {
      saturating_increment_u32(
          &playback->metrics.stale_frames_discarded);
      note_discarded_samples(
          playback, ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME);
      const enum iterate_kit_status release_status =
          release_frame(playback);
      if (release_status != ITERATE_KIT_OK) {
        final_status = remember_first_error(
            final_status, release_status);
        break;
      }
      continue;
    }

    memcpy(
        playback->options.retained_frame,
        frame,
        ITERATE_KIT_PCM_V1_FRAME_BYTES);
    playback->retained_offset = 0U;
    playback->retained_count =
        ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME;
    playback->retained_received_at_ms = received_at_ms;
    playback->metrics.retained_samples =
        ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME;
    const enum iterate_kit_status release_status =
        release_frame(playback);
    if (release_status != ITERATE_KIT_OK) {
      /*
       * A failed release leaves ring ownership unknowable. Do not play the
       * private copy and thereby make corrupt ownership look successful.
       */
      note_discarded_samples(
          playback, ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME);
      clear_retained(playback);
      final_status = remember_first_error(
          final_status, release_status);
      break;
    }

    const uint32_t bounded_age = bounded_u32(age_ms);
    playback->metrics.last_receive_to_render_ms = bounded_age;
    if (bounded_age >
        playback->metrics.maximum_receive_to_render_ms) {
      playback->metrics.maximum_receive_to_render_ms = bounded_age;
    }
    if (!playback->metrics.response_active) {
      playback->metrics.response_active = true;
      saturating_increment_u32(
          &playback->metrics.response_starts);
      result->began_response = true;
    }
  }

  const size_t silence_samples = sample_count - output_offset;
  finish_with_silence(
      playback, result, silence_samples, ended_in_this_render);
  return final_status;
}

enum iterate_kit_status iterate_kit_pcm_clock_playback_reset(
    struct iterate_kit_pcm_clock_playback *playback) {
  if (playback == NULL || !playback->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  const size_t retained =
      playback->retained_count - playback->retained_offset;
  saturating_increment_u32(&playback->metrics.resets);
  saturating_add_u64(
      &playback->metrics.reset_samples_discarded, retained);
  note_discarded_samples(playback, retained);
  clear_retained(playback);
  playback->metrics.response_active = false;
  return ITERATE_KIT_OK;
}

const struct iterate_kit_pcm_clock_playback_metrics *
iterate_kit_pcm_clock_playback_metrics(
    const struct iterate_kit_pcm_clock_playback *playback) {
  if (playback == NULL || !playback->initialized) {
    return NULL;
  }
  return &playback->metrics;
}
