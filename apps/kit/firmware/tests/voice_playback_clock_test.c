#include "iterate/kit/voice_device_profile.h"
#include "iterate/kit/voice_playback_clock.h"

#include <assert.h>

enum {
  FRAME_MS = ITERATE_KIT_VOICE_FRAME_MS,
  BYTES_PER_MS = 32,
  ONE_CHUNK_BYTES = 100 * BYTES_PER_MS, /* the sender's 100 ms chunk */
  CATCHUP_MS = ITERATE_KIT_VOICE_SPEAKER_LAG_CATCHUP_MS,
  PRIME_WAIT_MS = ITERATE_KIT_VOICE_SPEAKER_PRIME_WAIT_MS,
};

/* Leaves priming the way an owner does: with the prefill in the ring. */
static void leave_priming(struct iterate_kit_voice_playback_clock *clock) {
  assert(iterate_kit_voice_playback_clock_ready(
      clock, ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES, 1000U));
}

/*
 * Plays one frame at `at_ms` from a ring holding `queued_bytes` behind it,
 * the way both owners do: the decision, then the report of what was played.
 */
static void play_frame(
    struct iterate_kit_voice_playback_clock *clock,
    uint32_t queued_bytes,
    uint64_t at_ms) {
  assert(iterate_kit_voice_playback_clock_frame(
             clock, queued_bytes, FRAME_MS, at_ms) ==
      ITERATE_KIT_VOICE_PLAYBACK_PLAY);
  iterate_kit_voice_playback_clock_played(clock, at_ms, FRAME_MS);
}

/*
 * The opening bridge burst is useful only if playback waits for the device's
 * real prefill.  Starting one byte early recreates the zero-margin opening
 * that made every answer starve at its first network hiccup.
 */
static void opening_prefill_is_exact(void) {
  struct iterate_kit_voice_playback_clock clock;
  iterate_kit_voice_playback_clock_init(&clock);
  assert(!iterate_kit_voice_playback_clock_ready(
      &clock, ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES - 1U, 1000U));
  assert(iterate_kit_voice_playback_clock_ready(
      &clock, ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES, 1000U));
}

/*
 * A SHORT ANSWER DOES NOT WAIT FOR ITS MARKER. The sender emits a chunk every
 * 100 ms while the model speaks and marks the end only after 700 ms of
 * silence; an answer shorter than the prefill would otherwise sit in the ring
 * until that marker. Priming ends PRIME_WAIT_MS after audio first appeared —
 * exactly when a long answer's prefill would have filled — and then stays
 * over, however little is queued.
 */
static void a_short_answer_starts_at_the_prime_wait(void) {
  struct iterate_kit_voice_playback_clock clock;
  iterate_kit_voice_playback_clock_init(&clock);
  /* 100 ms queued: the wait starts now. */
  assert(!iterate_kit_voice_playback_clock_ready(&clock, ONE_CHUNK_BYTES, 1000U));
  assert(clock.priming_since_ms == 1000U);
  /* Another chunk 100 ms later: still below the prefill, still waiting. */
  assert(!iterate_kit_voice_playback_clock_ready(
      &clock, 2U * ONE_CHUNK_BYTES, 1100U));
  /* One millisecond short of the wait: not yet. */
  assert(!iterate_kit_voice_playback_clock_ready(
      &clock, 2U * ONE_CHUNK_BYTES, 1000U + PRIME_WAIT_MS - 1U));
  /* The wait is up: play what is there. */
  assert(iterate_kit_voice_playback_clock_ready(
      &clock, 2U * ONE_CHUNK_BYTES, 1000U + PRIME_WAIT_MS));
  assert(!clock.priming);
  /* Out of priming, a ring below the prefill is still ready. */
  assert(iterate_kit_voice_playback_clock_ready(
      &clock, ONE_CHUNK_BYTES, 1000U + PRIME_WAIT_MS + FRAME_MS));
}

/*
 * A JITTER GAP DURING PRIMING DOES NOT START PLAYBACK EARLY. Counted from the
 * first chunk, a 200 ms silence after it changes nothing: the ring keeps
 * collecting until the wait is up or the prefill is in.
 */
