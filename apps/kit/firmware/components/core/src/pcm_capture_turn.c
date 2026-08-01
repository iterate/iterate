#include "iterate/kit/pcm_capture_turn.h"

#include <limits.h>
#include <string.h>

/*
 * The queue is intentionally a queue of edges, not an atomic desired-state
 * mailbox. A start followed by a stop is itself a complete manual turn, even
 * when both arrive before the AEC task runs. Coalescing those values would
 * make successful Cap'n Web calls disappear according to scheduler timing.
 *
 * Only the AEC consumer writes the PCM lane. That ownership rule is stronger
 * than trying to coordinate a control-task marker with an in-flight audio
 * copy: one FIFO producer makes frame-before-marker order structural. The
 * existing lane owns all PCM storage, so this module adds only four command
 * bytes/lengths and no second audio queue.
 */

static uint32_t atomic_load_relaxed(const uint32_t *value) {
  return __atomic_load_n(value, __ATOMIC_RELAXED);
}

static void atomic_store_relaxed(uint32_t *value, uint32_t next) {
  __atomic_store_n(value, next, __ATOMIC_RELAXED);
}

static void atomic_saturating_increment(uint32_t *value) {
  uint32_t current = atomic_load_relaxed(value);
  while (current != UINT32_MAX &&
         !__atomic_compare_exchange_n(
             value,
             &current,
             current + 1U,
             false,
             __ATOMIC_RELAXED,
             __ATOMIC_RELAXED)) {
  }
}

static void notify_uplink(
    const struct iterate_kit_pcm_capture_turn *turn) {
  if (turn->options.notify_uplink != NULL) {
    turn->options.notify_uplink(
        turn->options.notify_uplink_context);
  }
}

