#include "iterate/kit/capabilities/aec_diagnostic_trace.h"

#include "rpc_internal.h"

#include <limits.h>
#include <stdbool.h>
#include <string.h>

#define TRACE_WIRE_MAGIC UINT32_C(0x31544149) /* ASCII "IAT1" in LE bytes. */

static const char *const describe_path[] = {"aecTrace", "describe"};
static const char *const start_path[] = {"aecTrace", "start"};
static const char *const read_path[] = {"aecTrace", "read"};
static const char *const release_path[] = {"aecTrace", "release"};

static bool borrow_scratch(
    struct iterate_kit_aec_diagnostic_trace_capability *capability) {
  uint32_t expected = 0U;
  return __atomic_compare_exchange_n(
      &capability->scratch_borrowed,
      &expected,
      1U,
      false,
      __ATOMIC_ACQ_REL,
      __ATOMIC_ACQUIRE);
}

static void release_scratch(void *context) {
  struct iterate_kit_aec_diagnostic_trace_capability *capability = context;
  if (capability != NULL) {
    __atomic_store_n(
        &capability->scratch_borrowed, 0U, __ATOMIC_RELEASE);
  }
}

static void write_u32_le(uint8_t *destination, uint32_t value) {
  destination[0] = (uint8_t)(value & UINT32_C(0xff));
  destination[1] = (uint8_t)((value >> 8U) & UINT32_C(0xff));
  destination[2] = (uint8_t)((value >> 16U) & UINT32_C(0xff));
  destination[3] = (uint8_t)((value >> 24U) & UINT32_C(0xff));
}

static enum capnweb_status describe_trace(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_aec_diagnostic_trace_capability *capability = context;
  struct iterate_kit_aec_diagnostic_trace_snapshot snapshot;
  uint8_t *bytes;
  const uint32_t words[ITERATE_KIT_AEC_TRACE_METADATA_WORDS] = {
    TRACE_WIRE_MAGIC,
    ITERATE_KIT_AEC_TRACE_WIRE_SCHEMA,
    capability->trace->options.sample_rate_hz,
    (uint32_t)capability->trace->options.frame_samples,
    (uint32_t)capability->trace->options.capture_samples,
    capability->trace->options.available_planes,
    (uint32_t)capability->maximum_read_samples,
    0U,
    0U,
    0U,
    0U,
    0U,
    0U,
    0U,
    0U,
    0U,
  };
  (void)call;
  if (!borrow_scratch(capability)) {
    return iterate_kit_reply_status(reply, ITERATE_KIT_BACKPRESSURE);
  }
  iterate_kit_aec_diagnostic_trace_snapshot(capability->trace, &snapshot);
  bytes = (uint8_t *)capability->read_scratch;
  for (size_t index = 0U;
       index < ITERATE_KIT_AEC_TRACE_METADATA_WORDS;
       ++index) {
    uint32_t value = words[index];
    switch (index) {
      case 7U: value = (uint32_t)snapshot.state; break;
      case 8U: value = snapshot.generation; break;
      case 9U: value = snapshot.captured_samples; break;
      case 10U: value = snapshot.first_frame_sequence; break;
      case 11U: value = snapshot.last_frame_sequence; break;
      case 12U: value = snapshot.captures_started; break;
      case 13U: value = snapshot.captures_completed; break;
      case 14U: value = snapshot.captures_aborted; break;
      case 15U: value = snapshot.start_rejections; break;
      default: break;
    }
    write_u32_le(bytes + index * sizeof(uint32_t), value);
  }
  const enum capnweb_status status = capnweb_reply_set_bytes(
      reply,
      bytes,
      ITERATE_KIT_AEC_TRACE_METADATA_WORDS * sizeof(uint32_t),
      release_scratch,
      capability);
  if (status != CAPNWEB_OK) release_scratch(capability);
  return status;
}

static enum capnweb_status start_trace(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_aec_diagnostic_trace_capability *capability = context;
  uint32_t generation = 0U;
  (void)call;
  const enum iterate_kit_status status =
      iterate_kit_aec_diagnostic_trace_start(
          capability->trace, &generation);
  return status == ITERATE_KIT_OK
      ? capnweb_reply_set_int64(reply, (int64_t)generation)
      : iterate_kit_reply_status(reply, status);
}

