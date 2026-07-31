#ifndef ITERATE_KIT_PCM_CLOCK_PLAYBACK_H
#define ITERATE_KIT_PCM_CLOCK_PLAYBACK_H

#include "iterate/kit/pcm_lane.h"
#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

struct iterate_kit_pcm_clock_playback_options {
  struct iterate_kit_pcm_lane *lane;

  /*
   * One caller-owned PCM-v1 frame is the complete private storage envelope.
   * A hardware cadence such as CoreS3's 128 samples cannot borrow a 320-sample
   * lane slot across clock edges because that would prevent the network owner
   * from reusing the bounded ring. Copying exactly one frame makes the cost
   * visible (640 bytes) without introducing another response FIFO.
   */
  int16_t *retained_frame;
  size_t retained_frame_capacity;

  /*
   * Frames older than this semantic limit are destroyed before playback. The
   * lane's capacity absorbs ordinary delivery jitter; it is not permission to
   * drain outage history after the conversation has moved on.
   */
  uint32_t maximum_frame_age_ms;

  /*
   * Stale scanning is bounded independently of ring capacity so an accidental
   * deep queue cannot consume an entire hardware deadline in one call.
   */
  size_t maximum_lane_items_per_render;
};

struct iterate_kit_pcm_clock_playback_result {
  size_t content_samples;
  size_t silence_samples;
  uint64_t oldest_received_at_ms;
  uint64_t newest_received_at_ms;
  bool receive_timing_valid;
  bool began_response;
  bool end_of_response;
};

struct iterate_kit_pcm_clock_playback_metrics {
  uint64_t content_samples_rendered;
  uint64_t idle_silence_samples;
  uint64_t underrun_silence_samples;
  uint64_t end_padding_silence_samples;
  uint64_t input_samples_discarded;
  uint64_t reset_samples_discarded;
  uint32_t frames_acquired;
  uint32_t frames_released;
  uint32_t stale_frames_discarded;
  uint32_t end_markers_consumed;
  uint32_t response_starts;
  uint32_t response_ends;
  uint32_t underrun_incidents;
  uint32_t stale_scan_budget_exhaustions;
  uint32_t timestamp_regressions;
  uint32_t lane_failures;
  uint32_t resets;
  uint32_t last_receive_to_render_ms;
  uint32_t maximum_receive_to_render_ms;
  size_t retained_samples;
  bool response_active;
};

/**
 * Allocation-free PCM-v1 to hardware-clock reframer.
 *
 * The network produces complete 320-sample / 20 ms frames; a codec is allowed
 * to demand any smaller or larger fixed chunk. render() is called by the one
 * high-priority audio owner whenever hardware needs samples. It copies from at
 * most `maximum_lane_items_per_render` ordered lane items and fills any
 * unavailable suffix with silence immediately. It never waits, retries, or
 * accumulates silence/debt for a later clock edge.
 *
 * An ordered zero-length lane item ends a response. Missing audio before that
 * marker is classified as an underrun; silence while no response is active is
 * ordinary idle. This distinction keeps expected always-on full-duplex clock
 * service out of error telemetry without concealing a clipped response.
 *
 * One task owns this object and the downlink consumer side of `lane`. The
 * network remains the only downlink producer. Callers must not alias the
 * output passed to render() with retained_frame.
 */
struct iterate_kit_pcm_clock_playback {
  struct iterate_kit_pcm_clock_playback_options options;
  struct iterate_kit_pcm_clock_playback_metrics metrics;
  size_t retained_offset;
  size_t retained_count;
  uint64_t retained_received_at_ms;
  bool initialized;
};

enum iterate_kit_status iterate_kit_pcm_clock_playback_init(
    struct iterate_kit_pcm_clock_playback *playback,
    const struct iterate_kit_pcm_clock_playback_options *options);

/**
 * Produces exactly sample_count samples for the current hardware clock edge.
 *
 * Silence is fully written into destination; callers never need a pre-clear.
 * A non-OK result reports local lane/timestamp corruption, but the destination
 * remains safe to write to the codec and all consumed/discarded ownership is
 * still accounted. Network absence and stale-frame purging are policy outcomes
 * and return OK.
 */
enum iterate_kit_status iterate_kit_pcm_clock_playback_render(
    struct iterate_kit_pcm_clock_playback *playback,
    uint64_t now_ms,
    int16_t *destination,
    size_t sample_count,
    struct iterate_kit_pcm_clock_playback_result *result);

/**
 * Destroys the retained suffix and response lifecycle at an interruption,
 * socket-generation barrier, I2S reset, or codec reset. The caller separately
 * purges complete lane items through iterate_kit_pcm_lane_discard_downlink();
 * preserving that producer/consumer ownership split avoids cross-task races.
 */
enum iterate_kit_status iterate_kit_pcm_clock_playback_reset(
    struct iterate_kit_pcm_clock_playback *playback);

const struct iterate_kit_pcm_clock_playback_metrics *
iterate_kit_pcm_clock_playback_metrics(
    const struct iterate_kit_pcm_clock_playback *playback);

#ifdef __cplusplus
}
#endif

#endif
