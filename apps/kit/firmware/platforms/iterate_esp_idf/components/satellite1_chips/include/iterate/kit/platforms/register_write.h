#ifndef ITERATE_KIT_PLATFORMS_REGISTER_WRITE_H
#define ITERATE_KIT_PLATFORMS_REGISTER_WRITE_H

#include <stdint.h>

/** One I2C register write, as specified by board-table task's interface.
 * Pure so chip scripts can be checked without ESP-IDF headers. */
struct iterate_kit_register_write {
  uint8_t address;
  uint8_t value;
};

#endif
