#include "iterate/kit/voice_device_profile.h"
#include "iterate/kit/voice_playback_clock.h"

#include <assert.h>

/*
 * The opening bridge burst is useful only if playback waits for the device's
 * real prefill.  Starting one byte early recreates the zero-margin opening
 * that made every answer starve at its first network hiccup.
 */
static void opening_prefill_is_exact(void) {
  struct iterate_kit_voice_playback_clock clock;
  iterate_kit_voice_playback_clock_init(&clock);
  assert(!iterate_kit_voice_playback_clock_ready(
      &clock, ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES - 1U));
  assert(iterate_kit_voice_playback_clock_ready(
      &clock, ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES));
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
  assert(iterate_kit_voice_playback_clock_ready(
      &clock, ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES));
  /* Ten dry ticks: ten frames of inserted silence. */
  for (index = 0U; index < 10U; ++index) {
    assert(iterate_kit_voice_playback_clock_empty(&clock, 1000U + index * 20U) ==
        ITERATE_KIT_VOICE_PLAYBACK_CONCEAL);
  }
  assert(iterate_kit_voice_playback_clock_audio_arrived(&clock, 1200U));
  /* Every frame that arrives after them is PLAYED. None pays for anything. */
  for (index = 0U; index < 10U; ++index) {
    assert(iterate_kit_voice_playback_clock_frame(
               &clock, 0U, index, 0U, 1200U + index * 20U) ==
        ITERATE_KIT_VOICE_PLAYBACK_PLAY);
  }
}

/*
 * Catch-up is allowed only once per second of played audio.  A free-running
 * drop loop empties seconds of backlog in milliseconds and sounds like most
 * of the answer vanished, the production defect this rate limit prevents.
 */
static void catchup_is_rate_limited(void) {
  struct iterate_kit_voice_playback_clock clock;
  const uint32_t flooded =
      (ITERATE_KIT_VOICE_SPEAKER_HIGH_WATER_MS + 1U) * 32U;
  iterate_kit_voice_playback_clock_init(&clock);
  assert(iterate_kit_voice_playback_clock_frame(&clock, flooded, 0U, 0U, 1000U) ==
      ITERATE_KIT_VOICE_PLAYBACK_DROP_CATCHUP);
  assert(iterate_kit_voice_playback_clock_frame(&clock, flooded, 0U, 0U, 1020U) ==
      ITERATE_KIT_VOICE_PLAYBACK_PLAY);
  assert(iterate_kit_voice_playback_clock_frame(
      &clock, flooded, ITERATE_KIT_VOICE_SPEAKER_CATCHUP_EVERY, 0U, 2000U) ==
      ITERATE_KIT_VOICE_PLAYBACK_DROP_CATCHUP);
}

/*
 * response.done turns an empty ring into normal answer completion, never an
 * underrun.  If this regresses every healthy answer contributes a false hole
 * and the endurance report cannot distinguish a broken lane from success.
 */
static void completed_answer_returns_to_priming_without_silence(void) {
  struct iterate_kit_voice_playback_clock clock;
  iterate_kit_voice_playback_clock_init(&clock);
  assert(iterate_kit_voice_playback_clock_ready(
      &clock, ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES));
  iterate_kit_voice_playback_clock_answer_done(&clock);
  assert(iterate_kit_voice_playback_clock_empty(&clock, 1000U) ==
      ITERATE_KIT_VOICE_PLAYBACK_WAIT);
  assert(!iterate_kit_voice_playback_clock_ready(&clock, 0U));
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
 */
static void falling_behind_its_timeline_is_recovered(void)
{
  struct iterate_kit_voice_playback_clock clock;
  const uint32_t late = ITERATE_KIT_VOICE_SPEAKER_LAG_CATCHUP_MS + 1U;

  iterate_kit_voice_playback_clock_init(&clock);
  /* Late, with an empty ring: depth would never have noticed. */
  assert(
      iterate_kit_voice_playback_clock_frame(&clock, 0U, 0U, late, 1000U) ==
      ITERATE_KIT_VOICE_PLAYBACK_DROP_CATCHUP);
  /* Rate limited, so recovery is 20ms per second rather than decimation. */
  assert(
      iterate_kit_voice_playback_clock_frame(&clock, 0U, 1U, late, 1020U) ==
      ITERATE_KIT_VOICE_PLAYBACK_PLAY);
  assert(
      iterate_kit_voice_playback_clock_frame(
          &clock, 0U, ITERATE_KIT_VOICE_SPEAKER_CATCHUP_EVERY, late, 2000U) ==
      ITERATE_KIT_VOICE_PLAYBACK_DROP_CATCHUP);
}

/*
 * And on time, nothing is ever dropped — however deep the queue. A whole
 * answer arriving at once is the normal case, and deleting speech from the
 * middle of it because the sender was quick is the failure the depth rule
 * had to be disabled to avoid.
 */
static void a_deep_queue_on_time_loses_nothing(void)
{
  struct iterate_kit_voice_playback_clock clock;
  const uint32_t deep = 20000U * 32U; /* 20 seconds queued, comfortably */
  uint32_t index;

  iterate_kit_voice_playback_clock_init(&clock);
  for (index = 0U; index < 200U; ++index) {
    assert(
        iterate_kit_voice_playback_clock_frame(
            &clock, deep, index, 0U, 1000U + index * 20U) ==
        ITERATE_KIT_VOICE_PLAYBACK_PLAY);
  }
}

int main(void) {
  opening_prefill_is_exact();
  concealment_never_costs_a_real_frame();
  catchup_is_rate_limited();
  completed_answer_returns_to_priming_without_silence();
  falling_behind_its_timeline_is_recovered();
  a_deep_queue_on_time_loses_nothing();
  return 0;
}
