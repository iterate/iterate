// Copyright (c) 2026 Iterate
// Licensed under the MIT license found in the repository root.

#include "iterate/kit/stream_subscription.h"

#include <string.h>

static const char *const streams_get_path[] = {"streams", "get"};
static const char *const append_path[] = {"append"};
static const char *const open_connection_path[] = {"openConnection"};
static const char *const live_state_subscribe_path[] = {"liveState", "subscribe"};
static const char *const unsubscribe_path[] = {"unsubscribe"};
static const char *const close_path[] = {"close"};

static bool take_capability(
    const struct capnweb_result *result,
    struct capnweb_remote_capability *out) {
  return result->kind == CAPNWEB_RESULT_VALUE && result->status == CAPNWEB_OK &&
      capnweb_value_get_remote_capability(&result->value, out);
}

static enum capnweb_status release_result(
    struct capnweb_session *session, const struct capnweb_result *result) {
  struct capnweb_remote_capability capability;
  if (session != NULL && take_capability(result, &capability)) {
    return capnweb_session_release_remote(session, capability);
  }
  return CAPNWEB_OK;
}

static void stream_get_completed(
    void *context, const struct capnweb_result *result) {
  struct iterate_kit_stream_request *const request = context;
  struct iterate_kit_stream *stream;
  if (request == NULL) return;
  stream = request->stream;
  if (stream == NULL) {
    (void)release_result(request->session, result);
    request->pending = false;
    return;
  }
  request->pending = false;
  if (request->epoch != stream->epoch || stream->state != ITERATE_KIT_STREAM_GETTING) {
    stream->status = release_result(request->session, result);
    return;
  }
  if (result->kind == CAPNWEB_RESULT_SESSION_ENDED) {
    stream->state = ITERATE_KIT_STREAM_CLOSED;
    stream->status = result->status;
    return;
  }
  if (!take_capability(result, &stream->capability)) {
    stream->state = ITERATE_KIT_STREAM_FAILED;
    stream->status = result->kind == CAPNWEB_RESULT_REJECTION ? CAPNWEB_OK : CAPNWEB_E_INVALID_MESSAGE;
    return;
  }
  stream->has_capability = true;
  stream->state = ITERATE_KIT_STREAM_READY;
  stream->status = CAPNWEB_OK;
}

static void callback_disposed(void *context) {
  struct iterate_kit_stream_subscription *const subscription = context;
  if (subscription == NULL) return;
  subscription->callback_disposed = true;
  subscription->has_callback = false;
  if (subscription->state == ITERATE_KIT_SUBSCRIPTION_CLOSING &&
      !subscription->open.pending && !subscription->has_handle) {
    subscription->state = ITERATE_KIT_SUBSCRIPTION_CLOSED;
  }
}

static enum capnweb_status callback_dispatch(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_stream_subscription *const subscription = context;
  struct capnweb_value update;
  if (subscription != NULL &&
      (subscription->state == ITERATE_KIT_SUBSCRIPTION_OPENING ||
       subscription->state == ITERATE_KIT_SUBSCRIPTION_OPEN) &&
      subscription->on_update != NULL && call->has_arguments &&
      capnweb_value_array_at(&call->arguments, 0U, &update)) {
    subscription->on_update(
        subscription->owner, subscription->owner_epoch, &update);
  }
  return capnweb_reply_set_null(reply);
}

static enum capnweb_status close_handle(
    struct iterate_kit_stream_subscription *subscription) {
  const char *const *path = subscription->kind == ITERATE_KIT_SUBSCRIPTION_LIVE_STATE
      ? unsubscribe_path : close_path;
  const size_t path_count = subscription->kind == ITERATE_KIT_SUBSCRIPTION_LIVE_STATE
      ? sizeof(unsubscribe_path) / sizeof(unsubscribe_path[0])
      : sizeof(close_path) / sizeof(close_path[0]);
  const enum capnweb_status close_status = capnweb_session_call_oneway_path(
      subscription->session, subscription->handle, path, path_count, "[]", 2U);
  const enum capnweb_status release_status = capnweb_session_release_remote(
      subscription->session, subscription->handle);
  if (release_status == CAPNWEB_OK) subscription->has_handle = false;
  return close_status == CAPNWEB_OK ? release_status : close_status;
}

