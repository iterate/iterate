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
 * A dry tick must keep the sink clock moving with silence, then discard one
 * late frame.  Without the matching debt payment each concealed 20 ms would
 * permanently increase lag and an hour-long answer would ratchet to overflow.
 */
static void concealment_creates_equal_drop_debt(void) {
  struct iterate_kit_voice_playback_clock clock;
  iterate_kit_voice_playback_clock_init(&clock);
  assert(iterate_kit_voice_playback_clock_ready(
      &clock, ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES));
  assert(iterate_kit_voice_playback_clock_empty(&clock, 1000U) ==
      ITERATE_KIT_VOICE_PLAYBACK_CONCEAL);
  assert(iterate_kit_voice_playback_clock_audio_arrived(&clock, 1010U));
  assert(iterate_kit_voice_playback_clock_frame(&clock, 0U, 0U, 1010U) ==
      ITERATE_KIT_VOICE_PLAYBACK_DROP_DEBT);
  assert(iterate_kit_voice_playback_clock_frame(&clock, 0U, 0U, 1030U) ==
      ITERATE_KIT_VOICE_PLAYBACK_PLAY);
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
  assert(iterate_kit_voice_playback_clock_frame(&clock, flooded, 0U, 1000U) ==
      ITERATE_KIT_VOICE_PLAYBACK_DROP_CATCHUP);
  assert(iterate_kit_voice_playback_clock_frame(&clock, flooded, 0U, 1020U) ==
      ITERATE_KIT_VOICE_PLAYBACK_PLAY);
  assert(iterate_kit_voice_playback_clock_frame(
      &clock, flooded, ITERATE_KIT_VOICE_SPEAKER_CATCHUP_EVERY, 2000U) ==
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

int main(void) {
  opening_prefill_is_exact();
  concealment_creates_equal_drop_debt();
  catchup_is_rate_limited();
  completed_answer_returns_to_priming_without_silence();
  return 0;
}
