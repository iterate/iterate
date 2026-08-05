#ifndef ITERATE_KIT_CAPABILITIES_SERVOS_H
#define ITERATE_KIT_CAPABILITIES_SERVOS_H

#include "iterate/kit/peer.h"
#include "iterate/kit/status.h"

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Synchronous hardware boundary for a two-axis head. The generic capability
 * validates signed wire values against device limits before narrowing them, so
 * a malformed remote call cannot become wraparound movement.
 */
struct iterate_kit_servo_driver {
  void *context;
  enum iterate_kit_status (*move)(
      void *context,
      int32_t yaw_degrees,
      int32_t pitch_degrees,
      uint16_t speed);
};

struct iterate_kit_servo_limits {
  /*
   * Limits belong to the device profile rather than this library: geometry
   * and safe pulse ranges are hardware facts, not universal servo policy.
   */
  int32_t minimum_yaw_degrees;
  int32_t maximum_yaw_degrees;
  int32_t minimum_pitch_degrees;
  int32_t maximum_pitch_degrees;
  uint16_t maximum_speed;
};

struct iterate_kit_servos {
  struct iterate_kit_servo_driver driver;
  struct iterate_kit_servo_limits limits;
};

enum iterate_kit_status iterate_kit_servos_init(
    struct iterate_kit_servos *servos,
    const struct iterate_kit_servo_driver *driver,
    const struct iterate_kit_servo_limits *limits);
struct iterate_kit_module iterate_kit_servos_module(
    struct iterate_kit_servos *servos);

#ifdef __cplusplus
}
#endif

#endif
