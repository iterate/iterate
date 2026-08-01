#ifndef ITERATE_KIT_PLATFORMS_CORE_S3_AUDIO_OWNER_H
#define ITERATE_KIT_PLATFORMS_CORE_S3_AUDIO_OWNER_H

#include "iterate/kit/aec_capture_bridge.h"
#include "iterate/kit/pcm_clock_playback.h"
#include "iterate/kit/pcm_lane.h"
#include "iterate/kit/platforms/core_s3_capture_reserve.h"
#include "iterate/kit/platforms/core_s3_bsp_audio.h"

#include "esp_err.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define ITERATE_KIT_CORE_S3_AUDIO_SAMPLE_RATE_HZ 16000U
#define ITERATE_KIT_CORE_S3_AEC_FRAME_SAMPLES 512U

struct iterate_kit_core_s3_audio_owner_options {
  struct iterate_kit_pcm_lane *lane;
  uint32_t maximum_downlink_frame_age_ms;
  size_t maximum_lane_items_per_dma_chunk;
  int speaker_volume_percent;
  int microphone_gain_db;
};

/**
 * A low-rate, cross-task diagnostics snapshot.
 *
 * Names deliberately stop at software boundaries. `receive_to_render` ends
 * when current PCM is handed to the codec; only an acoustic loopback capture
 * can measure when that sample becomes audible. Similarly,
 * `capture_to_uplink` ends when clean PCM is copied into the device lane, not
 * when a remote provider receives it. Reporting either as end-to-end latency
 * would make a pretty graph out of an unmeasured assumption.
 */
struct iterate_kit_core_s3_audio_owner_metrics {
  bool ready;
  bool playback_failed;
  bool capture_failed;
  uint32_t sample_rate_hz;
  uint32_t dma_frame_samples;
  uint32_t dma_descriptor_count;
  uint32_t configured_dma_reserve_ms;
  uint32_t static_owner_bytes;

  iterate_kit_core_s3_i2s_stats_t i2s;
  struct iterate_kit_core_s3_capture_reserve_metrics capture_reserve;
  struct iterate_kit_pcm_lane_metrics lane;

  uint32_t io_cycles;
  uint32_t codec_write_errors;
  uint32_t codec_read_errors;
  uint32_t playback_policy_errors;
  uint32_t playback_content_samples;
  uint32_t playback_silence_samples;
  uint32_t playback_resets;
  uint32_t downlink_frames_discarded_by_reset;
  uint32_t last_codec_write_us;
  uint32_t maximum_codec_write_us;
  uint32_t last_codec_read_us;
  uint32_t maximum_codec_read_us;
  uint32_t last_receive_to_render_ms;
  uint32_t maximum_receive_to_render_ms;

  uint32_t capture_chunks_deinterleaved;
  uint32_t tdm_slot_peak[ITERATE_KIT_CORE_S3_TDM_SLOT_COUNT];
  uint32_t capture_bridge_errors;
  uint32_t aec_frames;
  uint32_t aec_recreates;
  uint32_t aec_recreate_failures;
  uint32_t last_aec_linear_us;
  uint32_t maximum_aec_linear_us;
  uint32_t last_aec_nlp_us;
  uint32_t maximum_aec_nlp_us;
  uint32_t clean_uplink_frames;
  uint32_t clean_uplink_drops;
  uint32_t last_capture_to_uplink_us;
  uint32_t maximum_capture_to_uplink_us;
  uint32_t aec_input_partial_samples;
  uint32_t clean_egress_partial_samples;

  uint32_t io_stack_minimum_free_bytes;
  uint32_t aec_stack_minimum_free_bytes;
  uint32_t internal_heap_free_bytes;
  uint32_t internal_heap_largest_block_bytes;
  uint32_t psram_heap_free_bytes;
  uint32_t psram_heap_largest_block_bytes;
};

/**
 * Starts the one CoreS3 audio hardware owner for this boot.
 *
 * CoreS3 has one shared I2S clock and two singleton codec handles, so pretending
 * this is a freely-instantiable object would create an API promise the board
 * cannot honour. Startup may allocate inside the BSP/codecs and ESP-SR. Every
 * Iterate queue, frame, task stack, and task control block is static; the two
 * steady-state owner loops allocate nothing and never log.
 */
esp_err_t iterate_kit_core_s3_audio_owner_start(
    const struct iterate_kit_core_s3_audio_owner_options *options);

/**
 * Requests a consumer-owned speaker generation barrier.
 *
 * Socket teardown/interruption can call this from another task without
 * touching the downlink ring's consumer cursor. At the next 8 ms hardware
 * edge, the audio owner destroys its retained suffix and every queued frame
 * before rendering. Thus pre-interruption speech cannot play after recovery.
 */
void iterate_kit_core_s3_audio_owner_request_playback_reset(void);

void iterate_kit_core_s3_audio_owner_metrics_snapshot(
    struct iterate_kit_core_s3_audio_owner_metrics *snapshot);

#ifdef __cplusplus
}
#endif

#endif
