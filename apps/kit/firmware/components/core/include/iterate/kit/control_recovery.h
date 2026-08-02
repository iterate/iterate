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
  ITERATE_KIT_CONTROL_RECOVERY_RESTART_PCM,
  ITERATE_KIT_CONTROL_RECOVERY_RESTART_PROCESS,
};

struct iterate_kit_control_recovery_observation {
  uint64_t now_ms;
  uint64_t fatal_restart_after_ms;
  uint32_t ready_generation;
  bool fatal_latched;
  bool pcm_started;
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
  uint32_t highest_ready_generation;
  bool fatal_active;
  bool restart_emitted;
};

void iterate_kit_control_recovery_init(
    struct iterate_kit_control_recovery *recovery);

/**
 * Observe the current fatal latch and return at most one restart action.
 *
 * `now_ms` must normally be monotonic. A regression restarts the grace window
 * rather than underflowing into an immediate reboot. Clearing `fatal_latched`
 * cancels the incident completely; ordinary transient FAILED states therefore
 * remain owned by the transport's reconnect policy.
 */
enum iterate_kit_control_recovery_action iterate_kit_control_recovery_poll(
    struct iterate_kit_control_recovery *recovery,
    const struct iterate_kit_control_recovery_observation *observation);

#ifdef __cplusplus
}
#endif

#endif
