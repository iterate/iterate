#include "iterate/kit/audio_intent_reconciler.h"

#include <limits.h>
#include <string.h>

static void increment(uint32_t *value) {
  if (*value != UINT32_MAX) {
    ++*value;
  }
}

enum iterate_kit_status iterate_kit_audio_intent_reconciler_init(
    struct iterate_kit_audio_intent_reconciler *reconciler,
    const struct iterate_kit_audio_intent_ops *ops) {
  if (reconciler == NULL || ops == NULL ||
      ops->request_uplink_active == NULL ||
      ops->request_playback_reset == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(reconciler, 0, sizeof(*reconciler));
  reconciler->ops = *ops;
  reconciler->failure = ITERATE_KIT_OK;
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
      break;
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED:
      requests_uplink = true;
      uplink_active = true;
      resets_playback = true;
      break;
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED:
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
    reconciler->command_pending =
        !reconciler->has_applied_state ||
        reconciler->applied_uplink_active != uplink_active;
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

  status = reconciler->ops.request_uplink_active(
      reconciler->ops.context,
      reconciler->desired_uplink_active);
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
      reconciler->desired_uplink_active;
  reconciler->has_applied_state = true;
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
  metrics->commands_accepted = reconciler->commands_accepted;
  metrics->command_backpressure = reconciler->command_backpressure;
  metrics->command_failures = reconciler->command_failures;
  metrics->playback_resets = reconciler->playback_resets;
  metrics->desired_uplink_active = reconciler->desired_uplink_active;
  metrics->command_pending = reconciler->command_pending;
  metrics->failed = reconciler->failure != ITERATE_KIT_OK;
}
