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

typedef void (*iterate_kit_pcm_clock_playback_item_released_fn)(
    void *context,
    uint32_t released_items);

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

  /*
   * Minimum number of complete ordered lane items required before an inactive
   * response may begin. WebSocket delivery exposes complete messages one at a
   * time even when userspace already owns a healthy response reservoir. If the
   * codec starts on the first message, ordinary packetization can turn the
   * following hardware edge into an audible underrun.
   *
   * This is a finite startup cushion, not a jitter queue: it is consulted only
   * while no response is active and never refills or delays an active response.
   * A first current frame may be held in the single retained-frame workspace
   * while the producer refills the slots freed by a bounded stale-epoch scan;
   * that private frame counts as one item toward this watermark.
   * A queued ordered EOS bypasses it because EOS proves that every frame in a
   * shorter response is already local. Zero preserves immediate-start behavior
   * for platforms or tests that deliberately do not need a cushion.
   */
  size_t minimum_start_items;

  /*
   * Optional capacity-credit seam invoked after ordered lane items are
   * successfully released by the hardware-clocked consumer. Ordinary render
   * calls report one; an interruption purge reports its bounded epoch in one
   * bulk call so the priority audio task does not issue one task wake per item.
   * This is not an
   * audible-sample acknowledgement: a PCM frame has first been copied into the
   * fixed retained_frame above, and an EOS marker carries no samples. It does
   * prove that exactly one finite downlink-ring slot is reusable.
   *
   * The callback runs inside the highest-priority playback task. It must be
   * bounded, allocation-free, nonblocking, and must never perform networking,
   * logging, or lock acquisition. A platform adapter may use an atomic counter
   * here and let its lower-priority network owner emit coalesced flow-control
   * later. Socket-ingress receipts were rejected because they let a remote
   * timer, rather than the codec clock, control supply and caused physical
   * choppiness when a Cloudflare timer woke 380 ms late.
   */
  iterate_kit_pcm_clock_playback_item_released_fn item_released;
  void *item_released_context;
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
  uint32_t startup_wait_edges;
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
 * An ordered zero-length lane item ends a response. Once a response starts,
 * missing audio before that marker is classified as an underrun; finite
 * startup-watermark silence and silence while no response is active are
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
  /*
   * Once a full startup watermark exposes stale outage history, scanning must
   * remain authorized across hardware edges until the first current frame is
   * privately retained. Rechecking the watermark after every discard creates
   * a permanent N-1-slot deadlock under a slow trickle. This state never lets
   * audio play below the watermark; it only authorizes bounded destruction of
   * known-old items so the network producer can refill with current audio.
   */
  bool startup_scan_in_progress;
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

/**
 * Purges complete queued items and returns their finite sender capacity.
 *
 * This is the consumer-side companion to reset(). A response interruption
 * invalidates both the retained suffix and every complete item already queued
 * behind it. Calling pcm_lane_discard_downlink() directly would free those
 * ring slots without invoking the playback capacity callback, stranding the
 * remote sender's credit ledger. The work is bounded by the lane's initial
 * depth, performs no allocation or blocking, and emits at most one callback.
 */
enum iterate_kit_status iterate_kit_pcm_clock_playback_discard_queued(
    struct iterate_kit_pcm_clock_playback *playback,
    uint32_t *discarded_frames,
    uint32_t *discarded_items);

const struct iterate_kit_pcm_clock_playback_metrics *
iterate_kit_pcm_clock_playback_metrics(
    const struct iterate_kit_pcm_clock_playback *playback);

#ifdef __cplusplus
}
#endif

#endif
