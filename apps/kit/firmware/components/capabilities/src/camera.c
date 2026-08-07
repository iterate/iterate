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
/*
 * The second segment is fixed; only the noun in front of it varies, so these
 * are shared and the instance owns just the pair of pointers naming them.
 */
static const char *const take_verb = "take";
static const char *const read_chunk_verb = "readChunk";

/** Hand the frame back to the driver, once, and forget it. */
static void release_frame(struct iterate_kit_camera *camera) {
  if (!camera->has_frame) return;
  if (camera->held.release != NULL) {
    camera->held.release(camera->held.release_context);
  }
  memset(&camera->held, 0, sizeof(camera->held));
  camera->has_frame = false;
}

bool iterate_kit_camera_chunk_index_is_valid(size_t length, int64_t index) {
  if (index < 0 || length == 0U) return false;
  /* Widened on both sides so the comparison itself cannot wrap. */
  return (uint64_t)index <
      ((uint64_t)length + (uint64_t)ITERATE_KIT_CAMERA_CHUNK_BYTES - 1U) /
          (uint64_t)ITERATE_KIT_CAMERA_CHUNK_BYTES;
}

static size_t chunk_count(size_t length) {
  return (length + (size_t)ITERATE_KIT_CAMERA_CHUNK_BYTES - 1U) /
      (size_t)ITERATE_KIT_CAMERA_CHUNK_BYTES;
}

/*
 * An error that names the method the caller should have called, which is not
 * always "camera": the same module answers under "screen" on a board that can
 * be asked what its display is showing.
 */
static enum capnweb_status reply_naming_the_noun(
    struct capnweb_reply *reply,
    const struct iterate_kit_camera *camera,
    const char *error_name,
    const char *format) {
  static char message[96];
  const int written =
      snprintf(message, sizeof(message), format, camera->paths[0][0]);
  if (written < 0 || (size_t)written >= sizeof(message)) {
    return capnweb_reply_set_error(reply, error_name, format);
  }
  return capnweb_reply_set_error(reply, error_name, message);
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
        reply, "Error", "the capture succeeded but the frame was empty");
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
        reply, "RangeError", "frame metadata did not fit");
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
    return reply_naming_the_noun(
        reply, camera, "Error", "no frame is held — call %s.take() first");
  }
  if (!iterate_kit_read_object_argument(call, &object) ||
      !iterate_kit_read_int_field(&object, "index", &index) ||
      index < 0) {
    return reply_naming_the_noun(
        reply, camera, "TypeError", "%s.readChunk needs {index}");
  }
  /*
   * BOUND BEFORE MULTIPLYING — see the predicate's own comment for the wrap it
   * exists to prevent. Same order the servo capability validates degrees in,
   * and for the same reason.
   */
  if (!iterate_kit_camera_chunk_index_is_valid(camera->held.length, index)) {
    ++camera->stale_chunk_requests;
    return capnweb_reply_set_error(
        reply, "RangeError", "chunk index is past the end of the frame");
  }
  offset = (size_t)index * (size_t)ITERATE_KIT_CAMERA_CHUNK_BYTES;
  remaining = camera->held.length - offset;
  length = remaining < (size_t)ITERATE_KIT_CAMERA_CHUNK_BYTES
      ? remaining
      : (size_t)ITERATE_KIT_CAMERA_CHUNK_BYTES;
  ++camera->chunks_read;
  {
    /*
     * Borrowed with no release callback — see the note after this block for why
     * nothing is released on the way out, including on the final chunk.
     */
    const enum capnweb_status status = capnweb_reply_set_bytes(
        reply, camera->held.bytes + offset, length, NULL, NULL);
    if (status != CAPNWEB_OK) {
      return status;
    }
  }
  /*
   * THE FRAME IS NOT RELEASED HERE, and the last chunk is no exception.
   *
   * The bytes above are BORROWED by the reply with no release callback, so they
   * must stay valid until the reply has been serialised — which has not
   * happened yet when this dispatch returns. Releasing on the final chunk gave
   * the driver its buffer back while the reply still pointed into it: harmless
   * on a driver whose release only clears a flag, and a use-after-free on one
   * that recycles the sensor buffer, which is exactly what this module's own
   * header invites drivers to do.
   *
   * So the loan ends at the next take(), or when the session ends. Both are
   * points where nothing is mid-serialisation.
   */
  return CAPNWEB_OK;
}

/* A session that has gone away cannot read the rest of its frame. */
static void session_ended(void *context) {
  release_frame((struct iterate_kit_camera *)context);
}

enum iterate_kit_status iterate_kit_camera_init(
    struct iterate_kit_camera *camera,
    const struct iterate_kit_camera_driver *driver,
    const char *noun) {
  if (camera == NULL || driver == NULL || driver->capture == NULL ||
      noun == NULL || noun[0] == '\0') {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(camera, 0, sizeof(*camera));
  camera->driver = *driver;
  camera->paths[0][0] = noun;
  camera->paths[0][1] = take_verb;
  camera->paths[1][0] = noun;
  camera->paths[1][1] = read_chunk_verb;
  camera->methods[0] =
      (struct iterate_kit_method){camera->paths[0], 2U, take};
  camera->methods[1] =
      (struct iterate_kit_method){camera->paths[1], 2U, read_chunk};
  return ITERATE_KIT_OK;
}

struct iterate_kit_module iterate_kit_camera_module(
    struct iterate_kit_camera *camera) {
  const struct iterate_kit_module module = {
    .methods = camera->methods,
    .method_count = sizeof(camera->methods) / sizeof(camera->methods[0]),
    .context = camera,
    .poll = NULL,
    .close = NULL,
    .session_ended = session_ended,
  };
  return module;
}