static void subscription_opened(
    void *context, const struct capnweb_result *result) {
  struct iterate_kit_subscription_request *const request = context;
  struct iterate_kit_stream_subscription *subscription;
  if (request == NULL) return;
  subscription = request->subscription;
  if (subscription == NULL) {
    (void)release_result(request->session, result);
    request->pending = false;
    return;
  }
  request->pending = false;
  if (request->epoch != subscription->epoch ||
      subscription->state == ITERATE_KIT_SUBSCRIPTION_CLOSING ||
      subscription->state == ITERATE_KIT_SUBSCRIPTION_CLOSED) {
    if (take_capability(result, &subscription->handle)) {
      subscription->has_handle = true;
      subscription->status = close_handle(subscription);
    } else {
      subscription->status = result->status;
    }
    if (subscription->state == ITERATE_KIT_SUBSCRIPTION_CLOSING &&
        !subscription->has_handle && subscription->callback_disposed) {
      subscription->state = ITERATE_KIT_SUBSCRIPTION_CLOSED;
    }
    return;
  }
  if (result->kind == CAPNWEB_RESULT_SESSION_ENDED) {
    subscription->state = ITERATE_KIT_SUBSCRIPTION_CLOSED;
    subscription->status = result->status;
    return;
  }
  if (!take_capability(result, &subscription->handle)) {
    subscription->state = ITERATE_KIT_SUBSCRIPTION_FAILED;
    subscription->status =
        result->kind == CAPNWEB_RESULT_REJECTION ? CAPNWEB_OK : CAPNWEB_E_INVALID_MESSAGE;
    return;
  }
  subscription->has_handle = true;
  subscription->state = ITERATE_KIT_SUBSCRIPTION_OPEN;
  subscription->status = CAPNWEB_OK;
}

static enum capnweb_status prepare_subscription(
    struct iterate_kit_stream_subscription *subscription,
    struct capnweb_session *session,
    enum iterate_kit_subscription_kind kind,
    iterate_kit_subscription_update_fn on_update,
    void *owner,
    uint32_t owner_epoch) {
  const struct capnweb_capability callback = {
    callback_dispatch, subscription, callback_disposed,
  };
  enum capnweb_status status;
  if (subscription == NULL || session == NULL || on_update == NULL ||
      !iterate_kit_stream_subscription_reclaimable(subscription)) {
    return CAPNWEB_E_STATE;
  }
  if (subscription->epoch == UINT32_MAX) return CAPNWEB_E_LIMIT;
  ++subscription->epoch;
  subscription->session = session;
  subscription->kind = kind;
  subscription->state = ITERATE_KIT_SUBSCRIPTION_OPENING;
  subscription->status = CAPNWEB_OK;
  subscription->on_update = on_update;
  subscription->owner = owner;
  subscription->owner_epoch = owner_epoch;
  subscription->callback_disposed = false;
  status = capnweb_session_export_capability(session, callback, &subscription->callback);
  if (status != CAPNWEB_OK) {
    subscription->callback_disposed = true;
    subscription->state = ITERATE_KIT_SUBSCRIPTION_FAILED;
    subscription->status = status;
    return status;
  }
  subscription->has_callback = true;
  subscription->open.pending = true;
  subscription->open.epoch = subscription->epoch;
  subscription->open.subscription = subscription;
  subscription->open.session = session;
  return CAPNWEB_OK;
}

static enum capnweb_status call_subscription_open(
    struct iterate_kit_stream_subscription *subscription,
    struct capnweb_remote_capability target,
    const char *const *path,
    size_t path_count,
    const struct capnweb_expression *arguments,
    size_t argument_count) {
  enum capnweb_status status = capnweb_session_call_expressions(
      subscription->session, target, path, path_count, arguments, argument_count,
      subscription_opened, &subscription->open);
  if (status != CAPNWEB_OK) {
    subscription->open.pending = false;
    if (capnweb_session_release_local_capability(
            subscription->session, subscription->callback) == CAPNWEB_OK) {
      subscription->has_callback = false;
    }
    subscription->state = ITERATE_KIT_SUBSCRIPTION_FAILED;
    subscription->status = status;
  }
  return status;
}

