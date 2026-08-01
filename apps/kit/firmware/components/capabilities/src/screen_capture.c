#include "iterate/kit/capabilities/screen_capture.h"

#include "rpc_internal.h"

#include <string.h>

static const char *const capture_screen_path[] = {"captureScreen"};

static enum capnweb_status capture_screen(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_screen_capture *screen_capture = context;
  struct iterate_kit_captured_screen capture = {0};
  enum iterate_kit_status hardware_status;
  enum capnweb_status status;
  (void)call;
  hardware_status = screen_capture->driver.capture_png(
      screen_capture->driver.context, &capture);
  if (hardware_status != ITERATE_KIT_OK) {
    return iterate_kit_reply_status(reply, hardware_status);
  }
  if ((capture.data == NULL && capture.size > 0U) ||
      capture.size == 0U ||
      capture.size > screen_capture->maximum_png_bytes) {
    /*
     * The encoded result must fit one reviewed control reply. Silently
     * truncating PNG bytes would produce an image-shaped success that no tool
     * can decode; growing the transport slot would charge permanent internal
     * RAM to every audio session for an occasional diagnostics operation.
     */
    if (capture.release != NULL) {
      capture.release(capture.release_context);
    }
    return capnweb_reply_set_error(
        reply,
        "RangeError",
        "screen PNG exceeds the configured control-message byte bound");
  }
  status = capnweb_reply_set_bytes(
      reply,
      capture.data,
      capture.size,
      capture.release,
      capture.release_context);
  if (status != CAPNWEB_OK && capture.release != NULL) {
    /* Ownership transfers only when set_bytes succeeds. */
    capture.release(capture.release_context);
  }
  return status;
}

enum iterate_kit_status iterate_kit_screen_capture_init(
    struct iterate_kit_screen_capture *screen_capture,
    const struct iterate_kit_screen_capture_driver *driver,
    size_t maximum_png_bytes) {
  if (screen_capture == NULL ||
      driver == NULL ||
      driver->capture_png == NULL ||
      maximum_png_bytes == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(screen_capture, 0, sizeof(*screen_capture));
  screen_capture->driver = *driver;
  screen_capture->maximum_png_bytes = maximum_png_bytes;
  return ITERATE_KIT_OK;
}

struct iterate_kit_module iterate_kit_screen_capture_module(
    struct iterate_kit_screen_capture *screen_capture) {
  static const struct iterate_kit_method methods[] = {
    {capture_screen_path, 1U, capture_screen},
  };
  const struct iterate_kit_module module = {
    .methods = methods,
    .method_count = sizeof(methods) / sizeof(methods[0]),
    .context = screen_capture,
    .poll = NULL,
    .close = NULL,
    .session_ended = NULL,
  };
  return module;
}
