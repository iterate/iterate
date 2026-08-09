#ifndef ITERATE_KIT_AEC_CAPTURE_BRIDGE_H
#define ITERATE_KIT_AEC_CAPTURE_BRIDGE_H

#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Processes one device-native, clock-aligned near/reference/playout frame.
 *
 * The callback is synchronous, single-owner, non-blocking, and allocation
 * free. It must write exactly sample_count clean samples. A non-OK result is
 * treated as a safety failure: the bridge overwrites the entire destination
 * with silence, records the failure, and never substitutes the raw microphone.
 */
typedef enum iterate_kit_status (*iterate_kit_aec_process_fn)(
    void *context,
    const int16_t *near_samples,
    const int16_t *reference_samples,
    const int16_t *playout_samples,
    int16_t *clean_samples,
    size_t sample_count);

/**
 * Resets adaptive DSP after the input sample timeline becomes discontinuous.
 *
 * Returning an error leaves the bridge unable to accept the next epoch. It is
 * preferable to lose current microphone samples explicitly than to continue
 * an AEC filter whose near/reference timing is no longer meaningful.
 */
typedef enum iterate_kit_status (*iterate_kit_aec_reset_fn)(void *context);

/**
 * Copies one complete device-to-server PCM frame before returning.
 *
 * This callback must not retain samples. It is intentionally a synchronous
 * copy boundary because a retained borrow would require another frame queue
 * inside the bridge and could turn network backpressure into delayed speech.
 * captured_through_at_us is the local monotonic completion time of the final
 * microphone sample in this frame; it is not a wall clock or provider receipt
 * timestamp.
 */
typedef enum iterate_kit_status (*iterate_kit_aec_copy_egress_fn)(
    void *context,
    const int16_t *samples,
    size_t sample_count,
    uint32_t sample_rate_hz,
    uint64_t captured_through_at_us);

struct iterate_kit_aec_capture_bridge_options {
  uint32_t sample_rate_hz;
  size_t processing_frame_samples;
  size_t egress_frame_samples;

  /*
   * All five buffers are caller-owned, non-overlapping, and retained for the
   * bridge lifetime. Near/reference/playout/clean need
   * processing_frame_capacity; egress needs egress_frame_capacity. Reference
   * is the capture-clock-synchronous physical loudspeaker feedback presented
   * to AEC. Playout is a caller-defined, capture-aligned far-active signal;
   * CoreS3 currently fills it with a one/zero activity mask rather than
   * pretending the bridge contains exact amplifier output. Keeping that
   * policy signal separate from analogue feedback prevents noise or nonlinear
   * distortion from selecting the uplink branch. This explicit storage
   * envelope keeps internal-RAM cost visible in the target's resource report.
   */
  int16_t *near_frame;
  int16_t *reference_frame;
  int16_t *playout_frame;
  int16_t *clean_frame;
  size_t processing_frame_capacity;
  int16_t *egress_frame;
  size_t egress_frame_capacity;

  void *processor_context;
  iterate_kit_aec_process_fn process;
  iterate_kit_aec_reset_fn reset_processor;
  void *egress_context;
  iterate_kit_aec_copy_egress_fn copy_egress;
};

struct iterate_kit_aec_capture_bridge_metrics {
  uint64_t input_samples_accepted;
  uint64_t input_samples_discarded;
  uint64_t clean_samples_produced;
  uint64_t clean_samples_discarded;
  uint64_t egress_samples_copied;
  uint64_t processor_silence_samples;
  uint32_t processor_frames;
  uint32_t processor_failures;
  uint32_t processor_reset_failures;
  uint32_t egress_frames_copied;
  uint32_t egress_copy_failures;
  uint32_t sequence_discontinuities;
  uint32_t timestamp_regressions;
  uint32_t epoch_resets;
  size_t input_partial_samples;
  size_t egress_partial_samples;
};