enum capnweb_status iterate_kit_stream_get(
    struct iterate_kit_stream *stream,
    struct capnweb_session *session,
    struct capnweb_remote_capability project,
    const char *path) {
  struct capnweb_expression argument;
  enum capnweb_status status;
  if (stream == NULL || session == NULL || path == NULL || path[0] == '\0' ||
      stream->get.pending || stream->has_capability) return CAPNWEB_E_STATE;
  if (stream->epoch == UINT32_MAX) return CAPNWEB_E_LIMIT;
  ++stream->epoch;
  argument = (struct capnweb_expression){CAPNWEB_EXPRESSION_STRING,
      {.string = {path, strlen(path)}}};
  stream->session = session;
  stream->state = ITERATE_KIT_STREAM_GETTING;
  stream->status = CAPNWEB_OK;
  stream->get.pending = true;
  stream->get.epoch = stream->epoch;
  stream->get.stream = stream;
  stream->get.session = session;
  status = capnweb_session_call_expressions(
      session, project, streams_get_path,
      sizeof(streams_get_path) / sizeof(streams_get_path[0]), &argument, 1U,
      stream_get_completed, &stream->get);
  if (status != CAPNWEB_OK) {
    stream->get.pending = false;
    stream->state = ITERATE_KIT_STREAM_FAILED;
    stream->status = status;
  }
  return status;
}

enum capnweb_status iterate_kit_stream_append(
    const struct iterate_kit_stream *stream,
    const char *events_json,
    size_t events_json_length) {
  if (stream == NULL || stream->state != ITERATE_KIT_STREAM_READY ||
      !stream->has_capability || events_json == NULL) return CAPNWEB_E_STATE;
  return capnweb_session_call_oneway_path(
      stream->session, stream->capability, append_path,
      sizeof(append_path) / sizeof(append_path[0]), events_json, events_json_length);
}

enum capnweb_status iterate_kit_stream_close(struct iterate_kit_stream *stream) {
  enum capnweb_status status = CAPNWEB_OK;
  if (stream == NULL) return CAPNWEB_E_INVALID_ARGUMENT;
  if (stream->has_capability && stream->session != NULL) {
    status = capnweb_session_release_remote(stream->session, stream->capability);
    if (status == CAPNWEB_OK) stream->has_capability = false;
  }
  stream->state = ITERATE_KIT_STREAM_CLOSED;
  stream->status = status;
  return status;
}

enum capnweb_status iterate_kit_stream_subscription_open(
    struct iterate_kit_stream_subscription *subscription,
    struct iterate_kit_stream *stream,
    const char *connection_key,
    const char *const *event_types,
    size_t event_type_count,
    int64_t max_delivery_events,
    int64_t max_delivery_bytes,
    iterate_kit_subscription_update_fn on_update,
    void *owner,
    uint32_t owner_epoch) {
  struct capnweb_expression type_items[8];
  struct capnweb_expression types;
  struct capnweb_expression key;
  struct capnweb_expression max_events;
  struct capnweb_expression max_bytes;
  struct capnweb_expression no_state;
  struct capnweb_expression callback;
  struct capnweb_object_field fields[6];
  struct capnweb_expression argument;
  enum capnweb_status status;
  size_t index;
  if (stream == NULL || stream->state != ITERATE_KIT_STREAM_READY ||
      !stream->has_capability || connection_key == NULL || connection_key[0] == '\0' ||
      event_types == NULL || event_type_count == 0U ||
      event_type_count > sizeof(type_items) / sizeof(type_items[0])) return CAPNWEB_E_INVALID_ARGUMENT;
  for (index = 0U; index < event_type_count; ++index) {
    if (event_types[index] == NULL || event_types[index][0] == '\0') {
      return CAPNWEB_E_INVALID_ARGUMENT;
    }
  }
  status = prepare_subscription(subscription, stream->session,
      ITERATE_KIT_SUBSCRIPTION_STREAM, on_update, owner, owner_epoch);
  if (status != CAPNWEB_OK) return status;
  for (index = 0U; index < event_type_count; ++index) {
    type_items[index] = (struct capnweb_expression){CAPNWEB_EXPRESSION_STRING,
        {.string = {event_types[index], strlen(event_types[index])}}};
  }
  types = (struct capnweb_expression){CAPNWEB_EXPRESSION_ARRAY,
      {.array = {type_items, event_type_count}}};
  key = (struct capnweb_expression){CAPNWEB_EXPRESSION_STRING,
      {.string = {connection_key, strlen(connection_key)}}};
  max_events = (struct capnweb_expression){CAPNWEB_EXPRESSION_INT64,
      {.integer = max_delivery_events}};
  max_bytes = (struct capnweb_expression){CAPNWEB_EXPRESSION_INT64,
      {.integer = max_delivery_bytes}};
  no_state = (struct capnweb_expression){CAPNWEB_EXPRESSION_BOOLEAN,
      {.boolean = false}};
  callback = (struct capnweb_expression){CAPNWEB_EXPRESSION_CAPABILITY,
      {.capability = subscription->callback}};
  fields[0] = (struct capnweb_object_field){{"connectionKey", 13U}, &key};
  fields[1] = (struct capnweb_object_field){{"eventTypes", 10U}, &types};
  fields[2] = (struct capnweb_object_field){{"maxDeliveryEvents", 17U}, &max_events};
  fields[3] = (struct capnweb_object_field){{"maxDeliveryBytes", 16U}, &max_bytes};
  fields[4] = (struct capnweb_object_field){{"state", 5U}, &no_state};
  fields[5] = (struct capnweb_object_field){{"processEventBatch", 17U}, &callback};
  argument = (struct capnweb_expression){CAPNWEB_EXPRESSION_OBJECT,
      {.object = {fields, 6U}}};
  return call_subscription_open(subscription, stream->capability,
      open_connection_path, sizeof(open_connection_path) / sizeof(open_connection_path[0]),
      &argument, 1U);
}

