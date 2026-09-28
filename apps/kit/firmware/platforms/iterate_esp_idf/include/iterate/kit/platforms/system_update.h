#ifndef ITERATE_KIT_PLATFORMS_SYSTEM_UPDATE_H
#define ITERATE_KIT_PLATFORMS_SYSTEM_UPDATE_H

/*
 * The ESP-IDF half of `system.update`: esp_https_ota into the inactive OTA
 * slot, the slot's SHA-256 checked against the digest the caller named, then a
 * restart into it under the bootloader's rollback. system_update.c describes
 * the steps; the firmware README (Over-the-air updates) the whole path.
 */

#include "iterate/kit/status.h"

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** `iterate_kit_system_update_driver.begin`, so the voice loop mounts it. */
enum iterate_kit_status iterate_kit_platform_system_update_begin(
    void *context, const char *url, const uint8_t sha256[32]);

/**
 * Accept the running image: an image a `system.update` just booted is marked
 * valid, so the bootloader no longer rolls it back. The transport calls this
 * when it first reaches READY. Idempotent.
 */
void iterate_kit_esp_system_update_accept(void);

#ifdef __cplusplus
}
#endif

#endif
