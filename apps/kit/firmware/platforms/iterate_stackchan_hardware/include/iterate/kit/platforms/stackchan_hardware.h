#ifndef ITERATE_KIT_PLATFORMS_STACKCHAN_HARDWARE_H
#define ITERATE_KIT_PLATFORMS_STACKCHAN_HARDWARE_H

#include "iterate/kit/capabilities/camera.h"
#include "iterate/kit/capabilities/leds.h"
#include "iterate/kit/capabilities/screen.h"
#include "iterate/kit/capabilities/servos.h"
#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  /*
   * This count comes from the official StackChan body's PY32 LED controller,
   * not the CoreS3 itself. The controller stores one RGB565 word per pixel at
   * registers 0x30..0x47 and exposes the count in register 0x24.
   */
  ITERATE_KIT_STACKCHAN_LED_COUNT = 12,
  /* The official SCS0009 body faces forward at its 150-degree yaw position. */
  ITERATE_KIT_STACKCHAN_YAW_CENTRE_DEGREES = 150,
};

/**
 * One encoded frame lent by the physical camera backend.
 *
 * `handle` is deliberately separate from `data`: esp_camera returns a frame
 * descriptor that must be returned even though Cap'n Web only sees its byte
 * span. The adapter admits one handle at a time and never copies camera-sized
 * data. A backend must keep all three fields stable until release_jpeg().
 */
struct iterate_kit_stackchan_photo_frame {
  const uint8_t *data;
  size_t size;
  void *handle;
};

/**
 * Narrow physical-I/O boundary for the StackChan adapter.
 *
 * These callbacks are injected rather than hidden globals for two reasons:
 * the host rig can impose I/O failures without emulating ESP-IDF, and a target
 * can assign display/I2C/UART/camera ownership to one cooperative task. Every
 * call is synchronous and must be allocation-bounded. NULL means the physical
 * feature is absent or not honestly implemented and produces UNAVAILABLE.
 */
struct iterate_kit_stackchan_hardware_ops {
  void *context;
  enum iterate_kit_status (*fill_display)(
      void *context, uint32_t rgb888);
  enum iterate_kit_status (*render_png)(
      void *context, const char *url, size_t url_length);
  enum iterate_kit_status (*write_leds)(
      void *context,
      const uint16_t *rgb565,
      size_t pixel_count);
  enum iterate_kit_status (*move_head)(
      void *context,
      int16_t absolute_yaw_degrees,
      int16_t absolute_pitch_degrees,
      uint16_t duration_ms);
  enum iterate_kit_status (*capture_jpeg)(
      void *context,
      struct iterate_kit_stackchan_photo_frame *frame);
  void (*release_jpeg)(void *context, void *frame_handle);
};

/**
 * Allocation-free policy between generic capabilities and physical I/O.
 *
 * The 24-byte LED shadow is intentional: the PY32 refreshes a complete strip,
 * while set(index) must preserve the other eleven confirmed pixels. Camera
 * state is only one borrowed handle, making overlap explicit backpressure
 * instead of an implicit frame queue. This object is single-owner state; it is
 * not safe to invoke its driver views concurrently from hardware callbacks.
 */
struct iterate_kit_stackchan_hardware {
  struct iterate_kit_stackchan_hardware_ops ops;
  uint16_t confirmed_leds[ITERATE_KIT_STACKCHAN_LED_COUNT];
  void *outstanding_photo_handle;
  bool photo_outstanding;
  bool initialized;
};

enum iterate_kit_status iterate_kit_stackchan_hardware_init(
    struct iterate_kit_stackchan_hardware *hardware,
    const struct iterate_kit_stackchan_hardware_ops *ops);

/* Returned driver views borrow `hardware` for their full lifetime. */
struct iterate_kit_screen_driver iterate_kit_stackchan_screen_driver(
    struct iterate_kit_stackchan_hardware *hardware);
struct iterate_kit_led_driver iterate_kit_stackchan_led_driver(
    struct iterate_kit_stackchan_hardware *hardware);
struct iterate_kit_servo_driver iterate_kit_stackchan_servo_driver(
    struct iterate_kit_stackchan_hardware *hardware);
struct iterate_kit_camera_driver iterate_kit_stackchan_camera_driver(
    struct iterate_kit_stackchan_hardware *hardware);

#ifdef __cplusplus
}
#endif

#endif
