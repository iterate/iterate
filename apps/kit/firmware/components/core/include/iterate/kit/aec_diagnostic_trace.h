#ifndef ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_H
#define ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_H

#include "iterate/kit/status.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum iterate_kit_aec_diagnostic_trace_state {
  ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_IDLE = 0,
  ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_ARMED = 1,
  ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_CAPTURING = 2,
  ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_READY = 3,
  ITERATE_KIT_AEC_DIAGNOSTIC_TRACE_ABORTED = 4,
};

struct iterate_kit_aec_diagnostic_trace_options {
  uint32_t sample_rate_hz;
  size_t frame_samples;
  size_t capture_samples;

  /*
   * The platform supplies four non-overlapping, capture_samples-long arrays.
   * Rich devices should place them in external RAM. Keeping storage outside
   * this portable object makes the 4 * duration * sample-rate * 2-byte cost
   * visible in each target's map instead of hiding it in a heap allocation.
   */
  int16_t *near_samples;
  int16_t *reference_samples;
  int16_t *linear_samples;
  int16_t *clean_samples;
};

struct iterate_kit_aec_diagnostic_trace_snapshot {
  enum iterate_kit_aec_diagnostic_trace_state state;
  uint32_t generation;
  uint32_t captured_samples;
  uint32_t first_frame_sequence;
  uint32_t last_frame_sequence;
  uint32_t captures_started;
  uint32_t captures_completed;
  uint32_t captures_aborted;
  uint32_t start_rejections;
  uint32_t read_calls;
};

/**
 * A finite, synchronized four-tap AEC evidence capture.
 *
 * Metrics alone can say that the final signal is loud, but they cannot prove
 * whether the electrical reference is delayed, inverted, clipped, or mapped
 * to the wrong channel. This object preserves the exact near/reference/linear/
 * final samples needed for lag, polarity, ERLE, and double-talk analysis.
 *
 * There is intentionally no producer/consumer queue. One control owner arms
 * a fixed capture; the realtime audio owner copies each already-produced DSP
 * frame into caller-owned storage; the control owner may read only after the
 * fixed capture is complete. Thus a slow RPC reader cannot backpressure audio
 * or turn diagnostics into accumulating conversation delay.
 */
struct iterate_kit_aec_diagnostic_trace {
  struct iterate_kit_aec_diagnostic_trace_options options;
  volatile uint32_t state;
  volatile uint32_t generation;
  volatile uint32_t captured_samples;
  volatile uint32_t first_frame_sequence;
  volatile uint32_t last_frame_sequence;
  volatile uint32_t captures_started;
  volatile uint32_t captures_completed;
  volatile uint32_t captures_aborted;
  volatile uint32_t start_rejections;
  volatile uint32_t read_calls;
  uint32_t initialized;
};

enum iterate_kit_status iterate_kit_aec_diagnostic_trace_init(
    struct iterate_kit_aec_diagnostic_trace *trace,
    const struct iterate_kit_aec_diagnostic_trace_options *options);

enum iterate_kit_status iterate_kit_aec_diagnostic_trace_start(
    struct iterate_kit_aec_diagnostic_trace *trace,
    uint32_t *generation);

/**
 * Copies one aligned DSP frame from the realtime owner.
 *
 * In the common IDLE/READY states this performs one atomic state load and
 * returns UNAVAILABLE without touching sample memory. During a capture it
 * performs exactly four bounded memcpy calls and no allocation, lock, log,
 * wait, callback, or I/O. frame_sequence must remain contiguous, including
 * uint32 wrap; a discontinuity aborts rather than fabricating one waveform.
 */
enum iterate_kit_status iterate_kit_aec_diagnostic_trace_record(
    struct iterate_kit_aec_diagnostic_trace *trace,
    uint32_t frame_sequence,
    const int16_t *near_samples,
    const int16_t *reference_samples,
    const int16_t *linear_samples,
    const int16_t *clean_samples,
    size_t sample_count);

/**
 * Aborts an armed/in-progress trace after an audio-timeline reset.
 *
 * This belongs to the same realtime owner that calls record(). Keeping that
 * ownership rule avoids adding an in-flight writer lock/counter to every DSP
 * frame merely so a control RPC can cancel a rare diagnostic capture. The
 * control owner observes ABORTED and may then release the frozen generation.
 */
enum iterate_kit_status iterate_kit_aec_diagnostic_trace_abort(
    struct iterate_kit_aec_diagnostic_trace *trace);

void iterate_kit_aec_diagnostic_trace_snapshot(
    const struct iterate_kit_aec_diagnostic_trace *trace,
    struct iterate_kit_aec_diagnostic_trace_snapshot *snapshot);

/**
 * Copies a completed slice as four native int16 planes in this exact order:
 * near, reference, linear, clean. The capability adapter defines wire byte
 * order separately; this portable module does not smuggle a protocol into DSP.
 */
enum iterate_kit_status iterate_kit_aec_diagnostic_trace_read_planar(
    struct iterate_kit_aec_diagnostic_trace *trace,
    size_t sample_offset,
    size_t sample_count,
    int16_t *destination,
    size_t destination_values);

/** Releases READY/ABORTED evidence so a later generation may be armed. */
enum iterate_kit_status iterate_kit_aec_diagnostic_trace_release(
    struct iterate_kit_aec_diagnostic_trace *trace);

#ifdef __cplusplus
}
#endif

#endif
