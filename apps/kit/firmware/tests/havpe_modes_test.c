#include "havpe_modes.h"

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
  static const uint8_t forward[] = {1U, 3U, 2U, 0U};
  static const uint8_t backward[] = {2U, 3U, 1U, 0U};
  static const uint8_t bounce[] = {1U, 1U, 0U, 1U, 0U, 1U, 0U};
  static const uint8_t jump[] = {3U, 0U, 3U, 0U};
  struct havpe_dial_decoder decoder;

  havpe_dial_decoder_init(&decoder, false, false);
  assert(feed(&decoder, forward, sizeof(forward)) == 2);
  assert(feed(&decoder, backward, sizeof(backward)) == -2);
  havpe_dial_decoder_init(&decoder, false, false);
  assert(feed(&decoder, bounce, sizeof(bounce)) == 0);
  assert(feed(&decoder, jump, sizeof(jump)) == 0);
}

int main(void) {
  dial_counts_only_unambiguous_quadrature();
  return 0;
}
