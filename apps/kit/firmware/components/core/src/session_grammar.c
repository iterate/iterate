/*
 * The session grammar every board drives. Pure — see session_grammar.h,
 * where the state table lives.
 */
#include "iterate/kit/session_grammar.h"

#include <string.h>

enum iterate_kit_session_state iterate_kit_session_classify(
    bool wants_call, bool call_active) {
  if (wants_call) {
    return call_active ? ITERATE_KIT_SESSION_IN_CALL
                       : ITERATE_KIT_SESSION_WAKING;
  }
  return call_active ? ITERATE_KIT_SESSION_ENDING : ITERATE_KIT_SESSION_IDLE;
}

void iterate_kit_session_step(
    struct iterate_kit_session *session,
    const struct iterate_kit_session_poll *poll,
    struct iterate_kit_session_actions *out) {
  /*
   * The rising edge of the hold, taken before the table so a wake consumes
   * it: a session that ends UNDER a held button (the model hangs up while a
   * person is mid-hold) leaves the level true and the edge spent, and the
   * next poll classifies IDLE without minting anything — releasing and
   * holding again is the next wake, exactly like releasing and pressing.
   */
  const enum iterate_kit_session_state state =
      iterate_kit_session_classify(poll->wants_call, poll->call_active);
  const bool hold_began = poll->held && !session->was_held;
  session->was_held = poll->held;
  memset(out, 0, sizeof(*out));
  /*
   * EVERY end path flows through this one edge — tap, model hang-up, idle
   * timeout, a dead session all reach IDLE by clearing the loop's two facts
   * — so raising the end announcement here is what makes it impossible for
   * an end to forget its sound.
   */
  out->end_chime =
      session->was_in_session && state == ITERATE_KIT_SESSION_IDLE;
  if (!session->was_in_session && state != ITERATE_KIT_SESSION_IDLE) {
    session->session_since_ms = poll->now_ms;
  }
  session->was_in_session = state != ITERATE_KIT_SESSION_IDLE;
  /*
   * The talk LEVEL is reported only where the table says a hold means talk.
   * Raw pass-through would leak meaning around the table via the loop's own
   * talk-edge handler: a hold begun while ENDING would reopen the session
   * this grammar just closed.
   */
  switch (state) {
    case ITERATE_KIT_SESSION_IDLE:
      if (poll->push_to_talk) {
        /* THE HOLD IS THE WAKE — and only its RISING edge, so a hold that
         * outlived the previous session stays spent until re-pressed. */
        if (hold_began) {
          out->start_call = true;
          out->wake_chime = true;
          out->talk_held = true;
        }
        /* The bare tap wakes only where the call control is its own button
         * (`tap_wakes`); where the one button is also the talk hold it
         * opens nothing (a session a tap cannot talk to is the two-press
         * jank) and answers with the mode reminder instead. */
        if (poll->tap) {
          if (poll->tap_wakes) {
            out->start_call = true;
            out->wake_chime = true;
          } else {
            out->mode_flash = true;
          }
        }
      } else if (poll->tap) {
        out->start_call = true;
        out->wake_chime = true;
      }
      break;
    case ITERATE_KIT_SESSION_WAKING:
    case ITERATE_KIT_SESSION_IN_CALL:
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
       * hold as the always-works gesture. A dedicated end control needs no
       * such disambiguation: `end_press` ends in either posture, at once.
       */
      if (poll->end_press ||
          (poll->push_to_talk
               ? (poll->tap && poll->tap_ends)
               : (poll->end_hold ||
                  (poll->tap && poll->tap_ends &&
                   poll->now_ms - session->session_since_ms >=
                       (uint64_t)ITERATE_KIT_SESSION_TAP_END_GRACE_MS)))) {
        out->end_call = true;
      }
      out->talk_held = poll->push_to_talk && poll->held;
      break;
    case ITERATE_KIT_SESSION_ENDING:
      /* The teardown is on the wire; presses wait for idle. */
      break;
  }
}
