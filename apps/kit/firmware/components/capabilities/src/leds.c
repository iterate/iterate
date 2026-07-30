#include "iterate/kit/capabilities/leds.h"

#include "rpc_internal.h"

#include <limits.h>
#include <string.h>

/*
 * Keep parsing and range policy above the driver boundary. In particular,
 * converting Cap'n Web's signed 64-bit integers before validation would let
 * negative or oversized values wrap into plausible LED commands. The tiny
 * synchronous driver then sees only hardware-representable bytes and does not
 * need to understand RPC values.
 */
static const char *const set_path[] = {"leds", "set"};
static const char *const fill_path[] = {"leds", "fill"};

static bool byte_value(int64_t value) {
  return value >= 0 && value <= UCHAR_MAX;
}

static enum capnweb_status set(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_leds *leds = context;
  struct capnweb_value object = {0};
  int64_t index = 0;
  int64_t red = 0;
  int64_t green = 0;
  int64_t blue = 0;
  enum iterate_kit_status status;
  if (!iterate_kit_read_object_argument(call, &object) ||
      !iterate_kit_read_int_field(&object, "index", &index) ||
      !iterate_kit_read_int_field(&object, "red", &red) ||
      !iterate_kit_read_int_field(&object, "green", &green) ||
      !iterate_kit_read_int_field(&object, "blue", &blue) ||
      index < 0 ||
      (uint64_t)index >= leds->led_count ||
      !byte_value(red) ||
      !byte_value(green) ||
      !byte_value(blue)) {
    return capnweb_reply_set_error(
        reply, "RangeError", "LED command is outside the configured limits");
  }
  status = leds->driver.set(
      leds->driver.context,
      (uint8_t)index,
      (uint8_t)red,
      (uint8_t)green,
      (uint8_t)blue);
  if (status != ITERATE_KIT_OK) {
    return iterate_kit_reply_status(reply, status);
  }
  return capnweb_reply_set_boolean(reply, true);
}

static enum capnweb_status fill(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_leds *leds = context;
  struct capnweb_value object = {0};
  int64_t red = 0;
  int64_t green = 0;
  int64_t blue = 0;
  enum iterate_kit_status status;
  if (!iterate_kit_read_object_argument(call, &object) ||
      !iterate_kit_read_int_field(&object, "red", &red) ||
      !iterate_kit_read_int_field(&object, "green", &green) ||
      !iterate_kit_read_int_field(&object, "blue", &blue) ||
      !byte_value(red) ||
      !byte_value(green) ||
      !byte_value(blue)) {
    return capnweb_reply_set_error(
        reply, "RangeError", "expected red, green, and blue byte values");
  }
  status = leds->driver.fill(
      leds->driver.context,
      (uint8_t)red,
      (uint8_t)green,
      (uint8_t)blue);
  if (status != ITERATE_KIT_OK) {
    return iterate_kit_reply_status(reply, status);
  }
  return capnweb_reply_set_boolean(reply, true);
}

enum iterate_kit_status iterate_kit_leds_init(
    struct iterate_kit_leds *leds,
    const struct iterate_kit_led_driver *driver,
    size_t led_count) {
  if (leds == NULL ||
      driver == NULL ||
      driver->set == NULL ||
      driver->fill == NULL ||
      led_count == 0U ||
      led_count > UINT8_MAX) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  /*
   * The index passed to drivers is uint8_t to keep every dispatch compact.
   * Rejecting a larger strip here is preferable to silently making its upper
   * LEDs unreachable or widening the ABI later at individual call sites.
   */
  memset(leds, 0, sizeof(*leds));
  leds->driver = *driver;
  leds->led_count = led_count;
  return ITERATE_KIT_OK;
}

struct iterate_kit_module iterate_kit_leds_module(
    struct iterate_kit_leds *leds) {
  static const struct iterate_kit_method methods[] = {
    {set_path, 2U, set},
    {fill_path, 2U, fill},
  };
  const struct iterate_kit_module module = {
    .methods = methods,
    .method_count = sizeof(methods) / sizeof(methods[0]),
    .context = leds,
    .poll = NULL,
    .close = NULL,
    .session_ended = NULL,
  };
  return module;
}
