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
  /* Latched so a board without a working sensor is asked exactly once. */
  bool start_failed;
  uint8_t *jpeg;
  size_t jpeg_length;
  /* True while the portable capability holds `jpeg`; one frame at a time. */
  bool frame_out;
  bool overflowed;
  uint32_t sensor_failures;
  uint32_t encode_failures;
  uint32_t largest_jpeg_bytes;
  /* Completed photographs, and sensors that would not shut down again. */
  uint32_t photographs;
  uint32_t shutdown_failures;
  /*
   * What the internal heap looked like WHILE the sensor was up. The number
   * that mattered all along and that nothing could see: 6,719 bytes, against
   * 41,163 with the sensor down.
   */
  uint32_t internal_free_with_sensor_up;
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

static bool start_sensor(void);
static void stop_sensor(void);

static enum iterate_kit_status capture(
    void *context, struct iterate_kit_photo *photo) {
  camera_fb_t *frame;
  bool encoded;
  (void)context;
  if (camera.frame_out) {
    /*
     * One JPEG buffer, so one outstanding photograph. Backpressure rather
     * than a second buffer: the caller can retry, whereas permanent memory
     * charged for an occasional picture cannot be given back.
     */
    return ITERATE_KIT_BACKPRESSURE;
  }
  if (!start_sensor()) return ITERATE_KIT_UNAVAILABLE;

  frame = esp_camera_fb_get();
  if (frame == NULL) {
    ++camera.sensor_failures;
    stop_sensor();
    return ITERATE_KIT_IO_ERROR;
  }
  encoded = frame2jpg_cb(frame, (uint8_t)JPEG_QUALITY, append_jpeg, NULL);
  /*
   * RETURN THE SENSOR'S FRAME, then the whole driver. Everything below this
   * line runs on the PSRAM JPEG, so the thirty-four kilobytes of internal DMA
   * memory the driver holds go back to the radio before this call returns.
   */
  esp_camera_fb_return(frame);
  stop_sensor();

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

/*
 * THE SENSOR IS BORROWED FOR THE LENGTH OF ONE PHOTOGRAPH, AND THEN GIVEN
 * BACK. This is the whole memory policy of this file, and it was learned
 * twice at the cost of the board's network.
 *
 * MEASURED: with the sensor down this board has 41,163 bytes of internal heap.
 * `esp_camera_init` takes about thirty-four kilobytes of it for the driver's
 * DMA line buffers and leaves 6,719 — at which point mbedtls cannot allocate
 * an AES context for the next TLS write ("esp-aes: Failed to allocate
 * memory"), the socket dies, and the device spends its life reconnecting.
 * Starting the sensor at BOOT was worse still: Wi-Fi then could not allocate
 * its own packet buffers at all, and the start-up path returned with the task
 * watchdog subscribed, which is a silent twenty-second reboot loop that looks
 * from the outside exactly like a black screen.
 *
 * Making it lazy only moved that failure from boot to the first photograph.
 * The fix is that the camera does not get to KEEP anything: it is initialised,
 * read, encoded, and deinitialised inside one call, at a measured cost of
 * about half a second per photograph. The encoded JPEG lives in PSRAM and
 * outlives the sensor, so the chunk reads that follow need no hardware at all.
 *
 * A diagnostic photograph is never worth a device that cannot hold a call.
 */
static bool start_sensor(void) {
  if (camera.ready) return true;
  if (camera.start_failed) return false;

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
    camera.start_failed = true;
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
      camera.start_failed = true;
      return false;
    }
  }

  camera.ready = true;
  camera.internal_free_with_sensor_up =
      (uint32_t)heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
  ESP_LOGI(
      tag,
      "camera up: GC0308 %dx%d rgb565 -> jpeg q%d, %u KiB PSRAM ceiling, "
      "%u bytes internal heap left while it is",
      CAMERA_WIDTH,
      CAMERA_HEIGHT,
      JPEG_QUALITY,
      (unsigned int)(JPEG_CAPACITY / 1024),
      (unsigned int)camera.internal_free_with_sensor_up);
  return true;
}

/*
 * Give the driver's internal DMA memory back. The PSRAM JPEG deliberately
 * survives: the chunk reads that follow a take() must not need the hardware.
 */
static void stop_sensor(void) {
  if (!camera.ready) return;
  const esp_err_t status = esp_camera_deinit();
  if (status != ESP_OK) {
    /*
     * A sensor that will not shut down is holding the memory the radio needs,
     * and pretending otherwise would make the next TLS write fail somewhere
     * with no camera in the backtrace. Say it here instead.
     */
    ++camera.shutdown_failures;
    ESP_LOGE(
        tag,
        "esp_camera_deinit failed (%s): internal memory stays borrowed",
        esp_err_to_name(status));
    return;
  }
  camera.ready = false;
  ++camera.photographs;
}

uint32_t iterate_kit_stackchan_camera_photographs(void) {
  return camera.photographs;
}

uint32_t iterate_kit_stackchan_camera_shutdown_failures(void) {
  return camera.shutdown_failures;
}

uint32_t iterate_kit_stackchan_camera_internal_free_with_sensor_up(void) {
  return camera.internal_free_with_sensor_up;
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
