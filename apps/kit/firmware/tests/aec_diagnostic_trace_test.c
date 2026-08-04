#include "iterate/kit/aec_diagnostic_trace.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

static void test_assert(
    bool condition,
    const char *expression,
    const char *file,
    int line) {
  if (condition) {
    return;
  }
  fprintf(stderr, "%s:%d: assertion failed: %s\n", file, line, expression);
  abort();
}

#define TEST_ASSERT(expression) \
  test_assert((expression), #expression, __FILE__, __LINE__)

enum {
  frame_samples = 4,
  capture_samples = 8,
};

struct fixture {
  struct iterate_kit_aec_diagnostic_trace trace;
  int16_t near[capture_samples];
  int16_t reference[capture_samples];
  int16_t playout[capture_samples];
  int16_t linear[capture_samples];
  int16_t clean[capture_samples];
};

#define ALL_TRACE_PLANES ( \
    ITERATE_KIT_AEC_DIAGNOSTIC_PLANE_NEAR | \
    ITERATE_KIT_AEC_DIAGNOSTIC_PLANE_REFERENCE | \
    ITERATE_KIT_AEC_DIAGNOSTIC_PLANE_PLAYOUT | \
    ITERATE_KIT_AEC_DIAGNOSTIC_PLANE_LINEAR | \
    ITERATE_KIT_AEC_DIAGNOSTIC_PLANE_CLEAN)

static void initialise(struct fixture *fixture) {
  const struct iterate_kit_aec_diagnostic_trace_options options = {
    .sample_rate_hz = 16000U,
    .frame_samples = frame_samples,
    .capture_samples = capture_samples,
    .available_planes = ALL_TRACE_PLANES,
    .near_samples = fixture->near,
    .reference_samples = fixture->reference,
    .playout_samples = fixture->playout,
    .linear_samples = fixture->linear,
    .clean_samples = fixture->clean,
  };
  TEST_ASSERT(
      iterate_kit_aec_diagnostic_trace_init(&fixture->trace, &options) ==
      ITERATE_KIT_OK);
}

/*
 * Five semantic names are useful only if they own five independent planes.
 * Accidentally pointing completed-DMA playout at the electrical-reference
 * array would make every later comparison report perfect agreement while
 * erasing the very hardware mismatch this trace exists to detect. Reject that
 * configuration once at initialization, outside the realtime record path.
 */
static void electrical_and_playout_references_cannot_alias(void) {
  struct fixture fixture = {0};
  const struct iterate_kit_aec_diagnostic_trace_options options = {
    .sample_rate_hz = 16000U,
    .frame_samples = frame_samples,
    .capture_samples = capture_samples,
    .available_planes = ALL_TRACE_PLANES,
    .near_samples = fixture.near,
    .reference_samples = fixture.reference,
    .playout_samples = fixture.reference,
    .linear_samples = fixture.linear,
    .clean_samples = fixture.clean,
  };

  TEST_ASSERT(
      iterate_kit_aec_diagnostic_trace_init(
          &fixture.trace, &options) == ITERATE_KIT_INVALID_ARGUMENT);
}

/*
 * HAVPE exposes simultaneous raw and XMOS-clean taps but not the XMOS-private
 * electrical reference. Requiring five fake pointers would waste RAM and,
 * worse, encourage a target to label intended downlink or zeros as measured
 * hardware. The trace must retain only truthful planes while keeping a stable
 * five-plane read layout whose absent channels are explicitly zero-filled.
 */
static void unavailable_hardware_planes_are_explicit_not_fabricated(void) {
  struct iterate_kit_aec_diagnostic_trace trace;
  int16_t near[capture_samples] = {0};
  int16_t clean[capture_samples] = {0};
  int16_t planar[capture_samples * 5U] = {0};
  const int16_t near_frame[frame_samples] = {1, 2, 3, 4};
  const int16_t clean_frame[frame_samples] = {5, 6, 7, 8};
  const struct iterate_kit_aec_diagnostic_trace_options options = {
    .sample_rate_hz = 16000U,
    .frame_samples = frame_samples,
    .capture_samples = frame_samples,
    .available_planes =
        ITERATE_KIT_AEC_DIAGNOSTIC_PLANE_NEAR |
        ITERATE_KIT_AEC_DIAGNOSTIC_PLANE_CLEAN,
    .near_samples = near,
    .clean_samples = clean,
  };
  struct iterate_kit_aec_diagnostic_trace_snapshot snapshot;
  uint32_t generation = 0U;

  TEST_ASSERT(
      iterate_kit_aec_diagnostic_trace_init(&trace, &options) ==
      ITERATE_KIT_OK);
  TEST_ASSERT(
      iterate_kit_aec_diagnostic_trace_start(&trace, &generation) ==
      ITERATE_KIT_OK);
  TEST_ASSERT(
      iterate_kit_aec_diagnostic_trace_record(
          &trace,
          9U,
          near_frame,
          NULL,
          NULL,
          NULL,
          clean_frame,
          frame_samples) == ITERATE_KIT_OK);
  iterate_kit_aec_diagnostic_trace_snapshot(&trace, &snapshot);
  TEST_ASSERT(
      snapshot.available_planes ==
      (ITERATE_KIT_AEC_DIAGNOSTIC_PLANE_NEAR |
       ITERATE_KIT_AEC_DIAGNOSTIC_PLANE_CLEAN));
  TEST_ASSERT(
      iterate_kit_aec_diagnostic_trace_read_planar(
          &trace,
          0U,
          frame_samples,
          planar,
          sizeof(planar) / sizeof(planar[0])) == ITERATE_KIT_OK);
  for (size_t index = 0U; index < frame_samples; ++index) {
    TEST_ASSERT(planar[index] == near_frame[index]);
    TEST_ASSERT(planar[frame_samples + index] == 0);
    TEST_ASSERT(planar[frame_samples * 2U + index] == 0);
    TEST_ASSERT(planar[frame_samples * 3U + index] == 0);
    TEST_ASSERT(planar[frame_samples * 4U + index] == clean_frame[index]);
  }
}

