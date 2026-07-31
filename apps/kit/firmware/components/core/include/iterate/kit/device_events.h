#ifndef ITERATE_KIT_DEVICE_EVENTS_H
#define ITERATE_KIT_DEVICE_EVENTS_H

#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum iterate_kit_device_event_type {
  ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED = 0,
  ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED,
  ITERATE_KIT_DEVICE_EVENT_CONVERSATION_STARTED,
  ITERATE_KIT_DEVICE_EVENT_CONVERSATION_ENDED,
  ITERATE_KIT_DEVICE_EVENT_TYPE_COUNT,
};

enum iterate_kit_device_event_source {
  ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL = 0,
  ITERATE_KIT_DEVICE_EVENT_SOURCE_REMOTE,
  ITERATE_KIT_DEVICE_EVENT_SOURCE_SYSTEM,
  ITERATE_KIT_DEVICE_EVENT_SOURCE_COUNT,
};

/**
 * Compact queue entry. Public publishers take typed enums and validate them;
 * the stored representation deliberately costs two bytes per pending event.
 */
struct iterate_kit_device_event {
  uint8_t type;
  uint8_t source;
};

typedef enum iterate_kit_status (*iterate_kit_device_event_handler_fn)(
    void *context,
    const struct iterate_kit_device_event *event);
typedef void (*iterate_kit_device_event_observer_fn)(
    void *context,
    const struct iterate_kit_device_event *event,
    enum iterate_kit_status result);

struct iterate_kit_device_event_handler {
  void *context;
  iterate_kit_device_event_handler_fn handle;
};

struct iterate_kit_device_event_observer {
  void *context;
  iterate_kit_device_event_observer_fn observe;
};

struct iterate_kit_device_event_queue_options {
  /*
   * All storage and callbacks are borrowed for the queue lifetime. Capacity
   * must be a power of two so sequence-to-slot mapping is one bounded mask,
   * with no division in the device loop.
   */
  struct iterate_kit_device_event *storage;
  size_t capacity;
  struct iterate_kit_device_event_handler handler;
  struct iterate_kit_device_event_observer observer;
};

struct iterate_kit_device_event_queue_metrics {
  uint32_t events_published;
  uint32_t events_processed;
  uint32_t publisher_backpressure;
  uint32_t handler_failures;
  uint32_t high_water_events;
  uint32_t current_events;
};

/**
 * Allocation-free, single-task event queue. Both GPIO edge collection and
 * Cap'n Web dispatch run on its owner task. Publishing and polling never wait.
 * A handler failure consumes that event once and is returned to the owner;
 * there is no implicit retry loop.
 *
 * This is deliberately not ISR-safe or multi-producer. Platforms must first
 * marshal ISR/cross-core edges onto the owner task. Making that restriction
 * explicit keeps the hot path free of locks and atomics and gives physical and
 * remote push-to-talk transitions one deterministic order.
 */
struct iterate_kit_device_event_queue {
  struct iterate_kit_device_event_queue_options options;
  uint32_t producer_sequence;
  uint32_t consumer_sequence;
  uint32_t events_published;
  uint32_t events_processed;
  uint32_t publisher_backpressure;
  uint32_t handler_failures;
  uint32_t high_water_events;
  bool polling;
  bool initialized;
};

enum iterate_kit_status iterate_kit_device_event_queue_init(
    struct iterate_kit_device_event_queue *queue,
    const struct iterate_kit_device_event_queue_options *options);

enum iterate_kit_status iterate_kit_device_event_publish(
    struct iterate_kit_device_event_queue *queue,
    enum iterate_kit_device_event_type type,
    enum iterate_kit_device_event_source source);

/**
 * Processes at most `max_events` entries to bound work per main-loop turn.
 * Reentrant polling is rejected because a handler recursively draining the
 * queue would defeat that latency budget. Events published by a handler remain
 * queued for this or a later bounded iteration.
 */
enum iterate_kit_status iterate_kit_device_event_poll(
    struct iterate_kit_device_event_queue *queue,
    size_t max_events);

void iterate_kit_device_event_queue_metrics(
    const struct iterate_kit_device_event_queue *queue,
    struct iterate_kit_device_event_queue_metrics *metrics);

const char *iterate_kit_device_event_type_name(
    enum iterate_kit_device_event_type type);
const char *iterate_kit_device_event_source_name(
    enum iterate_kit_device_event_source source);

#ifdef __cplusplus
}
#endif

#endif
