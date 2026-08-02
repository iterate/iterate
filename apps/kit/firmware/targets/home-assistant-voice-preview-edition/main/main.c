#include "iterate/kit/audio_intent_reconciler.h"
#include "iterate/kit/cpu_usage.h"
#include "iterate/kit/debounced_button.h"
#include "iterate/kit/devices/voice_satellite.h"
#include "iterate/kit/pcm_lane.h"
#include "iterate/kit/pcm_websocket.h"
#include "iterate/kit/platforms/voice_pe_audio_owner.h"
#include "iterate/kit/platforms/esp_idf_configuration.h"
#include "iterate/kit/platforms/esp_idf_itx_transport.h"
#include "iterate/kit/platforms/esp_idf_pcm_transport.h"
#include "iterate/kit/platforms/esp_idf_websocket_policy.h"
#include "iterate/kit/spsc_ring.h"

#include "havpe_ui.h"
#include "led_strip.h"

#include "driver/gpio.h"
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
 * HAVPE's target is intentionally composition, not a second voice stack:
 *
 *   Cap'n Web control -> portable voice-satellite profile -> call intent
 *   binary /pcm socket <-> bounded shared lane <-> HAVPE audio owner/AEC
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

#define HAVPE_PENDING_CALL_CAPACITY 8U
#define HAVPE_EXPORT_CAPACITY 8U
#define HAVPE_IMPORT_CAPACITY 8U
#define HAVPE_TOKEN_CAPACITY 64U
#define HAVPE_OUTPUT_CAPACITY 128U
#define HAVPE_METRICS_SUBSCRIPTION_CAPACITY 2U
#define HAVPE_PLAYBACK_INTERRUPTION_ACK_TIMEOUT_MS 50U
#define HAVPE_MAXIMUM_DOWNLINK_FRAME_AGE_MS 400U
#define HAVPE_MAXIMUM_LANE_ITEMS_PER_PLAYBACK_EDGE 4U
#define HAVPE_LED_COUNT 12U
#define HAVPE_LED_GPIO 21
#define HAVPE_LED_POWER_GPIO GPIO_NUM_45
#define HAVPE_LED_POWER_ENABLE_MS 20U
#define HAVPE_CENTER_BUTTON_GPIO GPIO_NUM_0
#define HAVPE_CENTER_BUTTON_DEBOUNCE_MS 30U
#define HAVPE_CENTER_BUTTON_RESTART_HOLD_MS 3000U
#define HAVPE_RING_REFRESH_MS 50U
#define HAVPE_RING_NETWORK_SAMPLE_MS 1000U
#define HAVPE_RING_MANUAL_OVERRIDE_MS 3000U

/*
 * One callback consumes push+pull and may return resolve+release. Eight slots
 * per direction cover two admitted callbacks plus one bounded owner pass. A
 * larger ring would retain delayed control history; a smaller ring already
 * failed the corresponding measured Stick burst.
 */
#define HAVPE_CONTROL_INBOX_SLOTS 8U
#define HAVPE_CONTROL_OUTBOX_SLOTS 8U
#define HAVPE_CONTROL_SLOT_CAPACITY \
  ITERATE_KIT_ESP_IDF_CONTROL_MESSAGE_CAPACITY
#define HAVPE_CONTROL_MESSAGES_PER_POLL 4U

#define HAVPE_PCM_FRAME_DURATION_MS                              \
  ((1000U * ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME) /                 \
   ITERATE_KIT_PCM_V1_SAMPLE_RATE_HZ)
/*
 * Uplink and downlink do not have the same failure policy and therefore must
 * not share one convenient capacity. Microphone capture keeps the established
 * 640 ms freshness budget: after that point old speech is useless and must be
 * discarded visibly. Playback retains the same 400 ms age gate, but needs a
 * separate 1,280 ms allocation to absorb sub-second TCP/TLS delivery bunching.
 * A physical count-to-100 run filled the former 32-frame downlink ring and its
 * transport retired the call around audible number 37 even though Grok had
 * completed the response. Sixty-four downlink slots cost about 21 KiB more
 * internal RAM on this 8 MiB-PSRAM target; they are burst headroom, not target
 * latency. The userspace scheduler's device-depth feedback prevents slow
 * cross-clock drift, while the 400 ms age gate prevents this larger allocation
 * from replaying outage history. Growing both directions would spend scarce
 * internal RAM without improving microphone freshness.
 */
#define HAVPE_PCM_UPLINK_RESERVE_MS 640U
#define HAVPE_PCM_DOWNLINK_RESERVE_MS 1280U
#define HAVPE_PCM_UPLINK_RING_SLOTS \
  (HAVPE_PCM_UPLINK_RESERVE_MS / HAVPE_PCM_FRAME_DURATION_MS)
