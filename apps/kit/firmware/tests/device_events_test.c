#include "iterate/kit/device_events.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void test_assert(
    bool condition,
    const char *expression,
    const char *file,
    int line) {
  if (condition) {
    return;
  }
  fprintf(stderr, "%s:%d: assertion failed: %s\n", file, line, expression);
  abort();
}

#define assert(expression) \
  test_assert((expression), #expression, __FILE__, __LINE__)

enum {
  EVENT_CAPACITY = 2,
};

struct fixture {
  struct iterate_kit_device_event_queue queue;
  struct iterate_kit_device_event storage[EVENT_CAPACITY];
  struct iterate_kit_device_event handled[EVENT_CAPACITY];
  enum iterate_kit_status observed_results[EVENT_CAPACITY];
  size_t handled_count;
  size_t observed_count;
  bool fail_next;
};

static enum iterate_kit_status handle_event(
    void *context,
    const struct iterate_kit_device_event *event) {
  struct fixture *fixture = context;
  assert(fixture->handled_count < EVENT_CAPACITY);
  fixture->handled[fixture->handled_count++] = *event;
  if (fixture->fail_next) {
    fixture->fail_next = false;
    return ITERATE_KIT_IO_ERROR;
  }
  return ITERATE_KIT_OK;
}

static void observe_event(
    void *context,
    const struct iterate_kit_device_event *event,
    enum iterate_kit_status result) {
  struct fixture *fixture = context;
  assert(fixture->observed_count < EVENT_CAPACITY);
  assert(
      memcmp(
          event,
          &fixture->handled[fixture->observed_count],
          sizeof(*event)) == 0);
  fixture->observed_results[fixture->observed_count++] = result;
}

static void fixture_init(struct fixture *fixture) {
  const struct iterate_kit_device_event_queue_options options = {
    .storage = fixture->storage,
    .capacity = EVENT_CAPACITY,
    .handler = {
      .context = fixture,
      .handle = handle_event,
    },
    .observer = {
      .context = fixture,
      .observe = observe_event,
    },
  };
  memset(fixture, 0, sizeof(*fixture));
  assert(
      iterate_kit_device_event_queue_init(
          &fixture->queue, &options) == ITERATE_KIT_OK);
}

/*
 * GPIO edges and remote push-to-talk calls can arrive faster than the device
 * owner handles them while audio still needs its turn every loop iteration.
 * Blocking publishers or retrying a failed handler was rejected because that
 * can delay PCM and replay a physical action. This proves capacity exhaustion
 * is immediate and measured, polling performs bounded work, and every accepted
 * event is consumed and observed exactly once even when its handler fails.
 */
static void bounded_queue_never_waits_or_retries_failed_events(void) {
  struct fixture fixture;
  struct iterate_kit_device_event_queue_metrics metrics;
  fixture_init(&fixture);

  assert(
      iterate_kit_device_event_publish(
          &fixture.queue,
          ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED,
          ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_device_event_publish(
          &fixture.queue,
          ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED,
          ITERATE_KIT_DEVICE_EVENT_SOURCE_REMOTE) ==
      ITERATE_KIT_OK);
  assert(
      iterate_kit_device_event_publish(
          &fixture.queue,
          ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED,
          ITERATE_KIT_DEVICE_EVENT_SOURCE_REMOTE) ==
      ITERATE_KIT_BACKPRESSURE);

  iterate_kit_device_event_queue_metrics(
      &fixture.queue, &metrics);
  assert(metrics.events_published == 2U);
  assert(metrics.events_processed == 0U);
  assert(metrics.publisher_backpressure == 1U);
  assert(metrics.high_water_events == EVENT_CAPACITY);
  assert(metrics.current_events == EVENT_CAPACITY);

  assert(
      iterate_kit_device_event_poll(&fixture.queue, 1U) ==
      ITERATE_KIT_OK);
  assert(fixture.handled_count == 1U);
  assert(fixture.observed_count == 1U);
  assert(
      fixture.handled[0].type ==
      ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED);
  assert(
      fixture.handled[0].source ==
      ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL);

  fixture.fail_next = true;
  assert(
      iterate_kit_device_event_poll(&fixture.queue, 1U) ==
      ITERATE_KIT_IO_ERROR);
  assert(fixture.handled_count == 2U);
  assert(fixture.observed_count == 2U);
  assert(fixture.observed_results[1] == ITERATE_KIT_IO_ERROR);

  assert(
      iterate_kit_device_event_poll(&fixture.queue, 1U) ==
      ITERATE_KIT_OK);
  assert(fixture.handled_count == 2U);
  iterate_kit_device_event_queue_metrics(
      &fixture.queue, &metrics);
  assert(metrics.events_processed == 2U);
  assert(metrics.handler_failures == 1U);
  assert(metrics.current_events == 0U);
}

/*
 * Remote input and future device adapters can pass values outside the public
 * enums. Truncating those values into the compact two-byte queue entry was
 * rejected because an invalid value could alias a real actuator event. The
 * publisher must reject it before taking queue ownership or capacity, while
 * stable names remain available for diagnostics of valid events.
 */
static void invalid_events_are_rejected_without_entering_the_queue(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  assert(
      iterate_kit_device_event_publish(
          &fixture.queue,
          ITERATE_KIT_DEVICE_EVENT_TYPE_COUNT,
          ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL) ==
      ITERATE_KIT_INVALID_ARGUMENT);
  assert(
      iterate_kit_device_event_publish(
          &fixture.queue,
          ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED,
          ITERATE_KIT_DEVICE_EVENT_SOURCE_COUNT) ==
      ITERATE_KIT_INVALID_ARGUMENT);
  assert(strcmp(
      iterate_kit_device_event_type_name(
          ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED),
      "pushToTalk.started") == 0);
  assert(strcmp(
      iterate_kit_device_event_type_name(
          ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED),
      "conversation.started") == 0);
  assert(strcmp(
      iterate_kit_device_event_source_name(
          ITERATE_KIT_DEVICE_EVENT_SOURCE_REMOTE),
      "remote") == 0);
}

int main(void) {
  bounded_queue_never_waits_or_retries_failed_events();
  invalid_events_are_rejected_without_entering_the_queue();
  return 0;
}
