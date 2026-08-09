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

/*
 * `{accepted}`, AND NOW THAT IS THE WHOLE TRUTH.
 *
 * This answered a bare `true` once, which meant "the local queue took your
 * event" and was read by every caller as "the microphone is open". Those were
 * different claims, and on a push-to-talk board with no call up the gap between
 * them was total: the event was queued, the handler set the latch, and the turn
 * machine never read the latch because every use of it was gated behind
 * `wants_call`. The request was accepted and then ignored, permanently, and the
 * only symptom was silence. That cost an afternoon of hardware bisection.
 *
 * A second field, `latched`, reported that gap at the instant of the call. It
 * is gone WITH THE GAP: a press now opens the call as well as the microphone
 * (see handle_device_event in components/voice), so there is no state in which
 * an accepted press is not acted on, and a field that is always `true` is
 * noise. Absent rather than false is the rule that survived — a device with
 * nothing to say about a gate must not appear to answer "no".
 *
 * The object shape stays rather than collapsing back to a bare boolean: this is
 * the reply an agent reads, and `{"accepted":true}` says which claim is being
 * made where `true` says only that something happened.
 */
static enum capnweb_status publish(
    struct iterate_kit_push_to_talk *push_to_talk,
    enum iterate_kit_device_event_type type,
    struct capnweb_reply *reply) {
  static const char document[] = "{\"accepted\":true}";
  const enum iterate_kit_status status =
      iterate_kit_device_event_publish(
          push_to_talk->events,
          type,
          ITERATE_KIT_DEVICE_EVENT_SOURCE_REMOTE);
  if (status != ITERATE_KIT_OK) {
    return iterate_kit_reply_status(reply, status);
  }
  return capnweb_reply_set_borrowed_expression(
      reply, document, sizeof(document) - 1U, NULL, NULL);
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
    .close = NULL,
    .session_ended = NULL,
  };
  return module;
}