#define HAVPE_PCM_DOWNLINK_RING_SLOTS \
  (HAVPE_PCM_DOWNLINK_RESERVE_MS / HAVPE_PCM_FRAME_DURATION_MS)
#define HAVPE_MAIN_LOOP_DELAY_MS 10U

static const char *const TAG = "iterate-havpe";
/*
 * Capability paths are source-level API member names, not URL/product slugs.
 * Keep the human/device slug hyphenated below, but expose the board at
 * `itx.kit.homeAssistantVoicePreviewEdition`: OS deliberately rejects a
 * hyphenated segment because dotted capability dispatch cannot address it as
 * a normal member. The shared mount validator pins this distinction before a
 * target can authenticate with an incompatible address again.
 */
static const char *const MOUNT_PATH[] = {
  "kit",
  "homeAssistantVoicePreviewEdition",
};
static const struct iterate_kit_device_manifest DEVICE_MANIFEST = {
  .slug = "home-assistant-voice-preview-edition",
  .display_name = "Home Assistant Voice Preview Edition",
  .audio_mode = ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC,
};

_Static_assert(
    HAVPE_PCM_FRAME_DURATION_MS == 20U,
    "HAVPE must use the exact PCM-v1 frame duration");
_Static_assert(
    HAVPE_LED_COUNT == HAVPE_UI_RING_LED_COUNT,
    "the physical strip and host-tested HAVPE UI must describe one ring");
_Static_assert(
    HAVPE_PCM_UPLINK_RESERVE_MS % HAVPE_PCM_FRAME_DURATION_MS == 0U &&
        HAVPE_PCM_DOWNLINK_RESERVE_MS % HAVPE_PCM_FRAME_DURATION_MS == 0U,
    "PCM reserves must contain complete protocol frames");
_Static_assert(
    (HAVPE_PCM_UPLINK_RING_SLOTS &
     (HAVPE_PCM_UPLINK_RING_SLOTS - 1U)) == 0U &&
        (HAVPE_PCM_DOWNLINK_RING_SLOTS &
         (HAVPE_PCM_DOWNLINK_RING_SLOTS - 1U)) == 0U,
    "SPSC PCM slot counts must be powers of two");
_Static_assert(
    HAVPE_PCM_UPLINK_RESERVE_MS ==
        ITERATE_KIT_ESP_IDF_PCM_CAPTURE_MAX_AGE_MS,
    "uplink ring reserve and capture freshness are one latency budget");
_Static_assert(
    (HAVPE_CONTROL_INBOX_SLOTS &
     (HAVPE_CONTROL_INBOX_SLOTS - 1U)) == 0U &&
        (HAVPE_CONTROL_OUTBOX_SLOTS &
         (HAVPE_CONTROL_OUTBOX_SLOTS - 1U)) == 0U,
    "SPSC control slot counts must be powers of two");

