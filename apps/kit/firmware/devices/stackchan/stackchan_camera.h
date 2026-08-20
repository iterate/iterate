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
 * THE SENSOR IS BROUGHT UP ON THE FIRST PHOTOGRAPH, NOT AT START-UP. Doing it
 * at start-up took the DMA-capable internal memory Wi-Fi needs for its packet
 * buffers, and the board spent its life rebooting instead of making calls.
 * The capability is therefore always mounted and a board whose sensor cannot
 * start answers `take()` with "unavailable" — a caller can read that, whereas
 * it cannot read a device that is not on the network.
 */
struct iterate_kit_camera_driver iterate_kit_stackchan_camera_driver(void);

/**
 * Photographs completed, and sensors that refused to shut down again.
 *
 * A non-zero shutdown-failure count is the thing to look at when the network
 * starts dying after somebody took a picture: it means the driver is still
 * holding the internal DMA memory TLS needs.
 */
uint32_t iterate_kit_stackchan_camera_photographs(void);
uint32_t iterate_kit_stackchan_camera_shutdown_failures(void);
/** Internal heap free while the sensor was last up. Small on purpose. */
uint32_t iterate_kit_stackchan_camera_internal_free_with_sensor_up(void);

/** Frames the sensor refused, and encodes that did not fit the JPEG buffer. */
uint32_t iterate_kit_stackchan_camera_sensor_failures(void);
uint32_t iterate_kit_stackchan_camera_encode_failures(void);
/** Largest encoded frame seen, so the buffer bound can be argued with a number. */
uint32_t iterate_kit_stackchan_camera_largest_jpeg_bytes(void);

#ifdef __cplusplus
}
#endif

#endif
