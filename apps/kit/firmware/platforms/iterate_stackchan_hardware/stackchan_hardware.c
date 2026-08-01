#include "iterate/kit/platforms/stackchan_hardware.h"

#include <string.h>

enum {
  STACKCHAN_MINIMUM_YAW_DEGREES = -128,
  STACKCHAN_MAXIMUM_YAW_DEGREES = 128,
  STACKCHAN_MINIMUM_PITCH_DEGREES = 0,
  STACKCHAN_MAXIMUM_PITCH_DEGREES = 90,
  STACKCHAN_MAXIMUM_MOVE_DURATION_MS = 1000,
};

static bool ready(const struct iterate_kit_stackchan_hardware *hardware) {
  return hardware != NULL && hardware->initialized;
}

static enum iterate_kit_status render_png(
    void *context, const char *url, size_t url_length) {
  static const char secure_scheme[] = "https://";
  struct iterate_kit_stackchan_hardware *hardware = context;
  if (!ready(hardware)) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (url == NULL ||
      url_length < sizeof(secure_scheme) - 1U ||
      memcmp(url, secure_scheme, sizeof(secure_scheme) - 1U) != 0) {
    /*
     * Images ultimately come from a project capability. Allowing cleartext
     * here would make device-rendered content substitutable on local Wi-Fi.
     * This check is kept below the generic module as platform transport policy
     * and, importantly, runs before any downloader gets the borrowed string.
     */
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (hardware->ops.render_png == NULL) {
    /*
     * We deliberately do not bolt an allocating HTTP/PNG stack into this
     * adapter. Targets must inject a decoder with an explicit byte/pixel bound;
     * until then callers get an honest error rather than a fake render.
     */
    return ITERATE_KIT_UNAVAILABLE;
  }
  return hardware->ops.render_png(
      hardware->ops.context, url, url_length);
}

static enum iterate_kit_status change_colour(
    void *context, enum iterate_kit_screen_colour colour) {
  struct iterate_kit_stackchan_hardware *hardware = context;
  uint32_t rgb888;
  if (!ready(hardware)) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (hardware->ops.fill_display == NULL) {
    return ITERATE_KIT_UNAVAILABLE;
  }
  switch (colour) {
    case ITERATE_KIT_SCREEN_RED:
      rgb888 = 0xff0000U;
      break;
    case ITERATE_KIT_SCREEN_GREEN:
      rgb888 = 0x00ff00U;
      break;
    default:
      return ITERATE_KIT_INVALID_ARGUMENT;
  }
  /*
   * RGB888 is the neutral handoff used by LVGL's lv_color_hex(). Passing a
   * panel-endian RGB565 value would couple this reusable policy to a display
   * driver's byte swapping and is easy to get subtly wrong on host tests.
   */
  return hardware->ops.fill_display(hardware->ops.context, rgb888);
}

static uint16_t rgb565(uint8_t red, uint8_t green, uint8_t blue) {
  return (uint16_t)(
      ((uint16_t)(red & 0xf8U) << 8U) |
      ((uint16_t)(green & 0xfcU) << 3U) |
      ((uint16_t)blue >> 3U));
}

static enum iterate_kit_status commit_leds(
    struct iterate_kit_stackchan_hardware *hardware,
    const uint16_t *candidate) {
  enum iterate_kit_status status;
  if (hardware->ops.write_leds == NULL) {
    return ITERATE_KIT_UNAVAILABLE;
  }
  status = hardware->ops.write_leds(
      hardware->ops.context,
      candidate,
      ITERATE_KIT_STACKCHAN_LED_COUNT);
  if (status == ITERATE_KIT_OK) {
    /*
     * Commit after I/O, not before. Otherwise a failed bus transaction would
     * make a later set(index) preserve colours the body never displayed.
     */
    memcpy(
        hardware->confirmed_leds,
        candidate,
        sizeof(hardware->confirmed_leds));
  }
  return status;
}

static enum iterate_kit_status set_led(
    void *context,
    uint8_t index,
    uint8_t red,
    uint8_t green,
    uint8_t blue) {
  struct iterate_kit_stackchan_hardware *hardware = context;
  uint16_t candidate[ITERATE_KIT_STACKCHAN_LED_COUNT];
  if (!ready(hardware)) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (index >= ITERATE_KIT_STACKCHAN_LED_COUNT) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memcpy(candidate, hardware->confirmed_leds, sizeof(candidate));
  candidate[index] = rgb565(red, green, blue);
  return commit_leds(hardware, candidate);
}

static enum iterate_kit_status fill_leds(
    void *context, uint8_t red, uint8_t green, uint8_t blue) {
  struct iterate_kit_stackchan_hardware *hardware = context;
  uint16_t candidate[ITERATE_KIT_STACKCHAN_LED_COUNT];
  uint16_t colour;
  if (!ready(hardware)) {
    return ITERATE_KIT_STATE_ERROR;
  }
  colour = rgb565(red, green, blue);
  for (size_t index = 0U;
       index < ITERATE_KIT_STACKCHAN_LED_COUNT;
       ++index) {
    candidate[index] = colour;
  }
  return commit_leds(hardware, candidate);
}

static enum iterate_kit_status move_servos(
    void *context,
    int32_t yaw_degrees,
    int32_t pitch_degrees,
    uint16_t speed) {
  struct iterate_kit_stackchan_hardware *hardware = context;
  int32_t absolute_yaw;
  if (!ready(hardware)) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (yaw_degrees < STACKCHAN_MINIMUM_YAW_DEGREES ||
      yaw_degrees > STACKCHAN_MAXIMUM_YAW_DEGREES ||
      pitch_degrees < STACKCHAN_MINIMUM_PITCH_DEGREES ||
      pitch_degrees > STACKCHAN_MAXIMUM_PITCH_DEGREES ||
      speed > STACKCHAN_MAXIMUM_MOVE_DURATION_MS) {
    /*
     * The generic module already enforces these limits for RPC calls, but the
     * lightweight driver is also a public C boundary. Rechecking prevents a
     * future local gesture producer from bypassing the mechanical envelope.
     */
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (hardware->ops.move_head == NULL) {
    return ITERATE_KIT_UNAVAILABLE;
  }
  absolute_yaw =
      ITERATE_KIT_STACKCHAN_YAW_CENTRE_DEGREES + yaw_degrees;
  return hardware->ops.move_head(
      hardware->ops.context,
      (int16_t)absolute_yaw,
      (int16_t)pitch_degrees,
      speed);
}

static void release_photo(void *context) {
  struct iterate_kit_stackchan_hardware *hardware = context;
  void *handle;
  if (!ready(hardware) || !hardware->photo_outstanding) {
    return;
  }
  handle = hardware->outstanding_photo_handle;
  /*
   * Clear admission before returning the hardware frame. This keeps a backend
   * release hook free to wake its owner without observing a phantom borrower,
   * and means no subsequent capture can inherit the old descriptor.
   */
  hardware->photo_outstanding = false;
  hardware->outstanding_photo_handle = NULL;
  hardware->ops.release_jpeg(hardware->ops.context, handle);
}

static enum iterate_kit_status take_photo(
    void *context, struct iterate_kit_photo *photo) {
  struct iterate_kit_stackchan_hardware *hardware = context;
  struct iterate_kit_stackchan_photo_frame frame = {0};
  enum iterate_kit_status status;
  if (!ready(hardware)) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (photo == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(photo, 0, sizeof(*photo));
  if (hardware->ops.capture_jpeg == NULL ||
      hardware->ops.release_jpeg == NULL) {
    return ITERATE_KIT_UNAVAILABLE;
  }
  if (hardware->photo_outstanding) {
    return ITERATE_KIT_BACKPRESSURE;
  }
  status = hardware->ops.capture_jpeg(hardware->ops.context, &frame);
  if (status != ITERATE_KIT_OK) {
    return status;
  }
  if (frame.data == NULL || frame.size == 0U) {
    /*
     * A successful capture transferred one backend handle even if it produced
     * malformed bytes. Return it here so a broken sensor cannot permanently
     * consume the only frame buffer, then surface a real I/O failure.
     */
    hardware->ops.release_jpeg(hardware->ops.context, frame.handle);
    return ITERATE_KIT_IO_ERROR;
  }
  hardware->outstanding_photo_handle = frame.handle;
  hardware->photo_outstanding = true;
  *photo = (struct iterate_kit_photo){
    frame.data,
    frame.size,
    release_photo,
    hardware,
  };
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_stackchan_hardware_init(
    struct iterate_kit_stackchan_hardware *hardware,
    const struct iterate_kit_stackchan_hardware_ops *ops) {
  if (hardware == NULL || ops == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(hardware, 0, sizeof(*hardware));
  hardware->ops = *ops;
  hardware->initialized = true;
  return ITERATE_KIT_OK;
}

struct iterate_kit_screen_driver iterate_kit_stackchan_screen_driver(
    struct iterate_kit_stackchan_hardware *hardware) {
  const struct iterate_kit_screen_driver driver = {
    hardware,
    render_png,
    change_colour,
  };
  return driver;
}

struct iterate_kit_led_driver iterate_kit_stackchan_led_driver(
    struct iterate_kit_stackchan_hardware *hardware) {
  const struct iterate_kit_led_driver driver = {
    hardware,
    set_led,
    fill_leds,
  };
  return driver;
}

struct iterate_kit_servo_driver iterate_kit_stackchan_servo_driver(
    struct iterate_kit_stackchan_hardware *hardware) {
  const struct iterate_kit_servo_driver driver = {
    hardware,
    move_servos,
  };
  return driver;
}

struct iterate_kit_camera_driver iterate_kit_stackchan_camera_driver(
    struct iterate_kit_stackchan_hardware *hardware) {
  const struct iterate_kit_camera_driver driver = {
    hardware,
    take_photo,
  };
  return driver;
}
