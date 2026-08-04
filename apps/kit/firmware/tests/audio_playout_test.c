#include "iterate/kit/audio_playout.h"

#include <assert.h>
#include <stdint.h>
#include <string.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

/*
 * Every scenario here is one the device has actually been observed to get
 * wrong in a room, and each has been indistinguishable from the others in the
 * only report a listener can give: "it went funny". Sequence and answer
 * numbers make them separable, and separable is the whole point of the
 * module — a decision that needs a network, a codec and a flash cycle to
 * exercise is a decision nobody exercises.
 */

static struct iterate_kit_playout_frame at(
    uint32_t call, uint32_t answer, uint32_t frame) {
  struct iterate_kit_playout_frame reference;
  reference.call = call;
  reference.answer = answer;
  reference.frame = frame;
  return reference;
}

/*
 * The ordinary case, and the one a naive implementation gets right by
 * accident: consecutive frames of one answer are simply queued in order.
 */
static void plays_one_answer_in_order(void) {
  struct iterate_kit_playout playout;
  uint32_t index;

  iterate_kit_playout_reset(&playout, 7U);
  for (index = 0U; index < 50U; ++index) {
    const struct iterate_kit_playout_frame frame = at(7U, 1U, index);
    const enum iterate_kit_playout_action action =
        iterate_kit_playout_classify(&playout, &frame);
    /* The first frame of an answer is a REPLACE: nothing else may precede it. */
    assert(action == (index == 0U ? ITERATE_KIT_PLAYOUT_REPLACE
                                  : ITERATE_KIT_PLAYOUT_APPEND));
  }
  assert(playout.appended == 49U);
  assert(playout.replaced == 1U);
  assert(playout.gaps == 0U);
}

/*
 * A connection recycle overlaps two deliveries ON PURPOSE — the successor is
 * opened before the incumbent is released, so no frame falls between them —
 * which means the same frames legitimately arrive twice. Played twice they
 * stutter the sentence, and the stutter lands mid-word where it sounds like a
 * network fault rather than like the device repeating itself.
 */
static void ignores_frames_redelivered_by_a_recycle(void) {
  struct iterate_kit_playout playout;
  struct iterate_kit_playout_frame frame;

  iterate_kit_playout_reset(&playout, 7U);
  frame = at(7U, 1U, 0U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_REPLACE);
  frame = at(7U, 1U, 1U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_APPEND);

  /* The overlap re-sends both. */
  frame = at(7U, 1U, 0U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_IGNORE);
  frame = at(7U, 1U, 1U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_IGNORE);
  assert(playout.ignored_duplicate == 2U);
  /* A duplicate must never be mistaken for a hole. */
  assert(playout.gaps == 0U);
}

/*
 * Barge-in. The person starts talking while the assistant is mid-sentence, so
 * everything queued must go immediately — waiting for the server to confirm
 * the cancellation means the assistant talks over the person for a whole
 * round trip, which is the single rudest thing this device does.
 *
 * The frames already in flight for the abandoned answer keep arriving after
 * the interrupt, and playing them would resume a sentence the person has
 * already cut off.
 */
static void an_interrupt_silences_the_answer_being_talked_over(void) {
  struct iterate_kit_playout playout;
  struct iterate_kit_playout_frame frame;

  iterate_kit_playout_reset(&playout, 7U);
  frame = at(7U, 1U, 0U);
  (void)iterate_kit_playout_classify(&playout, &frame);
  frame = at(7U, 1U, 1U);
  (void)iterate_kit_playout_classify(&playout, &frame);

  iterate_kit_playout_interrupt(&playout);

  /* Still in flight when the button went down. */
  frame = at(7U, 1U, 2U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_IGNORE);
  frame = at(7U, 1U, 3U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_IGNORE);
  assert(playout.ignored_stale_answer == 2U);

  /*
   * The reply to what the person just said. It is a REPLACE even though the
   * queue was already emptied locally, because the caller must not be
   * required to remember that it was.
   */
  frame = at(7U, 2U, 0U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_REPLACE);
  frame = at(7U, 2U, 1U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_APPEND);
}

