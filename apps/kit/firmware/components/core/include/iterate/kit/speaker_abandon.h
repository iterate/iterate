#ifndef ITERATE_KIT_SPEAKER_ABANDON_H
#define ITERATE_KIT_SPEAKER_ABANDON_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * The four side effects of intentionally throwing queued speaker audio away,
 * in the only order that is safe.
 *
 * Abandoning audio is the device's own decision — barge-in, hang-up, a call
 * being replaced, a new turn starting. The starvation detector cannot know that:
 * it holds an absolute audio-empty deadline, and if the source disappears while
 * the watch is still armed, the deadline passes with nothing written and a
 * deliberate abandon is recorded as a real starve event. `spkStarveEvents` is
 * the never-tier gate, so that one miscount fails a release.
 *
 * Measured on 2026-08-04, session 5 turn 7 of the ten-session acceptance: the
 * bridge had raced 13,020ms of audio ahead of realtime, the hang-up arrived with
 * the ring still that deep, and the counter moved by one. An audit then found
 * five abandon sites with three different orderings — two disarming AFTER the
 * discard, two not disarming at all, one correct. Ordering by hand at five call
 * sites is how that happens, so there is now one funnel and no hand-ordering.
 */
struct iterate_kit_speaker_abandon_hooks {
  /** Stop the starvation watch. Must happen before the source goes away. */
  void (*disarm_watch)(void *context);
  /**
   * Mark the hardware ring stale, so the next arm starts its deadline a full
   * ring in the future instead of measuring against audio that was discarded.
   * This is what leaves no stale watch state for the next call.
   */
  void (*note_flush)(void *context);
  /** How many bytes are queued right now. Read after the watch is disarmed. */
  uint32_t (*buffered_bytes)(void *context);
  /** Tell the playback task to skip exactly that many bytes. */
  void (*set_discard)(void *context, uint32_t bytes);
  /** And to prime again before it reopens the DAC. */
  void (*set_reprime)(void *context);
};

/**
 * Abandon queued speaker audio safely.
 *
 * Returns the byte count handed to `set_discard`, so a caller can log or count
 * what it threw away. Missing hooks are skipped rather than crashing: a caller
 * that has nothing to reprime is a caller, not a bug.
 */
uint32_t iterate_kit_speaker_abandon(
    const struct iterate_kit_speaker_abandon_hooks *hooks, void *context);

#ifdef __cplusplus
}
#endif

#endif /* ITERATE_KIT_SPEAKER_ABANDON_H */
