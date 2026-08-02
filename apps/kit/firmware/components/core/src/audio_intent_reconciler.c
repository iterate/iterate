#include "iterate/kit/audio_intent_reconciler.h"

#include <limits.h>
#include <string.h>

static void increment(uint32_t *value) {
  if (*value != UINT32_MAX) {
    ++*value;
  }
}

static bool effective_uplink_active(
    const struct iterate_kit_audio_intent_reconciler *reconciler) {
  return reconciler->desired_uplink_active &&
      reconciler->media_ready;
}

static void refresh_command_pending(
    struct iterate_kit_audio_intent_reconciler *reconciler) {
  reconciler->command_pending =
      reconciler->applied_uplink_active !=
      effective_uplink_active(reconciler);
}

enum iterate_kit_status iterate_kit_audio_intent_reconciler_init(
    struct iterate_kit_audio_intent_reconciler *reconciler,
    enum iterate_kit_audio_mode mode,
    const struct iterate_kit_audio_intent_ops *ops) {
  if (reconciler == NULL || ops == NULL ||
      (mode != ITERATE_KIT_AUDIO_PUSH_TO_TALK &&
       mode != ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC) ||
      ops->request_uplink_active == NULL ||
      ops->request_playback_reset == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(reconciler, 0, sizeof(*reconciler));
  reconciler->ops = *ops;
  reconciler->mode = mode;
  reconciler->failure = ITERATE_KIT_OK;
  /*
   * Both capture-turn owners are zero-initialized inactive. Recording that
   * known physical baseline avoids sending a redundant false command when a
   * start and stop collapse before media becomes ready.
   */
  reconciler->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_audio_intent_reconciler_handle(
    void *context, const struct iterate_kit_device_event *event) {
  struct iterate_kit_audio_intent_reconciler *reconciler = context;
  bool requests_uplink = false;
  bool uplink_active = false;
  bool resets_playback = false;
  if (reconciler == NULL || event == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (!reconciler->initialized) {
    return ITERATE_KIT_STATE_ERROR;
  }

  switch ((enum iterate_kit_device_event_type)event->type) {
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED:
      if (reconciler->mode ==
          ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC) {
        /*
         * The AEC owner is already processing aligned microphone/reference
         * audio. This edge opens only clean-frame publication; server VAD
         * then receives a live sequence without a manual turn boundary.
         */
        requests_uplink = true;
        uplink_active = true;
      }
      break;
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED:
      if (reconciler->mode !=
          ITERATE_KIT_AUDIO_PUSH_TO_TALK) {
        return ITERATE_KIT_INVALID_ARGUMENT;
      }
      requests_uplink = true;
      uplink_active = true;
      resets_playback = true;
      break;
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED:
      if (reconciler->mode !=
          ITERATE_KIT_AUDIO_PUSH_TO_TALK) {
        return ITERATE_KIT_INVALID_ARGUMENT;
      }
      requests_uplink = true;
      break;
    case ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED:
      /*
       * Hang-up contains a possibly missing physical/button release. Retaining
       * the final false intent here is what prevents capture from remaining
       * live merely because the lower one-slot mailbox rejected this pass.
       */
      requests_uplink = true;
      resets_playback = true;
      break;
    case ITERATE_KIT_DEVICE_EVENT_TYPE_COUNT:
    default:
      return ITERATE_KIT_INVALID_ARGUMENT;
  }

  increment(&reconciler->intent_edges);
  if (resets_playback) {
    reconciler->ops.request_playback_reset(reconciler->ops.context);
    increment(&reconciler->playback_resets);
  }
  if (requests_uplink) {
    reconciler->desired_uplink_active = uplink_active;
    refresh_command_pending(reconciler);
  }

  /*
   * A failed audio owner cannot safely accept a new start. Teardown remains
   * accepted because the profile must still converge to an idle public state;
   * the sticky failure and unfulfilled stop remain visible in metrics.
   */
  if (reconciler->failure != ITERATE_KIT_OK && uplink_active) {
    return reconciler->failure;
  }
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_audio_intent_reconciler_set_media_ready(
    struct iterate_kit_audio_intent_reconciler *reconciler,
    bool ready) {
  if (reconciler == NULL || !reconciler->initialized) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (reconciler->media_ready == ready) {
    return ITERATE_KIT_OK;
  }

  reconciler->media_ready = ready;
  increment(&reconciler->media_readiness_edges);
  refresh_command_pending(reconciler);
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_audio_intent_reconciler_poll(
    struct iterate_kit_audio_intent_reconciler *reconciler) {
  enum iterate_kit_status status;
  if (reconciler == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (!reconciler->initialized) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (reconciler->failure != ITERATE_KIT_OK) {
    return reconciler->failure;
  }
  if (!reconciler->command_pending) {
    return ITERATE_KIT_OK;
  }

  const bool requested_active = effective_uplink_active(reconciler);
  status = reconciler->ops.request_uplink_active(
      reconciler->ops.context,
      requested_active);
  if (status == ITERATE_KIT_BACKPRESSURE) {
    /*
     * Do not add a retry queue. The newest boolean is a complete desired-state
     * description, and a later stop is allowed to supersede an unsent start.
     */
    increment(&reconciler->command_backpressure);
    return status;
  }
  if (status != ITERATE_KIT_OK) {
    increment(&reconciler->command_failures);
    reconciler->failure = status;
    return status;
  }
  increment(&reconciler->commands_accepted);
  reconciler->applied_uplink_active =
      requested_active;
  reconciler->command_pending = false;
  return ITERATE_KIT_OK;
}

void iterate_kit_audio_intent_reconciler_metrics(
    const struct iterate_kit_audio_intent_reconciler *reconciler,
    struct iterate_kit_audio_intent_metrics *metrics) {
  if (metrics == NULL) {
    return;
  }
  memset(metrics, 0, sizeof(*metrics));
  if (reconciler == NULL || !reconciler->initialized) {
    return;
  }
  metrics->intent_edges = reconciler->intent_edges;
  metrics->media_readiness_edges =
      reconciler->media_readiness_edges;
  metrics->commands_accepted = reconciler->commands_accepted;
  metrics->command_backpressure = reconciler->command_backpressure;
  metrics->command_failures = reconciler->command_failures;
  metrics->playback_resets = reconciler->playback_resets;
  metrics->desired_uplink_active = reconciler->desired_uplink_active;
  metrics->media_ready = reconciler->media_ready;
  metrics->publication_active =
      reconciler->applied_uplink_active;
  metrics->command_pending = reconciler->command_pending;
  metrics->failed = reconciler->failure != ITERATE_KIT_OK;
}
