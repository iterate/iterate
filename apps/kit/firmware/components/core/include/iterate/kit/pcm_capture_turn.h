#ifndef ITERATE_KIT_PCM_CAPTURE_TURN_H
#define ITERATE_KIT_PCM_CAPTURE_TURN_H

#include "iterate/kit/pcm_lane.h"
#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  /*
   * Human button/RPC edges are sparse, but an owner-loop stall can overlap a
   * local and remote start/stop burst. Four entries retain two complete empty
   * turns in 20 bytes of storage (four command bytes plus four size_t lengths
   * on ESP32). A deeper queue would preserve obsolete intent during a fault;
   * saturation is instead returned to the control caller and measured.
   */
  ITERATE_KIT_PCM_CAPTURE_TURN_COMMAND_CAPACITY = 4,
};

typedef void (*iterate_kit_pcm_capture_turn_notify_fn)(void *context);

/**
 * Wire meaning of a publication stop.
 *
 * Manual PTT needs an ordered zero-length marker so userspace can commit the
 * just-finished turn. A continuous AEC stream connected to server-side VAD
 * must not invent that boundary: the provider, not the device, decides when
 * speech ends. Zero is deliberately the manual policy so older designated
 * initializers fail safe rather than silently removing PTT turn commits.
 */
enum iterate_kit_pcm_capture_stop_boundary {
  ITERATE_KIT_PCM_CAPTURE_STOP_EMIT_END_MARKER = 0,
  ITERATE_KIT_PCM_CAPTURE_STOP_SUPPRESS_END_MARKER,
};

struct iterate_kit_pcm_capture_turn_options {
  struct iterate_kit_pcm_lane *lane;
  enum iterate_kit_pcm_capture_stop_boundary stop_boundary;

  /*
   * Optional nonblocking edge notification for the PCM connection owner.
   * It runs after a frame/marker is visible in the lane and also after lane
   * backpressure sets the destructive epoch-reset request. It must not call
   * back into this object; a task notification or event bit is appropriate.
   * A polling-only host harness may leave it NULL.
   */
  iterate_kit_pcm_capture_turn_notify_fn notify_uplink;
  void *notify_uplink_context;
};

struct iterate_kit_pcm_capture_turn_metrics {
  struct iterate_kit_spsc_ring_metrics commands;
  uint32_t commands_accepted;
  uint32_t command_backpressure;
  uint32_t command_protocol_errors;
  uint32_t transitions_applied;
  uint32_t inactive_frames_discarded;
  uint32_t frames_accepted;
  uint32_t frame_backpressure;
  uint32_t frame_failures;
  uint32_t end_markers_accepted;
  uint32_t end_markers_suppressed;
  uint32_t end_marker_backpressure;
  uint32_t end_marker_failures;
  bool requested_active;
  bool active;
};

/**
 * Allocation-free publication boundary for continuous capture.
 *
 * Some full-duplex boards must keep microphone/reference capture and AEC
 * running while PTT is idle. This object gates only publication: the control
 * owner enqueues ordered start/stop commands, while the AEC task consumes them
 * and remains the sole producer of the PCM uplink ring. Consequently a manual
 * stop marker cannot overtake a frame already accepted by that same producer.
 * In server-VAD mode the same edge closes publication without a marker; that
 * policy is explicit and counted rather than inferred from device identity.
 * Idle clean frames are discarded immediately and explicitly; they never
 * become a delayed backlog and are not reported as network errors.
 *
 * Exactly one control producer calls request(). Exactly one realtime consumer
 * calls poll() and submit(). These owners may run on different cores. The
 * embedded SPSC ring's release/acquire publication transfers commands; metric
 * fields are relaxed atomics because snapshots convey diagnostics, not buffer
 * ownership. Calls allocate nothing, wait on no lock, perform bounded work,
 * and never retry a full queue or lane.
 *
 * This boundary orders complete PCM-v1 frames, not individual samples. A
 * platform whose DSP builds a wire frame across a physical button edge may
 * intentionally lose or include that partial boundary frame; it must document
 * and measure that device policy separately. No accepted complete frame can
 * be reordered behind its turn marker.
 */
struct iterate_kit_pcm_capture_turn {
  struct iterate_kit_pcm_capture_turn_options options;
  struct iterate_kit_spsc_ring command_ring;
  uint8_t command_storage[
      ITERATE_KIT_PCM_CAPTURE_TURN_COMMAND_CAPACITY];
  size_t command_lengths[
      ITERATE_KIT_PCM_CAPTURE_TURN_COMMAND_CAPACITY];
  uint32_t commands_accepted;
  uint32_t command_backpressure;
  uint32_t command_protocol_errors;
  uint32_t transitions_applied;
  uint32_t inactive_frames_discarded;
  uint32_t frames_accepted;
  uint32_t frame_backpressure;
  uint32_t frame_failures;
  uint32_t end_markers_accepted;
  uint32_t end_markers_suppressed;
  uint32_t end_marker_backpressure;
  uint32_t end_marker_failures;
  uint32_t producer_requested_active;
  uint32_t consumer_active;
  bool initialized;
};

enum iterate_kit_status iterate_kit_pcm_capture_turn_init(
    struct iterate_kit_pcm_capture_turn *turn,
    const struct iterate_kit_pcm_capture_turn_options *options);

/**
 * Enqueues one desired publication edge from the cooperative control owner.
 *
 * Repeating the producer's latest requested state is idempotent. Success means
 * only that the fixed command queue accepted the edge; active publication
 * changes when the realtime consumer calls poll(). BACKPRESSURE preserves the
 * prior requested state so the caller can report/retry the unaccepted action
 * without the diagnostics snapshot claiming it took effect.
 */
enum iterate_kit_status iterate_kit_pcm_capture_turn_request(
    struct iterate_kit_pcm_capture_turn *turn, bool active);

/**
 * Applies every currently queued command on the sole PCM producer task.
 *
 * Under EMIT_END_MARKER, a transition to inactive publishes the zero-length
 * end-of-turn marker after all complete frames previously accepted by
 * submit(). Under SUPPRESS_END_MARKER it only closes the gate and accounts for
 * the deliberately absent boundary. Returns UNAVAILABLE if no command existed,
 * OK after a successful bounded drain, or the exact marker publication failure
 * after consuming the responsible stop command.
 */
enum iterate_kit_status iterate_kit_pcm_capture_turn_poll(
    struct iterate_kit_pcm_capture_turn *turn, uint64_t now_ms);

/**
 * AEC-compatible clean-frame copy boundary, owned by the realtime consumer.
 *
 * Samples must be one exact PCM-v1 frame at the protocol sample rate.
 * captured_through_at_us is truncated to local monotonic milliseconds for the
 * lane metadata. Inactive frames return OK after an explicit discard so a
 * continuous DSP bridge does not treat normal idle capture as egress failure.
 */
enum iterate_kit_status iterate_kit_pcm_capture_turn_submit(
    struct iterate_kit_pcm_capture_turn *turn,
    const int16_t *samples,
    size_t sample_count,
    uint32_t sample_rate_hz,
    uint64_t captured_through_at_us);

/** Consumer-side state probe for a synchronous egress adapter. */
bool iterate_kit_pcm_capture_turn_is_active(
    const struct iterate_kit_pcm_capture_turn *turn);

void iterate_kit_pcm_capture_turn_metrics(
    const struct iterate_kit_pcm_capture_turn *turn,
    struct iterate_kit_pcm_capture_turn_metrics *metrics);

#ifdef __cplusplus
}
#endif

#endif
