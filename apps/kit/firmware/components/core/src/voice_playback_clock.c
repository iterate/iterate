#include "iterate/kit/voice_playback_clock.h"

#include "iterate/kit/voice_device_profile.h"

#include <stddef.h>
#include <string.h>

/*
 * Zero rather than `now`: the origin is then taken from the next frame that
 * actually plays, which is correct however long the gap turns out to be.
 */
static void forget_answer_timeline(
    struct iterate_kit_voice_playback_clock *clock) {
  clock->answer_started_ms = 0U;
  clock->answer_emitted_ms = 0U;
}

void iterate_kit_voice_playback_clock_init(
    struct iterate_kit_voice_playback_clock *clock) {
  if (clock == NULL) return;
  memset(clock, 0, sizeof(*clock));
  clock->priming = true;
}

void iterate_kit_voice_playback_clock_reprime(
    struct iterate_kit_voice_playback_clock *clock) {
  if (clock == NULL) return;
  clock->priming = true;
  clock->priming_since_ms = 0U;
  clock->answer_done = false;
  /*
   * AND THE ANSWER'S CLOCK GOES WITH ITS AUDIO.
   *
   * The playout timeline is per-ANSWER — frame N belongs 20N ms after the
   * first one played — so a flush, which by definition leaves no answer in
   * flight, must leave no timeline either.
   *
   * This lived in the owners, beside their flush sites. On the board it was
   * written at ONE of the four — the new-answer branch — and the other three
   * were left resetting nothing: a new CALL emptied the ring and kept the last
   * call's clock, so the first audio of the new one was measured against an
   * answer minutes old and the catch-up rule deleted it. Measured on the
   * StackChan: 34 frames skipped with `spkLagMaxMs` at 117,083. The board then
   * moved it into its one abandon funnel; the host CLI's new-turn flush still
   * reprimed without it. Here, every flush on every target resets it, because
   * every flush reprimes.
   */
  forget_answer_timeline(clock);
}

void iterate_kit_voice_playback_clock_answer_done(
    struct iterate_kit_voice_playback_clock *clock) {
  if (clock != NULL) clock->answer_done = true;
}

bool iterate_kit_voice_playback_clock_audio_arrived(
    struct iterate_kit_voice_playback_clock *clock, uint64_t now_ms) {
  bool underrun = false;
  if (clock == NULL) return false;
  /*
   * An empty ring at response end is healthy.  It becomes an underrun only
   * when more speech arrives within a second, proving the answer had a hole.
   */
  if (clock->starve_at_ms != 0U) {
    underrun = now_ms - clock->starve_at_ms < 1000U;
    clock->starve_at_ms = 0U;
  }
  clock->answer_done = false;
  return underrun;
}

uint32_t iterate_kit_voice_playback_clock_lag_ms(
    const struct iterate_kit_voice_playback_clock *clock, uint64_t now_ms) {
  if (clock == NULL) return 0U;
  return iterate_kit_voice_playout_lag_ms(
      clock->answer_started_ms, clock->answer_emitted_ms, now_ms);
}

bool iterate_kit_voice_playback_clock_ready(
    struct iterate_kit_voice_playback_clock *clock,
    uint32_t queued_bytes,
    uint64_t now_ms) {
  if (clock == NULL) return false;
  /*
   * A SHORT ANSWER NEEDS NO MARKER. The end marker used to end priming early,
   * so an answer shorter than the prefill would play; the prime wait below
   * covers it — and it arrives sooner, because the marker trails the audio by
   * the sender's 700 ms tail silence.
   */
  if (clock->priming &&
      queued_bytes < ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES) {
    /*
     * PRIMING ENDS ON TIME AS WELL AS ON BYTES. An answer shorter than the
     * prefill never fills it and its end marker is 700 ms of silence away,
     * so the wait is bounded by the prefill's own duration, counted from the
     * moment audio first appeared in this priming. Counted from the FIRST
     * chunk, not the newest: a rule keyed on "nothing new for 150 ms" fired
     * on ordinary arrival jitter and started playback with too little
     * buffered (see ITERATE_KIT_VOICE_SPEAKER_PRIME_WAIT_MS). An EMPTY ring
     * never starts: there is nothing to play.
     */
    if (queued_bytes == 0U) return false;
    if (clock->priming_since_ms == 0U) clock->priming_since_ms = now_ms;
    if (now_ms - clock->priming_since_ms < ITERATE_KIT_VOICE_SPEAKER_PRIME_WAIT_MS) {
      return false;
    }
  }
  clock->priming = false;
  clock->priming_since_ms = 0U;
  return true;
}

