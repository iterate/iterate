#include "iterate/kit/capabilities/aec_diagnostic_trace.h"

#include <assert.h>
#include <stdint.h>
#include <string.h>

enum {
  frame_samples = 4,
  capture_samples = 4,
  maximum_read_samples = 4,
};

static uint32_t read_u32_le(const uint8_t *bytes) {
  return (uint32_t)bytes[0] |
      (uint32_t)bytes[1] << 8U |
      (uint32_t)bytes[2] << 16U |
      (uint32_t)bytes[3] << 24U;
}

/*
 * The control adapter may borrow one finite scratch reply, but it must never
 * allocate a second one or make the audio writer wait. This exercises the
 * ownership handoff literally: a second describe is busy until Cap'n Web's
 * release callback fires, while the trace itself completes independently.
 */
static void exposes_truthful_metadata_with_bounded_reply_ownership(void) {
  struct iterate_kit_aec_diagnostic_trace trace;
  struct iterate_kit_aec_diagnostic_trace_capability capability;
  int16_t near[capture_samples] = {0};
  int16_t clean[capture_samples] = {0};
  int16_t scratch[ITERATE_KIT_AEC_TRACE_METADATA_WORDS * 2U] = {0};
  const int16_t near_frame[frame_samples] = {1, 2, 3, 4};
  const int16_t clean_frame[frame_samples] = {5, 6, 7, 8};
  const struct iterate_kit_aec_diagnostic_trace_options trace_options = {
    .sample_rate_hz = 16000U,
    .frame_samples = frame_samples,
    .capture_samples = capture_samples,
    .available_planes =
        ITERATE_KIT_AEC_DIAGNOSTIC_PLANE_NEAR |
        ITERATE_KIT_AEC_DIAGNOSTIC_PLANE_CLEAN,
    .near_samples = near,
    .clean_samples = clean,
  };
  struct iterate_kit_aec_diagnostic_trace_capability_options capability_options;
  struct iterate_kit_module module;
  struct capnweb_call call = {0};
  struct capnweb_reply start_reply = {0};
  struct capnweb_reply describe_reply = {0};
  struct capnweb_reply busy_reply = {0};
  struct capnweb_reply release_reply = {0};

  assert(
      iterate_kit_aec_diagnostic_trace_init(&trace, &trace_options) ==
      ITERATE_KIT_OK);
  capability_options =
      (struct iterate_kit_aec_diagnostic_trace_capability_options){
        .trace = &trace,
        .read_scratch = scratch,
        .read_scratch_values = sizeof(scratch) / sizeof(scratch[0]),
        .maximum_read_samples = maximum_read_samples,
      };
  assert(
      iterate_kit_aec_diagnostic_trace_capability_init(
          &capability, &capability_options) == ITERATE_KIT_OK);
  module = iterate_kit_aec_diagnostic_trace_module(&capability);
  assert(module.method_count == 4U);
  assert(strcmp(module.methods[0].path[0], "aecTrace") == 0);
  assert(strcmp(module.methods[0].path[1], "describe") == 0);

  assert(
      module.methods[1].dispatch(
          module.context, &call, &start_reply) == CAPNWEB_OK);
  assert(start_reply.kind == CAPNWEB_REPLY_INT64);
  assert(start_reply.value.integer == 1);
  assert(
      iterate_kit_aec_diagnostic_trace_record(
          &trace,
          77U,
          near_frame,
          NULL,
          NULL,
          NULL,
          clean_frame,
          frame_samples) == ITERATE_KIT_OK);

  assert(
      module.methods[0].dispatch(
          module.context, &call, &describe_reply) == CAPNWEB_OK);
  assert(describe_reply.kind == CAPNWEB_REPLY_BYTES);
  assert(
      describe_reply.value.borrowed.length ==
      ITERATE_KIT_AEC_TRACE_METADATA_WORDS * sizeof(uint32_t));
  const uint8_t *const metadata = describe_reply.value.borrowed.data;
  assert(read_u32_le(metadata) == UINT32_C(0x31544149));
  assert(read_u32_le(metadata + 2U * sizeof(uint32_t)) == 16000U);
  assert(
      read_u32_le(metadata + 5U * sizeof(uint32_t)) ==
      (ITERATE_KIT_AEC_DIAGNOSTIC_PLANE_NEAR |
       ITERATE_KIT_AEC_DIAGNOSTIC_PLANE_CLEAN));
  assert(
      read_u32_le(metadata + 7U * sizeof(uint32_t)) ==
      ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_READY);
  assert(
      module.methods[0].dispatch(
          module.context, &call, &busy_reply) == CAPNWEB_OK);
  assert(busy_reply.kind == CAPNWEB_REPLY_ERROR);
  assert(strstr(busy_reply.value.error.message, "busy") != NULL);

  describe_reply.value.borrowed.release(
      describe_reply.value.borrowed.context);
  assert(
      module.methods[3].dispatch(
          module.context, &call, &release_reply) == CAPNWEB_OK);
  assert(release_reply.kind == CAPNWEB_REPLY_BOOLEAN);
  assert(release_reply.value.boolean);
}

int main(void) {
  exposes_truthful_metadata_with_bounded_reply_ownership();
  return 0;
}
