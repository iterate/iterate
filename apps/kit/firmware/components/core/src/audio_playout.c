/*
 * The three-way decision described in audio_playout.h, and nothing else.
 *
 * This file deliberately owns no buffer, no clock, no transport and no
 * allocation. Every audible defect this device has had lived in code that
 * mixed the "which frames are worth playing" decision into the machinery that
 * moved bytes — where it could not be tested without a network, a codec and a
 * ten-minute flash cycle. Keeping the decision total, ordered and pure is what
 * lets a test enumerate every case in microseconds.
 */

#include "iterate/kit/audio_playout.h"

#include <stddef.h>

void iterate_kit_playout_reset(
    struct iterate_kit_playout *playout, uint32_t call) {
  if (playout == NULL) {
    return;
  }
  playout->call = call;
  playout->answer = 0U;
  playout->frame = 0U;
  playout->answer_started = false;
  playout->appended = 0U;
  playout->replaced = 0U;
  playout->ignored_other_call = 0U;
  playout->ignored_stale_answer = 0U;
  playout->ignored_duplicate = 0U;
  playout->gaps = 0U;
}

void iterate_kit_playout_interrupt(struct iterate_kit_playout *playout) {
  if (playout == NULL) {
    return;
  }
  /*
   * Step PAST the answer being abandoned rather than merely marking it
   * finished. The frames already in flight carry the old number, and the only
   * test that rejects them without a second flag is "older than the one we
   * are on". The server's next answer will be numbered higher still, which
   * this then accepts as an ordinary REPLACE.
   */
  ++playout->answer;
  playout->frame = 0U;
  playout->answer_started = false;
}

/**
 * Advance to `frame` within the answer already being played, counting any
 * hole it exposes.
 *
 * Reached only for a frame that continues the current answer and is strictly
 * ahead of the last one accepted, so the arithmetic never sees a duplicate,
 * a reordering or an answer boundary — each of which would otherwise report a
 * hole that does not exist.
 */
static void continue_answer(
    struct iterate_kit_playout *playout,
    const struct iterate_kit_playout_frame *frame) {
  if (frame->frame > playout->frame + 1U) {
    playout->gaps += frame->frame - playout->frame - 1U;
  }
  playout->frame = frame->frame;
}

enum iterate_kit_playout_action iterate_kit_playout_classify(
    struct iterate_kit_playout *playout,
    const struct iterate_kit_playout_frame *frame) {
  if (playout == NULL || frame == NULL) {
    return ITERATE_KIT_PLAYOUT_IGNORE;
  }
  /*
   * A call this device is not on. Two bridges can briefly serve the same
   * stream while one is being replaced, and the loser's last frames are
   * somebody else's conversation.
   */
  if (frame->call != playout->call) {
    ++playout->ignored_other_call;
    return ITERATE_KIT_PLAYOUT_IGNORE;
  }
  /*
   * Speech from an answer that has been superseded — the person interrupted,
   * or the server cancelled and started again. Playing it is the failure a
   * listener describes as "it kept talking after I did".
   */
  if (frame->answer < playout->answer) {
    ++playout->ignored_stale_answer;
    return ITERATE_KIT_PLAYOUT_IGNORE;
  }
  /*
   * THE FIRST FRAME OF AN ANSWER ALWAYS REPLACES.
   *
   * Both ways of reaching a new answer land here: a higher number arriving on
   * its own (the server cancelled and started again), and the first frame
   * after a local interrupt (the person talked over it, so the number was
   * stepped without any frame having been accepted yet).
   *
   * Treating them identically is what keeps the caller stateless. The
   * alternative — APPEND after an interrupt, because the queue "is already
   * empty" — makes correctness depend on the caller remembering that it
   * emptied it, and a caller that forgets plays the tail of an abandoned
   * sentence in front of the new one.
   */
  if (frame->answer > playout->answer || !playout->answer_started) {
    ++playout->replaced;
    playout->answer = frame->answer;
    playout->frame = frame->frame;
    playout->answer_started = true;
    return ITERATE_KIT_PLAYOUT_REPLACE;
  }
  /*
   * Same answer, and at or behind where we already are. A connection recycle
   * overlaps two deliveries on purpose (make-before-break), so the same
   * frames legitimately arrive twice; playing them stutters the sentence.
   */
  if (frame->frame <= playout->frame) {
    ++playout->ignored_duplicate;
    return ITERATE_KIT_PLAYOUT_IGNORE;
  }
  continue_answer(playout, frame);
  ++playout->appended;
  return ITERATE_KIT_PLAYOUT_APPEND;
}

const char *iterate_kit_playout_action_name(
    enum iterate_kit_playout_action action) {
  switch (action) {
    case ITERATE_KIT_PLAYOUT_IGNORE:
      return "ignore";
    case ITERATE_KIT_PLAYOUT_APPEND:
      return "append";
    case ITERATE_KIT_PLAYOUT_REPLACE:
      return "replace";
    default:
      return "unknown";
  }
}
