#ifndef ITERATE_KIT_CAPABILITIES_SCREEN_H
#define ITERATE_KIT_CAPABILITIES_SCREEN_H

#include "iterate/kit/peer.h"
#include "iterate/kit/status.h"

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Device-specific image renderer behind a deliberately small public contract.
 *
 * `url` points into the module's caller-owned scratch buffer and remains valid
 * only for the synchronous call. A driver that schedules asynchronous work
 * must copy it into bounded storage of its own. Fetching, decoding, and display
 * ownership stay outside this module because their RAM and latency constraints
 * differ radically between an M5Stick and StackChan.
 */
enum iterate_kit_screen_colour {
  ITERATE_KIT_SCREEN_RED = 0,
  ITERATE_KIT_SCREEN_GREEN = 1,
};

struct iterate_kit_screen_driver {
  void *context;
  enum iterate_kit_status (*render_png)(
      void *context, const char *url, size_t url_length);
  enum iterate_kit_status (*change_colour)(
      void *context, enum iterate_kit_screen_colour colour);
};

struct iterate_kit_screen {
  struct iterate_kit_screen_driver driver;
  /*
   * Cap'n Web input storage is transient. Copying into one fixed scratch area
   * before calling hardware gives drivers a NUL-terminated value without a
   * heap allocation and turns excessive URLs into a deterministic RPC error.
   */
  char *url_scratch;
  size_t url_scratch_size;
};

/**
 * Borrows `url_scratch` and the driver's context for the module lifetime. The
 * caller must serialize dispatch because concurrent renders share that buffer.
 */
enum iterate_kit_status iterate_kit_screen_init(
    struct iterate_kit_screen *screen,
    const struct iterate_kit_screen_driver *driver,
    char *url_scratch,
    size_t url_scratch_size);
struct iterate_kit_module iterate_kit_screen_module(
    struct iterate_kit_screen *screen);

#ifdef __cplusplus
}
#endif

#endif
