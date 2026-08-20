#ifndef ITERATE_KIT_CAPABILITIES_CAMERA_H
#define ITERATE_KIT_CAPABILITIES_CAMERA_H

#include "iterate/kit/peer.h"
#include "iterate/kit/status.h"
/* For the outbox slot size a chunk has to fit inside; see the assert below. */
#include "iterate/kit/voice_device_profile.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * How much of one image each read returns.
 *
 * A CHUNK THAT DOES NOT FIT ITS CONTROL MESSAGE KILLS THE SESSION. Overflowing
 * one outbox slot is terminal in this peer by design — the slot is reserved
 * before Cap'n Web starts writing, and a message that runs past it cannot be
 * un-written — so the very first readChunk() of the very first photograph took
 * the whole WebSocket down with a 1006 and left a healthy board unreachable.
 *
 * The previous value was 6000, above a comment asserting it "still fits inside
 * one bounded control message with room for the surrounding JSON". It did not:
 * 6000 raw bytes are 8000 base64 characters against an 8192-byte slot, leaving
 * 192 for the envelope. The sentence was reasoning, not arithmetic, and the
 * arithmetic is now below where the compiler checks it.
 *
 * Round trips still matter — at 2400 bytes an image cost 35 of them and
 * dominated the time of anything that fetched one — so this is as large as the
 * budget honestly allows rather than as small as it could be.
 */
enum {
  ITERATE_KIT_CAMERA_CHUNK_BYTES = 4096,
  /** Envelope around the base64: ids, quoting, the resolve wrapper. */
  ITERATE_KIT_CAMERA_CHUNK_ENVELOPE_BYTES = 512,
  ITERATE_KIT_CAMERA_CHUNK_ENCODED_BYTES =
      ((ITERATE_KIT_CAMERA_CHUNK_BYTES + 2) / 3) * 4,
};

_Static_assert(
    ITERATE_KIT_CAMERA_CHUNK_ENCODED_BYTES +
            ITERATE_KIT_CAMERA_CHUNK_ENVELOPE_BYTES <=
        ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOT_CAPACITY,
    "a camera chunk must fit one control message: overflowing the outbox is "
    "session-fatal, so this cannot be left to a comment");

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
 * The held frame is released by the NEXT capture, or when the session ends —
 * never inside readChunk, not even on the last one. The bytes a read returns
 * are borrowed by the reply and must outlive the dispatch that produced it, so
 * handing a sensor its buffer back on the final chunk would invalidate memory
 * the reply still points at. A frame is never held across a session boundary,
 * because the only thing that could still read it is a caller who is gone.
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
  /*
   * THE MOUNT, per instance, because a board has more than one image to pull.
   *
   * StackChan has a sensor AND a screen, and reading the screen back is the
   * only way to answer "the display is black" from off the desk — the display
   * counters can say 5,625 transfers succeeded and still not say what was in
   * them. Both are the same protocol (hold one frame, drain it in chunks), so
   * the noun is data rather than a second copy of this module.
   *
   * The paths and the method table live in the instance because they name it:
   * `iterate_kit_module.methods` is borrowed for the peer's lifetime, so a
   * `static` table here would be shared by every camera on the board and the
   * second one to mount would rename the first.
   */
  const char *paths[2][2];
  struct iterate_kit_method methods[2];
};

/**
 * Whether `index` names a real chunk of a frame `length` bytes long.
 *
 * Exposed because the arithmetic behind it is where the bug was: `size_t` is 32
 * bits on these targets, so `index * chunk_size` computed BEFORE a bound check
 * wraps to a small offset that then passes a naive `offset >= length` test and
 * serves the wrong slice of the frame. Comparing against the chunk count keeps
 * every multiplication inside the range it was checked in. A host test can
 * falsify this directly; the dispatch path around it cannot be driven without a
 * live session.
 */
bool iterate_kit_camera_chunk_index_is_valid(size_t length, int64_t index);

/**
 * Wire one image source to the noun it answers under.
 *
 * `noun` is borrowed and must outlive the peer — a string literal, in every
 * real caller. It becomes `<noun>.take()` and `<noun>.readChunk({index})`:
 * "camera" for a sensor, "screen" for a display read back.
 */
enum iterate_kit_status iterate_kit_camera_init(
    struct iterate_kit_camera *camera,
    const struct iterate_kit_camera_driver *driver,
    const char *noun);
struct iterate_kit_module iterate_kit_camera_module(
    struct iterate_kit_camera *camera);

#ifdef __cplusplus
}
#endif

#endif
