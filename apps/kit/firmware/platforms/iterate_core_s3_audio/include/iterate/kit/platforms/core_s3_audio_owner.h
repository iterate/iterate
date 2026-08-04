#ifndef ITERATE_KIT_PLATFORMS_CORE_S3_AUDIO_OWNER_H
#define ITERATE_KIT_PLATFORMS_CORE_S3_AUDIO_OWNER_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "iterate/kit/aec_capture_bridge.h"
#include "iterate/kit/aec_signal_window.h"
#include "iterate/kit/aec_diagnostic_trace.h"
#include "iterate/kit/audio.h"
#include "iterate/kit/pcm_capture_turn.h"
#include "iterate/kit/pcm_clock_playback.h"
#include "iterate/kit/pcm_generation_fence.h"
#include "iterate/kit/pcm_lane.h"
#include "iterate/kit/pcm_playback_interruption.h"
#include "iterate/kit/platforms/core_s3_bsp_audio.h"
#include "iterate/kit/platforms/core_s3_capture_reserve.h"

#ifdef __cplusplus
extern "C" {
#endif

#define ITERATE_KIT_CORE_S3_AUDIO_SAMPLE_RATE_HZ 16000U
#define ITERATE_KIT_CORE_S3_AEC_VOIP_FRAME_SAMPLES 256U
#define ITERATE_KIT_CORE_S3_AEC_FD_FRAME_SAMPLES 512U
#define ITERATE_KIT_CORE_S3_AEC_MAX_FRAME_SAMPLES 512U
/*
 * These gains are part of the observable uplink contract, not private DSP
 * tuning. The metrics producer and selector must share one definition so the
 * off-device oracle can undo the exact gain applied to its selected wire tap.
 */
#define ITERATE_KIT_CORE_S3_AEC_RAW_GAIN_MULTIPLIER 6U
/*
 * A user should not need to raise their voice merely to cross provider VAD.
 * Keep the analogue PGA at the physically measured AEC-headroom point and
 * apply this modest +1.94 dB increase only after ESP-SR has produced the clean
 * channel. Ten is deliberately below the tempting x12 step: every saturated
 * output sample is observable, but clipping after AEC still damages near-end
 * speech and cannot be repaired by the provider.
 */
#define ITERATE_KIT_CORE_S3_AEC_PROCESSED_GAIN_MULTIPLIER 10U

enum iterate_kit_core_s3_aec_profile {
  /* Retained A/B control: measured VOIP output plus far-active raw bypass. */
  ITERATE_KIT_CORE_S3_AEC_VOIP_SELECTOR = 1,
  /* First-party full-duplex mode with one stable processed wire signal. */
  ITERATE_KIT_CORE_S3_AEC_FD_NORMAL_CONSTANT = 2,
  /* Measured VOIP engine with no raw/processed playback-edge switch. */
  ITERATE_KIT_CORE_S3_AEC_VOIP_CONSTANT = 3,
  /* Same VOIP adaptive filter, publishing before residual nonlinear
     suppression. */
  ITERATE_KIT_CORE_S3_AEC_VOIP_LINEAR_CONSTANT = 4,
  /* High-performance full-duplex engine with one stable processed signal. */
  ITERATE_KIT_CORE_S3_AEC_FD_HIGH_PERF_CONSTANT = 5,
  /* Same FD high-performance filter, publishing before nonlinear suppression. */
  ITERATE_KIT_CORE_S3_AEC_FD_HIGH_PERF_LINEAR_CONSTANT = 6,
};

/**
 * Return the processing cadence required by one AEC profile.
 *
 * A target has to allocate and initialise cold diagnostic storage before the
 * realtime audio owner starts. That storage must use the same cadence as the
 * selected DSP engine: a hard-coded 256-sample trace silently diverged when
 * StackChan moved to a 512-sample full-duplex profile, leaving Wi-Fi alive but
 * rejecting the audio owner before Cap'n Web could mount. Keeping this mapping
 * at the platform boundary gives targets one source of truth without exposing
 * ESP-SR implementation details or duplicating its profile switch.
 *
 * Returns zero for an unknown profile so option validation can reject it.
 */
size_t iterate_kit_core_s3_aec_processing_frame_samples(
    enum iterate_kit_core_s3_aec_profile profile);

/**
 * Optional observer of PCM which has physically completed speaker DMA.
 *
 * This is deliberately not a generic audio callback. It runs in I2S interrupt
 * context after one 128-sample descriptor leaves the hardware queue, so it is
 * the only honest clock for lip sync and acoustic diagnostics. An observer
 * must live entirely in IRAM/internal DRAM, allocate nothing, never block or
 * log, and return true only if it woke a higher-priority task. Copy into a
 * bounded latest-state handoff; retaining a FIFO here would let visual work
 * recreate the accumulating audio delay that the PCM lane rejects.
 */
typedef bool (*iterate_kit_core_s3_playout_observer_fn)(
    uint32_t sequence,
    uint64_t completed_at_us,
    const int16_t *samples,
    size_t sample_count,
    void *context);

struct iterate_kit_core_s3_audio_owner_options {
  struct iterate_kit_pcm_lane *lane;
  /*
   * Selects only the publication boundary around the continuously running AEC
   * graph. PTT emits an ordered END marker on release; full-duplex AEC closes
   * without one because server VAD owns speech boundaries. Device identity is
   * intentionally absent so every CoreS3 profile exercises the same policy.
   */
  enum iterate_kit_audio_mode audio_mode;
  enum iterate_kit_core_s3_aec_profile aec_profile;
  uint32_t maximum_downlink_frame_age_ms;
  size_t maximum_lane_items_per_dma_chunk;
  int speaker_volume_percent;
  int microphone_gain_db;
  /*
   * Gain for the physical electrical loudspeaker divider consumed by AEC.
   * The high-priority playback owner separately attaches a one-bit far-active
   * decision to each microphone edge. It is intentionally not a second PCM
   * stream: using pristine TX as the adaptive reference lost amplifier
   * distortion, while waiting for TX callbacks could starve healthy capture.
   */
  int reference_gain_db;

  /*
   * Optional cold evidence sink. The target owns its fixed storage and arms
   * it from Cap'n Web; this realtime owner only makes bounded copies while a
   * generation is armed. Keeping the object injected prevents the audio
   * platform from owning RPC, allocation, or artifact lifecycle.
   */
  struct iterate_kit_aec_diagnostic_trace *diagnostic_trace;

  /*
   * Optional nonblocking wake for the PCM connection owner. The audio task
   * invokes it only after publishing an uplink item or requesting a destructive
   * reset due to lane pressure; a FreeRTOS task notification is appropriate.
   */
  iterate_kit_pcm_capture_turn_notify_fn notify_uplink;
  void *notify_uplink_context;

  /*
   * Capacity-credit callback inherited by pcm_clock_playback. It runs on the
   * priority I/O task and therefore has the same bounded/nonblocking contract
   * as notify_uplink; see pcm_clock_playback_options for its exact semantics.
   */
  iterate_kit_pcm_clock_playback_item_released_fn downlink_item_released;
  void *downlink_item_released_context;

  /* Optional physical-playout observer; see the ISR contract above. */
  iterate_kit_core_s3_playout_observer_fn observe_playout;
  void *observe_playout_context;
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
  enum iterate_kit_core_s3_aec_profile aec_profile;
  uint32_t aec_frame_samples;
  uint32_t near_window_gain_multiplier;
  uint32_t far_window_gain_multiplier;
  int speaker_volume_percent;
  int microphone_gain_db;
  int reference_gain_db;

  iterate_kit_core_s3_i2s_stats_t i2s;
  struct iterate_kit_core_s3_capture_reserve_metrics capture_reserve;
  struct iterate_kit_pcm_lane_metrics lane;
  struct iterate_kit_pcm_capture_turn_metrics capture_turn;
  struct iterate_kit_pcm_generation_fence_metrics generation_fence;
  struct iterate_kit_pcm_playback_interruption_metrics playback_interruption;

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
  uint32_t playback_underrun_incidents;
  uint32_t playback_underrun_silence_samples;
  uint32_t playback_stale_frames_discarded;
  uint32_t playout_observer_frames;
  uint32_t playout_observer_shape_errors;

  uint32_t capture_chunks_deinterleaved;
  uint32_t tdm_slot_peak[ITERATE_KIT_CORE_S3_TDM_SLOT_COUNT];
  uint32_t capture_chunks_with_playback_content;
  uint32_t capture_chunks_without_playback_content;
  uint32_t capture_bridge_errors;
  uint32_t aec_frames;
  uint32_t aec_recreates;
  uint32_t aec_recreate_failures;
  uint32_t last_aec_process_us;
  uint32_t maximum_aec_process_us;
  uint32_t clean_uplink_frames;
  uint32_t clean_uplink_drops;
  /*
   * One canonical count of terminal capture-pipeline failures. This is not a
   * sum of every detailed diagnostic below: for example, an AEC recreate
   * failure is already observed as a capture-bridge failure. Keeping the
   * aggregate non-overlapping lets the shared metrics schema expose a useful
   * error counter without double-counting one physical incident.
   */
  uint32_t capture_failures;
  uint32_t last_capture_to_uplink_us;
  uint32_t maximum_capture_to_uplink_us;
  uint32_t aec_signal_measurement_failures;
  /*
   * Lifetime samples saturated by the stateful near-input high-pass. A nonzero
   * delta invalidates speech-quality evidence even when cadence remained exact:
   * it proves the conditioner lost amplitude information before AEC/uplink.
   */
  uint32_t near_high_pass_clipped_samples;
  /*
   * Lifetime saturations at the other two gain boundaries. A zero delta is a
   * physical-proof precondition: cadence can be exact while a railed AEC
   * reference or selected uplink has already destroyed waveform information.
   */
  uint32_t reference_scale_clipped_samples;
  uint32_t uplink_gain_clipped_samples;
  uint32_t aec_input_partial_samples;
  uint32_t clean_egress_partial_samples;
  uint32_t capture_turn_poll_failures;

  uint32_t io_stack_minimum_free_bytes;
  uint32_t aec_stack_minimum_free_bytes;
  uint32_t internal_heap_free_bytes;
  uint32_t internal_heap_largest_block_bytes;
  uint32_t psram_heap_free_bytes;
  uint32_t psram_heap_largest_block_bytes;
};

struct iterate_kit_core_s3_aec_signal_metrics {
  uint32_t sequence;
  uint64_t window_started_at_us;
  uint64_t produced_at_us;
  struct iterate_kit_aec_signal_summary signal;
};

/**
 * Starts the one CoreS3 audio hardware owner for this boot.
 *
 * CoreS3 has one shared I2S clock and two singleton codec handles, so
 * pretending this is a freely-instantiable object would create an API promise
 * the board cannot honour. Startup may allocate inside the BSP/codecs and
 * ESP-SR. Every Iterate queue, frame, task stack, and task control block is
 * static; the two steady-state owner loops allocate nothing and never log.
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

/**
 * Capability-side half of the physical playback interruption barrier.
 *
 * These signatures intentionally match the generic conversation driver. The
 * request only admits a constant-space token; poll returns OK only after the
 * priority CoreS3 I/O task has purged retained and queued speaker samples.
 */
enum iterate_kit_status
iterate_kit_core_s3_audio_owner_request_playback_interruption(void *context,
                                                              uint32_t *token);
enum iterate_kit_status
iterate_kit_core_s3_audio_owner_poll_playback_interruption(void *context,
                                                           uint32_t token);

/**
 * Nonblocking speaker-generation barrier for the ESP-IDF PCM transport.
 *
 * The first call for a `{generation, connected}` target queues a physical
 * owner reset and returns UNAVAILABLE. A later call returns OK only after the
 * priority audio owner has destroyed retained playback and the downlink lane.
 * This signature intentionally matches the transport callback contract.
 */
enum iterate_kit_status
iterate_kit_core_s3_audio_owner_downlink_generation_barrier(void *context,
                                                            uint32_t generation,
                                                            bool connected);

/**
 * Enqueues one manual-PTT publication edge for the continuous AEC task.
 *
 * The hardware microphone and reference remain clocked in both states. The
 * AEC task drains already-reserved raw audio before applying the edge, then it
 * alone starts/stops PCM publication and emits the ordered turn marker. This
 * keeps control code off the realtime lane and avoids resetting AEC on every
 * human button edge.
 *
 * Exactly one cooperative control owner may call this function; the embedded
 * command queue is SPSC, not a multi-producer convenience queue. Remote and
 * physical edges must first converge on that owner. BACKPRESSURE means the
 * requested edge was not accepted: in particular, a rejected stop must be
 * retried by that owner and conversation teardown must keep requesting stop
 * until it is accepted. Treating a rejected stop as success can leave the
 * microphone publishing indefinitely.
 */
enum iterate_kit_status iterate_kit_core_s3_audio_owner_request_uplink_active(
    bool active);

void iterate_kit_core_s3_audio_owner_metrics_snapshot(
    struct iterate_kit_core_s3_audio_owner_metrics *snapshot);

/**
 * Copies the newest exact near/reference/linear/final signal window.
 *
 * The implementation holds its cross-core critical section only while copying
 * fixed metadata and nine accumulator scalars. Sample walking and integer
 * division happen outside that section, so a diagnostics callback cannot
 * stretch an audio deadline. The audio owner rotates windows on its own
 * one-second clock; an unrelated getDiagnostics() call therefore cannot consume
 * the interval that an AEC subscriber was waiting to observe.
 */
enum iterate_kit_status
iterate_kit_core_s3_audio_owner_aec_signal_metrics_snapshot(
    struct iterate_kit_core_s3_aec_signal_metrics *snapshot);

#ifdef __cplusplus
}
#endif

#endif
