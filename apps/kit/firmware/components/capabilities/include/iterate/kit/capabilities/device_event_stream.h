#ifndef ITERATE_KIT_CAPABILITIES_DEVICE_EVENT_STREAM_H
#define ITERATE_KIT_CAPABILITIES_DEVICE_EVENT_STREAM_H

#include "iterate/kit/audio.h"
#include "iterate/kit/capabilities/callback_budget.h"
#include "iterate/kit/capabilities/subscription.h"
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
 * reconnect while either button-owned state machine is active can restore the
 * current state without replaying an invented edge. `conversation_active` is
 * repeated on ordinary events as a bounded state checksum; it is not a second
 * event source and does not imply ordering with PCM on the other socket.
 */
struct iterate_kit_device_event_notification {
  int64_t sequence;
  uint32_t coalesced_notifications;
  int32_t result;
  uint8_t type;
  uint8_t source;
  bool conversation_active;
  bool snapshot;
};

struct iterate_kit_device_event_stream;

/**
 * One caller-owned observer of the shared ordered event history.
 *
 * The payload ring is shared because a button edge has one truth regardless
 * of how many observers consume it. Each subscriber needs only a cursor and
 * callback lifecycle state. This avoids copying eight event objects per
 * diagnostic observer while ensuring that a test harness can never evict the
 * production `/pcm` owner. A slow observer resynchronizes from a snapshot
 * after the shared history overtakes its cursor; it cannot hold back another
 * observer or accumulate an unbounded private backlog.
 */
struct iterate_kit_device_event_subscription {
  struct iterate_kit_device_event_stream *owner;
  struct capnweb_remote_capability callback;
  struct iterate_kit_subscription_owner_key owner_key;
  int64_t next_sequence;
  uint32_t coalesced_notifications;
  bool occupied;
  bool call_in_flight;
  bool callback_budget_reserved;
  bool release_pending;
  bool snapshot_pending;
  bool sequence_limit_delivered;
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
  /*
   * Subscriber slots are explicit profile RAM. Two slots are sufficient for
   * the production userspace owner plus one independent diagnostic harness;
   * a board may choose another finite count and receives a visible RPC error
   * when it is exhausted.
   */
  struct iterate_kit_device_event_subscription *subscriptions;
  size_t subscription_count;
  struct iterate_kit_callback_budget *callback_budget;
  /*
   * Selects the state represented by the first subscription snapshot. A PTT
   * device snapshots its held/released speech gate; a continuous-AEC device
   * snapshots conversation lifetime because server VAD owns speech turns.
   */
  enum iterate_kit_audio_mode audio_mode;
};

/**
 * A bounded multi-observer `subscribeToEvents(callback)` capability.
 *
 * Subscribers share one fixed recent-event ring but advance independently.
 * Every accepted observer first receives a current-state snapshot. Deliveries
 * never overlap for one callback, and poll emits at most one callback across
 * the whole module so diagnostic fanout cannot create an unreviewed control
 * burst. If a slow observer falls behind the shared ring, only that observer
 * receives a new snapshot with an incremented coalescing counter. Fast
 * observers retain exact ordering and are never disconnected or delayed by
 * the slow one.
 */
struct iterate_kit_device_event_stream {
  struct iterate_kit_device_event_stream_options options;
  struct iterate_kit_poll_result pending_result;
  int64_t sequence;
  size_t queue_head;
  size_t queue_count;
  size_t next_poll_index;
  bool conversation_active;
  bool current_active;
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
