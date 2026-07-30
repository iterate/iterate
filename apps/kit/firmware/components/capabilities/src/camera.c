#include "iterate/kit/capabilities/camera.h"

#include "rpc_internal.h"

#include <string.h>

/*
 * Camera payloads are much larger than ordinary control replies, so this
 * module is primarily an ownership and resource boundary. The driver produces
 * one already-encoded image; Cap'n Web either accepts its release callback or
 * the module invokes it on every pre-transfer failure. Copying into a generic
 * module buffer was rejected because it would double peak RAM exactly when a
 * camera frame buffer is already resident.
 */
static const char *const take_photo_path[] = {"takePhoto"};

static enum capnweb_status take_photo(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_camera *camera = context;
  struct iterate_kit_photo photo = {0};
  enum iterate_kit_status hardware_status;
  enum capnweb_status status;
  (void)call;
  hardware_status = camera->driver.take_photo(
      camera->driver.context, &photo);
  if (hardware_status != ITERATE_KIT_OK) {
    return iterate_kit_reply_status(reply, hardware_status);
  }
  if ((photo.data == NULL && photo.size > 0U) ||
      photo.size > camera->maximum_photo_bytes) {
    /*
     * Even a buggy driver must not leak its frame buffer when the result is
     * rejected locally. The size cap is checked before reply construction so
     * an oversized photo never enters Cap'n Web's bounded serializer.
     */
    if (photo.release != NULL) {
      photo.release(photo.release_context);
    }
    return capnweb_reply_set_error(
        reply,
        "RangeError",
        "captured image exceeds the configured byte bound");
  }
  status = capnweb_reply_set_bytes(
      reply,
      photo.data,
      photo.size,
      photo.release,
      photo.release_context);
  if (status != CAPNWEB_OK && photo.release != NULL) {
    /*
     * A successful set_bytes transfers this obligation to Cap'n Web. Any
     * failure leaves ownership here, so exactly one layer releases the frame.
     */
    photo.release(photo.release_context);
  }
  return status;
}

enum iterate_kit_status iterate_kit_camera_init(
    struct iterate_kit_camera *camera,
    const struct iterate_kit_camera_driver *driver,
    size_t maximum_photo_bytes) {
  if (camera == NULL ||
      driver == NULL ||
      driver->take_photo == NULL ||
      maximum_photo_bytes == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(camera, 0, sizeof(*camera));
  camera->driver = *driver;
  camera->maximum_photo_bytes = maximum_photo_bytes;
  return ITERATE_KIT_OK;
}

struct iterate_kit_module iterate_kit_camera_module(
    struct iterate_kit_camera *camera) {
  static const struct iterate_kit_method methods[] = {
    {take_photo_path, 1U, take_photo},
  };
  const struct iterate_kit_module module = {
    .methods = methods,
    .method_count = sizeof(methods) / sizeof(methods[0]),
    .context = camera,
    .poll = NULL,
    .close = NULL,
    .session_ended = NULL,
  };
  return module;
}
