#ifndef ITERATE_KIT_CLI_PACED_SINK_H
#define ITERATE_KIT_CLI_PACED_SINK_H

/*
 * cli_paced_sink: the clock the host rig's speaker does not otherwise have.
 *
 * ORIGINATING FAILURE. The macOS target's speaker is an fwrite into a WAV. A
 * file has no clock: it accepts every frame the instant it is offered, it can
 * never be full, and it can never run dry. So the rig cannot express the one
 * thing a converter does all day — demand a frame every 20 ms whether or not
 * anybody has one. Three defects reached the device behind that blind spot: a
 * latch that left the speaker spinning on an empty ring, a concealment debt
 * that deleted one real word per inserted silence, and a response-complete
 * control treated as a barge-in. All three live on the path taken when the
 * consumer is WAITING, and in this rig the consumer never waits. Worse, the
 * recording carries no timestamps, so a run that dropped 180 ms of a call
 * produces a WAV that is simply 180 ms shorter and sounds perfect.
 *
 * MENTAL MODEL. A fixed-depth DMA queue in front of a converter that removes
 * exactly one frame every period, forever, from the first advance onwards.
 * Offering into a full queue is REFUSED: a caller that has fallen behind may
 * not catch up by writing faster, which is the entire difference between this
 * and a file. A drain boundary that finds the queue empty is an UNDERRUN —
 * silence a listener heard, and the only honest record that it happened.
 *
 * WHAT THIS DOES NOT MODEL. Timing, and nothing else. cli_wav still owns what
 * was played; this owns only whether it could have been played yet. A second
 * copy of the WAV writer inside a test double would be a second thing to keep
 * true, and the payload was never the part the rig was lying about. It is
 * likewise not an I2S driver: DMA descriptor underflow, amplifier settle, and
 * clock-domain drift are invisible here and remain device-only faults.
 *
 * TIME AND DETERMINISM. Microseconds on the caller's monotonic clock. This
 * module never reads a clock, so a run driven by a virtual clock replays
 * bit-for-bit. Counters saturate at UINT32_MAX rather than wrap, because an
 * unattended postmortem must never read a worsening fault as a recovered one.
 *
 * OWNERSHIP. One caller mutates this structure; it allocates nothing, blocks
 * on nothing, and has no lifecycle beyond configure.
 *
 * THE DEFAULT IS THE OLD BEHAVIOUR. A sink configured with no rate is
 * UNPACED: it accepts everything, refuses nothing, and never reports an
 * underrun — exactly the file sink it wraps. Turning the knob off must leave
 * the rig it was added to byte-identical, or nobody will leave it in.
 */

#include <stdbool.h>
#include <stdint.h>

enum {
  /*
   * The device's I2S lead is 90 ms (voice_device_profile), which at the 20 ms
   * wire frame is four whole frames; hardware cannot hold the remaining half
   * of one, so neither does the model. Depth is what bounds how far ahead of
   * realtime a caller may get: at four frames a stall shorter than 80 ms is
   * absorbed exactly as the board absorbs it, and a longer one is heard.
   */
  CLI_PACED_SINK_DEFAULT_DEPTH_FRAMES = 4,
  /*
   * Bounds on the configured knob. A converter faster than 1 kHz or deeper
   * than 64 frames is a typo, and a typo that silently produces a 1 us period
   * would make every run report millions of underruns and be believed.
   */
  CLI_PACED_SINK_MAX_FRAMES_PER_SECOND = 1000,
  CLI_PACED_SINK_MAX_DEPTH_FRAMES = 64,
  /*
   * Drain boundaries honoured by one advance. A host that slept with the lid
   * shut returns a stamp hours later; replaying four hours of boundaries
   * would report a quarter of a million underruns for a closed laptop and be
   * indistinguishable from a real fault. Past this the model resyncs to the
   * new stamp and counts the resync, so the gap stays visible without being
   * dressed up as audio nobody heard.
   */
  CLI_PACED_SINK_MAX_DRAIN_FRAMES = 256,
};

