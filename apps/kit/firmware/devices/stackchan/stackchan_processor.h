#ifndef ITERATE_KIT_STACKCHAN_PROCESSOR_H
#define ITERATE_KIT_STACKCHAN_PROCESSOR_H

#include <stdbool.h>
#include <stdint.h>

#include "iterate/kit/audio_processor.h"

#ifdef __cplusplus
extern "C" {
#endif

enum {
  /** ESP-SR's VOIP engine processes 16 ms frames; verified against
   * aec_get_chunksize() at creation, failing closed on mismatch. */
  STACKCHAN_PROCESSOR_FRAME_SAMPLES = 256,
};

/**
 * The proven StackChan echo canceller behind the shared processor seam.
 *
 * ESP-SR 2.4.7's standalone VOIP AEC (DiOS/athena-signal: adaptive filter,
 * double-talk detector, ERL estimator, residual suppressor; NLP always on)
 * at the donor branch's final tuned operating point:
 *
 *   mode AEC_MODE_VOIP_HIGH_PERF, filter_length 4, state in PSRAM;
 *   100 Hz one-pole high-pass on the near plane before the filter
 *     (one persistent state, so 8 ms chunk boundaries create no step);
 *   saturating x8 digital gain on the analogue divider reference
 *     (the divider is measured 9-18 dB below the echo entering the mic);
 *   constant saturating x10 gain on the processed output — the shipped
 *     CONSTANT_PROCESSED uplink policy. The playback-activity-switched
 *     policy (raw x6 with an eight-frame hangover) was the A/B control and
 *     is deliberately not carried: it exists in the adopted
 *     aec_uplink_selector for a future re-measurement, and this processor
 *     therefore declares uses_playout_activity = false.
 *
 * ESP-SR exposes no filter reset, so reset() destroys and recreates the
 * engine — losing adaptation deliberately, because continuing a filter whose
 * near/reference timing is no longer meaningful presents as "echo came
 * back". A process failure returns non-OK and the seam wrapper (and the
 * capture bridge, independently) overwrite the output with silence: raw
 * microphone audio never leaks around a failed canceller.
 */
bool stackchan_processor_init(void);

struct iterate_kit_audio_processor stackchan_processor(void);

/** Engine rebuilds forced by reset(), and rebuilds that failed. */
uint32_t stackchan_processor_recreates(void);

/**
 * How many times the canceller had to settle for the fallback mode.
 *
 * Nonzero means the board is NOT running the mode the source asks for. A
 * calibration sweep that could not see this would compare two firmware builds
 * that were secretly the same one.
 */
uint32_t stackchan_processor_mode_fallbacks(void);

/** The esp-sr `AEC_MODE_*` the canceller is actually running in. */
uint32_t stackchan_processor_mode(void);
uint32_t stackchan_processor_recreate_failures(void);

/** Lifetime saturating clip counters, for the health surface. */
uint64_t stackchan_processor_reference_clipped_samples(void);
uint64_t stackchan_processor_near_high_pass_clipped_samples(void);
uint64_t stackchan_processor_uplink_clipped_samples(void);

#ifdef __cplusplus
}
#endif

#endif
