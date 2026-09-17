#ifndef ITERATE_KIT_PLATFORMS_SYSTEM_UPDATE_H
#define ITERATE_KIT_PLATFORMS_SYSTEM_UPDATE_H
#include "iterate/kit/status.h"
#ifdef __cplusplus
extern "C" {
#endif
/** A Mac has no OTA slot: the capability mounts, and refuses. */
enum iterate_kit_status iterate_kit_platform_system_update_begin(
    void *context, const char *url, const char *sha256_hex);
#ifdef __cplusplus
}
#endif
#endif
