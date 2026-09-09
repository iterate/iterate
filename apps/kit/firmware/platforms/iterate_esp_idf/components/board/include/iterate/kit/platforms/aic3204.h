#ifndef ITERATE_KIT_PLATFORMS_AIC3204_H
#define ITERATE_KIT_PLATFORMS_AIC3204_H

#include "iterate/kit/platforms/register_script.h"
#include "iterate/kit/xmos_control.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Both scripts in boot order: [0] configures page switches, 32-bit I2S,
 * MFP3 routing, 0.75 V common mode and pop suppression, then settles 2500 ms
 * before I2S enable; [1] powers the DAC after enable, before the speaker rail.
 * The 0 dB ceiling preserves electrical and XMOS AEC headroom: +24 dB caused
 * self-transcription. Literal host tests guard register order and values.
 */
extern const struct iterate_kit_register_script iterate_kit_aic3204_scripts[2];

/** The measured XMOS uplink policy, default NS. The compiler-visible
 * ITERATE_KIT_VOICE_PE_XMOS_UPLINK_STAGE override and its evidence essay live
 * with these hardware tables, so diagnostic builds cannot silently drift.
 */
enum iterate_kit_xmos_stage iterate_kit_xmos_uplink_stage(void);

#ifdef __cplusplus
}
#endif
#endif
