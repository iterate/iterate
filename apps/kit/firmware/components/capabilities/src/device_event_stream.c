#include "iterate/kit/capabilities/device_event_stream.h"

#include <limits.h>
#include <string.h>

/*
 * The PCM lane remains pure binary audio. This module carries only the
 * low-rate state edges that give push-to-talk audio meaning. It deliberately
 * keeps one bounded history with independent subscriber cursors: production
 * userspace and a diagnostic harness see the same truth, but neither can
 * replace, block, or create an audio backlog for the other.
 */
static const char *const subscribe_path[] = {"subscribeToEvents"};

static struct iterate_kit_poll_result poll_ok(void) {
  const struct iterate_kit_poll_result result = {
    ITERATE_KIT_POLL_OK,
    CAPNWEB_OK,
  };
  return result;
}

static struct iterate_kit_poll_result poll_capnweb(
    enum capnweb_status status) {
  const struct iterate_kit_poll_result result = {
    ITERATE_KIT_POLL_CAPNWEB_ERROR,
    status,
  };
  return result;
}

static enum iterate_kit_status reserve_callback_budget(
    struct iterate_kit_device_event_stream *stream,
    struct iterate_kit_device_event_subscription *subscription) {
  enum iterate_kit_status status;
  if (stream->options.callback_budget == NULL) {
    return ITERATE_KIT_OK;
  }
  status = iterate_kit_callback_budget_acquire(
      stream->options.callback_budget);
  if (status == ITERATE_KIT_OK) {
    subscription->callback_budget_reserved = true;
  }
  return status;
}

static bool release_callback_budget(
    struct iterate_kit_device_event_stream *stream,
    struct iterate_kit_device_event_subscription *subscription) {
  if (!subscription->callback_budget_reserved) {
    return true;
  }
  subscription->callback_budget_reserved = false;
  if (stream->options.callback_budget == NULL ||
      iterate_kit_callback_budget_release(
          stream->options.callback_budget) != ITERATE_KIT_OK) {
    stream->pending_result = (struct iterate_kit_poll_result){
      ITERATE_KIT_POLL_DRIVER_ERROR,
      CAPNWEB_OK,
    };
    return false;
  }
  return true;
}

static bool power_of_two(size_t value) {
  return value != 0U && (value & (value - 1U)) == 0U;
}

static const char *event_type_name(uint8_t type) {
  return iterate_kit_device_event_type_name(
      (enum iterate_kit_device_event_type)type);
}

static const char *event_source_name(uint8_t source) {
  return iterate_kit_device_event_source_name(
      (enum iterate_kit_device_event_source)source);
}

static uint32_t saturating_add_u32(uint32_t value, uint64_t increment) {
  if (increment >= (uint64_t)UINT32_MAX - value) {
    return UINT32_MAX;
  }
  return value + (uint32_t)increment;
}

static bool subscriber_would_lose(
    const struct iterate_kit_device_event_subscription *subscription,
    int64_t overwritten_sequence) {
  return subscription->occupied &&
      !subscription->snapshot_pending &&
      subscription->next_sequence <= overwritten_sequence;
}

static enum iterate_kit_status append_history(
    struct iterate_kit_device_event_stream *stream,
    struct iterate_kit_device_event_notification notification) {
  bool subscriber_lost_event = false;
  size_t index;
  if (stream->queue_count == stream->options.capacity) {
    /*
     * This ring is recent shared history, not a work queue whose slowest
     * consumer owns global progress. Overwrite the oldest entry. A subscriber
     * whose cursor still points at it will receive a current-state snapshot on
     * its next turn; other subscribers continue with exact sequence ordering.
     */
    const int64_t overwritten_sequence =
        stream->options.storage[stream->queue_head].sequence;
    for (size_t subscriber_index = 0U;
         subscriber_index < stream->options.subscription_count;
         ++subscriber_index) {
      if (subscriber_would_lose(
              &stream->options.subscriptions[subscriber_index],
              overwritten_sequence)) {
        subscriber_lost_event = true;
      }
    }
    stream->queue_head =
        (stream->queue_head + 1U) & (stream->options.capacity - 1U);
    --stream->queue_count;
  }
  index =
      (stream->queue_head + stream->queue_count) &
      (stream->options.capacity - 1U);
  stream->options.storage[index] = notification;
  ++stream->queue_count;
  return subscriber_lost_event
      ? ITERATE_KIT_BACKPRESSURE
      : ITERATE_KIT_OK;
}

