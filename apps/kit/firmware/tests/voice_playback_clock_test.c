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
               &clock, 0U, 0U, 1200U + index * 20U) ==
        ITERATE_KIT_VOICE_PLAYBACK_PLAY);
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
  const uint32_t level = ITERATE_KIT_VOICE_SPEAKER_LAG_CATCHUP_MS;
  const uint32_t backlog = 500U * 32U; /* half a second waiting to be played */
  uint32_t index;

  iterate_kit_voice_playback_clock_init(&clock);
  /*
   * Late WITH A BACKLOG, which is the only case worth skipping: it keeps
   * skipping until level, rather than trimming one frame in fifty — measured,
   * that recovered 60 ms against 3.1 s of lag, so the answer ended long
   * before the device was level and it simply stayed behind.
   */
  for (index = 0U; index < 20U; ++index) {
    assert(
        iterate_kit_voice_playback_clock_frame(
            &clock, backlog, late, 1000U + index * 20U) ==
        ITERATE_KIT_VOICE_PLAYBACK_DROP_CATCHUP);
  }
  /* Level again: skipping stops at once, so the cut is bounded by the lag. */
  assert(
      iterate_kit_voice_playback_clock_frame(
          &clock, backlog, level, 1400U) ==
      ITERATE_KIT_VOICE_PLAYBACK_PLAY);
  /*
   * And late with NOTHING QUEUED plays: the next frame is the live edge, so
   * discarding it would delete speech and recover nothing. Unguarded, this
   * ate the opening of every answer — lag peaks exactly when one starts.
   */
  assert(
      iterate_kit_voice_playback_clock_frame(&clock, 0U, late, 1500U) ==
      ITERATE_KIT_VOICE_PLAYBACK_PLAY);
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
  const uint32_t deep = 8000U * 32U; /* twice the sender's budget */
  uint32_t index;

  iterate_kit_voice_playback_clock_init(&clock);
  for (index = 0U; index < 200U; ++index) {
    assert(
        iterate_kit_voice_playback_clock_frame(
            &clock, deep, 0U, 1000U + index * 20U) ==
        ITERATE_KIT_VOICE_PLAYBACK_PLAY);
  }
}

int main(void) {
  opening_prefill_is_exact();
  concealment_never_costs_a_real_frame();
  completed_answer_returns_to_priming_without_silence();
  falling_behind_its_timeline_is_recovered();
  a_deep_queue_on_time_loses_nothing();
  return 0;
}
