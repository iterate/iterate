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

void iterate_kit_playout_mark_drained(struct iterate_kit_playout *playout) {
  if (playout == NULL) return;
  playout->answer_audible = false;
}

void iterate_kit_playout_reset(
    struct iterate_kit_playout *playout, uint32_t call) {
  if (playout == NULL) {
    return;
  }
  playout->call = call;
  playout->answer = 0U;
  playout->frame = 0U;
  playout->answer_started = false;
  playout->abandoned = 0U;
  playout->has_abandoned = false;
  playout->abandoned_frame = 0U;
  playout->appended = 0U;
  playout->replaced = 0U;
  playout->superseded_midplay = 0U;
  playout->answer_audible = false;
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
   * NAME the answer being abandoned. Do not invent a new number.
   *
   * The obvious implementation is `++playout->answer`, and it is a latch that
   * silences the device permanently. Local interrupts happen on every press
   * of the talk button; the sender's numbers advance only when the model
   * actually starts speaking. Any turn that produces no answer — the customer
   * changed their mind, the provider dropped the turn, the model chose
   * silence — drifts the two apart by one, and from that moment every frame
   * that arrives is numbered BELOW the local counter and is discarded as
   * stale. Forever. Measured: turns where the transcript proves the model
   * answered and the device received zero frames of it.
   *
   * So the local side never authors a number. It records which answer it no
   * longer wants, and the sender's next answer — whatever it is numbered —
   * supersedes it as an ordinary newer answer.
   */
  if (playout->answer_started) {
    playout->abandoned = playout->answer;
    playout->abandoned_frame = playout->frame;
    playout->has_abandoned = true;
  }
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
   * Speech from an answer that has been superseded — the sender cancelled and
   * started again. Playing it is the failure a listener describes as "it kept
   * talking after I did".
   */
  if (frame->answer < playout->answer) {
    /*
     * ...unless the sender has plainly started over.
     *
     * A lower number means one of two opposite things, and only the frame
     * index tells them apart. Late frames from a superseded answer continue
     * from where that answer had got to; a sender that has RESTARTED — a
     * recycled bridge, a new call on the same mount — begins its first answer
     * at frame zero. Treating the second as the first is a latch with no way
     * out: every frame thereafter is numbered below a high-water mark the
     * sender will never reach again, so the device stays silent for the rest
     * of the boot while the transport reports ready and batches keep
     * arriving. Measured across five turns: 310 frames of 1388 discarded.
     *
     * This is the same hazard, on the field next to it, as the `abandoned`
     * latch below — which was also found by measurement, also silently ate a
     * whole answer, and was also fixed by looking at the frame index.
     *
     * FRAME ZERO EXACTLY, and nothing looser. A straggler at frame 2 of a
     * superseded answer is genuine stale speech and must still be refused; a
     * tolerance of "the first few frames" admits it and resumes a sentence
     * the person already talked over. If a restart's opening frame is lost
     * the device waits for the next answer, which costs one reply — where
     * being wrong the other way costs every reply until reboot.
     */
    if (frame->frame != 0U) {
      ++playout->ignored_stale_answer;
      return ITERATE_KIT_PLAYOUT_IGNORE;
    }
    /*
     * Take the sender's numbering as the truth from here. Leaving the old
     * high-water mark in place would send this frame to the branch below,
     * which admits only a HIGHER answer — and a restart is by definition
     * lower, so it would fall through to the duplicate test and be dropped.
     */
    playout->answer = frame->answer;
    playout->answer_started = false;
    playout->has_abandoned = false;
  }
  /*
   * Speech from the answer the person talked over — but ONLY the frames that
   * were already on their way.
   *
   * The abandoned number is forgotten the moment the sender numbers an answer
   * at or below it, because that can only mean the sender has moved on and
   * this is a DIFFERENT answer wearing a number we have seen. Two ways that
   * happens, both measured: a turn that produced no answer at all leaves the
   * sender's counter where it was, so its next real answer reuses the number
   * we abandoned; and a bridge that restarts begins again at zero.
   *
   * Remembering it past that point discards a whole answer the customer is
   * waiting for — 95 frames of one, in the run that found this — and the
   * device has no way back, because the number it is waiting to exceed is one
   * the sender will never reach again.
   *
   * The frames this is here to reject arrive within a round trip of the
   * button, so `frame` still climbing is what distinguishes them: the tail of
   * an abandoned answer continues where it left off, while a new answer under
   * a reused number starts again from its first frames.
   */
  if (playout->has_abandoned && frame->answer == playout->abandoned) {
    /*
     * Frame ZERO is the restart, named explicitly: an interrupt one frame into
     * an answer leaves abandoned_frame at 0, and then `frame >= 0` rejects
     * everything — including the reused-number restart this branch exists to
     * admit. The lower-answer path above calls that latch out by name; this is
     * the same latch.
     */
    if (frame->frame != 0U && frame->frame >= playout->abandoned_frame) {
      ++playout->ignored_stale_answer;
      return ITERATE_KIT_PLAYOUT_IGNORE;
    }
    playout->has_abandoned = false;
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
    /*
     * Did this cost the listener anything? Only if an answer was already under
     * way when the newer one arrived. Counting that separately is what lets a
     * clean turn report zero while a barge-in still reports what it abandoned.
     */
    if (playout->answer_audible && frame->answer > playout->answer) {
      ++playout->superseded_midplay;
    }
    /* A newer answer settles the interruption: nothing is abandoned now. */
    playout->has_abandoned = false;
    playout->answer = frame->answer;
    playout->frame = frame->frame;
    playout->answer_started = true;
    playout->answer_audible = true;
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
  playout->answer_audible = true;
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
