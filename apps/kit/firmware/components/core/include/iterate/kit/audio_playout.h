#ifndef ITERATE_KIT_AUDIO_PLAYOUT_H
#define ITERATE_KIT_AUDIO_PLAYOUT_H

/*
 * WHAT TO DO WITH A FRAME OF SPEECH THAT HAS JUST ARRIVED.
 *
 * The device receives the assistant's voice as a stream of small events over
 * a session connection, which is deliberately NOT flow-controlled: the server
 * pushes as fast as the wire takes it and never waits to be told a frame
 * landed. That is the right lane for audio — an acknowledgement per frame
 * would put a round trip inside every 20 ms of speech — but it hands the
 * device a problem the server cannot solve for it: some of what arrives is no
 * longer worth playing.
 *
 * There are exactly three answers, and this module is the whole of the
 * decision:
 *
 *   IGNORE   the frame belongs to a call we are not on, to an answer the
 *            person has already talked over, or is one we have played;
 *   APPEND   ordinary speech: put it after what is queued;
 *   REPLACE  a newer answer has begun, so what is queued is stale — discard
 *            it and start this one.
 *
 * WHY IT IS SEQUENCE NUMBERS AND NOT A CLOCK. It is tempting to timestamp
 * every frame and drop the ones that are "late". But late relative to what?
 * The device has no synchronised clock, and the only honest measure of
 * lateness — how much audio is already queued ahead of this frame — is a
 * property of the buffer, not of the frame. Meanwhile the decisions that
 * actually matter are all about IDENTITY: which call, which answer, which
 * frame within that answer. Identity is exact, needs no clock, and makes
 * every case here decidable from three integers. Timestamps still ride along
 * on the wire, but for measuring the network, not for driving this.
 *
 * WHY THE DEVICE AND NOT THE SERVER. A server that paces frames to arrive
 * "just in time" is guessing at a network it cannot see, and every version of
 * that guess has been wrong in a way a listener could hear: too fast overran
 * the device's buffer and threw speech away on arrival; too slow left the
 * buffer empty and inserted silence. The device knows exactly how much audio
 * it is holding. So the server sends everything at once and the device owns
 * the playout clock — which also means a barge-in is instant, because
 * discarding a queued answer is a local act.
 */

#include <stdbool.h>
#include <stdint.h>

/** What the caller must do with the frame it just received. */
enum iterate_kit_playout_action {
  /** Not ours, already played, or belongs to an answer that was talked over. */
  ITERATE_KIT_PLAYOUT_IGNORE = 0,
  /** Ordinary speech: write it after whatever is already queued. */
  ITERATE_KIT_PLAYOUT_APPEND = 1,
  /** A newer answer has started: discard the queue, then write this frame. */
  ITERATE_KIT_PLAYOUT_REPLACE = 2,
};

/**
 * The identity of one frame of speech, as it arrives on the wire.
 *
 * `call` and `answer` both count UP and never repeat within a call: the
 * server assigns `answer` when the model starts speaking, so a barge-in is
 * expressed simply as the next answer having a higher number. `frame` counts
 * from zero within each answer, which is what makes a gap detectable without
 * knowing how long the answer will be.
 */
struct iterate_kit_playout_frame {
  uint32_t call;
  uint32_t answer;
  uint32_t frame;
};

/**
 * What the device believes it is playing, plus a census of everything it
 * decided not to play.
 *
 * The counters are not decoration. "The speaker went quiet" has several
 * causes that sound identical in a room and are trivially distinguishable
 * here: frames for a call we had already left, frames from an answer the
 * person interrupted, duplicates from an overlapping connection recycle, or a
 * genuine hole in the sequence. Reporting only "frames played" made all four
 * look like the network.
 */
struct iterate_kit_playout {
  /** The call whose speech we accept. Anything else is somebody else's. */
  uint32_t call;
  /** The answer currently being played; frames from older ones are stale. */
  uint32_t answer;
  /** Highest frame number accepted within `answer`. */
  uint32_t frame;
  /** False until the first frame of `answer` has been accepted. */
  bool answer_started;
  /**
   * The answer the person talked over, if any, and whether there is one.
   *
   * Kept as a NAME rather than expressed by advancing `answer`, because the
   * local side must never author a number the sender then has to catch up
   * to: local interrupts fire on every press of the talk button while the
   * sender numbers only the answers it actually speaks, so an invented
   * number drifts ahead and silences the device permanently.
   */
  uint32_t abandoned;
  bool has_abandoned;
  uint32_t appended;
  uint32_t replaced;
  uint32_t ignored_other_call;
  uint32_t ignored_stale_answer;
  uint32_t ignored_duplicate;
  /**
   * Frames that never arrived, counted where the hole appears rather than
   * inferred afterwards from a total. A count computed by subtraction cannot
   * tell a lost frame from one that was never sent.
   */
  uint32_t gaps;
};

/**
 * Begin, or re-begin, on `call`. Everything already queued belongs to the
 * previous call and the caller must discard it: a device that carries speech
 * across a hang-up plays the end of the last conversation into the start of
 * the next one.
 */
void iterate_kit_playout_reset(
    struct iterate_kit_playout *playout, uint32_t call);

/**
 * Decide what to do with `frame`, AND record the decision.
 *
 * Deciding and recording are one step on purpose. Split in two, every caller
 * would carry an obligation to report back what it did, and a caller that
 * forgot would accept the same frame twice for as long as the connection
 * lived — which is exactly the kind of defect that is inaudible in a test and
 * ruinous in a room. A test can still assert on nothing but the returned
 * sequence of actions.
 */
enum iterate_kit_playout_action iterate_kit_playout_classify(
    struct iterate_kit_playout *playout,
    const struct iterate_kit_playout_frame *frame);

/**
 * The person has started speaking, so whatever is queued is no longer wanted.
 *
 * This is deliberately a LOCAL act with no round trip: the server will also
 * cancel the answer and the next frames will carry a higher `answer` number,
 * but waiting for that to arrive is waiting a whole network round trip while
 * the assistant talks over the person. Frames from the abandoned answer that
 * are already in flight are ignored on arrival, because `answer` has moved on.
 */
void iterate_kit_playout_interrupt(struct iterate_kit_playout *playout);

/** Human-readable action name, for logs and test failure messages. */
const char *iterate_kit_playout_action_name(
    enum iterate_kit_playout_action action);

#endif /* ITERATE_KIT_AUDIO_PLAYOUT_H */