static enum capnweb_status subscribe(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_device_event_stream *stream = context;
  struct capnweb_value callback_value = {0};
  struct capnweb_remote_capability callback = {0};
  struct iterate_kit_device_event_subscription *subscription = NULL;
  enum capnweb_status status;
  size_t index;
  if (stream == NULL || !stream->initialized) {
    return CAPNWEB_E_STATE;
  }
  if (!call->has_arguments ||
      capnweb_value_array_size(&call->arguments) != 1U ||
      !capnweb_value_array_at(
          &call->arguments, 0U, &callback_value) ||
      !capnweb_value_get_remote_capability(
          &callback_value, &callback)) {
    return capnweb_reply_set_error(
        reply, "TypeError", "expected a device event callback capability");
  }
  for (index = 0U;
       index < stream->options.subscription_count;
       ++index) {
    struct iterate_kit_device_event_subscription *candidate =
        &stream->options.subscriptions[index];
    if (!candidate->occupied &&
        !candidate->call_in_flight &&
        !candidate->release_pending) {
      subscription = candidate;
      break;
    }
  }
  if (subscription == NULL) {
    /*
     * Decoding transferred ownership of the remote capability. Exhaustion is
     * a normal explicit bound, but failing to release here would leak one
     * import for every reconnect or diagnostic retry.
     */
    status = capnweb_session_release_remote(
        stream->options.session, callback);
    if (status != CAPNWEB_OK) {
      return status;
    }
    return capnweb_reply_set_error(
        reply, "Error", "device event subscription limit reached");
  }

  subscription->callback = callback;
  subscription->occupied = true;
  subscription->snapshot_pending = true;
  subscription->coalesced_notifications = 0U;
  subscription->next_sequence = stream->sequence == INT64_MAX
      ? INT64_MAX
      : stream->sequence + 1;
  return capnweb_reply_set_null(reply);
}

static void delivery_complete(
    void *context, const struct capnweb_result *result) {
  struct iterate_kit_device_event_subscription *subscription = context;
  struct iterate_kit_device_event_stream *stream;
  if (subscription == NULL ||
      result == NULL ||
      subscription->owner == NULL) {
    return;
  }
  stream = subscription->owner;
  if (!stream->initialized) {
    return;
  }
  subscription->call_in_flight = false;
  (void)release_callback_budget(stream, subscription);
  if (result->kind == CAPNWEB_RESULT_VALUE) {
    return;
  }

  /*
   * A rejected callback is an ended subscription, not an item to retry. An
   * unbounded retry would starve ordinary capability calls while repeatedly
   * replaying a control edge whose receiver already rejected it.
   */
  subscription->occupied = false;
  subscription->snapshot_pending = false;
  subscription->release_pending =
      result->kind != CAPNWEB_RESULT_SESSION_ENDED;
  if (stream->pending_result.status != ITERATE_KIT_POLL_OK) {
    return;
  }
  if (result->kind == CAPNWEB_RESULT_REJECTION) {
    stream->pending_result = (struct iterate_kit_poll_result){
      ITERATE_KIT_POLL_CALLBACK_REJECTED,
      CAPNWEB_OK,
    };
  } else {
    stream->pending_result = poll_capnweb(result->status);
  }
}

struct notification_expression_workspace {
  struct capnweb_expression values[9];
  struct capnweb_object_field fields[9];
  struct capnweb_expression object;
};

static void string_value(
    struct capnweb_expression *value,
    struct capnweb_object_field *field,
    const char *key,
    const char *string) {
  *value = (struct capnweb_expression){
    .kind = CAPNWEB_EXPRESSION_STRING,
    .value.string = {string, strlen(string)},
  };
  *field = (struct capnweb_object_field){
    .key = {key, strlen(key)},
    .value = value,
  };
}

static void integer_value(
    struct capnweb_expression *value,
    struct capnweb_object_field *field,
    const char *key,
    int64_t integer) {
  *value = (struct capnweb_expression){
    .kind = CAPNWEB_EXPRESSION_INT64,
    .value.integer = integer,
  };
  *field = (struct capnweb_object_field){
    .key = {key, strlen(key)},
    .value = value,
  };
}

static void boolean_value(
    struct capnweb_expression *value,
    struct capnweb_object_field *field,
    const char *key,
    bool boolean) {
  *value = (struct capnweb_expression){
    .kind = CAPNWEB_EXPRESSION_BOOLEAN,
    .value.boolean = boolean,
  };
  *field = (struct capnweb_object_field){
    .key = {key, strlen(key)},
    .value = value,
  };
}