/*
 * A new answer arriving without any local interrupt — the server cancelled
 * and started again on its own, which happens when the model is handed a tool
 * result. The tail of the old answer must not be heard in front of the new
 * one; that is the "it answered the previous question" complaint.
 */
static void a_newer_answer_replaces_whatever_is_queued(void) {
  struct iterate_kit_playout playout;
  struct iterate_kit_playout_frame frame;

  iterate_kit_playout_reset(&playout, 7U);
  frame = at(7U, 4U, 0U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_REPLACE);
  frame = at(7U, 4U, 1U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_APPEND);
  frame = at(7U, 5U, 0U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_REPLACE);
  /* The straggler from answer 4 must not be appended after answer 5 began. */
  frame = at(7U, 4U, 2U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_IGNORE);
  assert(playout.replaced == 2U);
  assert(playout.ignored_stale_answer == 1U);
}

/*
 * Two bridges can serve one stream for a moment while one is being replaced,
 * and the loser's last frames carry its own call id. Played, they splice a
 * fragment of a different conversation into this one.
 */
static void ignores_speech_belonging_to_another_call(void) {
  struct iterate_kit_playout playout;
  struct iterate_kit_playout_frame frame;

  iterate_kit_playout_reset(&playout, 7U);
  frame = at(8U, 1U, 0U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_IGNORE);
  assert(playout.ignored_other_call == 1U);
  assert(playout.appended == 0U);
  assert(playout.replaced == 0U);
}

/*
 * A genuine hole. Counted where it appears, and NOT by subtracting played
 * frames from a total — subtraction cannot tell a frame that was lost from
 * one that was never sent, and every count taken that way has read as a
 * network fault when the sender simply stopped.
 */
static void counts_holes_where_they_appear(void) {
  struct iterate_kit_playout playout;
  struct iterate_kit_playout_frame frame;

  iterate_kit_playout_reset(&playout, 7U);
  frame = at(7U, 1U, 0U);
  (void)iterate_kit_playout_classify(&playout, &frame);
  frame = at(7U, 1U, 5U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_APPEND);
  assert(playout.gaps == 4U);

  /*
   * Late arrivals of the missing frames are still refused: the audio after
   * them has already been queued, so inserting them now would play the
   * sentence out of order.
   */
  frame = at(7U, 1U, 2U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_IGNORE);
  assert(playout.gaps == 4U);
}

/*
 * Hanging up and calling again. Speech left over from the previous call must
 * never open the next one, and the counters must start clean or the next
 * call's diagnosis inherits the last call's faults.
 */
static void a_new_call_starts_clean(void) {
  struct iterate_kit_playout playout;
  struct iterate_kit_playout_frame frame;

  iterate_kit_playout_reset(&playout, 7U);
  frame = at(7U, 3U, 9U);
  (void)iterate_kit_playout_classify(&playout, &frame);
  assert(playout.replaced == 1U);

  iterate_kit_playout_reset(&playout, 8U);
  assert(playout.replaced == 0U);
  assert(playout.appended == 0U);
  frame = at(7U, 3U, 10U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_IGNORE);
  assert(playout.ignored_other_call == 1U);
}

/*
 * THE LATCH. Interrupting must not invent an answer number.
 *
 * Local interrupts fire on every press of the talk button; the sender numbers
 * only the answers it actually speaks. A turn the customer abandons, or one
 * the provider drops, advances the local count and not the sender's — and an
 * implementation that expressed the interrupt as ++answer then discarded every
 * frame that followed as stale, permanently, on a device that looked perfectly
 * healthy. Measured in a live run: transcripts proving the model answered, and
 * zero frames of it played.
 */
