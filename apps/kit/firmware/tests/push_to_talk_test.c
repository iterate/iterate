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
};

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
  assert(
      iterate_kit_push_to_talk_init(
          &fixture->push_to_talk, &fixture->queue) == ITERATE_KIT_OK);
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
  assert(reply.kind == CAPNWEB_REPLY_BOOLEAN && reply.value.boolean);
  memset(&reply, 0, sizeof(reply));
  assert(
      module.methods[1].dispatch(module.context, NULL, &reply) == CAPNWEB_OK);
  assert(reply.kind == CAPNWEB_REPLY_BOOLEAN && reply.value.boolean);

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

int main(void) {
  remote_calls_join_the_bounded_device_event_path();
  return 0;
}
