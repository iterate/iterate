#include "iterate/kit/xmos_control.h"

#include <assert.h>
#include <stddef.h>
#include <string.h>

/** Pipeline command inputs and their literal device-control wire result. */
struct pipeline_case {
  uint8_t channel;
  enum iterate_kit_xmos_stage stage;
  enum iterate_kit_status becomes_status;
  uint8_t becomes[4];
};

static void pipeline_commands(void) {
  const struct pipeline_case cases[] = {
    {0, ITERATE_KIT_XMOS_STAGE_NS, ITERATE_KIT_OK, {241, 0x30, 1, 3}},
    {1, ITERATE_KIT_XMOS_STAGE_NONE, ITERATE_KIT_OK, {241, 0x40, 1, 0}},
    {2, ITERATE_KIT_XMOS_STAGE_AEC, ITERATE_KIT_INVALID_ARGUMENT, {0}},
    {0, ITERATE_KIT_XMOS_STAGE_COUNT, ITERATE_KIT_INVALID_ARGUMENT, {0}},
  };
  for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
    uint8_t output[4] = {0};
    assert(iterate_kit_xmos_pipeline_command(cases[i].channel, cases[i].stage,
        output, sizeof(output)) == cases[i].becomes_status);
    assert(memcmp(output, cases[i].becomes, sizeof(output)) == 0);
  }
  const struct {
    uint8_t channel;
    enum iterate_kit_status becomes_status;
    uint8_t becomes[3];
  } reads[] = {
    {0, ITERATE_KIT_OK, {241, 0xb0, 2}},
    {1, ITERATE_KIT_OK, {241, 0xc0, 2}},
    {2, ITERATE_KIT_INVALID_ARGUMENT, {0}},
  };
  for (size_t i = 0; i < sizeof(reads) / sizeof(reads[0]); ++i) {
    uint8_t output[3] = {0};
    assert(iterate_kit_xmos_pipeline_read_command(reads[i].channel,
        output, sizeof(output)) == reads[i].becomes_status);
    assert(memcmp(output, reads[i].becomes, sizeof(output)) == 0);
  }
}

/* A successful transport write does not establish the firmware or live stage.
 * These literal read contracts fail closed on incompatible/ignored commands. */
static void read_commands(void) {
  const struct {
    enum iterate_kit_status (*command)(uint8_t *, size_t);
    size_t capacity;
    enum iterate_kit_status becomes_status;
    uint8_t becomes[3];
  } cases[] = {
    {iterate_kit_xmos_version_command, 3, ITERATE_KIT_OK, {240, 0xd8, 4}},
    {iterate_kit_xmos_vnr_command, 3, ITERATE_KIT_OK, {241, 0x80, 2}},
    {iterate_kit_xmos_version_command, 2, ITERATE_KIT_INVALID_ARGUMENT, {0}},
    {iterate_kit_xmos_vnr_command, 2, ITERATE_KIT_INVALID_ARGUMENT, {0}},
  };
  for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
    uint8_t output[3] = {0};
    assert(cases[i].command(output, cases[i].capacity) == cases[i].becomes_status);
    assert(memcmp(output, cases[i].becomes, sizeof(output)) == 0);
  }
}

static void version_responses(void) {
  const struct {
    uint8_t response[4];
    size_t size;
    enum iterate_kit_status becomes_status;
    struct iterate_kit_xmos_version becomes_version;
    bool becomes_supported;
  } cases[] = {
    {{0, 1, 3, 1}, 4, ITERATE_KIT_OK, {1, 3, 1}, true},
    {{0, 1, 3, 2}, 4, ITERATE_KIT_OK, {1, 3, 2}, false},
    {{1, 0}, 2, ITERATE_KIT_INVALID_ARGUMENT, {0}, false},
    {{1, 1, 3, 1}, 4, ITERATE_KIT_INVALID_ARGUMENT, {0}, false},
  };
  for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
    struct iterate_kit_xmos_version output = {0};
    assert(iterate_kit_xmos_parse_version(cases[i].response, cases[i].size,
        &output) == cases[i].becomes_status);
    assert(output.major == cases[i].becomes_version.major);
    assert(output.minor == cases[i].becomes_version.minor);
    assert(output.patch == cases[i].becomes_version.patch);
    assert(iterate_kit_xmos_version_is_supported(&output) == cases[i].becomes_supported);
  }
  assert(!iterate_kit_xmos_version_is_supported(NULL));
}

static void stage_and_vnr_responses(void) {
  const struct {
    uint8_t response[2];
    size_t size;
    enum iterate_kit_xmos_stage stage;
    bool becomes_match;
    enum iterate_kit_status becomes_status;
    uint8_t becomes_vnr;
  } cases[] = {
    {{0, 0}, 2, ITERATE_KIT_XMOS_STAGE_NONE, true, ITERATE_KIT_OK, 0},
    {{0, 3}, 2, ITERATE_KIT_XMOS_STAGE_NS, true, ITERATE_KIT_OK, 3},
    {{0, 255}, 2, ITERATE_KIT_XMOS_STAGE_NS, false, ITERATE_KIT_OK, 255},
    {{1, 0}, 2, ITERATE_KIT_XMOS_STAGE_NONE, false, ITERATE_KIT_INVALID_ARGUMENT, 99},
    {{0, 0}, 1, ITERATE_KIT_XMOS_STAGE_NONE, false, ITERATE_KIT_INVALID_ARGUMENT, 99},
  };
  for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
    uint8_t output = 99;
    assert(iterate_kit_xmos_pipeline_response_matches(cases[i].response,
        cases[i].size, cases[i].stage) == cases[i].becomes_match);
    assert(iterate_kit_xmos_parse_vnr(cases[i].response, cases[i].size,
        &output) == cases[i].becomes_status);
    assert(output == cases[i].becomes_vnr);
  }
}

int main(void) {
  pipeline_commands();
  read_commands();
  version_responses();
  stage_and_vnr_responses();
  return 0;
}
