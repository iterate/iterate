#include "iterate/kit/pcm_uplink_conductor.h"

#include <limits.h>
#include <string.h>

/*
 * The conductor is the portable scheduling policy at the point where three
 * independently useful abstractions meet:
 *
 *   microphone SPSC ring -> retained-frame sender -> WebSocket transmitter
 *
 * Leaving these calls in an ESP-IDF task looked small, but it made their order
 * an untested platform convention. That order is the realtime guarantee. A
 * mandatory control reply must not be starved by a send burst; a
 * partially-written PCM frame must still finish atomically; and any
 * recoverable restart must purge both the application epoch and
 * connection-bound transmit bytes.
 *
 * No second PCM queue is introduced here. The sender retains a read-acquired
 * ring slot during short writes, and the WebSocket transmitter owns its one
 * fixed frame workspace. Another queue would cost RAM while increasing the
 * amount of speech that can become stale—the opposite of the requirement.
 */

static uint32_t atomic_load_u32(const uint32_t *value) {
  return __atomic_load_n(value, __ATOMIC_RELAXED);
}

static void atomic_saturating_increment(uint32_t *value) {
  uint32_t current = atomic_load_u32(value);
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
  uint32_t current = atomic_load_u32(value);
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

static uint32_t saturating_u64_to_u32(uint64_t value) {
  return value > UINT32_MAX ? UINT32_MAX : (uint32_t)value;
}

/*
 * There are two different apparent "backwards time" cases and conflating them
 * caused the original composition bug.
 *
 * - A later owner call with a smaller sampled_now_ms means the owner's
 *   monotonic source regressed. Freshness deadlines are no longer trustworthy,
 *   so this is a local failure.
 * - A microphone timestamp may be newer than the owner's most recent sample
 *   because the producer runs concurrently on another core. The accepted frame
 *   establishes a policy floor; equal cached owner samples are clamped to it.
 *
 * The adjustment is observable because excessive producer/consumer skew is
 * useful scheduling evidence even though it is not a correctness failure.
 */
static bool normalize_policy_time(
    struct iterate_kit_pcm_uplink_conductor *conductor,
    uint64_t sampled_now_ms,
    uint64_t *policy_now_ms) {
  uint64_t normalized_now_ms;
  if (conductor->has_last_sample &&
      sampled_now_ms < conductor->last_sampled_now_ms) {
    atomic_saturating_increment(
        &conductor->owner_clock_regressions);
    return false;
  }
  conductor->last_sampled_now_ms = sampled_now_ms;
  conductor->has_last_sample = true;
  normalized_now_ms = sampled_now_ms;
  if (normalized_now_ms < conductor->policy_time_floor_ms) {
    const uint64_t adjustment_ms =
        conductor->policy_time_floor_ms - normalized_now_ms;
    normalized_now_ms = conductor->policy_time_floor_ms;
    atomic_saturating_increment(
        &conductor->policy_time_normalizations);
    atomic_update_max(
        &conductor->maximum_policy_time_adjustment_ms,
        saturating_u64_to_u32(adjustment_ms));
  }
  *policy_now_ms = normalized_now_ms;
  return true;
}

/*
 * This callback deliberately terminates at the portable sans-I/O transmitter.
 * ESP-IDF's only responsibility is the nonblocking raw byte-stream callback.
 * As a result, the host harness exercises the exact framing, partial-write,
 * control-priority, and sender-retention composition used on the device.
 */
static enum iterate_kit_pcm_uplink_send_outcome
send_pcm_frame(
    void *context, const void *frame, size_t frame_bytes) {
  struct iterate_kit_pcm_uplink_conductor *conductor =
      context;
  const enum iterate_kit_websocket_tx_result result =
      iterate_kit_websocket_tx_send(
          conductor->tx,
          ITERATE_KIT_WEBSOCKET_BINARY,
          frame,
          frame_bytes);
  switch (result) {
    case ITERATE_KIT_WEBSOCKET_TX_SENT:
      return ITERATE_KIT_PCM_UPLINK_SEND_COMPLETE;
    case ITERATE_KIT_WEBSOCKET_TX_PROGRESS:
      return ITERATE_KIT_PCM_UPLINK_SEND_PROGRESS;
    case ITERATE_KIT_WEBSOCKET_TX_DEFERRED:
      return
          ITERATE_KIT_PCM_UPLINK_SEND_TEMPORARILY_UNAVAILABLE;
    case ITERATE_KIT_WEBSOCKET_TX_DISCONNECTED:
      return ITERATE_KIT_PCM_UPLINK_SEND_DISCONNECTED;
    case ITERATE_KIT_WEBSOCKET_TX_FAILED:
    case ITERATE_KIT_WEBSOCKET_TX_IDLE:
    default:
      return ITERATE_KIT_PCM_UPLINK_SEND_FAILED;
  }
}

enum iterate_kit_status iterate_kit_pcm_uplink_conductor_init(
    struct iterate_kit_pcm_uplink_conductor *conductor,
    const struct iterate_kit_pcm_uplink_conductor_options
        *options) {
  struct iterate_kit_pcm_uplink_sender_options sender_options;
  enum iterate_kit_status status;
  if (conductor == NULL ||
      options == NULL ||
      options->lane == NULL ||
      !options->lane->initialized ||
      options->tx == NULL ||
      !options->tx->initialized ||
      options->maximum_work_steps == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  memset(conductor, 0, sizeof(*conductor));
  conductor->tx = options->tx;
  conductor->maximum_work_steps =
      options->maximum_work_steps;

  sender_options =
      (struct iterate_kit_pcm_uplink_sender_options){
        .lane = options->lane,
        .send = send_pcm_frame,
        .send_context = conductor,
        .restart_after_no_progress_ms =
            options->restart_after_no_progress_ms,
        .maximum_frame_send_duration_ms =
            options->maximum_frame_send_duration_ms,
        .maximum_capture_age_ms =
            options->maximum_capture_age_ms,
      };
  status = iterate_kit_pcm_uplink_sender_init(
      &conductor->sender, &sender_options);
  if (status != ITERATE_KIT_OK) {
    memset(conductor, 0, sizeof(*conductor));
    return status;
  }

  conductor->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status
iterate_kit_pcm_uplink_conductor_discard_pending(
    struct iterate_kit_pcm_uplink_conductor *conductor,
    uint32_t *discarded_frames) {
  if (discarded_frames != NULL) {
    *discarded_frames = 0U;
  }
  if (conductor == NULL ||
      !conductor->initialized ||
      discarded_frames == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  return iterate_kit_pcm_uplink_sender_discard_pending(
      &conductor->sender, discarded_frames);
}

enum iterate_kit_status
iterate_kit_pcm_uplink_conductor_abandon_generation(
    struct iterate_kit_pcm_uplink_conductor *conductor,
    uint32_t *discarded_frames) {
  enum iterate_kit_status status;
  if (discarded_frames != NULL) {
    *discarded_frames = 0U;
  }
  if (conductor == NULL ||
      !conductor->initialized ||
      discarded_frames == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  /*
   * Release the sender's acquired ring slot before resetting its WebSocket
   * frame. That order makes ownership explicit: after this function returns,
   * neither the application ring nor the transmitter can retain bytes from the
   * old socket. The platform closes the socket itself immediately afterward to
   * make the same statement about opaque lower layers.
   */
  status = iterate_kit_pcm_uplink_sender_discard_pending(
      &conductor->sender, discarded_frames);
  iterate_kit_websocket_tx_reset(conductor->tx);
  conductor->generation_active = false;
  return status;
}

enum iterate_kit_status
iterate_kit_pcm_uplink_conductor_begin_generation(
    struct iterate_kit_pcm_uplink_conductor *conductor,
    uint32_t connection_generation,
    uint32_t *discarded_frames) {
  enum iterate_kit_status status;
  if (discarded_frames != NULL) {
    *discarded_frames = 0U;
  }
  if (conductor == NULL ||
      !conductor->initialized ||
      discarded_frames == NULL ||
      connection_generation == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (conductor->generation_active ||
      connection_generation <=
          conductor->connection_generation) {
    return ITERATE_KIT_STATE_ERROR;
  }

  status = iterate_kit_pcm_uplink_sender_discard_pending(
      &conductor->sender, discarded_frames);
  iterate_kit_websocket_tx_reset(conductor->tx);
  if (status != ITERATE_KIT_OK) {
    return status;
  }
  conductor->connection_generation = connection_generation;
  conductor->generation_active = true;
  return ITERATE_KIT_OK;
}

/*
 * Both expected recovery and local failure must leave a closed local epoch.
 * The result stays distinct for telemetry and platform policy, but failure to
 * perform the purge itself upgrades a recoverable restart to FAILED: claiming
 * recovery while stale slots remain would violate the API's strongest
 * postcondition.
 */
static enum iterate_kit_pcm_uplink_conductor_poll_result
finish_generation(
    struct iterate_kit_pcm_uplink_conductor *conductor,
    enum iterate_kit_pcm_uplink_conductor_poll_result result) {
  uint32_t discarded_frames;
  if (iterate_kit_pcm_uplink_conductor_abandon_generation(
          conductor, &discarded_frames) != ITERATE_KIT_OK) {
    return ITERATE_KIT_PCM_UPLINK_CONDUCTOR_FAILED;
  }
  (void)discarded_frames;
  return result;
}

enum iterate_kit_pcm_uplink_conductor_poll_result
iterate_kit_pcm_uplink_conductor_poll(
    struct iterate_kit_pcm_uplink_conductor *conductor,
    uint64_t sampled_now_ms) {
  uint64_t policy_now_ms;
  uint32_t step;
  bool made_progress = false;
  if (conductor == NULL ||
      !conductor->initialized ||
      !conductor->generation_active) {
    return ITERATE_KIT_PCM_UPLINK_CONDUCTOR_FAILED;
  }
  if (!normalize_policy_time(
          conductor, sampled_now_ms, &policy_now_ms)) {
    return finish_generation(
        conductor, ITERATE_KIT_PCM_UPLINK_CONDUCTOR_FAILED);
  }

  for (step = 0U;
       step < conductor->maximum_work_steps;
       ++step) {
    enum iterate_kit_websocket_tx_result control_result;
    enum iterate_kit_pcm_uplink_sender_poll_result
        sender_result;
    struct iterate_kit_pcm_uplink_sender_event event;
    bool data_frame_active;

    /*
     * PONG replies and CLOSE have RFC ordering meaning. Service one control
     * write before considering fresh PCM in every round. A partially-written
     * data frame is the sole exception: RFC 6455 forbids interleaving another
     * frame into it, so the sender must finish that bounded frame before the
     * queued control can own the wire.
     */
    control_result =
        iterate_kit_websocket_tx_poll_control(conductor->tx);
    if (control_result ==
        ITERATE_KIT_WEBSOCKET_TX_DISCONNECTED) {
      return finish_generation(
          conductor,
          ITERATE_KIT_PCM_UPLINK_CONDUCTOR_RESTART);
    }
    if (control_result == ITERATE_KIT_WEBSOCKET_TX_FAILED) {
      return finish_generation(
          conductor,
          ITERATE_KIT_PCM_UPLINK_CONDUCTOR_FAILED);
    }

    if (control_result == ITERATE_KIT_WEBSOCKET_TX_SENT ||
        control_result ==
            ITERATE_KIT_WEBSOCKET_TX_PROGRESS) {
      made_progress = true;
      continue;
    }
    data_frame_active =
        control_result == ITERATE_KIT_WEBSOCKET_TX_DEFERRED &&
        conductor->tx->active_kind ==
            ITERATE_KIT_WEBSOCKET_TX_ACTIVE_DATA;
    if (control_result ==
            ITERATE_KIT_WEBSOCKET_TX_DEFERRED &&
        !data_frame_active) {
      /*
       * An active control frame reached a would-block boundary. Acquiring a new
       * microphone slot cannot help it and would start that frame's age budget
       * early, so leave the ring untouched until the stream is writable.
       */
      return made_progress
          ? ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS
          : ITERATE_KIT_PCM_UPLINK_CONDUCTOR_DEFERRED;
    }
    sender_result = iterate_kit_pcm_uplink_sender_poll(
        &conductor->sender, policy_now_ms, &event);
    if (sender_result == ITERATE_KIT_PCM_UPLINK_SENDER_SENT) {
      /*
       * Advance the local policy floor to the sender's normalized acceptance
       * boundary. The producer can publish a capture timestamp just after the
       * owner sampled its clock; without this floor the next same-sample pass
       * would make a fresh frame look as if time moved backwards.
       */
      if (!event.transport_accepted) {
        return finish_generation(
            conductor,
            ITERATE_KIT_PCM_UPLINK_CONDUCTOR_FAILED);
      }
      if (policy_now_ms <
          event.transport_accepted_at_ms) {
        policy_now_ms = event.transport_accepted_at_ms;
      }
      if (conductor->policy_time_floor_ms <
          event.transport_accepted_at_ms) {
        conductor->policy_time_floor_ms =
            event.transport_accepted_at_ms;
      }
      made_progress = true;
      continue;
    }
    if (sender_result ==
        ITERATE_KIT_PCM_UPLINK_SENDER_PROGRESS) {
      made_progress = true;
      continue;
    }
    if (sender_result ==
        ITERATE_KIT_PCM_UPLINK_SENDER_DEFERRED) {
      return made_progress
          ? ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS
          : ITERATE_KIT_PCM_UPLINK_CONDUCTOR_DEFERRED;
    }
    if (sender_result ==
        ITERATE_KIT_PCM_UPLINK_SENDER_RESTART) {
      return finish_generation(
          conductor,
          ITERATE_KIT_PCM_UPLINK_CONDUCTOR_RESTART);
    }
    if (sender_result ==
        ITERATE_KIT_PCM_UPLINK_SENDER_FAILED) {
      return finish_generation(
          conductor,
          ITERATE_KIT_PCM_UPLINK_CONDUCTOR_FAILED);
    }
    if (sender_result == ITERATE_KIT_PCM_UPLINK_SENDER_IDLE) {
      /*
       * An active data frame without a retained sender slot would mean two
       * state machines disagree about ownership. Never normalize that as idle:
       * resetting the generation is the only safe way to prevent malformed
       * continuation bytes from leaking onto the socket.
       */
      if (data_frame_active) {
        return finish_generation(
            conductor,
            ITERATE_KIT_PCM_UPLINK_CONDUCTOR_FAILED);
      }
      return made_progress
          ? ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS
          : ITERATE_KIT_PCM_UPLINK_CONDUCTOR_IDLE;
    }
    return finish_generation(
        conductor, ITERATE_KIT_PCM_UPLINK_CONDUCTOR_FAILED);
  }

  /*
   * Exhausting the cooperative budget is not backpressure: useful work moved,
   * and the caller should schedule another prompt pass after giving receive
   * and other device work a chance to run.
   */
  return made_progress
      ? ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS
      : ITERATE_KIT_PCM_UPLINK_CONDUCTOR_DEFERRED;
}

void iterate_kit_pcm_uplink_conductor_metrics(
    const struct iterate_kit_pcm_uplink_conductor *conductor,
    struct iterate_kit_pcm_uplink_conductor_metrics *metrics) {
  if (metrics == NULL) {
    return;
  }
  memset(metrics, 0, sizeof(*metrics));
  if (conductor == NULL || !conductor->initialized) {
    return;
  }
  iterate_kit_pcm_uplink_sender_metrics(
      &conductor->sender, &metrics->sender);
  metrics->policy_time_normalizations =
      atomic_load_u32(
          &conductor->policy_time_normalizations);
  metrics->maximum_policy_time_adjustment_ms =
      atomic_load_u32(
          &conductor->maximum_policy_time_adjustment_ms);
  metrics->owner_clock_regressions =
      atomic_load_u32(&conductor->owner_clock_regressions);
}
