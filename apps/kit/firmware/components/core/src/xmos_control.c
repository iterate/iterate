#include "iterate/kit/xmos_control.h"

enum {
  ITERATE_KIT_XMOS_DFU_RESOURCE = 240,
  ITERATE_KIT_XMOS_CONFIGURATION_RESOURCE = 241,
  ITERATE_KIT_XMOS_GET_VERSION_COMMAND = 88,
  ITERATE_KIT_XMOS_READ_BIT = 0x80,
  ITERATE_KIT_XMOS_CONTROL_DONE = 0,
  ITERATE_KIT_XMOS_SUPPORTED_VERSION_MAJOR = 1,
  ITERATE_KIT_XMOS_SUPPORTED_VERSION_MINOR = 3,
  ITERATE_KIT_XMOS_SUPPORTED_VERSION_PATCH = 1,
};

enum iterate_kit_status iterate_kit_xmos_pipeline_command(
    uint8_t channel,
    enum iterate_kit_xmos_stage stage,
    uint8_t *destination,
    size_t destination_capacity) {
  if (channel > 1U || stage < ITERATE_KIT_XMOS_STAGE_NONE ||
      stage >= ITERATE_KIT_XMOS_STAGE_COUNT ||
      destination == NULL || destination_capacity < 4U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  /*
   * Resource 241 and command IDs 0x30/0x40 come from the XMOS firmware's
   * configuration_servicer. The caller deliberately selects channel 0's
   * public DSP tap; channel 1 NONE is the original microphone used only for
   * AEC diagnostics.
   */
  destination[0] = ITERATE_KIT_XMOS_CONFIGURATION_RESOURCE;
  destination[1] = channel == 0U ? 0x30U : 0x40U;
  destination[2] = 1U;
  destination[3] = (uint8_t)stage;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_xmos_version_command(
    uint8_t *destination,
    size_t destination_capacity) {
  if (destination == NULL || destination_capacity < 3U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  destination[0] = ITERATE_KIT_XMOS_DFU_RESOURCE;
  destination[1] =
      ITERATE_KIT_XMOS_GET_VERSION_COMMAND | ITERATE_KIT_XMOS_READ_BIT;
  destination[2] = 4U;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_xmos_vnr_command(
    uint8_t *destination,
    size_t destination_capacity) {
  if (destination == NULL || destination_capacity < 3U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  /*
   * Command 0x00 on the configuration servicer is the DSP's own
   * voice-to-noise estimate, 0-255. Nabu Casa's firmware reads it the same
   * way; it is the one uplink-quality number the XMOS will volunteer.
   */
  destination[0] = ITERATE_KIT_XMOS_CONFIGURATION_RESOURCE;
  destination[1] = 0x00U | ITERATE_KIT_XMOS_READ_BIT;
  destination[2] = 2U;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_xmos_parse_vnr(
    const uint8_t *response,
    size_t response_size,
    uint8_t *vnr) {
  if (response == NULL || response_size != 2U || vnr == NULL ||
      response[0] != ITERATE_KIT_XMOS_CONTROL_DONE) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  *vnr = response[1];
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_xmos_parse_version(
    const uint8_t *response,
    size_t response_size,
    struct iterate_kit_xmos_version *version) {
  if (response == NULL || response_size != 4U || version == NULL ||
      response[0] != ITERATE_KIT_XMOS_CONTROL_DONE) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  version->major = response[1];
  version->minor = response[2];
  version->patch = response[3];
  return ITERATE_KIT_OK;
}

bool iterate_kit_xmos_version_is_supported(
    const struct iterate_kit_xmos_version *version) {
  return version != NULL &&
      version->major == ITERATE_KIT_XMOS_SUPPORTED_VERSION_MAJOR &&
      version->minor == ITERATE_KIT_XMOS_SUPPORTED_VERSION_MINOR &&
      version->patch == ITERATE_KIT_XMOS_SUPPORTED_VERSION_PATCH;
}

enum iterate_kit_status iterate_kit_xmos_pipeline_read_command(
    uint8_t channel,
    uint8_t *destination,
    size_t destination_capacity) {
  if (channel > 1U || destination == NULL ||
      destination_capacity < 3U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  destination[0] = ITERATE_KIT_XMOS_CONFIGURATION_RESOURCE;
  destination[1] = (channel == 0U ? 0x30U : 0x40U) |
      ITERATE_KIT_XMOS_READ_BIT;
  destination[2] = 2U;
  return ITERATE_KIT_OK;
}

bool iterate_kit_xmos_pipeline_response_matches(
    const uint8_t *response,
    size_t response_size,
    enum iterate_kit_xmos_stage expected_stage) {
  return response != NULL && response_size == 2U &&
      expected_stage >= ITERATE_KIT_XMOS_STAGE_NONE &&
      expected_stage < ITERATE_KIT_XMOS_STAGE_COUNT &&
      response[0] == ITERATE_KIT_XMOS_CONTROL_DONE &&
      response[1] == (uint8_t)expected_stage;
}
