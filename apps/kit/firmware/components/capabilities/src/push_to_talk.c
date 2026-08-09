#include "iterate/kit/capabilities/push_to_talk.h"

#include "rpc_internal.h"

#include <stdio.h>

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

/*
 * `{accepted, latched}` — AND THE SECOND FIELD IS THE WHOLE POINT.
 *
 * This used to answer `true`, which meant "the local queue took your event"
 * and was read by every caller as "the microphone is open". Those are
 * different claims, and on a push-to-talk board with no call up the gap
 * between them is total: the event is queued, the handler sets the latch, and
 * the turn machine never reads the latch because every use of it is gated
 * behind `wants_call`. The request is accepted and then ignored, permanently,
 * and the only symptom is silence.
 *
 * That cost an afternoon of hardware bisection: two boards "did not respond to
 * a press" and the press had in fact been delivered, acknowledged and dropped
 * on the floor exactly as designed. `accepted` is what the old boolean meant.
 * `latched` is what the caller thought it meant.
 *
 * `latched` is absent, not false, when the composition supplied no driver:
 * a device that cannot answer the question must not appear to answer it "no".
 */
static enum capnweb_status publish(
    struct iterate_kit_push_to_talk *push_to_talk,
    enum iterate_kit_device_event_type type,
    struct capnweb_reply *reply) {
  /* Small, fixed-width, and only one dispatch runs at a time on this peer. */
  static char document[64];
  int written;
  const enum iterate_kit_status status =
      iterate_kit_device_event_publish(
          push_to_talk->events,
          type,
          ITERATE_KIT_DEVICE_EVENT_SOURCE_REMOTE);
  if (status != ITERATE_KIT_OK) {
    return iterate_kit_reply_status(reply, status);
  }
  if (push_to_talk->driver.would_be_honoured == NULL) {
    written = snprintf(document, sizeof(document), "{\"accepted\":true}");
  } else {
    written = snprintf(
        document,
        sizeof(document),
        "{\"accepted\":true,\"latched\":%s}",
        push_to_talk->driver.would_be_honoured(push_to_talk->driver.context)
            ? "true"
            : "false");
  }
  if (written < 0 || (size_t)written >= sizeof(document)) {
    return capnweb_reply_set_error(
        reply, "RangeError", "push-to-talk reply did not fit");
  }
  return capnweb_reply_set_borrowed_expression(
      reply, document, (size_t)written, NULL, NULL);
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
    struct iterate_kit_device_event_queue *events,
    const struct iterate_kit_push_to_talk_driver *driver) {
  if (push_to_talk == NULL ||
      events == NULL ||
      !events->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(push_to_talk, 0, sizeof(*push_to_talk));
  push_to_talk->events = events;
  if (driver != NULL) {
    push_to_talk->driver = *driver;
  }
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
    .close = NULL,
    .session_ended = NULL,
  };
  return module;
}