static bool build_notification_expression(
    const struct iterate_kit_device_event_notification *notification,
    struct notification_expression_workspace *workspace) {
  const char *const type = event_type_name(notification->type);
  const char *const source = event_source_name(notification->source);
  if (strcmp(type, "unknown") == 0 ||
      strcmp(source, "unknown") == 0) {
    return false;
  }
  integer_value(
      &workspace->values[0],
      &workspace->fields[0],
      "schemaVersion",
      1);
  integer_value(
      &workspace->values[1],
      &workspace->fields[1],
      "sequence",
      notification->sequence);
  string_value(
      &workspace->values[2],
      &workspace->fields[2],
      "type",
      type);
  string_value(
      &workspace->values[3],
      &workspace->fields[3],
      "source",
      source);
  boolean_value(
      &workspace->values[4],
      &workspace->fields[4],
      "active",
      notification->type ==
          ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED);
  integer_value(
      &workspace->values[5],
      &workspace->fields[5],
      "result",
      notification->result);
  boolean_value(
      &workspace->values[6],
      &workspace->fields[6],
      "snapshot",
      notification->snapshot);
  integer_value(
      &workspace->values[7],
      &workspace->fields[7],
      "coalescedNotifications",
      notification->coalesced_notifications);
  boolean_value(
      &workspace->values[8],
      &workspace->fields[8],
      "conversationActive",
      notification->conversation_active);
  workspace->object = (struct capnweb_expression){
    .kind = CAPNWEB_EXPRESSION_OBJECT,
    .value.object = {
      workspace->fields,
      sizeof(workspace->fields) /
          sizeof(workspace->fields[0]),
    },
  };
  return true;
}

static struct iterate_kit_device_event_notification current_snapshot(
    const struct iterate_kit_device_event_stream *stream,
    uint32_t coalesced_notifications) {
  const struct iterate_kit_device_event_notification snapshot = {
    .sequence = stream->sequence,
    .coalesced_notifications = coalesced_notifications,
    .result = ITERATE_KIT_OK,
    .type = (uint8_t)(
        stream->options.audio_mode ==
                ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC
            ? (stream->conversation_active
                  ? ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED
                  : ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED)
            : (stream->current_active
                  ? ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED
                  : ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED)),
    .source = (uint8_t)ITERATE_KIT_DEVICE_EVENT_SOURCE_SYSTEM,
    .conversation_active = stream->conversation_active,
    .snapshot = true,
  };
  return snapshot;
}

static bool next_notification(
    const struct iterate_kit_device_event_stream *stream,
    struct iterate_kit_device_event_subscription *subscription,
    struct iterate_kit_device_event_notification *notification) {
  int64_t oldest_sequence;
  uint64_t skipped;
  size_t offset;
  if (subscription->snapshot_pending) {
    *notification = current_snapshot(
        stream, subscription->coalesced_notifications);
    return true;
  }
  if (stream->sequence == INT64_MAX &&
      subscription->sequence_limit_delivered) {
    return false;
  }
  if (stream->queue_count == 0U ||
      subscription->next_sequence > stream->sequence) {
    return false;
  }

  oldest_sequence =
      stream->options.storage[stream->queue_head].sequence;
  if (subscription->next_sequence < oldest_sequence) {
    /*
     * Only this observer fell outside the fixed history window. A state
     * snapshot is the sole safe recovery because guessing whether a missing
     * edge was press or release can invert every later microphone frame. The
     * counter records every skipped sequence, while the other cursors remain
     * untouched.
     */
    skipped = (uint64_t)(stream->sequence -
        subscription->next_sequence) + 1U;
    subscription->coalesced_notifications = saturating_add_u32(
        subscription->coalesced_notifications, skipped);
    *notification = current_snapshot(
        stream, subscription->coalesced_notifications);
    return true;
  }

  offset = (size_t)(
      subscription->next_sequence - oldest_sequence);
  if (offset >= stream->queue_count) {
    return false;
  }
  *notification = stream->options.storage[
      (stream->queue_head + offset) &
      (stream->options.capacity - 1U)];
  notification->coalesced_notifications =
      subscription->coalesced_notifications;
  return true;
}

