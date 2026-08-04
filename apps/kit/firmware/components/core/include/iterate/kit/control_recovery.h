#ifndef ITERATE_KIT_CONTROL_RECOVERY_H
#define ITERATE_KIT_CONTROL_RECOVERY_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Action emitted by the allocation-free control recovery supervisor. */
enum iterate_kit_control_recovery_action {
  ITERATE_KIT_CONTROL_RECOVERY_NONE = 0,
  ITERATE_KIT_CONTROL_RECOVERY_REMOUNT_CONTROL,
  ITERATE_KIT_CONTROL_RECOVERY_RESTART_PROCESS,
};

struct iterate_kit_control_recovery_observation {
  uint64_t now_ms;
  uint64_t fatal_restart_after_ms;
  uint64_t idle_remount_after_ms;
  uint32_t ready_generation;
  uint32_t served_dispatches;
  bool fatal_latched;
  bool control_ready;
  bool conversation_active;
};

/**
 * Caller-owned state for converting a permanent transport latch into one
 * bounded process-restart request.
 *
 * The ESP-IDF transport distinguishes retryable socket-generation failures
 * from local invariants that cannot recover during this boot. Device targets
 * should not each recreate the timing edge cases around that distinction.
 * This tiny portable state machine is shared by Stick, StackChan, and future
 * ESPHome adapters and can be driven under the host fault harness without an
 * ESP scheduler, heap, task, or timer.
 */
struct iterate_kit_control_recovery {
  uint64_t fatal_since_ms;
  uint64_t control_idle_since_ms;
  uint32_t control_idle_generation;
  uint32_t last_served_dispatches;
  /**
   * Idle remounts asked for since anything inbound last arrived.
   *
   * Each remount replaces the socket, which bumps the ready generation, which
   * starts a new idle episode — so without this the interval would repeat
   * forever and a device nobody is calling would reconnect every 90s for as long
   * as it stayed idle. Measured: 29 remounts in 47 minutes on a healthy,
   * unreachable-by-nobody board. The count doubles the wait instead, and only a
   * real inbound dispatch (or a conversation) clears it — being idle is not
   * evidence of being orphaned, but nothing else the device can see distinguishes
   * the two.
   */
  uint32_t consecutive_idle_remounts;
  bool fatal_active;
  bool restart_emitted;
  bool control_idle_tracking;
  bool control_remount_emitted;
};

/**
 * How far the idle-remount wait may double: 1x, 2x, 4x, 8x and no further.
 *
 * Eight times ninety seconds is twelve minutes, which is long enough that an
 * idle device is quiet rather than churning, and short enough that a genuinely
 * orphaned one still heals without hands.
 */
enum { ITERATE_KIT_CONTROL_RECOVERY_MAX_BACKOFF_SHIFT = 3 };

void iterate_kit_control_recovery_init(
    struct iterate_kit_control_recovery *recovery);

/**
 * Observe control liveness and return at most one recovery action per fault.
 *
 * `now_ms` must normally be monotonic. A regression restarts the grace window
 * rather than underflowing into an immediate reboot. Clearing `fatal_latched`
 * cancels the fatal incident completely; ordinary transient FAILED states
 * therefore remain owned by the transport's reconnect policy.
 *
 * `served_dispatches` is the peer's saturating count of inbound capability
 * dispatches. A READY socket with neither a new generation nor a dispatch for
 * `idle_remount_after_ms` requests one control remount, but only while no
 * conversation is active. This closes the otherwise invisible state where
 * the server has forgotten a live mount while WebSocket pings remain healthy.
 */
enum iterate_kit_control_recovery_action iterate_kit_control_recovery_poll(
    struct iterate_kit_control_recovery *recovery,
    const struct iterate_kit_control_recovery_observation *observation);

#ifdef __cplusplus
}
#endif

#endif