static void interrupting_a_turn_that_is_never_answered_does_not_deafen_us(void)
{
  struct iterate_kit_playout playout;
  struct iterate_kit_playout_frame frame;
  uint32_t press;

  iterate_kit_playout_reset(&playout, 7U);
  /* Answer 1 plays normally. */
  frame = at(7U, 1U, 0U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_REPLACE);

  /* Five turns where the person speaks and nothing is ever answered. */
  for (press = 0U; press < 5U; ++press) {
    iterate_kit_playout_interrupt(&playout);
  }

  /* The sender's next answer is #2, because it has only ever spoken once. */
  frame = at(7U, 2U, 0U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_REPLACE);
  frame = at(7U, 2U, 1U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_APPEND);
  assert(playout.appended == 1U);
}

/*
 * An interrupt with nothing playing must not abandon the answer that is about
 * to arrive. Pressing talk before the assistant has said anything is ordinary,
 * and it used to poison the very next answer.
 */
static void interrupting_silence_abandons_nothing(void)
{
  struct iterate_kit_playout playout;
  struct iterate_kit_playout_frame frame;

  iterate_kit_playout_reset(&playout, 7U);
  iterate_kit_playout_interrupt(&playout);
  frame = at(7U, 0U, 0U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_REPLACE);
  frame = at(7U, 0U, 1U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_APPEND);
}

/* A null caller must not crash a device that is already having a bad day. */
/*
 * THE ANSWER THAT WAS THROWN AWAY WHOLE.
 *
 * Measured on hardware: 95 frames arrived, all 95 counted as ignored-stale,
 * spkPlayed did not move, and the customer heard nothing while the transcript
 * showed a perfectly good reply.
 *
 * The device abandons answer N when the talk button goes down. If the sender
 * then numbers its NEXT answer N as well — which happens whenever the turn
 * produced no answer, and whenever a restarted bridge begins again at zero —
 * every frame of that new answer matches the abandoned number and is
 * discarded. Forever, because the number the device waits to exceed is one the
 * sender will never reach again.
 *
 * The tail of an abandoned answer continues from where playback stopped; a new
 * answer reusing the number starts again at its beginning. That is what
 * separates them.
 */
static void an_answer_reusing_an_abandoned_number_still_plays(void)
{
  struct iterate_kit_playout playout;
  struct iterate_kit_playout_frame frame;

  iterate_kit_playout_reset(&playout, 3U);
  /* Answer 4 plays up to frame 20, then the person presses talk. */
  frame = at(3U, 4U, 0U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_REPLACE);
  frame = at(3U, 4U, 20U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_APPEND);
  iterate_kit_playout_interrupt(&playout);

  /* Frames still in flight from the abandoned answer are rightly dropped. */
  frame = at(3U, 4U, 21U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_IGNORE);
  assert(playout.ignored_stale_answer == 1U);

  /* The sender's next answer reuses number 4 and starts from the beginning. */
  frame = at(3U, 4U, 0U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_REPLACE);
  frame = at(3U, 4U, 1U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_APPEND);
  /* And the whole of it plays, rather than one frame in a hundred. */
  assert(playout.ignored_stale_answer == 1U);
}

/*
 * A bridge that restarts numbers its first answer 0, below anything the device
 * has played. That is a new conversation, not stale speech.
 */
static void a_restarted_sender_starting_at_zero_is_not_stale(void)
{
  struct iterate_kit_playout playout;
  struct iterate_kit_playout_frame frame;

  iterate_kit_playout_reset(&playout, 2U);
  frame = at(2U, 0U, 0U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_REPLACE);
  frame = at(2U, 0U, 5U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_APPEND);
  iterate_kit_playout_interrupt(&playout);

  /* The bridge restarts: answer 0 again, from its first frame. */
  frame = at(2U, 0U, 0U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_REPLACE);
  frame = at(2U, 0U, 1U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_APPEND);
}

/*
 * A SENDER THAT STARTED OVER IS NOT STALE SPEECH.
 *
 * Measured across five turns: 310 frames of 1388 discarded, spkPlayed stuck
 * at 1036, while the transport reported ready and batches kept arriving. A
 * recycled bridge numbers its first answer BELOW the high-water mark this
 * device has already played, and the stale test then rejects everything for
 * the rest of the boot — the number it waits to exceed is one the sender will
 * never reach again.
 *
 * The frame index is what tells the two apart: a restart opens at zero, while
 * late frames from a superseded answer are already deep into it.
 */
