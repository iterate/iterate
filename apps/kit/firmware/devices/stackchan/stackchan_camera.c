#include "stackchan_camera.h"

/* For BSP_CAMERA_DEFAULT_CONFIG: the pin map and buffer placement are the
 * board's facts, and this is the file that owns them. */
#include "bsp/m5stack_core_s3.h"
#include "esp_camera.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "img_converters.h"

#include <string.h>

/*
 * The GC0308 on the CoreS3, and nothing else. Everything the sensor needs that
 * the rest of the firmware must not know is here: that it borrows the BSP's I2C
 * bus for its control channel, that its power comes from a rail the PMIC gates,
 * that its frames land in PSRAM, and that the wire wants JPEG while the sensor
 * only speaks RGB565.
 */

static const char *const tag = "stackchan-camera";

enum {
  /*
   * QVGA matches the display, which is also what the BSP configures — there is
   * no reason for the camera to out-resolve the thing that shows it.
   */
  CAMERA_WIDTH = 320,
  CAMERA_HEIGHT = 240,
  /*
   * JPEG quality, in esp32-camera's scale where LOWER is better. 12 is the
   * BSP's own default and keeps a detailed QVGA frame comfortably inside the
   * buffer below; there is no point tuning this without a measurement of what
   * the far end actually does with the image.
   */
  JPEG_QUALITY = 12,
  /*
   * The encoded-frame ceiling, and it is a ceiling rather than an allocation
   * per capture: a QVGA JPEG of ordinary indoor detail is a few kilobytes, and
   * 64 KiB is roughly four times the worst case measured on this sensor class.
   * It lives in PSRAM because this board has already run out of INTERNAL heap
   * once — Wi-Fi could not allocate its receive buffers — and a diagnostic
   * photograph must never be the thing that costs a conversation its memory.
   */
  JPEG_CAPACITY = 64 * 1024,
};

static struct {
  bool ready;
  uint8_t *jpeg;
  size_t jpeg_length;
  /* True while the portable capability holds `jpeg`; one frame at a time. */
  bool frame_out;
  bool overflowed;
  uint32_t sensor_failures;
  uint32_t encode_failures;
  uint32_t largest_jpeg_bytes;
} camera;

/*
 * esp32-camera hands the encoder's output over in pieces. Appending into our
 * own bounded PSRAM buffer keeps the peak at one frame plus one JPEG, instead
 * of letting the encoder malloc a second copy out of whatever heap it likes.
 */
static size_t append_jpeg(
    void *argument, size_t index, const void *data, size_t length) {
  (void)argument;
  if (index == 0U) {
    camera.jpeg_length = 0U;
    camera.overflowed = false;
  }
  if (data == NULL) {
    /* End-of-stream marker from the encoder; nothing to copy. */
    return 0U;
  }
  if (camera.overflowed || index + length > (size_t)JPEG_CAPACITY) {
    /*
     * Latch rather than truncate. A JPEG cut short is not a smaller picture,
     * it is a corrupt file, and the caller would blame the sensor.
     */
    camera.overflowed = true;
    return 0U;
  }
  memcpy(camera.jpeg + index, data, length);
  if (index + length > camera.jpeg_length) {
    camera.jpeg_length = index + length;
  }
  return length;
}

/* The capability's release hook: the sensor's frame went back long ago (see
 * capture), so this only reopens our single JPEG slot. */
static void release_photo(void *context) {
  (void)context;
  camera.frame_out = false;
}

