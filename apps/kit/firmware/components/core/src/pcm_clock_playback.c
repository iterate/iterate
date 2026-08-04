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
    if (playback->options.item_released != NULL) {
      playback->options.item_released(
          playback->options.item_released_context, 1U);
    }
  } else {
    saturating_increment_u32(
        &playback->metrics.lane_failures);
  }
  return status;
}

/*
 * EOS is counted in three independently owned places: accepted by the network
 * producer, discarded by an interruption purge, and consumed by this playback
 * owner. Comparing the monotonic totals avoids peeking into a ring slot or
 * adding a second cross-task flag that could race ahead of the ordered audio.
 * Widen before addition so multi-day diagnostic counters cannot wrap the
 * unavailable total and manufacture a phantom complete response.
 */
static bool complete_response_is_queued(
    const struct iterate_kit_pcm_clock_playback *playback,
    const struct iterate_kit_pcm_lane_metrics *lane_metrics) {
  const uint64_t unavailable_markers =
      (uint64_t)lane_metrics->downlink_end_markers_discarded +
      (uint64_t)playback->metrics.end_markers_consumed;
  return (uint64_t)lane_metrics->downlink_end_markers_accepted >
      unavailable_markers;
}

static bool wait_for_response_start(
    struct iterate_kit_pcm_clock_playback *playback) {
  if (playback->metrics.response_active ||
      playback->options.minimum_start_items == 0U) {
    return false;
  }

  struct iterate_kit_pcm_lane_metrics lane_metrics;
  iterate_kit_pcm_lane_metrics(playback->options.lane, &lane_metrics);
  const size_t retained_items =
      playback->retained_offset < playback->retained_count ? 1U : 0U;
  const size_t available_items =
      lane_metrics.downlink.current_slots + retained_items;
  if (available_items >=
          playback->options.minimum_start_items ||
      complete_response_is_queued(playback, &lane_metrics)) {
    return false;
  }

  /*
   * Count hardware edges rather than polling time. This makes startup delay
   * visible without placing a timer or log call in the priority audio path.
   */
  saturating_increment_u32(&playback->metrics.startup_wait_edges);
  return true;
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
      options->maximum_lane_items_per_render == 0U ||
      options->minimum_start_items > options->lane->downlink->slot_count) {
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
    if (!playback->metrics.response_active &&
        playback->retained_offset < playback->retained_count) {
      if (now_ms < playback->retained_received_at_ms) {
        /*
         * A clock regression while a startup frame waits is just as corrupt as
         * one observed at ring acquisition. Destroy it and continue the
         * already-authorized scan; calling it fresh would conceal old audio.
         */
        saturating_increment_u32(
            &playback->metrics.timestamp_regressions);
        note_discarded_samples(
            playback,
            playback->retained_count - playback->retained_offset);
        clear_retained(playback);
        playback->startup_scan_in_progress = true;
        final_status = remember_first_error(
            final_status, ITERATE_KIT_STATE_ERROR);
        continue;
      }
      const uint64_t retained_age_ms =
          now_ms - playback->retained_received_at_ms;
      if (retained_age_ms >
          playback->options.maximum_frame_age_ms) {
        /*
         * The first fresh-looking frame can itself become stale while waiting
         * for the watermark to refill. It already owns private storage and has
         * returned its ring credit, so destroy only that private copy and keep
         * scanning; replaying it would reintroduce outage delay off-ring.
         */
        saturating_increment_u32(
            &playback->metrics.stale_frames_discarded);
        note_discarded_samples(
            playback,
            playback->retained_count - playback->retained_offset);
        clear_retained(playback);
        playback->startup_scan_in_progress = true;
        continue;
      }
    }

    if (!playback->metrics.response_active &&
        !playback->startup_scan_in_progress &&
        wait_for_response_start(playback)) {
      break;
    }

    if (playback->retained_offset < playback->retained_count) {
      if (!playback->metrics.response_active) {
        playback->metrics.response_active = true;
        playback->startup_scan_in_progress = false;
        saturating_increment_u32(
            &playback->metrics.response_starts);
        result->began_response = true;
      }
      if (playback->retained_offset == 0U) {
        /*
         * Measure when the frame first contributes to the hardware edge, not
         * when it moved from the SPSC ring into private storage. The latter can
         * precede playback by the startup refill interval and would understate
         * precisely the receive-to-speaker delay diagnostics are meant to find.
         */
        const uint32_t bounded_age = bounded_u32(
            now_ms - playback->retained_received_at_ms);
        playback->metrics.last_receive_to_render_ms = bounded_age;
        if (bounded_age >
            playback->metrics.maximum_receive_to_render_ms) {
          playback->metrics.maximum_receive_to_render_ms = bounded_age;
        }
      }
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

    if (!playback->metrics.response_active &&
        !playback->startup_scan_in_progress) {
      /*
       * Passing the watermark authorizes a bounded freshness scan, not
       * playback. Preserve that authorization across stale releases and CPU
       * budget boundaries; the first current frame is retained privately and
       * then re-enters the watermark gate before a sample can reach I2S.
       */
      playback->startup_scan_in_progress = true;
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
      if (playback->options.item_released != NULL) {
        playback->options.item_released(
            playback->options.item_released_context, 1U);
      }
      saturating_increment_u32(
          &playback->metrics.end_markers_consumed);
      saturating_increment_u32(
          &playback->metrics.response_ends);
      playback->metrics.response_active = false;
      playback->startup_scan_in_progress = false;
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
      } else if (playback->options.item_released != NULL) {
        playback->options.item_released(
            playback->options.item_released_context, 1U);
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
    playback->startup_scan_in_progress = false;
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
  playback->startup_scan_in_progress = false;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_pcm_clock_playback_discard_queued(
    struct iterate_kit_pcm_clock_playback *playback,
    uint32_t *discarded_frames,
    uint32_t *discarded_items) {
  enum iterate_kit_status status;
  if (playback == NULL || !playback->initialized ||
      discarded_frames == NULL || discarded_items == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  status = iterate_kit_pcm_lane_discard_downlink(
      playback->options.lane,
      discarded_frames,
      discarded_items);
  if (status != ITERATE_KIT_OK) {
    saturating_increment_u32(&playback->metrics.lane_failures);
    return status;
  }
  if (*discarded_items > 0U &&
      playback->options.item_released != NULL) {
    playback->options.item_released(
        playback->options.item_released_context,
        *discarded_items);
  }
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