/*
 * Cap'n Web envelopes are neither DMA buffers nor part of the audio deadline.
 * Keeping sixteen 8 KiB payload slots inside `havpe_runtime` consumed
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
    control_inbox_storage[HAVPE_CONTROL_INBOX_SLOTS]
                           [HAVPE_CONTROL_SLOT_CAPACITY];
EXT_RAM_BSS_ATTR static uint8_t
    control_outbox_storage[HAVPE_CONTROL_OUTBOX_SLOTS]
                            [HAVPE_CONTROL_SLOT_CAPACITY];

struct havpe_runtime {
  struct iterate_kit_configuration configuration;
  struct iterate_kit_itx_connection connection;
  struct capnweb_pending_call
      pending_calls[HAVPE_PENDING_CALL_CAPACITY];
  struct capnweb_export exports[HAVPE_EXPORT_CAPACITY];
  struct capnweb_import imports[HAVPE_IMPORT_CAPACITY];
  struct capnweb_json_token tokens[HAVPE_TOKEN_CAPACITY];
  char output_buffer[HAVPE_OUTPUT_CAPACITY];
  char diagnostics_expression
      [ITERATE_KIT_METRICS_DIAGNOSTICS_EXPRESSION_CAPACITY];
  struct iterate_kit_metrics_subscription
      subscriptions[HAVPE_METRICS_SUBSCRIPTION_CAPACITY];

  struct iterate_kit_spsc_ring control_inbox;
  struct iterate_kit_spsc_ring control_outbox;
  size_t control_inbox_lengths[HAVPE_CONTROL_INBOX_SLOTS];
  size_t control_outbox_lengths[HAVPE_CONTROL_OUTBOX_SLOTS];

  struct iterate_kit_spsc_ring pcm_uplink;
  struct iterate_kit_spsc_ring pcm_downlink;
  struct iterate_kit_pcm_uplink_slot
      pcm_uplink_storage[HAVPE_PCM_UPLINK_RING_SLOTS];
  struct iterate_kit_pcm_downlink_slot
      pcm_downlink_storage[HAVPE_PCM_DOWNLINK_RING_SLOTS];
  size_t pcm_uplink_lengths[HAVPE_PCM_UPLINK_RING_SLOTS];
  size_t pcm_downlink_lengths[HAVPE_PCM_DOWNLINK_RING_SLOTS];
  struct iterate_kit_pcm_lane pcm_lane;

  struct iterate_kit_esp_idf_itx_transport control_transport;
  struct iterate_kit_esp_idf_pcm_transport pcm_transport;
  led_strip_handle_t leds;
  struct iterate_kit_voice_satellite device;
  struct iterate_kit_audio_intent_reconciler audio_intent;
  struct iterate_kit_cpu_usage_meter cpu_usage;
  struct iterate_kit_debounced_button center_button;
  struct havpe_center_button_gesture center_button_gesture;
  struct havpe_ui_rgb ring_frame[HAVPE_UI_RING_LED_COUNT];

  int64_t booted_at_us;
  uint64_t next_ring_refresh_ms;
  uint64_t next_ring_network_sample_ms;
  uint64_t ring_manual_override_until_ms;
  enum iterate_kit_esp_idf_itx_transport_state last_control_state;
  enum iterate_kit_esp_idf_pcm_transport_state last_pcm_state;
  enum iterate_kit_status last_audio_intent_status;
  int32_t wifi_rssi_dbm;
  bool wifi_observed;
  bool ring_power_enabled;
  bool ring_frame_valid;
  bool ring_write_failure_latched;
  bool pcm_started;
  bool pcm_start_attempted_for_conversation;
};

static struct havpe_runtime runtime;

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
  struct havpe_runtime *state = context;
  struct iterate_kit_esp_idf_itx_transport_metrics control;
  struct iterate_kit_esp_idf_pcm_transport_metrics pcm;
  struct iterate_kit_voice_pe_audio_owner_metrics owner;
  struct iterate_kit_voice_pe_aec_signal_metrics aec_signal;
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
  memset(&aec_signal, 0, sizeof(aec_signal));
  memset(&access_point, 0, sizeof(access_point));
  iterate_kit_esp_idf_itx_transport_metrics(
      &state->control_transport, &control);
  iterate_kit_esp_idf_pcm_transport_metrics(
      &state->pcm_transport, &pcm);
  iterate_kit_voice_pe_audio_owner_metrics_snapshot(&owner);
  if (iterate_kit_voice_pe_audio_owner_aec_signal_metrics_snapshot(
          &aec_signal) != ITERATE_KIT_OK) {
    /*
     * A malformed aligned window is not equivalent to a quiet clean channel.
     * Fail the complete sample so the callback cannot silently manufacture an
     * impressive AEC result from zero-initialized amplitudes.
     */
    return ITERATE_KIT_STATE_ERROR;
  }

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
      stack_headroom, owner.playback_stack_minimum_free_bytes);
  stack_headroom = minimum_nonzero(
      stack_headroom, owner.capture_stack_minimum_free_bytes);
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
   * The I2S owner can count 10 ms physical edges and content samples, but the
   * public group is defined in complete 20 ms protocol frames. Do not divide
   * and round those counters: absence is more truthful than false conservation.
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
   * HAVPE has a different synchronous-codec clock and AEC topology; claiming
   * that schema with zero-filled fields would be worse than honest absence.
   */
  sample->has_playback_detail = false;

  sample->has_aec_detail = false;
  sample->has_raw_clean_aec_detail = true;
  sample->raw_clean_aec_detail.schema_version = 3U;
  sample->raw_clean_aec_detail.sequence = aec_signal.sequence;
  sample->raw_clean_aec_detail.window_started_at_ms =
      aec_signal.window_started_at_us >= (uint64_t)state->booted_at_us
      ? (int64_t)((aec_signal.window_started_at_us -
                   (uint64_t)state->booted_at_us) /
                  1000U)
      : 0;
  sample->raw_clean_aec_detail.produced_at_ms =
      aec_signal.produced_at_us >= (uint64_t)state->booted_at_us
      ? (int64_t)((aec_signal.produced_at_us -
                   (uint64_t)state->booted_at_us) /
                  1000U)
      : sample->uptime_ms;
  sample->raw_clean_aec_detail.sample_stride =
      aec_signal.signal.sample_stride;
  sample->raw_clean_aec_detail.sampled_samples =
      aec_signal.signal.sampled_samples;
  sample->raw_clean_aec_detail.raw_peak = aec_signal.signal.raw_peak;
  sample->raw_clean_aec_detail.clean_peak =
      aec_signal.signal.clean_peak;
  sample->raw_clean_aec_detail.raw_mean_absolute =
      aec_signal.signal.raw_mean_absolute;
  sample->raw_clean_aec_detail.clean_mean_absolute =
      aec_signal.signal.clean_mean_absolute;
  /*
   * A one-second window is orders of magnitude below INT64_MAX, but keep the
   * conversion explicit because the capability protocol's integer domain is
   * signed. If a future window policy grows without bound, saturation remains
   * observable instead of wrapping a valid magnitude into a negative value.
   */
  sample->raw_clean_aec_detail.raw_absolute_sum =
      aec_signal.signal.raw_absolute_sum > INT64_MAX
      ? INT64_MAX
      : (int64_t)aec_signal.signal.raw_absolute_sum;
  sample->raw_clean_aec_detail.clean_absolute_sum =
      aec_signal.signal.clean_absolute_sum > INT64_MAX
      ? INT64_MAX
      : (int64_t)aec_signal.signal.clean_absolute_sum;
  sample->raw_clean_aec_detail.playback_content_samples =
      aec_signal.signal.playback_content_samples;
  sample->raw_clean_aec_detail.lifetime_capture_frames =
      owner.capture_frames;
  sample->raw_clean_aec_detail.lifetime_clean_uplink_frames =
      owner.clean_uplink_frames;
  sample->raw_clean_aec_detail.lifetime_clean_uplink_drops =
      owner.clean_uplink_drops;
  sample->raw_clean_aec_detail.lifetime_capture_failures =
      owner.capture_failures;
  sample->raw_clean_aec_detail.lifetime_signal_measurement_failures =
      owner.aec_signal_measurement_failures;
  sample->raw_clean_aec_detail.last_capture_to_uplink_us =
      owner.last_capture_to_uplink_us;
  sample->raw_clean_aec_detail.maximum_capture_to_uplink_us =
      owner.maximum_capture_to_uplink_us;

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
  sample->control_diagnostics.network.wifi_connected =
      control.wifi_connected;
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

