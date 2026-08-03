#ifndef ITERATE_KIT_CAPABILITIES_AVATAR_H
#define ITERATE_KIT_CAPABILITIES_AVATAR_H

#include "iterate/kit/peer.h"
#include "iterate/kit/status.h"

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Device-specific sprite-set selection behind a portable RPC boundary.
 *
 * The public value is a stable catalogue slug, not an array index: generated
 * atlas order is an implementation detail and may change between firmware
 * builds. The callback is synchronous and receives caller-owned scratch that
 * remains valid only for the call. Drivers must not retain the pointer.
 */
struct iterate_kit_avatar_driver {
  void *context;
  enum iterate_kit_status (*change_sprite_set)(
      void *context, const char *slug, size_t slug_length);
};

struct iterate_kit_avatar {
  struct iterate_kit_avatar_driver driver;
  /*
   * Cap'n Web string storage is transient and may be JSON-escaped. Decode it
   * once into caller-budgeted memory rather than allocating or exposing parser
   * representation to a display driver.
   */
  char *slug_scratch;
  size_t slug_scratch_size;
};

enum iterate_kit_status iterate_kit_avatar_init(
    struct iterate_kit_avatar *avatar,
    const struct iterate_kit_avatar_driver *driver,
    char *slug_scratch,
    size_t slug_scratch_size);
struct iterate_kit_module iterate_kit_avatar_module(
    struct iterate_kit_avatar *avatar);

#ifdef __cplusplus
}
#endif

#endif
