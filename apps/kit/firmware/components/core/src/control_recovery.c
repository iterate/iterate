#include "iterate/kit/control_recovery.h"

#include <stddef.h>
#include <string.h>

void iterate_kit_control_recovery_init(
    struct iterate_kit_control_recovery *recovery) {
  if (recovery == NULL)
    return;
  memset(recovery, 0, sizeof(*recovery));
}

enum iterate_kit_control_recovery_action iterate_kit_control_recovery_poll(
    struct iterate_kit_control_recovery *recovery,
    const struct iterate_kit_control_recovery_observation *observation) {
  enum iterate_kit_control_recovery_action action =
      ITERATE_KIT_CONTROL_RECOVERY_NONE;
  if (recovery == NULL || observation == NULL) {
    return ITERATE_KIT_CONTROL_RECOVERY_NONE;
  }
  if (!observation->fatal_latched) {
    /*
     * FAILED is visible during normal generation replacement. Reset all
     * supervisor state as soon as the transport says no permanent latch is
     * present; remembering elapsed time across independent incidents could
     * otherwise turn a later fault into an immediate reboot.
     */
    recovery->fatal_since_ms = 0U;
    recovery->fatal_active = false;
    recovery->restart_emitted = false;
  } else if (!recovery->fatal_active) {
    recovery->fatal_active = true;
    recovery->fatal_since_ms = observation->now_ms;
  } else if (observation->now_ms < recovery->fatal_since_ms) {
    /* Avoid unsigned elapsed-time underflow if the supplied clock regresses. */
    recovery->fatal_since_ms = observation->now_ms;
    return ITERATE_KIT_CONTROL_RECOVERY_NONE;
  }
  if (observation->fatal_latched && !recovery->restart_emitted &&
      observation->now_ms - recovery->fatal_since_ms >=
          observation->fatal_restart_after_ms) {
    recovery->restart_emitted = true;
    return ITERATE_KIT_CONTROL_RECOVERY_RESTART_PROCESS;
  }
  if (observation->fatal_latched) {
    return ITERATE_KIT_CONTROL_RECOVERY_NONE;
  }
  /*
   * A transport can keep answering RFC 6455 and Cap'n Web pings after the
   * server-side capability host has evicted its live provider. The socket is
   * healthy in that state; only replacing the generation can publish a fresh
   * mount. Track application dispatches rather than pings so the timer
   * measures exactly the proof we need.
   *
   * A call is a hard exclusion, not merely activity. Remounting invalidates
   * session-scoped callback exports, so restarting control during a live PCM
   * session would turn a preventive watchdog into an audible interruption.
   * Leaving READY or entering a conversation restarts the full quiet window.
   */
  if (!observation->control_ready ||
      observation->conversation_active ||
      observation->ready_generation == 0U ||
      observation->idle_remount_after_ms == 0U) {
    recovery->control_idle_tracking = false;
    recovery->control_remount_emitted = false;
    recovery->control_idle_generation = observation->ready_generation;
    recovery->last_served_dispatches = observation->served_dispatches;
    return action;
  }
  if (!recovery->control_idle_tracking ||
      recovery->control_idle_generation != observation->ready_generation ||
      recovery->last_served_dispatches != observation->served_dispatches) {
    /*
     * A DISPATCH CLEARS THE BACKOFF; A NEW GENERATION DOES NOT.
     *
     * Somebody asking the device something is the only proof its mount works, so
     * that is what makes the next idle wait short again. A new generation, by
     * contrast, is usually THIS state machine's own remount — treating it as
     * progress is what made the interval repeat forever.
     */
    if (recovery->last_served_dispatches != observation->served_dispatches) {
      recovery->consecutive_idle_remounts = 0U;
    }
    recovery->control_idle_tracking = true;
    recovery->control_remount_emitted = false;
    recovery->control_idle_since_ms = observation->now_ms;
    recovery->control_idle_generation = observation->ready_generation;
    recovery->last_served_dispatches = observation->served_dispatches;
    return action;
  }
  if (observation->now_ms < recovery->control_idle_since_ms) {
    recovery->control_idle_since_ms = observation->now_ms;
    return action;
  }
  {
    /* Doubling, capped: 90s, 180s, 360s, 720s, and no longer than that. */
    const unsigned shift =
        recovery->consecutive_idle_remounts >
                (uint32_t)ITERATE_KIT_CONTROL_RECOVERY_MAX_BACKOFF_SHIFT
            ? (unsigned)ITERATE_KIT_CONTROL_RECOVERY_MAX_BACKOFF_SHIFT
            : (unsigned)recovery->consecutive_idle_remounts;
    const uint64_t wait_ms = observation->idle_remount_after_ms << shift;
    if (!recovery->control_remount_emitted &&
        observation->now_ms - recovery->control_idle_since_ms >= wait_ms) {
      recovery->control_remount_emitted = true;
      if (recovery->consecutive_idle_remounts < UINT32_MAX) {
        ++recovery->consecutive_idle_remounts;
      }
      if (action == ITERATE_KIT_CONTROL_RECOVERY_NONE) {
        action = ITERATE_KIT_CONTROL_RECOVERY_REMOUNT_CONTROL;
      }
    }
  }
  return action;
}
