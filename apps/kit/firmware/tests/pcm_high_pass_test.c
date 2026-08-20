#include "iterate/kit/pcm_high_pass.h"

#include <assert.h>
#include <stdint.h>
#include <string.h>

/*
 * DMA and WebSocket boundaries are scheduling details, not signal events. A
 * tempting stateless per-frame filter produces a fresh step response every
 * 8--20 ms, precisely the sort of phoneme damage that made a short greeting
 * reach Grok as unrelated words. The literals are independently worked from
 * y[n] = x[n] - x[n-1] + floor_toward_zero(31506*y[n-1]/32768); matching a
 * split call proves the public streaming contract, not an implementation
 * helper.
 */
static void preserves_filter_history_across_arbitrary_chunks(void) {
  const int16_t input[] = {
      0, 1000, 1000, 1000, -1000, -1000, 0, 32767, -32768, 0};
  const int16_t expected[] = {
      0, 1000, 961, 923, -1113, -1070, -28, 32741, -32768, 1262};
  int16_t one_call[sizeof(input) / sizeof(input[0])] = {0};
  int16_t split_calls[sizeof(input) / sizeof(input[0])] = {0};
  struct iterate_kit_pcm_high_pass contiguous;
  struct iterate_kit_pcm_high_pass split;

  assert(iterate_kit_pcm_high_pass_init(&contiguous, 31506U) ==
         ITERATE_KIT_OK);
  assert(iterate_kit_pcm_high_pass_init(&split, 31506U) == ITERATE_KIT_OK);
  assert(iterate_kit_pcm_high_pass_process(
             &contiguous,
             input,
             one_call,
             sizeof(input) / sizeof(input[0])) == ITERATE_KIT_OK);
  assert(iterate_kit_pcm_high_pass_process(
             &split, input, split_calls, 3U) == ITERATE_KIT_OK);
  assert(iterate_kit_pcm_high_pass_process(
             &split, input + 3U, split_calls + 3U, 2U) == ITERATE_KIT_OK);
  assert(iterate_kit_pcm_high_pass_process(
             &split, input + 5U, split_calls + 5U, 5U) == ITERATE_KIT_OK);
  assert(memcmp(one_call, expected, sizeof(expected)) == 0);
  assert(memcmp(split_calls, expected, sizeof(expected)) == 0);
  assert(contiguous.clipped_samples == 1U);
  assert(split.clipped_samples == 1U);
}

/*
 * A high-pass must remove a stationary offset rather than settling into a
 * fixed-point limit cycle. Five hundred samples are only 31.25 ms at 16 kHz,
 * so this also bounds startup/DC recovery without buffering any speech.
 */
static void constant_input_decays_to_zero_and_reset_forgets_the_epoch(void) {
  struct iterate_kit_pcm_high_pass filter;
  int16_t input[500];
  int16_t output[500];
  for (size_t index = 0U; index < 500U; ++index) {
    input[index] = 1000;
  }

  assert(iterate_kit_pcm_high_pass_init(&filter, 31506U) == ITERATE_KIT_OK);
  assert(iterate_kit_pcm_high_pass_process(
             &filter, input, output, 500U) == ITERATE_KIT_OK);
  assert(output[0] == 1000);
  assert(output[499] == 0);

  iterate_kit_pcm_high_pass_reset(&filter);
  assert(iterate_kit_pcm_high_pass_process(
             &filter, input, output, 1U) == ITERATE_KIT_OK);
  assert(output[0] == 1000);
}

/*
 * Invalid shape must be rejected before state changes. Silently accepting an
 * empty or aliased-null capture would make diagnostics claim continuous audio
 * after a driver/ownership defect.
 */
static void rejects_invalid_filter_shapes(void) {
  struct iterate_kit_pcm_high_pass filter;
  int16_t sample = 1;
  assert(iterate_kit_pcm_high_pass_init(NULL, 31506U) ==
         ITERATE_KIT_INVALID_ARGUMENT);
  assert(iterate_kit_pcm_high_pass_init(&filter, 0U) ==
         ITERATE_KIT_INVALID_ARGUMENT);
  assert(iterate_kit_pcm_high_pass_init(&filter, 32768U) ==
         ITERATE_KIT_INVALID_ARGUMENT);
  assert(iterate_kit_pcm_high_pass_init(&filter, 31506U) == ITERATE_KIT_OK);
  assert(iterate_kit_pcm_high_pass_process(NULL, &sample, &sample, 1U) ==
         ITERATE_KIT_INVALID_ARGUMENT);
  assert(iterate_kit_pcm_high_pass_process(
             &filter, NULL, &sample, 1U) == ITERATE_KIT_INVALID_ARGUMENT);
  assert(iterate_kit_pcm_high_pass_process(
             &filter, &sample, &sample, 0U) == ITERATE_KIT_INVALID_ARGUMENT);
}

int main(void) {
  preserves_filter_history_across_arbitrary_chunks();
  constant_input_decays_to_zero_and_reset_forgets_the_epoch();
  rejects_invalid_filter_shapes();
  return 0;
}
