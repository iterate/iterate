#include "iterate/kit/capabilities/health.h"

#include "rpc_internal.h"

#include <string.h>

/*
 * One method, no arguments, no state changed. The whole capability is a
 * rendering of numbers the device already keeps; everything interesting about
 * it is in the two rules its header states — that the renderer must be pure,
 * and that the buffer belongs to the device.
 */
static const char *const health_path[] = {"health"};

static enum capnweb_status health(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_health *state = context;
  size_t length;
  (void)call;
  length = state->driver.render(
      state->driver.context, state->buffer, state->capacity);
  if (length == 0U || length >= state->capacity) {
    /*
     * SAY SO RATHER THAN TRUNCATE. A clipped JSON document is not a smaller
     * answer, it is an unparseable one, and the caller would read the parse
     * failure as "the device is broken" rather than "the buffer is too small"
     * — which is a different repair in a different file.
     */
    return capnweb_reply_set_error(
        reply, "RangeError", "health document did not fit its buffer");
  }
  /*
   * Borrowed, not copied: the buffer outlives this dispatch by construction
   * (the device owns it for the life of the peer), and copying a couple of
   * kilobytes here would charge every health call a second buffer for no gain.
   */
  return capnweb_reply_set_borrowed_expression(
      reply, state->buffer, length, NULL, NULL);
}

enum iterate_kit_status iterate_kit_health_init(
    struct iterate_kit_health *health_state,
    const struct iterate_kit_health_driver *driver,
    char *buffer,
    size_t capacity) {
  if (health_state == NULL ||
      driver == NULL ||
      driver->render == NULL ||
      buffer == NULL ||
      /*
       * Below this a rendered document cannot be anything but truncated, and a
       * capability that can only fail is worse than one that is absent: it
       * advertises an answer it will never give.
       */
      capacity < 64U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(health_state, 0, sizeof(*health_state));
  health_state->driver = *driver;
  health_state->buffer = buffer;
  health_state->capacity = capacity;
  return ITERATE_KIT_OK;
}

struct iterate_kit_module iterate_kit_health_module(
    struct iterate_kit_health *health_state) {
  static const struct iterate_kit_method methods[] = {
    {health_path, 1U, health},
  };
  const struct iterate_kit_module module = {
    .methods = methods,
    .method_count = sizeof(methods) / sizeof(methods[0]),
    .context = health_state,
    .poll = NULL,
    .close = NULL,
    .session_ended = NULL,
  };
  return module;
}
