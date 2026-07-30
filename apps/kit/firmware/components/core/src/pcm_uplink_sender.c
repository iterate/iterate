#include "iterate/kit/pcm_uplink_sender.h"

#include <limits.h>
#include <string.h>

/*
 * The sender is the ownership bridge between the microphone SPSC ring and one
 * nonblocking WebSocket data-frame writer. It retains the acquired ring slot
 * until the complete frame is accepted or the whole microphone epoch is
 * abandoned; copying into another queue would consume RAM while merely moving
 * the same stale-audio problem one layer down.
 *
 * The owner mutates frame state from one task. Metrics use relaxed atomics
 * because another core may sample them, but no metric authorizes work or
 * transfers ownership. The producer timestamp is the one deliberate cross-task
 * time boundary: it can be one scheduler tick newer than the consumer's
 * already-sampled `now_ms`. That skew is normalized to age zero below. Treating
 * it as clock corruption would turn ordinary multicore scheduling into a
 * permanent fatal transport failure.
 */
static uint32_t atomic_load_relaxed(const uint32_t *value) {
  return __atomic_load_n(value, __ATOMIC_RELAXED);
}

static void atomic_store_relaxed(
    uint32_t *destination, uint32_t value) {
  __atomic_store_n(destination, value, __ATOMIC_RELAXED);
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

static void atomic_update_max(
    uint32_t *value, uint32_t candidate) {
  uint32_t current = atomic_load_relaxed(value);
  while (candidate > current &&
         !__atomic_compare_exchange_n(
             value,
             &current,
             candidate,
             false,
             __ATOMIC_RELAXED,
             __ATOMIC_RELAXED)) {
  }
}

static uint32_t saturating_age_ms(
    uint64_t now_ms, uint64_t then_ms) {
  const uint64_t age_ms =
      now_ms > then_ms ? now_ms - then_ms : 0U;
  return age_ms > UINT32_MAX ? UINT32_MAX : (uint32_t)age_ms;
}

/*
 * Normalize only within the retained frame's timeline. `esp_timer` itself is
 * monotonic; the apparent reversal comes from sampling it before a concurrent
 * producer publishes a newer timestamp, or from reusing one pass timestamp for
 * several nonblocking writes. Clamping to the latest known boundary prevents
 * unsigned age underflow and makes no claim that time advanced while the
 * consumer was not looking.
 */
static uint64_t frame_policy_now_ms(
    const struct iterate_kit_pcm_uplink_sender *sender,
    uint64_t sampled_now_ms) {
  uint64_t normalized = sampled_now_ms;
  if (normalized < sender->pending_capture_completed_at_ms) {
    normalized = sender->pending_capture_completed_at_ms;
  }
  if (normalized < sender->frame_started_at_ms) {
    normalized = sender->frame_started_at_ms;
  }
  if (normalized < sender->last_progress_at_ms) {
    normalized = sender->last_progress_at_ms;
  }
  return normalized;
}

static void clear_pending(
    struct iterate_kit_pcm_uplink_sender *sender) {
  sender->pending_frame = NULL;
  sender->pending_frame_bytes = 0U;
  sender->pending_capture_completed_at_ms = 0U;
  sender->frame_started_at_ms = 0U;
  sender->last_progress_at_ms = 0U;
  sender->frame_acquired = false;
}

static enum iterate_kit_status release_pending(
    struct iterate_kit_pcm_uplink_sender *sender) {
  enum iterate_kit_status status;
  if (!sender->frame_acquired) {
    return ITERATE_KIT_STATE_ERROR;
  }
  status = iterate_kit_pcm_lane_uplink_release(
      sender->options.lane);
  if (status == ITERATE_KIT_OK) {
    clear_pending(sender);
  }
  return status;
}

static enum iterate_kit_status acquire_if_needed(
    struct iterate_kit_pcm_uplink_sender *sender,
    uint64_t now_ms) {
  enum iterate_kit_status status;
  if (sender->frame_acquired) {
    return ITERATE_KIT_OK;
  }
  status = iterate_kit_pcm_lane_uplink_acquire(
      sender->options.lane,
      &sender->pending_frame,
      &sender->pending_frame_bytes,
      &sender->pending_capture_completed_at_ms);
  if (status == ITERATE_KIT_OK) {
    const uint64_t normalized_now_ms =
        now_ms < sender->pending_capture_completed_at_ms
            ? sender->pending_capture_completed_at_ms
            : now_ms;
    sender->frame_acquired = true;
    sender->frame_started_at_ms = normalized_now_ms;
    sender->last_progress_at_ms = normalized_now_ms;
  }
  return status;
}

static enum iterate_kit_pcm_uplink_sender_poll_result
restart_for_freshness(
    struct iterate_kit_pcm_uplink_sender *sender,
    enum iterate_kit_pcm_uplink_restart_reason reason,
    uint64_t now_ms) {
  uint32_t discarded_frames = 0U;
  uint32_t oldest_capture_age_ms;
  uint64_t normalized_now_ms;
  uint32_t *reason_counter = NULL;
  enum iterate_kit_status status;
  switch (reason) {
    case ITERATE_KIT_PCM_UPLINK_RESTART_PRODUCER_BACKPRESSURE:
      reason_counter = &sender->producer_backpressure_restarts;
      break;
    case ITERATE_KIT_PCM_UPLINK_RESTART_TRANSPORT_DISCONNECTED:
      reason_counter = &sender->transport_disconnect_restarts;
      break;
    case ITERATE_KIT_PCM_UPLINK_RESTART_NO_PROGRESS_TIMEOUT:
      reason_counter = &sender->no_progress_timeout_restarts;
      break;
    case ITERATE_KIT_PCM_UPLINK_RESTART_FRAME_SEND_TIMEOUT:
      reason_counter = &sender->frame_send_timeout_restarts;
      break;
    case ITERATE_KIT_PCM_UPLINK_RESTART_CAPTURE_STALE:
      reason_counter = &sender->capture_stale_restarts;
      break;
    case ITERATE_KIT_PCM_UPLINK_RESTART_NONE:
    default:
      atomic_saturating_increment(&sender->send_failures);
      return ITERATE_KIT_PCM_UPLINK_SENDER_FAILED;
  }
  status = acquire_if_needed(sender, now_ms);
  if (status != ITERATE_KIT_OK) {
    atomic_saturating_increment(&sender->send_failures);
    return ITERATE_KIT_PCM_UPLINK_SENDER_FAILED;
  }
  normalized_now_ms =
      frame_policy_now_ms(sender, now_ms);
  oldest_capture_age_ms = saturating_age_ms(
      normalized_now_ms,
      sender->pending_capture_completed_at_ms);
  if (iterate_kit_pcm_uplink_sender_discard_pending(
          sender, &discarded_frames) != ITERATE_KIT_OK) {
    atomic_saturating_increment(&sender->send_failures);
    return ITERATE_KIT_PCM_UPLINK_SENDER_FAILED;
  }
  atomic_saturating_increment(&sender->restart_incidents);
  atomic_saturating_increment(reason_counter);
  atomic_store_relaxed(
      &sender->last_restart_oldest_capture_age_ms,
      oldest_capture_age_ms);
  atomic_store_relaxed(
      &sender->last_restart_frames_discarded,
      discarded_frames);
  atomic_store_relaxed(
      &sender->last_restart_reason, (uint32_t)reason);
  return ITERATE_KIT_PCM_UPLINK_SENDER_RESTART;
}

enum iterate_kit_status iterate_kit_pcm_uplink_sender_init(
    struct iterate_kit_pcm_uplink_sender *sender,
    const struct iterate_kit_pcm_uplink_sender_options *options) {
  if (sender == NULL ||
      options == NULL ||
      options->lane == NULL ||
      !options->lane->initialized ||
      options->send == NULL ||
      options->restart_after_no_progress_ms == 0U ||
      options->maximum_capture_age_ms == 0U ||
      options->maximum_frame_send_duration_ms <
          options->restart_after_no_progress_ms) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(sender, 0, sizeof(*sender));
  sender->options = *options;
  sender->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_pcm_uplink_sender_poll_result
iterate_kit_pcm_uplink_sender_poll(
    struct iterate_kit_pcm_uplink_sender *sender,
    uint64_t now_ms,
    struct iterate_kit_pcm_uplink_sender_event *event) {
  enum iterate_kit_status queue_status;
  enum iterate_kit_pcm_uplink_send_outcome outcome;
  uint32_t consecutive;
  uint64_t normalized_now_ms;
  bool epoch_reset_requested = false;
  if (event != NULL) {
    memset(event, 0, sizeof(*event));
  }
  if (sender == NULL || !sender->initialized) {
    return ITERATE_KIT_PCM_UPLINK_SENDER_FAILED;
  }

  queue_status =
      iterate_kit_pcm_lane_take_uplink_epoch_reset_request(
          sender->options.lane, &epoch_reset_requested);
  if (queue_status != ITERATE_KIT_OK) {
    atomic_saturating_increment(&sender->send_failures);
    return ITERATE_KIT_PCM_UPLINK_SENDER_FAILED;
  }
  if (epoch_reset_requested) {
    return restart_for_freshness(
        sender,
        ITERATE_KIT_PCM_UPLINK_RESTART_PRODUCER_BACKPRESSURE,
        now_ms);
  }

  queue_status = acquire_if_needed(sender, now_ms);
  if (queue_status == ITERATE_KIT_UNAVAILABLE) {
    return ITERATE_KIT_PCM_UPLINK_SENDER_IDLE;
  }
  if (queue_status != ITERATE_KIT_OK) {
    atomic_saturating_increment(&sender->send_failures);
    return ITERATE_KIT_PCM_UPLINK_SENDER_FAILED;
  }
  normalized_now_ms =
      frame_policy_now_ms(sender, now_ms);
  if (normalized_now_ms -
          sender->pending_capture_completed_at_ms >=
      sender->options.maximum_capture_age_ms) {
    return restart_for_freshness(
        sender,
        ITERATE_KIT_PCM_UPLINK_RESTART_CAPTURE_STALE,
        normalized_now_ms);
  }
  if (normalized_now_ms - sender->frame_started_at_ms >=
      sender->options.maximum_frame_send_duration_ms) {
    return restart_for_freshness(
        sender,
        ITERATE_KIT_PCM_UPLINK_RESTART_FRAME_SEND_TIMEOUT,
        normalized_now_ms);
  }
  outcome = sender->options.send(
      sender->options.send_context,
      sender->pending_frame,
      sender->pending_frame_bytes);

  if (outcome == ITERATE_KIT_PCM_UPLINK_SEND_COMPLETE) {
    const uint32_t capture_age_ms = saturating_age_ms(
        normalized_now_ms,
        sender->pending_capture_completed_at_ms);
    if (event != NULL) {
      event->capture_completed_at_ms =
          sender->pending_capture_completed_at_ms;
      event->transport_accepted_at_ms = normalized_now_ms;
      event->transport_accepted = true;
    }
    if (release_pending(sender) != ITERATE_KIT_OK) {
      atomic_saturating_increment(&sender->send_failures);
      return ITERATE_KIT_PCM_UPLINK_SENDER_FAILED;
    }
    atomic_store_relaxed(
        &sender->consecutive_send_deferrals, 0U);
    atomic_saturating_increment(&sender->frames_sent);
    atomic_store_relaxed(
        &sender->last_transport_accept_age_ms,
        capture_age_ms);
    atomic_update_max(
        &sender->maximum_transport_accept_age_ms,
        capture_age_ms);
    return ITERATE_KIT_PCM_UPLINK_SENDER_SENT;
  }

  if (outcome == ITERATE_KIT_PCM_UPLINK_SEND_PROGRESS) {
    sender->last_progress_at_ms = normalized_now_ms;
    atomic_store_relaxed(
        &sender->consecutive_send_deferrals, 0U);
    return ITERATE_KIT_PCM_UPLINK_SENDER_PROGRESS;
  }

  if (outcome ==
      ITERATE_KIT_PCM_UPLINK_SEND_TEMPORARILY_UNAVAILABLE) {
    atomic_saturating_increment(&sender->send_deferrals);
    consecutive = atomic_load_relaxed(
        &sender->consecutive_send_deferrals);
    if (consecutive != UINT32_MAX) {
      ++consecutive;
    }
    atomic_store_relaxed(
        &sender->consecutive_send_deferrals, consecutive);
    atomic_update_max(
        &sender->maximum_consecutive_send_deferrals,
        consecutive);
    if (normalized_now_ms - sender->last_progress_at_ms <
        sender->options.restart_after_no_progress_ms) {
      return ITERATE_KIT_PCM_UPLINK_SENDER_DEFERRED;
    }
    return restart_for_freshness(
        sender,
        ITERATE_KIT_PCM_UPLINK_RESTART_NO_PROGRESS_TIMEOUT,
        normalized_now_ms);
  }

  if (outcome == ITERATE_KIT_PCM_UPLINK_SEND_DISCONNECTED) {
    return restart_for_freshness(
        sender,
        ITERATE_KIT_PCM_UPLINK_RESTART_TRANSPORT_DISCONNECTED,
        normalized_now_ms);
  }

  atomic_saturating_increment(&sender->send_failures);
  return ITERATE_KIT_PCM_UPLINK_SENDER_FAILED;
}

enum iterate_kit_status iterate_kit_pcm_uplink_sender_discard_pending(
    struct iterate_kit_pcm_uplink_sender *sender,
    uint32_t *discarded_frames) {
  uint32_t discarded = 0U;
  enum iterate_kit_status status;
  bool reset_requested;
  if (discarded_frames != NULL) {
    *discarded_frames = 0U;
  }
  if (sender == NULL ||
      !sender->initialized ||
      discarded_frames == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  status =
      iterate_kit_pcm_lane_take_uplink_epoch_reset_request(
          sender->options.lane, &reset_requested);
  if (status != ITERATE_KIT_OK) {
    return status;
  }
  (void)reset_requested;

  for (;;) {
    status = acquire_if_needed(sender, 0U);
    if (status == ITERATE_KIT_UNAVAILABLE) {
      break;
    }
    if (status != ITERATE_KIT_OK ||
        release_pending(sender) != ITERATE_KIT_OK) {
      return status == ITERATE_KIT_OK
          ? ITERATE_KIT_STATE_ERROR
          : status;
    }
    if (discarded != UINT32_MAX) {
      ++discarded;
    }
    atomic_saturating_increment(&sender->frames_discarded);
  }
  atomic_store_relaxed(
      &sender->consecutive_send_deferrals, 0U);
  *discarded_frames = discarded;
  return ITERATE_KIT_OK;
}

void iterate_kit_pcm_uplink_sender_metrics(
    const struct iterate_kit_pcm_uplink_sender *sender,
    struct iterate_kit_pcm_uplink_sender_metrics *metrics) {
  if (metrics == NULL) {
    return;
  }
  memset(metrics, 0, sizeof(*metrics));
  if (sender == NULL || !sender->initialized) {
    return;
  }
  metrics->frames_sent =
      atomic_load_relaxed(&sender->frames_sent);
  metrics->frames_discarded =
      atomic_load_relaxed(&sender->frames_discarded);
  metrics->send_deferrals =
      atomic_load_relaxed(&sender->send_deferrals);
  metrics->send_failures =
      atomic_load_relaxed(&sender->send_failures);
  metrics->consecutive_send_deferrals = atomic_load_relaxed(
      &sender->consecutive_send_deferrals);
  metrics->maximum_consecutive_send_deferrals =
      atomic_load_relaxed(
          &sender->maximum_consecutive_send_deferrals);
  metrics->restart_incidents =
      atomic_load_relaxed(&sender->restart_incidents);
  metrics->producer_backpressure_restarts =
      atomic_load_relaxed(
          &sender->producer_backpressure_restarts);
  metrics->transport_disconnect_restarts =
      atomic_load_relaxed(
          &sender->transport_disconnect_restarts);
  metrics->no_progress_timeout_restarts =
      atomic_load_relaxed(
          &sender->no_progress_timeout_restarts);
  metrics->frame_send_timeout_restarts =
      atomic_load_relaxed(
          &sender->frame_send_timeout_restarts);
  metrics->capture_stale_restarts =
      atomic_load_relaxed(
          &sender->capture_stale_restarts);
  metrics->last_transport_accept_age_ms =
      atomic_load_relaxed(
          &sender->last_transport_accept_age_ms);
  metrics->maximum_transport_accept_age_ms =
      atomic_load_relaxed(
          &sender->maximum_transport_accept_age_ms);
  metrics->last_restart_oldest_capture_age_ms =
      atomic_load_relaxed(
          &sender->last_restart_oldest_capture_age_ms);
  metrics->last_restart_frames_discarded =
      atomic_load_relaxed(
          &sender->last_restart_frames_discarded);
  metrics->last_restart_reason =
      (enum iterate_kit_pcm_uplink_restart_reason)
          atomic_load_relaxed(&sender->last_restart_reason);
}

const char *iterate_kit_pcm_uplink_restart_reason_name(
    enum iterate_kit_pcm_uplink_restart_reason reason) {
  switch (reason) {
    case ITERATE_KIT_PCM_UPLINK_RESTART_NONE:
      return "none";
    case ITERATE_KIT_PCM_UPLINK_RESTART_PRODUCER_BACKPRESSURE:
      return "producer_backpressure";
    case ITERATE_KIT_PCM_UPLINK_RESTART_TRANSPORT_DISCONNECTED:
      return "transport_disconnected";
    case ITERATE_KIT_PCM_UPLINK_RESTART_NO_PROGRESS_TIMEOUT:
      return "no_progress_timeout";
    case ITERATE_KIT_PCM_UPLINK_RESTART_FRAME_SEND_TIMEOUT:
      return "frame_send_timeout";
    case ITERATE_KIT_PCM_UPLINK_RESTART_CAPTURE_STALE:
      return "capture_stale";
  }
  return "unknown";
}
