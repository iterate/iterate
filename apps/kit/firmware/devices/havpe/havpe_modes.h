#ifndef ITERATE_KIT_HAVPE_MODES_H
#define ITERATE_KIT_HAVPE_MODES_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * The dial's four conversation modes and the wheel arithmetic behind them.
 * What the centre button MEANS is the shared session grammar's
 * (iterate/kit/session_grammar.h); this board only classifies its gestures
 * and picks the posture the adopted mode dictates.
 *
 * Pure C99 with no hardware includes, like voice_pe_hardware_config: the mode
 * table is a WIRE CONTRACT — each entry names a stream whose far end is
 * already configured for exactly that provider and turn policy — so the table
 * and the decoder stay host-testable, and a drifted path or a miscounted
 * detent is a failing host test rather than a board that dials a provider
 * expecting turns nobody marks.
 */

/**
 * One position of the dial, in the order the wheel walks them.
 *
 * The order is also the index into `havpe_mode_sounds` in the generated
 * assets: announcement N says mode N's name, so reordering here without
 * regenerating the sounds makes the device announce the wrong mode with
 * total confidence.
 */
enum havpe_mode {
  HAVPE_MODE_GROK_PUSH_TO_TALK = 0,
  HAVPE_MODE_GROK_OPEN_MIC,
  HAVPE_MODE_OPENAI_PUSH_TO_TALK,
  /** The board's factory default; its path is `facts.stream_path`. */
  HAVPE_MODE_OPENAI_OPEN_MIC,
  HAVPE_MODE_COUNT,
};

enum {
  /**
   * Dial quiet after which a spin settles on the mode it shows. A fast spin
   * crosses a detent every few tens of milliseconds, so this lands one
   * announcement on the final mode instead of stuttering through all four;
   * a deliberate single click still answers well under half a second later.
   */
  HAVPE_MODE_SETTLE_MS = 400,
};

/** The conversation stream a mode dials. NULL for an out-of-range mode. */
const char *havpe_mode_stream_path(uint8_t mode);

/** Whether this mode's microphone streams only while the button is held. */
bool havpe_mode_push_to_talk(uint8_t mode);

/* --- the dial's quadrature decoder ----------------------------------------
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

/* --- the mode wheel -------------------------------------------------------
 *
 * The spin-then-settle policy: counts move the SHOWN mode immediately (the
 * ring follows the finger), and the shown mode is only ADOPTED — announced,
 * dialled, persisted — once the dial has been quiet for HAVPE_MODE_SETTLE_MS.
 */

struct havpe_mode_wheel {
  /** What the ring shows while the finger is on the dial. */
  uint8_t shown;
  /** The last adopted mode; what `shown` snaps back to on cancel. */
  uint8_t settled;
  bool spinning;
  uint64_t last_turn_ms;
};

void havpe_mode_wheel_init(struct havpe_mode_wheel *wheel, uint8_t mode);

/** Advance the shown mode by `steps` detents (either sign), wrapping. */
void havpe_mode_wheel_turn(
    struct havpe_mode_wheel *wheel, int steps, uint64_t now_ms);

/**
 * Abandon an unsettled spin: the shown mode snaps back to the settled one.
 *
 * For the pass on which a call starts with a spin still pending — adopting a
 * new conversation underneath a call being placed would strand the call, and
 * holding the spin until the call ends would change the mode minutes later
 * as a complete surprise. Neither; the spin just did not happen.
 */
void havpe_mode_wheel_cancel(struct havpe_mode_wheel *wheel);

/**
 * True at most once per spin: the dial has been quiet long enough.
 *
 * `*mode` is the mode to adopt. Fires even when the spin lands back on the
 * mode it started from — the person asked where the dial is, and the
 * announcement is the answer; callers skip the persistence, not the reply.
 */
bool havpe_mode_wheel_take_settled(
    struct havpe_mode_wheel *wheel, uint64_t now_ms, uint8_t *mode);

#ifdef __cplusplus
}
#endif

#endif
