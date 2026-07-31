#include "iterate/kit/capabilities/conversation.h"

#include "rpc_internal.h"

#include <string.h>

/*
 * The top button is a call toggle, not the speech gate. `start` opens the PCM
 * generation but leaves capture stopped; the front-button PTT capability owns
 * the later capture/commit edges. `hangUp` tears down the whole generation.
 * Both commands remain queue admissions so physical and remote transitions
 * have one observable order and the unattended rig exercises the GPIO path's
 * actual state machine rather than a test-only socket shortcut.
 */
static const char *const start_path[] = {"conversation", "start"};
static const char *const hang_up_path[] = {
  "conversation", "hangUp",
};

static enum capnweb_status publish(
    struct iterate_kit_conversation *conversation,
    enum iterate_kit_device_event_type type,
    struct capnweb_reply *reply) {
  const enum iterate_kit_status status =
      iterate_kit_device_event_publish(
          conversation->events,
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
      ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED,
      reply);
}

static enum capnweb_status hang_up(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  (void)call;
  return publish(
      context,
      ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED,
      reply);
}

enum iterate_kit_status iterate_kit_conversation_init(
    struct iterate_kit_conversation *conversation,
    struct iterate_kit_device_event_queue *events) {
  if (conversation == NULL ||
      events == NULL ||
      !events->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(conversation, 0, sizeof(*conversation));
  conversation->events = events;
  conversation->initialized = true;
  return ITERATE_KIT_OK;
}

struct iterate_kit_module iterate_kit_conversation_module(
    struct iterate_kit_conversation *conversation) {
  static const struct iterate_kit_method methods[] = {
    {start_path, 2U, start},
    {hang_up_path, 2U, hang_up},
  };
  const struct iterate_kit_module module = {
    .methods = methods,
    .method_count = sizeof(methods) / sizeof(methods[0]),
    .context = conversation,
    .poll = NULL,
    .close = NULL,
    .session_ended = NULL,
  };
  return module;
}
