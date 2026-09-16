// Copyright (c) 2026 Iterate
// Licensed under the MIT license found in the repository root.

#include "iterate/kit/stream_subscription.h"

#include <string.h>

static const char *const context_cd_path[] = {"cd"};
static const char *const append_path[] = {"append"};
static const char *const subscribe_path[] = {"subscribe"};
static const char *const live_state_subscribe_path[] = {"liveState", "subscribe"};
static const char *const unsubscribe_path[] = {"unsubscribe"};

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

/*
 * THE CALLEE IS THE STUB ITSELF, AND IT TAKES TWO ARGUMENTS. os-next evaluates
 * a lent target whose last step is a call, so `method` is undefined and the
 * wire call carries an EMPTY path — which is why nothing here reads
 * `call->path`. The argument shape is in stream_subscription.h.
 */
static enum capnweb_status callback_dispatch(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_stream_subscription *const subscription = context;
  struct capnweb_value update;
  struct capnweb_value range;
  if (subscription != NULL &&
      (subscription->state == ITERATE_KIT_SUBSCRIPTION_OPENING ||
       subscription->state == ITERATE_KIT_SUBSCRIPTION_OPEN) &&
      subscription->on_update != NULL && call->has_arguments &&
      capnweb_value_array_at(&call->arguments, 0U, &update)) {
    const bool has_range =
        capnweb_value_array_at(&call->arguments, 1U, &range);
    subscription->on_update(
        subscription->owner, subscription->owner_epoch, &update,
        has_range ? &range : NULL);
  }
  /* Protocol hygiene, never back-pressure: delivery is fire-and-forget (the
   * contract is in stream_subscription.h) and nobody waits for this reply. */
  return capnweb_reply_set_null(reply);
}

/*
 * RELEASING A SUBSCRIPTION HANDLE IS HOW IT CLOSES. os-next's handle has no
 * `close()`: a Cap'n Web release triggers its `Symbol.dispose`, which un-sets
 * the row. Calling a method that is not there would reject, and a rejection on
 * this client is indistinguishable from a network fault. Live state still has
 * an explicit `unsubscribe`, so that kind keeps its one-way call.
 */
static enum capnweb_status close_handle(
    struct iterate_kit_stream_subscription *subscription) {
  enum capnweb_status close_status = CAPNWEB_OK;
  enum capnweb_status release_status;
  if (subscription->kind == ITERATE_KIT_SUBSCRIPTION_LIVE_STATE) {
    close_status = capnweb_session_call_oneway_path(
        subscription->session, subscription->handle, unsubscribe_path,
        sizeof(unsubscribe_path) / sizeof(unsubscribe_path[0]), "[]", 2U);
  }
  release_status = capnweb_session_release_remote(
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
      session, project, context_cd_path,
      sizeof(context_cd_path) / sizeof(context_cd_path[0]), &argument, 1U,
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
    const char *subscription_name,
    const char *const *consumed_event_types,
    size_t consumed_event_type_count,
    iterate_kit_subscription_update_fn on_update,
    void *owner,
    uint32_t owner_epoch) {
  struct capnweb_expression type_items[8];
  struct capnweb_expression consumes;
  struct capnweb_expression name;
  struct capnweb_expression target;
  struct capnweb_object_field fields[3];
  struct capnweb_expression argument;
  enum capnweb_status status;
  size_t index;
  if (stream == NULL || stream->state != ITERATE_KIT_STREAM_READY ||
      !stream->has_capability || subscription_name == NULL ||
      subscription_name[0] == '\0' || consumed_event_types == NULL ||
      consumed_event_type_count == 0U ||
      consumed_event_type_count > sizeof(type_items) / sizeof(type_items[0])) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  for (index = 0U; index < consumed_event_type_count; ++index) {
    if (consumed_event_types[index] == NULL ||
        consumed_event_types[index][0] == '\0') {
      return CAPNWEB_E_INVALID_ARGUMENT;
    }
  }
  status = prepare_subscription(subscription, stream->session,
      ITERATE_KIT_SUBSCRIPTION_STREAM, on_update, owner, owner_epoch);
  if (status != CAPNWEB_OK) return status;
  for (index = 0U; index < consumed_event_type_count; ++index) {
    type_items[index] = (struct capnweb_expression){CAPNWEB_EXPRESSION_STRING,
        {.string = {consumed_event_types[index],
                    strlen(consumed_event_types[index])}}};
  }
  consumes = (struct capnweb_expression){CAPNWEB_EXPRESSION_ARRAY,
      {.array = {type_items, consumed_event_type_count}}};
  name = (struct capnweb_expression){CAPNWEB_EXPRESSION_STRING,
      {.string = {subscription_name, strlen(subscription_name)}}};
  /*
   * THE CAPABILITY IS THE TARGET, not a named member of the argument object.
   * os-next looks at what `target` evaluates to: a live stub owns its own
   * progress and is pushed to directly, which is what makes the callback a
   * bare two-argument function rather than a `processEventBatch` method.
   */
  target = (struct capnweb_expression){CAPNWEB_EXPRESSION_CAPABILITY,
      {.capability = subscription->callback}};
  fields[0] = (struct capnweb_object_field){{"name", 4U}, &name};
  fields[1] = (struct capnweb_object_field){{"consumes", 8U}, &consumes};
  fields[2] = (struct capnweb_object_field){{"target", 6U}, &target};
  argument = (struct capnweb_expression){CAPNWEB_EXPRESSION_OBJECT,
      {.object = {fields, 3U}}};
  return call_subscription_open(subscription, stream->capability,
      subscribe_path, sizeof(subscribe_path) / sizeof(subscribe_path[0]),
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
