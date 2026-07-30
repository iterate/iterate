#ifndef ITERATE_KIT_CAPABILITIES_LEDS_H
#define ITERATE_KIT_CAPABILITIES_LEDS_H

#include "iterate/kit/peer.h"
#include "iterate/kit/status.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Hardware-only RGB boundary. RPC validation is intentionally kept in the
 * generic module so every LED device rejects the same malformed commands
 * before narrowing integers or touching a bus. Driver calls are synchronous,
 * allocation-free, and must be invoked from the capability owner's task.
 */
struct iterate_kit_led_driver {
  void *context;
  enum iterate_kit_status (*set)(
      void *context,
      uint8_t index,
      uint8_t red,
      uint8_t green,
      uint8_t blue);
  enum iterate_kit_status (*fill)(
      void *context, uint8_t red, uint8_t green, uint8_t blue);
};

struct iterate_kit_leds {
  struct iterate_kit_led_driver driver;
  /* The public index is one byte, so initialization rejects larger strips. */
  size_t led_count;
};

/**
 * Copies the driver table into caller-owned state. The driver context remains
 * borrowed for the lifetime of the module; no hardware initialization is
 * implied here.
 */
enum iterate_kit_status iterate_kit_leds_init(
    struct iterate_kit_leds *leds,
    const struct iterate_kit_led_driver *driver,
    size_t led_count);
struct iterate_kit_module iterate_kit_leds_module(
    struct iterate_kit_leds *leds);

#ifdef __cplusplus
}
#endif

#endif
