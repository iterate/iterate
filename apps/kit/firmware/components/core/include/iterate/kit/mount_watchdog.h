#ifndef ITERATE_KIT_MOUNT_WATCHDOG_H
#define ITERATE_KIT_MOUNT_WATCHDOG_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * When an idle device should re-register a mount nobody has called.
 *
 * A DEVICE CANNOT TELL "NOBODY WANTS ME" FROM "NOBODY CAN REACH ME", and that
 * is the whole of this policy. Measured across an afternoon: boards became
 * unreachable — every RPC answered `capability "kit.…" is offline` — while the
 * transport stayed ready, pings kept being answered and `livenessRestarts`
 * stayed 0. The server-side reason is that the live provider was in-memory
 * state in a Durable Object whose incarnation had died while the mount RECORD
 * survived, and the device's own traffic lands in a DIFFERENT Durable Object,
 * so it could not even keep the right one warm. Nothing observable from the
 * device distinguishes that from a quiet afternoon.
 *
 * So the device stops trying to distinguish them and simply asks again. The
 * cost is one reconnect nobody is listening to; the alternative was a board
 * that stayed unreachable until somebody power-cycled it.
 *
 * Pure, so the four boards share one answer and it can be tested without
 * hardware — the previous version of this was thirty-five lines pasted into
 * four device files with the interval hardcoded in each.
 */
struct iterate_kit_mount_watchdog {
  uint64_t dispatches_shown;
  uint64_t quiet_since_ms;
  /*
   * Explicit, because zero is a legal timestamp. Using `quiet_since_ms == 0`
   * as the "clock not started" sentinel meant a device that went quiet at
   * uptime zero — which is every device, at boot — never started counting.
   * The host test found it on the first run; the four pasted copies this
   * replaces had carried it for a day with nowhere to notice.
   */
  bool counting;
  /** Re-registrations asked for, published so a silent backstop is visible. */
  uint32_t remounts;
};

/**
 * Reports whether a re-registration is due, and counts it when it is.
 *
 * `dispatches` is the device's served-dispatch total: any inbound call proves
 * the mount reachable and resets the clock.
 *
 * `call_in_flight` suppresses the remount, and is deliberately narrow: a call
 * that is UP, or a start that has been sent and not yet answered. A reconnect
 * costs those a conversation.
 *
 * IT MUST NOT INCLUDE "SOMEBODY WANTS A CALL", which is what it used to, in
 * four identical copies. Wanting one is not having one, and a board that wants
 * a call it cannot start is the exact board whose mount has gone — so the old
 * predicate switched the backstop off precisely when it was needed and left
 * the device unreachable until somebody power-cycled it. Measured on the
 * StackChan: unreachable for ten minutes with `livenessRestarts` 0, no
 * self-restart (`restartNote` empty), recovered only by reflashing, twice.
 */
bool iterate_kit_mount_watchdog_due(
    struct iterate_kit_mount_watchdog *watchdog,
    uint64_t dispatches,
    bool call_in_flight,
    uint64_t now_ms);

#ifdef __cplusplus
}
#endif

#endif
