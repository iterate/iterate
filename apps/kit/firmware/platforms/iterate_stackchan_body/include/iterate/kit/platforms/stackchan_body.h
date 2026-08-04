#ifndef ITERATE_KIT_PLATFORMS_STACKCHAN_BODY_H
#define ITERATE_KIT_PLATFORMS_STACKCHAN_BODY_H

#include "esp_err.h"
#include "iterate/kit/platforms/stackchan_hardware.h"

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * One physical owner for the official StackChan body MCU and SCS0009 bus.
 *
 * The capability layer remains host-testable and knows only injected I/O
 * callbacks. This ESP-IDF boundary owns the real shared I2C device and UART;
 * keeping those handles here prevents the status renderer and model tools from
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

struct iterate_kit_stackchan_hardware_ops
iterate_kit_stackchan_body_hardware_ops(
    struct iterate_kit_stackchan_body *body);

#ifdef __cplusplus
}
#endif

#endif
