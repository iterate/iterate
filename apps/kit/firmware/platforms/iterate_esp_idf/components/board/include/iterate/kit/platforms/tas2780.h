#ifndef ITERATE_KIT_PLATFORMS_TAS2780_H
#define ITERATE_KIT_PLATFORMS_TAS2780_H

#include "driver/i2c_master.h"
#include "iterate/kit/platforms/tas2780_registers.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Caller-owned amplifier state; serialize all operations and health reads.
 * Supply/latch fields retain the last successful reads, failures saturate.
 * Hardware facts: Satellite1-ESPHome tas2780.cpp:277-598. */
struct iterate_kit_tas2780 {
  i2c_master_dev_handle_t device;
  enum iterate_kit_tas2780_power_mode power_mode;
  uint16_t pvdd_centivolts;
  uint16_t vbat1s_centivolts;
  uint32_t faults;
  uint32_t i2c_failures;
  uint8_t volume;
  bool muted;
  bool initialized;
};

/** Initialize caller-owned state, run base script, require chip ID 0x41.
 * False leaves initialized false. tas2780.cpp:277-338. */
bool iterate_kit_tas2780_init(struct iterate_kit_tas2780 *amp, i2c_master_dev_handle_t device);
/** Bootstrap mode 0, ACTIVE_MUTED, wait 100 ms for SAR, select valid supply
 * mode and become ACTIVE. Failure attempts shutdown; any failed recovery I2C
 * is counted too. Requires init and running I2S clocks. tas2780.cpp:340-383. */
bool iterate_kit_tas2780_activate(struct iterate_kit_tas2780 *amp);
/** Clamp to 100, write DVC (retain mute), then publish applied on success.
 * applied must be non-NULL. tas2780.cpp:547-598; step 17 percent mapping. */
bool iterate_kit_tas2780_set_volume(struct iterate_kit_tas2780 *amp, uint8_t percent, uint8_t *applied);
/** Write MODE_CTRL=0x82; false means shutdown was not confirmed. tas2780.cpp:385-392. */
bool iterate_kit_tas2780_shutdown(struct iterate_kit_tas2780 *amp);
/** Read 0x49/0x4A/0x4B/0x4F; cache and output only a complete successful read.
 * Reading latches may consume them; poll separately from health. tas2780.cpp:445-521. */
bool iterate_kit_tas2780_read_faults(struct iterate_kit_tas2780 *amp, uint32_t *faults);
/** Append cached amp fields using health_append_fields; 0 means invalid/no
 * space. No bus reads or state changes. Board-table step 17 health contract. */
size_t iterate_kit_tas2780_health(const struct iterate_kit_tas2780 *amp, char *out, size_t capacity);

#ifdef __cplusplus
}
#endif
#endif
