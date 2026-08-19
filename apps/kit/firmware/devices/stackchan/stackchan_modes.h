#ifndef ITERATE_KIT_STACKCHAN_MODES_H
#define ITERATE_KIT_STACKCHAN_MODES_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * The StackChan's two conversation modes, the face-tap menu that switches
 * them, and the session grammar the side button speaks.
 *
 * Pure C99 with no hardware includes, same rule as havpe_modes: the mode
 * table is a WIRE CONTRACT — each entry names a stream whose far end is
 * already configured for exactly that provider — so the table, the menu and
 * the session machine stay host-testable, and a drifted path or a press that
 * means the wrong thing is a failing host test rather than a robot that
 * dials the wrong provider with total confidence.
 *
 * This board has no push-to-talk anywhere in its table: its microphone rides
 * the open call behind its own echo canceller, so both modes are server-VAD
 * full duplex and the only choice the menu offers is WHO answers.
 */

/**
 * One provider choice, in menu order (left cell, right cell).
 *
 * The order is also the index into `stackchan_mode_sounds` in the generated
 * assets: announcement N says mode N's name, so reordering here without
 * regenerating the sounds makes the robot announce the wrong provider with
 * total confidence.
 */
enum stackchan_mode {
  STACKCHAN_MODE_GROK = 0,
  /** The board's factory default; its path is `facts.stream_path`. */
  STACKCHAN_MODE_OPENAI,
  STACKCHAN_MODE_COUNT,
};

/** The conversation stream a mode dials. NULL for an out-of-range mode. */
const char *stackchan_mode_stream_path(uint8_t mode);

/* --- the session -----------------------------------------------------------
 *
 * The same wake / converse / idle grammar the HAVPE speaks, minus the hold:
 * this board's side button has no talk posture to carry (the PMIC owns the
 * long press as hardware power-off), so a press is only ever a tap.
 *
 *   IDLE     face: dozing.  mic: silent.
 *            tap: wakes (chime).
 *   WAKING   face: awake.  tap ends the session.
 *   IN_CALL  face: awake, mouth on played audio.  tap ends.
 *   ENDING   presses: nothing — the teardown is already on the wire.
 *
 * SOUNDS: the wake press chimes (chime_press), every session's return to
 * IDLE says "call ended" (chime_ended) — every end path flows through that
 * one edge, so no end can forget the sound.
 *
 * Derived each poll from the loop's two published facts, never stored: a
 * second latch could disagree with the loop's, a classifier cannot.
 */

enum stackchan_session_state {
  STACKCHAN_SESSION_IDLE = 0,
  STACKCHAN_SESSION_WAKING,
  STACKCHAN_SESSION_IN_CALL,
  STACKCHAN_SESSION_ENDING,
};

/** Which row of the table applies, from the loop's two mirrored facts. */
enum stackchan_session_state stackchan_session_classify(
    bool wants_call, bool call_active);

/** The machine's memory: whether the last poll was in a session, for the
 * exit-to-idle edge. */
struct stackchan_session {
  bool was_in_session;
};

/** One control poll's worth of facts. */
struct stackchan_session_poll {
  bool tap;         /**< A completed side-button tap (edge). */
  bool wants_call;  /**< The loop's intent, mirrored by the last present. */
  bool call_active; /**< The loop's call fact, likewise. */
};

/** What this pass must do about it. All edges. */
struct stackchan_session_actions {
  bool start_call;
  bool end_call;
  bool wake_chime; /**< Plays only for the press that OPENS a session. */
  /** "Call ended", once per session, on its return to IDLE — whatever
   * ended it: tap, model hang-up, idle timeout, a dead session. */
  bool end_chime;
};

void stackchan_session_step(
    struct stackchan_session *session,
    const struct stackchan_session_poll *poll,
    struct stackchan_session_actions *out);

/* --- the face-tap menu -----------------------------------------------------
 *
 * A tap on the face opens a two-cell provider menu; a second tap picks the
 * cell under the finger; silence dismisses it. The face returns the moment
 * the menu closes, so the menu is a moment, not a screen the robot can get
 * stuck on.
 *
 * The menu opens only while no call is in play: adopting a new conversation
 * underneath a call being placed would strand the call, exactly the wheel
 * rule the HAVPE keeps, so a mid-call face tap does nothing at all.
 */

enum {
  /** Menu quiet after which it dismisses itself, undone. */
  STACKCHAN_MENU_TIMEOUT_MS = 3500,
};

/** A pick that is not one. */
enum { STACKCHAN_MENU_NO_PICK = 0xff };

struct stackchan_menu {
  bool open;
  uint64_t opened_at_ms;
};

/** One face-tap poll's worth of facts. */
struct stackchan_menu_poll {
  bool tap;          /**< A completed face tap (edge). */
  /** Which half of the panel the tap landed on; the cells are the halves,
   * so the hit test is one comparison and cannot disagree with the render. */
  bool tap_left_half;
  bool call_in_play; /**< wants_call or call_active — the wheel-cancel rule. */
  uint64_t now_ms;
};

/**
 * Advance the menu. Returns whether the menu is visible after this poll;
 * `*pick` is the mode the tap chose, or STACKCHAN_MENU_NO_PICK.
 *
 * A pick fires even when it lands on the mode already adopted — the person
 * asked which provider this is, and the announcement is the answer; callers
 * skip the persistence, not the reply.
 */
bool stackchan_menu_step(
    struct stackchan_menu *menu,
    const struct stackchan_menu_poll *poll,
    uint8_t *pick);

#ifdef __cplusplus
}
#endif

#endif
