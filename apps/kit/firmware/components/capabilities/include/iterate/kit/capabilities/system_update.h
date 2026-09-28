#ifndef ITERATE_KIT_CAPABILITIES_SYSTEM_UPDATE_H
#define ITERATE_KIT_CAPABILITIES_SYSTEM_UPDATE_H

/*
 * `system.update({url, sha256})`: over-the-air firmware as a capability the
 * board lends. The caller decides when and which image; the board fetches,
 * verifies and reboots into it. This module validates the request and hands it
 * to the platform's driver, so it builds and tests on the host. The whole path,
 * and how to invoke it, is in the firmware README (Over-the-air updates).
 */

#include "iterate/kit/peer.h"
#include "iterate/kit/status.h"

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* The longest url accepted, including its terminator. */
#define ITERATE_KIT_SYSTEM_UPDATE_URL_CAPACITY 512

/*
 * `url` is an https url, NUL-terminated, shorter than the capacity above;
 * `sha256` is the image's digest, decoded. `begin` returns without blocking:
 * ITERATE_KIT_OK once the download is scheduled, ITERATE_KIT_BACKPRESSURE while
 * one is already in flight, any other status for a platform that cannot start
 * it (the Mac has no OTA slot).
 */
struct iterate_kit_system_update_driver {
  void *context;
  enum iterate_kit_status (*begin)(
      void *context, const char *url, const uint8_t sha256[32]);
};

struct iterate_kit_system_update {
  struct iterate_kit_system_update_driver driver;
};

enum iterate_kit_status iterate_kit_system_update_init(
    struct iterate_kit_system_update *update,
    const struct iterate_kit_system_update_driver *driver);

struct iterate_kit_module iterate_kit_system_update_module(
    struct iterate_kit_system_update *update);

#ifdef __cplusplus
}
#endif

#endif
