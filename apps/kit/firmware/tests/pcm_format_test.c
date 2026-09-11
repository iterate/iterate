#include "iterate/kit/pcm_format.h"

#include <assert.h>
#include <limits.h>
#include <stddef.h>
#include <stdint.h>

/*
 * The userspace PCM lane deliberately stays mono PCM16 at 16 kHz on every
 * device.  The Voice Preview Edition's XMOS/AIC3204 playback clock is instead
 * fixed at stereo signed-32 at 48 kHz.  This test pins the conversion at the
 * hardware boundary so neither the portable lane nor userspace acquires a
 * device-specific resampler.
 *
 * Literal expected words matter here: recomputing the answer with another
 * loop would allow a shared channel-order, repetition, or bit-alignment bug to
 * make both sides of the assertion agree.  The two extrema also prove that
 * the 16-bit sample occupies the most-significant bits of the 32-bit I2S slot
 * without clipping or invoking a gain policy.
 */
static void interpolates_without_changing_the_hardware_contract(void) {
  const int16_t input[] = {0, 3000, 6000};
  int32_t output[18] = {0};
  size_t written = 0U;
  struct iterate_kit_pcm_playback_resampler resampler;
  iterate_kit_pcm_playback_resampler_reset(&resampler);

  assert(
      iterate_kit_pcm_expand_playback(
          &resampler,
          input,
          sizeof(input) / sizeof(input[0]),
          output,
          sizeof(output) / sizeof(output[0]),
          &written) == ITERATE_KIT_OK);
  assert(written == 18U);

  /*
   * One source-sample lookahead buys linear 3:1 interpolation with 62.5 us of
   * fixed latency and no heap/queue. The first sample primes the history; all
   * later triples walk exactly one source interval. Each value is duplicated
   * into left/right 32-bit I2S words, preserving the codec's native contract.
   */
  const int32_t expected[] = {
      0, 0, 0, 0, 0, 0,
      0, 0, 65536000, 65536000, 131072000, 131072000,
      196608000, 196608000, 262144000, 262144000,
      327680000, 327680000,
  };
  for (size_t index = 0U;
       index < sizeof(expected) / sizeof(expected[0]);
       ++index) {
    assert(output[index] == expected[index]);
  }
}

/*
 * Audio arrives in 10 ms lane edges, but those boundaries are transport
 * artefacts rather than acoustic discontinuities. Resetting interpolation on
 * every edge would create a periodic hold/jitter component even when every
 * frame is delivered. This split-vs-contiguous equality test therefore pins
 * the stateful seam that the physical playback owner must retain.
 */
static void preserves_interpolation_across_lane_edges(void) {
  const int16_t first[] = {-3000, 0};
  const int16_t second[] = {3000};
  const int16_t contiguous[] = {-3000, 0, 3000};
  int32_t split_output[18] = {0};
  int32_t contiguous_output[18] = {0};
  size_t first_written = 0U;
  size_t second_written = 0U;
  size_t contiguous_written = 0U;
  struct iterate_kit_pcm_playback_resampler split_resampler;
  struct iterate_kit_pcm_playback_resampler contiguous_resampler;
  iterate_kit_pcm_playback_resampler_reset(&split_resampler);
  iterate_kit_pcm_playback_resampler_reset(&contiguous_resampler);

  assert(
      iterate_kit_pcm_expand_playback(
          &split_resampler,
          first,
          sizeof(first) / sizeof(first[0]),
          split_output,
          sizeof(split_output) / sizeof(split_output[0]),
          &first_written) == ITERATE_KIT_OK);
  assert(
      iterate_kit_pcm_expand_playback(
          &split_resampler,
          second,
          sizeof(second) / sizeof(second[0]),
          split_output + first_written,
          sizeof(split_output) / sizeof(split_output[0]) - first_written,
          &second_written) == ITERATE_KIT_OK);
  assert(
      iterate_kit_pcm_expand_playback(
          &contiguous_resampler,
          contiguous,
          sizeof(contiguous) / sizeof(contiguous[0]),
          contiguous_output,
          sizeof(contiguous_output) / sizeof(contiguous_output[0]),
          &contiguous_written) == ITERATE_KIT_OK);

  assert(first_written + second_written == contiguous_written);
  for (size_t index = 0U; index < contiguous_written; ++index) {
    assert(split_output[index] == contiguous_output[index]);
  }
}

/*
 * XMOS emits two interleaved 32-bit channels: channel zero is the configured
 * cumulative DSP tap (currently AEC/IC/NS, deliberately before AGC), while
 * channel one is the original microphone before those stages. Keeping both at
 * this boundary makes the shipped uplink unambiguously channel zero and
 * preserves a simultaneous comparison signal without putting it on the
 * network. This format test pins channel ownership; the production assessor
 * uses exact same-window sums and explicit near-/far-end phases.
 */
