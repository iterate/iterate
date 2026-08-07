#include "iterate/kit/mount_watchdog.h"

#include "iterate/kit/voice_device_profile.h"

#include <stddef.h>

bool iterate_kit_mount_watchdog_due(
    struct iterate_kit_mount_watchdog *watchdog,
    uint64_t dispatches,
    bool call_in_flight,
    uint64_t now_ms) {
  if (watchdog == NULL) return false;
  /*
   * Any inbound call, and any moment the device is busy, restarts the clock.
   * Busy counts because a device in a conversation is provably reachable —
   * something started that conversation.
   */
  if (dispatches != watchdog->dispatches_shown || call_in_flight) {
    watchdog->dispatches_shown = dispatches;
    watchdog->quiet_since_ms = now_ms;
    watchdog->counting = !call_in_flight;
    return false;
  }
  if (!watchdog->counting) {
    watchdog->counting = true;
    watchdog->quiet_since_ms = now_ms;
    return false;
  }
  if (iterate_kit_voice_elapsed_ms(now_ms, watchdog->quiet_since_ms) <=
      (uint64_t)ITERATE_KIT_VOICE_IDLE_REMOUNT_MS) {
    return false;
  }
  watchdog->quiet_since_ms = now_ms;
  ++watchdog->remounts;
  return true;
}