static struct iterate_kit_poll_result poll(
    void *context, uint64_t now_ms) {
  struct iterate_kit_device_event_stream *stream = context;
  (void)now_ms;
  if (stream == NULL || !stream->initialized) {
    return poll_capnweb(CAPNWEB_E_STATE);
  }

  for (size_t index = 0U;
       index < stream->options.subscription_count;
       ++index) {
    struct iterate_kit_device_event_subscription *subscription =
        &stream->options.subscriptions[index];
    if (subscription->release_pending) {
      const enum capnweb_status status =
          capnweb_session_release_remote(
              stream->options.session, subscription->callback);
      if (status != CAPNWEB_OK) {
        return poll_capnweb(status);
      }
      memset(subscription, 0, sizeof(*subscription));
      subscription->owner = stream;
    }
  }
  if (stream->pending_result.status != ITERATE_KIT_POLL_OK) {
    const struct iterate_kit_poll_result result =
        stream->pending_result;
    stream->pending_result = poll_ok();
    return result;
  }

  for (size_t offset = 0U;
       offset < stream->options.subscription_count;
       ++offset) {
    const size_t index =
        (stream->next_poll_index + offset) %
        stream->options.subscription_count;
    struct iterate_kit_device_event_subscription *subscription =
        &stream->options.subscriptions[index];
    struct notification_expression_workspace workspace;
    struct iterate_kit_device_event_notification notification;
    enum iterate_kit_status budget_status;
    enum capnweb_status status;
    if (!subscription->occupied ||
        subscription->call_in_flight ||
        !next_notification(stream, subscription, &notification)) {
      continue;
    }
    budget_status = reserve_callback_budget(stream, subscription);
    if (budget_status == ITERATE_KIT_BACKPRESSURE) {
      /*
       * The profile-wide wire burst is full. Leave this cursor unchanged and
       * try on a later owner poll; physical audio state has already advanced
       * and no observer gets to block the realtime producer.
       */
      return poll_ok();
    }
    if (budget_status != ITERATE_KIT_OK) {
      return (struct iterate_kit_poll_result){
        ITERATE_KIT_POLL_DRIVER_ERROR,
        CAPNWEB_OK,
      };
    }
    if (!build_notification_expression(
            &notification, &workspace)) {
      (void)release_callback_budget(stream, subscription);
      return (struct iterate_kit_poll_result){
        ITERATE_KIT_POLL_DRIVER_ERROR,
        CAPNWEB_OK,
      };
    }
    status = capnweb_session_call_expressions(
        stream->options.session,
        subscription->callback,
        NULL,
        0U,
        &workspace.object,
        1U,
        delivery_complete,
        subscription);
    if (status != CAPNWEB_OK) {
      (void)release_callback_budget(stream, subscription);
      return poll_capnweb(status);
    }
    /*
     * Serialization is synchronous, so advancing this cursor cannot race the
     * borrowed expression workspace. The callback result remains outstanding,
     * and only this slot is fenced until its completion arrives.
     */
    subscription->snapshot_pending = false;
    if (notification.sequence == INT64_MAX) {
      subscription->sequence_limit_delivered = true;
      subscription->next_sequence = INT64_MAX;
    } else {
      subscription->next_sequence = notification.sequence + 1;
    }
    subscription->call_in_flight = true;
    stream->next_poll_index =
        (index + 1U) % stream->options.subscription_count;
    return poll_ok();
  }
  return poll_ok();
}

static struct iterate_kit_poll_result close_stream(void *context) {
  struct iterate_kit_device_event_stream *stream = context;
  struct iterate_kit_poll_result result = poll_ok();
  if (stream == NULL || !stream->initialized) {
    return poll_capnweb(CAPNWEB_E_STATE);
  }
  for (size_t index = 0U;
       index < stream->options.subscription_count;
       ++index) {
    struct iterate_kit_device_event_subscription *subscription =
        &stream->options.subscriptions[index];
    if ((subscription->occupied || subscription->release_pending) &&
        capnweb_session_get_state(stream->options.session) ==
            CAPNWEB_SESSION_OPEN) {
      const enum capnweb_status status =
          capnweb_session_release_remote(
              stream->options.session, subscription->callback);
      if (status != CAPNWEB_OK &&
          result.status == ITERATE_KIT_POLL_OK) {
        result = poll_capnweb(status);
      }
    }
    (void)release_callback_budget(stream, subscription);
    memset(subscription, 0, sizeof(*subscription));
    subscription->owner = stream;
  }
  stream->queue_head = 0U;
  stream->queue_count = 0U;
  stream->initialized = false;
  return result;
}

