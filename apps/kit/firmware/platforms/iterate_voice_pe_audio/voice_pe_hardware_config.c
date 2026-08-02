#include "iterate/kit/platforms/voice_pe_hardware_config.h"

enum {
  VOICE_PE_XMOS_DFU_RESOURCE = 240,
  VOICE_PE_XMOS_CONFIGURATION_RESOURCE = 241,
  VOICE_PE_XMOS_GET_VERSION_COMMAND = 88,
  VOICE_PE_XMOS_READ_BIT = 0x80,
  VOICE_PE_XMOS_CONTROL_DONE = 0,
  VOICE_PE_XMOS_SUPPORTED_VERSION_MAJOR = 1,
  VOICE_PE_XMOS_SUPPORTED_VERSION_MINOR = 3,
  VOICE_PE_XMOS_SUPPORTED_VERSION_PATCH = 1,
};

/*
 * Do not "simplify" this table from the data sheet in isolation. It mirrors
 * ESPHome's proven AIC3204 setup, including page switches, 32-bit I2S, MFP3
 * routing, 0.75 V common mode, analogue driver routing, and pop-suppression
 * settings for the actual Voice Preview Edition circuit. The host literal
 * test makes any divergence an intentional hardware change with reviewable
 * evidence rather than an unexplained acoustic regression.
 */
static const struct iterate_kit_voice_pe_register_write initial_writes[] = {
  {0x00, 0x00}, {0x01, 0x01}, {0x0b, 0x82}, {0x0c, 0x82},
  {0x0e, 0x80}, {0x1b, 0x30}, {0x38, 0x02}, {0x1f, 0x01},
  {0x20, 0x01}, {0x3c, 0x01}, {0x00, 0x01}, {0x02, 0x09},
  {0x01, 0x08}, {0x02, 0x01}, {0x0a, 0x40}, {0x03, 0x00},
  {0x04, 0x00}, {0x7b, 0x01}, {0x14, 0x25}, {0x0c, 0x08},
  {0x0d, 0x08}, {0x0e, 0x08}, {0x0f, 0x08}, {0x10, 0x3e},
  {0x11, 0x3e}, {0x12, 0x00}, {0x13, 0x00}, {0x09, 0x3c},
};

/*
 * Keep the DAC at 0 dB even though ESPHome's theoretical 100% endpoint is
 * +24 dB. A production full-duplex run at that endpoint made Grok transcribe
 * its own speaker output almost verbatim on XMOS's processed channel: the
 * positive digital gain exhausted acoustic/AEC headroom before the DSP could
 * provide useful cancellation. PCM reaches this boundary unscaled, so 0 dB is
 * the loudest setting that cannot electrically clip a full-scale provider
 * sample. If the nearby-Mac oracle later proves it too quiet, volume may move
 * only behind a measured unclipped/AEC gate; intelligibility is not permission
 * to reintroduce self-triggering server VAD.
 */
static const struct iterate_kit_voice_pe_register_write power_up_writes[] = {
  {0x00, 0x00},
  {0x3f, 0xd4},
  {0x41, 0x00},
  {0x42, 0x00},
  {0x40, 0x00},
};

const struct iterate_kit_voice_pe_register_write *
iterate_kit_voice_pe_aic3204_initial_writes(size_t *count) {
  if (count != NULL) {
    *count = sizeof(initial_writes) / sizeof(initial_writes[0]);
  }
  return initial_writes;
}

const struct iterate_kit_voice_pe_register_write *
iterate_kit_voice_pe_aic3204_power_up_writes(size_t *count) {
  if (count != NULL) {
    *count = sizeof(power_up_writes) / sizeof(power_up_writes[0]);
  }
  return power_up_writes;
}

