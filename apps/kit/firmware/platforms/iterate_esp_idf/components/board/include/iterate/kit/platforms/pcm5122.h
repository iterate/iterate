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
/** Write register 0x03=0x11 (mute both) or 0 (unmute); step 17 / ESPHome pcm5122.cpp. */
bool iterate_kit_pcm5122_mute(i2c_master_dev_handle_t device, bool muted);

#ifdef __cplusplus
}
#endif
#endif
