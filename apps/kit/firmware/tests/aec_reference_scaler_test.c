#include "iterate/kit/aec_reference_scaler.h"

#include <assert.h>
#include <stdint.h>

/*
 * StackChan's electrical loudspeaker divider is deliberately below the mic
 * level, while ESP-SR expects playback-scale reference samples. A plain C
 * multiplication in the board driver would be easy to wrap at the rails and
 * would make a rare loud sample poison the adaptive filter. This test fixes
 * the exact saturating contract before the board consumes it.
 */
static void scales_without_wrapping_at_either_rail(void) {
  const int16_t input[] = {0, 1, -1, 1549, -1549, 4096, -4096, 32767, -32768};
  int16_t output[sizeof(input) / sizeof(input[0])] = {0};
  uint64_t clipped_samples = 0U;

  assert(iterate_kit_aec_reference_scale(
             input,
             output,
             sizeof(input) / sizeof(input[0]),
             8U,
             &clipped_samples) == ITERATE_KIT_OK);
  assert(output[0] == 0);
  assert(output[1] == 8);
  assert(output[2] == -8);
  assert(output[3] == 12392);
  assert(output[4] == -12392);
  assert(output[5] == INT16_MAX);
  assert(output[6] == INT16_MIN);
  assert(output[7] == INT16_MAX);
  assert(output[8] == INT16_MIN);
  /* -4096 * 8 is exactly INT16_MIN and therefore is not a lost sample. */
  assert(clipped_samples == 3U);
}

static void rejects_shapes_that_cannot_describe_audio(void) {
  int16_t sample = 1;
  uint64_t clipped_samples = 0U;
  assert(iterate_kit_aec_reference_scale(
             NULL, &sample, 1U, 8U, &clipped_samples) ==
         ITERATE_KIT_INVALID_ARGUMENT);
  assert(iterate_kit_aec_reference_scale(
             &sample, &sample, 0U, 8U, &clipped_samples) ==
         ITERATE_KIT_INVALID_ARGUMENT);
  assert(iterate_kit_aec_reference_scale(
             &sample, &sample, 1U, 0U, &clipped_samples) ==
         ITERATE_KIT_INVALID_ARGUMENT);
}

int main(void) {
  scales_without_wrapping_at_either_rail();
  rejects_shapes_that_cannot_describe_audio();
  return 0;
}
