#ifndef ITERATE_KIT_VOICE_PLAYOUT_H
#define ITERATE_KIT_VOICE_PLAYOUT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/voice_playback_clock.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * ONE PLAYOUT STEP FOR THE BOARD AND THE HOST CLI.
 *
 * Both run the same sequence around the shared playback clock: is the ring
 * primed; take one frame; a dry ring is either a hole in the answer or the
 * end of it; a frame is skipped when the answer is behind with backlog to
 * skip into, otherwise handed to the speaker; and what was handed over is
 * reported so the answer's timeline advances. Each target used to write that
 * sequence itself around its own ring and sink, and the two drifted apart
 * twice in a week — the board forgot to restart the timeline on ordinary
 * turns, the CLI forgot it on its live-audio dry path — because a rule
 * written in two places is two rules.
 *
 * This is the sequence, once. What differs between targets is injected: the
 * RING (a FreeRTOS queue with generations on the board; a byte ring on the
 * host) and the SINK (a codec write that may wait for DMA headroom; a paced
 * or unpaced CoreAudio/file converter), each a handful of callbacks. The
 * counters both targets report are kept here too, so `spkPlayed` means the
 * same thing in a board's health() as in the CLI's report.
 *
 * The step owns no thread and never blocks on its own account; the board's
 * `read` blocks for its dry wait, the board's `write` for DMA headroom, and
 * that is theirs. One owner mutates a playout; calls are allocation-free.
 */

/** What `ring.read` handed back. */
enum iterate_kit_voice_playout_read {
  /** Nothing queued: the live edge, or a hole. */
  ITERATE_KIT_VOICE_PLAYOUT_READ_DRY = 0,
  /** `*frame` holds `*length` bytes of PCM16, valid until the next read. */
  ITERATE_KIT_VOICE_PLAYOUT_READ_FRAME,
  /**
   * A frame came out but belongs to an answer that has since been thrown
   * away; the ring has dealt with it. Not dry — nothing is concealed — and
   * not a frame — nothing is played.
   */
  ITERATE_KIT_VOICE_PLAYOUT_READ_ABANDONED,
};

/** What `sink.write` did with a frame the clock said to play. */
enum iterate_kit_voice_playout_write {
  ITERATE_KIT_VOICE_PLAYOUT_WRITE_OK = 0,
  /** A replacement answer arrived while this frame waited; not a failure. */
  ITERATE_KIT_VOICE_PLAYOUT_WRITE_ABANDONED,
  /** The speaker did not admit it. */
  ITERATE_KIT_VOICE_PLAYOUT_WRITE_FAILED,
};

struct iterate_kit_voice_playout_ring {
  void *context;
  /** Bytes queued and not yet handed to the sink. */
  uint32_t (*queued_bytes)(void *context);
  /** Removes at most one frame; may block for the ring's own dry wait. */
  enum iterate_kit_voice_playout_read (*read)(
      void *context, const uint8_t **frame, size_t *length);
};

struct iterate_kit_voice_playout_sink {
  void *context;
  /** The owner's monotonic clock, in milliseconds. */
  uint64_t (*now_ms)(void *context);
  /** Hands one frame to the speaker; may wait for bounded headroom. */
  enum iterate_kit_voice_playout_write (*write)(
      void *context, const uint8_t *frame, size_t length);
  /**
   * Emits one frame of silence for a hole the clock judged mid-answer. NULL
   * where the hardware clocks out its own zeros and inserting more would
   * only put the rest of the answer further behind — which is every board,
   * and the host CLI whenever a real or modelled room is pulling.
   */
  bool (*conceal)(void *context);
};

/**
 * What the step counted. Reported by both targets under the same names.
 *
 * `waits_priming` is the clock saying the ring is below prefill;
 * `waits_dry` is the ring being empty. A stall in either used to be
 * invisible — frames arriving with played AND conceal both frozen is exactly
 * what these two look like from outside — which is why they are counted.
 *
 * `conceal_frames` is how often the source could not keep up mid-answer,
 * whether or not the sink inserted anything for it: telemetry about the
 * pipe, not about the listener's experience.
 *
 * `margin_min_ms` is how much audio was still queued behind the emptiest
 * write: proving "no underruns" needs more than a count of holes, and a run
 * with a healthy floor is evidence where a zero count alone proves nothing.
 */
struct iterate_kit_voice_playout_stats {
  uint32_t waits_priming;
  uint32_t waits_dry;
  uint32_t frames_played;
  uint32_t conceal_frames;
  uint32_t catchup_frames;
  uint32_t write_failures;
  uint32_t writes;
  uint32_t margin_min_ms;
  uint32_t margin_max_ms;
};

struct iterate_kit_voice_playout {
  struct iterate_kit_voice_playback_clock clock;
  struct iterate_kit_voice_playout_stats stats;
  /** When the sink was last handed a frame, whatever it did with it. */
  uint64_t last_write_ms;
};

enum iterate_kit_voice_playout_outcome {
  /** Below prefill; nothing was taken from the ring. */
  ITERATE_KIT_VOICE_PLAYOUT_PRIMING = 0,
  /** The ring handed back a frame of a flushed answer and dealt with it. */
  ITERATE_KIT_VOICE_PLAYOUT_ABANDONED,
  /** Dry mid-answer: a hole, concealed if the sink conceals. */
  ITERATE_KIT_VOICE_PLAYOUT_STARVED,
  /** Dry because the answer is over: back to priming, timeline forgotten. */
  ITERATE_KIT_VOICE_PLAYOUT_SETTLED,
  /** Behind with backlog to skip into: the frame was discarded to catch up. */
  ITERATE_KIT_VOICE_PLAYOUT_SKIPPED,
  ITERATE_KIT_VOICE_PLAYOUT_PLAYED,
  /** The speaker let a replacement answer take the frame's place. */
  ITERATE_KIT_VOICE_PLAYOUT_REPLACED,
  /** The speaker refused the frame. */
  ITERATE_KIT_VOICE_PLAYOUT_REFUSED,
};

void iterate_kit_voice_playout_init(struct iterate_kit_voice_playout *playout);

/**
 * One pass of the speaker. Call it from the one task that owns playback, as
 * often as the sink wants feeding; it takes at most one frame.
 */
enum iterate_kit_voice_playout_outcome iterate_kit_voice_playout_step(
    struct iterate_kit_voice_playout *playout,
    const struct iterate_kit_voice_playout_ring *ring,
    const struct iterate_kit_voice_playout_sink *sink);

#ifdef __cplusplus
}
#endif

#endif /* ITERATE_KIT_VOICE_PLAYOUT_H */
