#include "voice_pe_pcm_format.h"

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
  struct iterate_kit_voice_pe_playback_resampler resampler;
  iterate_kit_voice_pe_playback_resampler_reset(&resampler);

  assert(
      iterate_kit_voice_pe_expand_playback(
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
  struct iterate_kit_voice_pe_playback_resampler split_resampler;
  struct iterate_kit_voice_pe_playback_resampler contiguous_resampler;
  iterate_kit_voice_pe_playback_resampler_reset(&split_resampler);
  iterate_kit_voice_pe_playback_resampler_reset(&contiguous_resampler);

  assert(
      iterate_kit_voice_pe_expand_playback(
          &split_resampler,
          first,
          sizeof(first) / sizeof(first[0]),
          split_output,
          sizeof(split_output) / sizeof(split_output[0]),
          &first_written) == ITERATE_KIT_OK);
  assert(
      iterate_kit_voice_pe_expand_playback(
          &split_resampler,
          second,
          sizeof(second) / sizeof(second[0]),
          split_output + first_written,
          sizeof(split_output) / sizeof(split_output[0]) - first_written,
          &second_written) == ITERATE_KIT_OK);
  assert(
      iterate_kit_voice_pe_expand_playback(
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
static void extracts_processed_and_non_aec_capture_channels(void) {
  const int32_t input[] = {
      0x12340000, 0x56780000,
      -65536, INT32_MIN,
      INT32_MAX, 0,
  };
  int16_t processed[3] = {0};
  int16_t non_aec[3] = {0};
  size_t written = 0U;

  assert(
      iterate_kit_voice_pe_extract_capture(
          input,
          3U,
          processed,
          non_aec,
          3U,
          &written) == ITERATE_KIT_OK);
  assert(written == 3U);
  assert(processed[0] == 0x1234);
  assert(processed[1] == -1);
  assert(processed[2] == INT16_MAX);
  assert(non_aec[0] == 0x5678);
  assert(non_aec[1] == INT16_MIN);
  assert(non_aec[2] == 0);
}

int main(void) {
  interpolates_without_changing_the_hardware_contract();
  preserves_interpolation_across_lane_edges();
  extracts_processed_and_non_aec_capture_channels();
  return 0;
}
