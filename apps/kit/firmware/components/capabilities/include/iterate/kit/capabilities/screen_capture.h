#ifndef ITERATE_KIT_CAPABILITIES_SCREEN_CAPTURE_H
#define ITERATE_KIT_CAPABILITIES_SCREEN_CAPTURE_H

#include "iterate/kit/peer.h"
#include "iterate/kit/status.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * One encoded snapshot of the pixels currently owned by a device display.
 *
 * Screen capture can require a temporary PNG allocation even when the steady
 * state UI is allocation-free. The release callback makes that exceptional
 * ownership explicit: after a successful reply construction Cap'n Web owns the
 * callback; every rejected or oversized result is released by this module.
 */
struct iterate_kit_captured_screen {
  const uint8_t *data;
  size_t size;
  capnweb_release_fn release;
  void *release_context;
};

/**
 * Device-specific framebuffer/panel capture boundary.
 *
 * The callback is synchronous and must either return a complete encoded PNG or
 * a classified failure. It must not hide a queue: a screenshot delayed behind
 * several older requests is stale UI evidence and could contend with realtime
 * audio long after the caller stopped caring about it.
 */
struct iterate_kit_screen_capture_driver {
  void *context;
  enum iterate_kit_status (*capture_png)(
      void *context, struct iterate_kit_captured_screen *capture);
};

struct iterate_kit_screen_capture {
  struct iterate_kit_screen_capture_driver driver;
  /* Bounds encoder bugs and the single-message Cap'n Web control reply. */
  size_t maximum_png_bytes;
};

enum iterate_kit_status iterate_kit_screen_capture_init(
    struct iterate_kit_screen_capture *screen_capture,
    const struct iterate_kit_screen_capture_driver *driver,
    size_t maximum_png_bytes);
struct iterate_kit_module iterate_kit_screen_capture_module(
    struct iterate_kit_screen_capture *screen_capture);

#ifdef __cplusplus
}
#endif

#endif