enum iterate_kit_status iterate_kit_pcm_capture_turn_init(
    struct iterate_kit_pcm_capture_turn *turn,
    const struct iterate_kit_pcm_capture_turn_options *options) {
  enum iterate_kit_status status;
  if (turn == NULL || options == NULL ||
      options->lane == NULL || !options->lane->initialized ||
      (options->stop_boundary !=
           ITERATE_KIT_PCM_CAPTURE_STOP_EMIT_END_MARKER &&
       options->stop_boundary !=
           ITERATE_KIT_PCM_CAPTURE_STOP_SUPPRESS_END_MARKER)) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  memset(turn, 0, sizeof(*turn));
  turn->options = *options;
  status = iterate_kit_spsc_ring_init(
      &turn->command_ring,
      turn->command_storage,
      sizeof(turn->command_storage[0]),
      ITERATE_KIT_PCM_CAPTURE_TURN_COMMAND_CAPACITY,
      turn->command_lengths);
  if (status != ITERATE_KIT_OK) {
    memset(turn, 0, sizeof(*turn));
    return status;
  }
  turn->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_pcm_capture_turn_request(
    struct iterate_kit_pcm_capture_turn *turn, bool active) {
  void *slot = NULL;
  size_t capacity = 0U;
  enum iterate_kit_status status;
  const uint32_t requested = active ? 1U : 0U;
  if (turn == NULL || !turn->initialized) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (atomic_load_relaxed(
          &turn->producer_requested_active) == requested) {
    return ITERATE_KIT_OK;
  }

  status = iterate_kit_spsc_ring_write_acquire(
      &turn->command_ring, &slot, &capacity);
  if (status != ITERATE_KIT_OK) {
    if (status == ITERATE_KIT_BACKPRESSURE) {
      atomic_saturating_increment(
          &turn->command_backpressure);
    }
    return status;
  }
  if (slot == NULL || capacity != 1U) {
    (void)iterate_kit_spsc_ring_write_cancel(
        &turn->command_ring);
    atomic_saturating_increment(
        &turn->command_protocol_errors);
    return ITERATE_KIT_STATE_ERROR;
  }
  *(uint8_t *)slot = active ? 1U : 0U;
  status = iterate_kit_spsc_ring_write_publish(
      &turn->command_ring, 1U);
  if (status != ITERATE_KIT_OK) {
    atomic_saturating_increment(
        &turn->command_protocol_errors);
    return status;
  }

  /*
   * Publish the command before updating the producer-side snapshot. The SPSC
   * release store is the actual cross-core handoff; this relaxed diagnostic
   * value never grants the consumer permission to act.
   */
  atomic_store_relaxed(
      &turn->producer_requested_active, requested);
  atomic_saturating_increment(&turn->commands_accepted);
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status apply_command(
    struct iterate_kit_pcm_capture_turn *turn,
    bool active,
    uint64_t now_ms) {
  const uint32_t active_value = active ? 1U : 0U;
  if (atomic_load_relaxed(&turn->consumer_active) == active_value) {
    return ITERATE_KIT_OK;
  }

  atomic_store_relaxed(
      &turn->consumer_active, active_value);
  atomic_saturating_increment(&turn->transitions_applied);
  if (active) {
    return ITERATE_KIT_OK;
  }

  if (turn->options.stop_boundary ==
      ITERATE_KIT_PCM_CAPTURE_STOP_SUPPRESS_END_MARKER) {
    /*
     * Server-side VAD consumes one continuous sequence of microphone frames.
     * Publishing the manual marker here would ask userspace to commit a turn
     * that the provider already owns. Closing at the existing sole-producer
     * boundary retains exact frame ordering and avoids a parallel audio path;
     * the counter makes the deliberate absence distinguishable from loss.
     */
    atomic_saturating_increment(
        &turn->end_markers_suppressed);
    return ITERATE_KIT_OK;
  }

  /*
   * State becomes inactive before marker publication. If the lane is full,
   * allowing another clean frame would deepen the already stale epoch. The
   * lane sets its destructive reset request; notification wakes the transport
   * for either the accepted marker or that recovery action.
   */
  const enum iterate_kit_status status =
      iterate_kit_pcm_lane_submit_uplink_end_marker_at(
          turn->options.lane, now_ms);
  if (status == ITERATE_KIT_OK) {
    atomic_saturating_increment(
        &turn->end_markers_accepted);
    notify_uplink(turn);
  } else if (status == ITERATE_KIT_BACKPRESSURE) {
    atomic_saturating_increment(
        &turn->end_marker_backpressure);
    notify_uplink(turn);
  } else {
    atomic_saturating_increment(
        &turn->end_marker_failures);
  }
  return status;
}

enum iterate_kit_status iterate_kit_pcm_capture_turn_poll(
    struct iterate_kit_pcm_capture_turn *turn, uint64_t now_ms) {
  size_t processed = 0U;
  if (turn == NULL || !turn->initialized) {
    return ITERATE_KIT_STATE_ERROR;
  }

  while (processed <
         ITERATE_KIT_PCM_CAPTURE_TURN_COMMAND_CAPACITY) {
    const void *slot = NULL;
    size_t length = 0U;
    enum iterate_kit_status status =
        iterate_kit_spsc_ring_read_acquire(
            &turn->command_ring, &slot, &length);
    if (status == ITERATE_KIT_UNAVAILABLE) {
      return processed == 0U
          ? ITERATE_KIT_UNAVAILABLE
          : ITERATE_KIT_OK;
    }
    if (status != ITERATE_KIT_OK) {
      atomic_saturating_increment(
          &turn->command_protocol_errors);
      return status;
    }
    if (slot == NULL || length != 1U ||
        *(const uint8_t *)slot > 1U) {
      (void)iterate_kit_spsc_ring_read_release(
          &turn->command_ring);
      atomic_saturating_increment(
          &turn->command_protocol_errors);
      return ITERATE_KIT_STATE_ERROR;
    }

    status = apply_command(
        turn, *(const uint8_t *)slot != 0U, now_ms);
    const enum iterate_kit_status release_status =
        iterate_kit_spsc_ring_read_release(
            &turn->command_ring);
    ++processed;
    if (release_status != ITERATE_KIT_OK) {
      atomic_saturating_increment(
          &turn->command_protocol_errors);
      return release_status;
    }
    if (status != ITERATE_KIT_OK) {
      return status;
    }
  }
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_pcm_capture_turn_submit(
    struct iterate_kit_pcm_capture_turn *turn,
    const int16_t *samples,
    size_t sample_count,
    uint32_t sample_rate_hz,
    uint64_t captured_through_at_us) {
  enum iterate_kit_status status;
  if (turn == NULL || !turn->initialized || samples == NULL ||
      sample_count != ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME ||
      sample_rate_hz != ITERATE_KIT_PCM_V1_SAMPLE_RATE_HZ) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  if (atomic_load_relaxed(&turn->consumer_active) == 0U) {
    /*
     * This is expected continuous-AEC work, not failed delivery. Returning OK
     * lets the DSP bridge continue its aligned timeline; the exact discard
     * count makes idle CPU/resource accounting possible without 50 Hz logs.
     */
    atomic_saturating_increment(
        &turn->inactive_frames_discarded);
    return ITERATE_KIT_OK;
  }

  status = iterate_kit_pcm_lane_submit_uplink_at(
      turn->options.lane,
      samples,
      sample_count * sizeof(*samples),
      captured_through_at_us / 1000U);
  if (status == ITERATE_KIT_OK) {
    atomic_saturating_increment(&turn->frames_accepted);
    notify_uplink(turn);
  } else if (status == ITERATE_KIT_BACKPRESSURE) {
    atomic_saturating_increment(&turn->frame_backpressure);
    notify_uplink(turn);
  } else {
    atomic_saturating_increment(&turn->frame_failures);
  }
  return status;
}

bool iterate_kit_pcm_capture_turn_is_active(
    const struct iterate_kit_pcm_capture_turn *turn) {
  return turn != NULL && turn->initialized &&
      atomic_load_relaxed(&turn->consumer_active) != 0U;
}

void iterate_kit_pcm_capture_turn_metrics(
    const struct iterate_kit_pcm_capture_turn *turn,
    struct iterate_kit_pcm_capture_turn_metrics *metrics) {
  if (metrics == NULL) {
    return;
  }
  memset(metrics, 0, sizeof(*metrics));
  if (turn == NULL || !turn->initialized) {
    return;
  }

  iterate_kit_spsc_ring_metrics(
      &turn->command_ring, &metrics->commands);
#define COPY_ATOMIC_METRIC(name) \
  metrics->name = atomic_load_relaxed(&turn->name)
  COPY_ATOMIC_METRIC(commands_accepted);
  COPY_ATOMIC_METRIC(command_backpressure);
  COPY_ATOMIC_METRIC(command_protocol_errors);
  COPY_ATOMIC_METRIC(transitions_applied);
  COPY_ATOMIC_METRIC(inactive_frames_discarded);
  COPY_ATOMIC_METRIC(frames_accepted);
  COPY_ATOMIC_METRIC(frame_backpressure);
  COPY_ATOMIC_METRIC(frame_failures);
  COPY_ATOMIC_METRIC(end_markers_accepted);
  COPY_ATOMIC_METRIC(end_markers_suppressed);
  COPY_ATOMIC_METRIC(end_marker_backpressure);
  COPY_ATOMIC_METRIC(end_marker_failures);
#undef COPY_ATOMIC_METRIC
  metrics->requested_active =
      atomic_load_relaxed(
          &turn->producer_requested_active) != 0U;
  metrics->active =
      atomic_load_relaxed(&turn->consumer_active) != 0U;
}
