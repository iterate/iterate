#include "iterate/kit/voice_playback_clock.h"

#include "iterate/kit/voice_device_profile.h"

#include <stddef.h>
#include <string.h>

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
  clock->answer_done = false;
  /* A new answer never owes latency correction for the abandoned answer. */
  clock->drop_debt_frames = 0U;
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

bool iterate_kit_voice_playback_clock_ready(
    struct iterate_kit_voice_playback_clock *clock,
    uint32_t queued_bytes) {
  if (clock == NULL) return false;
  /*
   * A FINISHED ANSWER IS ALWAYS READY, however little of it there is.
   *
   * Prefill answers "will more arrive in time?", and once the sender has
   * said the answer is complete the question is settled: nothing more is
   * coming, so waiting for a threshold that can never be reached is waiting
   * forever. Without this, every answer SHORTER than the prefill was never
   * played at all — "Yes, I can hear you clearly" is under a second, and the
   * larger the prefill the more of the conversation disappears. That failure
   * is silent at both ends: the model believes it spoke, and the listener
   * hears nothing.
   */
  /*
   * A finished answer short-circuits the PREFILL WAIT, and nothing else.
   *
   * Written as an unconditional `if (answer_done) return true`, this became a
   * latch: `answer_done` stays set until the dry-tick path clears it, that
   * path is only reached once a frame has been taken, and a caller that skips
   * its idle branch because ready() said true never takes one. The speaker
   * task then span on an empty buffer for the rest of the session - played
   * and concealed both frozen while frames arrived, no counter moving,
   * because neither the play path nor the conceal path was ever reached.
   *
   * Measured: 0 of 5 journeys, recovering completely on a restart, after the
   * first answer completed. Scoped to `priming` it does what it was added
   * for - an answer shorter than the prefill still plays - and stops being a
   * latch, because once priming is false the flag is irrelevant anyway.
   */
  if (clock->priming && clock->answer_done) {
    clock->priming = false;
    return true;
  }
  if (clock->priming &&
      queued_bytes < ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES) {
    return false;
  }
  clock->priming = false;
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
    uint32_t frames_played,
    uint64_t now_ms) {
  const uint32_t queued_ms = queued_bytes / 32U;
  if (clock == NULL) return ITERATE_KIT_VOICE_PLAYBACK_WAIT;
  if (queued_ms > ITERATE_KIT_VOICE_SPEAKER_HIGH_WATER_MS &&
      frames_played >= clock->next_catchup_at_frame) {
    clock->next_catchup_at_frame =
        frames_played + ITERATE_KIT_VOICE_SPEAKER_CATCHUP_EVERY;
    return ITERATE_KIT_VOICE_PLAYBACK_DROP_CATCHUP;
  }
  if (clock->drop_debt_frames > 0U) {
    --clock->drop_debt_frames;
    return ITERATE_KIT_VOICE_PLAYBACK_DROP_DEBT;
  }
  clock->last_write_ms = now_ms;
  return ITERATE_KIT_VOICE_PLAYBACK_PLAY;
}