enum iterate_kit_voice_pe_xmos_stage
iterate_kit_voice_pe_xmos_uplink_stage(void) {
  /*
   * The public XMOS firmware orders this path AEC -> IC -> NS -> AGC. A
   * network-valid physical run showed that the final AGC expanded quiet
   * speaker residue by roughly two orders of magnitude and made Grok hear its
   * own reply as a new user turn. Stage NS retains every echo-processing stage
   * while omitting only that destabilising final gain. The userspace bridge
   * applies a measured fixed multiplier after transport because native NS
   * level is below xAI's VAD floor. Unlike XMOS AGC, that multiplier cannot
   * adapt upward specifically when quiet far-end residue is present.
   */
  return ITERATE_KIT_VOICE_PE_XMOS_STAGE_NS;
}

enum iterate_kit_status iterate_kit_voice_pe_xmos_pipeline_command(
    uint8_t channel,
    enum iterate_kit_voice_pe_xmos_stage stage,
    uint8_t *destination,
    size_t destination_capacity) {
  if (channel > 1U || stage < ITERATE_KIT_VOICE_PE_XMOS_STAGE_NONE ||
      stage >= ITERATE_KIT_VOICE_PE_XMOS_STAGE_COUNT ||
      destination == NULL || destination_capacity < 4U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  /*
   * Resource 241 and command IDs 0x30/0x40 come from the XMOS firmware's
   * configuration_servicer. The caller deliberately selects channel 0's
   * public DSP tap; channel 1 NONE is the original microphone used only for
   * AEC diagnostics.
   */
  destination[0] = VOICE_PE_XMOS_CONFIGURATION_RESOURCE;
  destination[1] = channel == 0U ? 0x30U : 0x40U;
  destination[2] = 1U;
  destination[3] = (uint8_t)stage;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_voice_pe_xmos_version_command(
    uint8_t *destination,
    size_t destination_capacity) {
  if (destination == NULL || destination_capacity < 3U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  destination[0] = VOICE_PE_XMOS_DFU_RESOURCE;
  destination[1] =
      VOICE_PE_XMOS_GET_VERSION_COMMAND | VOICE_PE_XMOS_READ_BIT;
  destination[2] = 4U;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_voice_pe_parse_xmos_version(
    const uint8_t *response,
    size_t response_size,
    struct iterate_kit_voice_pe_xmos_version *version) {
  if (response == NULL || response_size != 4U || version == NULL ||
      response[0] != VOICE_PE_XMOS_CONTROL_DONE) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  version->major = response[1];
  version->minor = response[2];
  version->patch = response[3];
  return ITERATE_KIT_OK;
}

bool iterate_kit_voice_pe_xmos_version_is_supported(
    const struct iterate_kit_voice_pe_xmos_version *version) {
  return version != NULL &&
      version->major == VOICE_PE_XMOS_SUPPORTED_VERSION_MAJOR &&
      version->minor == VOICE_PE_XMOS_SUPPORTED_VERSION_MINOR &&
      version->patch == VOICE_PE_XMOS_SUPPORTED_VERSION_PATCH;
}

enum iterate_kit_status iterate_kit_voice_pe_xmos_pipeline_read_command(
    uint8_t channel,
    uint8_t *destination,
    size_t destination_capacity) {
  if (channel > 1U || destination == NULL ||
      destination_capacity < 3U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  destination[0] = VOICE_PE_XMOS_CONFIGURATION_RESOURCE;
  destination[1] = (channel == 0U ? 0x30U : 0x40U) |
      VOICE_PE_XMOS_READ_BIT;
  destination[2] = 2U;
  return ITERATE_KIT_OK;
}

bool iterate_kit_voice_pe_xmos_pipeline_response_matches(
    const uint8_t *response,
    size_t response_size,
    enum iterate_kit_voice_pe_xmos_stage expected_stage) {
  return response != NULL && response_size == 2U &&
      expected_stage >= ITERATE_KIT_VOICE_PE_XMOS_STAGE_NONE &&
      expected_stage < ITERATE_KIT_VOICE_PE_XMOS_STAGE_COUNT &&
      response[0] == VOICE_PE_XMOS_CONTROL_DONE &&
      response[1] == (uint8_t)expected_stage;
}
