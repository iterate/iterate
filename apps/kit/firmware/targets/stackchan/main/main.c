#include "esp_attr.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "iterate/kit/audio_intent_reconciler.h"
#include "iterate/kit/control_recovery.h"
#include "iterate/kit/conversation_lights.h"
#include "iterate/kit/cpu_usage.h"
#include "iterate/kit/devices/stackchan.h"
#include "iterate/kit/pcm_lane.h"
#include "iterate/kit/pcm_websocket.h"
#include "iterate/kit/platforms/core_s3_audio_owner.h"
#include "iterate/kit/platforms/esp_idf_configuration.h"
#include "iterate/kit/platforms/esp_idf_itx_transport.h"
#include "iterate/kit/platforms/esp_idf_pcm_session.h"
#include "iterate/kit/platforms/esp_idf_pcm_transport.h"
#include "iterate/kit/platforms/esp_idf_websocket_policy.h"
#include "iterate/kit/platforms/stackchan_avatar.h"
#include "iterate/kit/platforms/stackchan_body.h"
#include "iterate/kit/platforms/stackchan_hardware.h"
#include "iterate/kit/spsc_ring.h"
#include "iterate/kit/voice_device_profile.h"
#include "stackchan_realtime_policy.h"
/*
 * ESP-IDF's public Wi-Fi declarations use deliberate GCC extensions. Keep
 * pedantic diagnostics for this target while treating that SDK boundary as a
 * system interface, rather than disabling the warning for all application C.
 */
#if defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wpedantic"
#endif
#include "esp_wifi.h"
#if defined(__GNUC__)
#pragma GCC diagnostic pop
#endif
#include <limits.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/task.h"

/*
 * StackChan's target is intentionally composition, not a second voice stack:
 *
 *   Cap'n Web control  -> portable StackChan profile -> desired PTT state
 *   binary /pcm socket <-> bounded shared lane <-> CoreS3 audio owner/AEC
 *
 * The codec owner runs continuously at the hardware clock and never waits for
 * DNS, TLS, Cap'n Web, camera, display, or this cooperative application loop.
 * Conversely, the two WebSocket owners never touch codec state. This is the
 * minimum separation that lets a slow capability or reconnect be observable
 * without becoming audible delay.
 *
 * Every application-owned queue and workspace below is static. Ring capacity
 * is a finite jitter reserve, never permission to replay outage history: the
 * shared lane/transport destroy an unhealthy generation and resume at "now".
 */

#define STACKCHAN_PENDING_CALL_CAPACITY 8U
#define STACKCHAN_EXPORT_CAPACITY 8U
#define STACKCHAN_IMPORT_CAPACITY 8U
#define STACKCHAN_TOKEN_CAPACITY 64U
#define STACKCHAN_OUTPUT_CAPACITY 128U
#define STACKCHAN_METRICS_SUBSCRIPTION_CAPACITY 3U
#define STACKCHAN_SCREEN_URL_CAPACITY 513U
#define STACKCHAN_AVATAR_SLUG_CAPACITY 32U
#define STACKCHAN_MAXIMUM_PHOTO_BYTES (512U * 1024U)
#define STACKCHAN_PLAYBACK_INTERRUPTION_ACK_TIMEOUT_MS 50U

/*
 * One callback consumes push+pull and may return resolve+release. Eight slots
 * per direction cover two admitted callbacks plus one bounded owner pass. A
 * larger ring would retain delayed control history; a smaller ring already
 * failed the corresponding measured Stick burst.
 */
#define STACKCHAN_CONTROL_INBOX_SLOTS 8U
#define STACKCHAN_CONTROL_OUTBOX_SLOTS 8U
#define STACKCHAN_CONTROL_SLOT_CAPACITY \
  ITERATE_KIT_ESP_IDF_CONTROL_MESSAGE_CAPACITY
#define STACKCHAN_CONTROL_MESSAGES_PER_POLL 4U

#define STACKCHAN_PCM_FRAME_DURATION_MS             \
  ((1000U * ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME) / \
   ITERATE_KIT_PCM_V1_SAMPLE_RATE_HZ)
/*
 * 640 ms is measured loss reserve for scheduler/TLS bursts, not target
 * latency. Freshness and generation barriers ensure neither direction drains
 * those 32 slots after an outage. The capacity is deliberately the same as
 * the proven Stick profile so device comparison changes hardware, not policy.
 */
#define STACKCHAN_PCM_RESERVE_MS 640U
#define STACKCHAN_PCM_RING_SLOTS \
  (STACKCHAN_PCM_RESERVE_MS / STACKCHAN_PCM_FRAME_DURATION_MS)
#define STACKCHAN_MAIN_LOOP_DELAY_MS 10U
#define STACKCHAN_UI_NETWORK_SAMPLE_MS 1000U
#define STACKCHAN_BODY_STATUS_REFRESH_MS 1000U
/*
 * The selected profile is shared by the DSP owner and its diagnostic trace.
 * Keeping it here prevents a target-local 256/512 cadence split from turning a
 * DSP A/B into a boot failure. The trace capacity is a duration budget (1.024
 * seconds at 16 kHz), intentionally independent of the engine frame size.
 */
#define STACKCHAN_AEC_PROFILE ITERATE_KIT_CORE_S3_AEC_VOIP_CONSTANT
#define STACKCHAN_AEC_TRACE_SAMPLES 16384U
#define STACKCHAN_AEC_TRACE_READ_SAMPLES \
  ITERATE_KIT_CORE_S3_AEC_MAX_FRAME_SAMPLES

static const char *const TAG = "iterate-stackchan";
static const char *const MOUNT_PATH[] = {"kit", "stackchan"};

_Static_assert(STACKCHAN_PCM_FRAME_DURATION_MS == 20U,
               "StackChan must use the exact PCM-v1 frame duration");
_Static_assert(STACKCHAN_PCM_RESERVE_MS % STACKCHAN_PCM_FRAME_DURATION_MS == 0U,
               "PCM reserve must contain complete protocol frames");
_Static_assert((STACKCHAN_PCM_RING_SLOTS & (STACKCHAN_PCM_RING_SLOTS - 1U)) ==
                   0U,
               "SPSC PCM slot count must be a power of two");
_Static_assert(
    STACKCHAN_PCM_RESERVE_MS == ITERATE_KIT_ESP_IDF_PCM_CAPTURE_MAX_AGE_MS,
    "ring reserve and uplink freshness policy are one latency budget");
_Static_assert((STACKCHAN_CONTROL_INBOX_SLOTS &
                (STACKCHAN_CONTROL_INBOX_SLOTS - 1U)) == 0U &&
                   (STACKCHAN_CONTROL_OUTBOX_SLOTS &
                    (STACKCHAN_CONTROL_OUTBOX_SLOTS - 1U)) == 0U,
               "SPSC control slot counts must be powers of two");

/*
 * Cap'n Web envelopes are neither DMA buffers nor part of the audio deadline.
 * Keeping sixteen 8 KiB payload slots inside `stackchan_runtime` consumed
 * 128 KiB of scarce internal SRAM and left the target unable to link once the
 * full-duplex AEC path was enabled.  Put only those cold payload bytes in
 * linker-reserved PSRAM, as the already-proven Stick target does.  Ring
 * indices and lengths stay internal, and every PCM/AEC/DMA buffer stays
 * internal or in its platform owner's explicitly reviewed allocation class.
 *
 * Static PSRAM is deliberate here: a missing PSRAM configuration becomes a
 * deterministic boot/link failure instead of a late heap allocation failure
 * while a call is active.  The 8 KiB wire limit is unchanged, so this is not a
 * hidden reduction in capability message size.
 */
EXT_RAM_BSS_ATTR static uint8_t
    control_inbox_storage[STACKCHAN_CONTROL_INBOX_SLOTS]
                         [STACKCHAN_CONTROL_SLOT_CAPACITY];
EXT_RAM_BSS_ATTR static uint8_t
    control_outbox_storage[STACKCHAN_CONTROL_OUTBOX_SLOTS]
                          [STACKCHAN_CONTROL_SLOT_CAPACITY];
/*
 * 1.024 seconds is long enough for lag/ERLE windows and contains exactly 64
 * VOIP frames. Three truthful planes cost 98,304 bytes. CoreS3
 * exposes the electrical divider, but not completed-DMA or a separate linear
 * tap; allocating those as zeros would manufacture evidence.
 */
EXT_RAM_BSS_ATTR static int16_t
    aec_trace_near[STACKCHAN_AEC_TRACE_SAMPLES];
EXT_RAM_BSS_ATTR static int16_t
    aec_trace_reference[STACKCHAN_AEC_TRACE_SAMPLES];