static void a_sender_that_restarted_is_not_stale(void)
{
  struct iterate_kit_playout playout;
  struct iterate_kit_playout_frame frame;

  iterate_kit_playout_reset(&playout, 1U);
  /* Answers 0..4 play; the device's high-water mark reaches 4. */
  frame = at(1U, 4U, 0U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_REPLACE);
  frame = at(1U, 4U, 30U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_APPEND);

  /* A late frame from answer 3 is genuinely stale, and is refused. */
  frame = at(1U, 3U, 40U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_IGNORE);
  assert(playout.ignored_stale_answer == 1U);

  /* The bridge recycles and starts again at answer 0, frame 0. */
  frame = at(1U, 0U, 0U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_REPLACE);
  frame = at(1U, 0U, 1U);
  assert(
      iterate_kit_playout_classify(&playout, &frame) ==
      ITERATE_KIT_PLAYOUT_APPEND);
  /* Nothing more refused: the whole new conversation plays. */
  assert(playout.ignored_stale_answer == 1U);
}

static void tolerates_missing_arguments(void) {
  struct iterate_kit_playout playout;
  const struct iterate_kit_playout_frame frame = at(1U, 1U, 1U);

  iterate_kit_playout_reset(&playout, 1U);
  assert(
      iterate_kit_playout_classify(NULL, &frame) ==
      ITERATE_KIT_PLAYOUT_IGNORE);
  assert(
      iterate_kit_playout_classify(&playout, NULL) ==
      ITERATE_KIT_PLAYOUT_IGNORE);
  iterate_kit_playout_reset(NULL, 1U);
  iterate_kit_playout_interrupt(NULL);
  assert(strcmp(iterate_kit_playout_action_name(
                    ITERATE_KIT_PLAYOUT_REPLACE), "replace") == 0);
}


/*
 * A NEW ANSWER AFTER A COMPLETED ONE COSTS NOTHING.
 *
 * Every answer carries a higher number than the last, so every answer takes the
 * REPLACE path. That is ordinary, and `superseded_midplay` must stay at zero for
 * it — the counter exists to name answers cut off while still audible, and if it
 * moved on a clean sequence every healthy turn would look damaged.
 */
static void a_new_answer_after_a_drained_one_is_not_a_supersede(void)
{
  struct iterate_kit_playout playout;
  const struct iterate_kit_playout_frame first = {7U, 1U, 0U};
  const struct iterate_kit_playout_frame second = {7U, 2U, 0U};

  iterate_kit_playout_reset(&playout, 7U);
  assert(iterate_kit_playout_classify(&playout, &first) ==
         ITERATE_KIT_PLAYOUT_REPLACE);
  /* The speaker drained it and the sender had said it was done. */
  iterate_kit_playout_mark_drained(&playout);
  assert(iterate_kit_playout_classify(&playout, &second) ==
         ITERATE_KIT_PLAYOUT_REPLACE);
  assert(playout.replaced == 2U);
  assert(playout.superseded_midplay == 0U);
}

/*
 * THE CASE THAT MUST NOT BE FORGIVEN.
 *
 * A source that goes dry in the MIDDLE of an answer is starving, not finishing.
 * If a newer answer then arrives, it really did cut a live one off, and clearing
 * the audible flag on any dry wait would have hidden exactly that. Only a dry
 * buffer AND a sender-declared end may clear it, which is why nothing calls
 * mark_drained here.
 */
static void a_supersede_after_a_transient_dry_still_counts(void)
{
  struct iterate_kit_playout playout;
  const struct iterate_kit_playout_frame first = {7U, 1U, 0U};
  const struct iterate_kit_playout_frame more = {7U, 1U, 1U};
  const struct iterate_kit_playout_frame newer = {7U, 2U, 0U};

  iterate_kit_playout_reset(&playout, 7U);
  assert(iterate_kit_playout_classify(&playout, &first) ==
         ITERATE_KIT_PLAYOUT_REPLACE);
  assert(iterate_kit_playout_classify(&playout, &more) ==
         ITERATE_KIT_PLAYOUT_APPEND);
  /* No mark_drained: the answer was never declared done. */
  assert(iterate_kit_playout_classify(&playout, &newer) ==
         ITERATE_KIT_PLAYOUT_REPLACE);
  assert(playout.superseded_midplay == 1U);
}

