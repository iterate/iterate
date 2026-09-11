/*
 * THE SHARED PLAYOUT STEP, DRIVEN BY A SCRIPTED RING AND SINK.
 *
 * The board's answer-clock test proves the step through a real queue and a
 * fake codec; the CLI's paced-sink test proves it through the CLI's ring and
 * converter. This file proves the step ITSELF: every branch, with the ring
 * and the sink reduced to arrays and counters, so a rule that both targets
 * depend on is asserted once where both can see it.
 */
#include "iterate/kit/voice_device_profile.h"
#include "iterate/kit/voice_playout.h"

#include <assert.h>
#include <stdbool.h>
#include <string.h>

enum {
  FRAME_BYTES = ITERATE_KIT_VOICE_FRAME_BYTES,
  FRAME_MS = ITERATE_KIT_VOICE_FRAME_MS,
  BYTES_PER_MS = FRAME_BYTES / FRAME_MS,
  /** Enough frames for the clock to leave priming, whatever the prefill is. */
  PREFILL_FRAMES = ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES / FRAME_BYTES + 1,
  RING_FRAMES = 1024,
};

/* --- a ring that is an array ---------------------------------------------- */

static struct {
  uint8_t frames[RING_FRAMES][FRAME_BYTES];
  uint32_t head;
  uint32_t tail;
  bool abandon_next;
  uint8_t out[FRAME_BYTES];
} ring_state;

static void ring_deliver(uint32_t frames) {
  while (frames-- > 0U) {
    memset(
        ring_state.frames[ring_state.tail % RING_FRAMES],
        (int)(ring_state.tail + 1U),
        FRAME_BYTES);
    ++ring_state.tail;
  }
}

static uint32_t ring_queued_bytes(void *context) {
  (void)context;
  return (ring_state.tail - ring_state.head) * (uint32_t)FRAME_BYTES;
}

static enum iterate_kit_voice_playout_read ring_read(
    void *context, const uint8_t **frame, size_t *length) {
  (void)context;
  if (ring_state.abandon_next) {
    ring_state.abandon_next = false;
    if (ring_state.tail > ring_state.head) ++ring_state.head;
    return ITERATE_KIT_VOICE_PLAYOUT_READ_ABANDONED;
  }
  if (ring_state.tail == ring_state.head) {
    return ITERATE_KIT_VOICE_PLAYOUT_READ_DRY;
  }
  memcpy(
      ring_state.out,
      ring_state.frames[ring_state.head % RING_FRAMES],
      FRAME_BYTES);
  ++ring_state.head;
  *frame = ring_state.out;
  *length = FRAME_BYTES;
  return ITERATE_KIT_VOICE_PLAYOUT_READ_FRAME;
}

static const struct iterate_kit_voice_playout_ring ring = {
  .context = NULL,
  .queued_bytes = ring_queued_bytes,
  .read = ring_read,
};

/* --- a sink that counts, with a clock it owns ------------------------------ */

static struct {
  uint64_t now_ms;
  /** How long the speaker makes a write wait for headroom. */
  uint32_t admission_wait_ms;
  enum iterate_kit_voice_playout_write next_write;
  uint32_t written;
  uint32_t concealed;
  uint8_t last_written;
} sink_state;

static uint64_t sink_now_ms(void *context) {
  (void)context;
  return sink_state.now_ms;
}

static enum iterate_kit_voice_playout_write sink_write(
    void *context, const uint8_t *frame, size_t length) {
  (void)context;
  assert(length == (size_t)FRAME_BYTES);
  sink_state.now_ms += sink_state.admission_wait_ms;
  if (sink_state.next_write == ITERATE_KIT_VOICE_PLAYOUT_WRITE_OK) {
    ++sink_state.written;
    sink_state.last_written = frame[0];
  }
  return sink_state.next_write;
}

static bool sink_conceal(void *context) {
  (void)context;
  ++sink_state.concealed;
  return true;
}

static const struct iterate_kit_voice_playout_sink concealing_sink = {
  .context = NULL,
  .now_ms = sink_now_ms,
  .write = sink_write,
  .conceal = sink_conceal,
};

/* A board: the DAC clocks out its own zeros, so nothing is inserted. */
static const struct iterate_kit_voice_playout_sink hardware_sink = {
  .context = NULL,
  .now_ms = sink_now_ms,
  .write = sink_write,
  .conceal = NULL,
};