EXT_RAM_BSS_ATTR static int16_t
    aec_trace_clean[STACKCHAN_AEC_TRACE_SAMPLES];
EXT_RAM_BSS_ATTR static int16_t
    aec_trace_read_scratch[STACKCHAN_AEC_TRACE_READ_SAMPLES * 5U];

struct stackchan_runtime {
  struct iterate_kit_configuration configuration;
  struct iterate_kit_itx_connection connection;
  struct capnweb_pending_call pending_calls[STACKCHAN_PENDING_CALL_CAPACITY];
  struct capnweb_export exports[STACKCHAN_EXPORT_CAPACITY];
  struct capnweb_import imports[STACKCHAN_IMPORT_CAPACITY];
  struct capnweb_json_token tokens[STACKCHAN_TOKEN_CAPACITY];
  char output_buffer[STACKCHAN_OUTPUT_CAPACITY];
  char screen_url_scratch[STACKCHAN_SCREEN_URL_CAPACITY];
  char avatar_slug_scratch[STACKCHAN_AVATAR_SLUG_CAPACITY];
  char diagnostics_expression
      [ITERATE_KIT_METRICS_DIAGNOSTICS_EXPRESSION_CAPACITY];
  struct iterate_kit_metrics_subscription
      subscriptions[STACKCHAN_METRICS_SUBSCRIPTION_CAPACITY];

  struct iterate_kit_spsc_ring control_inbox;
  struct iterate_kit_spsc_ring control_outbox;
  size_t control_inbox_lengths[STACKCHAN_CONTROL_INBOX_SLOTS];
  size_t control_outbox_lengths[STACKCHAN_CONTROL_OUTBOX_SLOTS];

  struct iterate_kit_spsc_ring pcm_uplink;
  struct iterate_kit_spsc_ring pcm_downlink;
  struct iterate_kit_pcm_uplink_slot
      pcm_uplink_storage[STACKCHAN_PCM_RING_SLOTS];
  struct iterate_kit_pcm_downlink_slot
      pcm_downlink_storage[STACKCHAN_PCM_RING_SLOTS];
  size_t pcm_uplink_lengths[STACKCHAN_PCM_RING_SLOTS];
  size_t pcm_downlink_lengths[STACKCHAN_PCM_RING_SLOTS];
  struct iterate_kit_pcm_lane pcm_lane;

  struct iterate_kit_esp_idf_itx_transport control_transport;
  struct iterate_kit_esp_idf_pcm_transport pcm_transport;
  struct iterate_kit_esp_idf_pcm_session pcm_session;
  struct iterate_kit_stackchan_body body;
  struct iterate_kit_stackchan_hardware hardware;
  struct iterate_kit_stackchan device;
  struct iterate_kit_aec_diagnostic_trace aec_trace;
  struct iterate_kit_aec_diagnostic_trace_capability aec_trace_capability;
  struct iterate_kit_audio_intent_reconciler audio_intent;
  struct iterate_kit_control_recovery control_recovery;
  struct iterate_kit_cpu_usage_meter cpu_usage;

  int64_t booted_at_us;
  enum iterate_kit_esp_idf_itx_transport_state last_control_state;
  enum iterate_kit_status last_audio_intent_status;
  uint64_t next_ui_network_sample_ms;
  uint64_t next_body_status_refresh_ms;
  struct iterate_kit_conversation_visual_state last_ui_status;
  int32_t ui_wifi_rssi_dbm;
  bool ui_wifi_observed;
  bool ui_status_valid;
  bool ui_status_failure_latched;
  bool body_status_failure_latched;
  uint32_t control_idle_remounts;
};

static struct stackchan_runtime runtime;

static uint32_t saturating_add_u32(uint32_t left, uint64_t right) {
  const uint64_t sum = (uint64_t)left + right;
  return sum > UINT32_MAX ? UINT32_MAX : (uint32_t)sum;
}

static uint32_t minimum_nonzero(uint32_t current, uint32_t candidate) {
  if (candidate == 0U) return current;
  if (current == 0U || candidate < current) return candidate;
  return current;
}

/*
 * FreeRTOS exposes one idle counter per core. Summing them is meaningful only
 * because the portable CPU meter is initialized with the same core count. It
 * is a low-intrusion scheduler utilization signal, not task-level attribution
 * and not proof that an individual 8 ms audio deadline was met.
 */
static uint64_t aggregate_idle_time(void) {
  uint64_t total = 0U;
  BaseType_t core;
  for (core = 0; core < CONFIG_FREERTOS_NUMBER_OF_CORES; ++core) {
    total += ulTaskGetIdleRunTimeCounterForCore(core);
  }
  return total;
}