enum capnweb_status iterate_kit_live_state_subscription_open(
    struct iterate_kit_stream_subscription *subscription,
    struct capnweb_session *session,
    struct capnweb_remote_capability target,
    iterate_kit_subscription_update_fn on_update,
    void *owner,
    uint32_t owner_epoch) {
  struct capnweb_expression callback;
  enum capnweb_status status = prepare_subscription(subscription, session,
      ITERATE_KIT_SUBSCRIPTION_LIVE_STATE, on_update, owner, owner_epoch);
  if (status != CAPNWEB_OK) return status;
  callback = (struct capnweb_expression){CAPNWEB_EXPRESSION_CAPABILITY,
      {.capability = subscription->callback}};
  return call_subscription_open(subscription, target, live_state_subscribe_path,
      sizeof(live_state_subscribe_path) / sizeof(live_state_subscribe_path[0]),
      &callback, 1U);
}

enum capnweb_status iterate_kit_stream_subscription_close(
    struct iterate_kit_stream_subscription *subscription) {
  enum capnweb_status first = CAPNWEB_OK;
  enum capnweb_status status;
  if (subscription == NULL) return CAPNWEB_E_INVALID_ARGUMENT;
  if (subscription->state == ITERATE_KIT_SUBSCRIPTION_FREE ||
      subscription->state == ITERATE_KIT_SUBSCRIPTION_CLOSED) return CAPNWEB_OK;
  subscription->state = ITERATE_KIT_SUBSCRIPTION_CLOSING;
  if (subscription->has_handle && subscription->session != NULL) {
    first = close_handle(subscription);
  }
  if (subscription->has_callback && subscription->session != NULL) {
    status = capnweb_session_release_local_capability(subscription->session, subscription->callback);
    if (status == CAPNWEB_OK) subscription->has_callback = false;
    else if (first == CAPNWEB_OK) first = status;
  }
  if (!subscription->open.pending && !subscription->has_handle &&
      subscription->callback_disposed) subscription->state = ITERATE_KIT_SUBSCRIPTION_CLOSED;
  subscription->status = first;
  return first;
}

bool iterate_kit_stream_subscription_reclaimable(
    const struct iterate_kit_stream_subscription *subscription) {
  return subscription != NULL &&
      (subscription->state == ITERATE_KIT_SUBSCRIPTION_FREE ||
       (subscription->state == ITERATE_KIT_SUBSCRIPTION_CLOSED &&
        !subscription->open.pending && !subscription->has_handle &&
        !subscription->has_callback && subscription->callback_disposed));
}

bool iterate_kit_stream_reclaimable(const struct iterate_kit_stream *stream) {
  return stream != NULL && !stream->get.pending && !stream->has_capability &&
      (stream->state == ITERATE_KIT_STREAM_FREE ||
       stream->state == ITERATE_KIT_STREAM_CLOSED ||
       stream->state == ITERATE_KIT_STREAM_FAILED);
}

void iterate_kit_stream_session_ended(struct iterate_kit_stream *stream) {
  if (stream == NULL) return;
  stream->has_capability = false;
  stream->state = ITERATE_KIT_STREAM_CLOSED;
  stream->status = CAPNWEB_E_STATE;
}

void iterate_kit_stream_subscription_session_ended(
    struct iterate_kit_stream_subscription *subscription) {
  if (subscription == NULL) return;
  subscription->has_handle = false;
  subscription->has_callback = false;
  subscription->callback_disposed = true;
  subscription->state = ITERATE_KIT_SUBSCRIPTION_CLOSED;
  subscription->status = CAPNWEB_E_STATE;
}
