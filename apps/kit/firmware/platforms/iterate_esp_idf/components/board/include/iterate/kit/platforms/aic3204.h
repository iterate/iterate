#ifndef ITERATE_KIT_PLATFORMS_AIC3204_H
#define ITERATE_KIT_PLATFORMS_AIC3204_H

#include "iterate/kit/platforms/register_script.h"
#include "iterate/kit/xmos_control.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Both scripts in boot order, for a constant board table. */
extern const struct iterate_kit_register_script iterate_kit_aic3204_scripts[2];

/** First-party AIC3204 setup: page switches, 32-bit I2S, MFP3 routing,
 * 0.75 V common mode and pop suppression. Wait its 2500 ms soft-start before
 * enabling I2S. Literal host tests guard the register order and values.
 */
const struct iterate_kit_register_script *iterate_kit_aic3204_initial_script(void);
/** Power the DAC after I2S enable, before the speaker rail. The 0 dB ceiling
 * preserves electrical and XMOS AEC headroom; +24 dB caused self-transcription.
 */
const struct iterate_kit_register_script *iterate_kit_aic3204_power_up_script(void);
/** Map 0..100 percent to signed half-dB DAC codes (-63..0 dB), clamping above
 * 100. The control is linear in dB, not amplitude: 50 percent is -31.5 dB.
 */
uint8_t iterate_kit_aic3204_volume_register(uint8_t percent);
/** The measured XMOS uplink policy, default NS. The compiler-visible
 * ITERATE_KIT_VOICE_PE_XMOS_UPLINK_STAGE override and its evidence essay live
 * with these hardware tables, so diagnostic builds cannot silently drift.
 */
enum iterate_kit_xmos_stage iterate_kit_xmos_uplink_stage(void);

#ifdef __cplusplus
}
#endif
#endif
