#ifndef ITERATE_KIT_CAPABILITIES_DEVICE_EVENT_STREAM_H
#define ITERATE_KIT_CAPABILITIES_DEVICE_EVENT_STREAM_H

#include "iterate/kit/capabilities/callback_budget.h"
#include "iterate/kit/device_events.h"
#include "iterate/kit/peer.h"
#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * One processed device-state notification retained until a remote callback can
 * accept it.
 *
 * This is control state, never PCM. Sequence is device-boot-local and lets the
 * userspace proxy detect a coalesced transition instead of silently leaving a
 * provider turn open. `snapshot` is emitted once after subscription so a
 * reconnect while the physical button is held can restore the current state
 * without replaying an invented edge.
 */
struct iterate_kit_device_event_notification {
  int64_t sequence;
  uint32_t coalesced_notifications;
  int32_t result;
  uint8_t type;
  uint8_t source;
  bool snapshot;
};

struct iterate_kit_device_event_stream_options {
  /*
   * The stream and storage are owned by the same cooperative task as the
   * Cap'n Web session. Capacity must be a non-zero power of two. Four or eight
   * compact entries are normally enough because human button edges are sparse;
   * saturation keeps the newest state and increments an observable counter.
   */
  struct capnweb_session *session;
  struct iterate_kit_device_event_notification *storage;
  size_t capacity;
  struct iterate_kit_callback_budget *callback_budget;
};

/**
 * A single-owner bounded `subscribeToEvents(callback)` capability.
 *
 * One subscriber is intentional for the MVP: the userspace worker is the
 * device's sole lifecycle owner and can fan events out to streams elsewhere.
 * A second on-device fanout would consume Cap'n Web calls and control-ring RAM
 * on the audio-critical board. A new callback replaces an idle callback on the
 * same control session because `/pcm` Worker generations can turn over without
 * reconnecting that session; an in-flight callback cannot be replaced until
 * its completion makes ownership unambiguous. Every accepted owner gets a
 * current-state snapshot. Deliveries never overlap. If the callback is slow,
 * accepted state changes occupy caller-provided storage; when it is exhausted,
 * the newest state replaces the newest queued notification and its
 * sequence/counter make that loss explicit to userspace.
 */
struct iterate_kit_device_event_stream {
  struct iterate_kit_device_event_stream_options options;
  struct capnweb_remote_capability callback;
  struct iterate_kit_poll_result pending_result;
  int64_t sequence;
  uint32_t coalesced_notifications;
  size_t queue_head;
  size_t queue_count;
  bool current_active;
  bool occupied;
  bool call_in_flight;
  bool callback_budget_reserved;
  bool release_pending;
  bool initialized;
};

enum iterate_kit_status iterate_kit_device_event_stream_init(
    struct iterate_kit_device_event_stream *stream,
    const struct iterate_kit_device_event_stream_options *options);

/**
 * Records the result of one already-processed device event.
 *
 * This does not call the remote peer inline. It only updates current state and
 * a fixed local queue; the module poll performs at most one callback call.
 * ITERATE_KIT_BACKPRESSURE means an older queued representation was coalesced,
 * not that the local audio transition failed.
 */
enum iterate_kit_status iterate_kit_device_event_stream_observe(
    struct iterate_kit_device_event_stream *stream,
    const struct iterate_kit_device_event *event,
    enum iterate_kit_status result);

struct iterate_kit_module iterate_kit_device_event_stream_module(
    struct iterate_kit_device_event_stream *stream);

#ifdef __cplusplus
}
#endif

#endif
