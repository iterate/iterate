#ifndef ITERATE_KIT_PLATFORMS_REGISTER_WRITE_H
#define ITERATE_KIT_PLATFORMS_REGISTER_WRITE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** One page-sensitive I2C register write, in the chip script's wire order. */
struct iterate_kit_register_write {
  uint8_t address;
  uint8_t value;
};

#ifdef __cplusplus
}
#endif
#endif
