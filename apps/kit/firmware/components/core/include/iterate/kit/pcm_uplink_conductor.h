#ifndef ITERATE_KIT_PCM_UPLINK_CONDUCTOR_H
#define ITERATE_KIT_PCM_UPLINK_CONDUCTOR_H

#include "iterate/kit/pcm_lane.h"
#include "iterate/kit/pcm_uplink_sender.h"
#include "iterate/kit/pcm_websocket.h"
#include "iterate/kit/status.h"
#include "iterate/kit/websocket_tx.h"

#include <stdbool.h>
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
 * stream would block. RESTART means the current socket generation has been
 * abandoned and must be replaced. FAILED is reserved for a local invariant,
 * clock, or writer-contract defect.
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
  uint32_t in_place_freshness_recoveries;
  uint32_t socket_restarts;
  uint32_t policy_time_normalizations;
  uint32_t maximum_policy_time_adjustment_ms;
  uint32_t owner_clock_regressions;
  uint32_t downlink_items_received;
  uint32_t downlink_items_acknowledged;
  uint32_t downlink_receipts_sent;
  uint32_t downlink_receipt_send_deferrals;
};

/**
 * Portable owner of the complete microphone-to-WebSocket admission policy.
 *
 * This layer exists because separately-correct sender and WebSocket state
 * machines can still be composed incorrectly. In particular, a platform
 * adapter can admit PCM before a mandatory PONG reply, reuse a stale clock
 * sample after a write, or forget to purge application audio when replacing a
 * socket. Keeping that ordering in ESP-IDF glue made those bugs impossible to
 * exercise in the deterministic host fault harness.
 *
 * The conductor owns no frame storage and performs no allocation or blocking
 * call of its own. It borrows one lane and one already-initialised sans-I/O
 * WebSocket transmitter. The transmitter's raw callback may perform one
 * nonblocking platform write per work step.
 *
 * Exactly one connection-owner task calls lifecycle and poll. A diagnostics
 * task may call metrics concurrently; the published counters are relaxed
 * atomics because they report observations and never grant permission to send.
 * The object must not be copied after init: the embedded sender keeps a
 * self-reference as its transport callback context.
 *
 * This object deliberately does not interpret WebSocket PONG as PCM delivery
 * credit. A PONG proves only hop-level ordered parsing, not userspace proxy or
 * provider receipt. The inverse speaker direction uses one explicit cumulative
 * application receipt: workerd has no server-side bufferedAmount, so only the
 * device can bound bytes hidden after userspace send(). Receipt writes share
 * this owner and transmitter with microphone PCM and can therefore be proved
 * non-interleaving under partial writes without a second task or mutex.
 */
struct iterate_kit_pcm_uplink_conductor {
  struct iterate_kit_pcm_uplink_sender sender;
  struct iterate_kit_websocket_tx *tx;
  uint64_t last_sampled_now_ms;
  uint64_t policy_time_floor_ms;
  uint64_t in_place_recovery_started_at_ms;
  uint32_t maximum_work_steps;
  uint32_t connection_generation;
  uint32_t in_place_freshness_recoveries;
  uint32_t socket_restarts;
  uint32_t policy_time_normalizations;
  uint32_t maximum_policy_time_adjustment_ms;
  uint32_t owner_clock_regressions;
  uint8_t downlink_receipt_payload[
      ITERATE_KIT_PCM_V1_DOWNLINK_RECEIPT_BYTES];
  uint32_t downlink_items_received;
  uint32_t downlink_items_acknowledged;
  uint32_t downlink_receipt_inflight_items;
  uint32_t downlink_receipts_sent;
  uint32_t downlink_receipt_send_deferrals;
  bool has_last_sample;
  bool in_place_recovery_active;
  bool generation_active;
  bool downlink_receipt_pending;
  bool downlink_receipt_active;
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
 * microphone epoch and resets connection-bound WebSocket state before
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
 * erase lifetime sender diagnostics.
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

/**
 * Records one complete server-to-device PCM frame or response-end marker after
 * it has been published to the playback lane.
 *
 * The next poll emits a cumulative fixed-size receipt before acquiring a new
 * microphone frame. Repeated calls coalesce while a prior receipt is queued;
 * an already partially written receipt remains immutable and is followed by a
 * newer cumulative receipt. Only the connection-owner task may call this.
 */
enum iterate_kit_status
iterate_kit_pcm_uplink_conductor_note_downlink_item(
    struct iterate_kit_pcm_uplink_conductor *conductor);

enum iterate_kit_pcm_uplink_conductor_poll_result
iterate_kit_pcm_uplink_conductor_poll(
    struct iterate_kit_pcm_uplink_conductor *conductor,
    uint64_t sampled_now_ms);

void iterate_kit_pcm_uplink_conductor_metrics(
    const struct iterate_kit_pcm_uplink_conductor *conductor,
    struct iterate_kit_pcm_uplink_conductor_metrics *metrics);

#ifdef __cplusplus
}
#endif

#endif
