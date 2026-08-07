#include "iterate/kit/mount_watchdog.h"

#include "iterate/kit/voice_device_profile.h"

#include <assert.h>
#include <stddef.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

enum { OVERDUE = ITERATE_KIT_VOICE_IDLE_REMOUNT_MS + 1 };

/* The failure this exists for: a board unreachable until somebody unplugs it. */
static void silence_eventually_re_registers(void) {
  struct iterate_kit_mount_watchdog watchdog = {0};
  assert(!iterate_kit_mount_watchdog_due(&watchdog, 0U, false, 1000U));
  assert(!iterate_kit_mount_watchdog_due(&watchdog, 0U, false, 1000U + 1000U));
  assert(iterate_kit_mount_watchdog_due(&watchdog, 0U, false, 1000U + OVERDUE));
  assert(watchdog.remounts == 1U);
}

/* Anything calling the device proves the mount, so the clock restarts. */
static void being_called_is_proof(void) {
  struct iterate_kit_mount_watchdog watchdog = {0};
  (void)iterate_kit_mount_watchdog_due(&watchdog, 0U, false, 0U);
  (void)iterate_kit_mount_watchdog_due(&watchdog, 1U, false, OVERDUE - 10U);
  assert(!iterate_kit_mount_watchdog_due(&watchdog, 1U, false, OVERDUE));
  assert(watchdog.remounts == 0U);
}

/*
 * NEVER DURING A CALL. A reconnect costs eight seconds; mid-conversation that
 * is the conversation. A busy device is also provably reachable — something
 * started that conversation.
 */
static void a_busy_device_is_never_interrupted(void) {
  struct iterate_kit_mount_watchdog watchdog = {0};
  for (uint64_t now = 0U; now < OVERDUE * 3U; now += 1000U) {
    assert(!iterate_kit_mount_watchdog_due(&watchdog, 0U, true, now));
  }
  assert(watchdog.remounts == 0U);
}

/* Going idle starts the clock then, not retroactively from the last call. */
static void the_clock_starts_when_the_device_goes_idle(void) {
  struct iterate_kit_mount_watchdog watchdog = {0};
  (void)iterate_kit_mount_watchdog_due(&watchdog, 0U, true, 100000U);
  assert(!iterate_kit_mount_watchdog_due(&watchdog, 0U, false, 100000U + OVERDUE - 1U));
  assert(iterate_kit_mount_watchdog_due(&watchdog, 0U, false, 100000U + OVERDUE * 2U));
}

/* Asking again must not fire twice in a row on the same silence. */
static void one_re_registration_per_silence(void) {
  struct iterate_kit_mount_watchdog watchdog = {0};
  (void)iterate_kit_mount_watchdog_due(&watchdog, 0U, false, 0U);
  assert(iterate_kit_mount_watchdog_due(&watchdog, 0U, false, OVERDUE));
  assert(!iterate_kit_mount_watchdog_due(&watchdog, 0U, false, OVERDUE + 1U));
  assert(watchdog.remounts == 1U);
}

static void an_absent_watchdog_never_fires(void) {
  assert(!iterate_kit_mount_watchdog_due(NULL, 0U, false, OVERDUE));
}

/*
 * WANTING A CALL IS NOT BEING IN ONE, and conflating them wedged a board.
 *
 * The four device loops used to pass `!wants_call && !call_active &&
 * !call_pending`, so a device whose user had asked for a call it could not
 * start never re-registered — which is exactly the device whose mount has gone
 * server-side. Measured on the StackChan: unreachable for ten minutes,
 * `livenessRestarts` 0, no self-restart, recovered only by reflashing. Twice.
 *
 * This pins the seam's half of that contract: nothing in flight means the
 * clock runs, however badly the device wishes it were in a call.
 */
static void a_wish_is_not_a_call(void) {
  struct iterate_kit_mount_watchdog watchdog = {0};
  assert(!iterate_kit_mount_watchdog_due(&watchdog, 0U, false, 1000U));
  assert(iterate_kit_mount_watchdog_due(&watchdog, 0U, false, 1000U + OVERDUE));
  assert(watchdog.remounts == 1U);
}

int main(void) {
  silence_eventually_re_registers();
  being_called_is_proof();
  a_busy_device_is_never_interrupted();
  the_clock_starts_when_the_device_goes_idle();
  one_re_registration_per_silence();
  a_wish_is_not_a_call();
  an_absent_watchdog_never_fires();
  return 0;
}
