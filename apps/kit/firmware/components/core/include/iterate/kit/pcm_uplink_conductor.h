#ifndef ITERATE_KIT_PCM_UPLINK_CONDUCTOR_H
#define ITERATE_KIT_PCM_UPLINK_CONDUCTOR_H

#include "iterate/kit/pcm_lane.h"
#include "iterate/kit/pcm_peer_delivery_guard.h"
#include "iterate/kit/pcm_uplink_sender.h"
#include "iterate/kit/status.h"
#include "iterate/kit/websocket_tx.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Result of one bounded conductor pass.
 *
 * IDLE means there was no application or control work. PROGRESS means at least
 * one protocol state or byte-stream boundary advanced and immediately-ready
 * work may remain after the fairness bound. The owner must give receive/control
 * work a turn and then call poll again without a timed sleep; on the 100 Hz
 * ESP32 target, interpreting “promptly” as the next tick would add 10 ms per
 * short write. DEFERRED is expected bounded backpressure: either the byte
 * stream would block or the peer-confirmation window is full. RESTART means
 * the current socket generation has been abandoned and must be replaced.
 * FAILED is reserved for a local invariant, clock, or writer-contract defect.
 *
 * Keeping RESTART separate from FAILED is operationally important. Wi-Fi loss
 * is normal recoverable input; a corrupt state machine is a release-blocking
 * defect. Combining them would either page on ordinary roaming or hide real
 * firmware faults inside a reconnect counter.
 */
enum iterate_kit_pcm_uplink_conductor_poll_result {
  ITERATE_KIT_PCM_UPLINK_CONDUCTOR_IDLE = 0,
  ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS,
  ITERATE_KIT_PCM_UPLINK_CONDUCTOR_DEFERRED,
  ITERATE_KIT_PCM_UPLINK_CONDUCTOR_RESTART,
  ITERATE_KIT_PCM_UPLINK_CONDUCTOR_FAILED,
};

struct iterate_kit_pcm_uplink_conductor_options {
  struct iterate_kit_pcm_lane *lane;
  struct iterate_kit_websocket_tx *tx;

  uint64_t restart_after_no_progress_ms;
  uint64_t maximum_frame_send_duration_ms;
  uint64_t maximum_capture_age_ms;

  uint32_t barrier_interval_frames;
  uint32_t maximum_unconfirmed_frames;
  uint32_t maximum_barrier_delay_ms;
  uint32_t maximum_confirmation_age_ms;
  /*
   * These are forwarded to the peer guard rather than implemented by the
   * platform loop. Keeping silent-socket liveness beside audio confirmation
   * makes one portable state machine own every ordered PING/PONG and prevents
   * two timers from racing for the transmitter's bounded control slot.
   */
  uint32_t idle_peer_probe_interval_ms;
  uint32_t idle_peer_probe_timeout_ms;

  /*
   * One pass may perform several immediately-ready writes so audio does not
   * wait for another scheduler tick after a short write. The bound prevents a
   * permanently writable socket from monopolising the network task and
   * starving receive/control work. It is a count of scheduling rounds, each of
   * which performs at most one raw byte-stream write.
   */
  uint32_t maximum_work_steps;
};

struct iterate_kit_pcm_uplink_conductor_metrics {
  struct iterate_kit_pcm_uplink_sender_metrics sender;
  struct iterate_kit_pcm_peer_delivery_guard_metrics
      peer_delivery;
  uint32_t policy_time_normalizations;
  uint32_t maximum_policy_time_adjustment_ms;
  uint32_t owner_clock_regressions;
};