static void a_jitter_gap_during_priming_does_not_start_early(void) {
  struct iterate_kit_voice_playback_clock clock;
  iterate_kit_voice_playback_clock_init(&clock);
  assert(!iterate_kit_voice_playback_clock_ready(&clock, ONE_CHUNK_BYTES, 1000U));
  /* 200 ms with nothing new — a late frame, not an ended answer. */
  assert(!iterate_kit_voice_playback_clock_ready(&clock, ONE_CHUNK_BYTES, 1200U));
  assert(clock.priming);
  /* The late chunk lands; the prefill is reached, playback starts. */
  assert(iterate_kit_voice_playback_clock_ready(
      &clock, ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES, 1210U));
}

/* Nothing queued is nothing to play, however long the wait: the wait does
 * not even begin until audio is there. */
static void an_empty_ring_never_starts_on_time(void) {
  struct iterate_kit_voice_playback_clock clock;
  iterate_kit_voice_playback_clock_init(&clock);
  assert(!iterate_kit_voice_playback_clock_ready(&clock, 0U, 1000U));
  assert(!iterate_kit_voice_playback_clock_ready(&clock, 0U, 9000U));
  assert(clock.priming && clock.priming_since_ms == 0U);
  assert(!iterate_kit_voice_playback_clock_ready(&clock, ONE_CHUNK_BYTES, 9000U));
  assert(iterate_kit_voice_playback_clock_ready(
      &clock, ONE_CHUNK_BYTES, 9000U + PRIME_WAIT_MS));
}

/*
 * A HOLE MID-ANSWER IS CONCEALED, NOT RE-PRIMED. Once the opening prefill is
 * spent, a 200 ms jitter gap leaves the ring dry for a beat; the clock
 * conceals and the next frame plays at once — it does not go back to
 * collecting 300 ms.
 */
static void a_jitter_gap_after_priming_does_not_reprime(void) {
  struct iterate_kit_voice_playback_clock clock;
  iterate_kit_voice_playback_clock_init(&clock);
  leave_priming(&clock);
  play_frame(&clock, ONE_CHUNK_BYTES, 1000U);
  assert(iterate_kit_voice_playback_clock_empty(&clock, 1200U) ==
      ITERATE_KIT_VOICE_PLAYBACK_CONCEAL);
  assert(!clock.priming);
  /* A chunk lands 220 ms later, well below the prefill: plays now. */
  assert(iterate_kit_voice_playback_clock_ready(&clock, ONE_CHUNK_BYTES, 1220U));
}

/*
 * CONCEALING COSTS NOTHING. A dry tick keeps the sink moving with silence and
 * every real frame that follows is still played.
 *
 * This asserted the opposite until the device proved it wrong. Repaying
 * concealment by dropping a later frame was correct against a sender that
 * PACED audio to a schedule — 20 ms of silence put playback 20 ms late, and
 * dropping one frame put it back on the clock. That sender is gone: the whole
 * answer arrives at once and this device owns the clock, so there is no
 * schedule to be late for and the debt is a machine for deleting words.
 *
 * Measured on the device, one answer: 298 frames arrived with no loss, no
 * overflow and no bad frames; 107 were dropped to repay 107 concealed, and
 * 191 were played. A third of the answer thrown away to pay for silence
 * nobody asked for — heard, and reported, as words clipped out of the first
 * sentence.
 */
static void concealment_never_costs_a_real_frame(void) {
  struct iterate_kit_voice_playback_clock clock;
  uint32_t index;
  iterate_kit_voice_playback_clock_init(&clock);
  leave_priming(&clock);
  /* Ten dry ticks: ten frames of inserted silence. */
  for (index = 0U; index < 10U; ++index) {
    assert(iterate_kit_voice_playback_clock_empty(&clock, 1000U + index * 20U) ==
        ITERATE_KIT_VOICE_PLAYBACK_CONCEAL);
  }
  assert(iterate_kit_voice_playback_clock_audio_arrived(&clock, 1200U));
  /* Every frame that arrives after them is PLAYED. None pays for anything. */
  for (index = 0U; index < 10U; ++index) {
    play_frame(&clock, 0U, 1200U + index * 20U);
  }
}

