#include "iterate/kit/capabilities/conversation.h"

#include "rpc_internal.h"

#include <limits.h>
#include <string.h>

/*
 * Conversation lifetime and microphone turns are separate actions. `start`
 * opens the PCM generation but leaves capture stopped; the PTT capability owns
 * later capture/commit edges. `hangUp` tears down the whole generation.
 * Both commands remain queue admissions so physical and remote transitions
 * have one observable order and the unattended rig exercises the GPIO path's
 * actual state machine rather than a test-only socket shortcut.
 */
static const char *const start_path[] = {"conversation", "start"};
static const char *const hang_up_path[] = {
  "conversation", "hangUp",
};
static const char *const interrupt_playback_path[] = {
  "conversation", "interruptPlayback",
};

static struct iterate_kit_poll_result poll_ok(void) {
  const struct iterate_kit_poll_result result = {
    ITERATE_KIT_POLL_OK,
    CAPNWEB_OK,
  };
  return result;
}

static struct iterate_kit_poll_result poll_capnweb(
    enum capnweb_status status) {
  if (status == CAPNWEB_OK || status == CAPNWEB_E_CANCELED) {
    return poll_ok();
  }
  const struct iterate_kit_poll_result result = {
    ITERATE_KIT_POLL_CAPNWEB_ERROR,
    status,
  };
  return result;
}

static void saturating_increment(uint32_t *value) {
  if (*value != UINT32_MAX) {
    ++*value;
  }
}

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

static enum capnweb_status interrupt_playback(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_conversation *conversation = context;
  enum iterate_kit_status status;
  enum capnweb_status capnweb_status;
  uint32_t token = 0U;
  if (conversation == NULL || !conversation->initialized) {
    return CAPNWEB_E_STATE;
  }
  if (call == NULL ||
      !call->has_arguments ||
      capnweb_value_array_size(&call->arguments) != 0U) {
    return capnweb_reply_set_error(
        reply, "TypeError", "interruptPlayback expects no arguments");
  }
  if (conversation->playback_interruption.request == NULL ||
      conversation->playback_interruption.poll == NULL) {
    return capnweb_reply_set_error(
        reply, "Error", "playback interruption unavailable");
  }
  if (conversation->playback_interruption_pending) {
    saturating_increment(
        &conversation->playback_interruption_backpressure);
    return capnweb_reply_set_error(
        reply, "Error", "playback interruption already pending");
  }

  status = conversation->playback_interruption.request(
      conversation->playback_interruption.context, &token);
  if (status != ITERATE_KIT_OK) {
    return iterate_kit_reply_status(reply, status);
  }
  conversation->playback_interruption_token = token;
  conversation->playback_interruption_pending = true;
  conversation->playback_interruption_clock_started = false;
  conversation->playback_interruption_responder_active = false;
  saturating_increment(
      &conversation->playback_interruption_requests);

  capnweb_status = capnweb_reply_defer(reply);
  if (capnweb_status == CAPNWEB_OK) {
    conversation->playback_interruption_responder = call->responder;
    conversation->playback_interruption_responder_active = true;
  }
  /*
   * If deferral itself fails, the admitted physical purge must still complete.
   * The module keeps polling the token without a responder so the one-slot
   * audio barrier cannot remain wedged behind a dead Cap'n Web call.
   */
  return capnweb_status;
}

static enum capnweb_status responder_set_status(
    struct capnweb_responder responder,
    enum iterate_kit_status status) {
  switch (status) {
    case ITERATE_KIT_INVALID_ARGUMENT:
      return capnweb_responder_set_error(
          responder, "RangeError", "hardware rejected the arguments");
    case ITERATE_KIT_UNAVAILABLE:
      return capnweb_responder_set_error(
          responder, "Error", "hardware capability unavailable");
    case ITERATE_KIT_IO_ERROR:
      return capnweb_responder_set_error(
          responder, "Error", "hardware I/O failed");
    case ITERATE_KIT_LIMIT:
      return capnweb_responder_set_error(
          responder, "RangeError", "hardware resource limit reached");
    case ITERATE_KIT_BACKPRESSURE:
      return capnweb_responder_set_error(
          responder, "Error", "hardware is busy");
    case ITERATE_KIT_STATE_ERROR:
      return capnweb_responder_set_error(
          responder, "Error", "hardware is in the wrong state");
    case ITERATE_KIT_OK:
      break;
  }
  return capnweb_responder_set_error(
      responder, "Error", "hardware returned an unknown status");
}

static struct iterate_kit_poll_result finish_responder(
    struct iterate_kit_conversation *conversation,
    enum capnweb_status status) {
  conversation->playback_interruption_responder_active = false;
  if (status == CAPNWEB_E_CANCELED) {
    saturating_increment(
        &conversation->playback_interruption_cancellations);
  }
  return poll_capnweb(status);
}

