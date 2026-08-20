#ifndef ITERATE_KIT_CAPABILITIES_SYSTEM_UPDATE_H
#define ITERATE_KIT_CAPABILITIES_SYSTEM_UPDATE_H

/*
 * `system.update({url, sha256})` — over-the-air firmware as a remote-triggered
 * capability, which is the only shape OTA is allowed to take on a client: the
 * server decides when and what; the device implements the mechanical fetch,
 * verify, and reboot. The module validates the request and hands it to a
 * platform driver; it holds no download or flash logic itself, so it builds
 * and tests on the host.
 */

#include "iterate/kit/peer.h"
#include "iterate/kit/status.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Accepts a validated update request. `url` is NUL-terminated http(s);
 * `sha256_hex` is exactly 64 lowercase hex characters, NUL-terminated. The
 * driver returns without blocking: ITERATE_KIT_OK when the download has been
 * scheduled, ITERATE_KIT_BACKPRESSURE when one is already in flight, and any
 * other status for a request it refused to start.
 */
struct iterate_kit_system_update_driver {
  void *context;
  enum iterate_kit_status (*begin)(
      void *context, const char *url, const char *sha256_hex);
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