/*
 * Diagnostics must be effectively absent from the steady-state audio path.
 * If an idle observer copied samples, a feature intended to diagnose timing
 * could itself consume memory bandwidth on every 32 ms AEC deadline. Pin the
 * public inactive result and prove all caller-owned storage remains untouched.
 */
static void idle_trace_does_not_touch_audio_or_storage(void) {
  struct fixture fixture = {0};
  const int16_t near[frame_samples] = {1, 2, 3, 4};
  const int16_t reference[frame_samples] = {5, 6, 7, 8};
  const int16_t playout[frame_samples] = {17, 18, 19, 20};
  const int16_t linear[frame_samples] = {9, 10, 11, 12};
  const int16_t clean[frame_samples] = {13, 14, 15, 16};
  struct iterate_kit_aec_diagnostic_trace_snapshot snapshot;
  initialise(&fixture);

  TEST_ASSERT(
      iterate_kit_aec_diagnostic_trace_record(
          &fixture.trace,
          7U,
          near,
          reference,
          playout,
          linear,
          clean,
          frame_samples) == ITERATE_KIT_UNAVAILABLE);
  iterate_kit_aec_diagnostic_trace_snapshot(&fixture.trace, &snapshot);
  TEST_ASSERT(snapshot.state == ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_IDLE);
  TEST_ASSERT(snapshot.captured_samples == 0U);
  for (size_t index = 0U; index < capture_samples; ++index) {
    TEST_ASSERT(fixture.near[index] == 0);
    TEST_ASSERT(fixture.reference[index] == 0);
    TEST_ASSERT(fixture.playout[index] == 0);
    TEST_ASSERT(fixture.linear[index] == 0);
    TEST_ASSERT(fixture.clean[index] == 0);
  }
}

/*
 * The diagnostic oracle is useful only if all five taps describe the same DSP
 * instants. In particular, confusing the electrical divider with the exact
 * PCM which completed speaker DMA would make a lag or gain diagnosis look
 * plausible while tuning the wrong signal. Complete two small frames and
 * assert a literal planar payload so a future refactor cannot rotate channels,
 * overwrite the first frame, or publish READY before every copy is visible.
 */
static void armed_trace_publishes_one_exact_read_only_generation(void) {
  struct fixture fixture = {0};
  const int16_t near_a[frame_samples] = {1, 2, 3, 4};
  const int16_t reference_a[frame_samples] = {11, 12, 13, 14};
  const int16_t playout_a[frame_samples] = {41, 42, 43, 44};
  const int16_t linear_a[frame_samples] = {21, 22, 23, 24};
  const int16_t clean_a[frame_samples] = {31, 32, 33, 34};
  const int16_t near_b[frame_samples] = {5, 6, 7, 8};
  const int16_t reference_b[frame_samples] = {15, 16, 17, 18};
  const int16_t playout_b[frame_samples] = {45, 46, 47, 48};
  const int16_t linear_b[frame_samples] = {25, 26, 27, 28};
  const int16_t clean_b[frame_samples] = {35, 36, 37, 38};
  const int16_t expected[] = {
    1, 2, 3, 4, 5, 6, 7, 8,
    11, 12, 13, 14, 15, 16, 17, 18,
    41, 42, 43, 44, 45, 46, 47, 48,
    21, 22, 23, 24, 25, 26, 27, 28,
    31, 32, 33, 34, 35, 36, 37, 38,
  };
  int16_t actual[sizeof(expected) / sizeof(expected[0])] = {0};
  struct iterate_kit_aec_diagnostic_trace_snapshot snapshot;
  uint32_t generation = 0U;
  initialise(&fixture);

  TEST_ASSERT(
      iterate_kit_aec_diagnostic_trace_start(
          &fixture.trace, &generation) == ITERATE_KIT_OK);
  TEST_ASSERT(generation == 1U);
  TEST_ASSERT(
      iterate_kit_aec_diagnostic_trace_record(
          &fixture.trace,
          41U,
          near_a,
          reference_a,
          playout_a,
          linear_a,
          clean_a,
          frame_samples) == ITERATE_KIT_OK);
  iterate_kit_aec_diagnostic_trace_snapshot(&fixture.trace, &snapshot);
  TEST_ASSERT(
      snapshot.state == ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_CAPTURING);
  TEST_ASSERT(snapshot.captured_samples == frame_samples);

  TEST_ASSERT(
      iterate_kit_aec_diagnostic_trace_record(
          &fixture.trace,
          42U,
          near_b,
          reference_b,
          playout_b,
          linear_b,
          clean_b,
          frame_samples) == ITERATE_KIT_OK);
  iterate_kit_aec_diagnostic_trace_snapshot(&fixture.trace, &snapshot);
  TEST_ASSERT(snapshot.state == ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_READY);
  TEST_ASSERT(snapshot.first_frame_sequence == 41U);
  TEST_ASSERT(snapshot.last_frame_sequence == 42U);
  TEST_ASSERT(snapshot.captured_samples == capture_samples);
  TEST_ASSERT(snapshot.captures_started == 1U);
  TEST_ASSERT(snapshot.captures_completed == 1U);
  TEST_ASSERT(
      iterate_kit_aec_diagnostic_trace_start(
          &fixture.trace, &generation) == ITERATE_KIT_BACKPRESSURE);
  TEST_ASSERT(
      iterate_kit_aec_diagnostic_trace_read_planar(
          &fixture.trace,
          0U,
          capture_samples,
          actual,
          sizeof(actual) / sizeof(actual[0])) == ITERATE_KIT_OK);
  for (size_t index = 0U;
       index < sizeof(expected) / sizeof(expected[0]);
       ++index) {
    TEST_ASSERT(actual[index] == expected[index]);
  }
}

