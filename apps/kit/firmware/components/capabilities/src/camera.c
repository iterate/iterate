#include "iterate/kit/capabilities/camera.h"

#include "rpc_internal.h"

#include <stdio.h>
#include <string.h>

/*
 * The whole module is one rule: a frame is held between `take` and the reads
 * that drain it, and it is given back exactly once. Everything else here is
 * bookkeeping in service of that, because the failure this shape prevents is
 * a sensor with no buffer left to capture into and no way to say why.
 */
static const char *const take_path[] = {"camera", "take"};
static const char *const read_chunk_path[] = {"camera", "readChunk"};

/** Hand the frame back to the driver, once, and forget it. */
static void release_frame(struct iterate_kit_camera *camera) {
  if (!camera->has_frame) return;
  if (camera->held.release != NULL) {
    camera->held.release(camera->held.release_context);
  }
  memset(&camera->held, 0, sizeof(camera->held));
  camera->has_frame = false;
}

static size_t chunk_count(size_t length) {
  return (length + (size_t)ITERATE_KIT_CAMERA_CHUNK_BYTES - 1U) /
      (size_t)ITERATE_KIT_CAMERA_CHUNK_BYTES;
}

static enum capnweb_status take(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_camera *camera = context;
  struct iterate_kit_photo photo = {0};
  enum iterate_kit_status status;
  /*
   * The metadata is small and fixed-width; a static buffer is honest here
   * because only one dispatch runs at a time on this peer.
   */
  static char meta[192];
  int written;
  (void)call;

  /*
   * A NEW PHOTOGRAPH REPLACES THE OLD ONE. The alternative — refusing while a
   * frame is outstanding — would leave a caller who abandoned a read halfway
   * unable to ever take another picture, and nothing on the wire tells us that
   * caller is coming back.
   */
  release_frame(camera);

  status = camera->driver.capture(camera->driver.context, &photo);
  if (status != ITERATE_KIT_OK) {
    ++camera->capture_failures;
    return iterate_kit_reply_status(reply, status);
  }
  if (photo.bytes == NULL || photo.length == 0U) {
    /*
     * A capture that "succeeded" with nothing in it still owns a buffer. Give
     * it back before complaining, or a sensor that returns empty frames
     * consumes its own frame buffer permanently on the first try.
     */
    ++camera->capture_failures;
    camera->held = photo;
    camera->has_frame = true;
    release_frame(camera);
    return capnweb_reply_set_error(
        reply, "Error", "camera captured an empty frame");
  }

  camera->held = photo;
  camera->has_frame = true;
  ++camera->captures;

  written = snprintf(
      meta,
      sizeof(meta),
      "{\"width\":%u,\"height\":%u,\"contentType\":\"%s\",\"bytes\":%u,"
      "\"chunkSize\":%u,\"chunks\":%u}",
      (unsigned int)photo.width,
      (unsigned int)photo.height,
      photo.content_type != NULL ? photo.content_type : "application/octet-stream",
      (unsigned int)photo.length,
      (unsigned int)ITERATE_KIT_CAMERA_CHUNK_BYTES,
      (unsigned int)chunk_count(photo.length));
  if (written < 0 || (size_t)written >= sizeof(meta)) {
    release_frame(camera);
    return capnweb_reply_set_error(
        reply, "RangeError", "camera metadata did not fit");
  }
  return capnweb_reply_set_borrowed_expression(
      reply, meta, (size_t)written, NULL, NULL);
}

static enum capnweb_status read_chunk(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_camera *camera = context;
  struct capnweb_value object = {0};
  int64_t index = 0;
  size_t offset;
  size_t remaining;
  size_t length;
  if (!camera->has_frame) {
    ++camera->stale_chunk_requests;
    /*
     * Named plainly, because the caller's mistake is recoverable and the
     * remedy is one call away. "No frame" and "index out of range" are
     * different mistakes and must not share a message.
     */
    return capnweb_reply_set_error(
        reply, "Error", "no frame is held — call camera.take() first");
  }
  if (!iterate_kit_read_object_argument(call, &object) ||
      !iterate_kit_read_int_field(&object, "index", &index) ||
      index < 0) {
    return capnweb_reply_set_error(
        reply, "TypeError", "camera.readChunk needs {index}");
  }
  offset = (size_t)index * (size_t)ITERATE_KIT_CAMERA_CHUNK_BYTES;
  if (offset >= camera->held.length) {
    ++camera->stale_chunk_requests;
    return capnweb_reply_set_error(
        reply, "RangeError", "chunk index is past the end of the frame");
  }
  remaining = camera->held.length - offset;
  length = remaining < (size_t)ITERATE_KIT_CAMERA_CHUNK_BYTES
      ? remaining
      : (size_t)ITERATE_KIT_CAMERA_CHUNK_BYTES;
  ++camera->chunks_read;
  {
    /*
     * Borrowed with no release callback: the frame stays held until the caller
     * finishes, takes another, or the session ends. Passing the driver's
     * release here instead would free the buffer after the FIRST chunk and
     * every later read would serve freed memory.
     */
    const enum capnweb_status status = capnweb_reply_set_bytes(
        reply, camera->held.bytes + offset, length, NULL, NULL);
    if (status != CAPNWEB_OK) {
      return status;
    }
  }
  /*
   * The last chunk ends the loan. Waiting for a session to end instead would
   * keep the sensor's only buffer occupied for as long as the conversation
   * lasts, so the next photograph would fail for a reason nothing explains.
   */
  if (offset + length >= camera->held.length) {
    release_frame(camera);
  }
  return CAPNWEB_OK;
}

/* A session that has gone away cannot read the rest of its frame. */
static void session_ended(void *context) {
  release_frame((struct iterate_kit_camera *)context);
}

enum iterate_kit_status iterate_kit_camera_init(
    struct iterate_kit_camera *camera,
    const struct iterate_kit_camera_driver *driver) {
  if (camera == NULL || driver == NULL || driver->capture == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(camera, 0, sizeof(*camera));
  camera->driver = *driver;
  return ITERATE_KIT_OK;
}

struct iterate_kit_module iterate_kit_camera_module(
    struct iterate_kit_camera *camera) {
  static const struct iterate_kit_method methods[] = {
    {take_path, 2U, take},
    {read_chunk_path, 2U, read_chunk},
  };
  const struct iterate_kit_module module = {
    .methods = methods,
    .method_count = sizeof(methods) / sizeof(methods[0]),
    .context = camera,
    .poll = NULL,
    .close = NULL,
    .session_ended = session_ended,
  };
  return module;
}
