#ifndef ITERATE_KIT_STACKCHAN_BODY_H
#define ITERATE_KIT_STACKCHAN_BODY_H

#include "esp_err.h"
#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** The official body carries twelve RGB565 pixels in its PY32's LED RAM. */
enum { ITERATE_KIT_STACKCHAN_LED_COUNT = 12 };

/**
 * One physical owner for the official StackChan body MCU and SCS0009 bus.
 *
 * This ESP-IDF boundary owns the real shared I2C device and UART; keeping
 * those handles here prevents the status renderer and model tools from
 * becoming competing bus owners. Operations are synchronous but tightly
 * bounded and run only on the cooperative control task, never an audio task.
 */
struct iterate_kit_stackchan_body {
  void *i2c_device;
  bool i2c_ready;
  bool servo_ready;
};

esp_err_t iterate_kit_stackchan_body_start(
    struct iterate_kit_stackchan_body *body);

/** One atomic 12-pixel RGB565 commit to the body's LED RAM. */
enum iterate_kit_status iterate_kit_stackchan_body_write_leds(
    struct iterate_kit_stackchan_body *body,
    const uint16_t *pixels,
    size_t pixel_count);

/**
 * One broadcast timed move of both head servos. Envelope: yaw -128..128
 * degrees, pitch 0..90 degrees; `duration_ms` is the on-servo move time, so
 * a 700 ms gesture never parks the control loop or steals time from audio.
 */
enum iterate_kit_status iterate_kit_stackchan_body_move_head(
    struct iterate_kit_stackchan_body *body,
    int16_t yaw_degrees,
    int16_t pitch_degrees,
    uint16_t duration_ms);

#ifdef __cplusplus
}
#endif

#endif