/**
 * Portable owner of the complete microphone-to-WebSocket admission policy.
 *
 * This layer exists because separately-correct sender, WebSocket, and
 * peer-confirmation state machines can still be composed incorrectly. In
 * particular, a platform adapter can admit PCM before a parked control frame,
 * reuse a stale clock sample after a write, or forget to purge application
 * audio when replacing a socket. Keeping that ordering in ESP-IDF glue made
 * those bugs impossible to exercise in the deterministic host fault harness.
 *
 * The conductor owns no frame storage and performs no allocation or blocking
 * call of its own. It borrows one lane and one already-initialised sans-I/O
 * WebSocket transmitter. The transmitter's raw callback may perform one
 * nonblocking platform write per work step.
 *
 * Exactly one connection-owner task calls lifecycle, poll, and receive_pong.
 * A diagnostics task may call metrics concurrently; the published counters are
 * relaxed atomics because they report observations and never grant permission
 * to send. The object must not be copied after init: the embedded sender keeps
 * a self-reference as its transport callback context.
 */
struct iterate_kit_pcm_uplink_conductor {
  struct iterate_kit_pcm_uplink_sender sender;
  struct iterate_kit_pcm_peer_delivery_guard peer_delivery;
  struct iterate_kit_websocket_tx *tx;
  uint64_t last_sampled_now_ms;
  uint64_t policy_time_floor_ms;
  uint32_t maximum_work_steps;
  uint32_t connection_generation;
  uint32_t policy_time_normalizations;
  uint32_t maximum_policy_time_adjustment_ms;
  uint32_t owner_clock_regressions;
  bool has_last_sample;
  bool generation_active;
  bool initialized;
};

enum iterate_kit_status iterate_kit_pcm_uplink_conductor_init(
    struct iterate_kit_pcm_uplink_conductor *conductor,
    const struct iterate_kit_pcm_uplink_conductor_options
        *options);

/**
 * Starts a strictly newer socket generation.
 *
 * Captured audio from while the device was disconnected is not the beginning
 * of a realtime conversation: replaying it after connect would violate the
 * central freshness requirement. This operation therefore purges the whole
 * microphone epoch and resets connection-bound WebSocket/proof state before
 * admitting bytes to the new socket. `discarded_frames` makes that loss
 * explicit for diagnostics.
 */
enum iterate_kit_status
iterate_kit_pcm_uplink_conductor_begin_generation(
    struct iterate_kit_pcm_uplink_conductor *conductor,
    uint32_t connection_generation,
    uint32_t *discarded_frames);

/**
 * Ends the current generation and destroys every locally-owned path by which
 * its stale audio could later escape.
 *
 * The platform must still close the actual socket to destroy opaque
 * TLS/lwIP/Wi-Fi bytes. Calling this function twice is harmless and does not
 * erase the guard's last non-empty abandonment incident.
 */
enum iterate_kit_status
iterate_kit_pcm_uplink_conductor_abandon_generation(
    struct iterate_kit_pcm_uplink_conductor *conductor,
    uint32_t *discarded_frames);

/**
 * Purges microphone frames captured while no socket generation is active.
 *
 * This is intentionally separate from begin_generation(): a disconnected
 * device may keep producing PTT audio for minutes, and the fixed ring must not
 * repeatedly fill and raise misleading overflow incidents while reconnection
 * is already underway.
 */
enum iterate_kit_status
iterate_kit_pcm_uplink_conductor_discard_pending(
    struct iterate_kit_pcm_uplink_conductor *conductor,
    uint32_t *discarded_frames);

enum iterate_kit_pcm_uplink_conductor_poll_result
iterate_kit_pcm_uplink_conductor_poll(
    struct iterate_kit_pcm_uplink_conductor *conductor,
    uint64_t sampled_now_ms);

/**
 * Applies one peer-delivery pong on the same normalized policy clock as poll.
 *
 * UNAVAILABLE means ordinary unsolicited, stale, or replayed protocol traffic.
 * STATE_ERROR means the single owner supplied a backwards clock sample or
 * called the function outside an active generation.
 */
enum iterate_kit_status
iterate_kit_pcm_uplink_conductor_receive_pong(
    struct iterate_kit_pcm_uplink_conductor *conductor,
    const void *payload,
    size_t payload_size,
    uint64_t sampled_now_ms);

void iterate_kit_pcm_uplink_conductor_metrics(
    const struct iterate_kit_pcm_uplink_conductor *conductor,
    struct iterate_kit_pcm_uplink_conductor_metrics *metrics);

#ifdef __cplusplus
}
#endif

#endif
