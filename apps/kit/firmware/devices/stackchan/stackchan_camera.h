#ifndef ITERATE_KIT_STACKCHAN_CAMERA_H
#define ITERATE_KIT_STACKCHAN_CAMERA_H

#include "iterate/kit/capabilities/camera.h"

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * The CoreS3's GC0308 camera, as one photograph at a time.
 *
 * ALL of the sensor knowledge lives behind this header — pin map, power rail,
 * pixel format, JPEG encoding, buffer placement — exactly as the servo geometry
 * lives behind stackchan_body.h. The portable capability above it knows only
 * "capture returns bytes and a way to give them back".
 *
 * Returns false if the camera cannot be brought up, and that is not fatal: the
 * device then does not mount the capability at all, so a caller is told the
 * method does not exist rather than being handed a permanent runtime error
 * from a camera that was never there.
 */
bool iterate_kit_stackchan_camera_init(void);

/** The driver to hand iterate_kit_camera_init; valid only after a true init. */
struct iterate_kit_camera_driver iterate_kit_stackchan_camera_driver(void);

/** Frames the sensor refused, and encodes that did not fit the JPEG buffer. */
uint32_t iterate_kit_stackchan_camera_sensor_failures(void);
uint32_t iterate_kit_stackchan_camera_encode_failures(void);
/** Largest encoded frame seen, so the buffer bound can be argued with a number. */
uint32_t iterate_kit_stackchan_camera_largest_jpeg_bytes(void);

#ifdef __cplusplus
}
#endif

#endif
