#ifndef ITERATE_KIT_HAVPE_MODES_H
#define ITERATE_KIT_HAVPE_MODES_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * The dial's four conversation modes, the wheel arithmetic behind them, and
 * the session grammar the centre button speaks.
 *
 * Pure C99 with no hardware includes, like voice_pe_hardware_config: the mode
 * table is a WIRE CONTRACT — each entry names a stream whose far end is
 * already configured for exactly that provider and turn policy — so the table,
 * the decoder and the session machine stay host-testable, and a drifted path,
 * a miscounted detent or a press that means the wrong thing is a failing host
 * test rather than a board that dials a provider expecting turns nobody marks.
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

/* --- the session -----------------------------------------------------------
 *
 * THE OFFICIAL FIRMWARE'S GRAMMAR: WAKE, CONVERSE, IDLE. A press wakes the
 * device into a session; the session ends by model hang-up, button, or idle
 * timeout; an ended session is SILENT — no microphone frame leaves — until
 * the next wake press. It replaced a latch that re-armed on every call end:
 * the hang_up tool's end at 12:53:25 (2026-08-19) was answered by a fresh
 * call within the same second, so hanging up was impossible in open mic.
 *
 *   IDLE     ring: the mode's quadrant, dim.  mic: silent.
 *            tap:  open-mic wakes (chime); push-to-talk flashes the mode —
 *                  opening a session a tap cannot talk to is the two-press
 *                  jank this table bans.
 *            hold: push-to-talk wakes — chime and talk in ONE gesture;
 *                  open-mic nothing.
 *   WAKING   ring: the amber working comet.  mic: push-to-talk while held.
 *            tap ends the session; a push-to-talk hold keeps talking.
 *   IN_CALL  ring: the shared lights.  mic: open-mic the whole session,
 *            push-to-talk while held.  tap ends; an open-mic hold is
 *            nothing, so leaning cannot hang up.
 *   ENDING   ring: the lights draining.  mic: silent.  presses: nothing —
 *            the teardown is already on the wire.
 *
 * SOUNDS: the wake press chimes (chime_press), every session's return to
 * IDLE says "call ended" (chime_ended) — every end path flows through that
 * one edge, so no end can forget the sound — and every other press is
 * answered by the ring alone.
 *
 * Derived each poll from the loop's two published facts, never stored: a
 * second latch could disagree with the loop's, a classifier cannot. Holding
 * is a LEVEL the button owns (`talk_held`), not a fifth state.
 */

enum havpe_session_state {
  HAVPE_SESSION_IDLE = 0,
  HAVPE_SESSION_WAKING,
  HAVPE_SESSION_IN_CALL,
  HAVPE_SESSION_ENDING,
};

/** Which row of the table applies, from the loop's two mirrored facts. */
enum havpe_session_state havpe_session_classify(
    bool wants_call, bool call_active);

/** The machine's memory: the hold level for its rising edge, and whether
 * the last poll was in a session, for the exit-to-idle edge. */
struct havpe_session {
  bool was_held;
  bool was_in_session;
  /** When the session left IDLE, for the open-mic tap-end grace. */
  uint64_t session_since_ms;
};

/** Open mic ignores a tap this soon after the session opened: the reflexive
 * press right behind a wake used to say "call ended" to a person who meant
 * nothing by it. Past the grace, the tap is the end — the gesture a person
 * actually tries on a one-button device. */
#define HAVPE_SESSION_TAP_END_GRACE_MS 2000

/** One control poll's worth of facts, gestures already classified. */
struct havpe_session_poll {
  bool tap;          /**< A completed short tap (edge). */
  bool held;         /**< The hold level, raw; the machine applies posture. */
  /** The 800 ms deliberate-end latch (edge); still an open-mic hang-up. */
  bool end_hold;
  bool wants_call;   /**< The loop's intent, mirrored by the last present. */
  bool call_active;  /**< The loop's call fact, likewise. */
  bool push_to_talk; /**< The adopted mode's posture. */
  uint64_t now_ms;   /**< Monotonic, for the tap-end grace. */
};

/** What this pass must do about it. Edges, except the `talk_held` level. */
struct havpe_session_actions {
  bool start_call;
  bool end_call;
  bool wake_chime;   /**< Plays only for the press that OPENS a session. */
  /** "Call ended", once per session, on its return to IDLE — whatever
   * ended it: tap, model hang-up, idle timeout, a dead session. */
  bool end_chime;
  bool mode_flash;   /**< A push-to-talk bare tap: remind, open nothing. */
  /** The hold, reported only where the table says it means talk, so a hold
   * outside a session can never become one by an edge. */
  bool talk_held;
};

void havpe_session_step(
    struct havpe_session *session,
    const struct havpe_session_poll *poll,
    struct havpe_session_actions *out);

#ifdef __cplusplus
}
#endif

#endif
