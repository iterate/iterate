#ifndef ITERATE_KIT_STACKCHAN_MODES_H
#define ITERATE_KIT_STACKCHAN_MODES_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * The StackChan's two conversation modes and the face-tap menu that switches
 * them. What the side button MEANS is the shared session grammar's
 * (iterate/kit/session_grammar.h); this board only classifies its taps.
 *
 * Pure C99 with no hardware includes, same rule as havpe_modes: the mode
 * table is a WIRE CONTRACT — each entry names a stream whose far end is
 * already configured for exactly that provider — so the table and the menu
 * stay host-testable, and a drifted path or a tap that picks the wrong cell
 * is a failing host test rather than a robot that dials the wrong provider
 * with total confidence.
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
