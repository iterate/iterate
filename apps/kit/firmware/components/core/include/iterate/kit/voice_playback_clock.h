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
 * The producer decides what to queue — which is now nothing at all, because
 * the sender paces the answer and marks the chunk that replaces one.  This
 * module answers the separate realtime question at each 20 ms sink tick: wait
 * for opening prefill, play, conceal a mid-answer hole, or discard one late
 * frame to bound excessive backlog.  That question is about occupancy, which
 * is local to the consumer and knowable nowhere else.
 *
 * IT ALSO OWNS THE ANSWER'S TIMELINE. Frame N of an answer belongs 20N ms
 * after the first one played; the gap between that and the wall clock is how
 * far behind realtime playback has fallen, and it is the only honest measure
 * of "behind" — queue depth is not, because a whole answer legitimately
 * arrives at once and a deep queue then means the sender was fast. Both the
 * board and the host CLI used to keep that timeline themselves, beside this
 * clock, and feed it in as a number. Each then had to remember, at every
 * place an answer ends, to start the next one from zero — and each forgot a
 * different place. The board forgot ordinary turns until 2026-09-06 (two
 * boards played a fifth of every answer after the first for a week); the CLI
 * forgot the live-audio dry path until 2026-09-09 (a back-office turn read as
 * nine seconds late and four frames in five were discarded for the rest of
 * it). The timeline is now reset HERE, in the same call that decides the ring
 * is at the live edge, so there is no longer a caller who can forget.
 *
 * There was a fifth answer, DROP_DEBT: one frame discarded per frame
 * concealed, so concealment could not permanently add its own duration to
 * playout lag.  Nothing ever incurred the debt — `drop_debt_frames` was only
 * ever zeroed and decremented, never incremented — so the branch, its counter
 * and the five device arms that read it were unreachable from the day they
 * were written.  DROP_CATCHUP is what actually bounds lag.
 *
 * One playback owner mutates this structure.  Calls are allocation-free and
 * non-blocking; `now_ms` is monotonic milliseconds and `queued_bytes` excludes
 * the candidate frame already removed from the ring.
 */
struct iterate_kit_voice_playback_clock {
  bool priming;
  bool answer_done;
  uint64_t last_write_ms;
  uint64_t starve_at_ms;
  /**
   * The current answer's playout timeline: when its first frame reached the
   * speaker, and how many MILLISECONDS have been emitted since. Zero
   * `answer_started_ms` means no answer is in flight, so nothing is late; the
   * origin is then taken from the next frame that actually plays, which is
   * correct however long the gap turns out to be.
   *
   * Needs no clock agreement with the server: both terms are local, and the
   * answer's own first frame is the origin.
   */
  uint64_t answer_started_ms;
  uint32_t answer_emitted_ms;
  /** The worst lag any played frame was measured at; telemetry, never acted on. */
  uint32_t lag_max_ms;
};

enum iterate_kit_voice_playback_action {
  ITERATE_KIT_VOICE_PLAYBACK_WAIT = 0,
  ITERATE_KIT_VOICE_PLAYBACK_PLAY,
  ITERATE_KIT_VOICE_PLAYBACK_CONCEAL,
  ITERATE_KIT_VOICE_PLAYBACK_DROP_CATCHUP,
};

void iterate_kit_voice_playback_clock_init(
    struct iterate_kit_voice_playback_clock *clock);

/**
 * The queue was thrown away — barge-in, a superseded answer, a new call or
 * turn. Playback primes again, and the answer's timeline goes with its audio:
 * a flush by definition leaves no answer in flight, so it leaves no timeline.
 */
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
 * `emitted_ms` is the audio actually handed to the speaker so far, which is
 * what the timeline is made of. Counting CALLS instead of milliseconds made a
 * short read — the tail of an answer, or any partial the ring hands back —
 * advance the timeline by a full frame it had not played, so `due` ran ahead
 * of the audio and lag read LOW exactly when playback was starving.
 *
 * `started_ms` of zero means this is the first frame, and the answer is by
 * definition on time.
 *
 * Shared rather than written twice because both targets need exactly this
 * arithmetic and one of them getting it subtly different is how a metric ends
 * up meaning two things — which has already cost this project a night.
 */
static inline uint32_t iterate_kit_voice_playout_lag_ms(
    uint64_t started_ms, uint32_t emitted_ms, uint64_t now_ms) {
  const uint64_t due = started_ms + emitted_ms;
  if (started_ms == 0U || now_ms <= due) return 0U;
  return (uint32_t)(now_ms - due);
}

/** The clock's own answer, at `now_ms`, to the question above. */
uint32_t iterate_kit_voice_playback_clock_lag_ms(
    const struct iterate_kit_voice_playback_clock *clock, uint64_t now_ms);

/** Whether the owner should remove a frame from the ring on this iteration. */
bool iterate_kit_voice_playback_clock_ready(
    struct iterate_kit_voice_playback_clock *clock,
    uint32_t queued_bytes);

/**
 * Decide a dry sink tick after playback has left priming.
 *
 * WAIT means the ring is empty because the answer is over — declared so, or
 * silent past the conceal limit — and playback is AT THE LIVE EDGE. The
 * answer's timeline is reset in the same breath: whatever lag it ended on is
 * unrecoverable by definition, and carried forward it would only wait to be
 * charged against the next answer.
 */
enum iterate_kit_voice_playback_action
iterate_kit_voice_playback_clock_empty(
    struct iterate_kit_voice_playback_clock *clock, uint64_t now_ms);

/**
 * Decide what to do with one whole frame removed from the ring.
 *
 * `frame_ms` is how much audio the frame holds — the tail of an answer can be
 * short. The clock measures the answer's lag against its own timeline; a
 * frame it tells the owner to DISCARD has still spent its place in that
 * timeline, and the clock advances it here. (Leave the counter alone and the
 * computed lag never falls, so the loop keeps deciding it is late and skips
 * again — it drains the whole backlog and the listener hears half the answer
 * missing. Measured exactly that: 78 of 162 frames skipped.)
 */
enum iterate_kit_voice_playback_action
iterate_kit_voice_playback_clock_frame(
    struct iterate_kit_voice_playback_clock *clock,
    uint32_t queued_bytes,
    uint32_t frame_ms,
    uint64_t now_ms);

/**
 * The owner played `played_ms` of a frame the clock said to PLAY.
 *
 * `played_at_ms` is when the frame was handed to the speaker, STAMPED BEFORE
 * THE WRITE, NOT AFTER: codec admission may wait for bounded queue headroom,
 * and stamping after that wait folds hardware pacing into the measurement, so
 * a perfectly punctual loop reports itself progressively later and the
 * catch-up rule then deletes speech to fix a delay that only existed in the
 * metric. Measured that way: 1089 ms of "lag" while the ring held 1620 ms of
 * audio, which is the signature of a consumer that is keeping up.
 *
 * The first frame played after a reset is the timeline's origin.
 */
void iterate_kit_voice_playback_clock_played(
    struct iterate_kit_voice_playback_clock *clock,
    uint64_t played_at_ms,
    uint32_t played_ms);

#ifdef __cplusplus
}
#endif

#endif /* ITERATE_KIT_VOICE_PLAYBACK_CLOCK_H */
