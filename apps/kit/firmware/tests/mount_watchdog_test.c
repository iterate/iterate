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
  assert(!iterate_kit_mount_watchdog_due(&watchdog, 0U, true, 1000U));
  assert(!iterate_kit_mount_watchdog_due(&watchdog, 0U, true, 1000U + 1000U));
  assert(iterate_kit_mount_watchdog_due(&watchdog, 0U, true, 1000U + OVERDUE));
  assert(watchdog.remounts == 1U);
}

/* Anything calling the device proves the mount, so the clock restarts. */
static void being_called_is_proof(void) {
  struct iterate_kit_mount_watchdog watchdog = {0};
  (void)iterate_kit_mount_watchdog_due(&watchdog, 0U, true, 0U);
  (void)iterate_kit_mount_watchdog_due(&watchdog, 1U, true, OVERDUE - 10U);
  assert(!iterate_kit_mount_watchdog_due(&watchdog, 1U, true, OVERDUE));
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
    assert(!iterate_kit_mount_watchdog_due(&watchdog, 0U, false, now));
  }
  assert(watchdog.remounts == 0U);
}

/* Going idle starts the clock then, not retroactively from the last call. */
static void the_clock_starts_when_the_device_goes_idle(void) {
  struct iterate_kit_mount_watchdog watchdog = {0};
  (void)iterate_kit_mount_watchdog_due(&watchdog, 0U, false, 100000U);
  assert(!iterate_kit_mount_watchdog_due(&watchdog, 0U, true, 100000U + OVERDUE - 1U));
  assert(iterate_kit_mount_watchdog_due(&watchdog, 0U, true, 100000U + OVERDUE * 2U));
}

/* Asking again must not fire twice in a row on the same silence. */
static void one_re_registration_per_silence(void) {
  struct iterate_kit_mount_watchdog watchdog = {0};
  (void)iterate_kit_mount_watchdog_due(&watchdog, 0U, true, 0U);
  assert(iterate_kit_mount_watchdog_due(&watchdog, 0U, true, OVERDUE));
  assert(!iterate_kit_mount_watchdog_due(&watchdog, 0U, true, OVERDUE + 1U));
  assert(watchdog.remounts == 1U);
}

static void an_absent_watchdog_never_fires(void) {
  assert(!iterate_kit_mount_watchdog_due(NULL, 0U, true, OVERDUE));
}

int main(void) {
  silence_eventually_re_registers();
  being_called_is_proof();
  a_busy_device_is_never_interrupted();
  the_clock_starts_when_the_device_goes_idle();
  one_re_registration_per_silence();
  an_absent_watchdog_never_fires();
  return 0;
}
