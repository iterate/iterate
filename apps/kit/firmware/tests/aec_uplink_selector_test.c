#include "iterate/kit/aec_uplink_selector.h"

#include <assert.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>

enum { frame_samples = 8 };

/*
 * This is the regression for the physical failure a person observed as
 * “hey pal” becoming a delayed nonsense reply. Retained device metrics proved
 * near-only raw speech around 4,600--5,000 mean absolute was reduced to
 * 70--360 by the VOIP residual suppressor despite an exactly-zero reference.
 * The only lossless answer in that state is the raw microphone itself.
 */
static void silent_far_end_preserves_raw_near_speech(void) {
  struct iterate_kit_aec_uplink_selector selector;
  assert(iterate_kit_aec_uplink_selector_init(
             &selector,
             ITERATE_KIT_AEC_UPLINK_PLAYBACK_SWITCHED,
             2U,
             4U,
             8U) == ITERATE_KIT_OK);
  const int16_t near[frame_samples] = {100, -200, 300, -400, 500, -600, 700, -800};
  const int16_t playout[frame_samples] = {0};
  const int16_t over_suppressed[frame_samples] = {1, -2, 3, -4, 5, -6, 7, -8};
  int16_t output[frame_samples] = {0};

  assert(iterate_kit_aec_uplink_selector_process(
             &selector, near, playout, over_suppressed, output, frame_samples) ==
         ITERATE_KIT_OK);
  for (size_t index = 0U; index < frame_samples; ++index) {
    assert(output[index] == near[index] * 4);
  }
  assert(selector.raw_frames == 1U);
  assert(selector.processed_frames == 0U);
}

/*
 * The raw bypass must never become the speaker-active gate that prior evidence
 * rejected. When far-end speech exists, output is still the AEC result, and a
 * simultaneous nearby talker remains non-zero after the calibrated gain.
 */
static void far_end_and_double_talk_use_processed_audio(void) {
  struct iterate_kit_aec_uplink_selector selector;
  assert(iterate_kit_aec_uplink_selector_init(
             &selector,
             ITERATE_KIT_AEC_UPLINK_PLAYBACK_SWITCHED,
             2U,
             4U,
             8U) == ITERATE_KIT_OK);
  const int16_t near[frame_samples] = {9000, -9000, 8000, -8000, 0, 0, 0, 0};
  const int16_t playout[frame_samples] = {1, 0, 0, 0, 0, 0, 0, 0};
  const int16_t processed[frame_samples] = {100, -200, 300, -400, 5000, -5000, 0, 1};
  int16_t output[frame_samples] = {0};

  assert(iterate_kit_aec_uplink_selector_process(
             &selector, near, playout, processed, output, frame_samples) ==
         ITERATE_KIT_OK);
  assert(output[0] == 800);
  assert(output[1] == -1600);
  assert(output[2] == 2400);
  assert(output[3] == -3200);
  assert(output[4] == INT16_MAX);
  assert(output[5] == INT16_MIN);
  assert(output[7] == 8);
  assert(selector.raw_frames == 0U);
  assert(selector.processed_frames == 1U);
  assert(selector.clipped_samples == 2U);
}

/*
 * Digital playback can stop before the loudspeaker/enclosure acoustic tail
 * reaches the mic. Two test frames stand in for the board's configured tail:
 * both must remain AEC-protected, then raw speech may resume. This prevents a
 * clean provider response ending from leaking its last phoneme back to VAD.
 */
static void hangover_covers_the_far_end_acoustic_tail(void) {
  struct iterate_kit_aec_uplink_selector selector;
  assert(iterate_kit_aec_uplink_selector_init(
             &selector,
             ITERATE_KIT_AEC_UPLINK_PLAYBACK_SWITCHED,
             2U,
             3U,
             2U) == ITERATE_KIT_OK);
  const int16_t near[frame_samples] = {100, 100, 100, 100, 100, 100, 100, 100};
  int16_t playout[frame_samples] = {1, 0, 0, 0, 0, 0, 0, 0};
  const int16_t processed[frame_samples] = {3, 3, 3, 3, 3, 3, 3, 3};
  int16_t output[frame_samples] = {0};

  assert(iterate_kit_aec_uplink_selector_process(
             &selector, near, playout, processed, output, frame_samples) ==
         ITERATE_KIT_OK);
  playout[0] = 0;
  for (size_t frame = 0U; frame < 2U; ++frame) {
    assert(iterate_kit_aec_uplink_selector_process(
               &selector, near, playout, processed, output, frame_samples) ==
           ITERATE_KIT_OK);
    assert(output[0] == 6);
  }
  assert(iterate_kit_aec_uplink_selector_process(
             &selector, near, playout, processed, output, frame_samples) ==
         ITERATE_KIT_OK);
  assert(output[0] == near[0] * 3);
  assert(selector.processed_frames == 3U);
  assert(selector.raw_frames == 1U);
}

/*
 * The FD experiment is valuable only if it removes the two-contract edge, not
 * merely swaps an ESP-SR enum underneath the old selector. A silent activity
 * mask must therefore still publish the processed result at the exact same
 * gain. The raw input is intentionally very different so this test catches an
 * accidental return of the measured VOIP workaround.
 */
static void constant_policy_never_switches_back_to_raw_audio(void) {
  struct iterate_kit_aec_uplink_selector selector;
  assert(iterate_kit_aec_uplink_selector_init(
             &selector,
             ITERATE_KIT_AEC_UPLINK_CONSTANT_PROCESSED,
             0U,
             6U,
             8U) == ITERATE_KIT_OK);
  const int16_t near[frame_samples] = {1000, -1000, 500, -500, 0, 0, 0, 0};
  const int16_t inactive[frame_samples] = {0};
  const int16_t processed[frame_samples] = {1, -2, 3, -4, 5, -6, 7, -8};
  int16_t output[frame_samples] = {0};

  assert(iterate_kit_aec_uplink_selector_process(
             &selector, near, inactive, processed, output, frame_samples) ==
         ITERATE_KIT_OK);
  for (size_t index = 0U; index < frame_samples; ++index) {
    assert(output[index] == processed[index] * 8);
  }
  assert(selector.raw_frames == 0U);
  assert(selector.processed_frames == 1U);
}

int main(void) {
  silent_far_end_preserves_raw_near_speech();
  far_end_and_double_talk_use_processed_audio();
  hangover_covers_the_far_end_acoustic_tail();
  constant_policy_never_switches_back_to_raw_audio();
  puts("aec uplink selector tests passed");
  return 0;
}
