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
  if (observation->ready_generation > recovery->highest_ready_generation) {
    const bool replaces_ready_generation =
        recovery->highest_ready_generation != 0U;
    recovery->highest_ready_generation = observation->ready_generation;
    /*
     * A recurring Cap'n Web callback is an export in one control generation;
     * it silently dies when that generation is replaced. Replacing the live
     * PCM session gives userspace one unambiguous owner that installs fresh
     * event and metrics callbacks. The first READY generation only gates the
     * initial PCM start, so restarting there would create a boot-time loop.
     */
    if (replaces_ready_generation && observation->pcm_started) {
      return ITERATE_KIT_CONTROL_RECOVERY_RESTART_PCM;
    }
  }
  return ITERATE_KIT_CONTROL_RECOVERY_NONE;
}
