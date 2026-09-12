#include "havpe_dial.h"

#include <assert.h>
#include <stddef.h>

static int feed(
    struct havpe_dial_decoder *decoder, const uint8_t *levels, size_t count) {
  int total = 0;
  for (size_t index = 0U; index < count; ++index) {
    total += havpe_dial_decoder_step(
        decoder, (levels[index] & 2U) != 0U, (levels[index] & 1U) != 0U);
  }
  return total;
}

static void dial_counts_only_unambiguous_quadrature(void) {
  /* HAVPE GPIO16=A, GPIO18=B: A leading B is clockwise, matching the
   * official firmware's rotary encoder and volume-up callback. */
  static const uint8_t clockwise[] = {2U, 3U, 1U, 0U};
  static const uint8_t anticlockwise[] = {1U, 3U, 2U, 0U};
  static const uint8_t clockwise_from_high[] = {1U, 0U, 2U, 3U};
  static const uint8_t anticlockwise_from_high[] = {2U, 0U, 1U, 3U};
  static const uint8_t bounce[] = {1U, 1U, 0U, 1U, 0U, 1U, 0U};
  static const uint8_t jump[] = {3U, 0U, 3U, 0U};
  struct havpe_dial_decoder decoder;

  havpe_dial_decoder_init(&decoder, false, false);
  assert(feed(&decoder, clockwise, sizeof(clockwise)) == 2);
  assert(feed(&decoder, anticlockwise, sizeof(anticlockwise)) == -2);
  havpe_dial_decoder_init(&decoder, true, true);
  assert(feed(&decoder, clockwise_from_high, sizeof(clockwise_from_high)) == 2);
  assert(feed(&decoder, anticlockwise_from_high, sizeof(anticlockwise_from_high)) == -2);
  havpe_dial_decoder_init(&decoder, false, false);
  assert(feed(&decoder, bounce, sizeof(bounce)) == 0);
  assert(feed(&decoder, jump, sizeof(jump)) == 0);
}

int main(void) {
  dial_counts_only_unambiguous_quadrature();
  return 0;
}
