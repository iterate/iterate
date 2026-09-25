#ifndef ITERATE_KIT_PLATFORMS_RESET_REASON_H
#define ITERATE_KIT_PLATFORMS_RESET_REASON_H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Why this board last restarted, as a word for `health()`.
 *
 * A DEVICE THAT REBOOTS AND CANNOT SAY WHY. Uptime going backwards is how a
 * restart is noticed at all, and by then the evidence is gone: the panic went
 * to a console nobody had open, and opening one to look REBOOTS these boards,
 * destroying the state being investigated. Measured: an HA Voice PE restarted
 * in the middle of a latency run and the only trace was that its uptime was
 * four minutes younger than boards flashed after it.
 *
 * The chip keeps the answer across the restart. This is one word of it, which
 * costs nothing and separates the three cases that look identical from the
 * outside — a panic, a watchdog, and somebody pressing reset.
 *
 * Never NULL; an unrecognised code answers "unknown".
 */
const char *iterate_kit_platform_reset_reason_name(void);

/**
 * Whether a person probably caused this boot: power applied, the reset button,
 * or a USB host (flashing, opening a console). The board narrates its
 * connection out loud only after these (iterate/kit/announcer.h); an update,
 * a crash or a watchdog restarts it with nobody there to hear.
 */
bool iterate_kit_platform_reset_by_person(void);

#ifdef __cplusplus
}
#endif

#endif /* ITERATE_KIT_PLATFORMS_RESET_REASON_H */
