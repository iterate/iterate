#include "iterate/kit/capabilities/push_to_talk.h"

#include <assert.h>
#include <string.h>

enum { EVENT_CAPACITY = 2 };

struct fixture {
  struct iterate_kit_device_event_queue queue;
  struct iterate_kit_device_event storage[EVENT_CAPACITY];
  struct iterate_kit_device_event handled[EVENT_CAPACITY];
  struct iterate_kit_push_to_talk push_to_talk;
  size_t handled_count;
  /** What this fixture's device would say about a call being up. */
  bool call_wanted;
};

static bool fixture_would_be_honoured(void *context) {
  const struct fixture *fixture = context;
  return fixture->call_wanted;
}

static enum iterate_kit_status handle_event(
    void *context, const struct iterate_kit_device_event *event) {
  struct fixture *fixture = context;
  assert(fixture->handled_count < EVENT_CAPACITY);
  fixture->handled[fixture->handled_count++] = *event;
  return ITERATE_KIT_OK;
}

static void fixture_init(struct fixture *fixture) {
  memset(fixture, 0, sizeof(*fixture));
  const struct iterate_kit_device_event_queue_options options = {
    .storage = fixture->storage,
    .capacity = EVENT_CAPACITY,
    .handler = {
      .context = fixture,
      .handle = handle_event,
    },
  };
  assert(
      iterate_kit_device_event_queue_init(&fixture->queue, &options) ==
      ITERATE_KIT_OK);
  const struct iterate_kit_push_to_talk_driver driver = {
    .context = fixture,
    .would_be_honoured = fixture_would_be_honoured,
  };
  assert(
      iterate_kit_push_to_talk_init(
          &fixture->push_to_talk, &fixture->queue, &driver) ==
      ITERATE_KIT_OK);
}

static void remote_calls_join_the_bounded_device_event_path(void) {
  struct fixture fixture;
  struct capnweb_reply reply = {0};
  fixture_init(&fixture);
  const struct iterate_kit_module module =
      iterate_kit_push_to_talk_module(&fixture.push_to_talk);

  assert(module.method_count == 2U);
  assert(module.context == &fixture.push_to_talk);
  assert(strcmp(module.methods[0].path[0], "pushToTalk") == 0);
  assert(strcmp(module.methods[0].path[1], "start") == 0);
  assert(strcmp(module.methods[1].path[1], "stop") == 0);

  assert(
      module.methods[0].dispatch(module.context, NULL, &reply) == CAPNWEB_OK);
  assert(reply.kind == CAPNWEB_REPLY_EXPRESSION);
  memset(&reply, 0, sizeof(reply));
  assert(
      module.methods[1].dispatch(module.context, NULL, &reply) == CAPNWEB_OK);
  assert(reply.kind == CAPNWEB_REPLY_EXPRESSION);

  assert(iterate_kit_device_event_poll(&fixture.queue, EVENT_CAPACITY) ==
         ITERATE_KIT_OK);
  assert(fixture.handled_count == 2U);
  assert(fixture.handled[0].type ==
         ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED);
  assert(fixture.handled[1].type ==
         ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED);
  assert(fixture.handled[0].source == ITERATE_KIT_DEVICE_EVENT_SOURCE_REMOTE);
  assert(fixture.handled[1].source == ITERATE_KIT_DEVICE_EVENT_SOURCE_REMOTE);
}

/*
 * ACCEPTED IS NOT LATCHED, AND THE REPLY HAS TO SAY WHICH.
 *
 * A press with no call up is queued, handled, and then never read: every use
 * of the latch on a push-to-talk board is gated behind `wants_call`. The old
 * reply was `true` for both cases, so a caller had no way to tell a working
 * device from one quietly discarding every press — which is exactly how two
 * boards were bisected in hardware for an afternoon before anyone suspected
 * the answer rather than the device.
 */
static void a_press_with_no_call_says_it_was_not_latched(void) {
  struct fixture fixture;
  struct capnweb_reply reply = {0};
  fixture_init(&fixture);
  fixture.call_wanted = false;
  const struct iterate_kit_module module =
      iterate_kit_push_to_talk_module(&fixture.push_to_talk);

  assert(
      module.methods[0].dispatch(module.context, NULL, &reply) == CAPNWEB_OK);
  assert(reply.kind == CAPNWEB_REPLY_EXPRESSION);
  assert(strstr((const char *)reply.value.borrowed.data, "\"accepted\":true") != NULL);
  assert(strstr((const char *)reply.value.borrowed.data, "\"latched\":false") != NULL);

  /* Still queued, still delivered: refusing to LIE is not refusing to act. */
  assert(iterate_kit_device_event_poll(&fixture.queue, EVENT_CAPACITY) ==
         ITERATE_KIT_OK);
  assert(fixture.handled_count == 1U);
  assert(fixture.handled[0].type ==
         ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED);
}

static void a_press_during_a_wanted_call_says_it_was_latched(void) {
  struct fixture fixture;
  struct capnweb_reply reply = {0};
  fixture_init(&fixture);
  fixture.call_wanted = true;
  const struct iterate_kit_module module =
      iterate_kit_push_to_talk_module(&fixture.push_to_talk);

  assert(
      module.methods[0].dispatch(module.context, NULL, &reply) == CAPNWEB_OK);
  assert(reply.kind == CAPNWEB_REPLY_EXPRESSION);
  assert(strstr((const char *)reply.value.borrowed.data, "\"latched\":true") != NULL);
}

/*
 * A DEVICE THAT CANNOT ANSWER MUST NOT APPEAR TO ANSWER "no". Omitting the
 * field is the difference between "this press will be ignored" and "this
 * composition does not know", and a caller can tell those apart.
 */
static void a_composition_with_no_gate_omits_the_claim(void) {
  struct fixture fixture;
  struct capnweb_reply reply = {0};
  fixture_init(&fixture);
  assert(
      iterate_kit_push_to_talk_init(
          &fixture.push_to_talk, &fixture.queue, NULL) == ITERATE_KIT_OK);
  const struct iterate_kit_module module =
      iterate_kit_push_to_talk_module(&fixture.push_to_talk);

  assert(
      module.methods[0].dispatch(module.context, NULL, &reply) == CAPNWEB_OK);
  assert(reply.kind == CAPNWEB_REPLY_EXPRESSION);
  assert(strstr((const char *)reply.value.borrowed.data, "\"accepted\":true") != NULL);
  assert(strstr((const char *)reply.value.borrowed.data, "latched") == NULL);
}

int main(void) {
  remote_calls_join_the_bounded_device_event_path();
  a_press_with_no_call_says_it_was_not_latched();
  a_press_during_a_wanted_call_says_it_was_latched();
  a_composition_with_no_gate_omits_the_claim();
  return 0;
}
