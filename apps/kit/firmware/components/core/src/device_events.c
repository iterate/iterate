#include "iterate/kit/device_events.h"

#include <limits.h>
#include <string.h>

/*
 * Physical button edges and remotely requested transitions must drive the same
 * audio state machine in one total order. This fixed single-owner queue is that
 * boundary. It avoids locks and allocation in the main loop, never blocks a
 * publisher, and exposes saturation rather than silently losing the start or
 * stop edge that determines whether microphone capture remains active.
 */
static bool power_of_two(size_t value) {
  return value != 0U && (value & (value - 1U)) == 0U;
}

static void saturating_increment(uint32_t *value) {
  /*
   * Endurance diagnostics must remain monotonic. Wrapping to zero would make a
   * worsening unattended fault look like recovery; UINT32_MAX means "at least
   * this many" and costs no wider atomics on ESP32.
   */
  if (*value != UINT32_MAX) {
    ++*value;
  }
}

static bool valid_type(enum iterate_kit_device_event_type type) {
  return type >= ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED &&
      type < ITERATE_KIT_DEVICE_EVENT_TYPE_COUNT;
}

static bool valid_source(enum iterate_kit_device_event_source source) {
  return source >= ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL &&
      source < ITERATE_KIT_DEVICE_EVENT_SOURCE_COUNT;
}

enum iterate_kit_status iterate_kit_device_event_queue_init(
    struct iterate_kit_device_event_queue *queue,
    const struct iterate_kit_device_event_queue_options *options) {
  if (queue == NULL ||
      options == NULL ||
      options->storage == NULL ||
      !power_of_two(options->capacity) ||
      options->capacity > (size_t)UINT32_MAX / 2U ||
      options->handler.handle == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  /*
   * Sequence arithmetic intentionally wraps modulo 2^32. Restricting capacity
   * to half that domain keeps producer-consumer subtraction unambiguous while
   * a power-of-two capacity maps sequence to storage with a mask.
   */
  memset(queue, 0, sizeof(*queue));
  memset(
      options->storage,
      0,
      options->capacity * sizeof(*options->storage));
  queue->options = *options;
  queue->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_device_event_publish(
    struct iterate_kit_device_event_queue *queue,
    enum iterate_kit_device_event_type type,
    enum iterate_kit_device_event_source source) {
  uint32_t depth;
  size_t index;
  if (queue == NULL ||
      !queue->initialized ||
      !valid_type(type) ||
      !valid_source(source)) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  depth = queue->producer_sequence - queue->consumer_sequence;
  if (depth >= queue->options.capacity) {
    /*
     * Do not overwrite the oldest edge. Replacing START with a newer STOP (or
     * vice versa) would hide which transition was lost. Backpressure lets the
     * caller log/recover and leaves the accepted queue internally coherent.
     */
    saturating_increment(&queue->publisher_backpressure);
    return ITERATE_KIT_BACKPRESSURE;
  }
  index =
      queue->producer_sequence & (uint32_t)(queue->options.capacity - 1U);
  queue->options.storage[index] =
      (struct iterate_kit_device_event){
        (uint8_t)type,
        (uint8_t)source,
      };
  ++queue->producer_sequence;
  saturating_increment(&queue->events_published);
  ++depth;
  if (depth > queue->high_water_events) {
    queue->high_water_events = depth;
  }
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_device_event_poll(
    struct iterate_kit_device_event_queue *queue,
    size_t max_events) {
  size_t processed = 0U;
  enum iterate_kit_status result = ITERATE_KIT_OK;
  if (queue == NULL ||
      !queue->initialized ||
      max_events == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (queue->polling) {
    /*
     * Recursive polling from a handler would evade max_events and could starve
     * the PCM/network loop under a feedback-producing observer.
     */
    return ITERATE_KIT_STATE_ERROR;
  }

  queue->polling = true;
  while (processed < max_events &&
         queue->consumer_sequence != queue->producer_sequence) {
    const size_t index =
        queue->consumer_sequence &
        (uint32_t)(queue->options.capacity - 1U);
    const struct iterate_kit_device_event event =
        queue->options.storage[index];
    /*
     * Consume before invoking user code. A failed handler is an observed,
     * one-shot event, not an implicit retry that can pin the queue forever.
     * The failure counter and return value preserve the postmortem.
     */
    ++queue->consumer_sequence;
    saturating_increment(&queue->events_processed);
    ++processed;
    result = queue->options.handler.handle(
        queue->options.handler.context, &event);
    if (result != ITERATE_KIT_OK) {
      saturating_increment(&queue->handler_failures);
    }
    if (queue->options.observer.observe != NULL) {
      queue->options.observer.observe(
          queue->options.observer.context, &event, result);
    }
    if (result != ITERATE_KIT_OK) {
      break;
    }
  }
  queue->polling = false;
  return result;
}

void iterate_kit_device_event_queue_metrics(
    const struct iterate_kit_device_event_queue *queue,
    struct iterate_kit_device_event_queue_metrics *metrics) {
  if (metrics == NULL) {
    return;
  }
  memset(metrics, 0, sizeof(*metrics));
  if (queue == NULL || !queue->initialized) {
    return;
  }
  metrics->events_published = queue->events_published;
  metrics->events_processed = queue->events_processed;
  metrics->publisher_backpressure = queue->publisher_backpressure;
  metrics->handler_failures = queue->handler_failures;
  metrics->high_water_events = queue->high_water_events;
  metrics->current_events =
      queue->producer_sequence - queue->consumer_sequence;
}

const char *iterate_kit_device_event_type_name(
    enum iterate_kit_device_event_type type) {
  switch (type) {
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STARTED:
      return "pushToTalk.started";
    case ITERATE_KIT_DEVICE_EVENT_PUSH_TO_TALK_STOPPED:
      return "pushToTalk.stopped";
    case ITERATE_KIT_DEVICE_EVENT_TYPE_COUNT:
      return "unknown";
  }
  return "unknown";
}

const char *iterate_kit_device_event_source_name(
    enum iterate_kit_device_event_source source) {
  switch (source) {
    case ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL:
      return "physical";
    case ITERATE_KIT_DEVICE_EVENT_SOURCE_REMOTE:
      return "remote";
    case ITERATE_KIT_DEVICE_EVENT_SOURCE_SYSTEM:
      return "system";
    case ITERATE_KIT_DEVICE_EVENT_SOURCE_COUNT:
      return "unknown";
  }
  return "unknown";
}
