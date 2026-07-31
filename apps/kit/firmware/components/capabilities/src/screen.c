#include "iterate/kit/capabilities/screen.h"

#include "rpc_internal.h"

#include <string.h>

/*
 * The RPC parser's string view does not outlive dispatch, whereas display
 * drivers may need a conventional NUL-terminated URL. Copy once into
 * caller-budgeted scratch rather than allocating. The driver remains
 * synchronous at this boundary; a platform that queues downloads must make an
 * explicit bounded copy so queueing policy cannot hide in this generic layer.
 */
static const char *const render_path[] = {"renderOnScreen"};
static const char *const change_colour_path[] = {"changeColour"};

static enum capnweb_status change_colour(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_screen *screen = context;
  struct capnweb_value value = {0};
  enum iterate_kit_screen_colour colour;
  enum iterate_kit_status status;
  if (call == NULL ||
      !call->has_arguments ||
      !capnweb_value_array_at(&call->arguments, 0U, &value)) {
    return capnweb_reply_set_error(
        reply, "TypeError", "expected red or green");
  }
  if (capnweb_value_string_equals(&value, "red")) {
    colour = ITERATE_KIT_SCREEN_RED;
  } else if (capnweb_value_string_equals(&value, "green")) {
    colour = ITERATE_KIT_SCREEN_GREEN;
  } else {
    return capnweb_reply_set_error(
        reply, "TypeError", "expected red or green");
  }
  status = screen->driver.change_colour(
      screen->driver.context, colour);
  if (status != ITERATE_KIT_OK) {
    return iterate_kit_reply_status(reply, status);
  }
  return capnweb_reply_set_boolean(reply, true);
}

static enum capnweb_status render(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_screen *screen = context;
  struct capnweb_value object = {0};
  struct capnweb_value url_value = {0};
  size_t url_length = 0U;
  enum iterate_kit_status status;
  if (!iterate_kit_read_object_argument(call, &object) ||
      !capnweb_value_object_get(&object, "url", &url_value) ||
      capnweb_value_copy_string(
          &url_value,
          screen->url_scratch,
          screen->url_scratch_size,
          &url_length) != CAPNWEB_OK) {
    return capnweb_reply_set_error(
        reply,
        "TypeError",
        "expected {url} within the configured UTF-8 byte bound");
  }
  status = screen->driver.render_png(
      screen->driver.context, screen->url_scratch, url_length);
  if (status != ITERATE_KIT_OK) {
    return iterate_kit_reply_status(reply, status);
  }
  return capnweb_reply_set_boolean(reply, true);
}

enum iterate_kit_status iterate_kit_screen_init(
    struct iterate_kit_screen *screen,
    const struct iterate_kit_screen_driver *driver,
    char *url_scratch,
    size_t url_scratch_size) {
  if (screen == NULL ||
      driver == NULL ||
      driver->render_png == NULL ||
      driver->change_colour == NULL ||
      url_scratch == NULL ||
      url_scratch_size < 2U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(screen, 0, sizeof(*screen));
  screen->driver = *driver;
  screen->url_scratch = url_scratch;
  screen->url_scratch_size = url_scratch_size;
  return ITERATE_KIT_OK;
}

struct iterate_kit_module iterate_kit_screen_module(
    struct iterate_kit_screen *screen) {
  static const struct iterate_kit_method methods[] = {
    {render_path, 1U, render},
    {change_colour_path, 1U, change_colour},
  };
  const struct iterate_kit_module module = {
    .methods = methods,
    .method_count = sizeof(methods) / sizeof(methods[0]),
    .context = screen,
    .poll = NULL,
    .close = NULL,
    .session_ended = NULL,
  };
  return module;
}