static enum capnweb_status read_trace(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_aec_diagnostic_trace_capability *capability = context;
  struct capnweb_value object = {0};
  int64_t sample_offset = 0;
  int64_t sample_count = 0;
  if (!iterate_kit_read_object_argument(call, &object) ||
      !iterate_kit_read_int_field(&object, "sampleOffset", &sample_offset) ||
      !iterate_kit_read_int_field(&object, "sampleCount", &sample_count) ||
      sample_offset < 0 || sample_count <= 0 ||
      (uint64_t)sample_offset > SIZE_MAX ||
      (uint64_t)sample_count > capability->maximum_read_samples) {
    return capnweb_reply_set_error(
        reply,
        "RangeError",
        "aecTrace.read requires bounded sampleOffset and sampleCount integers");
  }
  if (!borrow_scratch(capability)) {
    return iterate_kit_reply_status(reply, ITERATE_KIT_BACKPRESSURE);
  }
  const size_t count = (size_t)sample_count;
  const enum iterate_kit_status trace_status =
      iterate_kit_aec_diagnostic_trace_read_planar(
          capability->trace,
          (size_t)sample_offset,
          count,
          capability->read_scratch,
          capability->read_scratch_values);
  if (trace_status != ITERATE_KIT_OK) {
    release_scratch(capability);
    return iterate_kit_reply_status(reply, trace_status);
  }

  /*
   * ESP32 is little-endian, but the wire contract must not depend on the host
   * used by the simulator. Reading each value before overwriting its own two
   * bytes makes this in-place conversion safe on either endian without a
   * second diagnostic buffer.
   */
  uint8_t *const bytes = (uint8_t *)capability->read_scratch;
  for (size_t index = 0U; index < count * 5U; ++index) {
    const uint16_t value = (uint16_t)capability->read_scratch[index];
    bytes[index * 2U] = (uint8_t)(value & UINT16_C(0xff));
    bytes[index * 2U + 1U] = (uint8_t)(value >> 8U);
  }
  const enum capnweb_status reply_status = capnweb_reply_set_bytes(
      reply,
      bytes,
      count * 5U * sizeof(int16_t),
      release_scratch,
      capability);
  if (reply_status != CAPNWEB_OK) release_scratch(capability);
  return reply_status;
}

static enum capnweb_status release_trace(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_aec_diagnostic_trace_capability *capability = context;
  (void)call;
  if (__atomic_load_n(
          &capability->scratch_borrowed, __ATOMIC_ACQUIRE) != 0U) {
    return iterate_kit_reply_status(reply, ITERATE_KIT_BACKPRESSURE);
  }
  const enum iterate_kit_status status =
      iterate_kit_aec_diagnostic_trace_release(capability->trace);
  return status == ITERATE_KIT_OK
      ? capnweb_reply_set_boolean(reply, true)
      : iterate_kit_reply_status(reply, status);
}

enum iterate_kit_status iterate_kit_aec_diagnostic_trace_capability_init(
    struct iterate_kit_aec_diagnostic_trace_capability *capability,
    const struct iterate_kit_aec_diagnostic_trace_capability_options *options) {
  if (capability == NULL || options == NULL || options->trace == NULL ||
      options->trace->initialized == 0U || options->read_scratch == NULL ||
      options->maximum_read_samples == 0U ||
      options->maximum_read_samples > SIZE_MAX / 5U ||
      options->read_scratch_values < options->maximum_read_samples * 5U ||
      options->read_scratch_values <
          ITERATE_KIT_AEC_TRACE_METADATA_WORDS * sizeof(uint32_t) /
              sizeof(int16_t)) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(capability, 0, sizeof(*capability));
  capability->trace = options->trace;
  capability->read_scratch = options->read_scratch;
  capability->read_scratch_values = options->read_scratch_values;
  capability->maximum_read_samples = options->maximum_read_samples;
  capability->initialized = 1U;
  return ITERATE_KIT_OK;
}

struct iterate_kit_module iterate_kit_aec_diagnostic_trace_module(
    struct iterate_kit_aec_diagnostic_trace_capability *capability) {
  static const struct iterate_kit_method methods[] = {
    {describe_path, 2U, describe_trace},
    {start_path, 2U, start_trace},
    {read_path, 2U, read_trace},
    {release_path, 2U, release_trace},
  };
  const struct iterate_kit_module module = {
    .methods = methods,
    .method_count = sizeof(methods) / sizeof(methods[0]),
    .context = capability,
    .poll = NULL,
    .close = NULL,
    .session_ended = NULL,
  };
  return module;
}