static enum iterate_kit_status sample_runtime_metrics(
    void *context, struct iterate_kit_metrics_sample *sample) {
  struct stackchan_runtime *state = context;
  struct iterate_kit_esp_idf_itx_transport_metrics control;
  struct iterate_kit_esp_idf_pcm_transport_metrics pcm;
  struct iterate_kit_core_s3_audio_owner_metrics owner;
  struct iterate_kit_core_s3_aec_signal_metrics aec_signal;
  struct iterate_kit_stackchan_avatar_metrics avatar;
  const int64_t now_us = esp_timer_get_time();
  int64_t cpu_permille = -1;
  uint32_t stack_headroom;
  wifi_ap_record_t access_point;
  enum iterate_kit_status cpu_status;

  if (state == NULL || sample == NULL || now_us < state->booted_at_us) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  cpu_status = iterate_kit_cpu_usage_meter_sample(&state->cpu_usage,
                                                  (uint64_t)now_us,
                                                  aggregate_idle_time(),
                                                  &cpu_permille);
  if (cpu_status != ITERATE_KIT_OK) {
    /*
     * A clock/counter discontinuity makes the whole interval ambiguous. Do
     * not publish a half-valid point that a graph could mistake for low load.
     */
    return cpu_status;
  }

  memset(sample, 0, sizeof(*sample));
  memset(&control, 0, sizeof(control));
  memset(&pcm, 0, sizeof(pcm));
  memset(&owner, 0, sizeof(owner));
  memset(&aec_signal, 0, sizeof(aec_signal));
  memset(&avatar, 0, sizeof(avatar));
  memset(&access_point, 0, sizeof(access_point));
  iterate_kit_esp_idf_itx_transport_metrics(&state->control_transport,
                                            &control);
  iterate_kit_esp_idf_pcm_transport_metrics(&state->pcm_transport, &pcm);
  iterate_kit_core_s3_audio_owner_metrics_snapshot(&owner);
  iterate_kit_stackchan_avatar_metrics_snapshot(&avatar);
  if (iterate_kit_core_s3_audio_owner_aec_signal_metrics_snapshot(
          &aec_signal) != ITERATE_KIT_OK) {
    /*
     * A malformed signal snapshot invalidates AEC attribution, but general
     * metrics must not quietly publish around it. Returning a driver error
     * keeps the failed interval visible and prevents a zero-filled clean
     * channel from being mistaken for successful echo cancellation.
     */
    return ITERATE_KIT_STATE_ERROR;
  }

  sample->uptime_ms = (now_us - state->booted_at_us) / 1000;
  sample->free_heap_bytes = esp_get_free_heap_size();
  sample->minimum_free_heap_bytes = esp_get_minimum_free_heap_size();
  sample->free_internal_heap_bytes = esp_get_free_internal_heap_size();
  sample->minimum_free_internal_heap_bytes = heap_caps_get_minimum_free_size(
      MALLOC_CAP_8BIT | MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
  sample->free_psram_bytes = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
  sample->cpu_permille = cpu_permille;
  stack_headroom =
      (uint32_t)(uxTaskGetStackHighWaterMark(NULL) * sizeof(StackType_t));
  stack_headroom = minimum_nonzero(stack_headroom,
                                   control.network_task_stack_high_water_bytes);
  stack_headroom =
      minimum_nonzero(stack_headroom, pcm.network_task_stack_high_water_bytes);
  stack_headroom =
      minimum_nonzero(stack_headroom, owner.io_stack_minimum_free_bytes);
  stack_headroom =
      minimum_nonzero(stack_headroom, owner.aec_stack_minimum_free_bytes);
  stack_headroom =
      minimum_nonzero(stack_headroom, avatar.analyzer_stack_minimum_free_bytes);
  stack_headroom =
      minimum_nonzero(stack_headroom, avatar.input_stack_minimum_free_bytes);
  sample->task_stack_high_water_bytes = stack_headroom;
  sample->subscription_callback_rejections =
      iterate_kit_peer_subscription_callback_rejections(&state->device.peer);

  sample->has_audio = true;
  sample->audio.capture.sent = owner.clean_uplink_frames;
  sample->audio.capture.dropped = owner.clean_uplink_drops;
  sample->audio.capture.failures = owner.capture_failures;
  sample->audio.uplink.sent = pcm.uplink_frames_sent;
  sample->audio.uplink.dropped = saturating_add_u32(
      pcm.uplink_frames_discarded, pcm.lane.uplink.producer_backpressure);
  sample->audio.uplink.depth = pcm.lane.uplink.current_slots;
  sample->audio.uplink.high_water = pcm.lane.uplink.high_water_slots;
  sample->audio.uplink.failures = pcm.uplink_send_failures;
  sample->audio.uplink.send_deferrals = pcm.uplink_send_deferrals;
  sample->audio.uplink.consecutive_send_deferrals =
      pcm.uplink_consecutive_send_deferrals;
  sample->audio.uplink.maximum_consecutive_send_deferrals =
      pcm.uplink_maximum_consecutive_send_deferrals;
  sample->audio.uplink.restart_incidents = pcm.uplink_restart_incidents;
  sample->audio.uplink.in_place_freshness_recoveries =
      pcm.uplink_in_place_freshness_recoveries;
  sample->audio.uplink.socket_restarts = pcm.uplink_socket_restarts;
  sample->audio.uplink.producer_backpressure_restarts =
      pcm.uplink_producer_backpressure_restarts;
  sample->audio.uplink.transport_disconnect_restarts =
      pcm.uplink_transport_disconnect_restarts;
  sample->audio.uplink.no_progress_timeout_restarts =
      pcm.uplink_no_progress_timeout_restarts;
  sample->audio.uplink.frame_send_timeout_restarts =
      pcm.uplink_frame_send_timeout_restarts;
  sample->audio.uplink.capture_stale_restarts =
      pcm.uplink_capture_stale_restarts;
  sample->audio.uplink.last_transport_accept_age_ms =
      pcm.uplink_last_transport_accept_age_ms;
  sample->audio.uplink.maximum_transport_accept_age_ms =
      pcm.uplink_maximum_transport_accept_age_ms;
  sample->audio.uplink.last_restart_oldest_capture_age_ms =
      pcm.uplink_last_restart_oldest_capture_age_ms;
  sample->audio.uplink.last_restart_reason =
      iterate_kit_pcm_uplink_restart_reason_name(
          pcm.uplink_last_restart_reason);
  sample->audio.uplink.last_restart_frames_discarded =
      pcm.uplink_last_restart_frames_discarded;
  sample->audio.downlink.received = pcm.lane.downlink_frames_accepted;
  sample->audio.downlink.dropped = pcm.lane.downlink.producer_backpressure;
  sample->audio.downlink.depth = pcm.lane.downlink.current_slots;
  sample->audio.downlink.high_water = pcm.lane.downlink.high_water_slots;
  sample->audio.downlink.failures = pcm.downlink_receive_failures;
  /*
   * CoreS3 hands fixed 8 ms codec chunks to a synchronous driver, so a 20 ms
   * wire frame can straddle two writes. No current TX-EOF observation retains
   * its content/generation identity. Omit the entire physical playback group
   * rather than dividing sample counts and fabricating conservation.
   */
  sample->audio.has_playback = false;
  sample->audio.protocol_failures = pcm.protocol_failures;
  sample->audio.buffers.uplink_application = pcm.buffers.uplink_application;
  sample->audio.buffers.websocket_transmitter =
      pcm.buffers.websocket_transmitter;
  sample->audio.buffers.lwip_send = pcm.buffers.lwip_send;
  sample->audio.buffers.tls_egress = pcm.buffers.tls_egress;
  sample->audio.buffers.wifi_egress = pcm.buffers.wifi_egress;
  sample->audio.has_buffers = true;
  /*
   * The Stick's detailed schema describes its direct DMA descriptor owner.
   * CoreS3 has a different synchronous-codec clock and AEC topology; claiming
   * that schema with zero-filled fields would be worse than honest absence.
   */
  sample->has_playback_detail = false;

  sample->has_aec_detail = true;
  sample->aec_detail.schema_version = 11U;
  sample->aec_detail.sequence = aec_signal.sequence;
  sample->aec_detail.window_started_at_ms =
      aec_signal.window_started_at_us >= (uint64_t)state->booted_at_us
          ? (int64_t)((aec_signal.window_started_at_us -
                       (uint64_t)state->booted_at_us) /
                      1000U)
          : 0;
  sample->aec_detail.produced_at_ms =
      aec_signal.produced_at_us >= (uint64_t)state->booted_at_us
          ? (int64_t)((aec_signal.produced_at_us -
                       (uint64_t)state->booted_at_us) /
                      1000U)
          : sample->uptime_ms;
  sample->aec_detail.sample_stride = aec_signal.signal.sample_stride;
  sample->aec_detail.sampled_samples = aec_signal.signal.sampled_samples;
  sample->aec_detail.near_peak = aec_signal.signal.near_peak;
  sample->aec_detail.reference_peak = aec_signal.signal.reference_peak;
  sample->aec_detail.clean_peak = aec_signal.signal.clean_peak;
  sample->aec_detail.near_mean_absolute = aec_signal.signal.near_mean_absolute;
  sample->aec_detail.reference_mean_absolute =
      aec_signal.signal.reference_mean_absolute;
  sample->aec_detail.clean_mean_absolute =
      aec_signal.signal.clean_mean_absolute;
  sample->aec_detail.engine_profile = (uint32_t)owner.aec_profile;
  sample->aec_detail.processing_frame_samples = owner.aec_frame_samples;
  sample->aec_detail.near_window_gain_multiplier =
      owner.near_window_gain_multiplier;
  sample->aec_detail.far_window_gain_multiplier =
      owner.far_window_gain_multiplier;
  sample->aec_detail.speaker_volume_percent =
      (uint32_t)owner.speaker_volume_percent;
  sample->aec_detail.microphone_gain_db = (uint32_t)owner.microphone_gain_db;
  sample->aec_detail.reference_gain_db = (uint32_t)owner.reference_gain_db;
  sample->aec_detail.lifetime_frames_processed = owner.aec_frames;
  sample->aec_detail.lifetime_recreates = owner.aec_recreates;
  sample->aec_detail.lifetime_recreate_failures = owner.aec_recreate_failures;
  sample->aec_detail.last_process_us = owner.last_aec_process_us;
  sample->aec_detail.maximum_process_us = owner.maximum_aec_process_us;
  sample->aec_detail.last_capture_to_uplink_us =
      owner.last_capture_to_uplink_us;
  sample->aec_detail.maximum_capture_to_uplink_us =
      owner.maximum_capture_to_uplink_us;
  sample->aec_detail.lifetime_capture_reserve_dropped_chunks =
      owner.capture_reserve.chunks_discarded;
  sample->aec_detail.lifetime_capture_chunks_with_playback_content =
      owner.capture_chunks_with_playback_content;
  sample->aec_detail.lifetime_capture_chunks_without_playback_content =
      owner.capture_chunks_without_playback_content;
  sample->aec_detail.lifetime_capture_bridge_errors =
      owner.capture_bridge_errors;
  sample->aec_detail.lifetime_signal_measurement_failures =
      owner.aec_signal_measurement_failures;
  sample->aec_detail.lifetime_reference_scale_clipped_samples =
      owner.reference_scale_clipped_samples;
  sample->aec_detail.lifetime_near_high_pass_clipped_samples =
      owner.near_high_pass_clipped_samples;
  sample->aec_detail.lifetime_uplink_gain_clipped_samples =
      owner.uplink_gain_clipped_samples;
  /*
   * CoreS3's synchronous codec consumes 8 ms chunks, so inventing one
   * completion per 20 ms wire frame would make conservation look more exact
   * than the hardware can prove. These lifetime counters are the truthful
   * alternative: the AEC harness can reject every reset, failed write, TX
   * queue overflow, malformed playout observation, or policy fault while
   * retaining measured receive-to-codec timing. Reset failure is structurally
   * zero because this owner's reset is an in-memory clock operation with no
   * fallible peripheral call.
   */
  sample->aec_detail.playback_health.lifetime_content_samples =
      owner.playback_content_samples;
  sample->aec_detail.playback_health.lifetime_resets = owner.playback_resets;
  sample->aec_detail.playback_health.lifetime_frames_discarded_by_reset =
      owner.downlink_frames_discarded_by_reset;
  sample->aec_detail.playback_health.lifetime_write_failures =
      owner.codec_write_errors;
  sample->aec_detail.playback_health.lifetime_queue_overflows =
      owner.i2s.tx_queue_overflows;
  sample->aec_detail.playback_health.lifetime_policy_errors =
      owner.playback_policy_errors;
  sample->aec_detail.playback_health.lifetime_reset_failures = 0U;
  sample->aec_detail.playback_health.lifetime_observation_failures =
      owner.playout_observer_shape_errors;
  sample->aec_detail.playback_health.lifetime_underrun_incidents =
      owner.playback_underrun_incidents;
  sample->aec_detail.playback_health.lifetime_underrun_silence_samples =
      owner.playback_underrun_silence_samples;
  sample->aec_detail.playback_health.lifetime_stale_frames_discarded =
      owner.playback_stale_frames_discarded;
  sample->aec_detail.playback_health.last_write_us = owner.last_codec_write_us;
  sample->aec_detail.playback_health.maximum_write_us =
      owner.maximum_codec_write_us;
  sample->aec_detail.playback_health.last_receive_to_render_ms =
      owner.last_receive_to_render_ms;
  sample->aec_detail.playback_health.maximum_receive_to_render_ms =
      owner.maximum_receive_to_render_ms;

  /*
   * The visual sidecar gets a dedicated Cap'n Web serialization view because
   * general metrics is already at its fixed 2 KiB wire budget. Snapshotting
   * the same owner here adds no task, history, or frame-path work; it lets the
   * production harness distinguish live mouth/display progress from pixels
   * merely retained in the LCD controller across an application reset.
   */
  sample->has_avatar_detail = true;
  sample->avatar_detail.schema_version = 1U;
  sample->avatar_detail.produced_at_ms = sample->uptime_ms;
  sample->avatar_detail.ready = avatar.ready;
  sample->avatar_detail.playout_observations = avatar.playout_observations;
  sample->avatar_detail.malformed_observations = avatar.malformed_observations;
  sample->avatar_detail.mailbox_overwrites = avatar.mailbox_overwrites;
  sample->avatar_detail.mailbox_failures = avatar.mailbox_failures;
  sample->avatar_detail.analyzer_frames = avatar.analyzer_frames;
  sample->avatar_detail.analyzer_sequence_gaps = avatar.analyzer_sequence_gaps;
  sample->avatar_detail.mouth_open_rendered_frames =
      avatar.mouth_open_rendered_frames;
  sample->avatar_detail.snapshot_races = avatar.snapshot_races;
  sample->avatar_detail.rendered_frames = avatar.rendered_frames;
  sample->avatar_detail.render_failures = avatar.render_failures;
  sample->avatar_detail.display_transfers = avatar.display_transfers;
  sample->avatar_detail.display_transfer_failures =
      avatar.display_transfer_failures;
  sample->avatar_detail.display_transfer_timeouts =
      avatar.display_transfer_timeouts;
  sample->avatar_detail.maximum_handoff_delay_us =
      avatar.maximum_handoff_delay_us;
  sample->avatar_detail.maximum_analyzer_us = avatar.maximum_analyzer_us;
  sample->avatar_detail.maximum_render_us = avatar.maximum_render_us;
  sample->avatar_detail.maximum_display_transfer_us =
      avatar.maximum_display_transfer_us;
  sample->avatar_detail.analyzer_stack_minimum_free_bytes =
      avatar.analyzer_stack_minimum_free_bytes;
  sample->avatar_detail.physical_playout_sample_clock =
      avatar.physical_playout_sample_clock;
  sample->avatar_detail.current_avatar_index = avatar.current_avatar_index;
  sample->avatar_detail.framebuffer_bytes = avatar.framebuffer_bytes;

  sample->has_control_diagnostics = true;
  sample->control_diagnostics.schema_version = 4U;
  sample->control_diagnostics.produced_at_ms = sample->uptime_ms;
  sample->control_diagnostics.websocket_start_attempts =
      control.websocket_start_attempts;
  sample->control_diagnostics.websocket_connections =
      control.websocket_connections;
  sample->control_diagnostics.websocket_disconnects =
      control.websocket_disconnects;
  sample->control_diagnostics.websocket_errors = control.websocket_errors;
  sample->control_diagnostics.wifi_disconnects = control.wifi_disconnects;
  sample->control_diagnostics.protocol_failures = control.protocol_failures;
  sample->control_diagnostics.control_receive_failures =
      control.control_receive_failures;
  /*
   * Audio-intent failures are logged at their own state-machine boundary.
   * Folding them into WebSocket send failures would falsify network
   * attribution precisely when an audio-control bug occurs.
   */
  sample->control_diagnostics.control_send_failures =
      control.control_send_failures;
  sample->control_diagnostics.last_wifi_disconnect_reason =
      control.last_wifi_disconnect_reason;
  sample->control_diagnostics.last_websocket_error_generation =
      control.last_websocket_error_generation;
  sample->control_diagnostics.last_websocket_error_type =
      control.last_websocket_error_type;
  sample->control_diagnostics.last_websocket_tls_error =
      control.last_websocket_tls_error;
  sample->control_diagnostics.last_websocket_tls_stack_error =
      control.last_websocket_tls_stack_error;
  sample->control_diagnostics.last_websocket_transport_errno =
      control.last_websocket_transport_errno;
  sample->control_diagnostics.last_websocket_handshake_status_code =
      control.last_websocket_handshake_status_code;
  sample->control_diagnostics.last_websocket_close_status_code =
      control.last_websocket_close_status_code;
  sample->control_diagnostics.protocol_failure_generation =
      control.protocol_failure_generation;
  sample->control_diagnostics.last_application_capnweb_generation =
      control.last_application_capnweb_generation;
  sample->control_diagnostics.last_application_capnweb_status =
      control.last_application_capnweb_status;
  sample->control_diagnostics.last_control_receive_status =
      control.last_control_receive_status;
  sample->control_diagnostics.control_messages_sent =
      control.control_messages_sent;
  sample->control_diagnostics.control_messages_discarded =
      control.control_messages_discarded;
  sample->control_diagnostics.control_inbox_discarded =
      control.control_inbox_discarded;
  sample->control_diagnostics.control_outbox_discarded =
      control.control_outbox_discarded;
  sample->control_diagnostics.control_inbox.capacity_slots =
      control.control_inbox_capacity_slots;
  sample->control_diagnostics.control_inbox.messages_published =
      control.control_inbox.messages_published;
  sample->control_diagnostics.control_inbox.messages_consumed =
      control.control_inbox.messages_consumed;
  sample->control_diagnostics.control_inbox.producer_backpressure =
      control.control_inbox.producer_backpressure;
  sample->control_diagnostics.control_inbox.high_water_slots =
      control.control_inbox.high_water_slots;
  sample->control_diagnostics.control_inbox.current_slots =
      control.control_inbox.current_slots;
  sample->control_diagnostics.control_outbox.capacity_slots =
      control.control_outbox_capacity_slots;
  sample->control_diagnostics.control_outbox.messages_published =
      control.control_outbox.messages_published;
  sample->control_diagnostics.control_outbox.messages_consumed =
      control.control_outbox.messages_consumed;
  sample->control_diagnostics.control_outbox.producer_backpressure =
      control.control_outbox.producer_backpressure;
  sample->control_diagnostics.control_outbox.high_water_slots =
      control.control_outbox.high_water_slots;
  sample->control_diagnostics.control_outbox.current_slots =
      control.control_outbox.current_slots;
  sample->control_diagnostics.network.wifi_connected = control.wifi_connected;
  sample->control_diagnostics.network.pcm_websocket_connections =
      pcm.websocket_connections;
  sample->control_diagnostics.network.pcm_websocket_disconnects =
      pcm.websocket_disconnects;
  sample->control_diagnostics.network.pcm_websocket_errors =
      pcm.websocket_errors;
  sample->control_diagnostics.network.pcm_websocket_raw_write_failures =
      pcm.websocket_raw_write_failures;
  sample->control_diagnostics.network.pcm_transport_failure_incidents =
      pcm.websocket_transport_failure_incidents;
  sample->control_diagnostics.network.pcm_last_failure_operation =
      (uint32_t)pcm.websocket_last_failure_operation;
  sample->control_diagnostics.network.pcm_last_raw_result =
      pcm.websocket_last_raw_result;
  sample->control_diagnostics.network.pcm_last_socket_errno =
      pcm.websocket_last_socket_errno;
  sample->control_diagnostics.network.pcm_last_esp_tls_error =
      pcm.websocket_last_esp_tls_error;
  sample->control_diagnostics.network.pcm_last_tls_stack_error =
      pcm.websocket_last_tls_stack_error;
  sample->control_diagnostics.network.pcm_last_tls_cert_flags =
      pcm.websocket_last_tls_cert_flags;
  if (esp_wifi_sta_get_ap_info(&access_point) == ESP_OK) {
    sample->control_diagnostics.network.has_wifi_rssi_dbm = true;
    sample->control_diagnostics.network.wifi_rssi_dbm = access_point.rssi;
  }
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status request_uplink_active(void *context,
                                                     bool active) {
  (void)context;
  return iterate_kit_core_s3_audio_owner_request_uplink_active(active);
}

static void request_playback_reset(void *context) {
  (void)context;
  iterate_kit_core_s3_audio_owner_request_playback_reset();
}

static bool pcm_conversation_active(void *context) {
  const struct stackchan_runtime *state = context;
  return state != NULL &&
      iterate_kit_stackchan_is_conversation_active(&state->device);
}

static enum iterate_kit_status set_pcm_media_ready(
    void *context, bool ready) {
  struct stackchan_runtime *state = context;
  if (state == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  /*
   * The shared session owns the authorization decision. This adapter merely
   * hands that one boolean to the existing high-priority audio intent owner;
   * it performs no codec work and cannot invent a target-local gate.
   */
  return iterate_kit_audio_intent_reconciler_set_media_ready(
      &state->audio_intent, ready);
}

static void notify_uplink(void *context) {
  struct stackchan_runtime *state = context;
  if (state != NULL) {
    iterate_kit_esp_idf_pcm_transport_notify_uplink(&state->pcm_transport);
  }
}

static void observe_device_event(void *context,
                                 const struct iterate_kit_device_event *event,
                                 enum iterate_kit_status result) {
  (void)context;
  if (event == NULL) return;
  /*
   * This is a transition log, not a frame log. The profile also delivers the
   * same bounded event over its capability subscription; serial remains a
   * fallback for boot attribution without stealing cycles from PCM owners.
   */
  ESP_LOGI(TAG,
           "device_event type=%u source=%u result=%d",
           (unsigned)event->type,
           (unsigned)event->source,
           (int)result);
}

static void device_session_ended(void *context) {
  struct stackchan_runtime *state = context;
  if (state != NULL) {
    iterate_kit_peer_session_ended(&state->device.peer);
  }
}

static enum iterate_kit_status change_avatar_sprite_set(void *context,
                                                        const char *slug,
                                                        size_t slug_length) {
  (void)context;
  const esp_err_t status =
      iterate_kit_stackchan_avatar_request_sprite_set(slug, slug_length);
  if (status == ESP_OK) {
    return ITERATE_KIT_OK;
  }
  if (status == ESP_ERR_INVALID_ARG || status == ESP_ERR_INVALID_SIZE) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (status == ESP_ERR_INVALID_STATE) {
    return ITERATE_KIT_STATE_ERROR;
  }
  return ITERATE_KIT_IO_ERROR;
}

static bool initialise_rings(struct stackchan_runtime *state) {
  return iterate_kit_spsc_ring_init(&state->control_inbox,
                                    control_inbox_storage,
                                    STACKCHAN_CONTROL_SLOT_CAPACITY,
                                    STACKCHAN_CONTROL_INBOX_SLOTS,
                                    state->control_inbox_lengths) ==
             ITERATE_KIT_OK &&
         iterate_kit_spsc_ring_init(&state->control_outbox,
                                    control_outbox_storage,
                                    STACKCHAN_CONTROL_SLOT_CAPACITY,
                                    STACKCHAN_CONTROL_OUTBOX_SLOTS,
                                    state->control_outbox_lengths) ==
             ITERATE_KIT_OK &&
         iterate_kit_spsc_ring_init(&state->pcm_uplink,
                                    state->pcm_uplink_storage,
                                    sizeof(state->pcm_uplink_storage[0]),
                                    STACKCHAN_PCM_RING_SLOTS,
                                    state->pcm_uplink_lengths) ==
             ITERATE_KIT_OK &&
         iterate_kit_spsc_ring_init(&state->pcm_downlink,
                                    state->pcm_downlink_storage,
                                    sizeof(state->pcm_downlink_storage[0]),
                                    STACKCHAN_PCM_RING_SLOTS,
                                    state->pcm_downlink_lengths) ==
             ITERATE_KIT_OK &&
         iterate_kit_pcm_lane_init(&state->pcm_lane,
                                   &state->pcm_uplink,
                                   &state->pcm_downlink) == ITERATE_KIT_OK;
}

static bool initialise_device(struct stackchan_runtime *state) {
  const struct iterate_kit_stackchan_hardware_ops hardware_ops =
      iterate_kit_stackchan_body_hardware_ops(&state->body);
  struct iterate_kit_stackchan_options device_options;
  struct iterate_kit_audio_intent_ops audio_ops;
  struct iterate_kit_stackchan_control_driver control_driver;
  const struct iterate_kit_aec_diagnostic_trace_options trace_options = {
      .sample_rate_hz = ITERATE_KIT_CORE_S3_AUDIO_SAMPLE_RATE_HZ,
      .frame_samples = iterate_kit_core_s3_aec_processing_frame_samples(
          STACKCHAN_AEC_PROFILE),
      .capture_samples = STACKCHAN_AEC_TRACE_SAMPLES,
      .available_planes = ITERATE_KIT_AEC_DIAGNOSTIC_PLANE_NEAR |
          ITERATE_KIT_AEC_DIAGNOSTIC_PLANE_REFERENCE |
          ITERATE_KIT_AEC_DIAGNOSTIC_PLANE_CLEAN,
      .near_samples = aec_trace_near,
      .reference_samples = aec_trace_reference,
      .clean_samples = aec_trace_clean,
  };
  struct iterate_kit_aec_diagnostic_trace_capability_options
      trace_capability_options;

  /*
   * Every rich capability below terminates at one physical owner. In
   * particular, captureScreen snapshots the avatar owner's existing source
   * surface; it does not read the camera or create another display stack.
   * Generic modules still enforce the byte/range limits before Cap'n Web can
   * expose any driver result.
   */
  if (iterate_kit_stackchan_hardware_init(&state->hardware, &hardware_ops) !=
      ITERATE_KIT_OK) {
    return false;
  }
  if (iterate_kit_aec_diagnostic_trace_init(
          &state->aec_trace, &trace_options) != ITERATE_KIT_OK) {
    return false;
  }
  trace_capability_options =
      (struct iterate_kit_aec_diagnostic_trace_capability_options){
          .trace = &state->aec_trace,
          .read_scratch = aec_trace_read_scratch,
          .read_scratch_values =
              sizeof(aec_trace_read_scratch) /
              sizeof(aec_trace_read_scratch[0]),
          .maximum_read_samples = STACKCHAN_AEC_TRACE_READ_SAMPLES,
      };
  if (iterate_kit_aec_diagnostic_trace_capability_init(
          &state->aec_trace_capability,
          &trace_capability_options) != ITERATE_KIT_OK) {
    return false;
  }

  memset(&device_options, 0, sizeof(device_options));
  device_options.screen = iterate_kit_stackchan_screen_driver(&state->hardware);
  /*
   * Background-colour mutation was scaffolding for the first control proof.
   * The product surface now selects a complete sprite set. Keep PNG rendering
   * available, but do not advertise two overlapping ways to own the display.
   */
  device_options.screen.change_colour = NULL;
  device_options.screen_url_scratch = state->screen_url_scratch;
  device_options.screen_url_scratch_size = sizeof(state->screen_url_scratch);
  device_options.avatar = (struct iterate_kit_avatar_driver){
      .context = NULL,
      .change_sprite_set = change_avatar_sprite_set,
  };
  device_options.avatar_slug_scratch = state->avatar_slug_scratch;
  device_options.avatar_slug_scratch_size = sizeof(state->avatar_slug_scratch);
  device_options.screen_capture =
      iterate_kit_stackchan_avatar_screen_capture_driver();
  /*
   * One control slot is 8192 bytes and Cap'n Web base64-encodes byte arrays.
   * 5.6 KiB leaves more than 700 bytes for JSON/RPC framing without inflating
   * either permanent control ring for an occasional screenshot. If a future
   * arbitrary image does not compress to this bound, it needs a blob/stream
   * lane rather than a silent transport-size increase.
   */
  device_options.maximum_screen_capture_bytes =
      ITERATE_KIT_STACKCHAN_CAPTURE_PNG_CAPACITY;
  device_options.servos = iterate_kit_stackchan_servo_driver(&state->hardware);
  device_options.leds = iterate_kit_stackchan_led_driver(&state->hardware);
  device_options.camera = iterate_kit_stackchan_camera_driver(&state->hardware);
  device_options.maximum_photo_bytes = STACKCHAN_MAXIMUM_PHOTO_BYTES;
  device_options.playback_interruption =
      (struct iterate_kit_conversation_playback_interruption_driver){
          .context = NULL,
          .request =
              iterate_kit_core_s3_audio_owner_request_playback_interruption,
          .poll = iterate_kit_core_s3_audio_owner_poll_playback_interruption,
          .acknowledgement_timeout_ms =
              STACKCHAN_PLAYBACK_INTERRUPTION_ACK_TIMEOUT_MS,
      };
  device_options.metrics.session = &state->connection.session;
  device_options.metrics.driver.context = state;
  device_options.metrics.driver.sample = sample_runtime_metrics;
  device_options.metrics.subscriptions = state->subscriptions;
  device_options.metrics.subscription_count =
      STACKCHAN_METRICS_SUBSCRIPTION_CAPACITY;
  device_options.metrics.interval_ms = 1000U;
  /*
   * CoreS3 is the first target that can report aligned near/reference/clean
   * AEC windows. Mount that view explicitly; leaving this as a generic metrics
   * method would make no-AEC targets advertise evidence they cannot produce.
   */
  device_options.metrics.enable_aec_view = true;
  device_options.metrics.enable_avatar_view = true;
  device_options.metrics.diagnostics_expression_buffer =
      state->diagnostics_expression;
  device_options.metrics.diagnostics_expression_capacity =
      sizeof(state->diagnostics_expression);
  device_options.aec_trace = &state->aec_trace_capability;
  if (iterate_kit_stackchan_init(&state->device, &device_options) !=
      CAPNWEB_OK) {
    return false;
  }

  audio_ops = (struct iterate_kit_audio_intent_ops){
      .context = state,
      .request_uplink_active = request_uplink_active,
      .request_playback_reset = request_playback_reset,
  };
  if (iterate_kit_audio_intent_reconciler_init(
          &state->audio_intent,
          ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC,
          &audio_ops) != ITERATE_KIT_OK) {
    return false;
  }
  control_driver = (struct iterate_kit_stackchan_control_driver){
      .handler =
          {
              .context = &state->audio_intent,
              .handle = iterate_kit_audio_intent_reconciler_handle,
          },
      .observer =
          {
              .context = state,
              .observe = observe_device_event,
          },
  };
  return iterate_kit_stackchan_bind_control_driver(
             &state->device, &control_driver) == ITERATE_KIT_OK;
}

static bool initialise_connections(struct stackchan_runtime *state) {
  struct iterate_kit_esp_idf_itx_transport_options control_options;
  struct iterate_kit_esp_idf_pcm_transport_options pcm_options;
  struct iterate_kit_esp_idf_pcm_session_options pcm_session_options;
  struct iterate_kit_itx_connection_options connection_options;

  memset(&control_options, 0, sizeof(control_options));
  control_options.configuration = &state->configuration;
  control_options.connection = &state->connection;
  control_options.control_inbox = &state->control_inbox;
  control_options.control_outbox = &state->control_outbox;
  if (iterate_kit_esp_idf_itx_transport_prepare(
          &state->control_transport, &control_options) != ITERATE_KIT_OK) {
    return false;
  }

  memset(&pcm_options, 0, sizeof(pcm_options));
  pcm_options.configuration = &state->configuration;
  pcm_options.device_id = "stackchan";
  pcm_options.audio_mode = ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC;
  pcm_options.lane = &state->pcm_lane;
  pcm_options.downlink_generation_barrier =
      iterate_kit_core_s3_audio_owner_downlink_generation_barrier;
  /*
   * CoreS3 playback is already clocked every 8 ms. A downlink notification
   * cannot make the codec demand its next chunk sooner, so no fake wake path
   * is installed; the ring remains the sole source of queued work.
   */
  pcm_options.downlink_ready = NULL;
  if (iterate_kit_esp_idf_pcm_transport_prepare(
          &state->pcm_transport, &pcm_options) != ITERATE_KIT_OK) {
    return false;
  }
  memset(&pcm_session_options, 0, sizeof(pcm_session_options));
  pcm_session_options.control_transport = &state->control_transport;
  pcm_session_options.pcm_transport = &state->pcm_transport;
  pcm_session_options.hook_context = state;
  pcm_session_options.conversation_active = pcm_conversation_active;
  pcm_session_options.set_media_ready = set_pcm_media_ready;
  pcm_session_options.log_tag = TAG;
  if (iterate_kit_esp_idf_pcm_session_prepare(
          &state->pcm_session, &pcm_session_options) != ITERATE_KIT_OK) {
    return false;
  }

  memset(&connection_options, 0, sizeof(connection_options));
  connection_options.pending_calls = state->pending_calls;
  connection_options.pending_call_count = STACKCHAN_PENDING_CALL_CAPACITY;
  connection_options.exports = state->exports;
  connection_options.export_count = STACKCHAN_EXPORT_CAPACITY;
  connection_options.imports = state->imports;
  connection_options.import_count = STACKCHAN_IMPORT_CAPACITY;
  connection_options.tokens = state->tokens;
  connection_options.token_count = STACKCHAN_TOKEN_CAPACITY;
  connection_options.outbound_buffer = state->output_buffer;
  connection_options.outbound_buffer_size = sizeof(state->output_buffer);
  connection_options.send_text = iterate_kit_esp_idf_itx_transport_send_text;
  connection_options.send_text_context = &state->control_transport;
  connection_options.project_id = state->configuration.project_id;
  connection_options.project_api_key = state->configuration.project_api_key;
  connection_options.mount_path = MOUNT_PATH;
  connection_options.mount_path_count =
      sizeof(MOUNT_PATH) / sizeof(MOUNT_PATH[0]);
  connection_options.capability =
      iterate_kit_stackchan_capability(&state->device);
  connection_options.session_ended = device_session_ended;
  connection_options.session_ended_context = state;
  return iterate_kit_itx_connection_init(&state->connection,
                                         &connection_options) == CAPNWEB_OK;
}

static bool stackchan_status_view_equal(
    const struct iterate_kit_conversation_visual_state *left,
    const struct iterate_kit_conversation_visual_state *right) {
  /*
   * Pixel equality deliberately coalesces RSSI noise inside one three-bar
   * band.  The explicit lifecycle fields cover the rail's three-letter text,
   * which can change even when two states happen to produce equal dark/dim
   * pixels.  Precise RSSI and transport counters remain in diagnostics.
   */
  return iterate_kit_conversation_lights_equal(left, right) &&
         left->network == right->network &&
         left->conversation_active == right->conversation_active &&
         left->media_ready == right->media_ready &&
         left->media_failed == right->media_failed &&
         left->microphone_listening == right->microphone_listening;
}

static void update_stackchan_status(struct stackchan_runtime *state,
                                    uint64_t now_ms) {
  struct iterate_kit_conversation_visual_state status;

  if (state == NULL) return;
  if (now_ms >= state->next_ui_network_sample_ms) {
    wifi_ap_record_t access_point;
    const bool was_observed = state->ui_wifi_observed;
    memset(&access_point, 0, sizeof(access_point));
    state->ui_wifi_observed = esp_wifi_sta_get_ap_info(&access_point) == ESP_OK;
    if (state->ui_wifi_observed) {
      const int32_t measured = access_point.rssi;
      /*
       * A few dB of normal station noise must not repaint the LCD every
       * second.  Four dB is still small enough to cross a meaningful shared
       * status band promptly, while exact samples remain on the metrics view.
       */
      if (!was_observed || measured >= state->ui_wifi_rssi_dbm + 4 ||
          measured <= state->ui_wifi_rssi_dbm - 4) {
        state->ui_wifi_rssi_dbm = measured;
      }
    }
    state->next_ui_network_sample_ms = now_ms + STACKCHAN_UI_NETWORK_SAMPLE_MS;
  }

  memset(&status, 0, sizeof(status));
  if (!state->ui_wifi_observed) {
    status.network = ITERATE_KIT_NETWORK_DISCONNECTED;
  } else if (state->control_transport.state == ITERATE_KIT_ESP_IDF_ITX_READY) {
    status.network = ITERATE_KIT_NETWORK_CONNECTED;
  } else {
    status.network = ITERATE_KIT_NETWORK_CONNECTING;
  }
  status.has_wifi_rssi = state->ui_wifi_observed;
  status.wifi_rssi_dbm = state->ui_wifi_rssi_dbm;
  status.conversation_active =
      iterate_kit_stackchan_is_conversation_active(&state->device);
  status.media_ready = iterate_kit_esp_idf_pcm_session_media_ready(
      &state->pcm_session);
  status.media_failed = iterate_kit_esp_idf_pcm_session_failed(
      &state->pcm_session);
  status.microphone_listening = status.media_ready;
  /* StackChan currently publishes no allocation-free live near-end peak. */
  status.microphone_peak = 0U;
  status.speaker_peak =
      iterate_kit_stackchan_avatar_speaker_status_peak();
  status.restart_armed = false;

  const bool changed = !state->ui_status_valid ||
      !stackchan_status_view_equal(&status, &state->last_ui_status);
  if (changed) {
    const esp_err_t result =
        iterate_kit_stackchan_avatar_request_status(&status);
    state->last_ui_status = status;
    state->ui_status_valid = true;
    if (result != ESP_OK) {
      if (!state->ui_status_failure_latched) {
        ESP_LOGE(TAG, "status rail update failed: platform=%ld", (long)result);
        state->ui_status_failure_latched = true;
      }
    } else if (state->ui_status_failure_latched) {
      ESP_LOGI(TAG, "status rail update recovered");
      state->ui_status_failure_latched = false;
    }
  }

  if (changed || now_ms >= state->next_body_status_refresh_ms) {
    const enum iterate_kit_status result =
        iterate_kit_stackchan_hardware_show_status(&state->hardware, &status);
    /* A failed I2C bus must retry visibly but never at the 10 ms audio loop. */
    state->next_body_status_refresh_ms =
        now_ms + STACKCHAN_BODY_STATUS_REFRESH_MS;
    if (result != ITERATE_KIT_OK) {
      if (!state->body_status_failure_latched) {
        ESP_LOGE(TAG, "body status update failed: status=%d", (int)result);
        state->body_status_failure_latched = true;
      }
    } else if (state->body_status_failure_latched) {
      ESP_LOGI(TAG, "body status update recovered");
      state->body_status_failure_latched = false;
    }
  }
}

static void consume_physical_call_touch(struct stackchan_runtime *state) {
  if (state == NULL || !iterate_kit_stackchan_avatar_take_call_touch_tap()) {
    return;
  }
  const bool target_active =
      !iterate_kit_stackchan_is_conversation_active(&state->device);
  const enum iterate_kit_status status =
      iterate_kit_stackchan_publish_conversation(
          &state->device,
          target_active,
          ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL);
  if (status != ITERATE_KIT_OK) {
    ESP_LOGE(TAG,
             "whole-screen call toggle rejected: target=%s status=%d",
             target_active ? "active" : "idle",
             (int)status);
    return;
  }
  ESP_LOGI(TAG,
           "whole-screen call toggle published: target=%s",
           target_active ? "active" : "idle");
}

static void supervise_control_mount(struct stackchan_runtime *state,
                                    uint64_t now_ms) {
  struct iterate_kit_esp_idf_itx_transport_lifecycle lifecycle;
  enum iterate_kit_control_recovery_action action;
  const bool conversation_active =
      iterate_kit_stackchan_is_conversation_active(&state->device);

  /*
   * Socket keepalive and a live capability mount are different guarantees.
   * Production retained the awkward failure where this transport stayed
   * READY and answered pings after the capability host had forgotten its live
   * provider; every RPC then failed until a power cycle. The portable recovery
   * state machine watches actual inbound device dispatches and asks for one
   * bounded generation replacement after a long, genuinely idle interval.
   *
   * This supervision stays on the cooperative control owner. It performs no
   * socket I/O and cannot delay the higher-priority codec/AEC tasks. A live
   * conversation suppresses the idle remount because changing generation also
   * invalidates its session-scoped metrics/event callback exports.
   */
  iterate_kit_esp_idf_itx_transport_lifecycle(&state->control_transport,
                                              &lifecycle);
  action = iterate_kit_control_recovery_poll(
      &state->control_recovery,
      &(const struct iterate_kit_control_recovery_observation){
          .now_ms = now_ms,
          .fatal_restart_after_ms = ITERATE_KIT_VOICE_UNHEALTHY_RESTART_MS,
          .idle_remount_after_ms = ITERATE_KIT_VOICE_IDLE_REMOUNT_MS,
          .ready_generation = lifecycle.ready_socket_generation,
          .served_dispatches =
              iterate_kit_peer_served_dispatches(&state->device.peer),
          .fatal_latched = lifecycle.fatal_failure_latched,
          .control_ready =
              state->control_transport.state == ITERATE_KIT_ESP_IDF_ITX_READY,
          .conversation_active = conversation_active,
      });
  switch (action) {
    case ITERATE_KIT_CONTROL_RECOVERY_NONE:
      return;
    case ITERATE_KIT_CONTROL_RECOVERY_REMOUNT_CONTROL:
      if (state->control_idle_remounts < UINT32_MAX) {
        ++state->control_idle_remounts;
      }
      ESP_LOGW(TAG,
               "control capability idle lease expired: generation=%lu "
               "served=%lu remounts=%lu",
               (unsigned long)lifecycle.ready_socket_generation,
               (unsigned long)iterate_kit_peer_served_dispatches(
                   &state->device.peer),
               (unsigned long)state->control_idle_remounts);
      iterate_kit_esp_idf_itx_transport_request_restart(
          &state->control_transport);
      return;
    case ITERATE_KIT_CONTROL_RECOVERY_RESTART_PROCESS:
      ESP_LOGE(TAG,
               "control transport fatally latched for %us; restarting device",
               (unsigned int)(ITERATE_KIT_VOICE_UNHEALTHY_RESTART_MS / 1000U));
      esp_restart();
      return;
  }
}

void app_main(void) {
  struct iterate_kit_esp_configuration_result configuration_result;
  struct iterate_kit_core_s3_audio_owner_options audio_options;
  int64_t ignored_cpu = -1;

  configuration_result =
      iterate_kit_esp_read_configuration(&runtime.configuration);
  if (configuration_result.status != ITERATE_KIT_ESP_CONFIGURATION_OK) {
    ESP_LOGE(
        TAG,
        "device is not provisioned: storage=%s decode=%s platform=%ld",
        iterate_kit_esp_configuration_status_name(configuration_result.status),
        iterate_kit_configuration_error_name(
            configuration_result.configuration_error),
        (long)configuration_result.platform_error);
    return;
  }

  runtime.booted_at_us = esp_timer_get_time();
  iterate_kit_control_recovery_init(&runtime.control_recovery);
  if (runtime.booted_at_us < 0 ||
      iterate_kit_cpu_usage_meter_init(&runtime.cpu_usage,
                                       CONFIG_FREERTOS_NUMBER_OF_CORES) !=
          ITERATE_KIT_OK ||
      iterate_kit_cpu_usage_meter_sample(&runtime.cpu_usage,
                                         (uint64_t)runtime.booted_at_us,
                                         aggregate_idle_time(),
                                         &ignored_cpu) != ITERATE_KIT_OK ||
      !initialise_rings(&runtime)) {
    ESP_LOGE(TAG, "bounded target initialization failed");
    return;
  }

  memset(&audio_options, 0, sizeof(audio_options));
  if (iterate_kit_stackchan_avatar_start() != ESP_OK) {
    /*
     * The avatar is part of this target, not a best-effort decoration. A
     * silent fallback would let a display/LVGL regression ship behind a green
     * voice test. Fail before installing the audio ISR observer so the target
     * never calls into a partially initialized visual owner.
     */
    ESP_LOGE(TAG, "StackChan avatar owner failed to start");
    return;
  }
  /*
   * This order expresses an electrical dependency, not a UI dependency. The
   * official StackChan body is powered from CoreS3's M-BUS 5 V rail. Starting
   * the BSP display configures the AW9523 BOOST_EN and BUS_OUT_EN outputs that
   * energise that rail; probing the body's PY32 before then deterministically
   * times out even though the I2C pins and address are correct. Keep the body
   * as the sole PY32/UART owner, but only construct capability drivers after
   * the display owner has established board power.
   */
  if (iterate_kit_stackchan_body_start(&runtime.body) != ESP_OK ||
      !initialise_device(&runtime) ||
      !initialise_connections(&runtime)) {
    ESP_LOGE(TAG, "bounded target initialization failed");
    return;
  }
  audio_options.lane = &runtime.pcm_lane;
  audio_options.audio_mode = ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC;
  /*
   * Profile 5 was a useful falsifier, not a shippable operating point. Its
   * full-pipeline output cancelled isolated far speech, yet an aligned
   * production barge-in retained only 3--9% of ordinary near speech; the user
   * had to shout “STOP PLEASE” before Grok heard them. Lowering the loudspeaker
   * to 80% did not make normal speech reliable. ESP-SR 2.4.7's FD engines have
   * no double-talk detector, so another volume or NLP tweak cannot repair that
   * architectural mismatch.
   *
   * VOIP is the first-party engine which runs its double-talk detector every
   * frame. Keep its constant processed publication so playback edges cannot
   * switch the wire between raw and filtered signals. The earlier profile-3
   * result preserved 0.54 of simultaneous near speech—imperfect, but an order
   * of magnitude better than profile 5—and was measured at the now-rejected
   * 24 dB/90% near-clipping operating point. This build combines the DTD path
   * with the independently established 18 dB mic headroom and 80% speaker
   * level. Blanket linear-output bypass remains rejected because profile 6
   * caused Grok to transcribe StackChan's own reply.
   */
  audio_options.aec_profile = STACKCHAN_AEC_PROFILE;
  audio_options.maximum_downlink_frame_age_ms =
      STACKCHAN_MAXIMUM_DOWNLINK_FRAME_AGE_MS;
  audio_options.maximum_lane_items_per_dma_chunk = 4U;
  /*
   * The custom CoreS3 curve makes logical 100 the AW88298's actual 0 dB
   * setting. The codec's real mapping places logical 90 only about 1 dB below
   * that endpoint, and retained far playback drove the near ADC close to its
   * rail. A linear canceller cannot remove harmonics created after its clean
   * electrical reference, while the resulting loud echo also dominates quiet
   * nearby speech. The retained 85% production run remained digitally exact
   * and did not self-trigger, but its real double-talk transcript lost the
   * beginning and end of “Stop and reply exactly interruption test complete”.
   * Eighty is therefore the final bounded operating-point A/B before changing
   * the DSP topology: still a deliberately high, clearly audible device level,
   * but another roughly 1.5 dB of acoustic headroom. Do not compensate by
   * raising uplink gain; that would amplify residual echo together with genuine
   * near speech.
   */
  audio_options.speaker_volume_percent = 80;
  /*
   * The profile-3 deterministic run reached 31,932/32,767 on the near input
   * during far playback. That leaves no tolerance for capsule/room variation,
   * and any analogue rail contact produces harmonics absent from the divider
   * reference and therefore impossible for AEC to cancel. Keep the ES7210
   * near-channel PGA 6 dB below that clipped run. User-requested sensitivity
   * belongs after AEC, where it cannot alter the adaptive filter input; the
   * shared processed multiplier and clipping counter make that small uplift
   * explicit rather than smuggling it into this analogue operating point.
   */
  audio_options.microphone_gain_db = 18;
  /*
   * Non-near inputs remain at unity for mapping diagnostics. Cancellation uses
   * the capture-synchronous electrical divider on MIC3; the separate playback
   * activity bit only describes whether the speaker owner rendered content.
   */
  audio_options.reference_gain_db = 0;
  audio_options.diagnostic_trace = &runtime.aec_trace;
  audio_options.notify_uplink = notify_uplink;
  audio_options.notify_uplink_context = &runtime;
  audio_options.downlink_item_released =
      iterate_kit_esp_idf_pcm_transport_note_downlink_item_released;
  audio_options.downlink_item_released_context = &runtime.pcm_transport;
  audio_options.observe_playout = iterate_kit_stackchan_avatar_observe_playout;
  audio_options.observe_playout_context = NULL;
  /*
   * Reserve Wi-Fi's non-negotiable internal-DMA buffers before constructing
   * ESP-SR AEC. Its mixed internal/PSRAM footprint is flexible, whereas Wi-Fi
   * DMA is not. When
   * audio was started first, ESP-IDF could allocate only 3 of Wi-Fi's required
   * 10 static RX buffers and correctly refused to start the control plane.
   *
   * This order does not expose a half-initialized voice target. The network
   * task may associate while audio starts, but Cap'n Web mounting is consumed
   * only by the main poll loop below, which is not entered until both starts
   * have succeeded. Flexible codec/AEC allocations can therefore spill into
   * PSRAM while the DMA-only network reservation remains deterministic.
   */
  if (iterate_kit_esp_idf_itx_transport_start(&runtime.control_transport) !=
      ITERATE_KIT_OK) {
    ESP_LOGE(TAG,
             "control transport failed to start: platform=%ld",
             (long)runtime.control_transport.last_platform_error);
    return;
  }
  const esp_err_t audio_start =
      iterate_kit_core_s3_audio_owner_start(&audio_options);
  if (audio_start != ESP_OK) {
    /*
     * Audio failure prevents the capability loop from starting, so a generic
     * message makes a remotely reachable but unmounted board needlessly opaque.
     * Retain the exact ESP-IDF category in the bounded boot log for attribution.
     */
    ESP_LOGE(TAG,
             "CoreS3 audio owner failed to start: %s (%ld)",
             esp_err_to_name(audio_start),
             (long)audio_start);
    return;
  }

  struct iterate_kit_stackchan_avatar_metrics avatar_metrics;
  memset(&avatar_metrics, 0, sizeof(avatar_metrics));
  iterate_kit_stackchan_avatar_metrics_snapshot(&avatar_metrics);
  ESP_LOGI(TAG,
           "runtime ready: static_bytes=%u control_bytes=%u pcm_ring_bytes=%u "
           "device_bytes=%u control_transport_bytes=%u pcm_transport_bytes=%u "
           "avatar_static_bytes=%lu avatar_framebuffer_bytes=%lu",
           (unsigned)sizeof(runtime),
           (unsigned)(sizeof(control_inbox_storage) +
                      sizeof(control_outbox_storage)),
           (unsigned)(sizeof(runtime.pcm_uplink_storage) +
                      sizeof(runtime.pcm_downlink_storage)),
           (unsigned)sizeof(runtime.device),
           (unsigned)sizeof(runtime.control_transport),
           (unsigned)sizeof(runtime.pcm_transport),
           (unsigned long)avatar_metrics.static_bytes,
           (unsigned long)avatar_metrics.framebuffer_bytes);

  for (;;) {
    const int64_t now_us = esp_timer_get_time();
    const uint64_t now_ms = now_us < 0 ? 0U : (uint64_t)now_us / 1000U;
    /*
     * Physical and remote call actions converge before the portable device
     * poll.  The side key therefore exercises the same event observer, audio
     * intent reconciler, and `/pcm` lifecycle as conversation.start()/hangUp();
     * it is not a target-only shortcut around the capability contract.
     */
    consume_physical_call_touch(&runtime);
    struct iterate_kit_poll_result device_poll =
        iterate_kit_stackchan_poll(&runtime.device, now_ms);
    enum iterate_kit_status intent_status;
    enum iterate_kit_status control_status;

    if (device_poll.status == ITERATE_KIT_POLL_CALLBACK_REJECTED) {
      ESP_LOGW(TAG,
               "remote capability subscription ended: callback rejected "
               "total=%lu",
               (unsigned long)iterate_kit_peer_subscription_callback_rejections(
                   &runtime.device.peer));
    } else if (device_poll.status != ITERATE_KIT_POLL_OK) {
      ESP_LOGE(TAG,
               "device poll failed: status=%d capnweb=%d",
               (int)device_poll.status,
               (int)device_poll.capnweb_status);
    }

    control_status = iterate_kit_esp_idf_itx_transport_poll(
        &runtime.control_transport, STACKCHAN_CONTROL_MESSAGES_PER_POLL);
    if (control_status != ITERATE_KIT_OK &&
        runtime.control_transport.state != runtime.last_control_state) {
      ESP_LOGE(TAG,
               "control transition failed: state=%s status=%d capnweb=%d",
               iterate_kit_esp_idf_itx_transport_state_name(
                   runtime.control_transport.state),
               (int)control_status,
               (int)runtime.control_transport.last_capnweb_status);
    }
    if (runtime.control_transport.state != runtime.last_control_state) {
      ESP_LOGI(TAG,
               "control state=%s",
               iterate_kit_esp_idf_itx_transport_state_name(
                   runtime.control_transport.state));
      runtime.last_control_state = runtime.control_transport.state;
    }

    supervise_control_mount(&runtime, now_ms);
    /*
     * This is the only board-level involvement in PCM lifetime. The shared
     * owner joins authenticated control generation, transport readiness, and
     * conversation intent; StackChan contributes only its conversation fact
     * and the audio-intent hardware hook installed during preparation.
     */
    (void)iterate_kit_esp_idf_pcm_session_poll(&runtime.pcm_session);
    intent_status =
        iterate_kit_audio_intent_reconciler_poll(&runtime.audio_intent);
    if (intent_status != ITERATE_KIT_OK &&
        intent_status != ITERATE_KIT_BACKPRESSURE &&
        intent_status != runtime.last_audio_intent_status) {
      ESP_LOGE(TAG, "audio intent failed: status=%d", (int)intent_status);
    }
    runtime.last_audio_intent_status = intent_status;
    update_stackchan_status(&runtime, now_ms);
    /*
     * Audio owners are already blocked on physical codec/DMA clocks at higher
     * priority. This sleep only bounds cooperative Cap'n Web/control latency
     * and lets both idle tasks run; no PCM frame waits for this loop.
     */
    vTaskDelay(pdMS_TO_TICKS(STACKCHAN_MAIN_LOOP_DELAY_MS));
  }
}