static struct iterate_kit_voice_playout playout;

static void reset(uint64_t now_ms) {
  memset(&ring_state, 0, sizeof(ring_state));
  memset(&sink_state, 0, sizeof(sink_state));
  sink_state.now_ms = now_ms;
  iterate_kit_voice_playout_init(&playout);
}

static enum iterate_kit_voice_playout_outcome step(
    const struct iterate_kit_voice_playout_sink *sink) {
  return iterate_kit_voice_playout_step(&playout, &ring, sink);
}

/** One on-time tick: the step, then the frame period passes. */
static enum iterate_kit_voice_playout_outcome tick(
    const struct iterate_kit_voice_playout_sink *sink) {
  const enum iterate_kit_voice_playout_outcome outcome = step(sink);
  sink_state.now_ms += FRAME_MS;
  return outcome;
}

/* --- the tests ------------------------------------------------------------ */

static void nothing_plays_before_prefill(void) {
  reset(1000U);
  ring_deliver(1U);
  assert(step(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_PRIMING);
  assert(playout.stats.waits_priming == 1U);
  assert(sink_state.written == 0U && ring_queued_bytes(NULL) == FRAME_BYTES);
  ring_deliver(PREFILL_FRAMES);
  assert(step(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_PLAYED);
  assert(sink_state.last_written == 1U); /* in order, from the first */
}

/*
 * A whole answer plays, and the dry ring after it is the END, not a hole:
 * nothing is concealed, and the timeline is forgotten so that nothing is
 * late afterwards however long the silence.
 */
/*
 * A SHORT ANSWER PLAYS AT THE PRIME WAIT, WITHOUT A MARKER. 100 ms of answer,
 * a third of the prefill, and no `last`: the ring waits exactly as long as a
 * long answer's prefill would have taken to fill, then plays every frame.
 */
static void a_short_answer_plays_at_the_prime_wait(void) {
  uint32_t index;
  reset(1000U);
  ring_deliver(5U);
  assert(step(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_PRIMING);
  sink_state.now_ms = 1000U + ITERATE_KIT_VOICE_SPEAKER_PRIME_WAIT_MS - 1U;
  assert(step(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_PRIMING);
  sink_state.now_ms += 1U;
  for (index = 0U; index < 5U; ++index) {
    assert(tick(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_PLAYED);
  }
  assert(sink_state.written == 5U);
  assert(sink_state.concealed == 0U);
}

/*
 * A JITTER GAP DURING PRIMING DOES NOT START PLAYBACK EARLY. A chunk, then
 * 200 ms of nothing (a late frame on a jittery link), then the rest: the ring
 * keeps priming through the gap and starts when the prefill is in.
 */
static void a_jitter_gap_during_priming_does_not_start_early(void) {
  reset(1000U);
  ring_deliver(5U);
  assert(step(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_PRIMING);
  sink_state.now_ms = 1200U;
  assert(step(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_PRIMING);
  assert(sink_state.written == 0U);
  ring_deliver((uint32_t)PREFILL_FRAMES - 5U);
  sink_state.now_ms = 1210U;
  assert(step(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_PLAYED);
}

/*
 * A LONG ANSWER STILL PRIMES TO THE PREFILL. Chunks every 100 ms reach the
 * prefill before the wait is up, so playback starts on bytes, as before.
 */
static void an_arriving_answer_still_primes_to_the_prefill(void) {
  uint32_t delivered = 0U;
  reset(1000U);
  while ((delivered + 5U) * (uint32_t)FRAME_BYTES <
         (uint32_t)ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES) {
    ring_deliver(5U);
    delivered += 5U;
    assert(step(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_PRIMING);
    sink_state.now_ms += 100U;
    assert(step(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_PRIMING);
  }
  /* The chunk that reaches the prefill starts playback at once. */
  ring_deliver((uint32_t)PREFILL_FRAMES - delivered);
  assert(step(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_PLAYED);
  assert(playout.stats.waits_priming > 0U);
}

static void an_answer_plays_whole_then_settles(void) {
  uint32_t index;
  reset(1000U);
  ring_deliver(50U);
  iterate_kit_voice_playback_clock_answer_done(&playout.clock);
  for (index = 0U; index < 50U; ++index) {
    assert(tick(&concealing_sink) == ITERATE_KIT_VOICE_PLAYOUT_PLAYED);
  }
  assert(sink_state.written == 50U && playout.stats.frames_played == 50U);
  assert(playout.stats.writes == 50U);
  assert(playout.stats.margin_max_ms == 49U * FRAME_MS);
  assert(playout.stats.margin_min_ms == 0U);
  assert(playout.clock.lag_max_ms == 0U);
  assert(tick(&concealing_sink) == ITERATE_KIT_VOICE_PLAYOUT_SETTLED);
  assert(playout.stats.waits_dry == 1U && sink_state.concealed == 0U);
  assert(playout.stats.conceal_frames == 0U);
  assert(iterate_kit_voice_playback_clock_lag_ms(
             &playout.clock, sink_state.now_ms + 60000U) == 0U);
  /* And the ring is priming again: a lone frame waits for company. */
  ring_deliver(1U);
  assert(step(&concealing_sink) == ITERATE_KIT_VOICE_PLAYOUT_PRIMING);
}

/*
 * A dry ring MID-ANSWER is a hole. It is counted on every target — that is
 * telemetry about the pipe — and filled only by a sink that has nothing
 * behind it clocking out zeros already. And the answer resumes played, not
 * skipped: a hole is not a backlog.
 */
static void a_hole_mid_answer_is_concealed_only_by_a_sink_that_can(void) {
  uint32_t index;
  reset(1000U);
  ring_deliver((uint32_t)PREFILL_FRAMES);
  for (index = 0U; index < (uint32_t)PREFILL_FRAMES; ++index) {
    assert(tick(&concealing_sink) == ITERATE_KIT_VOICE_PLAYOUT_PLAYED);
  }
  assert(tick(&concealing_sink) == ITERATE_KIT_VOICE_PLAYOUT_STARVED);
  assert(sink_state.concealed == 1U && playout.stats.conceal_frames == 1U);
  assert(tick(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_STARVED);
  assert(sink_state.concealed == 1U && playout.stats.conceal_frames == 2U);
  assert(playout.stats.waits_dry == 2U);
  ring_deliver(1U);
  assert(tick(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_PLAYED);
  assert(playout.stats.catchup_frames == 0U);
}

/*
 * THE BACK-OFFICE TURN OF 2026-09-09, AT THE STEP. An answer ends; the
 * colleague works for nine seconds; the follow-up arrives with the sender's
 * four-second lead and then at playback rate. Measured against the first
 * answer's clock that is nine seconds of lag with four seconds queued — the
 * catch-up rule's exact trigger — and the host CLI discarded four frames in
 * five for the rest of the turn. The step forgets the timeline when the
 * first answer settles, on whichever path found the ring dry.
 */
static void an_answer_after_a_long_silence_is_on_time(void) {
  uint32_t index;
  reset(1000U);
  ring_deliver(20U);
  iterate_kit_voice_playback_clock_answer_done(&playout.clock);
  for (index = 0U; index < 20U; ++index) {
    assert(tick(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_PLAYED);
  }
  assert(tick(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_SETTLED);
  sink_state.now_ms += 9000U;
  ring_deliver(200U); /* the lead: four seconds, all at once */
  for (index = 0U; index < 300U; ++index) {
    assert(tick(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_PLAYED);
    if (index % 5U == 4U) ring_deliver(5U); /* then 100 ms per 100 ms */
  }
  assert(playout.stats.catchup_frames == 0U);
  assert(playout.stats.frames_played == 320U);
  assert(playout.clock.lag_max_ms == 0U);
}

/*
 * And an answer that merely STALLED — never declared over — is given up on
 * past the conceal limit, timeline included; the next one is on time too.
 */
static void a_stalled_answer_is_given_up_and_the_next_is_on_time(void) {
  uint32_t index;
  reset(1000U);
  ring_deliver(20U);
  for (index = 0U; index < 20U; ++index) {
    assert(tick(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_PLAYED);
  }
  assert(tick(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_STARVED);
  sink_state.now_ms += ITERATE_KIT_VOICE_SPEAKER_CONCEAL_LIMIT_MS;
  assert(tick(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_SETTLED);
  sink_state.now_ms += 30000U;
  ring_deliver(200U);
  for (index = 0U; index < 200U; ++index) {
    assert(tick(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_PLAYED);
  }
  assert(playout.stats.catchup_frames == 0U);
}

/*
 * BEHIND WITH A BACKLOG, the step skips until level and then plays: 900 ms
 * late with two seconds queued is exactly twenty skipped frames, because
 * every skip spends its place in the timeline.
 */
static void a_late_answer_with_backlog_is_skipped_until_level(void) {
  uint32_t index;
  reset(1000U);
  ring_deliver(100U);
  assert(step(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_PLAYED);
  sink_state.now_ms += FRAME_MS + 900U;
  for (index = 0U;
       index < (900U - ITERATE_KIT_VOICE_SPEAKER_LAG_CATCHUP_MS) / FRAME_MS;
       ++index) {
    assert(step(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_SKIPPED);
  }
  assert(playout.stats.catchup_frames == 20U);
  assert(sink_state.written == 1U);
  assert(tick(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_PLAYED);
  assert(sink_state.last_written == 22U); /* frames 2..21 were the cut */
  for (index = 0U; index < 20U; ++index) {
    assert(tick(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_PLAYED);
  }
  assert(playout.stats.catchup_frames == 20U);
}

/* A frame of a flushed answer is nobody's: not played, not a hole. */
static void an_abandoned_frame_is_neither_played_nor_a_hole(void) {
  reset(1000U);
  ring_deliver((uint32_t)PREFILL_FRAMES + 1U);
  ring_state.abandon_next = true;
  assert(step(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_ABANDONED);
  assert(sink_state.written == 0U && playout.stats.frames_played == 0U);
  assert(playout.stats.waits_dry == 0U && playout.stats.conceal_frames == 0U);
  assert(playout.stats.catchup_frames == 0U && playout.stats.writes == 0U);
  assert(step(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_PLAYED);
  assert(sink_state.last_written == 2U);
}

/*
 * A write the speaker refuses is a failure and is counted; one abandoned
 * for a replacement is not. Neither starts the answer's timeline — only
 * audio the speaker actually took can be late.
 */
static void a_refused_write_is_counted_and_an_abandoned_one_is_not(void) {
  reset(1000U);
  ring_deliver((uint32_t)PREFILL_FRAMES + 2U);
  sink_state.next_write = ITERATE_KIT_VOICE_PLAYOUT_WRITE_FAILED;
  assert(tick(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_REFUSED);
  assert(playout.stats.write_failures == 1U && playout.stats.writes == 1U);
  assert(playout.clock.answer_started_ms == 0U);
  sink_state.next_write = ITERATE_KIT_VOICE_PLAYOUT_WRITE_ABANDONED;
  assert(tick(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_REPLACED);
  assert(playout.stats.write_failures == 1U && playout.stats.writes == 2U);
  assert(playout.clock.answer_started_ms == 0U);
  sink_state.next_write = ITERATE_KIT_VOICE_PLAYOUT_WRITE_OK;
  assert(tick(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_PLAYED);
  assert(playout.stats.frames_played == 1U && playout.stats.writes == 3U);
  assert(playout.clock.answer_started_ms != 0U);
}

/*
 * THE STAMP IS TAKEN BEFORE THE WRITE. A speaker that makes every write wait
 * for headroom must not make a punctual loop look late: the origin of the
 * timeline is when the frame was handed over, not when the DAC took it.
 */
static void the_stamp_is_taken_before_the_write(void) {
  uint32_t index;
  reset(1000U);
  sink_state.admission_wait_ms = 15U;
  ring_deliver(50U);
  for (index = 0U; index < 50U; ++index) {
    assert(step(&hardware_sink) == ITERATE_KIT_VOICE_PLAYOUT_PLAYED);
    sink_state.now_ms = 1000U + (index + 1U) * FRAME_MS; /* punctual */
  }
  assert(playout.clock.answer_started_ms == 1000U);
  assert(playout.clock.lag_max_ms == 0U);
  assert(playout.stats.catchup_frames == 0U);
}

int main(void) {
  nothing_plays_before_prefill();
  a_short_answer_plays_at_the_prime_wait();
  a_jitter_gap_during_priming_does_not_start_early();
  an_arriving_answer_still_primes_to_the_prefill();
  an_answer_plays_whole_then_settles();
  a_hole_mid_answer_is_concealed_only_by_a_sink_that_can();
  an_answer_after_a_long_silence_is_on_time();
  a_stalled_answer_is_given_up_and_the_next_is_on_time();
  a_late_answer_with_backlog_is_skipped_until_level();
  an_abandoned_frame_is_neither_played_nor_a_hole();
  a_refused_write_is_counted_and_an_abandoned_one_is_not();
  the_stamp_is_taken_before_the_write();
  return 0;
}
