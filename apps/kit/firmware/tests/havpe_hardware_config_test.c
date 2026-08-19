#include "voice_pe_hardware_config.h"

#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

/*
 * These literal vectors are copied from the first-party ESPHome AIC3204 and
 * voice_kit implementations, not derived from the production table under
 * test. A swapped register or invented pipeline tap can still produce audio,
 * but it invalidates volume/AEC evidence in ways an acoustic smoke test cannot
 * localise. A physical full-duplex run at +24 dB reproduced the assistant's
 * own speech almost verbatim on the supposedly clean microphone and repeatedly
 * triggered server VAD. The 0 dB register values below therefore protect an
 * unclipped electrical reference and acoustic path; loudness must be raised
 * only after measured AEC headroom, never by silently changing this vector.
 */
static void preserves_the_first_party_codec_sequence(void) {
  static const struct iterate_kit_voice_pe_register_write expected_initial[] = {
    {0x00, 0x00}, {0x01, 0x01}, {0x0b, 0x82}, {0x0c, 0x82},
    {0x0e, 0x80}, {0x1b, 0x30}, {0x38, 0x02}, {0x1f, 0x01},
    {0x20, 0x01}, {0x3c, 0x01}, {0x00, 0x01}, {0x02, 0x09},
    {0x01, 0x08}, {0x02, 0x01}, {0x0a, 0x40}, {0x03, 0x00},
    {0x04, 0x00}, {0x7b, 0x01}, {0x14, 0x25}, {0x0c, 0x08},
    {0x0d, 0x08}, {0x0e, 0x08}, {0x0f, 0x08}, {0x10, 0x3e},
    {0x11, 0x3e}, {0x12, 0x00}, {0x13, 0x00}, {0x09, 0x3c},
  };
  static const struct iterate_kit_voice_pe_register_write expected_power_up[] = {
    {0x00, 0x00}, {0x3f, 0xd4}, {0x41, 0x00}, {0x42, 0x00},
    {0x40, 0x00},
  };
  size_t count = 0U;
  const struct iterate_kit_voice_pe_register_write *writes =
      iterate_kit_voice_pe_aic3204_initial_writes(&count);
  assert(count == sizeof(expected_initial) / sizeof(expected_initial[0]));
  assert(memcmp(writes, expected_initial, sizeof(expected_initial)) == 0);

  writes = iterate_kit_voice_pe_aic3204_power_up_writes(&count);
  assert(count == sizeof(expected_power_up) / sizeof(expected_power_up[0]));
  assert(memcmp(writes, expected_power_up, sizeof(expected_power_up)) == 0);
  assert(ITERATE_KIT_VOICE_PE_AIC3204_SETTLE_MS == 2500U);
}

/*
 * THIS TEST IS THE ORACLE'S GUARD, AND IT HAS EARNED THE JOB TWICE. It
 * asserts the NS tap because NS is the only stage a REAL CONVERSATION has
 * ever endorsed: the corrected campaign measured 0.982 matched-path
 * similarity, 0.901 under double-talk, three clean server-VAD starts and
 * no speaker-echo turn. The AEC tap's bench windows look better and its
 * conversations are worse — the recorded production run leaked the first
 * short reply nearly unchanged, and on 2026-08-19 a stage-1 build that
 * slipped past this very test (the assertion was "corrected" to match the
 * drifted code instead of the code corrected to match it) reached a
 * physical board and read echoRawPeak 8509 vs echoCleanPeak 8514
 * mid-conversation: cancellation of nothing, heard as double talk. When
 * this assertion disagrees with voice_pe_hardware_config.c, the FIX IS IN
 * THE CONFIG, and the evidence standard for moving it is the board's own
 * oracle (`voicelab aec --stages`, health's echoRawPeak/echoCleanPeak) on
 * a live conversation — never a bench window, never this file.
 */
