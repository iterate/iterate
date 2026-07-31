#ifndef ITERATE_KIT_PCM_UPLINK_SENDER_H
#define ITERATE_KIT_PCM_UPLINK_SENDER_H

#include "iterate/kit/pcm_lane.h"
#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Result of one platform send attempt.
 *
 * PROGRESS means part of the retained frame reached the current connection
 * and the platform will resume that same WebSocket frame on the next call.
 * TEMPORARILY_UNAVAILABLE means no progress was possible, but retrying the
 * exact retained frame on the same connection is safe. DISCONNECTED means
 * delivery is uncertain and the connection must be replaced.
 */
enum iterate_kit_pcm_uplink_send_outcome {
  ITERATE_KIT_PCM_UPLINK_SEND_COMPLETE = 0,
  ITERATE_KIT_PCM_UPLINK_SEND_PROGRESS,
  ITERATE_KIT_PCM_UPLINK_SEND_TEMPORARILY_UNAVAILABLE,
  ITERATE_KIT_PCM_UPLINK_SEND_DISCONNECTED,
  /*
   * FAILED is a local writer/state contract violation. It must not be mapped
   * to DISCONNECTED: reconnecting may make the next request look healthy while
   * silently preserving a deterministic firmware defect.
   */
  ITERATE_KIT_PCM_UPLINK_SEND_FAILED,
};

enum iterate_kit_pcm_uplink_sender_poll_result {
  ITERATE_KIT_PCM_UPLINK_SENDER_IDLE = 0,
  ITERATE_KIT_PCM_UPLINK_SENDER_SENT,
  ITERATE_KIT_PCM_UPLINK_SENDER_PROGRESS,
  ITERATE_KIT_PCM_UPLINK_SENDER_DEFERRED,
  ITERATE_KIT_PCM_UPLINK_SENDER_RESTART,
  ITERATE_KIT_PCM_UPLINK_SENDER_FAILED,
};

enum iterate_kit_pcm_uplink_restart_reason {
  ITERATE_KIT_PCM_UPLINK_RESTART_NONE = 0,
  ITERATE_KIT_PCM_UPLINK_RESTART_PRODUCER_BACKPRESSURE,
  ITERATE_KIT_PCM_UPLINK_RESTART_TRANSPORT_DISCONNECTED,
  ITERATE_KIT_PCM_UPLINK_RESTART_NO_PROGRESS_TIMEOUT,
  ITERATE_KIT_PCM_UPLINK_RESTART_FRAME_SEND_TIMEOUT,
  ITERATE_KIT_PCM_UPLINK_RESTART_CAPTURE_STALE,
};

typedef enum iterate_kit_pcm_uplink_send_outcome
    (*iterate_kit_pcm_uplink_send_fn)(
        void *context, const void *frame, size_t frame_bytes);

struct iterate_kit_pcm_uplink_sender_options {
  struct iterate_kit_pcm_lane *lane;
  iterate_kit_pcm_uplink_send_fn send;
  void *send_context;
  uint64_t restart_after_no_progress_ms;
  uint64_t maximum_frame_send_duration_ms;
  uint64_t maximum_capture_age_ms;
};

struct iterate_kit_pcm_uplink_sender_metrics {
  uint32_t frames_sent;
  uint32_t frames_discarded;
  uint32_t send_deferrals;
  uint32_t send_failures;
  uint32_t consecutive_send_deferrals;
  uint32_t maximum_consecutive_send_deferrals;
  uint32_t restart_incidents;
  uint32_t producer_backpressure_restarts;
  uint32_t transport_disconnect_restarts;
  uint32_t no_progress_timeout_restarts;
  uint32_t frame_send_timeout_restarts;
  uint32_t capture_stale_restarts;
  uint32_t last_transport_accept_age_ms;
  uint32_t maximum_transport_accept_age_ms;
  uint32_t last_restart_oldest_capture_age_ms;
  uint32_t last_restart_frames_discarded;
  enum iterate_kit_pcm_uplink_restart_reason last_restart_reason;
};

