#ifndef ITERATE_KIT_STACKCHAN_IMAGE_H
#define ITERATE_KIT_STACKCHAN_IMAGE_H

#include "iterate/kit/status.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * A picture from the web, worn on the CoreS3's face for a while.
 *
 * Everything network- and JPEG-shaped lives behind this header, exactly as
 * the sensor lives behind stackchan_camera.h: the HTTPS fetch, the bounded
 * PSRAM download, the esp_jpeg decode, and the cover-crop down to the
 * avatar's 160x120 staging surface. The avatar knows only "a staged image
 * owns the glass until a deadline".
 *
 * NOTHING HERE RUNS ON THE APP TASK. Accepting a request spawns a one-shot
 * FreeRTOS task (low priority, core 1, deleted on completion) that fetches,
 * decodes, stages, and publishes the show deadline. One request at a time:
 * a fetch in flight or an image still on the glass answers backpressure,
 * which is also what keeps the staging surface single-writer.
 */

/**
 * Accept (or refuse) one fetch-and-show request. Synchronous and quick.
 *
 * `url` must be http(s) and shorter than 512 bytes; `seconds` is how long
 * the image owns the glass once decoded, clamped here to 1..300.
 * OK means the fetch task is RUNNING — not that the picture will appear;
 * asynchronous failures land in the imageFetchFailures health counter and
 * the console log. BACKPRESSURE: a fetch is in flight or an image is still
 * showing. INVALID_ARGUMENT: the url's shape. LIMIT: no memory for the
 * staging surface or the task.
 */
enum iterate_kit_status iterate_kit_stackchan_image_show(
    const char *url, size_t url_length, uint32_t seconds);

/** Fetches accepted, and the ones that failed somewhere past acceptance. */
uint32_t iterate_kit_stackchan_image_fetches(void);
uint32_t iterate_kit_stackchan_image_fetch_failures(void);

#ifdef __cplusplus
}
#endif

#endif
