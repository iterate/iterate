#ifndef ITERATE_KIT_PLATFORMS_REGISTER_SCRIPT_H
#define ITERATE_KIT_PLATFORMS_REGISTER_SCRIPT_H

#include "iterate/kit/platforms/register_write.h"
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Immutable chip script and its position relative to I2S startup.
 * settle_ms follows the script, before proceeding (AIC3204 soft-start: 2500 ms).
 * The board owns scheduling; scripts never sleep or open their own I2C bus.
 */
struct iterate_kit_register_script {
  uint8_t i2c_address;
  const struct iterate_kit_register_write *writes;
  size_t count;
  uint16_t settle_ms;
  enum { ITERATE_KIT_SCRIPT_BEFORE_I2S, ITERATE_KIT_SCRIPT_AFTER_I2S } when;
};

#ifdef __cplusplus
}
#endif
#endif