/*
 * response.done turns an empty ring into normal answer completion, never an
 * underrun.  If this regresses every healthy answer contributes a false hole
 * and the endurance report cannot distinguish a broken lane from success.
 */
static void completed_answer_returns_to_priming_without_silence(void) {
  struct iterate_kit_voice_playback_clock clock;
  iterate_kit_voice_playback_clock_init(&clock);
  leave_priming(&clock);
  iterate_kit_voice_playback_clock_answer_done(&clock);
  assert(iterate_kit_voice_playback_clock_empty(&clock, 1000U) ==
      ITERATE_KIT_VOICE_PLAYBACK_WAIT);
  assert(!iterate_kit_voice_playback_clock_ready(&clock, 0U, 1000U));
}

/*
 * BEING LATE HAS TO END.
 *
 * Measured on hardware with no lag rule at all: playback drifted 2772 ms
 * behind its own timeline across three turns and stayed there, because
 * nothing in the design ever returns to realtime — a listener who is behind
 * can only catch up by playing less than arrives.
 *
 * The old rule keyed on queue DEPTH, which cannot see this: a deep queue
 * means the sender was fast, not that playback is late, so the threshold had
 * to be set just under the ring and consequently never fired.
 *
 * AND A SKIPPED FRAME SPENDS ITS PLACE IN THE TIMELINE, which is what makes
 * "skip until level" terminate: 900 ms late with a second queued is exactly
 * twenty skips, then the next frame plays. Leave the timeline alone on a skip
 * and it would skip the whole second — measured, 78 of 162 frames.
 */
static void falling_behind_its_timeline_is_recovered(void)
{
  struct iterate_kit_voice_playback_clock clock;
  const uint32_t backlog = 1000U * BYTES_PER_MS; /* a second waiting */
  const uint32_t late_by = 900U;
  uint64_t now;
  uint32_t index;

  iterate_kit_voice_playback_clock_init(&clock);
  leave_priming(&clock);
  play_frame(&clock, backlog, 1000U); /* the timeline's origin */
  now = 1000U + FRAME_MS + late_by; /* the next frame is due; we are late */
  assert(iterate_kit_voice_playback_clock_lag_ms(&clock, now) == late_by);
  /*
   * Late WITH A BACKLOG, which is the only case worth skipping: it keeps
   * skipping until level, rather than trimming one frame in fifty — measured,
   * that recovered 60 ms against 3.1 s of lag, so the answer ended long
   * before the device was level and it simply stayed behind.
   */
  for (index = 0U; index < (late_by - CATCHUP_MS) / FRAME_MS; ++index) {
    assert(
        iterate_kit_voice_playback_clock_frame(
            &clock, backlog, FRAME_MS, now) ==
        ITERATE_KIT_VOICE_PLAYBACK_DROP_CATCHUP);
  }
  /* Level again: skipping stops at once, so the cut is bounded by the lag. */
  assert(iterate_kit_voice_playback_clock_lag_ms(&clock, now) == CATCHUP_MS);
  play_frame(&clock, backlog, now);
  /*
   * And late with NOTHING QUEUED plays: the next frame is the live edge, so
   * discarding it would delete speech and recover nothing. Unguarded, this
   * ate the opening of every answer — lag peaks exactly when one starts.
   */
  play_frame(&clock, 0U, now + 3000U);
}

/*
 * A TIMELINE THAT LOST ITS FOOTING IS NOT A STALL. The back-office turn of
 * 2026-09-09: an answer ends, the ring runs dry for nine seconds while the
 * colleague works, and the follow-up answers arrive at exactly playback rate.
 * Measured against the first answer's clock the device is "nine seconds
 * late", the ring never holds more than the chunk that just landed, and the
 * old rule skipped four frames in five of a 71-second answer without the lag
 * ever moving. With one chunk queued there is nothing to catch up INTO: the
 * frame is played. Half a second waiting is a stall's signature and is still
 * skipped.
 *
 * The lag here is manufactured — the timeline is started and then abandoned
 * for nine seconds without the dry tick that would forget it — because the
 * guard has to hold even when the timeline is wrong.
 */
