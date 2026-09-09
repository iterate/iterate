#ifndef ITERATE_KIT_PLATFORMS_PCM5122_H
#define ITERATE_KIT_PLATFORMS_PCM5122_H

#include "driver/i2c_master.h"
#include "iterate/kit/platforms/pcm5122_registers.h"
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Reset, wait 20 ms, configure 32-bit stereo I2S / PLL from BCK.
 * Caller owns and serializes the I2C handle; every operation selects page 0.
 * False means a bus operation failed; no automatic retry. Task step 17,
 * translated from upstream ESPHome pcm5122/pcm5122.cpp. */
bool iterate_kit_pcm5122_init(i2c_master_dev_handle_t device);
/** Write both channels 0x3D/0x3E, clamp percent to 100; applied changes only
 * after BOTH writes succeed. False may leave channels unequal: caller must
 * handle the failure. Source: step 17 / ESPHome pcm5122.cpp. */
bool iterate_kit_pcm5122_set_volume(i2c_master_dev_handle_t device, uint8_t percent, uint8_t *applied);
/** Write register 0x03=0x11 (mute both) or 0 (unmute); step 17 / ESPHome pcm5122.cpp. */
bool iterate_kit_pcm5122_mute(i2c_master_dev_handle_t device, bool muted);
/** Read register 0x77 bit `pin` of register 0x77 (GPIN1..5 at bits 1..5; GPIO6 has no input bit), pin in 1..5.
 * only on success. Source: step 17 / ESPHome pcm5122.cpp GPIO input read. */
bool iterate_kit_pcm5122_read_gpio(i2c_master_dev_handle_t device, uint8_t pin, bool *level);

#ifdef __cplusplus
}
#endif
#endif
