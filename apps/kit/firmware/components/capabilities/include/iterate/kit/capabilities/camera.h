#ifndef ITERATE_KIT_CAPABILITIES_CAMERA_H
#define ITERATE_KIT_CAPABILITIES_CAMERA_H

#include "iterate/kit/peer.h"
#include "iterate/kit/status.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

struct iterate_kit_photo {
  /*
   * The driver lends or transfers one contiguous encoded image. `release` is
   * the ownership boundary: after a successful RPC reply construction Cap'n
   * Web owns that callback, while a rejected/oversized reply releases it here.
   * This avoids copying camera-sized payloads into a second firmware buffer.
   * Drivers must keep `data` valid until the callback runs.
   */
  const uint8_t *data;
  size_t size;
  capnweb_release_fn release;
  void *release_context;
};

/**
 * Synchronous camera boundary used by the generic capability module.
 *
 * The module deliberately knows nothing about frame buffers, JPEG quality, or
 * sensor tasks. A platform may borrow a hardware frame buffer and return its
 * release hook, but it must not return before `photo` describes stable bytes.
 * Slow capture therefore belongs on a device-appropriate task; this generic
 * dispatch layer neither allocates nor creates an implicit work queue.
 */
struct iterate_kit_camera_driver {
  void *context;
  enum iterate_kit_status (*take_photo)(
      void *context, struct iterate_kit_photo *photo);
};

struct iterate_kit_camera {
  struct iterate_kit_camera_driver driver;
  /*
   * A camera or corrupt driver must not turn one RPC into unbounded memory or
   * wire work. The device profile chooses a limit appropriate to its RAM and
   * transport; the module enforces it before transferring payload ownership.
   */
  size_t maximum_photo_bytes;
};

/**
 * Initializes caller-owned, allocation-free state. `driver` is copied, but
 * its context and every object it refers to must outlive `camera`.
 */
enum iterate_kit_status iterate_kit_camera_init(
    struct iterate_kit_camera *camera,
    const struct iterate_kit_camera_driver *driver,
    size_t maximum_photo_bytes);
struct iterate_kit_module iterate_kit_camera_module(
    struct iterate_kit_camera *camera);

#ifdef __cplusplus
}
#endif

#endif
