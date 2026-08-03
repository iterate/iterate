#ifndef ITERATE_KIT_VOICE_PLAYBACK_CLOCK_H
#define ITERATE_KIT_VOICE_PLAYBACK_CLOCK_H

#include <stdbool.h>
#include <stdint.h>

#include "iterate/kit/voice_device_profile.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Shared playout-clock policy; it owns no ring, clock, task, or audio device.
 *
 * The producer first uses audio_playout.h to decide whether an arriving frame
 * is current and whether the ring must be replaced.  This module answers the
 * separate realtime question at each 20 ms sink tick: wait for opening
 * prefill, play, conceal a mid-answer hole, or discard one late frame to pay
 * concealment debt / bound excessive backlog.  Keeping those two decisions
 * separate is essential: sequence identity is exact, while occupancy is
 * local to the consumer.
 *
 * One playback owner mutates this structure.  Calls are allocation-free and
 * non-blocking; `now_ms` is monotonic milliseconds and `queued_bytes` excludes
 * the candidate frame already removed from the ring.
 */
struct iterate_kit_voice_playback_clock {
  bool priming;
  bool answer_done;
  uint32_t drop_debt_frames;
  uint32_t next_catchup_at_frame;
  uint64_t last_write_ms;
  uint64_t starve_at_ms;
};

enum iterate_kit_voice_playback_action {
  ITERATE_KIT_VOICE_PLAYBACK_WAIT = 0,
  ITERATE_KIT_VOICE_PLAYBACK_PLAY,
  ITERATE_KIT_VOICE_PLAYBACK_CONCEAL,
  ITERATE_KIT_VOICE_PLAYBACK_DROP_DEBT,
  ITERATE_KIT_VOICE_PLAYBACK_DROP_CATCHUP,
};

void iterate_kit_voice_playback_clock_init(
    struct iterate_kit_voice_playback_clock *clock);
void iterate_kit_voice_playback_clock_reprime(
    struct iterate_kit_voice_playback_clock *clock);
void iterate_kit_voice_playback_clock_answer_done(
    struct iterate_kit_voice_playback_clock *clock);

/** Returns true exactly once when new audio proves a recent starve audible. */
bool iterate_kit_voice_playback_clock_audio_arrived(
    struct iterate_kit_voice_playback_clock *clock, uint64_t now_ms);

/**
 * How far behind its own timeline an answer has fallen.
 *
 * Frame N belongs `ITERATE_KIT_VOICE_FRAME_MS * N` after the answer's first
 * frame reached the speaker. `started_ms` of zero means this is that first
 * frame, and the answer is by definition on time.
 *
 * Shared rather than written twice because both targets need exactly this
 * arithmetic and one of them getting it subtly different is how a metric ends
 * up meaning two things — which has already cost this project a night.
 */
static inline uint32_t iterate_kit_voice_playout_lag_ms(
    uint64_t started_ms, uint32_t frames_played, uint64_t now_ms) {
  const uint64_t due =
      started_ms + (uint64_t)frames_played * ITERATE_KIT_VOICE_FRAME_MS;
  if (started_ms == 0U || now_ms <= due) return 0U;
  return (uint32_t)(now_ms - due);
}

/** Whether the owner should remove a frame from the ring on this iteration. */
bool iterate_kit_voice_playback_clock_ready(
    struct iterate_kit_voice_playback_clock *clock,
    uint32_t queued_bytes);

/** Decide a dry sink tick after playback has left priming. */
enum iterate_kit_voice_playback_action
iterate_kit_voice_playback_clock_empty(
    struct iterate_kit_voice_playback_clock *clock, uint64_t now_ms);

/**
 * Decide what to do with one whole frame removed from the ring.
 *
 * `lag_ms` is how far behind its own timeline this answer has fallen — frame
 * N belongs 20N ms after the first one played, and this is the gap between
 * that and now. It is the caller's to measure because only the caller knows
 * when a frame actually reached the speaker; it is the clock's to act on
 * because dropping a frame is a playout decision.
 */
enum iterate_kit_voice_playback_action
iterate_kit_voice_playback_clock_frame(
    struct iterate_kit_voice_playback_clock *clock,
    uint32_t queued_bytes,
    uint32_t frames_played,
    uint32_t lag_ms,
    uint64_t now_ms);

#ifdef __cplusplus
}
#endif

#endif /* ITERATE_KIT_VOICE_PLAYBACK_CLOCK_H */
