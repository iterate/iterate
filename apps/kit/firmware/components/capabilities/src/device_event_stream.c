#include "iterate/kit/capabilities/device_event_stream.h"

#include <limits.h>
#include <string.h>

/*
 * The PCM lane remains pure binary audio. This module carries only the
 * low-rate state edges that give push-to-talk audio meaning. It deliberately
 * follows the same latest-state philosophy as device metrics: bounded RAM,
 * one owner, no retry storm, and enough sequence evidence for the receiver to
 * reject an ambiguous turn rather than treating missing control as success.
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
    struct iterate_kit_device_event_stream *stream) {
  enum iterate_kit_status status;
  if (stream->options.callback_budget == NULL) {
    return ITERATE_KIT_OK;
  }
  status = iterate_kit_callback_budget_acquire(
      stream->options.callback_budget);
  if (status == ITERATE_KIT_OK) {
    stream->callback_budget_reserved = true;
  }
  return status;
}

static bool release_callback_budget(
    struct iterate_kit_device_event_stream *stream) {
  if (!stream->callback_budget_reserved) {
    return true;
  }
  stream->callback_budget_reserved = false;
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

static enum iterate_kit_status enqueue(
    struct iterate_kit_device_event_stream *stream,
    struct iterate_kit_device_event_notification notification) {
  size_t index;
  if (!stream->occupied) {
    /*
     * State and sequence are still retained by observe(), but events before a
     * subscriber exists are not history. The subscription snapshot is the
     * explicit resynchronization boundary and costs one notification.
     */
    return ITERATE_KIT_OK;
  }
  if (stream->queue_count == stream->options.capacity) {
    /*
     * Never preserve an old edge at the expense of current physical state.
     * Replacing the newest queued item keeps all older causally ordered items,
     * then sends the final state with a sequence gap and cumulative counter.
     * Userspace must reset the provider turn on that gap; it cannot silently
     * infer which transition was skipped.
     */
    if (stream->coalesced_notifications != UINT32_MAX) {
      ++stream->coalesced_notifications;
    }
    notification.coalesced_notifications =
        stream->coalesced_notifications;
    index =
        (stream->queue_head + stream->queue_count - 1U) &
        (stream->options.capacity - 1U);
    stream->options.storage[index] = notification;
    return ITERATE_KIT_BACKPRESSURE;
  }
  index =
      (stream->queue_head + stream->queue_count) &
      (stream->options.capacity - 1U);
  stream->options.storage[index] = notification;
  ++stream->queue_count;
  return ITERATE_KIT_OK;
}

static enum capnweb_status subscribe(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_device_event_stream *stream = context;
  struct capnweb_value callback_value = {0};
  struct capnweb_remote_capability callback = {0};
  enum capnweb_status status;
  struct iterate_kit_device_event_notification snapshot;
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
  if (stream->call_in_flight || stream->release_pending) {
    /*
     * Import ownership transferred while decoding the argument. Refusing the
     * replacement without a release would leak one remote capability per
     * retry. An in-flight completion still points at this stream, so replacing
     * its callback in place would let the old owner clear or release the new
     * owner when that completion arrives.
     */
    status = capnweb_session_release_remote(
        stream->options.session, callback);
    if (status != CAPNWEB_OK) {
      return status;
    }
    return capnweb_reply_set_error(
        reply, "Error", "device event subscription limit reached");
  }

  if (stream->occupied) {
    /*
     * There is one logical userspace event owner, but a new `/pcm` Worker
     * generation can replace that owner without ending the device's separate
     * long-lived control session. Treating the new callback as a second
     * subscriber caused a permanent 503 reconnect loop in production.
     *
     * Release-before-replace is the ownership handoff: after this frame the
     * old idle callback cannot receive another edge, and resetting the bounded
     * queue prevents its stale snapshot from being delivered to the new
     * generation. Explicit unsubscribe was rejected as the only recovery
     * mechanism because a dead Worker cannot reliably invoke it.
     */
    status = capnweb_session_release_remote(
        stream->options.session, stream->callback);
    if (status != CAPNWEB_OK) {
      return status;
    }
  }

  stream->callback = callback;
  stream->occupied = true;
  stream->queue_head = 0U;
  stream->queue_count = 0U;
  snapshot = (struct iterate_kit_device_event_notification){
    .sequence = stream->sequence,
    .coalesced_notifications =
        stream->coalesced_notifications,
    .result = ITERATE_KIT_OK,
    .type = (uint8_t)(
        stream->current_active
            ? ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED
            : ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED),
    .source = (uint8_t)ITERATE_KIT_DEVICE_EVENT_SOURCE_SYSTEM,
    .snapshot = true,
  };
  /*
   * The queue was reset above and has non-zero validated capacity, so the
   * initial resynchronization notification cannot backpressure.
   */
  if (enqueue(stream, snapshot) != ITERATE_KIT_OK) {
    return CAPNWEB_E_STATE;
  }
  return capnweb_reply_set_null(reply);
}

