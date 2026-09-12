#ifndef ITERATE_KIT_XMOS_CONTROL_H
#define ITERATE_KIT_XMOS_CONTROL_H

#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Cumulative XMOS pipeline taps in device-control wire order. */
enum iterate_kit_xmos_stage {
  ITERATE_KIT_XMOS_STAGE_NONE = 0,
  ITERATE_KIT_XMOS_STAGE_AEC = 1,
  ITERATE_KIT_XMOS_STAGE_IC = 2,
  ITERATE_KIT_XMOS_STAGE_NS = 3,
  ITERATE_KIT_XMOS_STAGE_AGC = 4,
  ITERATE_KIT_XMOS_STAGE_COUNT,
};

/** Firmware identity returned only after a successful device-control status. */
struct iterate_kit_xmos_version {
  uint8_t major;
  uint8_t minor;
  uint8_t patch;
};

/**
 * Builds the XMOS configuration-servicer command for either output channel.
 * The command is four bytes and contains no transport framing beyond the
 * device-control resource/command/length/value contract.
 */
enum iterate_kit_status iterate_kit_xmos_pipeline_command(
    uint8_t channel,
    enum iterate_kit_xmos_stage stage,
    uint8_t *destination,
    size_t destination_capacity);

/**
 * Builds and validates the read-side XMOS contracts used to fail boot closed.
 * A write ACK does not establish the firmware version or live pipeline stage;
 * callers must issue these requests and check their exact response before
 * treating capture/AEC evidence as trustworthy.
 */
enum iterate_kit_status iterate_kit_xmos_version_command(
    uint8_t *destination,
    size_t destination_capacity);
/** Parse exactly four bytes (DONE, major, minor, patch); reject failed status. */
enum iterate_kit_status iterate_kit_xmos_parse_version(
    const uint8_t *response,
    size_t response_size,
    struct iterate_kit_xmos_version *version);
/** Accept only the measured 1.3.1 firmware contract; NULL is unsupported. */
bool iterate_kit_xmos_version_is_supported(
    const struct iterate_kit_xmos_version *version);
/** Request read-back for channel 0 or 1 into at least three output bytes. */
enum iterate_kit_status iterate_kit_xmos_pipeline_read_command(
    uint8_t channel,
    uint8_t *destination,
    size_t destination_capacity);
/** Require exactly DONE plus the requested valid stage; NULL never matches. */
bool iterate_kit_xmos_pipeline_response_matches(
    const uint8_t *response,
    size_t response_size,
    enum iterate_kit_xmos_stage expected_stage);

/**
 * The XMOS DSP's own voice-to-noise estimate, 0-255: the one uplink-quality
 * number the hardware volunteers, and free soak evidence for open-mic runs.
 */
enum iterate_kit_status iterate_kit_xmos_vnr_command(
    uint8_t *destination,
    size_t destination_capacity);
/** Parse exactly DONE plus the 0-255 estimate; output must be non-NULL. */
enum iterate_kit_status iterate_kit_xmos_parse_vnr(
    const uint8_t *response,
    size_t response_size,
    uint8_t *vnr);

#ifdef __cplusplus
}
#endif

#endif