/** A wire shape and literal words, with their expected portable channels. */
struct capture_case {
  struct iterate_kit_pcm_shape shape;
  int32_t input[18];
  size_t frames;
  int16_t processed[3];
  int16_t diagnostic[3];
  size_t becomes_count;
};

static void extracts_processed_and_non_aec_capture_channels(void) {
  const struct capture_case cases[] = {
    {{32, 2, 0, 1, 1},
     {0x12340000, 0x56780000, -65536, INT32_MIN, INT32_MAX, 0}, 3,
     {0x1234, -1, INT16_MAX}, {0x5678, INT16_MIN, 0}, 3},
    /* Distinct skipped words prove stride selection, not just repetition. */
    {{32, 2, 1, 0, 3},
     {0x12340000, 0x56780000, 1, 2, 3, 4,
      -65536, INT32_MIN, 5, 6, 7, 8,
      INT32_MAX, 0, 9, 10, 11, 12}, 9,
     {0x5678, INT16_MIN, 0}, {0x1234, -1, INT16_MAX}, 3},
  };
  for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
    int16_t processed[3] = {0};
    int16_t diagnostic[3] = {0};
    size_t written = 0U;
    assert(iterate_kit_pcm_extract_capture(
        &cases[i].shape, cases[i].input, cases[i].frames,
        1U, processed, diagnostic, 3U, &written, NULL) == ITERATE_KIT_OK);
    assert(written == cases[i].becomes_count);
    for (size_t j = 0; j < written; ++j) {
      assert(processed[j] == cases[i].processed[j]);
      assert(diagnostic[j] == cases[i].diagnostic[j]);
    }
  }
}

/** Shape validation and the native PCM16 path, without a diagnostic tap. */
static void validates_shapes_and_extracts_pcm16(void) {
  const int16_t input[] = {-32768, 0, 32767};
  const struct {
    struct iterate_kit_pcm_shape shape;
    size_t frames;
    size_t capacity;
    enum iterate_kit_status becomes_status;
    size_t becomes_count;
    int16_t becomes[3];
  } cases[] = {
    {{16, 1, 0, -1, 1}, 3, 3, ITERATE_KIT_OK, 3, {-32768, 0, 32767}},
    {{16, 1, 0, -1, 3}, 3, 3, ITERATE_KIT_OK, 1, {-32768}},
    {{16, 1, 0, -1, 3}, 2, 3, ITERATE_KIT_INVALID_ARGUMENT, 0, {0}},
    {{16, 1, 0, -1, 1}, 3, 2, ITERATE_KIT_LIMIT, 0, {0}},
    {{16, 1, 1, -1, 1}, 3, 3, ITERATE_KIT_INVALID_ARGUMENT, 0, {0}},
    {{16, 1, 0, 0, 1}, 3, 3, ITERATE_KIT_INVALID_ARGUMENT, 0, {0}},
    {{16, 1, 0, -1, 0}, 3, 3, ITERATE_KIT_INVALID_ARGUMENT, 0, {0}},
  };
  for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
    int16_t output[3] = {123, 123, 123};
    size_t written = 99;
    assert(iterate_kit_pcm_extract_capture(&cases[i].shape, input,
        cases[i].frames, 1U, output, NULL, cases[i].capacity, &written, NULL) ==
        cases[i].becomes_status);
    assert(written == cases[i].becomes_count);
    for (size_t j = 0; j < 3; ++j) {
      assert(output[j] == (j < written ? cases[i].becomes[j] : 123));
    }
  }
}

/*
 * Satellite1's processed XMOS plane can use only low Q31 bits. Scaling the
 * already-truncated PCM16 value turns those consonants into zero; scaling the
 * Q31 word first retains them. The raw tap remains a pre-gain observation,
 * and a saturated selected sample increments exactly once.
 */
static void capture_gain_preserves_q31_precision_before_pcm16(void) {
  const struct iterate_kit_pcm_shape shape = {32, 2, 0, 1, 1};
  const int32_t input[] = {
      2048, 0x12340000,
      -2048, -65536,
      0x7fff0000, 0x56780000,
      INT32_MIN, INT32_MIN,
  };
  int16_t processed[4] = {0};
  int16_t diagnostic[4] = {0};
  struct iterate_kit_pcm_capture_metrics metrics;
  size_t written = 0U;

  assert(iterate_kit_pcm_extract_capture(
      &shape, input, 4U, 64U, processed, diagnostic, 4U, &written,
      &metrics) == ITERATE_KIT_OK);
  assert(written == 4U);
  assert(processed[0] == 2);
  assert(processed[1] == -2);
  assert(processed[2] == INT16_MAX);
  assert(processed[3] == INT16_MIN);
  assert(diagnostic[0] == 0x1234);
  assert(diagnostic[1] == -1);
  assert(diagnostic[2] == 0x5678);
  assert(diagnostic[3] == INT16_MIN);
  assert(metrics.processed_peak == 32768U);
  assert(metrics.diagnostic_peak == 32768U);
  assert(metrics.processed_clipped == 2U);
}