/** One status per way the modelled converter can refuse a frame. */
enum cli_paced_sink_status {
  CLI_PACED_SINK_OK = 0,
  /** A NULL sink or a knob outside the bounds above. */
  CLI_PACED_SINK_ERR_ARG,
  /** The queue is full. The caller must wait, not write faster. */
  CLI_PACED_SINK_ERR_BUSY,
};

/**
 * How badly the converter is asked to behave.
 *
 * Zero everywhere means "unpaced", which is the default and reproduces the
 * file sink exactly. `frames_per_second` is the true consumption rate, so 50
 * is the device's 20 ms frame; `depth_frames` of zero adopts the device's
 * I2S lead rather than inventing a queue no board has.
 */
struct cli_paced_sink_config {
  uint32_t frames_per_second;
  uint32_t depth_frames;
};

/**
 * The modelled converter.
 *
 * `period_us` of zero is the single flag for "unpaced": it is derived once at
 * configure, so no other line has to re-decide whether pacing is on. Counters
 * are cumulative for the life of the configuration and are the whole
 * postmortem: `underrun_frames` is silence the listener heard, and
 * `refused_frames` is the caller trying to run ahead of realtime, which a
 * file would have accepted without comment.
 */
struct cli_paced_sink {
  uint32_t frames_per_second;
  uint32_t depth_frames;
  uint32_t period_us;
  uint32_t queued_frames;
  uint64_t next_drain_us;
  uint64_t last_us;
  bool running;
  uint32_t accepted_frames;
  uint32_t refused_frames;
  uint32_t drained_frames;
  uint32_t underrun_frames;
  /** Stamps that went backwards; see cli_paced_sink_advance. */
  uint32_t skew_stamps;
  /** Advances so far past the schedule that the model gave up replaying it. */
  uint32_t resyncs;
};

/** Human-readable status name, for logs and test failure messages. */
const char *cli_paced_sink_status_name(enum cli_paced_sink_status status);

/**
 * Apply `config`, clearing every counter. Rejects an out-of-range knob rather
 * than clamping it: a run configured with a rate nobody meant would produce
 * numbers nobody could interpret, and the flag is easier to fix than the
 * report. `sink` is caller-owned and needs no release.
 */
enum cli_paced_sink_status cli_paced_sink_configure(
    struct cli_paced_sink *sink, const struct cli_paced_sink_config *config);

/** Whether a converter is being modelled at all. False is the default. */
bool cli_paced_sink_paced(const struct cli_paced_sink *sink);

/**
 * Move the modelled converter to `now_us`, consuming one queued frame per
 * drain boundary and counting an underrun for every boundary that found the
 * queue empty.
 *
 * Returns the underruns DISCOVERED BY THIS CALL, so a caller recording the
 * true playback timeline knows exactly how many frames of silence to write.
 * The cumulative total is in `underrun_frames` either way.
 *
 * Call once per loop iteration, BEFORE cli_paced_sink_offer, which does not
 * touch the clock. Repeating a stamp is a no-op, and a stamp that goes
 * backwards is counted and ignored rather than subtracted: an unsigned
 * elapsed-time underflow here would report several million underruns and, on
 * the device, rebuilt a healthy call 42 times in three minutes.
 */
uint32_t cli_paced_sink_advance(struct cli_paced_sink *sink, uint64_t now_us);

/**
 * Whether the converter has room for another frame RIGHT NOW — that is,
 * whether it is still asking for audio at this instant.
 *
 * An unpaced sink answers false, because an unmodelled converter never asks
 * for anything and the caller's own schedule remains the only clock. That is
 * what keeps this usable as the continuation condition of a feed loop whose
 * first frame is unconditional: with pacing off the loop runs exactly once,
 * which is the behaviour it had before this module existed.
 */
bool cli_paced_sink_ready(const struct cli_paced_sink *sink);

/**
 * Hand one frame to the converter. ERR_BUSY means the queue is full and the
 * caller must come back after advancing time; the frame has not been
 * consumed and the caller still owns it. An unpaced sink always accepts.
 */
enum cli_paced_sink_status cli_paced_sink_offer(struct cli_paced_sink *sink);

#endif /* ITERATE_KIT_CLI_PACED_SINK_H */
