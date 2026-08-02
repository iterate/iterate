#ifndef ITERATE_KIT_PLATFORMS_VOICE_PE_AUDIO_OWNER_H
#define ITERATE_KIT_PLATFORMS_VOICE_PE_AUDIO_OWNER_H

#include "iterate/kit/aec_signal_window.h"
#include "iterate/kit/pcm_capture_turn.h"
#include "iterate/kit/pcm_generation_fence.h"
#include "iterate/kit/pcm_lane.h"
#include "iterate/kit/pcm_playback_interruption.h"

#include "esp_err.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  ITERATE_KIT_VOICE_PE_CAPTURE_RATE_HZ = 16000,
  ITERATE_KIT_VOICE_PE_PLAYBACK_RATE_HZ = 48000,
  ITERATE_KIT_VOICE_PE_CAPTURE_FRAME_SAMPLES = 320,
  ITERATE_KIT_VOICE_PE_PLAYBACK_EDGE_SAMPLES = 160,
};

struct iterate_kit_voice_pe_audio_owner_options {
  struct iterate_kit_pcm_lane *lane;
  uint32_t maximum_downlink_frame_age_ms;
  size_t maximum_lane_items_per_playback_edge;

  /*
   * The capture task calls this only after a complete current 20 ms frame is
   * visible to the PCM network owner. A task notification is the intended
   * implementation: this callback must not touch a socket, allocate, or wait.
   */
  iterate_kit_pcm_capture_turn_notify_fn notify_uplink;
  void *notify_uplink_context;
};

/**
 * One low-rate view over the board's two exact same-time XMOS output taps.
 *
 * `raw` is pipeline stage NONE (the original microphone); `clean` is pipeline
 * stage NS, after AEC/IC/NS but before AGC. This intentionally does not manufacture an
 * aligned speaker-reference channel: the board does not expose the XMOS
 * reference on its capture I2S bus. A speaker-only physical interval can
 * still measure raw-to-clean echo suppression honestly. A later calibrated
 * reference alignment may extend the public schema, but zero or scheduler-
 * aligned intended playback must never be presented as measured reference.
 */
struct iterate_kit_voice_pe_aec_signal_summary {
  uint32_t sample_stride;
  uint32_t sampled_samples;
  uint32_t raw_peak;
  uint32_t clean_peak;
  uint32_t raw_mean_absolute;
  uint32_t clean_mean_absolute;
  /*
   * The original microphone is quiet enough that an integer mean of 9 versus
   * 11 changes a normalized AEC verdict by several dB. These exact totals are
   * copied from accumulators the realtime path already maintains: publishing
   * them adds no per-sample work and lets the host combine settled windows
   * without inventing precision from rounded means.
   */
  uint64_t raw_absolute_sum;
  uint64_t clean_absolute_sum;
  /* Non-silence physically submitted while this capture window was open. */
  uint32_t playback_content_samples;
};

struct iterate_kit_voice_pe_aec_signal_metrics {
  uint32_t sequence;
  uint64_t window_started_at_us;
  uint64_t produced_at_us;
  struct iterate_kit_voice_pe_aec_signal_summary signal;
};

struct iterate_kit_voice_pe_audio_owner_metrics {
  bool ready;
  bool playback_failed;
  bool capture_failed;
  uint32_t capture_rate_hz;
  uint32_t playback_rate_hz;
  uint32_t capture_dma_frame_samples;
  uint32_t playback_dma_frame_samples;
  uint32_t capture_dma_descriptor_count;
  uint32_t playback_dma_descriptor_count;
  uint32_t capture_dma_reserve_ms;
  uint32_t playback_dma_reserve_ms;
  uint32_t static_owner_bytes;

  struct iterate_kit_pcm_lane_metrics lane;
  struct iterate_kit_pcm_capture_turn_metrics capture_turn;
  struct iterate_kit_pcm_generation_fence_metrics generation_fence;
  struct iterate_kit_pcm_playback_interruption_metrics
      playback_interruption;

