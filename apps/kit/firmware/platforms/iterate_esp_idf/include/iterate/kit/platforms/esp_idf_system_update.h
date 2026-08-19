#ifndef ITERATE_KIT_PLATFORMS_ESP_IDF_SYSTEM_UPDATE_H
#define ITERATE_KIT_PLATFORMS_ESP_IDF_SYSTEM_UPDATE_H

/*
 * The ESP-IDF half of `system.update`: stream an image over HTTP(S) into the
 * inactive OTA slot, verify its SHA-256 against the digest the server named,
 * set the boot partition, and restart with a classified note. Signature
 * matches `iterate_kit_system_update_driver.begin` so the voice loop can
 * mount it directly.
 */

#include "iterate/kit/status.h"

#ifdef __cplusplus
extern "C" {
#endif

enum iterate_kit_status iterate_kit_esp_idf_system_update_begin(
    void *context, const char *url, const char *sha256_hex);

#ifdef __cplusplus
}
#endif

#endif
