#include "havpe_dial.h"

#include <stddef.h>

void havpe_dial_decoder_init(
    struct havpe_dial_decoder *decoder, bool a, bool b) {
  decoder->last_levels = (uint8_t)(((a ? 1U : 0U) << 1) | (b ? 1U : 0U));
  decoder->quarter_steps = 0;
}

int havpe_dial_decoder_step(
    struct havpe_dial_decoder *decoder, bool a, bool b) {
  /*
   * Indexed by (previous levels << 2) | current levels. Adjacent Gray-code
   * transitions are +-1 quarter cycle; no-change and the two ambiguous
   * double-jumps are 0. A (GPIO16) leading B (GPIO18) is clockwise on HAVPE
   * and increases volume, matching the official firmware's encoder mapping.
   */
  static const int8_t quarter[16] = {
    0, -1, +1, 0,
    +1, 0, 0, -1,
    -1, 0, 0, +1,
    0, +1, -1, 0,
  };
  const uint8_t levels = (uint8_t)(((a ? 1U : 0U) << 1) | (b ? 1U : 0U));
  const int8_t moved =
      quarter[(uint8_t)((decoder->last_levels << 2) | levels)];
  decoder->last_levels = levels;
  if (moved == 0) return 0;
  decoder->quarter_steps = (int8_t)(decoder->quarter_steps + moved);
  /* Two quarters per count: the official firmware's `resolution: 2`. */
  if (decoder->quarter_steps >= 2) {
    decoder->quarter_steps = 0;
    return 1;
  }
  if (decoder->quarter_steps <= -2) {
    decoder->quarter_steps = 0;
    return -1;
  }
  return 0;
}
