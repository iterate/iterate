#ifndef ITERATE_KIT_CAPABILITIES_CAMERA_H
#define ITERATE_KIT_CAPABILITIES_CAMERA_H

#include "iterate/kit/peer.h"
#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * How much of one image each read returns.
 *
 * 6000 raw bytes become 8000 base64 characters, which still fits inside one
 * bounded control message with room for the surrounding JSON. The number is
 * MEASURED, not chosen for tidiness: at 2400 bytes an image cost 35 round
 * trips and dominated the time of anything that fetched one; at 6000 it costs
 * a quarter of that. Raising it further would charge every audio session a
 * larger permanent control slot for an occasional photograph.
 */
enum {
  ITERATE_KIT_CAMERA_CHUNK_BYTES = 6000,
};

/**
 * The frame a driver hands over, and how to give it back.
 *
 * A camera driver is expected to BORROW its hardware frame buffer rather than
 * copy out of it — copying would double peak memory at exactly the moment a
 * frame is already resident. `release` therefore matters: it returns the
 * buffer to the sensor driver, and until it is called the camera may have no
 * frame to capture into.
 */
struct iterate_kit_photo {
  const uint8_t *bytes;
  size_t length;
  uint16_t width;
  uint16_t height;
  /** MIME type of `bytes`, e.g. "image/jpeg". Borrowed, must outlive release. */
  const char *content_type;
  void *release_context;
  void (*release)(void *release_context);
};

/**
 * Synchronous hardware boundary for one camera.
 *
 * `capture` must not return until the bytes are stable, and must not queue:
 * this generic layer neither allocates nor creates an implicit work queue, so
 * a slow sensor belongs on a task the board chose deliberately. Returning
 * ITERATE_KIT_BACKPRESSURE is the right answer when a previous frame is still
 * outstanding — better a caller that retries than a device that quietly holds
 * two frame buffers.
 */
struct iterate_kit_camera_driver {
  void *context;
  enum iterate_kit_status (*capture)(
      void *context, struct iterate_kit_photo *photo);
};

/**
 * A camera exposed as `camera.take()` then `camera.readChunk(index)`.
 *
 * PULLED, NOT PUSHED, and in pieces, for the same reason a screenshot is: one
 * capture is held while the caller reads it out in messages that each fit the
 * transport. Handing back a whole JPEG in one reply is the obvious design and
 * it cannot work — a frame is tens of kilobytes and one control message is a
 * few, so the reply would be rejected after the photograph had been taken.
 *
 * The held frame is released when the last chunk is read, when a new capture
 * replaces it, or when the session ends — whichever comes first. A frame is
 * never held across a session boundary, because the only thing that would
 * reach it is a caller who no longer exists.
 */
struct iterate_kit_camera {
  struct iterate_kit_camera_driver driver;
  struct iterate_kit_photo held;
  bool has_frame;
  /** Lifetime counters; a camera that never captures should say why. */
  uint32_t captures;
  uint32_t capture_failures;
  uint32_t chunks_read;
  uint32_t stale_chunk_requests;
};

enum iterate_kit_status iterate_kit_camera_init(
    struct iterate_kit_camera *camera,
    const struct iterate_kit_camera_driver *driver);
struct iterate_kit_module iterate_kit_camera_module(
    struct iterate_kit_camera *camera);

#ifdef __cplusplus
}
#endif

#endif