/**
 * Allocation-free bridge between a board's AEC cadence and PCM v1 cadence.
 *
 * CoreS3 is the motivating case: its VOIP AEC processes 256 samples while PCM
 * v1 sends 320. Keeping either as a FIFO of whole frames produces a
 * beat-pattern backlog. Instead, one owner copies aligned DMA chunks into one
 * DSP frame and drains clean samples through one partial wire frame. Storage
 * is therefore exactly four DSP frames plus one wire frame, with no task,
 * lock, allocation, retry, or hidden capacity. The fourth frame is deliberate:
 * aliasing the synchronous physical feedback with playback-activity metadata
 * would make either AEC quality or far-active selection depend on the wrong
 * signal. The bridge carries both without claiming the activity mask is an
 * exact copy of the PCM that physically left the amplifier.
 *
 * A non-contiguous DMA sequence destroys both raw and clean partial epochs and
 * resets the processor before the new chunk is accepted. An egress rejection
 * destroys the rejected frame and the remaining clean suffix of that DSP
 * result: recovered connectivity starts with current audio rather than FIFO
 * history. These losses are exact counters, not benign log messages.
 *
 * The struct is public only so callers can own it statically. Treat its fields
 * as private and observe state through metrics(). Mutating operations belong
 * to one task; this type contains no atomics.
 */
struct iterate_kit_aec_capture_bridge {
  struct iterate_kit_aec_capture_bridge_options options;
  struct iterate_kit_aec_capture_bridge_metrics metrics;
  size_t input_fill;
  size_t egress_fill;
  uint32_t last_sequence;
  uint64_t last_captured_through_at_us;
  bool sequence_valid;
  bool timestamp_valid;
  bool initialized;
};

enum iterate_kit_status iterate_kit_aec_capture_bridge_init(
    struct iterate_kit_aec_capture_bridge *bridge,
    const struct iterate_kit_aec_capture_bridge_options *options);

/**
 * Copies one clock-contiguous near/reference set plus its far-active policy.
 *
 * sequence identifies the capture DMA completion and must increment once per
 * call (uint32 wrap is valid). Near and reference must describe samples from
 * the same capture completion. Playout is deliberately only a caller-defined,
 * capture-aligned far-active policy signal; the bridge must not make capture
 * wait for a speaker-completion callback in an attempt to manufacture a third
 * clock domain. CoreS3 therefore supplies an activity mask sampled by the RX
 * callback, while another adapter may supply a more exact capture-aligned tap.
 * This abstraction cannot prove electrical or acoustic alignment.
 * captured_through_at_us timestamps the final near/reference sample. The call
 * may synchronously process/copy multiple output frames but never waits for a
 * consumer.
 */
enum iterate_kit_status iterate_kit_aec_capture_bridge_push_aligned(
    struct iterate_kit_aec_capture_bridge *bridge,
    uint32_t sequence,
    uint64_t captured_through_at_us,
    const int16_t *near_samples,
    const int16_t *reference_samples,
    const int16_t *playout_samples,
    size_t sample_count);

/**
 * Starts a new alignment epoch and destroys every partial sample explicitly.
 * Use this after I2S restart, DMA overflow, codec reconfiguration, or another
 * event which invalidates sample continuity. Network reconnect alone does not
 * invalidate acoustic alignment and should not reset the adaptive filter.
 */
enum iterate_kit_status iterate_kit_aec_capture_bridge_reset(
    struct iterate_kit_aec_capture_bridge *bridge);

/**
 * Reads the counters without touching them.
 *
 * THE READER USED TO WRITE. It copied `input_fill`/`egress_fill` into the two
 * partial-sample members on every call — but both members are already kept
 * current at each fill site, so the writes changed nothing and only made
 * observing the bridge an operation that mutates it. That cost stackchan a
 * workaround: its app loop could not read its own health document without
 * racing the audio task, so the read had to be moved onto the owning task and
 * mirrored through atomics. A const reader is safe from any task, subject to
 * the usual torn-read caveat on a struct this size.
 */
const struct iterate_kit_aec_capture_bridge_metrics *
iterate_kit_aec_capture_bridge_metrics(
    const struct iterate_kit_aec_capture_bridge *bridge);

#ifdef __cplusplus
}
#endif

#endif