static void seconds_of_lag_with_only_a_chunk_queued_is_played(void)
{
  struct iterate_kit_voice_playback_clock clock;
  const uint32_t half_a_second = CATCHUP_MS * BYTES_PER_MS;
  uint64_t now = 1000U;
  uint32_t index;
  iterate_kit_voice_playback_clock_init(&clock);
  leave_priming(&clock);
  play_frame(&clock, ONE_CHUNK_BYTES, now);
  now += 9000U;
  assert(iterate_kit_voice_playback_clock_lag_ms(&clock, now) > 8000U);
  for (index = 0U; index < 50U; ++index, now += FRAME_MS) {
    play_frame(&clock, ONE_CHUNK_BYTES, now);
  }
  assert(
      iterate_kit_voice_playback_clock_frame(
          &clock, half_a_second, FRAME_MS, now) ==
      ITERATE_KIT_VOICE_PLAYBACK_DROP_CATCHUP);
}

/*
 * AN ANSWER THAT ENDED DOES NOT MAKE THE NEXT ONE LATE.
 *
 * This is the reset both owners used to carry themselves, and each forgot on
 * one path: the board on ordinary turns (a fifth of every answer after the
 * first, for a week), the host CLI on its live-audio dry path (nine seconds
 * of "lag" after a back-office wait, four frames in five discarded). The
 * clock forgets the timeline in the same call that decides the ring is at the
 * live edge, so a caller can no longer skip the reset by skipping a branch.
 */
static void an_answer_that_ended_does_not_make_the_next_one_late(void)
{
  struct iterate_kit_voice_playback_clock clock;
  uint64_t now = 1000U;
  uint32_t index;
  iterate_kit_voice_playback_clock_init(&clock);
  leave_priming(&clock);
  for (index = 0U; index < 10U; ++index, now += FRAME_MS) {
    play_frame(&clock, ONE_CHUNK_BYTES, now);
  }
  /* The sender said it was over; the ring runs dry; playback settles. */
  iterate_kit_voice_playback_clock_answer_done(&clock);
  assert(iterate_kit_voice_playback_clock_empty(&clock, now) ==
      ITERATE_KIT_VOICE_PLAYBACK_WAIT);
  /* Nine seconds of the colleague working. */
  now += 9000U;
  assert(iterate_kit_voice_playback_clock_lag_ms(&clock, now) == 0U);
  /* The follow-up answer, at playback rate, with the sender's 4 s lead. */
  leave_priming(&clock);
  for (index = 0U; index < 100U; ++index, now += FRAME_MS) {
    play_frame(&clock, 4000U * BYTES_PER_MS, now);
    assert(iterate_kit_voice_playback_clock_lag_ms(&clock, now) == 0U);
  }
}

/*
 * AND SO DOES ONE THAT STALLED WITHOUT BEING DECLARED OVER: silence past the
 * conceal limit is the clock giving the answer up, and the timeline goes with
 * it — a stall the source never recovered from is not a debt the next answer
 * owes.
 */
static void a_given_up_answer_is_forgotten_too(void)
{
  struct iterate_kit_voice_playback_clock clock;
  uint64_t now = 1000U;
  iterate_kit_voice_playback_clock_init(&clock);
  leave_priming(&clock);
  play_frame(&clock, 0U, now);
  now += ITERATE_KIT_VOICE_SPEAKER_CONCEAL_LIMIT_MS; /* still within it */
  assert(iterate_kit_voice_playback_clock_empty(&clock, now) ==
      ITERATE_KIT_VOICE_PLAYBACK_CONCEAL);
  assert(iterate_kit_voice_playback_clock_lag_ms(&clock, now) > 0U);
  now += 1U; /* and now past it */
  assert(iterate_kit_voice_playback_clock_empty(&clock, now) ==
      ITERATE_KIT_VOICE_PLAYBACK_WAIT);
  assert(iterate_kit_voice_playback_clock_lag_ms(&clock, now + 60000U) == 0U);
}

/*
 * A FLUSH FORGETS THE ANSWER'S TIMELINE. A new call, a barge-in, a new turn:
 * all reprime, and none of them may keep the last answer's clock — a new
 * CALL once did, on the board, and its first audio was measured against an
 * answer minutes old (34 frames skipped, `spkLagMaxMs` 117,083).
 */
