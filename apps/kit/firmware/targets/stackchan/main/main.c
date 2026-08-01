#include "iterate/kit/audio_intent_reconciler.h"
#include "iterate/kit/cpu_usage.h"
#include "iterate/kit/devices/stackchan.h"
#include "iterate/kit/pcm_lane.h"
#include "iterate/kit/pcm_websocket.h"
#include "iterate/kit/platforms/core_s3_audio_owner.h"
#include "iterate/kit/platforms/esp_idf_configuration.h"
#include "iterate/kit/platforms/esp_idf_itx_transport.h"
#include "iterate/kit/platforms/esp_idf_pcm_transport.h"
#include "iterate/kit/platforms/esp_idf_websocket_policy.h"
#include "iterate/kit/platforms/stackchan_hardware.h"
#include "iterate/kit/spsc_ring.h"
#include "stackchan_realtime_policy.h"

#include "esp_err.h"
#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
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
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/task.h"

#include <limits.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

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
#define STACKCHAN_METRICS_SUBSCRIPTION_CAPACITY 2U
#define STACKCHAN_SCREEN_URL_CAPACITY 513U
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

#define STACKCHAN_PCM_FRAME_DURATION_MS                              \
  ((1000U * ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME) /                 \
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

static const char *const TAG = "iterate-stackchan";
static const char *const MOUNT_PATH[] = {"kit", "stackchan"};

_Static_assert(
    STACKCHAN_PCM_FRAME_DURATION_MS == 20U,
    "StackChan must use the exact PCM-v1 frame duration");
_Static_assert(
    STACKCHAN_PCM_RESERVE_MS % STACKCHAN_PCM_FRAME_DURATION_MS == 0U,
    "PCM reserve must contain complete protocol frames");
_Static_assert(
    (STACKCHAN_PCM_RING_SLOTS & (STACKCHAN_PCM_RING_SLOTS - 1U)) == 0U,
    "SPSC PCM slot count must be a power of two");
_Static_assert(
    STACKCHAN_PCM_RESERVE_MS == ITERATE_KIT_ESP_IDF_PCM_CAPTURE_MAX_AGE_MS,
    "ring reserve and uplink freshness policy are one latency budget");
_Static_assert(
    (STACKCHAN_CONTROL_INBOX_SLOTS &
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

struct stackchan_runtime {
  struct iterate_kit_configuration configuration;
  struct iterate_kit_itx_connection connection;
  struct capnweb_pending_call
      pending_calls[STACKCHAN_PENDING_CALL_CAPACITY];
  struct capnweb_export exports[STACKCHAN_EXPORT_CAPACITY];
  struct capnweb_import imports[STACKCHAN_IMPORT_CAPACITY];
  struct capnweb_json_token tokens[STACKCHAN_TOKEN_CAPACITY];
  char output_buffer[STACKCHAN_OUTPUT_CAPACITY];
  char screen_url_scratch[STACKCHAN_SCREEN_URL_CAPACITY];
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
  struct iterate_kit_stackchan_hardware hardware;
  struct iterate_kit_stackchan device;
  struct iterate_kit_audio_intent_reconciler audio_intent;
  struct iterate_kit_cpu_usage_meter cpu_usage;

  int64_t booted_at_us;
  enum iterate_kit_esp_idf_itx_transport_state last_control_state;
  enum iterate_kit_esp_idf_pcm_transport_state last_pcm_state;
  enum iterate_kit_status last_audio_intent_status;
  bool pcm_started;
  bool pcm_start_attempted_for_conversation;
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
  const int64_t now_us = esp_timer_get_time();
  int64_t cpu_permille = -1;
  uint32_t stack_headroom;
  wifi_ap_record_t access_point;
  enum iterate_kit_status cpu_status;

  if (state == NULL || sample == NULL || now_us < state->booted_at_us) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  cpu_status = iterate_kit_cpu_usage_meter_sample(
      &state->cpu_usage,
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
  memset(&access_point, 0, sizeof(access_point));
  iterate_kit_esp_idf_itx_transport_metrics(
      &state->control_transport, &control);
  iterate_kit_esp_idf_pcm_transport_metrics(
      &state->pcm_transport, &pcm);
  iterate_kit_core_s3_audio_owner_metrics_snapshot(&owner);

  sample->uptime_ms = (now_us - state->booted_at_us) / 1000;
  sample->free_heap_bytes = esp_get_free_heap_size();
  sample->minimum_free_heap_bytes = esp_get_minimum_free_heap_size();
  sample->free_internal_heap_bytes = esp_get_free_internal_heap_size();
  sample->minimum_free_internal_heap_bytes =
      heap_caps_get_minimum_free_size(
          MALLOC_CAP_8BIT | MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
  sample->free_psram_bytes = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
  sample->cpu_permille = cpu_permille;
  stack_headroom = (uint32_t)(
      uxTaskGetStackHighWaterMark(NULL) * sizeof(StackType_t));
  stack_headroom = minimum_nonzero(
      stack_headroom, control.network_task_stack_high_water_bytes);
  stack_headroom = minimum_nonzero(
      stack_headroom, pcm.network_task_stack_high_water_bytes);
  stack_headroom = minimum_nonzero(
      stack_headroom, owner.io_stack_minimum_free_bytes);
  stack_headroom = minimum_nonzero(
      stack_headroom, owner.aec_stack_minimum_free_bytes);
  sample->task_stack_high_water_bytes = stack_headroom;

  sample->has_audio = true;
  sample->audio.capture.sent = owner.clean_uplink_frames;
  sample->audio.capture.dropped = owner.clean_uplink_drops;
  sample->audio.capture.failures = owner.capture_failures;
  sample->audio.uplink.sent = pcm.uplink_frames_sent;
  sample->audio.uplink.dropped = saturating_add_u32(
      pcm.uplink_frames_discarded,
      pcm.lane.uplink.producer_backpressure);
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
  sample->audio.uplink.socket_restarts =
      pcm.uplink_socket_restarts;
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
  sample->audio.downlink.dropped =
      pcm.lane.downlink.producer_backpressure;
  sample->audio.downlink.depth = pcm.lane.downlink.current_slots;
  sample->audio.downlink.high_water =
      pcm.lane.downlink.high_water_slots;
  sample->audio.downlink.failures = pcm.downlink_receive_failures;
  /*
   * CoreS3 hands fixed 8 ms codec chunks to a synchronous driver, so a 20 ms
   * wire frame can straddle two writes. No current TX-EOF observation retains
   * its content/generation identity. Omit the entire physical playback group
   * rather than dividing sample counts and fabricating conservation.
   */
  sample->audio.has_playback = false;
  sample->audio.protocol_failures = pcm.protocol_failures;
  sample->audio.buffers.uplink_application =
      pcm.buffers.uplink_application;
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

  sample->has_control_diagnostics = true;
  sample->control_diagnostics.schema_version = 3U;
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
  sample->control_diagnostics.network.wifi_connected =
      control.wifi_connected;
  sample->control_diagnostics.network.pcm_websocket_connections =
      pcm.websocket_connections;
  sample->control_diagnostics.network.pcm_websocket_disconnects =
      pcm.websocket_disconnects;
  sample->control_diagnostics.network.pcm_websocket_errors =
      pcm.websocket_errors;
  if (esp_wifi_sta_get_ap_info(&access_point) == ESP_OK) {
    sample->control_diagnostics.network.has_wifi_rssi_dbm = true;
    sample->control_diagnostics.network.wifi_rssi_dbm = access_point.rssi;
  }
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status request_uplink_active(
    void *context, bool active) {
  (void)context;
  return iterate_kit_core_s3_audio_owner_request_uplink_active(active);
}

static void request_playback_reset(void *context) {
  (void)context;
  iterate_kit_core_s3_audio_owner_request_playback_reset();
}

static void notify_uplink(void *context) {
  struct stackchan_runtime *state = context;
  if (state != NULL) {
    iterate_kit_esp_idf_pcm_transport_notify_uplink(
        &state->pcm_transport);
  }
}

static void observe_device_event(
    void *context,
    const struct iterate_kit_device_event *event,
    enum iterate_kit_status result) {
  (void)context;
  if (event == NULL) return;
  /*
   * This is a transition log, not a frame log. The profile also delivers the
   * same bounded event over its capability subscription; serial remains a
   * fallback for boot attribution without stealing cycles from PCM owners.
   */
  ESP_LOGI(
      TAG,
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

static bool initialise_rings(struct stackchan_runtime *state) {
  return iterate_kit_spsc_ring_init(
             &state->control_inbox,
             control_inbox_storage,
             STACKCHAN_CONTROL_SLOT_CAPACITY,
             STACKCHAN_CONTROL_INBOX_SLOTS,
             state->control_inbox_lengths) == ITERATE_KIT_OK &&
      iterate_kit_spsc_ring_init(
             &state->control_outbox,
             control_outbox_storage,
             STACKCHAN_CONTROL_SLOT_CAPACITY,
             STACKCHAN_CONTROL_OUTBOX_SLOTS,
             state->control_outbox_lengths) == ITERATE_KIT_OK &&
      iterate_kit_spsc_ring_init(
             &state->pcm_uplink,
             state->pcm_uplink_storage,
             sizeof(state->pcm_uplink_storage[0]),
             STACKCHAN_PCM_RING_SLOTS,
             state->pcm_uplink_lengths) == ITERATE_KIT_OK &&
      iterate_kit_spsc_ring_init(
             &state->pcm_downlink,
             state->pcm_downlink_storage,
             sizeof(state->pcm_downlink_storage[0]),
             STACKCHAN_PCM_RING_SLOTS,
             state->pcm_downlink_lengths) == ITERATE_KIT_OK &&
      iterate_kit_pcm_lane_init(
             &state->pcm_lane,
             &state->pcm_uplink,
             &state->pcm_downlink) == ITERATE_KIT_OK;
}

static bool initialise_device(struct stackchan_runtime *state) {
  const struct iterate_kit_stackchan_hardware_ops hardware_ops = {0};
  struct iterate_kit_stackchan_options device_options;
  struct iterate_kit_audio_intent_ops audio_ops;
  struct iterate_kit_stackchan_control_driver control_driver;

  /*
   * Audio is the first physical StackChan slice. The generic screen/LED/servo/
   * camera capabilities are mounted now through an adapter that returns
   * UNAVAILABLE until their one-owner BSP operations are injected. A truthful
   * explicit error is safer than dummy success and avoids coupling their later
   * bring-up to the realtime voice target.
   */
  if (iterate_kit_stackchan_hardware_init(
          &state->hardware, &hardware_ops) != ITERATE_KIT_OK) {
    return false;
  }

  memset(&device_options, 0, sizeof(device_options));
  device_options.screen =
      iterate_kit_stackchan_screen_driver(&state->hardware);
  device_options.screen_url_scratch = state->screen_url_scratch;
  device_options.screen_url_scratch_size =
      sizeof(state->screen_url_scratch);
  device_options.servos =
      iterate_kit_stackchan_servo_driver(&state->hardware);
  device_options.leds =
      iterate_kit_stackchan_led_driver(&state->hardware);
  device_options.camera =
      iterate_kit_stackchan_camera_driver(&state->hardware);
  device_options.maximum_photo_bytes = STACKCHAN_MAXIMUM_PHOTO_BYTES;
  device_options.playback_interruption =
      (struct iterate_kit_conversation_playback_interruption_driver){
        .context = NULL,
        .request =
            iterate_kit_core_s3_audio_owner_request_playback_interruption,
        .poll =
            iterate_kit_core_s3_audio_owner_poll_playback_interruption,
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
  device_options.metrics.diagnostics_expression_buffer =
      state->diagnostics_expression;
  device_options.metrics.diagnostics_expression_capacity =
      sizeof(state->diagnostics_expression);
  if (iterate_kit_stackchan_init(
          &state->device, &device_options) != CAPNWEB_OK) {
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
    .handler = {
      .context = &state->audio_intent,
      .handle = iterate_kit_audio_intent_reconciler_handle,
    },
    .observer = {
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
  struct iterate_kit_itx_connection_options connection_options;

  memset(&control_options, 0, sizeof(control_options));
  control_options.configuration = &state->configuration;
  control_options.connection = &state->connection;
  control_options.control_inbox = &state->control_inbox;
  control_options.control_outbox = &state->control_outbox;
  if (iterate_kit_esp_idf_itx_transport_prepare(
          &state->control_transport,
          &control_options) != ITERATE_KIT_OK) {
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
  return iterate_kit_itx_connection_init(
             &state->connection, &connection_options) == CAPNWEB_OK;
}

static void reconcile_pcm_conversation(struct stackchan_runtime *state) {
  const bool active =
      iterate_kit_stackchan_is_conversation_active(&state->device);

  if (state->pcm_started &&
      state->pcm_transport.state == ITERATE_KIT_ESP_IDF_PCM_STOPPING) {
    const enum iterate_kit_status status =
        iterate_kit_esp_idf_pcm_transport_finish_stop(
            &state->pcm_transport);
    if (status == ITERATE_KIT_OK) {
      state->pcm_started = false;
      state->pcm_start_attempted_for_conversation = false;
      ESP_LOGI(TAG, "pcm conversation stopped");
    } else if (status != ITERATE_KIT_UNAVAILABLE) {
      ESP_LOGE(TAG, "pcm stop reap failed: status=%d", (int)status);
    }
  } else if (!active && state->pcm_started) {
    enum iterate_kit_status status =
        iterate_kit_esp_idf_pcm_transport_request_stop(
            &state->pcm_transport);
    if (status == ITERATE_KIT_OK) {
      status = iterate_kit_esp_idf_pcm_transport_finish_stop(
          &state->pcm_transport);
    }
    if (status == ITERATE_KIT_OK) {
      state->pcm_started = false;
      state->pcm_start_attempted_for_conversation = false;
      ESP_LOGI(TAG, "pcm conversation stopped");
    } else if (status != ITERATE_KIT_UNAVAILABLE) {
      ESP_LOGE(TAG, "pcm stop failed: status=%d", (int)status);
    }
  } else if (!active) {
    /*
     * A failed initial connect retries only after a deliberate new
     * conversation. This prevents a 10 ms DNS/TLS retry storm during outage.
     */
    state->pcm_start_attempted_for_conversation = false;
  }

  if (active && !state->pcm_started &&
      !state->pcm_start_attempted_for_conversation &&
      state->control_transport.state == ITERATE_KIT_ESP_IDF_ITX_READY) {
    const enum iterate_kit_status status =
        iterate_kit_esp_idf_pcm_transport_start(&state->pcm_transport);
    state->pcm_start_attempted_for_conversation = true;
    if (status == ITERATE_KIT_OK) {
      state->pcm_started = true;
    } else {
      ESP_LOGE(
          TAG,
          "pcm start failed: status=%d platform=%ld",
          (int)status,
          (long)state->pcm_transport.last_platform_error);
    }
  }

  if (state->pcm_started &&
      state->pcm_transport.state != ITERATE_KIT_ESP_IDF_PCM_STOPPING) {
    const enum iterate_kit_status status =
        iterate_kit_esp_idf_pcm_transport_poll(&state->pcm_transport);
    if (status != ITERATE_KIT_OK &&
        state->pcm_transport.state != state->last_pcm_state) {
      ESP_LOGE(
          TAG,
          "pcm transition failed: state=%s status=%d platform=%ld",
          iterate_kit_esp_idf_pcm_transport_state_name(
              state->pcm_transport.state),
          (int)status,
          (long)state->pcm_transport.last_platform_error);
    }
    if (state->pcm_transport.state != state->last_pcm_state) {
      struct iterate_kit_esp_idf_pcm_transport_metrics pcm;
      memset(&pcm, 0, sizeof(pcm));
      iterate_kit_esp_idf_pcm_transport_metrics(
          &state->pcm_transport, &pcm);
      /*
       * Connection churn has several materially different causes: a peer
       * CLOSE, a lower-transport read/write failure, local ordered-item loss,
       * or a deliberate freshness restart. A bare "connecting" line erased
       * that distinction and encouraged guessing from the later 1006 observed
       * by userspace. Emit one bounded transition record with the counters
       * needed to classify the interval; never log per PCM frame or per idle
       * socket probe because serial output itself can perturb audio deadlines.
       */
      ESP_LOGI(
          TAG,
          "pcm state=%s platform=%ld connections=%lu disconnects=%lu "
          "errors=%lu protocol=%lu rx_calls=%lu rx_chunks=%lu "
          "pings=%lu pongs=%lu control_bp=%lu ordered_losses=%lu "
          "uplink_socket_restarts=%lu",
          iterate_kit_esp_idf_pcm_transport_state_name(
              state->pcm_transport.state),
          (long)pcm.last_platform_error,
          (unsigned long)pcm.websocket_connections,
          (unsigned long)pcm.websocket_disconnects,
          (unsigned long)pcm.websocket_errors,
          (unsigned long)pcm.protocol_failures,
          (unsigned long)pcm.websocket_receive_calls,
          (unsigned long)pcm.websocket_receive_chunks,
          (unsigned long)pcm.websocket_pings_received,
          (unsigned long)pcm.websocket_pongs_received,
          (unsigned long)pcm.websocket_control_backpressure,
          (unsigned long)pcm.downlink_ordered_item_losses,
          (unsigned long)pcm.uplink_socket_restarts);
      state->last_pcm_state = state->pcm_transport.state;
    }
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
        iterate_kit_esp_configuration_status_name(
            configuration_result.status),
        iterate_kit_configuration_error_name(
            configuration_result.configuration_error),
        (long)configuration_result.platform_error);
    return;
  }

  runtime.booted_at_us = esp_timer_get_time();
  if (runtime.booted_at_us < 0 ||
      iterate_kit_cpu_usage_meter_init(
          &runtime.cpu_usage,
          CONFIG_FREERTOS_NUMBER_OF_CORES) != ITERATE_KIT_OK ||
      iterate_kit_cpu_usage_meter_sample(
          &runtime.cpu_usage,
          (uint64_t)runtime.booted_at_us,
          aggregate_idle_time(),
          &ignored_cpu) != ITERATE_KIT_OK ||
      !initialise_rings(&runtime) ||
      !initialise_device(&runtime) ||
      !initialise_connections(&runtime)) {
    ESP_LOGE(TAG, "bounded target initialization failed");
    return;
  }

  memset(&audio_options, 0, sizeof(audio_options));
  audio_options.lane = &runtime.pcm_lane;
  audio_options.audio_mode = ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC;
  audio_options.maximum_downlink_frame_age_ms =
      STACKCHAN_MAXIMUM_DOWNLINK_FRAME_AGE_MS;
  audio_options.maximum_lane_items_per_dma_chunk = 4U;
  audio_options.speaker_volume_percent = 100;
  audio_options.microphone_gain_db = 24;
  audio_options.notify_uplink = notify_uplink;
  audio_options.notify_uplink_context = &runtime;
  if (iterate_kit_core_s3_audio_owner_start(&audio_options) != ESP_OK) {
    ESP_LOGE(TAG, "CoreS3 audio owner failed to start");
    return;
  }
  if (iterate_kit_esp_idf_itx_transport_start(
          &runtime.control_transport) != ITERATE_KIT_OK) {
    ESP_LOGE(
        TAG,
        "control transport failed to start: platform=%ld",
        (long)runtime.control_transport.last_platform_error);
    return;
  }

  ESP_LOGI(
      TAG,
      "runtime ready: static_bytes=%u control_bytes=%u pcm_ring_bytes=%u "
      "device_bytes=%u control_transport_bytes=%u pcm_transport_bytes=%u",
      (unsigned)sizeof(runtime),
      (unsigned)(sizeof(control_inbox_storage) +
                 sizeof(control_outbox_storage)),
      (unsigned)(sizeof(runtime.pcm_uplink_storage) +
                 sizeof(runtime.pcm_downlink_storage)),
      (unsigned)sizeof(runtime.device),
      (unsigned)sizeof(runtime.control_transport),
      (unsigned)sizeof(runtime.pcm_transport));

  for (;;) {
    const int64_t now_us = esp_timer_get_time();
    struct iterate_kit_poll_result device_poll =
        iterate_kit_stackchan_poll(
            &runtime.device,
            now_us < 0 ? 0U : (uint64_t)now_us / 1000U);
    enum iterate_kit_status intent_status;
    enum iterate_kit_status control_status;

    if (device_poll.status != ITERATE_KIT_POLL_OK) {
      ESP_LOGE(
          TAG,
          "device poll failed: status=%d capnweb=%d",
          (int)device_poll.status,
          (int)device_poll.capnweb_status);
    }

    intent_status =
        iterate_kit_audio_intent_reconciler_poll(&runtime.audio_intent);
    if (intent_status != ITERATE_KIT_OK &&
        intent_status != ITERATE_KIT_BACKPRESSURE &&
        intent_status != runtime.last_audio_intent_status) {
      ESP_LOGE(
          TAG,
          "audio intent failed: status=%d",
          (int)intent_status);
    }
    runtime.last_audio_intent_status = intent_status;

    control_status = iterate_kit_esp_idf_itx_transport_poll(
        &runtime.control_transport,
        STACKCHAN_CONTROL_MESSAGES_PER_POLL);
    if (control_status != ITERATE_KIT_OK &&
        runtime.control_transport.state != runtime.last_control_state) {
      ESP_LOGE(
          TAG,
          "control transition failed: state=%s status=%d capnweb=%d",
          iterate_kit_esp_idf_itx_transport_state_name(
              runtime.control_transport.state),
          (int)control_status,
          (int)runtime.control_transport.last_capnweb_status);
    }
    if (runtime.control_transport.state != runtime.last_control_state) {
      ESP_LOGI(
          TAG,
          "control state=%s",
          iterate_kit_esp_idf_itx_transport_state_name(
              runtime.control_transport.state));
      runtime.last_control_state = runtime.control_transport.state;
    }

    reconcile_pcm_conversation(&runtime);
    /*
     * Audio owners are already blocked on physical codec/DMA clocks at higher
     * priority. This sleep only bounds cooperative Cap'n Web/control latency
     * and lets both idle tasks run; no PCM frame waits for this loop.
     */
    vTaskDelay(pdMS_TO_TICKS(STACKCHAN_MAIN_LOOP_DELAY_MS));
  }
}