enum iterate_kit_voice_playback_action
iterate_kit_voice_playback_clock_empty(
    struct iterate_kit_voice_playback_clock *clock, uint64_t now_ms) {
  if (clock == NULL) return ITERATE_KIT_VOICE_PLAYBACK_WAIT;
  if (clock->answer_done ||
      (clock->last_write_ms != 0U &&
       now_ms - clock->last_write_ms >
           ITERATE_KIT_VOICE_SPEAKER_CONCEAL_LIMIT_MS)) {
    clock->answer_done = false;
    clock->priming = true;
    clock->priming_since_ms = 0U;
    /*
     * SETTLED BACK TO PRIMING, WHICH IS THE DEVICE'S OWN PROOF THAT NO
     * ANSWER IS IN FLIGHT — and therefore that nothing is late.
     *
     * This is the only branch that returns WAIT: the answer was declared
     * over, or nothing has been written for longer than the conceal limit.
     * Either way the ring is empty and playback is AT THE LIVE EDGE, so
     * whatever lag the last answer ended on is unrecoverable by definition —
     * the catch-up rule already refuses to skip into an empty ring for that
     * exact reason. Carrying the number forward does not measure anything; it
     * only waits to be charged against the next answer.
     *
     * This is the reset that needs no cooperation from the sender. The
     * reprime covers the answer that replaces a LIVE one; this covers every
     * ordinary turn, including the ones where `drop` arrives a few chunks
     * late — measured on the StackChan, where 800 ms of a new answer was
     * delivered ahead of the clear that was supposed to precede it.
     *
     * IT IS DONE HERE, NOT BY THE CALLER. Both owners used to do it beside
     * this call, and the host CLI had one dry path — live audio — that never
     * made the call at all: after a back-office wait its next answer was
     * measured against the previous one, read as nine seconds late, and lost
     * four frames in five for the rest of the turn (prd, 2026-09-09). A reset
     * that lives in the decision cannot be skipped by a path that skips it.
     */
    forget_answer_timeline(clock);
    return ITERATE_KIT_VOICE_PLAYBACK_WAIT;
  }
  /*
   * NO DEBT IS INCURRED. Concealing does not put this device behind anything.
   *
   * Repaying concealment by dropping a later real frame made sense against a
   * sender that PACED audio to a schedule: 20ms of inserted silence put
   * playback 20ms late, and dropping one frame put it back on the clock. That
   * sender is gone. The whole answer now arrives at once and this device owns
   * the playout clock, so there is no schedule to be late for — and the debt
   * became a machine for deleting words.
   *
   * Measured on the device, one answer: 298 frames arrived with no loss, no
   * overflow and no bad frames; 107 of them were dropped to repay 107
   * concealed frames, and 191 were played. A third of the answer thrown away
   * to pay for silence nobody asked for. That is exactly the "words clipped
   * out of the first sentence" a listener reports.
   *
   * The honest response to a dry buffer is to play what arrives when it
   * arrives. The answer finishes a few hundred milliseconds later than it
   * might have, which nobody notices; a missing word is all anybody notices.
   */
  clock->starve_at_ms = now_ms;
  return ITERATE_KIT_VOICE_PLAYBACK_CONCEAL;
}