/*
 * A DMA overrun or codec restart breaks the acoustic timeline. Retaining the
 * prefix and appending post-reset samples would make host correlation return a
 * plausible but false lag. Abort must freeze that failed generation for
 * diagnostics, forbid reads as complete evidence, and require an explicit
 * release before the next generation starts cleanly.
 */
static void discontinuity_aborts_without_reusing_a_partial_generation(void) {
  struct fixture fixture = {0};
  const int16_t near[frame_samples] = {1, 2, 3, 4};
  const int16_t reference[frame_samples] = {5, 6, 7, 8};
  const int16_t playout[frame_samples] = {17, 18, 19, 20};
  const int16_t linear[frame_samples] = {9, 10, 11, 12};
  const int16_t clean[frame_samples] = {13, 14, 15, 16};
  int16_t destination[frame_samples * 5U] = {0};
  struct iterate_kit_aec_diagnostic_trace_snapshot snapshot;
  uint32_t generation = 0U;
  initialise(&fixture);

  TEST_ASSERT(
      iterate_kit_aec_diagnostic_trace_start(
          &fixture.trace, &generation) == ITERATE_KIT_OK);
  TEST_ASSERT(
      iterate_kit_aec_diagnostic_trace_record(
          &fixture.trace,
          100U,
          near,
          reference,
          playout,
          linear,
          clean,
          frame_samples) == ITERATE_KIT_OK);
  TEST_ASSERT(
      iterate_kit_aec_diagnostic_trace_abort(&fixture.trace) ==
      ITERATE_KIT_OK);
  iterate_kit_aec_diagnostic_trace_snapshot(&fixture.trace, &snapshot);
  TEST_ASSERT(snapshot.state == ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_ABORTED);
  TEST_ASSERT(snapshot.captured_samples == frame_samples);
  TEST_ASSERT(snapshot.captures_aborted == 1U);
  TEST_ASSERT(
      iterate_kit_aec_diagnostic_trace_read_planar(
          &fixture.trace,
          0U,
          frame_samples,
          destination,
          sizeof(destination) / sizeof(destination[0])) ==
      ITERATE_KIT_UNAVAILABLE);
  TEST_ASSERT(
      iterate_kit_aec_diagnostic_trace_start(
          &fixture.trace, &generation) == ITERATE_KIT_BACKPRESSURE);
  TEST_ASSERT(
      iterate_kit_aec_diagnostic_trace_release(&fixture.trace) ==
      ITERATE_KIT_OK);
  TEST_ASSERT(
      iterate_kit_aec_diagnostic_trace_start(
          &fixture.trace, &generation) == ITERATE_KIT_OK);
  TEST_ASSERT(generation == 2U);
  iterate_kit_aec_diagnostic_trace_snapshot(&fixture.trace, &snapshot);
  TEST_ASSERT(snapshot.state == ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_ARMED);
  TEST_ASSERT(snapshot.captured_samples == 0U);
}

int main(void) {
  electrical_and_playout_references_cannot_alias();
  unavailable_hardware_planes_are_explicit_not_fabricated();
  idle_trace_does_not_touch_audio_or_storage();
  armed_trace_publishes_one_exact_read_only_generation();
  discontinuity_aborts_without_reusing_a_partial_generation();
  return 0;
}