static struct iterate_kit_poll_result poll(
    void *context, uint64_t now_ms) {
  struct iterate_kit_conversation *conversation = context;
  enum iterate_kit_status status;
  if (conversation == NULL || !conversation->initialized) {
    return poll_capnweb(CAPNWEB_E_STATE);
  }
  if (!conversation->playback_interruption_pending) {
    return poll_ok();
  }
  if (!conversation->playback_interruption_clock_started) {
    conversation->playback_interruption_started_ms = now_ms;
    conversation->playback_interruption_clock_started = true;
  }

  status = conversation->playback_interruption.poll(
      conversation->playback_interruption.context,
      conversation->playback_interruption_token);
  if (status == ITERATE_KIT_UNAVAILABLE) {
    if (conversation->playback_interruption_responder_active &&
        now_ms >= conversation->playback_interruption_started_ms &&
        now_ms - conversation->playback_interruption_started_ms >=
            conversation->playback_interruption
                .acknowledgement_timeout_ms) {
      const enum capnweb_status timeout_status =
          capnweb_responder_set_error(
              conversation->playback_interruption_responder,
              "Error",
              "playback interruption acknowledgement timed out");
      saturating_increment(
          &conversation->playback_interruption_timeouts);
      /*
       * Only the promise times out. The physical reset remains pending and is
       * polled on later owner passes until it reaches a terminal result. This
       * is why timeout cannot release a second interruption admission.
       */
      return finish_responder(conversation, timeout_status);
    }
    return poll_ok();
  }

  conversation->playback_interruption_pending = false;
  conversation->playback_interruption_clock_started = false;
  if (status == ITERATE_KIT_OK) {
    saturating_increment(
        &conversation->playback_interruption_completions);
    if (!conversation->playback_interruption_responder_active) {
      return poll_ok();
    }
    return finish_responder(
        conversation,
        capnweb_responder_set_boolean(
            conversation->playback_interruption_responder, true));
  }

  saturating_increment(
      &conversation->playback_interruption_failures);
  if (!conversation->playback_interruption_responder_active) {
    return poll_ok();
  }
  return finish_responder(
      conversation,
      responder_set_status(
          conversation->playback_interruption_responder, status));
}

static void session_ended(void *context) {
  struct iterate_kit_conversation *conversation = context;
  if (conversation == NULL || !conversation->initialized) {
    return;
  }
  if (conversation->playback_interruption_responder_active) {
    saturating_increment(
        &conversation->playback_interruption_cancellations);
    conversation->playback_interruption_responder_active = false;
  }
  /*
   * Do not discard playback_interruption_pending. Cap'n Web lifetime ended,
   * not the physical reset; subsequent peer polls must still consume its
   * acknowledgement before another control session can request one.
   */
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

enum iterate_kit_status
iterate_kit_conversation_bind_playback_interruption(
    struct iterate_kit_conversation *conversation,
    const struct iterate_kit_conversation_playback_interruption_driver
        *driver) {
  if (conversation == NULL || !conversation->initialized) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (conversation->playback_interruption_pending) {
    return ITERATE_KIT_BACKPRESSURE;
  }
  if (driver == NULL) {
    memset(
        &conversation->playback_interruption,
        0,
        sizeof(conversation->playback_interruption));
    return ITERATE_KIT_OK;
  }
  if (driver->request == NULL ||
      driver->poll == NULL ||
      driver->acknowledgement_timeout_ms == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  conversation->playback_interruption = *driver;
  return ITERATE_KIT_OK;
}

void iterate_kit_conversation_metrics(
    const struct iterate_kit_conversation *conversation,
    struct iterate_kit_conversation_metrics *metrics) {
  if (metrics == NULL) {
    return;
  }
  memset(metrics, 0, sizeof(*metrics));
  if (conversation == NULL || !conversation->initialized) {
    return;
  }
  metrics->playback_interruption_requests =
      conversation->playback_interruption_requests;
  metrics->playback_interruption_completions =
      conversation->playback_interruption_completions;
  metrics->playback_interruption_failures =
      conversation->playback_interruption_failures;
  metrics->playback_interruption_timeouts =
      conversation->playback_interruption_timeouts;
  metrics->playback_interruption_cancellations =
      conversation->playback_interruption_cancellations;
  metrics->playback_interruption_backpressure =
      conversation->playback_interruption_backpressure;
  metrics->playback_interruption_pending =
      conversation->playback_interruption_pending;
  metrics->playback_interruption_responder_active =
      conversation->playback_interruption_responder_active;
}

struct iterate_kit_module iterate_kit_conversation_module(
    struct iterate_kit_conversation *conversation) {
  static const struct iterate_kit_method methods[] = {
    {start_path, 2U, start},
    {hang_up_path, 2U, hang_up},
    {interrupt_playback_path, 2U, interrupt_playback},
  };
  const struct iterate_kit_module module = {
    .methods = methods,
    .method_count = sizeof(methods) / sizeof(methods[0]),
    .context = conversation,
    .poll = poll,
    .close = NULL,
    .session_ended = session_ended,
  };
  return module;
}
