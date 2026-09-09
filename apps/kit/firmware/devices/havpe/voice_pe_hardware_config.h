#ifndef ITERATE_KIT_HAVPE_VOICE_PE_HARDWARE_CONFIG_H
#define ITERATE_KIT_HAVPE_VOICE_PE_HARDWARE_CONFIG_H

#include "iterate/kit/xmos_control.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Adopted from the donor branch's proven HAVPE port (§5.1 Tier 2:
 * voice_pe_hardware_config). Pure C99 with no hardware includes, so the
 * register tables and XMOS wire contracts stay host-testable: the literal
 * tests make any divergence an intentional hardware change with reviewable
 * evidence rather than an unexplained acoustic regression.
 */

enum {
  ITERATE_KIT_VOICE_PE_AIC3204_SETTLE_MS = 2500,
};

/* One page-sensitive AIC3204 register write in wire order. */
struct iterate_kit_voice_pe_register_write {
  uint8_t address;
  uint8_t value;
};

/**
 * Selects the XMOS tap that is allowed onto the realtime uplink.
 *
 * Keeping this policy beside the first-party stage enum makes a consequential
 * DSP choice host-testable. It must not be buried as a literal in the ESP-IDF
 * owner task: changing AEC/NS/AGC order changes both intelligibility and
 * whether speaker residue can retrigger provider VAD.
 */
enum iterate_kit_xmos_stage
iterate_kit_voice_pe_xmos_uplink_stage(void);

/**
 * Returns immutable boot-time register scripts mirrored from ESPHome's
 * first-party AIC3204 component. The split preserves its mandatory analogue
 * soft-start delay; callers must wait AIC3204_SETTLE_MS between the arrays.
 */
const struct iterate_kit_voice_pe_register_write *
iterate_kit_voice_pe_aic3204_initial_writes(size_t *count);
const struct iterate_kit_voice_pe_register_write *
iterate_kit_voice_pe_aic3204_power_up_writes(size_t *count);

#ifdef __cplusplus
}
#endif

#endif
