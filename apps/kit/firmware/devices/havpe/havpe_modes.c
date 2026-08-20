/*
 * The dial's mode table, wheel arithmetic and session grammar. Pure — see
 * havpe_modes.h, where the session's state table lives.
 */
#include "havpe_modes.h"

#include <stddef.h>
#include <string.h>

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

/* --- the session ---------------------------------------------------------- */

enum havpe_session_state havpe_session_classify(
    bool wants_call, bool call_active) {
  if (wants_call) {
    return call_active ? HAVPE_SESSION_IN_CALL : HAVPE_SESSION_WAKING;
  }
  return call_active ? HAVPE_SESSION_ENDING : HAVPE_SESSION_IDLE;
}

void havpe_session_step(
    struct havpe_session *session,
    const struct havpe_session_poll *poll,
    struct havpe_session_actions *out) {
  /*
   * The rising edge of the hold, taken before the table so a wake consumes
   * it: a session that ends UNDER a held button (the model hangs up while a
   * person is mid-hold) leaves the level true and the edge spent, and the
   * next poll classifies IDLE without minting anything — releasing and
   * holding again is the next wake, exactly like releasing and pressing.
   */
  const enum havpe_session_state state =
      havpe_session_classify(poll->wants_call, poll->call_active);
  const bool hold_began = poll->held && !session->was_held;
  session->was_held = poll->held;
  memset(out, 0, sizeof(*out));
  /*
   * EVERY end path flows through this one edge — tap, model hang-up, idle
   * timeout, a dead session all reach IDLE by clearing the loop's two facts
   * — so raising the end announcement here is what makes it impossible for
   * an end to forget its sound.
   */
  out->end_chime = session->was_in_session && state == HAVPE_SESSION_IDLE;
  if (!session->was_in_session && state != HAVPE_SESSION_IDLE) {
    session->session_since_ms = poll->now_ms;
  }
  session->was_in_session = state != HAVPE_SESSION_IDLE;
  /*
   * The talk LEVEL is reported only where the table says a hold means talk.
   * Raw pass-through would leak meaning around the table via the loop's own
   * talk-edge handler: a hold begun while ENDING would reopen the session
   * this grammar just closed.
   */
  switch (state) {
    case HAVPE_SESSION_IDLE:
      if (poll->push_to_talk) {
        /* THE HOLD IS THE WAKE — and only its RISING edge, so a hold that
         * outlived the previous session stays spent until re-pressed. The
         * bare tap opens nothing (a session a tap cannot talk to is the
         * two-press jank) and answers with the mode reminder instead. */
        if (hold_began) {
          out->start_call = true;
          out->wake_chime = true;
          out->talk_held = true;
        }
        if (poll->tap) out->mode_flash = true;
      } else if (poll->tap) {
        out->start_call = true;
        out->wake_chime = true;
      }
      break;
    case HAVPE_SESSION_WAKING:
    case HAVPE_SESSION_IN_CALL:
      /*
       * ENDING IS DELIBERATE, AND THE GESTURE DIFFERS BY POSTURE. In
       * push-to-talk a hold is a turn, so the tap is the end — unambiguous
       * there. In open mic the tap was once a hair trigger: any reflexive
       * press the instant a call opened said "call ended" to a person who
       * meant nothing by it. Hold-only ending fixed that and created the
       * opposite complaint — the tap is the gesture a person actually tries
       * on a one-button device, and a call it cannot end reads as a broken
       * button. So open mic takes the tap AFTER a short grace (the hair
       * trigger lived entirely in the first moments) and keeps the 800 ms
       * hold as the always-works gesture.
       */
      if (poll->push_to_talk
              ? poll->tap
              : (poll->end_hold ||
                 (poll->tap &&
                  poll->now_ms - session->session_since_ms >=
                      (uint64_t)HAVPE_SESSION_TAP_END_GRACE_MS))) {
        out->end_call = true;
      }
      out->talk_held = poll->push_to_talk && poll->held;
      break;
    case HAVPE_SESSION_ENDING:
      /* The teardown is on the wire; presses wait for idle. */
      break;
  }
}