static void session_ended(void *context) {
  struct iterate_kit_device_event_stream *stream = context;
  if (stream == NULL || !stream->initialized) {
    return;
  }
  /*
   * Preserve the boot-local sequence and current physical state. They are the
   * information the replacement control session needs in its first snapshot;
   * only the dead session's imported callback and queued deliveries are reset.
   */
  for (size_t index = 0U;
       index < stream->options.subscription_count;
       ++index) {
    struct iterate_kit_device_event_subscription *subscription =
        &stream->options.subscriptions[index];
    (void)release_callback_budget(stream, subscription);
    memset(subscription, 0, sizeof(*subscription));
    subscription->owner = stream;
  }
  stream->queue_head = 0U;
  stream->queue_count = 0U;
  stream->next_poll_index = 0U;
  stream->pending_result = poll_ok();
}

enum iterate_kit_status iterate_kit_device_event_stream_init(
    struct iterate_kit_device_event_stream *stream,
    const struct iterate_kit_device_event_stream_options *options) {
  if (stream == NULL ||
      options == NULL ||
      options->session == NULL ||
      options->storage == NULL ||
      options->subscriptions == NULL ||
      options->subscription_count == 0U ||
      !power_of_two(options->capacity) ||
      options->capacity > (size_t)UINT32_MAX / 2U ||
      (options->audio_mode != ITERATE_KIT_AUDIO_PUSH_TO_TALK &&
       options->audio_mode != ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC)) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(stream, 0, sizeof(*stream));
  memset(
      options->storage,
      0,
      options->capacity * sizeof(*options->storage));
  memset(
      options->subscriptions,
      0,
      options->subscription_count * sizeof(*options->subscriptions));
  stream->options = *options;
  for (size_t index = 0U;
       index < options->subscription_count;
       ++index) {
    options->subscriptions[index].owner = stream;
  }
  stream->pending_result = poll_ok();
  stream->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_device_event_stream_observe(
    struct iterate_kit_device_event_stream *stream,
    const struct iterate_kit_device_event *event,
    enum iterate_kit_status result) {
  struct iterate_kit_device_event_notification notification;
  if (stream == NULL ||
      !stream->initialized ||
      event == NULL ||
      event->type >= ITERATE_KIT_DEVICE_EVENT_TYPE_COUNT ||
      event->source >= ITERATE_KIT_DEVICE_EVENT_SOURCE_COUNT) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  /*
   * The subscription snapshot exists to restore the mic turn after a Worker
   * generation reconnects. Conversation start/hang-up events share this
   * ordered stream for diagnostics, but must not overwrite the held/released
   * PTT state. Likewise a rejected press outside a call is evidence, not a
   * state transition: reporting it as held would make userspace commit audio
   * that the device never captured.
   */
  if (result == ITERATE_KIT_OK &&
      (event->type == ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED ||
       event->type == ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED)) {
    stream->current_active =
        event->type == ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED;
  }
  if (result == ITERATE_KIT_OK &&
      (event->type == ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED ||
       event->type == ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED)) {
    /*
     * Call lifetime is independent of the PTT level above. Keeping both bits
     * in the same ordered owner lets a replacement userspace callback recover
     * an in-progress call without opening another query/callback race. A
     * failed device transition is retained as evidence but cannot mutate the
     * state advertised by the next subscription snapshot.
     */
    stream->conversation_active =
        event->type == ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED;
  }
  /*
   * Reusing INT64_MAX would make two distinct button edges indistinguishable
   * to every cursor, while wrapping would invert decades of ordering. Stop
   * publishing with a visible limit result after updating the current state;
   * a replacement subscriber can still recover that state from its snapshot.
   * At one edge per millisecond this boundary is hundreds of millions of
   * years away, but defining it keeps the protocol honest.
   */
  if (stream->sequence == INT64_MAX) {
    return ITERATE_KIT_LIMIT;
  }
  ++stream->sequence;
  notification = (struct iterate_kit_device_event_notification){
    .sequence = stream->sequence,
    .coalesced_notifications = 0U,
    .result = (int32_t)result,
    .type = event->type,
    .source = event->source,
    .conversation_active = stream->conversation_active,
    .snapshot = false,
  };
  return append_history(stream, notification);
}

struct iterate_kit_module iterate_kit_device_event_stream_module(
    struct iterate_kit_device_event_stream *stream) {
  static const struct iterate_kit_method methods[] = {
    {subscribe_path, 1U, subscribe},
  };
  const struct iterate_kit_module module = {
    .methods = methods,
    .method_count = sizeof(methods) / sizeof(methods[0]),
    .context = stream,
    .poll = poll,
    .close = close_stream,
    .session_ended = session_ended,
  };
  return module;
}