static enum iterate_kit_status capture(
    void *context, struct iterate_kit_photo *photo) {
  camera_fb_t *frame;
  bool encoded;
  (void)context;
  if (!camera.ready) return ITERATE_KIT_UNAVAILABLE;
  if (camera.frame_out) {
    /*
     * One JPEG buffer, so one outstanding photograph. Backpressure rather
     * than a second buffer: the caller can retry, whereas permanent memory
     * charged for an occasional picture cannot be given back.
     */
    return ITERATE_KIT_BACKPRESSURE;
  }

  frame = esp_camera_fb_get();
  if (frame == NULL) {
    ++camera.sensor_failures;
    return ITERATE_KIT_IO_ERROR;
  }
  encoded = frame2jpg_cb(frame, (uint8_t)JPEG_QUALITY, append_jpeg, NULL);
  /*
   * RETURN THE SENSOR'S FRAME IMMEDIATELY. It is one of only two, and holding
   * it across the whole read-out would stall the camera for as long as the
   * caller took to fetch its chunks. The JPEG is ours and outlives it.
   */
  esp_camera_fb_return(frame);

  if (!encoded || camera.overflowed || camera.jpeg_length == 0U) {
    ++camera.encode_failures;
    return camera.overflowed ? ITERATE_KIT_LIMIT : ITERATE_KIT_IO_ERROR;
  }
  if (camera.jpeg_length > (size_t)camera.largest_jpeg_bytes) {
    camera.largest_jpeg_bytes = (uint32_t)camera.jpeg_length;
  }

  camera.frame_out = true;
  photo->bytes = camera.jpeg;
  photo->length = camera.jpeg_length;
  photo->width = (uint16_t)CAMERA_WIDTH;
  photo->height = (uint16_t)CAMERA_HEIGHT;
  photo->content_type = "image/jpeg";
  photo->release_context = NULL;
  photo->release = release_photo;
  return ITERATE_KIT_OK;
}

bool iterate_kit_stackchan_camera_init(void) {
  if (camera.ready) return true;

  /*
   * ORDERING, NOT CONFIGURATION: this must run after the display is up, and
   * that is the whole of the camera's power management.
   *
   * The CoreS3 gates the sensor rail through the AW9523 expander, and the BSP
   * raises it inside bsp_display_new() — camera and LCD are enabled together
   * there (see the vendored m5stack_core_s3.c, BSP_FEATURE_CAMERA beside
   * BSP_FEATURE_LCD). The same call brings up the I2C bus the sensor's SCCB
   * control channel borrows (its sccb pins are NC and its port is the BSP's).
   * So there is deliberately no rail or bus work here: doing it again would
   * mean writing the expander's P1 latch, and this firmware does not hold that
   * register's shadow — a blind write would turn the DISPLAY off, since its
   * enable is the neighbouring bit.
   */
  camera.jpeg = heap_caps_malloc((size_t)JPEG_CAPACITY, MALLOC_CAP_SPIRAM);
  if (camera.jpeg == NULL) {
    ESP_LOGW(tag, "no PSRAM for a JPEG buffer; no camera capability");
    return false;
  }

  {
    /*
     * RGB565 and not PIXFORMAT_JPEG: the GC0308 has no JPEG engine, so asking
     * the driver for JPEG only moves the same software encode somewhere less
     * visible. Encoding explicitly keeps the cost where the comment is.
     */
    const camera_config_t config = BSP_CAMERA_DEFAULT_CONFIG;
    const esp_err_t status = esp_camera_init(&config);
    if (status != ESP_OK) {
      ESP_LOGW(
          tag,
          "esp_camera_init failed (%s); no camera capability",
          esp_err_to_name(status));
      heap_caps_free(camera.jpeg);
      camera.jpeg = NULL;
      return false;
    }
  }

  camera.ready = true;
  ESP_LOGI(
      tag,
      "camera ready: GC0308 %dx%d rgb565 -> jpeg q%d, %u KiB PSRAM ceiling",
      CAMERA_WIDTH,
      CAMERA_HEIGHT,
      JPEG_QUALITY,
      (unsigned int)(JPEG_CAPACITY / 1024));
  return true;
}

struct iterate_kit_camera_driver iterate_kit_stackchan_camera_driver(void) {
  const struct iterate_kit_camera_driver driver = {
    .context = NULL,
    .capture = capture,
  };
  return driver;
}

uint32_t iterate_kit_stackchan_camera_sensor_failures(void) {
  return camera.sensor_failures;
}

uint32_t iterate_kit_stackchan_camera_encode_failures(void) {
  return camera.encode_failures;
}

uint32_t iterate_kit_stackchan_camera_largest_jpeg_bytes(void) {
  return camera.largest_jpeg_bytes;
}
