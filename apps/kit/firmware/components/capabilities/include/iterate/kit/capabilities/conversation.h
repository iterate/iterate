#ifndef ITERATE_KIT_CAPABILITIES_CONVERSATION_H
#define ITERATE_KIT_CAPABILITIES_CONVERSATION_H

#include "iterate/kit/device_events.h"
#include "iterate/kit/peer.h"
#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum iterate_kit_status
(*iterate_kit_conversation_request_playback_interruption_fn)(
    void *context, uint32_t *token);
typedef enum iterate_kit_status
(*iterate_kit_conversation_poll_playback_interruption_fn)(
    void *context, uint32_t token);

/**
 * Nonblocking adapter from the generic capability to a physical audio owner.
 *
 * request() must only admit one bounded reset command and return its token;
 * OK does not mean the speaker is clean. poll() returns UNAVAILABLE until the
 * physical owner has made all retained/queued pre-interruption samples
 * unreachable, then returns OK or the exact failure. Both callbacks execute on
 * the cooperative peer owner and must never wait for the audio task.
 */
struct iterate_kit_conversation_playback_interruption_driver {
  void *context;
  iterate_kit_conversation_request_playback_interruption_fn request;
  iterate_kit_conversation_poll_playback_interruption_fn poll;
  uint32_t acknowledgement_timeout_ms;
};

struct iterate_kit_conversation_metrics {
  uint32_t playback_interruption_requests;
  uint32_t playback_interruption_completions;
  uint32_t playback_interruption_failures;
  uint32_t playback_interruption_timeouts;
  uint32_t playback_interruption_cancellations;
  uint32_t playback_interruption_backpressure;
  bool playback_interruption_pending;
  bool playback_interruption_responder_active;
};

/**
 * Remote control for one device conversation lifecycle.
 *
 * Start/hang-up dispatch only publishes into the same bounded owner-task queue
 * as physical input. Playback interruption is the one asynchronous method: it
 * stores a single Cap'n Web responder and resolves literal true only after the
 * injected physical owner acknowledges its purge. The module adds no task,
 * heap allocation, retry queue, or blocking edge.
 */
struct iterate_kit_conversation {
  struct iterate_kit_device_event_queue *events;
  struct iterate_kit_conversation_playback_interruption_driver
      playback_interruption;
  struct capnweb_responder playback_interruption_responder;
  uint32_t playback_interruption_token;
  uint64_t playback_interruption_started_ms;
  uint32_t playback_interruption_requests;
  uint32_t playback_interruption_completions;
  uint32_t playback_interruption_failures;
  uint32_t playback_interruption_timeouts;
  uint32_t playback_interruption_cancellations;
  uint32_t playback_interruption_backpressure;
  bool playback_interruption_pending;
  bool playback_interruption_clock_started;
  bool playback_interruption_responder_active;
  bool initialized;
};

enum iterate_kit_status iterate_kit_conversation_init(
    struct iterate_kit_conversation *conversation,
    struct iterate_kit_device_event_queue *events);
enum iterate_kit_status
iterate_kit_conversation_bind_playback_interruption(
    struct iterate_kit_conversation *conversation,
    const struct iterate_kit_conversation_playback_interruption_driver
        *driver);
void iterate_kit_conversation_metrics(
    const struct iterate_kit_conversation *conversation,
    struct iterate_kit_conversation_metrics *metrics);
struct iterate_kit_module iterate_kit_conversation_module(
    struct iterate_kit_conversation *conversation);

#ifdef __cplusplus
}
#endif

#endif
