#include "iterate/kit/voice_playout.h"

#include "iterate/kit/voice_device_profile.h"

#include <stddef.h>
#include <string.h>

enum {
  BYTES_PER_MS = ITERATE_KIT_VOICE_FRAME_BYTES / ITERATE_KIT_VOICE_FRAME_MS,
};

void iterate_kit_voice_playout_init(struct iterate_kit_voice_playout *playout) {
  if (playout == NULL) return;
  memset(playout, 0, sizeof(*playout));
  iterate_kit_voice_playback_clock_init(&playout->clock);
}

static void note_margin(
    struct iterate_kit_voice_playout *playout,
    const struct iterate_kit_voice_playout_ring *ring) {
  const uint32_t margin_ms =
      ring->queued_bytes(ring->context) / (uint32_t)BYTES_PER_MS;
  ++playout->stats.writes;
  if (playout->stats.writes == 1U || margin_ms < playout->stats.margin_min_ms) {
    playout->stats.margin_min_ms = margin_ms;
  }
  if (margin_ms > playout->stats.margin_max_ms) {
    playout->stats.margin_max_ms = margin_ms;
  }
}

enum iterate_kit_voice_playout_outcome iterate_kit_voice_playout_step(
    struct iterate_kit_voice_playout *playout,
    const struct iterate_kit_voice_playout_ring *ring,
    const struct iterate_kit_voice_playout_sink *sink) {
  const uint8_t *frame = NULL;
  size_t length = 0U;
  uint32_t frame_ms;
  uint64_t played_at_ms;
  enum iterate_kit_voice_playout_outcome outcome;

  if (playout == NULL || ring == NULL || sink == NULL) {
    return ITERATE_KIT_VOICE_PLAYOUT_PRIMING;
  }
  if (!iterate_kit_voice_playback_clock_ready(
          &playout->clock,
          ring->queued_bytes(ring->context),
          sink->now_ms(sink->context))) {
    /* Not feeding: nothing is playing, so nothing is written. */
    ++playout->stats.waits_priming;
    return ITERATE_KIT_VOICE_PLAYOUT_PRIMING;
  }

  switch (ring->read(ring->context, &frame, &length)) {
  case ITERATE_KIT_VOICE_PLAYOUT_READ_ABANDONED:
    return ITERATE_KIT_VOICE_PLAYOUT_ABANDONED;
  case ITERATE_KIT_VOICE_PLAYOUT_READ_DRY:
    /*
     * DRY. The clock says whether that is a hole or the end.
     *
     * A hole is NOT filled with silence from here on a board: silence written
     * into a DMA ring is indistinguishable from audio, occupies playout time,
     * can never be taken back, and so permanently puts the rest of the answer
     * 20 ms further behind — 149 times in one measured answer, three seconds
     * of chopping. A board's ring already clocks out zeros when it is truly
     * empty. A sink that has no such hardware behind it (the CLI's file
     * model) supplies the silence so its recording keeps the timeline.
     *
     * The end resets the answer's timeline inside the clock, in this same
     * call. THAT is the reset the two owners used to write themselves and
     * each forgot on one path; asking the clock on EVERY dry read, from every
     * path, is what this step guarantees.
     */
    ++playout->stats.waits_dry;
    if (iterate_kit_voice_playback_clock_empty(
            &playout->clock, sink->now_ms(sink->context)) ==
        ITERATE_KIT_VOICE_PLAYBACK_CONCEAL) {
      ++playout->stats.conceal_frames;
      if (sink->conceal != NULL) (void)sink->conceal(sink->context);
      return ITERATE_KIT_VOICE_PLAYOUT_STARVED;
    }
    return ITERATE_KIT_VOICE_PLAYOUT_SETTLED;
  case ITERATE_KIT_VOICE_PLAYOUT_READ_FRAME:
    break;
  }
  if (frame == NULL || length == 0U) return ITERATE_KIT_VOICE_PLAYOUT_ABANDONED;

  /*
   * Flooded: skip this frame to catch up.
   *
   * The sender paces off its own wall clock and the device consumes off its
   * audio clock; the two are independent, so a stall accumulates as lag that
   * nothing else ever pays back. Skipping one frame here, only while the
   * answer is behind AND the backlog carries the threshold, is the same loss
   * placed where it is least audible — see the clock for the two guards and
   * what each one cost before it existed. The symmetric counterpart to
   * concealment: conceal when starved, skip when flooded, count both.
   */
  frame_ms = (uint32_t)(length / BYTES_PER_MS);
  if (iterate_kit_voice_playback_clock_frame(
          &playout->clock,
          ring->queued_bytes(ring->context),
          frame_ms,
          sink->now_ms(sink->context)) ==
      ITERATE_KIT_VOICE_PLAYBACK_DROP_CATCHUP) {
    ++playout->stats.catchup_frames;
    return ITERATE_KIT_VOICE_PLAYOUT_SKIPPED;
  }

  /* Stamped BEFORE the write; the clock's `played` says why. */
  played_at_ms = sink->now_ms(sink->context);
  switch (sink->write(sink->context, frame, length)) {
  case ITERATE_KIT_VOICE_PLAYOUT_WRITE_OK:
    ++playout->stats.frames_played;
    iterate_kit_voice_playback_clock_played(
        &playout->clock, played_at_ms, frame_ms);
    outcome = ITERATE_KIT_VOICE_PLAYOUT_PLAYED;
    break;
  case ITERATE_KIT_VOICE_PLAYOUT_WRITE_ABANDONED:
    /* Intentional replacement, not a speaker failure. */
    outcome = ITERATE_KIT_VOICE_PLAYOUT_REPLACED;
    break;
  case ITERATE_KIT_VOICE_PLAYOUT_WRITE_FAILED:
  default:
    ++playout->stats.write_failures;
    outcome = ITERATE_KIT_VOICE_PLAYOUT_REFUSED;
    break;
  }
  note_margin(playout, ring);
  playout->last_write_ms = sink->now_ms(sink->context);
  return outcome;
}
