#ifndef ITERATE_KIT_HAVPE_VOICE_PE_HARDWARE_CONFIG_H
#define ITERATE_KIT_HAVPE_VOICE_PE_HARDWARE_CONFIG_H

#include "iterate/kit/status.h"

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

enum iterate_kit_voice_pe_xmos_stage {
  ITERATE_KIT_VOICE_PE_XMOS_STAGE_NONE = 0,
  ITERATE_KIT_VOICE_PE_XMOS_STAGE_AEC = 1,
  ITERATE_KIT_VOICE_PE_XMOS_STAGE_IC = 2,
  ITERATE_KIT_VOICE_PE_XMOS_STAGE_NS = 3,
  ITERATE_KIT_VOICE_PE_XMOS_STAGE_AGC = 4,
  ITERATE_KIT_VOICE_PE_XMOS_STAGE_COUNT,
};

/**
 * Selects the XMOS tap that is allowed onto the realtime uplink.
 *
 * Keeping this policy beside the first-party stage enum makes a consequential
 * DSP choice host-testable. It must not be buried as a literal in the ESP-IDF
 * owner task: changing AEC/NS/AGC order changes both intelligibility and
 * whether speaker residue can retrigger provider VAD.
 */
enum iterate_kit_voice_pe_xmos_stage
iterate_kit_voice_pe_xmos_uplink_stage(void);

struct iterate_kit_voice_pe_xmos_version {
  uint8_t major;
  uint8_t minor;
  uint8_t patch;
};

/**
 * Returns immutable boot-time register scripts mirrored from ESPHome's
 * first-party AIC3204 component. The split preserves its mandatory analogue
 * soft-start delay; callers must wait AIC3204_SETTLE_MS between the arrays.
 */
const struct iterate_kit_voice_pe_register_write *
iterate_kit_voice_pe_aic3204_initial_writes(size_t *count);
const struct iterate_kit_voice_pe_register_write *
iterate_kit_voice_pe_aic3204_power_up_writes(size_t *count);

/**
 * Builds the XMOS configuration-servicer command for either output channel.
 * The command is four bytes and contains no transport framing beyond the
 * device-control resource/command/length/value contract.
 */
enum iterate_kit_status iterate_kit_voice_pe_xmos_pipeline_command(
    uint8_t channel,
    enum iterate_kit_voice_pe_xmos_stage stage,
    uint8_t *destination,
    size_t destination_capacity);

/**
 * Builds and validates the read-side XMOS contracts used to fail boot closed.
 * A write ACK does not establish the firmware version or live pipeline stage;
 * callers must issue these requests and check their exact response before
 * treating capture/AEC evidence as trustworthy.
 */
enum iterate_kit_status iterate_kit_voice_pe_xmos_version_command(
    uint8_t *destination,
    size_t destination_capacity);
enum iterate_kit_status iterate_kit_voice_pe_parse_xmos_version(
    const uint8_t *response,
    size_t response_size,
    struct iterate_kit_voice_pe_xmos_version *version);
bool iterate_kit_voice_pe_xmos_version_is_supported(
    const struct iterate_kit_voice_pe_xmos_version *version);
enum iterate_kit_status iterate_kit_voice_pe_xmos_pipeline_read_command(
    uint8_t channel,
    uint8_t *destination,
    size_t destination_capacity);
bool iterate_kit_voice_pe_xmos_pipeline_response_matches(
    const uint8_t *response,
    size_t response_size,
    enum iterate_kit_voice_pe_xmos_stage expected_stage);

#ifdef __cplusplus
}
#endif

#endif
