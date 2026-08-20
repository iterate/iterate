/*
 * The dial's mode table and wheel arithmetic. Pure — see havpe_modes.h. The
 * session grammar the centre button speaks is the shared machine in
 * components/core (iterate/kit/session_grammar.h).
 */
#include "havpe_modes.h"

#include <stddef.h>

/*
 * THE MODE TABLE IS HALF OF A CONTRACT WHOSE OTHER HALF LIVES SERVER-SIDE.
 *
 * Each path names a stream that is already configured for that provider and
 * that turn policy; the board contributes only which one it dials and whether
 * its own microphone gate matches. Keeping path and posture in ONE row is the
 * whole safety: a board that dialled a VAD stream in a push-to-talk posture
 * would present the provider a mic that only opens under a button it never
 * asks for, and the reverse commits turns a server VAD owns. As long as this
 * table is edited a row at a time, the two cannot disagree.
 */
static const struct {
  const char *stream_path;
  bool push_to_talk;
} modes[HAVPE_MODE_COUNT] = {
  [HAVPE_MODE_GROK_PUSH_TO_TALK] = {"/agents/voice/havpe-grok-ptt", true},
  [HAVPE_MODE_GROK_OPEN_MIC] = {"/agents/voice/havpe-grok-vad", false},
  [HAVPE_MODE_OPENAI_PUSH_TO_TALK] = {"/agents/voice/havpe-openai-ptt", true},
  /* The factory default; must stay equal to `facts.stream_path` in
   * havpe_device.c, which the host test pins as a literal. */
  [HAVPE_MODE_OPENAI_OPEN_MIC] =
      {"/agents/voice/home-assistant-voice-preview-edition", false},
};

const char *havpe_mode_stream_path(uint8_t mode) {
  return mode < HAVPE_MODE_COUNT ? modes[mode].stream_path : NULL;
}

bool havpe_mode_push_to_talk(uint8_t mode) {
  return mode < HAVPE_MODE_COUNT && modes[mode].push_to_talk;
}

/* --- quadrature ----------------------------------------------------------- */

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
   * double-jumps are 0. The sign convention makes B leading A positive;
   * whether that is clockwise on the assembled ring is a wiring fact the
   * flash-and-listen pass confirms, and flipping it is one sign here.
   */
  static const int8_t quarter[16] = {
    0, +1, -1, 0,
    -1, 0, 0, +1,
    +1, 0, 0, -1,
    0, -1, +1, 0,
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

/* --- the wheel ------------------------------------------------------------ */

void havpe_mode_wheel_init(struct havpe_mode_wheel *wheel, uint8_t mode) {
  if (mode >= HAVPE_MODE_COUNT) mode = HAVPE_MODE_OPENAI_OPEN_MIC;
  wheel->shown = mode;
  wheel->settled = mode;
  wheel->spinning = false;
  wheel->last_turn_ms = 0U;
}

void havpe_mode_wheel_turn(
    struct havpe_mode_wheel *wheel, int steps, uint64_t now_ms) {
  int position = (int)wheel->shown + steps;
  position %= (int)HAVPE_MODE_COUNT;
  if (position < 0) position += (int)HAVPE_MODE_COUNT;
  wheel->shown = (uint8_t)position;
  wheel->spinning = true;
  wheel->last_turn_ms = now_ms;
}

void havpe_mode_wheel_cancel(struct havpe_mode_wheel *wheel) {
  wheel->shown = wheel->settled;
  wheel->spinning = false;
}

bool havpe_mode_wheel_take_settled(
    struct havpe_mode_wheel *wheel, uint64_t now_ms, uint8_t *mode) {
  if (!wheel->spinning ||
      now_ms - wheel->last_turn_ms < (uint64_t)HAVPE_MODE_SETTLE_MS) {
    return false;
  }
  wheel->spinning = false;
  wheel->settled = wheel->shown;
  if (mode != NULL) *mode = wheel->settled;
  return true;
}
