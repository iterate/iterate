#ifndef ITERATE_KIT_SESSION_GRAMMAR_H
#define ITERATE_KIT_SESSION_GRAMMAR_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * THE SESSION GRAMMAR: what a press MEANS, decided in one place for every
 * board.
 *
 * THE OFFICIAL FIRMWARE'S SHAPE: WAKE, CONVERSE, IDLE. A press wakes the
 * device into a session; the session ends by model hang-up, button, or idle
 * timeout; an ended session is SILENT — no microphone frame leaves — until
 * the next wake press. It replaced a latch that re-armed on every call end:
 * the hang_up tool's end at 12:53:25 (2026-08-19) was answered by a fresh
 * call within the same second, so hanging up was impossible in open mic.
 *
 * It grew up on the HAVPE and is now the ONE machine all four boards drive,
 * because every recent UX bug lived in the seams between four slightly
 * different copies of it: a held button reopening the session its own
 * teardown was closing, a press mid-teardown restarting the call it ended.
 * The split is strict — boards CLASSIFY gestures (debounce, tap against
 * hold, which physical control) and RENDER the actions (which chime asset,
 * which ring or face or nothing); what a gesture means in which state lives
 * here, host-tested, and the boards' differences ride the posture flags in
 * the poll as DATA, never as a fork of this table.
 *
 *   IDLE     mic: silent.
 *            tap:  open mic wakes (chime). Push-to-talk wakes only where
 *                  the call control is its own button (`tap_wakes`); where
 *                  the one button is also the talk hold, a bare tap would
 *                  open a session a tap cannot talk to — the two-press jank
 *                  — so it answers with the mode reminder instead.
 *            hold: push-to-talk wakes — chime and talk in ONE gesture;
 *                  open mic nothing, so leaning cannot open a call.
 *   WAKING   mic: push-to-talk while held.
 *            tap ends the session (`tap_ends`); a push-to-talk hold talks.
 *   IN_CALL  mic: open mic the whole session, push-to-talk while held.
 *            tap ends (`tap_ends`; open mic only after a short grace); an
 *            open-mic hold is nothing, so leaning cannot hang up. A
 *            dedicated end control (`end_press`) always ends.
 *   ENDING   mic: silent.  presses: nothing — the teardown is already on
 *            the wire.
 *
 * SOUNDS: the wake press chimes (wake_chime), and every session's return to
 * IDLE announces the end (end_chime) — every end path flows through that
 * one edge, so no end can forget the sound. Every other press is answered
 * by the board's surfaces alone, and a board with no baked sounds simply
 * renders neither chime.
 *
 * Derived each poll from the loop's two published facts, never stored: a
 * second latch could disagree with the loop's, a classifier cannot. Holding
 * is a LEVEL the button owns (`talk_held`), not a fifth state.
 */

enum iterate_kit_session_state {
  ITERATE_KIT_SESSION_IDLE = 0,
  ITERATE_KIT_SESSION_WAKING,
  ITERATE_KIT_SESSION_IN_CALL,
  ITERATE_KIT_SESSION_ENDING,
};

/** Which row of the table applies, from the loop's two mirrored facts. */
enum iterate_kit_session_state iterate_kit_session_classify(
    bool wants_call, bool call_active);

/** The machine's memory: the hold level for its rising edge, and whether
 * the last poll was in a session, for the exit-to-idle edge. */
struct iterate_kit_session {
  bool was_held;
  bool was_in_session;
  /** When the session left IDLE, for the open-mic tap-end grace. */
  uint64_t session_since_ms;
};

/** Open mic ignores a tap this soon after the session opened: the reflexive
 * press right behind a wake used to say "call ended" to a person who meant
 * nothing by it. Past the grace, the tap is the end — the gesture a person
 * actually tries on a one-button device. */
#define ITERATE_KIT_SESSION_TAP_END_GRACE_MS 2000

/**
 * One control poll's worth of facts: the gestures the board classified, the
 * loop's two mirrored facts, and the board's posture as data.
 */
struct iterate_kit_session_poll {
  bool tap;          /**< A completed press of the call control (edge). */
  bool held;         /**< The talk-hold level, raw; the machine applies posture. */
  /** The 800 ms deliberate-end latch (edge). An open-mic hang-up only: in
   * push-to-talk the same physical hold is a TURN, so honouring it there
   * would hang up every long sentence. */
  bool end_hold;
  /** A dedicated end control's press (edge) — a button whose only meaning
   * is hang up, so it ends in either posture with no grace. IDLE ignores it
   * and ENDING absorbs it like every other press. */
  bool end_press;
  bool wants_call;   /**< The loop's intent, mirrored by the last present. */
  bool call_active;  /**< The loop's call fact, likewise. */
  /* --- posture: how this board differs, as data --------------------------- */
  bool push_to_talk; /**< The board's (or its adopted mode's) turn posture. */
  /** Push-to-talk only (open mic always wakes on tap): a bare IDLE tap opens
   * the session. True where the call control is its own button (M5Stick
   * side, Waveshare upper); false where the one button is also the talk
   * hold (HAVPE centre), which flashes the mode instead. */
  bool tap_wakes;
  /** An in-session tap ends the session. False only where the tap edge
   * rides the talk hold itself (Waveshare upper): there every turn would
   * begin by hanging up. */
  bool tap_ends;
  uint64_t now_ms;   /**< Monotonic, for the tap-end grace. */
};

/** What this pass must do about it. Edges, except the `talk_held` level. */
struct iterate_kit_session_actions {
  bool start_call;
  bool end_call;
  bool wake_chime;   /**< Plays only for the press that OPENS a session. */
  /** The end announcement, once per session, on its return to IDLE —
   * whatever ended it: tap, model hang-up, idle timeout, a dead session. */
  bool end_chime;
  /** A push-to-talk bare tap where taps do not wake: remind, open nothing. */
  bool mode_flash;
  /** The hold, reported only where the table says it means talk, so a hold
   * outside a session can never become one by an edge. */
  bool talk_held;
};

void iterate_kit_session_step(
    struct iterate_kit_session *session,
    const struct iterate_kit_session_poll *poll,
    struct iterate_kit_session_actions *out);

#ifdef __cplusplus
}
#endif

#endif