enum iterate_kit_voice_playback_action
iterate_kit_voice_playback_clock_frame(
    struct iterate_kit_voice_playback_clock *clock,
    uint32_t queued_bytes,
    uint32_t frame_ms,
    uint64_t now_ms) {
  const uint32_t queued_ms = queued_bytes / 32U;
  if (clock == NULL) return ITERATE_KIT_VOICE_PLAYBACK_WAIT;
  /*
   * BEHIND ITS OWN TIMELINE, so skip forward until level again.
   *
   * SKIP, NOT TRIM. The first version of this dropped one frame in fifty —
   * 20 ms recovered per second — which is the right shape for trimming slow
   * clock drift and hopeless against a stall. Measured: 3.1 s of lag, three
   * frames dropped, 60 ms recovered; at that rate the answer ends long before
   * the device is level, so it simply stays late for the rest of the call.
   *
   * A listener who is behind can only catch up by playing less than arrives,
   * and doing that gradually means doing it audibly for a long time. Doing it
   * at once costs one visible cut and then the conversation is live again,
   * which is what a person actually wants from a voice device: they would
   * rather lose a syllable than talk to something three seconds in the past.
   *
   * The threshold is what keeps this rare — a lag this large only follows a
   * real stall, and ordinary jitter never reaches it.
   */
  /*
   * ONLY WHILE THERE IS SOMETHING TO SKIP INTO.
   *
   * Skipping recovers lag by playing less than arrived, so it is only ever
   * correct when audio is waiting. With an empty ring the next frame IS the
   * live edge — discarding it removes speech and recovers nothing, because
   * the timeline is already as current as the data allows.
   *
   * Measured without this guard: 64 of 183 frames skipped, which the listener
   * hears as the opening of an answer missing. Lag is at its highest exactly
   * when an answer starts, since the timeline begins at the first frame
   * played and prefill has already spent its cushion — so an unguarded rule
   * attacks the first words of every answer, which is precisely the part
   * nobody can afford to lose.
   */
  /*
   * ONE CATCH-UP RULE, NOT TWO. A second trigger used to sit here, firing on
   * queue DEPTH past a 9,000 ms high-water mark and dropping one frame every
   * N — and the paragraphs above are the argument against it, written beside
   * it: depth cannot tell "the sender is ahead of realtime" from "playback has
   * stalled", and dropping gradually is hopeless against a stall (3.1 s of lag,
   * three frames dropped, 60 ms recovered).
   *
   * It was also unreachable. voice-agent2 caps the device at
   * MAX_DEVICE_SPEAKER_BACKLOG_BYTES — 128,000 bytes, 4,000 ms — so 9,000 ms of
   * backlog required the server's model of this device's memory to be wrong by
   * more than five seconds. Kept as a backstop against exactly that, it was a
   * backstop nobody had ever seen fire, which is a comment rather than a
   * mechanism. If the model does go that wrong, the honest signal is the same
   * one this function already trusts: lateness against the audio timeline.
   */
  /*
   * AND ONLY WHILE AT LEAST THE THRESHOLD IS WAITING. Skipping recovers lag
   * by playing less than has arrived, so the most it can ever recover is the
   * backlog itself. A timeline that says seconds while the ring holds one
   * chunk is not a stall in the audio — a stall banks the audio it withheld
   * and the backlog shows it — it is a timeline that lost its footing: an
   * answer ended, the silence after it went on counting, and a later answer
   * is now measured against a clock it never started. Skipping into that
   * chunk recovers 20 ms a frame against arrival at the same rate, so the
   * lag never moves and every frame pays: measured on the host CLI, four in
   * five frames of a 71-second answer discarded, the listener hearing one
   * block of speech in every hundred milliseconds, for the whole answer.
   * Requiring the backlog to carry the threshold makes "skip until level"
   * mean what it says: level is reachable, in one cut, from what is queued.
   */
  if (iterate_kit_voice_playback_clock_lag_ms(clock, now_ms) >
          ITERATE_KIT_VOICE_SPEAKER_LAG_CATCHUP_MS &&
      queued_ms >= ITERATE_KIT_VOICE_SPEAKER_LAG_CATCHUP_MS) {
    /*
     * A SKIPPED FRAME STILL SPENT ITS PLACE IN THE TIMELINE.
     *
     * Skipping recovers lag only if the timeline advances as the frame is
     * discarded. Leave the counter alone and the computed lag never falls,
     * so the loop keeps deciding it is late and skips again — it drains the
     * whole backlog and the listener hears half the answer missing.
     * Measured exactly that: 78 of 162 frames skipped.
     *
     * Advancing here is what makes "skip until level" terminate at the point
     * it is level, which is the entire safety of the mechanism.
     */
    clock->answer_emitted_ms += frame_ms;
    return ITERATE_KIT_VOICE_PLAYBACK_DROP_CATCHUP;
  }
  clock->last_write_ms = now_ms;
  return ITERATE_KIT_VOICE_PLAYBACK_PLAY;
}

void iterate_kit_voice_playback_clock_played(
    struct iterate_kit_voice_playback_clock *clock,
    uint64_t played_at_ms,
    uint32_t played_ms) {
  if (clock == NULL) return;
  if (clock->answer_started_ms == 0U) {
    clock->answer_started_ms = played_at_ms;
    clock->answer_emitted_ms = 0U;
  }
  {
    const uint32_t lag =
        iterate_kit_voice_playback_clock_lag_ms(clock, played_at_ms);
    if (lag > clock->lag_max_ms) clock->lag_max_ms = lag;
  }
  /* Milliseconds actually emitted, so a short read advances the timeline by
   * what it played and not by a whole frame. */
  clock->answer_emitted_ms += played_ms;
}
