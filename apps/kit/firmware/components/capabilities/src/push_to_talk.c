#include "iterate/kit/capabilities/push_to_talk.h"

#include "rpc_internal.h"

#include <string.h>

/*
 * Remote start/stop calls intentionally join the same bounded event path as a
 * physical button. Calling the audio controller directly from RPC dispatch
 * was rejected because it would create two owners for capture state and make
 * physical/remote edge ordering scheduler-dependent. A successful reply means
 * "event accepted by the local queue", not "microphone frame reached server".
 */
static const char *const start_path[] = {"pushToTalk", "start"};
static const char *const stop_path[] = {"pushToTalk", "stop"};

static enum capnweb_status publish(
    struct iterate_kit_push_to_talk *push_to_talk,
    enum iterate_kit_device_event_type type,
    struct capnweb_reply *reply) {
  const enum iterate_kit_status status =
      iterate_kit_device_event_publish(
          push_to_talk->events,
          type,
          ITERATE_KIT_DEVICE_EVENT_SOURCE_REMOTE);
  if (status != ITERATE_KIT_OK) {
    return iterate_kit_reply_status(reply, status);
  }
  return capnweb_reply_set_boolean(reply, true);
}

static enum capnweb_status start(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  (void)call;
  return publish(
      context,
      ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED,
      reply);
}

static enum capnweb_status stop(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  (void)call;
  return publish(
      context,
      ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED,
      reply);
}

enum iterate_kit_status iterate_kit_push_to_talk_init(
    struct iterate_kit_push_to_talk *push_to_talk,
    struct iterate_kit_device_event_queue *events) {
  if (push_to_talk == NULL ||
      events == NULL ||
      !events->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(push_to_talk, 0, sizeof(*push_to_talk));
  push_to_talk->events = events;
  push_to_talk->initialized = true;
  return ITERATE_KIT_OK;
}

struct iterate_kit_module iterate_kit_push_to_talk_module(
    struct iterate_kit_push_to_talk *push_to_talk) {
  static const struct iterate_kit_method methods[] = {
    {start_path, 2U, start},
    {stop_path, 2U, stop},
  };
  const struct iterate_kit_module module = {
    .methods = methods,
    .method_count = sizeof(methods) / sizeof(methods[0]),
    .context = push_to_talk,
    .poll = NULL,
    .close = NULL,
    .session_ended = NULL,
  };
  return module;
}