/**
 * Boundary event from one sender poll. transport_accepted means the complete
 * WebSocket frame entered the local transport; it does not claim peer receipt.
 *
 * Keeping this event separate from aggregate metrics lets the conductor update
 * its cross-core policy-time floor at the exact local acceptance boundary.
 * It must not be fed into a PONG-based credit scheme: local socket acceptance
 * and hop-level control replies prove neither proxy nor provider receipt.
 * Keeping both timestamps also prevents a future refactor from quietly
 * substituting poll time for microphone completion time in freshness policy.
 */
struct iterate_kit_pcm_uplink_sender_event {
  uint64_t capture_completed_at_ms;
  uint64_t transport_accepted_at_ms;
  bool transport_accepted;
};

/**
 * Allocation-free single-consumer PCM uplink pump.
 *
 * A temporary platform send deferral keeps ownership of the oldest frame so
 * it can be retried without copying or reordering. Both time without byte
 * progress and total frame age are bounded. An expired frame is discarded
 * observably and the caller is instructed to replace the socket.
 *
 * `now_ms` is a monotonic consumer-side sample. Because the microphone producer
 * publishes its own timestamp from another core, a just-acquired frame may be
 * stamped slightly later than that already-taken sample. The sender treats the
 * difference as zero age and publishes a normalized acceptance timestamp; it
 * never classifies normal cross-task scheduling skew as a fatal clock failure.
 */
struct iterate_kit_pcm_uplink_sender {
  struct iterate_kit_pcm_uplink_sender_options options;
  const void *pending_frame;
  size_t pending_frame_bytes;
  uint32_t frames_sent;
  uint32_t frames_discarded;
  uint32_t send_deferrals;
  uint32_t send_failures;
  uint32_t consecutive_send_deferrals;
  uint32_t maximum_consecutive_send_deferrals;
  uint32_t restart_incidents;
  uint32_t producer_backpressure_restarts;
  uint32_t transport_disconnect_restarts;
  uint32_t no_progress_timeout_restarts;
  uint32_t frame_send_timeout_restarts;
  uint32_t capture_stale_restarts;
  uint32_t last_transport_accept_age_ms;
  uint32_t maximum_transport_accept_age_ms;
  uint32_t last_restart_oldest_capture_age_ms;
  uint32_t last_restart_frames_discarded;
  uint32_t last_restart_reason;
  uint64_t pending_capture_completed_at_ms;
  uint64_t frame_started_at_ms;
  uint64_t last_progress_at_ms;
  bool frame_acquired;
  bool initialized;
};

enum iterate_kit_status iterate_kit_pcm_uplink_sender_init(
    struct iterate_kit_pcm_uplink_sender *sender,
    const struct iterate_kit_pcm_uplink_sender_options *options);

enum iterate_kit_pcm_uplink_sender_poll_result
iterate_kit_pcm_uplink_sender_poll(
    struct iterate_kit_pcm_uplink_sender *sender,
    uint64_t now_ms,
    struct iterate_kit_pcm_uplink_sender_event *event);

/**
 * Discards every queued frame, including a frame retained after a temporary
 * send deferral. Intended for a known-disconnected socket.
 */
enum iterate_kit_status iterate_kit_pcm_uplink_sender_discard_pending(
    struct iterate_kit_pcm_uplink_sender *sender,
    uint32_t *discarded_frames);

void iterate_kit_pcm_uplink_sender_metrics(
    const struct iterate_kit_pcm_uplink_sender *sender,
    struct iterate_kit_pcm_uplink_sender_metrics *metrics);

const char *iterate_kit_pcm_uplink_restart_reason_name(
    enum iterate_kit_pcm_uplink_restart_reason reason);

#ifdef __cplusplus
}
#endif

#endif