static void delivery_complete(
    void *context, const struct capnweb_result *result) {
  struct iterate_kit_device_event_stream *stream = context;
  if (stream == NULL || result == NULL || !stream->initialized) {
    return;
  }
  stream->call_in_flight = false;
  (void)release_callback_budget(stream);
  if (result->kind == CAPNWEB_RESULT_VALUE) {
    return;
  }

  /*
   * A rejected callback is an ended subscription, not an item to retry. An
   * unbounded retry would starve ordinary capability calls while repeatedly
   * replaying a control edge whose receiver already rejected it.
   */
  stream->occupied = false;
  stream->queue_head = 0U;
  stream->queue_count = 0U;
  stream->release_pending =
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
  struct capnweb_expression values[8];
  struct capnweb_object_field fields[8];
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

static struct iterate_kit_poll_result poll(
    void *context, uint64_t now_ms) {
  struct iterate_kit_device_event_stream *stream = context;
  struct notification_expression_workspace workspace;
  struct iterate_kit_device_event_notification notification;
  enum iterate_kit_status budget_status;
  enum capnweb_status status;
  (void)now_ms;
  if (stream == NULL || !stream->initialized) {
    return poll_capnweb(CAPNWEB_E_STATE);
  }
  if (stream->release_pending) {
    status = capnweb_session_release_remote(
        stream->options.session, stream->callback);
    if (status != CAPNWEB_OK) {
      return poll_capnweb(status);
    }
    memset(&stream->callback, 0, sizeof(stream->callback));
    stream->release_pending = false;
  }
  if (stream->pending_result.status != ITERATE_KIT_POLL_OK) {
    const struct iterate_kit_poll_result result =
        stream->pending_result;
    stream->pending_result = poll_ok();
    return result;
  }
  if (!stream->occupied ||
      stream->call_in_flight ||
      stream->queue_count == 0U) {
    return poll_ok();
  }
  budget_status = reserve_callback_budget(stream);
  if (budget_status == ITERATE_KIT_BACKPRESSURE) {
    /*
     * Retain the already-bounded notification until a callback slot becomes
     * free. Physical capture has already changed state and continues outside
     * this control path; no audio work waits on the remote observer.
     */
    return poll_ok();
  }
  if (budget_status != ITERATE_KIT_OK) {
    return (struct iterate_kit_poll_result){
      ITERATE_KIT_POLL_DRIVER_ERROR,
      CAPNWEB_OK,
    };
  }

  notification = stream->options.storage[stream->queue_head];
  if (!build_notification_expression(
          &notification, &workspace)) {
    (void)release_callback_budget(stream);
    return (struct iterate_kit_poll_result){
      ITERATE_KIT_POLL_DRIVER_ERROR,
      CAPNWEB_OK,
    };
  }
  status = capnweb_session_call_expressions(
      stream->options.session,
      stream->callback,
      NULL,
      0U,
      &workspace.object,
      1U,
      delivery_complete,
      stream);
  if (status != CAPNWEB_OK) {
    (void)release_callback_budget(stream);
    return poll_capnweb(status);
  }
  /*
   * Expression serialization is synchronous. Once Cap'n Web accepts the call,
   * the queue slot can be reused even though the remote result is outstanding.
   * `call_in_flight` prevents the next edge from overtaking this one.
   */
  stream->queue_head =
      (stream->queue_head + 1U) &
      (stream->options.capacity - 1U);
  --stream->queue_count;
  stream->call_in_flight = true;
  return poll_ok();
}

static struct iterate_kit_poll_result close_stream(void *context) {
  struct iterate_kit_device_event_stream *stream = context;
  struct iterate_kit_poll_result result = poll_ok();
  if (stream == NULL || !stream->initialized) {
    return poll_capnweb(CAPNWEB_E_STATE);
  }
  if ((stream->occupied || stream->release_pending) &&
      capnweb_session_get_state(stream->options.session) ==
          CAPNWEB_SESSION_OPEN) {
    const enum capnweb_status status =
        capnweb_session_release_remote(
            stream->options.session, stream->callback);
    if (status != CAPNWEB_OK) {
      result = poll_capnweb(status);
    }
  }
  (void)release_callback_budget(stream);
  stream->occupied = false;
  stream->call_in_flight = false;
  stream->release_pending = false;
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
  (void)release_callback_budget(stream);
  memset(&stream->callback, 0, sizeof(stream->callback));
  stream->occupied = false;
  stream->call_in_flight = false;
  stream->release_pending = false;
  stream->queue_head = 0U;
  stream->queue_count = 0U;
  stream->pending_result = poll_ok();
}

enum iterate_kit_status iterate_kit_device_event_stream_init(
    struct iterate_kit_device_event_stream *stream,
    const struct iterate_kit_device_event_stream_options *options) {
  if (stream == NULL ||
      options == NULL ||
      options->session == NULL ||
      options->storage == NULL ||
      !power_of_two(options->capacity) ||
      options->capacity > (size_t)UINT32_MAX / 2U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(stream, 0, sizeof(*stream));
  memset(
      options->storage,
      0,
      options->capacity * sizeof(*options->storage));
  stream->options = *options;
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
  /*
   * Saturation is visible through a repeated sequence plus the coalesced
   * counter; wrapping would make a decades-old event appear to precede a
   * reconnect snapshot. This limit is unreachable in ordinary button use.
   */
  if (stream->sequence != INT64_MAX) {
    ++stream->sequence;
  } else if (stream->coalesced_notifications != UINT32_MAX) {
    ++stream->coalesced_notifications;
  }
  notification = (struct iterate_kit_device_event_notification){
    .sequence = stream->sequence,
    .coalesced_notifications =
        stream->coalesced_notifications,
    .result = (int32_t)result,
    .type = event->type,
    .source = event->source,
    .snapshot = false,
  };
  return enqueue(stream, notification);
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
