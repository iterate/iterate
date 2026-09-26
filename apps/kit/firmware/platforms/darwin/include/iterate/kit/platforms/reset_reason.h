#ifndef ITERATE_KIT_PLATFORMS_RESET_REASON_H
#define ITERATE_KIT_PLATFORMS_RESET_REASON_H

#include <stdbool.h>
#ifdef __cplusplus
extern "C" {
#endif
/** A process has one reason to start: it was started. */
const char *iterate_kit_platform_reset_reason_name(void);

/** A process was started by someone, so always true (see the ESP header). */
bool iterate_kit_platform_reset_by_person(void);
#ifdef __cplusplus
}
#endif
#endif