/* Unity gain remains the prior bit-exact Q31 conversion, including its
 * defined floor behavior for negative values. */
static void capture_gain_one_preserves_q31_conversion(void) {
  const struct iterate_kit_pcm_shape shape = {32, 1, 0, -1, 1};
  const int32_t input[] = {0x1234ffff, -1, INT32_MIN, INT32_MAX};
  const int16_t expected[] = {0x1234, -1, INT16_MIN, INT16_MAX};
  int16_t processed[4] = {0};
  struct iterate_kit_pcm_capture_metrics metrics;
  size_t written = 0U;

  assert(iterate_kit_pcm_extract_capture(
      &shape, input, 4U, 1U, processed, NULL, 4U, &written,
      &metrics) == ITERATE_KIT_OK);
  assert(written == 4U);
  for (size_t index = 0U; index < written; ++index) {
    assert(processed[index] == expected[index]);
  }
  assert(metrics.processed_peak == 32768U);
  assert(metrics.diagnostic_peak == 0U);
  assert(metrics.processed_clipped == 0U);
}

/** Literal DMA sizes include HAVPE's two geometries and M5's stereo ring. */
static void wire_byte_counts(void) {
  const struct {
    struct iterate_kit_pcm_shape shape;
    size_t frames;
    size_t bytes;
  } cases[] = {
    {{32, 2, 0, -1, 3}, 480, 3840},
    {{32, 2, 0, 1, 1}, 320, 2560},
    {{16, 2, 0, -1, 1}, 320, 1280},
    {{16, 1, 0, -1, 1}, 240, 480},
    {{32, 2, 0, -1, 3}, 960, 7680},
    {{16, 1, 0, -1, 1}, SIZE_MAX, 0},
    {{16, 1, 0, -1, 1}, 0, 0},
    {{24, 2, 0, -1, 1}, 320, 0},
    {{16, 0, 0, -1, 1}, 320, 0},
    {{16, 1, 0, -1, 0}, 320, 0},
    {{16, 1, 1, -1, 1}, 320, 0},
    {{16, 1, 0, 1, 1}, 320, 0},
  };
  for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
    assert(iterate_kit_pcm_bytes_for_frames(&cases[i].shape, cases[i].frames) == cases[i].bytes);
  }
  assert(iterate_kit_pcm_bytes_for_frames(NULL, 320) == 0U);
}

/** Native mono/stereo expansion preserves extrema and repeats exactly one slot pair. */
static void playback_shapes(void) {
  const int16_t source[] = {INT16_MIN, INT16_MAX};
  const struct {
    struct iterate_kit_pcm_shape shape;
    size_t bytes;
    int16_t expected[12];
  } cases[] = {
    {{16, 1, 0, -1, 1}, 4, {INT16_MIN, INT16_MAX}},
    {{16, 2, 0, -1, 1}, 8, {INT16_MIN, INT16_MIN, INT16_MAX, INT16_MAX}},
    {{32, 1, 0, -1, 1}, 8, {INT16_MIN, INT16_MAX}},
    {{32, 2, 0, -1, 1}, 16, {INT16_MIN, INT16_MIN, INT16_MAX, INT16_MAX}},
    {{16, 1, 0, -1, 3}, 12, {INT16_MIN, INT16_MIN, INT16_MIN, INT16_MIN, -10923, 10922}},
  };
  for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
    union { int16_t pcm16[12]; int32_t pcm32[12]; } output = {0};
    struct iterate_kit_pcm_playback_resampler resampler = {0};
    size_t bytes = 99;
    assert(iterate_kit_pcm_expand_playback_shape(&cases[i].shape, &resampler,
        source, 2, &output, sizeof(output), &bytes) == ITERATE_KIT_OK);
    assert(bytes == cases[i].bytes);
    const size_t words = bytes / (cases[i].shape.bits / 8U);
    for (size_t j = 0; j < words; ++j) {
      if (cases[i].shape.bits == 16U) assert(output.pcm16[j] == cases[i].expected[j]);
      else assert(output.pcm32[j] == (int32_t)cases[i].expected[j] * 65536);
    }
    assert(iterate_kit_pcm_expand_playback_shape(&cases[i].shape, &resampler,
        source, 2, &output, bytes - 1U, &bytes) == ITERATE_KIT_LIMIT);
    assert(bytes == 0U);
  }
}

int main(void) {
  wire_byte_counts();
  playback_shapes();
  interpolates_without_changing_the_hardware_contract();
  preserves_interpolation_across_lane_edges();
  extracts_processed_and_non_aec_capture_channels();
  validates_shapes_and_extracts_pcm16();
  capture_gain_preserves_q31_precision_before_pcm16();
  capture_gain_one_preserves_q31_conversion();
  return 0;
}
