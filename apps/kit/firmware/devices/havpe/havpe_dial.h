#ifndef ITERATE_KIT_HAVPE_DIAL_H
#define ITERATE_KIT_HAVPE_DIAL_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* The rotary encoder's pure quadrature decoder.
 *
 * The official firmware reads this encoder with ESPHome's interrupt-driven
 * state machine at `resolution: 2` — two counts per full A/B cycle. This is
 * the same arithmetic fed by polling instead of edges: the app loop samples
 * the two pins every pass (~5 ms), which tracks a human hand comfortably,
 * and a violent spin that outruns the sampling merely loses counts rather
 * than inventing them, because only adjacent Gray-code transitions count.
 */

struct havpe_dial_decoder {
  /** Previous sampled levels: bit 1 = A, bit 0 = B. */
  uint8_t last_levels;
  /** Quarter-cycle transitions accumulated toward the next count. */
  int8_t quarter_steps;
};

void havpe_dial_decoder_init(
    struct havpe_dial_decoder *decoder, bool a, bool b);

/**
 * Feed one sample of the two pins; returns -1, 0 or +1 counts.
 *
 * A count fires every TWO valid quarter-cycle transitions, matching the
 * official `resolution: 2`. A sample identical to the last is free, and an
 * illegal jump (both pins changed — the sampler missed a state) contributes
 * nothing in either direction.
 */
int havpe_dial_decoder_step(
    struct havpe_dial_decoder *decoder, bool a, bool b);

#ifdef __cplusplus
}
#endif

#endif