  uint32_t playback_edges;
  uint32_t playback_content_samples;
  uint32_t playback_silence_samples;
  uint32_t playback_policy_errors;
  uint32_t playback_write_errors;
  uint32_t playback_partial_writes;
  uint32_t playback_queue_overflows;
  uint32_t playback_resets;
  uint32_t playback_reset_failures;
  uint32_t downlink_frames_discarded_by_reset;
  uint32_t last_playback_write_us;
  uint32_t maximum_playback_write_us;
  uint32_t last_receive_to_render_ms;
  uint32_t maximum_receive_to_render_ms;

  uint32_t capture_frames;
  uint32_t capture_read_errors;
  uint32_t capture_partial_reads;
  uint32_t capture_queue_overflows;
  uint32_t capture_resets;
  uint32_t capture_reset_failures;
  uint32_t capture_format_errors;
  uint32_t capture_turn_poll_failures;
  uint32_t aec_signal_measurement_failures;
  uint32_t clean_uplink_frames;
  uint32_t clean_uplink_drops;
  uint32_t capture_failures;
  uint32_t last_capture_read_us;
  uint32_t maximum_capture_read_us;
  uint32_t last_capture_to_uplink_us;
  uint32_t maximum_capture_to_uplink_us;

  uint32_t playback_stack_minimum_free_bytes;
  uint32_t capture_stack_minimum_free_bytes;
  uint32_t internal_heap_free_bytes;
  uint32_t internal_heap_largest_block_bytes;
  uint32_t psram_heap_free_bytes;
  uint32_t psram_heap_largest_block_bytes;
};

/**
 * Peak-hold activity accumulated since the previous take.
 *
 * This is intentionally a destructive, single-consumer observation for a
 * low-rate physical UI—not a second metrics stream. Each realtime owner only
 * raises one atomic integer; it never queues samples, wakes the UI, touches
 * LEDs, logs, or allocates. The UI owner exchanges both values back to zero,
 * so stopped audio becomes visibly quiet on its next refresh rather than
 * decaying from retained history.
 */
struct iterate_kit_voice_pe_audio_activity {
  uint32_t microphone_peak;
  uint32_t speaker_peak;
};

/**
 * Starts the singleton Voice Preview Edition audio owner for this boot.
 *
 * The XMOS and AIC3204 are singleton peripherals with independent 16 kHz RX
 * and 48 kHz TX clocks. Two pinned priority tasks therefore own one blocking
 * I2S direction each. All Iterate task stacks and audio frames are static, and
 * ordinary capture/playback performs no allocation or logging.
 */
esp_err_t iterate_kit_voice_pe_audio_owner_start(
    const struct iterate_kit_voice_pe_audio_owner_options *options);

void iterate_kit_voice_pe_audio_owner_request_playback_reset(void);

enum iterate_kit_status
iterate_kit_voice_pe_audio_owner_request_playback_interruption(
    void *context, uint32_t *token);
enum iterate_kit_status
iterate_kit_voice_pe_audio_owner_poll_playback_interruption(
    void *context, uint32_t token);
enum iterate_kit_status
iterate_kit_voice_pe_audio_owner_downlink_generation_barrier(
    void *context, uint32_t generation, bool connected);

/**
 * Opens/closes publication only; XMOS capture and AEC continue uninterrupted.
 * Full-duplex server-VAD mode suppresses a device-authored end-of-turn marker.
 */
enum iterate_kit_status
iterate_kit_voice_pe_audio_owner_request_uplink_active(bool active);

void iterate_kit_voice_pe_audio_owner_metrics_snapshot(
    struct iterate_kit_voice_pe_audio_owner_metrics *snapshot);
void iterate_kit_voice_pe_audio_owner_take_activity(
    struct iterate_kit_voice_pe_audio_activity *activity);
enum iterate_kit_status
iterate_kit_voice_pe_audio_owner_aec_signal_metrics_snapshot(
    struct iterate_kit_voice_pe_aec_signal_metrics *snapshot);

#ifdef __cplusplus
}
#endif

#endif