/* A frame arriving after a drain makes the answer audible again. */
static void audio_after_a_drain_is_audible_again(void)
{
  struct iterate_kit_playout playout;
  const struct iterate_kit_playout_frame first = {7U, 1U, 0U};
  const struct iterate_kit_playout_frame late = {7U, 1U, 1U};
  const struct iterate_kit_playout_frame newer = {7U, 2U, 0U};

  iterate_kit_playout_reset(&playout, 7U);
  (void)iterate_kit_playout_classify(&playout, &first);
  iterate_kit_playout_mark_drained(&playout);
  /* A straggler for the SAME answer: there is audio to hear again. */
  assert(iterate_kit_playout_classify(&playout, &late) ==
         ITERATE_KIT_PLAYOUT_APPEND);
  assert(iterate_kit_playout_classify(&playout, &newer) ==
         ITERATE_KIT_PLAYOUT_REPLACE);
  assert(playout.superseded_midplay == 1U);
}


/*
 * WHY A NEW CALL MUST RESET THE PLAYOUT.
 *
 * Answer and frame numbers restart with every call, so a second call's opening
 * frames are numerically BEHIND wherever the previous call finished. Without a
 * reset the classifier is right to call them duplicates — that is its contract —
 * and the owner is wrong not to have reset. Measured before the reset existed:
 * 539 of 583 frames of a fresh call's first answer never reached the speaker,
 * 330 of them refused here.
 *
 * This test pins both halves: the refusal without a reset, and the acceptance
 * with one.
 */
static void a_second_call_needs_a_reset_or_its_frames_look_stale(void)
{
  struct iterate_kit_playout playout;
  const struct iterate_kit_playout_frame first = {7U, 1U, 0U};
  const struct iterate_kit_playout_frame later = {7U, 1U, 5U};
  const struct iterate_kit_playout_frame fresh_call = {7U, 1U, 0U};

  iterate_kit_playout_reset(&playout, 7U);
  assert(iterate_kit_playout_classify(&playout, &first) ==
         ITERATE_KIT_PLAYOUT_REPLACE);
  assert(iterate_kit_playout_classify(&playout, &later) ==
         ITERATE_KIT_PLAYOUT_APPEND);

  /* A new call's first frame, with NO reset: behind us, so refused. */
  assert(iterate_kit_playout_classify(&playout, &fresh_call) ==
         ITERATE_KIT_PLAYOUT_IGNORE);
  assert(playout.ignored_duplicate == 1U);

  /* The same frame after the reset the owner owes it: played. */
  iterate_kit_playout_reset(&playout, 7U);
  assert(iterate_kit_playout_classify(&playout, &fresh_call) ==
         ITERATE_KIT_PLAYOUT_REPLACE);
}

int main(void) {
  plays_one_answer_in_order();
  ignores_frames_redelivered_by_a_recycle();
  an_interrupt_silences_the_answer_being_talked_over();
  a_newer_answer_replaces_whatever_is_queued();
  ignores_speech_belonging_to_another_call();
  counts_holes_where_they_appear();
  a_new_call_starts_clean();
  interrupting_a_turn_that_is_never_answered_does_not_deafen_us();
  interrupting_silence_abandons_nothing();
  an_answer_reusing_an_abandoned_number_still_plays();
  a_restarted_sender_starting_at_zero_is_not_stale();
  a_sender_that_restarted_is_not_stale();
  tolerates_missing_arguments();
  a_new_answer_after_a_drained_one_is_not_a_supersede();
  a_supersede_after_a_transient_dry_still_counts();
  audio_after_a_drain_is_audible_again();
  a_second_call_needs_a_reset_or_its_frames_look_stale();
  return 0;
}