static void a_flush_forgets_the_answers_timeline(void)
{
  struct iterate_kit_voice_playback_clock clock;
  iterate_kit_voice_playback_clock_init(&clock);
  leave_priming(&clock);
  play_frame(&clock, 0U, 1000U);
  iterate_kit_voice_playback_clock_reprime(&clock);
  assert(iterate_kit_voice_playback_clock_lag_ms(&clock, 120000U) == 0U);
  leave_priming(&clock);
  play_frame(&clock, 1000U * BYTES_PER_MS, 120000U);
}

/*
 * THE WORST LAG IS REMEMBERED, from the moment the frame was handed over —
 * telemetry, so a run can prove "never late" with a number and not a count of
 * holes.
 */
static void the_worst_lag_is_remembered(void)
{
  struct iterate_kit_voice_playback_clock clock;
  iterate_kit_voice_playback_clock_init(&clock);
  leave_priming(&clock);
  play_frame(&clock, 0U, 1000U);
  play_frame(&clock, 0U, 1320U); /* 300 ms late, nothing to skip into */
  play_frame(&clock, 0U, 1340U); /* and back on time relative to that */
  assert(clock.lag_max_ms == 300U);
}

/*
 * And on time, nothing is dropped for being deep. Deleting speech from the
 * middle of a sentence because the sender was quick is the failure the depth
 * rule had to be all but disabled to avoid.
 *
 * EIGHT SECONDS, WHICH IS TWICE THE SENDER'S BUDGET. voice-agent2 holds the
 * device to MAX_DEVICE_SPEAKER_BACKLOG_BYTES — 128,000 bytes, four seconds —
 * so a ring this deep is already past anything the sender should produce.
 * Depth alone still must not cost a frame: there was a second catch-up rule
 * that fired on exactly this, and it is gone. Lateness is the only signal.
 */
static void a_deep_queue_on_time_loses_nothing(void)
{
  struct iterate_kit_voice_playback_clock clock;
  const uint32_t deep = 8000U * BYTES_PER_MS; /* twice the sender's budget */
  uint32_t index;

  iterate_kit_voice_playback_clock_init(&clock);
  leave_priming(&clock);
  for (index = 0U; index < 200U; ++index) {
    play_frame(&clock, deep, 1000U + index * 20U);
  }
  assert(clock.lag_max_ms == 0U);
}

/*
 * A STARVE GOES STALE. Both owners promote a hole to an underrun only when
 * audio resumes within a second of it; a gap between turns proves nothing
 * about the answer that ended, and counting it made the metric read one
 * underrun per answer.
 */
static void a_starve_older_than_a_second_is_not_an_underrun(void)
{
  struct iterate_kit_voice_playback_clock clock;
  iterate_kit_voice_playback_clock_init(&clock);
  leave_priming(&clock);
  assert(iterate_kit_voice_playback_clock_empty(&clock, 1000U) ==
      ITERATE_KIT_VOICE_PLAYBACK_CONCEAL);
  assert(!iterate_kit_voice_playback_clock_audio_arrived(&clock, 2000U));
  /* And the stamp is spent: the same arrival cannot be charged twice. */
  assert(iterate_kit_voice_playback_clock_empty(&clock, 2000U) ==
      ITERATE_KIT_VOICE_PLAYBACK_CONCEAL);
  assert(iterate_kit_voice_playback_clock_audio_arrived(&clock, 2500U));
  assert(!iterate_kit_voice_playback_clock_audio_arrived(&clock, 2500U));
}

int main(void) {
  opening_prefill_is_exact();
  a_starve_older_than_a_second_is_not_an_underrun();
  a_short_answer_starts_at_the_prime_wait();
  a_jitter_gap_during_priming_does_not_start_early();
  an_empty_ring_never_starts_on_time();
  a_jitter_gap_after_priming_does_not_reprime();
  concealment_never_costs_a_real_frame();
  completed_answer_returns_to_priming_without_silence();
  falling_behind_its_timeline_is_recovered();
  seconds_of_lag_with_only_a_chunk_queued_is_played();
  an_answer_that_ended_does_not_make_the_next_one_late();
  a_given_up_answer_is_forgotten_too();
  a_flush_forgets_the_answers_timeline();
  the_worst_lag_is_remembered();
  a_deep_queue_on_time_loses_nothing();
  return 0;
}
