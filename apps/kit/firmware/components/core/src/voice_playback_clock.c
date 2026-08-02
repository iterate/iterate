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
  ++clock->drop_debt_frames;
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