static void selects_a_truthful_raw_and_server_vad_xmos_pair(void) {
  uint8_t command[4] = {0xffU, 0xffU, 0xffU, 0xffU};
  assert(
      iterate_kit_voice_pe_xmos_uplink_stage() ==
      ITERATE_KIT_VOICE_PE_XMOS_STAGE_NS);
  assert(
      iterate_kit_voice_pe_xmos_pipeline_command(
          0U,
          iterate_kit_voice_pe_xmos_uplink_stage(),
          command,
          sizeof(command)) == ITERATE_KIT_OK);
  assert(command[0] == 241U);
  assert(command[1] == 0x30U);
  assert(command[2] == 1U);
  assert(command[3] == 3U);

  assert(
      iterate_kit_voice_pe_xmos_pipeline_command(
          1U,
          ITERATE_KIT_VOICE_PE_XMOS_STAGE_NONE,
          command,
          sizeof(command)) == ITERATE_KIT_OK);
  assert(command[0] == 241U);
  assert(command[1] == 0x40U);
  assert(command[2] == 1U);
  assert(command[3] == 0U);

  assert(
      iterate_kit_voice_pe_xmos_pipeline_command(
          2U,
          ITERATE_KIT_VOICE_PE_XMOS_STAGE_AEC,
          command,
          sizeof(command)) == ITERATE_KIT_INVALID_ARGUMENT);
  assert(
      iterate_kit_voice_pe_xmos_pipeline_command(
          0U,
          ITERATE_KIT_VOICE_PE_XMOS_STAGE_COUNT,
          command,
          sizeof(command)) == ITERATE_KIT_INVALID_ARGUMENT);
}

/*
 * A successful I2C write only proves that bytes left the ESP32. It does not
 * prove which XMOS firmware accepted them or that the live pipeline changed.
 * These literal read contracts let boot fail closed on an incompatible
 * firmware or silently ignored stage write instead of collecting misleading
 * AEC evidence from an unknown signal path.
 */
static void verifies_xmos_firmware_and_pipeline_readback(void) {
  uint8_t command[3] = {0xffU, 0xffU, 0xffU};
  struct iterate_kit_voice_pe_xmos_version version = {0U, 0U, 0U};
  assert(
      iterate_kit_voice_pe_xmos_version_command(
          command, sizeof(command)) == ITERATE_KIT_OK);
  assert(command[0] == 240U);
  assert(command[1] == (uint8_t)(88U | 0x80U));
  assert(command[2] == 4U);
  const uint8_t version_response[] = {0U, 1U, 3U, 1U};
  assert(
      iterate_kit_voice_pe_parse_xmos_version(
          version_response,
          sizeof(version_response),
          &version) == ITERATE_KIT_OK);
  assert(version.major == 1U);
  assert(version.minor == 3U);
  assert(version.patch == 1U);
  assert(iterate_kit_voice_pe_xmos_version_is_supported(&version));

  assert(
      iterate_kit_voice_pe_xmos_pipeline_read_command(
          1U, command, sizeof(command)) == ITERATE_KIT_OK);
  assert(command[0] == 241U);
  assert(command[1] == (uint8_t)(0x40U | 0x80U));
  assert(command[2] == 2U);
  const uint8_t stage_response[] = {
    0U,
    ITERATE_KIT_VOICE_PE_XMOS_STAGE_NONE,
  };
  assert(
      iterate_kit_voice_pe_xmos_pipeline_response_matches(
          stage_response,
          sizeof(stage_response),
          ITERATE_KIT_VOICE_PE_XMOS_STAGE_NONE));

  const uint8_t rejected_response[] = {1U, 0U};
  assert(
      iterate_kit_voice_pe_parse_xmos_version(
          rejected_response,
          sizeof(rejected_response),
          &version) == ITERATE_KIT_INVALID_ARGUMENT);
  assert(
      !iterate_kit_voice_pe_xmos_pipeline_response_matches(
          rejected_response,
          sizeof(rejected_response),
          ITERATE_KIT_VOICE_PE_XMOS_STAGE_NONE));
}

int main(void) {
  preserves_the_first_party_codec_sequence();
  selects_a_truthful_raw_and_server_vad_xmos_pair();
  verifies_xmos_firmware_and_pipeline_readback();
  return 0;
}