static enum iterate_kit_status request_uplink_active(
    void *context, bool active) {
  (void)context;
  return iterate_kit_voice_pe_audio_owner_request_uplink_active(active);
}

static void request_playback_reset(void *context) {
  (void)context;
  iterate_kit_voice_pe_audio_owner_request_playback_reset();
}

static void notify_uplink(void *context) {
  struct havpe_runtime *state = context;
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
  struct havpe_runtime *state = context;
  if (state != NULL) {
    iterate_kit_peer_session_ended(&state->device.peer);
  }
}

static bool initialise_rings(struct havpe_runtime *state) {
  return iterate_kit_spsc_ring_init(
             &state->control_inbox,
             control_inbox_storage,
             HAVPE_CONTROL_SLOT_CAPACITY,
             HAVPE_CONTROL_INBOX_SLOTS,
             state->control_inbox_lengths) == ITERATE_KIT_OK &&
      iterate_kit_spsc_ring_init(
             &state->control_outbox,
             control_outbox_storage,
             HAVPE_CONTROL_SLOT_CAPACITY,
             HAVPE_CONTROL_OUTBOX_SLOTS,
             state->control_outbox_lengths) == ITERATE_KIT_OK &&
      iterate_kit_spsc_ring_init(
             &state->pcm_uplink,
             state->pcm_uplink_storage,
             sizeof(state->pcm_uplink_storage[0]),
             HAVPE_PCM_UPLINK_RING_SLOTS,
             state->pcm_uplink_lengths) == ITERATE_KIT_OK &&
      iterate_kit_spsc_ring_init(
             &state->pcm_downlink,
             state->pcm_downlink_storage,
             sizeof(state->pcm_downlink_storage[0]),
             HAVPE_PCM_DOWNLINK_RING_SLOTS,
             state->pcm_downlink_lengths) == ITERATE_KIT_OK &&
      iterate_kit_pcm_lane_init(
             &state->pcm_lane,
             &state->pcm_uplink,
             &state->pcm_downlink) == ITERATE_KIT_OK;
}

static enum iterate_kit_status set_led(
    void *context,
    uint8_t index,
    uint8_t red,
    uint8_t green,
    uint8_t blue) {
  struct havpe_runtime *state = context;
  if (state == NULL || !state->ring_power_enabled ||
      state->leds == NULL || index >= HAVPE_LED_COUNT) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  /*
   * The component owns the WS2812 GRB wire order. Passing semantic RGB here
   * prevents the red/blue inversion previously found on the Stick from
   * becoming a second device-specific API convention.
   */
  if (led_strip_set_pixel(state->leds, index, red, green, blue) != ESP_OK ||
      led_strip_refresh(state->leds) != ESP_OK) {
    return ITERATE_KIT_IO_ERROR;
  }
  const int64_t now_us = esp_timer_get_time();
  if (now_us >= 0) {
    /*
     * A remote capability call must remain visible long enough to prove it,
     * but it cannot permanently erase safety/status feedback. The renderer
     * retakes ownership after this bounded window; invalidating its cache is
     * what makes it redraw even if its semantic state did not change.
     */
    state->ring_manual_override_until_ms =
        (uint64_t)now_us / 1000U + HAVPE_RING_MANUAL_OVERRIDE_MS;
    state->ring_frame_valid = false;
  }
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status fill_leds(
    void *context,
    uint8_t red,
    uint8_t green,
    uint8_t blue) {
  struct havpe_runtime *state = context;
  if (state == NULL || !state->ring_power_enabled ||
      state->leds == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  /*
   * Set the complete logical frame before the one RMT refresh. Refreshing per
   * pixel would hold the cooperative Cap'n Web owner for twelve wire frames
   * and turn an observational light command into avoidable control latency.
   */
  for (uint8_t index = 0U; index < HAVPE_LED_COUNT; ++index) {
    if (led_strip_set_pixel(
            state->leds, index, red, green, blue) != ESP_OK) {
      return ITERATE_KIT_IO_ERROR;
    }
  }
  if (led_strip_refresh(state->leds) != ESP_OK) {
    return ITERATE_KIT_IO_ERROR;
  }
  const int64_t now_us = esp_timer_get_time();
  if (now_us >= 0) {
    state->ring_manual_override_until_ms =
        (uint64_t)now_us / 1000U + HAVPE_RING_MANUAL_OVERRIDE_MS;
    state->ring_frame_valid = false;
  }
  return ITERATE_KIT_OK;
}

static bool write_status_ring(
    struct havpe_runtime *state,
    const struct havpe_ui_rgb pixels[HAVPE_UI_RING_LED_COUNT]) {
  if (state == NULL || !state->ring_power_enabled ||
      state->leds == NULL || pixels == NULL) {
    return false;
  }
  if (state->ring_frame_valid &&
      memcmp(state->ring_frame, pixels, sizeof(state->ring_frame)) == 0) {
    return true;
  }
  /*
   * Twelve pixels are staged and committed with one RMT refresh. At the 20 Hz
   * UI ceiling this is under one percent wire duty and, critically, happens
   * only in the cooperative owner—not in either codec-clocked audio task.
   */
  for (uint8_t index = 0U; index < HAVPE_LED_COUNT; ++index) {
    if (led_strip_set_pixel(
            state->leds,
            index,
            pixels[index].red,
            pixels[index].green,
            pixels[index].blue) != ESP_OK) {
      state->ring_frame_valid = false;
      return false;
    }
  }
  if (led_strip_refresh(state->leds) != ESP_OK) {
    state->ring_frame_valid = false;
    return false;
  }
  memcpy(state->ring_frame, pixels, sizeof(state->ring_frame));
  state->ring_frame_valid = true;
  return true;
}

static void update_status_ring(
    struct havpe_runtime *state, uint64_t now_ms) {
  struct iterate_kit_voice_pe_audio_activity activity = {0U, 0U};
  struct havpe_ring_ui_input input;
  struct havpe_ui_rgb pixels[HAVPE_UI_RING_LED_COUNT];
  wifi_ap_record_t access_point;

  if (state == NULL || now_ms < state->next_ring_refresh_ms) return;
  state->next_ring_refresh_ms = now_ms + HAVPE_RING_REFRESH_MS;

  /*
   * Taking the peak-hold mailboxes on every UI interval is as important as
   * drawing them: a temporary manual LED override must discard old peaks, not
   * reveal a several-second-old voice burst when status rendering resumes.
   */
  iterate_kit_voice_pe_audio_owner_take_activity(&activity);

  if (now_ms >= state->next_ring_network_sample_ms) {
    memset(&access_point, 0, sizeof(access_point));
    state->wifi_observed =
        esp_wifi_sta_get_ap_info(&access_point) == ESP_OK;
    if (state->wifi_observed) state->wifi_rssi_dbm = access_point.rssi;
    state->next_ring_network_sample_ms =
        now_ms + HAVPE_RING_NETWORK_SAMPLE_MS;
  }

  memset(&input, 0, sizeof(input));
  if (!state->wifi_observed) {
    input.network = HAVPE_UI_NETWORK_DISCONNECTED;
  } else if (
      state->control_transport.state == ITERATE_KIT_ESP_IDF_ITX_READY) {
    input.network = HAVPE_UI_NETWORK_CONNECTED;
  } else {
    input.network = HAVPE_UI_NETWORK_CONNECTING;
  }
  input.has_wifi_rssi = state->wifi_observed;
  input.wifi_rssi_dbm = state->wifi_rssi_dbm;
  input.conversation_active =
      iterate_kit_voice_satellite_is_conversation_active(&state->device);
  input.pcm_ready = state->pcm_started &&
      state->pcm_transport.state == ITERATE_KIT_ESP_IDF_PCM_READY;
  input.pcm_failed = state->pcm_started &&
      state->pcm_transport.state == ITERATE_KIT_ESP_IDF_PCM_FAILED;
  input.microphone_peak = activity.microphone_peak;
  input.speaker_peak = activity.speaker_peak;
  input.restart_armed = state->center_button_gesture.restart_armed;

  if (!input.restart_armed &&
      now_ms < state->ring_manual_override_until_ms) {
    return;
  }
  havpe_ring_ui_render(&input, pixels);
  if (!write_status_ring(state, pixels)) {
    if (!state->ring_write_failure_latched) {
      ESP_LOGE(TAG, "status ring write failed");
      state->ring_write_failure_latched = true;
    }
    return;
  }
  if (state->ring_write_failure_latched) {
    ESP_LOGI(TAG, "status ring write recovered");
    state->ring_write_failure_latched = false;
  }
}

static bool initialise_leds(struct havpe_runtime *state) {
  const gpio_config_t power = {
    .pin_bit_mask = UINT64_C(1) << HAVPE_LED_POWER_GPIO,
    .mode = GPIO_MODE_OUTPUT,
    .pull_up_en = GPIO_PULLUP_DISABLE,
    .pull_down_en = GPIO_PULLDOWN_DISABLE,
    .intr_type = GPIO_INTR_DISABLE,
  };
  const led_strip_config_t strip = {
    .strip_gpio_num = HAVPE_LED_GPIO,
    .max_leds = HAVPE_LED_COUNT,
    .led_model = LED_MODEL_WS2812,
    .led_pixel_format = LED_PIXEL_FORMAT_GRB,
    .flags = {.invert_out = false},
  };
  const led_strip_rmt_config_t rmt = {
    .clk_src = RMT_CLK_SRC_DEFAULT,
    .resolution_hz = 10U * 1000U * 1000U,
    .mem_block_symbols = 64U,
    .flags = {.with_dma = false},
  };
  if (state == NULL || gpio_config(&power) != ESP_OK ||
      gpio_set_level(HAVPE_LED_POWER_GPIO, 1) != ESP_OK) {
    return false;
  }
  /*
   * GPIO21 is only the WS2812 data line. The official HAVPE hardware gates
   * the ring's supply on GPIO45; RMT happily reports successful writes while
   * that rail is off, which is exactly how the first implementation mounted
   * a healthy capability yet looked physically dead. Keep the rail on for
   * this status UI and honour ESPHome's first-party 20 ms enable time before
   * the first wire transaction. This bounded boot-only delay never executes
   * in an audio task or while a call is active.
   */
  state->ring_power_enabled = true;
  vTaskDelay(pdMS_TO_TICKS(HAVPE_LED_POWER_ENABLE_MS));
  if (led_strip_new_rmt_device(&strip, &rmt, &state->leds) != ESP_OK) {
    state->ring_power_enabled = false;
    (void)gpio_set_level(HAVPE_LED_POWER_GPIO, 0);
    return false;
  }
  if (led_strip_clear(state->leds) != ESP_OK) {
    state->ring_power_enabled = false;
    (void)gpio_set_level(HAVPE_LED_POWER_GPIO, 0);
    return false;
  }
  ESP_LOGI(
      TAG,
      "status ring power enabled: gpio=%d settle_ms=%u",
      (int)HAVPE_LED_POWER_GPIO,
      (unsigned)HAVPE_LED_POWER_ENABLE_MS);
  return true;
}

static bool initialise_center_button(struct havpe_runtime *state) {
  const gpio_config_t input = {
    .pin_bit_mask = UINT64_C(1) << HAVPE_CENTER_BUTTON_GPIO,
    .mode = GPIO_MODE_INPUT,
    .pull_up_en = GPIO_PULLUP_ENABLE,
    .pull_down_en = GPIO_PULLDOWN_DISABLE,
    .intr_type = GPIO_INTR_DISABLE,
  };
  const int64_t now_us = esp_timer_get_time();
  bool initially_pressed;

  if (state == NULL || now_us < 0 || gpio_config(&input) != ESP_OK) {
    return false;
  }
  /*
   * First-party HAVPE hardware declares GPIO0 active-low. Sampling after the
   * pull-up is configured makes a button held across boot the baseline rather
   * than an unsolicited conversation start. Later presses publish through the
   * same portable event queue as `conversation.start()` / `hangUp()`.
   */
  initially_pressed = gpio_get_level(HAVPE_CENTER_BUTTON_GPIO) == 0;
  const uint64_t now_ms = (uint64_t)now_us / 1000U;
  if (iterate_kit_debounced_button_init(
          &state->center_button,
          initially_pressed,
          HAVPE_CENTER_BUTTON_DEBOUNCE_MS,
          now_ms) != ITERATE_KIT_OK) {
    return false;
  }
  havpe_center_button_gesture_init(
      &state->center_button_gesture, initially_pressed, now_ms);
  return true;
}

static void poll_center_button(
    struct havpe_runtime *state, uint64_t now_ms) {
  bool pressed_edge = false;
  bool released_edge = false;
  enum havpe_center_button_action action;
  enum iterate_kit_status status;

  if (state == NULL) return;
  status = iterate_kit_debounced_button_update(
      &state->center_button,
      gpio_get_level(HAVPE_CENTER_BUTTON_GPIO) == 0,
      now_ms,
      &pressed_edge,
      &released_edge);
  if (status != ITERATE_KIT_OK) {
    ESP_LOGE(TAG, "center button poll failed: status=%d", (int)status);
    return;
  }
  action = havpe_center_button_gesture_update(
      &state->center_button_gesture,
      pressed_edge,
      released_edge,
      now_ms,
      HAVPE_CENTER_BUTTON_RESTART_HOLD_MS);
  if (action == HAVPE_CENTER_BUTTON_ACTION_RESTART_ARMED) {
    /* The magenta whole-ring state remains visible until the finger lifts. */
    state->ring_frame_valid = false;
    ESP_LOGW(TAG, "center button restart armed; release to restart");
    return;
  }
  if (action == HAVPE_CENTER_BUTTON_ACTION_RESTART) {
    /*
     * GPIO0 has now been stably high for the debounce interval. Restarting on
     * the earlier hold threshold could instead enter the ROM bootloader.
     */
    ESP_LOGW(TAG, "center button released; restarting");
    esp_restart();
    return;
  }
  if (action != HAVPE_CENTER_BUTTON_ACTION_TOGGLE_CONVERSATION) return;

  /*
   * HAVPE is a full-duplex server-VAD device: one short center-button gesture
   * opens a continuous AEC-clean microphone conversation and the next closes
   * it. Publishing intent (instead of opening /pcm here) preserves one state
   * machine for physical input, RPC tests, and transport recovery. The toggle
   * occurs on release so a long hold cannot first open a call and then reboot.
   */
  status = iterate_kit_voice_satellite_publish_conversation(
      &state->device,
      !iterate_kit_voice_satellite_is_conversation_active(&state->device),
      ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL);
  if (status != ITERATE_KIT_OK) {
    ESP_LOGE(
        TAG,
        "physical conversation publish failed: status=%d",
        (int)status);
  }
}

static bool initialise_device(struct havpe_runtime *state) {
  struct iterate_kit_voice_satellite_options device_options;
  struct iterate_kit_audio_intent_ops audio_ops;
  struct iterate_kit_voice_satellite_control_driver control_driver;

  /*
   * HAVPE exposes only hardware it really owns. Screen/camera/servo methods
   * are absent from this profile; the twelve-pixel ring is the smallest useful
   * physical capability and doubles as an unattended remote-call oracle.
   */
  if (!initialise_leds(state)) {
    return false;
  }

  memset(&device_options, 0, sizeof(device_options));
  device_options.manifest = &DEVICE_MANIFEST;
  device_options.leds = (struct iterate_kit_led_driver){
    .context = state,
    .set = set_led,
    .fill = fill_leds,
  };
  device_options.led_count = HAVPE_LED_COUNT;
  device_options.playback_interruption =
      (struct iterate_kit_conversation_playback_interruption_driver){
        .context = NULL,
        .request =
            iterate_kit_voice_pe_audio_owner_request_playback_interruption,
        .poll =
            iterate_kit_voice_pe_audio_owner_poll_playback_interruption,
        .acknowledgement_timeout_ms =
            HAVPE_PLAYBACK_INTERRUPTION_ACK_TIMEOUT_MS,
      };
  device_options.metrics.session = &state->connection.session;
  device_options.metrics.driver.context = state;
  device_options.metrics.driver.sample = sample_runtime_metrics;
  device_options.metrics.subscriptions = state->subscriptions;
  device_options.metrics.subscription_count =
      HAVPE_METRICS_SUBSCRIPTION_CAPACITY;
  device_options.metrics.interval_ms = 1000U;
  device_options.metrics.enable_aec_view = false;
  /*
   * XMOS exposes exact same-time raw and post-AEC microphones, but not its
   * private reference. Mount the shared method with the discriminated two-tap
   * schema: callers receive real amplitudes plus same-window physical playback
   * activity, never a zero or intended-PCM value disguised as the reference.
   */
  device_options.metrics.enable_raw_clean_aec_view = true;
  device_options.metrics.diagnostics_expression_buffer =
      state->diagnostics_expression;
  device_options.metrics.diagnostics_expression_capacity =
      sizeof(state->diagnostics_expression);
  if (iterate_kit_voice_satellite_init(
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
  control_driver = (struct iterate_kit_voice_satellite_control_driver){
    .handler = {
      .context = &state->audio_intent,
      .handle = iterate_kit_audio_intent_reconciler_handle,
    },
    .observer = {
      .context = state,
      .observe = observe_device_event,
    },
  };
  return iterate_kit_voice_satellite_bind_control_driver(
             &state->device, &control_driver) == ITERATE_KIT_OK;
}

static bool initialise_connections(struct havpe_runtime *state) {
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
  pcm_options.device_id = "home-assistant-voice-preview-edition";
  pcm_options.audio_mode = ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC;
  pcm_options.lane = &state->pcm_lane;
  pcm_options.downlink_generation_barrier =
      iterate_kit_voice_pe_audio_owner_downlink_generation_barrier;
  /*
   * HAVPE playback is already clocked every 8 ms. A downlink notification
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
  connection_options.pending_call_count = HAVPE_PENDING_CALL_CAPACITY;
  connection_options.exports = state->exports;
  connection_options.export_count = HAVPE_EXPORT_CAPACITY;
  connection_options.imports = state->imports;
  connection_options.import_count = HAVPE_IMPORT_CAPACITY;
  connection_options.tokens = state->tokens;
  connection_options.token_count = HAVPE_TOKEN_CAPACITY;
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
      iterate_kit_voice_satellite_capability(&state->device);
  connection_options.session_ended = device_session_ended;
  connection_options.session_ended_context = state;
  return iterate_kit_itx_connection_init(
             &state->connection, &connection_options) == CAPNWEB_OK;
}

static void reconcile_pcm_conversation(struct havpe_runtime *state) {
  const bool active =
      iterate_kit_voice_satellite_is_conversation_active(&state->device);

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
  struct iterate_kit_voice_pe_audio_owner_options audio_options;
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
      !initialise_center_button(&runtime) ||
      !initialise_connections(&runtime)) {
    ESP_LOGE(TAG, "bounded target initialization failed");
    return;
  }

  memset(&audio_options, 0, sizeof(audio_options));
  audio_options.lane = &runtime.pcm_lane;
  audio_options.maximum_downlink_frame_age_ms =
      HAVPE_MAXIMUM_DOWNLINK_FRAME_AGE_MS;
  audio_options.maximum_lane_items_per_playback_edge =
      HAVPE_MAXIMUM_LANE_ITEMS_PER_PLAYBACK_EDGE;
  audio_options.notify_uplink = notify_uplink;
  audio_options.notify_uplink_context = &runtime;
  if (iterate_kit_voice_pe_audio_owner_start(&audio_options) != ESP_OK) {
    ESP_LOGE(TAG, "HAVPE audio owner failed to start");
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
    const uint64_t now_ms = now_us < 0 ? 0U : (uint64_t)now_us / 1000U;
    /* Admit a human edge before the bounded device/event owner runs. */
    poll_center_button(&runtime, now_ms);
    struct iterate_kit_poll_result device_poll =
        iterate_kit_voice_satellite_poll(
            &runtime.device, now_ms);
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
        HAVPE_CONTROL_MESSAGES_PER_POLL);
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
    update_status_ring(&runtime, now_ms);
    /*
     * Audio owners are already blocked on physical codec/DMA clocks at higher
     * priority. This sleep only bounds cooperative Cap'n Web/control latency
     * and lets both idle tasks run; no PCM frame waits for this loop.
     */
    vTaskDelay(pdMS_TO_TICKS(HAVPE_MAIN_LOOP_DELAY_MS));
  }
}
