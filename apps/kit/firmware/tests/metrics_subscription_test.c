#include "iterate/kit/capabilities/metrics.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum {
  TOKEN_CAPACITY = 128,
  CALL_CAPACITY = 8,
  OUTPUT_CAPACITY = 64,
  CAPTURE_CAPACITY = 16,
  MESSAGE_CAPACITY = 2048,
  MAXIMUM_OWNER_LOOP_CONTROL_BURST = 8,
};

static void test_assert(
    bool condition,
    const char *expression,
    const char *file,
    int line) {
  if (condition) {
    return;
  }
  fprintf(stderr, "%s:%d: assertion failed: %s\n", file, line, expression);
  abort();
}

#define assert(expression) \
  test_assert((expression), #expression, __FILE__, __LINE__)

struct fixture {
  struct capnweb_session session;
  struct capnweb_json_token tokens[TOKEN_CAPACITY];
  struct capnweb_pending_call pending_calls[CALL_CAPACITY];
  struct capnweb_export exports[CALL_CAPACITY];
  struct capnweb_import imports[CALL_CAPACITY];
  char output_buffer[OUTPUT_CAPACITY];
  char captured[CAPTURE_CAPACITY][MESSAGE_CAPACITY];
  size_t captured_lengths[CAPTURE_CAPACITY];
  size_t capture_limit;
  size_t captured_count;
  bool message_open;
  struct iterate_kit_metrics metrics;
  struct iterate_kit_metrics_subscription subscriptions[3];
  struct iterate_kit_callback_budget callback_budget;
  char diagnostics_expression
      [ITERATE_KIT_METRICS_DIAGNOSTICS_EXPRESSION_CAPACITY];
  struct iterate_kit_module module;
  size_t dispatch_method_index;
  bool maximum_metrics;
  bool include_playback;
  bool include_aec;
  bool include_avatar;
  bool include_raw_clean_aec;
  bool include_buffers;
  bool include_control_diagnostics;
  bool invalid_buffer_evidence;
  bool wifi_connected;
  bool has_wifi_rssi_dbm;
  int32_t wifi_rssi_dbm;
};

static enum capnweb_status capture_fragment(
    void *context,
    enum capnweb_text_fragment_kind kind,
    const char *data,
    size_t length) {
  struct fixture *fixture = context;
  size_t *captured_length;
  if (kind == CAPNWEB_TEXT_BEGIN) {
    if (fixture->message_open ||
        fixture->captured_count >= fixture->capture_limit) {
      return CAPNWEB_E_STATE;
    }
    fixture->message_open = true;
    fixture->captured_lengths[fixture->captured_count] = 0U;
    return CAPNWEB_OK;
  }
  if (kind == CAPNWEB_TEXT_DATA) {
    if (!fixture->message_open ||
        data == NULL ||
        length == 0U) {
      return CAPNWEB_E_STATE;
    }
    captured_length =
        &fixture->captured_lengths[fixture->captured_count];
    if (length >= MESSAGE_CAPACITY ||
        *captured_length >= MESSAGE_CAPACITY - length) {
      return CAPNWEB_E_LIMIT;
    }
    memcpy(
        fixture->captured[fixture->captured_count] + *captured_length,
        data,
        length);
    *captured_length += length;
    return CAPNWEB_OK;
  }
  if (kind == CAPNWEB_TEXT_END) {
    if (!fixture->message_open) {
      return CAPNWEB_E_STATE;
    }
    captured_length =
        &fixture->captured_lengths[fixture->captured_count];
    fixture->captured[fixture->captured_count][*captured_length] = '\0';
    fixture->captured_count++;
    fixture->message_open = false;
    return CAPNWEB_OK;
  }
  return CAPNWEB_E_INVALID_ARGUMENT;
}

static enum iterate_kit_status sample_metrics(
    void *context, struct iterate_kit_metrics_sample *sample) {
  const struct fixture *fixture = context;
  const struct iterate_kit_buffer_metrics maximum_observed_buffer = {
    ITERATE_KIT_BUFFER_OBSERVED,
    UINT32_MAX,
    UINT32_MAX,
    UINT32_MAX,
  };
  const int64_t uptime =
      fixture->maximum_metrics ? INT64_MAX : 1;
  const uint32_t maximum_counter =
      fixture->maximum_metrics ? UINT32_MAX : 0U;
  *sample = (struct iterate_kit_metrics_sample){
    uptime,
    fixture->maximum_metrics ? UINT32_MAX : 2U,
    fixture->maximum_metrics ? UINT32_MAX : 3U,
    fixture->maximum_metrics ? UINT32_MAX : 4U,
    fixture->maximum_metrics ? UINT32_MAX : 5U,
    fixture->maximum_metrics ? UINT32_MAX : 6U,
    fixture->maximum_metrics ? UINT32_MAX : 7U,
    fixture->maximum_metrics ? INT64_C(1000) : 8,
    true,
    {
      {
        fixture->maximum_metrics ? UINT32_MAX : 9U,
        fixture->maximum_metrics ? UINT32_MAX : 10U,
        fixture->maximum_metrics ? UINT32_MAX : 11U,
      },
      {
        fixture->maximum_metrics ? UINT32_MAX : 12U,
        fixture->maximum_metrics ? UINT32_MAX : 13U,
        fixture->maximum_metrics ? UINT32_MAX : 14U,
        fixture->maximum_metrics ? UINT32_MAX : 15U,
        fixture->maximum_metrics ? UINT32_MAX : 16U,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        NULL,
        0,
      },
      {
        fixture->maximum_metrics ? UINT32_MAX : 17U,
        fixture->maximum_metrics ? UINT32_MAX : 18U,
        fixture->maximum_metrics ? UINT32_MAX : 19U,
        fixture->maximum_metrics ? UINT32_MAX : 20U,
        fixture->maximum_metrics ? UINT32_MAX : 21U,
      },
      {
        fixture->maximum_metrics ? UINT32_MAX : 22U,
        fixture->maximum_metrics ? UINT32_MAX : 23U,
        fixture->maximum_metrics ? UINT32_MAX : 24U,
        fixture->maximum_metrics ? UINT32_MAX : 25U,
        fixture->maximum_metrics ? UINT32_MAX : 26U,
        fixture->maximum_metrics ? UINT32_MAX : 27U,
      },
      fixture->maximum_metrics ? UINT32_MAX : 28U,
      false,
      {0},
      false,
    },
    false,
    {0},
    false,
    {0},
    false,
    {0},
    false,
    {0},
    false,
    {0},
    0U,
  };
  sample->audio.uplink.send_deferrals =
      fixture->maximum_metrics ? maximum_counter : 29U;
  sample->audio.uplink.consecutive_send_deferrals =
      fixture->maximum_metrics ? maximum_counter : 30U;
  sample->audio.uplink.maximum_consecutive_send_deferrals =
      fixture->maximum_metrics ? maximum_counter : 31U;
  sample->audio.uplink.restart_incidents =
      fixture->maximum_metrics ? maximum_counter : 32U;
  sample->audio.uplink.in_place_freshness_recoveries =
      fixture->maximum_metrics ? maximum_counter : 42U;
  sample->audio.uplink.socket_restarts =
      fixture->maximum_metrics ? maximum_counter : 43U;
  sample->audio.uplink.producer_backpressure_restarts =
      fixture->maximum_metrics ? maximum_counter : 33U;
  sample->audio.uplink.transport_disconnect_restarts =
      fixture->maximum_metrics ? maximum_counter : 34U;
  sample->audio.uplink.no_progress_timeout_restarts =
      fixture->maximum_metrics ? maximum_counter : 35U;
  sample->audio.uplink.frame_send_timeout_restarts =
      fixture->maximum_metrics ? maximum_counter : 36U;
  sample->audio.uplink.capture_stale_restarts =
      fixture->maximum_metrics ? maximum_counter : 37U;
  sample->audio.uplink.last_transport_accept_age_ms =
      fixture->maximum_metrics ? maximum_counter : 38U;
  sample->audio.uplink.maximum_transport_accept_age_ms =
      fixture->maximum_metrics ? maximum_counter : 39U;
  sample->audio.uplink.last_restart_oldest_capture_age_ms =
      fixture->maximum_metrics ? maximum_counter : 40U;
  sample->audio.uplink.last_restart_reason =
      fixture->maximum_metrics
          ? "transport_disconnected"
          : "capture_stale";
  sample->audio.uplink.last_restart_frames_discarded =
      fixture->maximum_metrics ? maximum_counter : 41U;
  sample->subscription_callback_rejections =
      fixture->maximum_metrics ? maximum_counter : 44U;
  sample->audio.has_buffers = fixture->include_buffers;
  sample->audio.has_playback = fixture->include_playback;
  sample->audio.buffers.uplink_application.evidence =
      ITERATE_KIT_BUFFER_OBSERVED;
  sample->audio.buffers.uplink_application.current_bytes =
      fixture->maximum_metrics ? UINT32_MAX : 42U;
  sample->audio.buffers.uplink_application.high_water_bytes =
      fixture->maximum_metrics ? UINT32_MAX : 43U;
  sample->audio.buffers.uplink_application.capacity_bytes =
      fixture->maximum_metrics ? UINT32_MAX : 44U;
  sample->audio.buffers.websocket_transmitter.evidence =
      ITERATE_KIT_BUFFER_OBSERVED;
  sample->audio.buffers.websocket_transmitter.current_bytes =
      fixture->maximum_metrics ? UINT32_MAX : 45U;
  sample->audio.buffers.websocket_transmitter.high_water_bytes =
      fixture->maximum_metrics ? UINT32_MAX : 46U;
  sample->audio.buffers.websocket_transmitter.capacity_bytes =
      fixture->maximum_metrics ? UINT32_MAX : 47U;
  sample->audio.buffers.lwip_send.evidence =
      ITERATE_KIT_BUFFER_CAPACITY_ONLY;
  sample->audio.buffers.lwip_send.capacity_bytes =
      fixture->maximum_metrics ? UINT32_MAX : 48U;
  sample->audio.buffers.tls_egress.evidence =
      ITERATE_KIT_BUFFER_UNAVAILABLE;
  sample->audio.buffers.wifi_egress.evidence =
      ITERATE_KIT_BUFFER_UNAVAILABLE;
  if (fixture->maximum_metrics) {
    /*
     * TLS and Wi-Fi occupancy are unavailable today, but making them exactly
     * observable must not turn a valid future sample into an oversized Cap'n
     * Web message. Model the strongest and longest representation for every
     * layer instead of letting today's ESP-IDF limitations make this budget
     * test accidentally optimistic.
     */
    sample->audio.buffers.uplink_application =
        maximum_observed_buffer;
    sample->audio.buffers.websocket_transmitter =
        maximum_observed_buffer;
    sample->audio.buffers.lwip_send = maximum_observed_buffer;
    sample->audio.buffers.tls_egress = maximum_observed_buffer;
    sample->audio.buffers.wifi_egress = maximum_observed_buffer;
  }
  if (fixture->invalid_buffer_evidence) {
    sample->audio.buffers.wifi_egress.evidence =
        (enum iterate_kit_buffer_metric_evidence)99;
  }
  sample->has_playback_detail = true;
  sample->playback_detail.schema_version = 5U;
  sample->playback_detail.sequence =
      fixture->maximum_metrics ? UINT32_MAX : 52U;
  sample->playback_detail.produced_at_ms =
      fixture->maximum_metrics ? INT64_MAX : 53;
  sample->playback_detail.downlink_accepted =
      fixture->maximum_metrics ? UINT32_MAX : 54U;
  sample->playback_detail.playback.frames_dequeued =
      fixture->maximum_metrics ? UINT32_MAX : 55U;
  sample->playback_detail.playback.submitted =
      fixture->maximum_metrics ? UINT32_MAX : 56U;
  sample->playback_detail.playback.completed =
      fixture->maximum_metrics ? UINT32_MAX : 57U;
  sample->playback_detail.playback.underrun_incidents =
      fixture->maximum_metrics ? UINT32_MAX : 58U;
  sample->playback_detail.playback
      .underrun_silence_frames_submitted =
      fixture->maximum_metrics ? UINT32_MAX : 59U;
  sample->playback_detail.playback
      .underrun_silence_frames_completed =
      fixture->maximum_metrics ? UINT32_MAX : 60U;
  sample->playback_detail.playback
      .underrun_silence_frames_retired =
      fixture->maximum_metrics ? UINT32_MAX : 61U;
  sample->playback_detail.playback
      .underrun_late_frames_dropped =
      fixture->maximum_metrics ? UINT32_MAX : 62U;
  sample->playback_detail.playback
      .write_backpressure_destructive_resets =
      fixture->maximum_metrics ? UINT32_MAX : 62U;
  sample->playback_detail.playback
      .successful_refill_timing_samples =
      fixture->maximum_metrics ? UINT32_MAX : 63U;
  sample->playback_detail.playback.receive_to_dma_start_samples =
      fixture->maximum_metrics ? UINT32_MAX : 64U;
  sample->playback_detail.playback.maximum_receive_to_dma_start_ms =
      fixture->maximum_metrics ? UINT32_MAX : 65U;
  sample->playback_detail.playback.downlink_interarrival_samples =
      fixture->maximum_metrics ? UINT32_MAX : 66U;
  sample->playback_detail.playback.maximum_downlink_interarrival_ms =
      fixture->maximum_metrics ? UINT32_MAX : 67U;
  sample->playback_detail.playback
      .maximum_eof_to_successful_refill_us =
      fixture->maximum_metrics ? UINT32_MAX : 61U;
  sample->playback_detail.playback
      .maximum_write_call_duration_us =
      fixture->maximum_metrics ? UINT32_MAX : 62U;
  sample->playback_detail.playback
      .minimum_reuse_lead_at_successful_refill_us =
      fixture->maximum_metrics ? UINT32_MAX : 63U;
  sample->playback_detail.runtime.audio_owner_stack_headroom_bytes =
      fixture->maximum_metrics ? UINT32_MAX : 64U;
  sample->playback_detail.runtime.free_internal_heap_bytes =
      fixture->maximum_metrics ? UINT32_MAX : 65U;
  sample->playback_detail.runtime.cpu_permille =
      fixture->maximum_metrics ? INT64_C(1000) : 66;
  sample->playback_detail.runtime
      .generation_fence_acknowledgement_timeouts =
      fixture->maximum_metrics ? UINT32_MAX : 67U;
  sample->playback_detail.runtime
      .lifecycle_acknowledgement_timeouts =
      fixture->maximum_metrics ? UINT32_MAX : 68U;
  sample->playback_detail.runtime.pcm_receive_calls =
      fixture->maximum_metrics ? UINT32_MAX : 69U;
  sample->playback_detail.runtime.pcm_receive_chunks =
      fixture->maximum_metrics ? UINT32_MAX : 70U;
  sample->playback_detail.runtime.control_network_max_work_cycles =
      fixture->maximum_metrics ? UINT32_MAX : 71U;
  sample->playback_detail.runtime.pcm_network_max_work_cycles =
      fixture->maximum_metrics ? UINT32_MAX : 72U;
  sample->has_aec_detail = fixture->include_aec;
  sample->aec_detail.schema_version = 3U;
  sample->aec_detail.sequence =
      fixture->maximum_metrics ? UINT32_MAX : 73U;
  sample->aec_detail.window_started_at_ms =
      fixture->maximum_metrics ? INT64_MAX : 74;
  sample->aec_detail.produced_at_ms =
      fixture->maximum_metrics ? INT64_MAX : 75;
  sample->aec_detail.sample_stride =
      fixture->maximum_metrics ? UINT32_MAX : 8U;
  sample->aec_detail.sampled_samples =
      fixture->maximum_metrics ? UINT32_MAX : 2000U;
  sample->aec_detail.near_peak =
      fixture->maximum_metrics ? UINT32_MAX : 12000U;
  sample->aec_detail.reference_peak =
      fixture->maximum_metrics ? UINT32_MAX : 9000U;
  sample->aec_detail.linear_peak =
      fixture->maximum_metrics ? UINT32_MAX : 4000U;
  sample->aec_detail.clean_peak =
      fixture->maximum_metrics ? UINT32_MAX : 5000U;
  sample->aec_detail.near_mean_absolute =
      fixture->maximum_metrics ? UINT32_MAX : 1100U;
  sample->aec_detail.reference_mean_absolute =
      fixture->maximum_metrics ? UINT32_MAX : 800U;
  sample->aec_detail.linear_mean_absolute =
      fixture->maximum_metrics ? UINT32_MAX : 500U;
  sample->aec_detail.clean_mean_absolute =
      fixture->maximum_metrics ? UINT32_MAX : 250U;
  sample->aec_detail.lifetime_frames_processed =
      fixture->maximum_metrics ? UINT32_MAX : 76U;
  sample->aec_detail.lifetime_recreates =
      fixture->maximum_metrics ? UINT32_MAX : 77U;
  sample->aec_detail.lifetime_recreate_failures =
      fixture->maximum_metrics ? UINT32_MAX : 78U;
  sample->aec_detail.last_linear_us =
      fixture->maximum_metrics ? UINT32_MAX : 79U;
  sample->aec_detail.maximum_linear_us =
      fixture->maximum_metrics ? UINT32_MAX : 80U;
  sample->aec_detail.last_nlp_us =
      fixture->maximum_metrics ? UINT32_MAX : 81U;
  sample->aec_detail.maximum_nlp_us =
      fixture->maximum_metrics ? UINT32_MAX : 82U;
  sample->aec_detail.last_capture_to_uplink_us =
      fixture->maximum_metrics ? UINT32_MAX : 83U;
  sample->aec_detail.maximum_capture_to_uplink_us =
      fixture->maximum_metrics ? UINT32_MAX : 84U;
  sample->aec_detail.lifetime_capture_reserve_dropped_chunks =
      fixture->maximum_metrics ? UINT32_MAX : 85U;
  sample->aec_detail.lifetime_capture_bridge_errors =
      fixture->maximum_metrics ? UINT32_MAX : 86U;
  sample->aec_detail.lifetime_signal_measurement_failures =
      fixture->maximum_metrics ? UINT32_MAX : 87U;
  sample->aec_detail.playback_health.lifetime_content_samples =
      fixture->maximum_metrics ? UINT32_MAX : 88U;
  sample->aec_detail.playback_health.lifetime_resets =
      fixture->maximum_metrics ? UINT32_MAX : 89U;
  sample->aec_detail.playback_health
      .lifetime_frames_discarded_by_reset =
      fixture->maximum_metrics ? UINT32_MAX : 90U;
  sample->aec_detail.playback_health.lifetime_write_failures =
      fixture->maximum_metrics ? UINT32_MAX : 91U;
  sample->aec_detail.playback_health.lifetime_queue_overflows =
      fixture->maximum_metrics ? UINT32_MAX : 92U;
  sample->aec_detail.playback_health.lifetime_policy_errors =
      fixture->maximum_metrics ? UINT32_MAX : 93U;
  sample->aec_detail.playback_health.lifetime_reset_failures =
      fixture->maximum_metrics ? UINT32_MAX : 94U;
  sample->aec_detail.playback_health.lifetime_observation_failures =
      fixture->maximum_metrics ? UINT32_MAX : 95U;
  sample->aec_detail.playback_health.lifetime_underrun_incidents =
      fixture->maximum_metrics ? UINT32_MAX : 96U;
  sample->aec_detail.playback_health.lifetime_underrun_silence_samples =
      fixture->maximum_metrics ? UINT32_MAX : 97U;
  sample->aec_detail.playback_health.lifetime_stale_frames_discarded =
      fixture->maximum_metrics ? UINT32_MAX : 98U;
  sample->aec_detail.playback_health.last_write_us =
      fixture->maximum_metrics ? UINT32_MAX : 99U;
  sample->aec_detail.playback_health.maximum_write_us =
      fixture->maximum_metrics ? UINT32_MAX : 100U;
  sample->aec_detail.playback_health.last_receive_to_render_ms =
      fixture->maximum_metrics ? UINT32_MAX : 101U;
  sample->aec_detail.playback_health.maximum_receive_to_render_ms =
      fixture->maximum_metrics ? UINT32_MAX : 102U;
  sample->has_avatar_detail = fixture->include_avatar;
  sample->avatar_detail.schema_version = 1U;
  sample->avatar_detail.produced_at_ms =
      fixture->maximum_metrics ? INT64_MAX : 88;
  sample->avatar_detail.ready = true;
  sample->avatar_detail.playout_observations = maximum_counter;
  sample->avatar_detail.malformed_observations = maximum_counter;
  sample->avatar_detail.mailbox_overwrites = maximum_counter;
  sample->avatar_detail.mailbox_failures = maximum_counter;
  sample->avatar_detail.analyzer_frames = maximum_counter;
  sample->avatar_detail.analyzer_sequence_gaps = maximum_counter;
  sample->avatar_detail.mouth_open_rendered_frames = maximum_counter;
  sample->avatar_detail.snapshot_races = maximum_counter;
  sample->avatar_detail.rendered_frames = maximum_counter;
  sample->avatar_detail.render_failures = maximum_counter;
  sample->avatar_detail.display_transfers = maximum_counter;
  sample->avatar_detail.display_transfer_failures = maximum_counter;
  sample->avatar_detail.display_transfer_timeouts = maximum_counter;
  sample->avatar_detail.maximum_handoff_delay_us = maximum_counter;
  sample->avatar_detail.maximum_analyzer_us = maximum_counter;
  sample->avatar_detail.maximum_render_us = maximum_counter;
  sample->avatar_detail.maximum_display_transfer_us = maximum_counter;
  sample->avatar_detail.analyzer_stack_minimum_free_bytes =
      maximum_counter;
  sample->avatar_detail.physical_playout_sample_clock = maximum_counter;
  sample->avatar_detail.current_avatar_index = maximum_counter;
  sample->avatar_detail.framebuffer_bytes = maximum_counter;
  sample->has_raw_clean_aec_detail = fixture->include_raw_clean_aec;
  sample->raw_clean_aec_detail.schema_version = 4U;
  sample->raw_clean_aec_detail.sequence =
      fixture->maximum_metrics ? UINT32_MAX : 88U;
  sample->raw_clean_aec_detail.window_started_at_ms =
      fixture->maximum_metrics ? INT64_MAX : 89;
  sample->raw_clean_aec_detail.produced_at_ms =
      fixture->maximum_metrics ? INT64_MAX : 90;
  sample->raw_clean_aec_detail.sample_stride =
      fixture->maximum_metrics ? UINT32_MAX : 8U;
  sample->raw_clean_aec_detail.sampled_samples =
      fixture->maximum_metrics ? UINT32_MAX : 2000U;
  sample->raw_clean_aec_detail.raw_peak =
      fixture->maximum_metrics ? UINT32_MAX : 12000U;
  sample->raw_clean_aec_detail.clean_peak =
      fixture->maximum_metrics ? UINT32_MAX : 5000U;
  sample->raw_clean_aec_detail.raw_mean_absolute =
      fixture->maximum_metrics ? UINT32_MAX : 1100U;
  sample->raw_clean_aec_detail.clean_mean_absolute =
      fixture->maximum_metrics ? UINT32_MAX : 250U;
  sample->raw_clean_aec_detail.raw_absolute_sum =
      fixture->maximum_metrics ? INT64_MAX : 2200000;
  sample->raw_clean_aec_detail.clean_absolute_sum =
      fixture->maximum_metrics ? INT64_MAX : 500000;
  sample->raw_clean_aec_detail.playback_content_samples =
      fixture->maximum_metrics ? UINT32_MAX : 48000U;
  sample->raw_clean_aec_detail.lifetime_capture_frames =
      fixture->maximum_metrics ? UINT32_MAX : 91U;
  sample->raw_clean_aec_detail.lifetime_clean_uplink_frames =
      fixture->maximum_metrics ? UINT32_MAX : 92U;
  sample->raw_clean_aec_detail.lifetime_clean_uplink_drops =
      fixture->maximum_metrics ? UINT32_MAX : 93U;
  sample->raw_clean_aec_detail.lifetime_capture_failures =
      fixture->maximum_metrics ? UINT32_MAX : 94U;
  sample->raw_clean_aec_detail.lifetime_signal_measurement_failures =
      fixture->maximum_metrics ? UINT32_MAX : 95U;
  sample->raw_clean_aec_detail.last_capture_to_uplink_us =
      fixture->maximum_metrics ? UINT32_MAX : 96U;
  sample->raw_clean_aec_detail.maximum_capture_to_uplink_us =
      fixture->maximum_metrics ? UINT32_MAX : 97U;
  sample->raw_clean_aec_detail.playback_health =
      sample->aec_detail.playback_health;
  sample->has_control_diagnostics =
      fixture->include_control_diagnostics;
  sample->control_diagnostics.schema_version = 4U;
  sample->control_diagnostics.produced_at_ms = uptime;
  sample->control_diagnostics.websocket_start_attempts =
      fixture->maximum_metrics ? UINT32_MAX : 73U;
  sample->control_diagnostics.websocket_connections =
      fixture->maximum_metrics ? UINT32_MAX : 74U;
  sample->control_diagnostics.websocket_disconnects =
      fixture->maximum_metrics ? UINT32_MAX : 75U;
  sample->control_diagnostics.websocket_errors =
      fixture->maximum_metrics ? UINT32_MAX : 76U;
  sample->control_diagnostics.wifi_disconnects =
      fixture->maximum_metrics ? UINT32_MAX : 77U;
  sample->control_diagnostics.protocol_failures =
      fixture->maximum_metrics ? UINT32_MAX : 78U;
  sample->control_diagnostics.control_receive_failures =
      fixture->maximum_metrics ? UINT32_MAX : 79U;
  sample->control_diagnostics.control_send_failures =
      fixture->maximum_metrics ? UINT32_MAX : 80U;
  sample->control_diagnostics.last_wifi_disconnect_reason =
      fixture->maximum_metrics ? INT32_MIN : 81;
  sample->control_diagnostics.last_websocket_error_generation =
      fixture->maximum_metrics ? UINT32_MAX : 82U;
  sample->control_diagnostics.last_websocket_error_type = 2;
  sample->control_diagnostics.last_websocket_tls_error =
      fixture->maximum_metrics ? INT32_MIN : 83;
  sample->control_diagnostics.last_websocket_tls_stack_error =
      fixture->maximum_metrics ? INT32_MIN : -84;
  sample->control_diagnostics.last_websocket_transport_errno =
      fixture->maximum_metrics ? INT32_MIN : 85;
  sample->control_diagnostics.last_websocket_handshake_status_code =
      fixture->maximum_metrics ? INT32_MIN : 429;
  sample->control_diagnostics.last_websocket_close_status_code =
      fixture->maximum_metrics ? INT32_MIN : 4008;
  sample->control_diagnostics.protocol_failure_generation =
      fixture->maximum_metrics ? UINT32_MAX : 83U;
  sample->control_diagnostics.last_application_capnweb_generation =
      fixture->maximum_metrics ? UINT32_MAX : 84U;
  sample->control_diagnostics.last_application_capnweb_status =
      fixture->maximum_metrics ? INT32_MIN : CAPNWEB_E_TRANSPORT;
  sample->control_diagnostics.last_control_receive_status =
      fixture->maximum_metrics ? INT32_MIN : CAPNWEB_OK;
  sample->control_diagnostics.control_messages_sent =
      fixture->maximum_metrics ? UINT32_MAX : 85U;
  sample->control_diagnostics.control_messages_discarded =
      fixture->maximum_metrics ? UINT32_MAX : 86U;
  sample->control_diagnostics.control_inbox_discarded =
      fixture->maximum_metrics ? UINT32_MAX : 87U;
  sample->control_diagnostics.control_outbox_discarded =
      fixture->maximum_metrics ? UINT32_MAX : 88U;
  sample->control_diagnostics.control_inbox.capacity_slots =
      fixture->maximum_metrics ? UINT32_MAX : 4U;
  sample->control_diagnostics.control_inbox.messages_published =
      fixture->maximum_metrics ? UINT32_MAX : 89U;
  sample->control_diagnostics.control_inbox.messages_consumed =
      fixture->maximum_metrics ? UINT32_MAX : 90U;
  sample->control_diagnostics.control_inbox.producer_backpressure =
      fixture->maximum_metrics ? UINT32_MAX : 0U;
  sample->control_diagnostics.control_inbox.high_water_slots =
      fixture->maximum_metrics ? UINT32_MAX : 3U;
  sample->control_diagnostics.control_inbox.current_slots =
      fixture->maximum_metrics ? UINT32_MAX : 0U;
  sample->control_diagnostics.control_outbox.capacity_slots =
      fixture->maximum_metrics ? UINT32_MAX : 8U;
  sample->control_diagnostics.control_outbox.messages_published =
      fixture->maximum_metrics ? UINT32_MAX : 91U;
  sample->control_diagnostics.control_outbox.messages_consumed =
      fixture->maximum_metrics ? UINT32_MAX : 90U;
  sample->control_diagnostics.control_outbox.producer_backpressure =
      fixture->maximum_metrics ? UINT32_MAX : 1U;
  sample->control_diagnostics.control_outbox.high_water_slots =
      fixture->maximum_metrics ? UINT32_MAX : 8U;
  sample->control_diagnostics.control_outbox.current_slots =
      fixture->maximum_metrics ? UINT32_MAX : 1U;
  /*
   * A failed AP-info lookup must be distinguishable from both an actual
   * 0 dBm measurement and a stale prior reading. Keep fixture presence and
   * storage independent so the omission test exercises that distinction
   * through the real retained Cap'n Web reply.
   */
  sample->control_diagnostics.network.wifi_connected =
      fixture->wifi_connected;
  sample->control_diagnostics.network.has_wifi_rssi_dbm =
      fixture->has_wifi_rssi_dbm;
  sample->control_diagnostics.network.wifi_rssi_dbm =
      fixture->wifi_rssi_dbm;
  sample->control_diagnostics.network.pcm_websocket_connections =
      fixture->maximum_metrics ? UINT32_MAX : 92U;
  sample->control_diagnostics.network.pcm_websocket_disconnects =
      fixture->maximum_metrics ? UINT32_MAX : 93U;
  sample->control_diagnostics.network.pcm_websocket_errors =
      fixture->maximum_metrics ? UINT32_MAX : 94U;
  sample->control_diagnostics.network.pcm_websocket_raw_write_failures =
      fixture->maximum_metrics ? UINT32_MAX : 95U;
  sample->control_diagnostics.network.pcm_transport_failure_incidents =
      fixture->maximum_metrics ? UINT32_MAX : 96U;
  sample->control_diagnostics.network.pcm_last_failure_operation =
      fixture->maximum_metrics ? UINT32_MAX : 3U;
  sample->control_diagnostics.network.pcm_last_raw_result =
      fixture->maximum_metrics ? INT32_MIN : -1;
  sample->control_diagnostics.network.pcm_last_socket_errno =
      fixture->maximum_metrics ? INT32_MIN : 104;
  sample->control_diagnostics.network.pcm_last_esp_tls_error =
      fixture->maximum_metrics ? INT32_MIN : 32776;
  sample->control_diagnostics.network.pcm_last_tls_stack_error =
      fixture->maximum_metrics ? INT32_MIN : -29312;
  sample->control_diagnostics.network.pcm_last_tls_cert_flags =
      fixture->maximum_metrics ? INT32_MIN : 0;
  return ITERATE_KIT_OK;
}

static enum capnweb_status dispatch(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct fixture *fixture = context;
  return fixture->module.methods[fixture->dispatch_method_index].dispatch(
      fixture->module.context, call, reply);
}

static void fixture_init_with_aec_topology(
    struct fixture *fixture,
    size_t subscription_count,
    bool raw_clean_aec,
    bool avatar,
    size_t callback_budget_capacity) {
  struct iterate_kit_metrics_options metrics_options;
  struct capnweb_session_options session_options;
  struct iterate_kit_callback_budget *callback_budget = NULL;
  memset(fixture, 0, sizeof(*fixture));
  fixture->capture_limit = CAPTURE_CAPACITY;
  fixture->include_playback = true;
  assert(
      subscription_count > 0U &&
      subscription_count <=
          sizeof(fixture->subscriptions) /
              sizeof(fixture->subscriptions[0]));
  if (callback_budget_capacity > 0U) {
    assert(
        iterate_kit_callback_budget_init(
            &fixture->callback_budget, callback_budget_capacity) ==
        ITERATE_KIT_OK);
    callback_budget = &fixture->callback_budget;
  }

  metrics_options = (struct iterate_kit_metrics_options){
    .session = &fixture->session,
    .driver = {fixture, sample_metrics},
    .subscriptions = fixture->subscriptions,
    .subscription_count = subscription_count,
    .interval_ms = 1000U,
    .enable_playback_view = true,
    .enable_aec_view = !raw_clean_aec,
    .enable_raw_clean_aec_view = raw_clean_aec,
    .enable_avatar_view = avatar,
    .diagnostics_expression_buffer = fixture->diagnostics_expression,
    .diagnostics_expression_capacity =
        sizeof(fixture->diagnostics_expression),
    .callback_budget = callback_budget,
  };
  assert(
      iterate_kit_metrics_init(
          &fixture->metrics, &metrics_options) ==
      ITERATE_KIT_OK);
  fixture->module = iterate_kit_metrics_module(&fixture->metrics);

  session_options = (struct capnweb_session_options){
    {dispatch, fixture, NULL},
    capture_fragment,
    fixture,
    fixture->pending_calls,
    CALL_CAPACITY,
    fixture->exports,
    CALL_CAPACITY,
    fixture->imports,
    CALL_CAPACITY,
    fixture->tokens,
    TOKEN_CAPACITY,
    fixture->output_buffer,
    OUTPUT_CAPACITY,
  };
  assert(
      capnweb_session_init(
          &fixture->session, &session_options) ==
      CAPNWEB_OK);
}

static void fixture_init_with_subscription_count(
    struct fixture *fixture, size_t subscription_count) {
  fixture_init_with_aec_topology(
      fixture, subscription_count, false, false, 0U);
}

static void fixture_init(struct fixture *fixture) {
  fixture_init_with_subscription_count(fixture, 1U);
}

static void fixture_init_raw_clean_aec(struct fixture *fixture) {
  fixture_init_with_aec_topology(fixture, 1U, true, false, 0U);
}

static void fixture_init_avatar(struct fixture *fixture) {
  fixture_init_with_aec_topology(fixture, 1U, false, true, 0U);
}

static void receive(struct fixture *fixture, const char *message) {
  assert(
      capnweb_session_receive(
          &fixture->session, message, strlen(message)) ==
      CAPNWEB_OK);
}

/*
 * A rejected callback remains a live Cap'n Web import until its release frame
 * is transmitted. Reusing the only subscription slot first would alias two
 * remote capabilities and let a later completion mutate the wrong subscriber.
 * This sequence holds the rejected call between those states and proves that
 * capacity remains unavailable until poll() performs the ordered release.
 */
static void rejected_callback_is_released_before_slot_reuse(void) {
  struct fixture fixture;
  struct iterate_kit_poll_result poll_result;
  fixture_init(&fixture);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToMetrics\"],"
      "[[\"export\",-1]]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(fixture.captured_count == 1U);
  assert(strcmp(fixture.captured[0], "[\"resolve\",1,null]") == 0);

  poll_result = fixture.module.poll(fixture.module.context, 0U);
  assert(poll_result.status == ITERATE_KIT_POLL_OK);
  assert(fixture.captured_count == 3U);
  assert(strstr(fixture.captured[1], "[\"pipeline\",-1,[]") != NULL);
  assert(strcmp(fixture.captured[2], "[\"pull\",1]") == 0);

  receive(&fixture, "[\"release\",1,1]");
  receive(
      &fixture,
      "[\"reject\",1,[\"error\",\"Error\",\"subscriber failed\"]]");

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToMetrics\"],"
      "[[\"export\",-2]]]]");
  receive(&fixture, "[\"pull\",2]");
  assert(fixture.captured_count == 6U);
  assert(strcmp(fixture.captured[4], "[\"release\",-2,1]") == 0);
  assert(
      strstr(
          fixture.captured[5],
          "metrics subscription limit reached") != NULL);

  poll_result = fixture.module.poll(fixture.module.context, 1U);
  assert(poll_result.status == ITERATE_KIT_POLL_CALLBACK_REJECTED);
  assert(fixture.captured_count == 7U);
  assert(strcmp(fixture.captured[6], "[\"release\",-1,1]") == 0);

  poll_result = fixture.module.close(fixture.module.context);
  assert(poll_result.status == ITERATE_KIT_POLL_OK);
  capnweb_session_close(&fixture.session);
}

/*
 * Metrics follow the same two-socket ownership rule as button events. The
 * userspace `/pcm` generation wants the newest bounded sample, not parallel
 * month-long callbacks from every socket incarnation. Production proved that
 * disposing a project session is not an immediate device-side reclamation
 * oracle: an idle imported callback can occupy the only slot until another
 * sample finally discovers that its exporter has gone away.
 *
 * A stable optional owner key lets the replacement generation supersede only
 * its own idle callback. This is deliberately tested at the wire/resource
 * boundary: the old import must be released before the new callback receives
 * the slot, and the fixed one-slot RAM bound must remain unchanged.
 */
static void stable_owner_key_replaces_its_stale_metrics_callback(void) {
  struct fixture fixture;
  size_t captured_before_replacement;
  fixture_init(&fixture);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToMetrics\"],"
      "[[\"export\",-1],\"iterate-kit-voice-pcm-v1\"]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(
      fixture.module.poll(fixture.module.context, 0U).status ==
      ITERATE_KIT_POLL_OK);
  receive(&fixture, "[\"release\",1,1]");
  receive(&fixture, "[\"resolve\",1,null]");
  captured_before_replacement = fixture.captured_count;

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToMetrics\"],"
      "[[\"export\",-2],\"iterate-kit-voice-pcm-v1\"]]]");
  receive(&fixture, "[\"pull\",2]");

  assert(fixture.subscriptions[0].callback.id == -2);
  assert(fixture.captured_count == captured_before_replacement + 2U);
  assert(
      strcmp(
          fixture.captured[captured_before_replacement],
          "[\"release\",-1,1]") == 0);
  assert(
      strcmp(
          fixture.captured[captured_before_replacement + 1U],
          "[\"resolve\",2,null]") == 0);

  assert(
      fixture.module.poll(fixture.module.context, 1U).status ==
      ITERATE_KIT_POLL_OK);
  assert(
      strstr(
          fixture.captured[captured_before_replacement + 2U],
          "[\"pipeline\",-2,[]") != NULL);

  capnweb_session_close(&fixture.session);
  fixture.module.session_ended(fixture.module.context);
}

/*
 * Wi-Fi reconnection creates a new Cap'n Web session while the metrics module
 * itself survives. Retaining the old import would call a capability ID whose
 * meaning belongs to the dead session. Reinitialize the same storage and prove
 * session_ended() makes the only slot safe for the new peer.
 */
static void session_end_discards_callbacks_before_session_reuse(void) {
  struct fixture fixture;
  struct capnweb_session_options session_options;
  fixture_init(&fixture);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToMetrics\"],"
      "[[\"export\",-41]]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(fixture.subscriptions[0].occupied);

  capnweb_session_close(&fixture.session);
  assert(fixture.module.session_ended != NULL);
  fixture.module.session_ended(fixture.module.context);
  assert(!fixture.subscriptions[0].occupied);
  assert(!fixture.subscriptions[0].call_in_flight);
  assert(!fixture.subscriptions[0].release_pending);
  assert(fixture.subscriptions[0].owner == &fixture.metrics);

  session_options = (struct capnweb_session_options){
    {dispatch, &fixture, NULL},
    capture_fragment,
    &fixture,
    fixture.pending_calls,
    CALL_CAPACITY,
    fixture.exports,
    CALL_CAPACITY,
    fixture.imports,
    CALL_CAPACITY,
    fixture.tokens,
    TOKEN_CAPACITY,
    fixture.output_buffer,
    OUTPUT_CAPACITY,
  };
  assert(
      capnweb_session_init(
          &fixture.session, &session_options) ==
      CAPNWEB_OK);
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToMetrics\"],"
      "[[\"export\",-42]]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(fixture.subscriptions[0].occupied);
  assert(fixture.subscriptions[0].callback.id == -42);
  capnweb_session_close(&fixture.session);
  fixture.module.session_ended(fixture.module.context);
}

/*
 * The metrics callback shares a fixed control lane with interactive device
 * RPC. Serialize the complete audio diagnostic shape through the real Cap'n
 * Web writer so a field addition cannot silently fragment or truncate what
 * callers believe is one atomic observation.
 */
static void audio_metrics_fit_one_control_message(void) {
  struct fixture fixture;
  fixture_init(&fixture);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToMetrics\"],"
      "[[\"export\",-1]]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(
      fixture.module.poll(fixture.module.context, 0U).status ==
      ITERATE_KIT_POLL_OK);
  assert(fixture.captured_count == 3U);
  assert(
      strstr(
          fixture.captured[1],
          "\"subscriptionEnds\":44") != NULL);
  assert(
      strstr(
          fixture.captured[1],
          "\"audio\":{\"capture\":{\"sent\":9,\"dropped\":10,"
          "\"failures\":11},\"uplink\":{\"sent\":12,\"dropped\":13,"
          "\"depth\":14,\"highWater\":15,\"sendDeferrals\":29,"
          "\"consecutiveSendDeferrals\":30,"
          "\"maximumConsecutiveSendDeferrals\":31,\"failures\":16,"
          "\"restartIncidents\":32,"
          "\"inPlaceFreshnessRecoveries\":42,"
          "\"socketRestarts\":43,"
          "\"producerBackpressureRestarts\":33,"
          "\"transportDisconnectRestarts\":34,"
          "\"noProgressTimeoutRestarts\":35,"
          "\"frameSendTimeoutRestarts\":36,"
          "\"captureStaleRestarts\":37,"
          "\"lastTransportAcceptAgeMs\":38,"
          "\"maximumTransportAcceptAgeMs\":39,"
          "\"lastRestartOldestCaptureAgeMs\":40,"
          "\"lastRestartReason\":\"capture_stale\","
          "\"lastRestartFramesDiscarded\":41},"
          "\"downlink\":{\"received\":17,\"dropped\":18,\"depth\":19,"
          "\"highWater\":20,\"failures\":21},\"playback\":{"
          "\"submitted\":22,\"completed\":23,\"flushed\":24,"
          "\"depth\":25,\"highWater\":26,\"failures\":27},"
          "\"protocolFailures\":28}") != NULL);
  assert(fixture.captured_lengths[1] < MESSAGE_CAPACITY);

  capnweb_session_close(&fixture.session);
  fixture.module.session_ended(fixture.module.context);
}

/*
 * The control transport owns fixed 2 KiB slots; allowing a valid metrics
 * sample to approach that limit too closely would turn a healthy long-running
 * device into a permanent callback failure after an innocuous schema or
 * instrumentation improvement. Exercise the actual public domains: 64-bit
 * uptime, 0..1000 CPU, saturated 32-bit counters, the longest restart reason,
 * all six buffers at their longest evidence representation, and a full-width
 * remote capability ID. INT64_MAX for every field would describe no ESP32
 * producer and hide the stronger API guarantee that counters saturate before
 * serialization.
 *
 * Sixty-four bytes is deliberate change headroom, not an invitation to spend
 * it casually. A field addition that consumes it must either justify more
 * static RAM or shorten the wire schema. Without this assertion, the failure
 * appears only at maximum counter widths and can permanently silence the very
 * diagnostics needed to explain it.
 */
static void maximum_audio_counters_fit_one_control_message(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  fixture.maximum_metrics = true;
  fixture.include_buffers = true;

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToMetrics\"],"
      "[[\"export\",-9223372036854775807]]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(
      fixture.module.poll(fixture.module.context, 0U).status ==
      ITERATE_KIT_POLL_OK);
  assert(fixture.captured_count == 3U);
  assert(fixture.captured_lengths[1] <= MESSAGE_CAPACITY - 64U);

  capnweb_session_close(&fixture.session);
  fixture.module.session_ended(fixture.module.context);
}

/*
 * Per-descriptor timing and every destructive recovery classification cannot
 * be compressed into the almost-full general metrics callback without making
 * healthy maximum-width counters exceed the fixed 2 KiB control slot. A
 * second latest-state view shares the same sampler and subscriber storage: it
 * is a different serialization, not another task, queue, or telemetry history.
 *
 * Exercise the real Cap'n Web call boundary here. Merely testing a C struct
 * would miss both an accidentally unmounted method and schema growth that
 * starts failing only after long-lived counters gain all ten digits.
 */
static void playback_metrics_use_a_bounded_dedicated_view(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  fixture.maximum_metrics = true;
  fixture.dispatch_method_index = 1U;

  assert(fixture.module.method_count == 4U);
  assert(
      strcmp(
          fixture.module.methods[1].path[0],
          "subscribeToPlaybackMetrics") == 0);
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToPlaybackMetrics\"],"
      "[[\"export\",-9223372036854775807]]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(
      fixture.module.poll(fixture.module.context, 0U).status ==
      ITERATE_KIT_POLL_OK);
  assert(fixture.captured_count == 3U);
  assert(
      strstr(
          fixture.captured[1],
          "\"schemaVersion\":5,"
          "\"sequence\":4294967295,"
          "\"producedAtMs\":9223372036854775807,"
          "\"downlinkAccepted\":4294967295") != NULL);
  assert(
      strstr(
          fixture.captured[1],
          "\"receiveToDmaStartSamples\":4294967295,"
          "\"maximumReceiveToDmaStartMs\":4294967295,"
          "\"downlinkInterarrivalSamples\":4294967295,"
          "\"maximumDownlinkInterarrivalMs\":4294967295") != NULL);
  assert(
      strstr(
          fixture.captured[1],
          "\"underrunSilenceFramesSubmitted\":4294967295,"
          "\"underrunSilenceFramesCompleted\":4294967295,"
          "\"underrunSilenceFramesRetired\":4294967295,"
          "\"underrunLateFramesDropped\":4294967295") != NULL);
  assert(
      strstr(
          fixture.captured[1],
          "\"maximumEofToSuccessfulRefillUs\":4294967295") != NULL);
  assert(
      strstr(
          fixture.captured[1],
          "\"maximumWriteCallDurationUs\":4294967295") != NULL);
  assert(
      strstr(
          fixture.captured[1],
          "\"minimumReuseLeadAtSuccessfulRefillUs\":4294967295") !=
      NULL);
  /*
   * The fixed-size view spends its wire budget on causal maxima. The three
   * latest-sample values remain available inside firmware but are deliberately
   * not serialized: a one-second callback can miss the incident that matters,
   * whereas the lifetime maximum/minimum cannot.
   */
  assert(
      strstr(
          fixture.captured[1],
          "\"lastEofToSuccessfulRefillUs\"") == NULL);
  assert(
      strstr(
          fixture.captured[1],
          "\"lastWriteCallDurationUs\"") == NULL);
  assert(
      strstr(
          fixture.captured[1],
          "\"lastReuseLeadAtSuccessfulRefillUs\"") == NULL);
  assert(
      strstr(
          fixture.captured[1],
          "\"generationFenceAcknowledgementTimeouts\":4294967295,"
          "\"lifecycleAcknowledgementTimeouts\":4294967295") != NULL);
  /*
   * The endurance load stage cannot distinguish a healthy busy network task
   * from a starved one using aggregate CPU alone. These owner-loop maxima were
   * already sampled by the target but vanished at serialization, creating dead
   * instrumentation exactly where the acceptance rig needs it.
   */
  assert(
      strstr(
          fixture.captured[1],
          "\"pcmReceiveCalls\":4294967295,"
          "\"pcmReceiveChunks\":4294967295") != NULL);
  /*
   * These counters already exist at the ESP transport boundary. Publishing
   * them must stay a passive snapshot: their diagnostic value comes from
   * comparing cumulative stages after a stall, not from adding a telemetry
   * queue or serial logging to the high-volume PCM task.
   */
  assert(
      strstr(
          fixture.captured[1],
          "\"controlNetworkMaximumWorkCycles\":4294967295,"
          "\"pcmNetworkMaximumWorkCycles\":4294967295") != NULL);
  assert(fixture.captured_lengths[1] <= MESSAGE_CAPACITY - 64U);

  capnweb_session_close(&fixture.session);
  fixture.module.session_ended(fixture.module.context);
}

/*
 * A server-VAD failure is otherwise impossible to attribute from lifetime
 * capture counters: StackChan's own greeting can set the boot-wide peak, then
 * hide whether a later physical prompt reached the near microphone, leaked
 * into the speaker-reference channel, survived AEC, or was suppressed before
 * the provider lane. Keep that interval evidence in a dedicated latest-state
 * callback. Adding it to the nearly-full general metrics object would make an
 * endurance counter's tenth digit capable of breaking every metrics update.
 *
 * This method-level assertion is intentionally the first red slice. It proves
 * the public Cap'n Web surface must actually mount the diagnostic view; a
 * device-local C struct alone would not let the production harness observe it.
 */
static void aec_metrics_are_mounted_as_a_dedicated_view(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  fixture.maximum_metrics = true;
  fixture.include_aec = true;
  fixture.dispatch_method_index = 2U;

  assert(fixture.module.method_count == 4U);
  assert(
      strcmp(
          fixture.module.methods[2].path[0],
          "subscribeToAecMetrics") == 0);
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToAecMetrics\"],"
      "[[\"export\",-9223372036854775807]]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(
      fixture.module.poll(fixture.module.context, 0U).status ==
      ITERATE_KIT_POLL_OK);
  assert(fixture.captured_count == 3U);
  assert(
      strstr(
          fixture.captured[1],
          "\"schemaVersion\":3,"
          "\"sequence\":4294967295,"
          "\"windowStartedAtMs\":9223372036854775807,"
          "\"producedAtMs\":9223372036854775807,"
          "\"sampleStride\":4294967295,"
          "\"sampledSamples\":4294967295") != NULL);
  assert(
      strstr(
          fixture.captured[1],
          "\"nearPeak\":4294967295,"
          "\"referencePeak\":4294967295,"
          "\"linearPeak\":4294967295,"
          "\"cleanPeak\":4294967295,"
          "\"nearMeanAbsolute\":4294967295,"
          "\"referenceMeanAbsolute\":4294967295,"
          "\"linearMeanAbsolute\":4294967295,"
          "\"cleanMeanAbsolute\":4294967295") != NULL);
  assert(
      strstr(
          fixture.captured[1],
          "\"lifetimeFramesProcessed\":4294967295,"
          "\"lifetimeRecreates\":4294967295,"
          "\"lifetimeRecreateFailures\":4294967295,"
          "\"lastLinearUs\":4294967295,"
          "\"maximumLinearUs\":4294967295,"
          "\"lastNlpUs\":4294967295,"
          "\"maximumNlpUs\":4294967295") != NULL);
  assert(
      strstr(
          fixture.captured[1],
          "\"lastCaptureToUplinkUs\":4294967295,"
          "\"maximumCaptureToUplinkUs\":4294967295,"
          "\"lifetimeCaptureReserveDroppedChunks\":4294967295,"
          "\"lifetimeCaptureBridgeErrors\":4294967295,"
          "\"lifetimeSignalMeasurementFailures\":4294967295") !=
      NULL);
  assert(
      strstr(
          fixture.captured[1],
          "\"lifetimePlaybackContentSamples\":4294967295,"
          "\"lifetimePlaybackResets\":4294967295,"
          "\"lifetimePlaybackFramesDiscardedByReset\":4294967295,"
          "\"lifetimePlaybackWriteFailures\":4294967295,"
          "\"lifetimePlaybackQueueOverflows\":4294967295,"
          "\"lifetimePlaybackPolicyErrors\":4294967295,"
          "\"lifetimePlaybackResetFailures\":4294967295,"
          "\"lifetimePlaybackObservationFailures\":4294967295,"
          "\"lifetimePlaybackUnderrunIncidents\":4294967295,"
          "\"lifetimePlaybackUnderrunSilenceSamples\":4294967295,"
          "\"lifetimePlaybackStaleFramesDiscarded\":4294967295") !=
      NULL);
  assert(
      strstr(
          fixture.captured[1],
          "\"lastPlaybackWriteUs\":4294967295,"
          "\"maximumPlaybackWriteUs\":4294967295,"
          "\"lastReceiveToRenderMs\":4294967295,"
          "\"maximumReceiveToRenderMs\":4294967295") != NULL);
  assert(fixture.captured_lengths[1] <= MESSAGE_CAPACITY - 64U);

  capnweb_session_close(&fixture.session);
  fixture.module.session_ended(fixture.module.context);
}

/*
 * A physically visible face is not enough acceptance evidence: LCD controller
 * memory can retain an old image across an application reset. Exercise the
 * public Cap'n Web seam that lets the production harness prove current audio
 * observations reached the animator, mouth-open frames were rendered, and the
 * panel completed those transfers without timeout. Keeping this as its own
 * bounded view avoids overflowing the nearly-full general metrics message.
 */
static void avatar_metrics_are_mounted_as_a_bounded_dedicated_view(void) {
  struct fixture fixture;
  fixture_init_avatar(&fixture);
  fixture.maximum_metrics = true;
  fixture.include_avatar = true;
  fixture.dispatch_method_index = 3U;

  assert(fixture.module.method_count == 5U);
  assert(
      strcmp(
          fixture.module.methods[3].path[0],
          "subscribeToAvatarMetrics") == 0);
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToAvatarMetrics\"],"
      "[[\"export\",-9223372036854775807]]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(
      fixture.module.poll(fixture.module.context, 0U).status ==
      ITERATE_KIT_POLL_OK);
  assert(fixture.captured_count == 3U);
  assert(
      strstr(
          fixture.captured[1],
          "\"schemaVersion\":1,"
          "\"producedAtMs\":9223372036854775807,"
          "\"ready\":true,"
          "\"playoutObservations\":4294967295") != NULL);
  assert(
      strstr(
          fixture.captured[1],
          "\"analyzerSequenceGaps\":4294967295,"
          "\"mouthOpenRenderedFrames\":4294967295,"
          "\"snapshotRaces\":4294967295,"
          "\"renderedFrames\":4294967295") != NULL);
  assert(
      strstr(
          fixture.captured[1],
          "\"displayTransfers\":4294967295,"
          "\"displayTransferFailures\":4294967295,"
          "\"displayTransferTimeouts\":4294967295") != NULL);
  assert(
      strstr(
          fixture.captured[1],
          "\"maximumHandoffDelayUs\":4294967295,"
          "\"maximumAnalyzerUs\":4294967295,"
          "\"maximumRenderUs\":4294967295,"
          "\"maximumDisplayTransferUs\":4294967295") != NULL);
  assert(
      strstr(
          fixture.captured[1],
          "\"analyzerStackMinimumFreeBytes\":4294967295,"
          "\"physicalPlayoutSampleClock\":4294967295,"
          "\"currentAvatarIndex\":4294967295,"
          "\"framebufferBytes\":4294967295") != NULL);
  assert(fixture.captured_lengths[1] <= MESSAGE_CAPACITY - 64U);

  capnweb_session_close(&fixture.session);
  fixture.module.session_ended(fixture.module.context);
}

/*
 * HAVPE's XMOS bus exposes two simultaneous capture taps: raw microphone and
 * the post-AEC clean channel. It does not expose the private far-end reference
 * used inside XMOS. Serialising a zero reference would turn missing evidence
 * into a false AEC measurement, while inventing a second endpoint would force
 * every generic voice-satellite harness to branch on method names. The shared
 * subscribeToAecMetrics method therefore carries a discriminated two-tap
 * schema for this topology. Playback content is counted in the same monotonic
 * signal window so a speaker-only interval is attributable without pretending
 * intended PCM is the hidden hardware reference.
 */
static void raw_clean_aec_metrics_preserve_the_truthful_topology(void) {
  struct fixture fixture;
  fixture_init_raw_clean_aec(&fixture);
  fixture.maximum_metrics = true;
  fixture.include_raw_clean_aec = true;
  fixture.dispatch_method_index = 2U;

  assert(fixture.module.method_count == 4U);
  assert(
      strcmp(
          fixture.module.methods[2].path[0],
          "subscribeToAecMetrics") == 0);
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToAecMetrics\"],"
      "[[\"export\",-9223372036854775807]]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(
      fixture.module.poll(fixture.module.context, 0U).status ==
      ITERATE_KIT_POLL_OK);
  assert(fixture.captured_count == 3U);
  assert(
      strstr(
          fixture.captured[1],
          "\"schemaVersion\":4,\"topology\":\"raw-clean\","
          "\"sequence\":4294967295,"
          "\"windowStartedAtMs\":9223372036854775807,"
          "\"producedAtMs\":9223372036854775807") != NULL);
  assert(
      strstr(
          fixture.captured[1],
          "\"rawPeak\":4294967295,\"cleanPeak\":4294967295,"
          "\"rawMeanAbsolute\":4294967295,"
          "\"cleanMeanAbsolute\":4294967295,"
          "\"rawAbsoluteSum\":9223372036854775807,"
          "\"cleanAbsoluteSum\":9223372036854775807,"
          "\"playbackContentSamples\":4294967295") != NULL);
  assert(
      strstr(
          fixture.captured[1],
          "\"lifetimeCaptureFrames\":4294967295,"
          "\"lifetimeCleanUplinkFrames\":4294967295,"
          "\"lifetimeCleanUplinkDrops\":4294967295,"
          "\"lifetimeCaptureFailures\":4294967295,"
          "\"lifetimeSignalMeasurementFailures\":4294967295,"
          "\"lastCaptureToUplinkUs\":4294967295,"
          "\"maximumCaptureToUplinkUs\":4294967295") != NULL);
  assert(
      strstr(
          fixture.captured[1],
          "\"lifetimePlaybackContentSamples\":4294967295,"
          "\"lifetimePlaybackResets\":4294967295,"
          "\"lifetimePlaybackFramesDiscardedByReset\":4294967295,"
          "\"lifetimePlaybackWriteFailures\":4294967295,"
          "\"lifetimePlaybackQueueOverflows\":4294967295,"
          "\"lifetimePlaybackPolicyErrors\":4294967295,"
          "\"lifetimePlaybackResetFailures\":4294967295,"
          "\"lifetimePlaybackObservationFailures\":4294967295,"
          "\"lifetimePlaybackUnderrunIncidents\":4294967295,"
          "\"lifetimePlaybackUnderrunSilenceSamples\":4294967295,"
          "\"lifetimePlaybackStaleFramesDiscarded\":4294967295") !=
      NULL);
  assert(
      strstr(
          fixture.captured[1],
          "\"lastPlaybackWriteUs\":4294967295,"
          "\"maximumPlaybackWriteUs\":4294967295,"
          "\"lastReceiveToRenderMs\":4294967295,"
          "\"maximumReceiveToRenderMs\":4294967295") != NULL);
  assert(strstr(fixture.captured[1], "\"referencePeak\"") == NULL);
  assert(fixture.captured_lengths[1] <= MESSAGE_CAPACITY - 64U);

  capnweb_session_close(&fixture.session);
  fixture.module.session_ended(fixture.module.context);
}

/*
 * The first production avatar proof mounted three latest-state callbacks:
 * userspace general metrics plus harness-only AEC and avatar views. The shared
 * transport profile deliberately admits only two callback calls at once. A
 * fixed index-zero scan therefore delivered AEC and avatar every second while
 * starving userspace general metrics forever; the provider became ready, but
 * the acceptance harness could not observe that state and timed out.
 *
 * Backpressure is expected and no sample should be queued, but every ready
 * subscriber must eventually get first access to the bounded budget. Recreate
 * the exact two-of-three shape through real Cap'n Web callback completions and
 * require the subscriber skipped in the first interval to run in the second.
 * This guards scheduler fairness without increasing callback capacity, wire
 * burst size, heap use, or work performed in one owner pass.
 */
static void callback_budget_rotates_past_a_backpressured_subscriber(void) {
  struct fixture fixture;
  fixture_init_with_aec_topology(
      &fixture, 3U, false, true, 2U);
  fixture.include_aec = true;
  fixture.include_avatar = true;

  fixture.dispatch_method_index = 2U;
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToAecMetrics\"],"
      "[[\"export\",-1]]]]");
  receive(&fixture, "[\"pull\",1]");
  fixture.dispatch_method_index = 3U;
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToAvatarMetrics\"],"
      "[[\"export\",-2]]]]");
  receive(&fixture, "[\"pull\",2]");
  fixture.dispatch_method_index = 0U;
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToMetrics\"],"
      "[[\"export\",-3]]]]");
  receive(&fixture, "[\"pull\",3]");

  assert(
      fixture.module.poll(fixture.module.context, 0U).status ==
      ITERATE_KIT_POLL_OK);
  assert(fixture.subscriptions[0].call_in_flight);
  assert(fixture.subscriptions[1].call_in_flight);
  assert(!fixture.subscriptions[2].call_in_flight);
  assert(fixture.callback_budget.in_flight == 2U);

  receive(&fixture, "[\"release\",1,1]");
  receive(&fixture, "[\"resolve\",1,null]");
  receive(&fixture, "[\"release\",2,1]");
  receive(&fixture, "[\"resolve\",2,null]");
  assert(fixture.callback_budget.in_flight == 0U);

  assert(
      fixture.module.poll(fixture.module.context, 1000U).status ==
      ITERATE_KIT_POLL_OK);
  assert(fixture.subscriptions[2].call_in_flight);
  assert(fixture.callback_budget.in_flight == 2U);

  capnweb_session_close(&fixture.session);
  fixture.module.session_ended(fixture.module.context);
}

/*
 * The M5StickS3 owner loop polls metrics before consuming at most four inbound
 * Cap'n Web messages. Two ready subscriptions each serialize one push and one
 * pull, so that first phase can publish four messages. Four already-dispatched
 * calls can then present their pulls in the next inbox burst, requiring four
 * resolutions before the asynchronous network owner is guaranteed to run.
 *
 * The physical 20 Hz diagnostics run hit the old four-slot profile exactly:
 * metrics messages occupied the outbox, getDiagnostics pull 60 received no
 * resolution, yet later subscription traffic proved the socket was alive.
 * Model the real protocol sequence with a sink that refuses a ninth message.
 * Eight is a one-owner-pass reserve, not a retry queue; failure to serialize
 * within it must remain a visible terminal generation error.
 */
static void metrics_fanout_and_inbound_resolutions_fit_one_owner_burst(
    void) {
  struct fixture fixture;
  struct iterate_kit_poll_result poll_result;
  fixture_init_with_subscription_count(&fixture, 2U);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToMetrics\"],"
      "[[\"export\",-1]]]]");
  receive(&fixture, "[\"pull\",1]");
  receive(&fixture, "[\"release\",1,1]");
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToPlaybackMetrics\"],"
      "[[\"export\",-2]]]]");
  receive(&fixture, "[\"pull\",2]");
  receive(&fixture, "[\"release\",2,1]");

  fixture.include_control_diagnostics = true;
  fixture.dispatch_method_index = 3U;
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"getDiagnostics\"],[]]]");
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"getDiagnostics\"],[]]]");
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"getDiagnostics\"],[]]]");
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"getDiagnostics\"],[]]]");

  /*
   * The capture sink represents an empty profiled outbox at the start of this
   * owner pass. Earlier subscription acknowledgements were already consumed
   * by the peer and have no bearing on this burst's storage obligation.
   */
  fixture.captured_count = 0U;
  fixture.capture_limit = MAXIMUM_OWNER_LOOP_CONTROL_BURST;
  poll_result = fixture.module.poll(fixture.module.context, 0U);
  assert(poll_result.status == ITERATE_KIT_POLL_OK);
  assert(fixture.captured_count == 4U);

  receive(&fixture, "[\"pull\",3]");
  receive(&fixture, "[\"pull\",4]");
  receive(&fixture, "[\"pull\",5]");
  receive(&fixture, "[\"pull\",6]");
  assert(fixture.captured_count == MAXIMUM_OWNER_LOOP_CONTROL_BURST);
  assert(
      capnweb_session_get_state(&fixture.session) ==
      CAPNWEB_SESSION_OPEN);
  assert(
      strstr(
          fixture.captured[4],
          "\"control\":{\"websocketStartAttempts\":73") != NULL);
  assert(
      strstr(
          fixture.captured[7],
          "control diagnostics snapshot already in flight") != NULL);

  capnweb_session_close(&fixture.session);
  fixture.module.session_ended(fixture.module.context);
}

/*
 * A reconnect is exactly when a recurring Cap'n Web callback disappears, so
 * transport failure evidence cannot live only in the dead subscription. The
 * replacement generation needs one bounded, allocation-free snapshot of the
 * SDK's latest classified incident. This is intentionally a request/response,
 * not a third every-second stream: an idle device pays no recurring wire or
 * CPU cost, and the host cannot build a stale diagnostics backlog.
 */
static void control_diagnostics_are_available_as_a_one_shot_snapshot(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  fixture.include_control_diagnostics = true;
  fixture.dispatch_method_index = 3U;
  fixture.wifi_connected = true;
  fixture.has_wifi_rssi_dbm = true;
  fixture.wifi_rssi_dbm = -67;

  assert(fixture.module.method_count == 4U);
  assert(
      strcmp(
          fixture.module.methods[3].path[0],
          "getDiagnostics") == 0);
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"getDiagnostics\"],[]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(fixture.captured_count == 1U);
  assert(
      strstr(
          fixture.captured[0],
          "\"schemaVersion\":4,\"producedAtMs\":1,"
          "\"control\":{\"websocketStartAttempts\":73,"
          "\"websocketConnections\":74,\"websocketDisconnects\":75,"
          "\"websocketErrors\":76,\"wifiDisconnects\":77,"
          "\"protocolFailures\":78,\"receiveFailures\":79,"
          "\"sendFailures\":80,\"lastWifiDisconnectReason\":81,"
          "\"lastErrorGeneration\":82,\"lastErrorType\":2,"
          "\"lastTlsError\":83,\"lastTlsStackError\":-84,"
          "\"lastTransportErrno\":85,\"lastHandshakeStatusCode\":429,"
          "\"lastCloseStatusCode\":4008,"
          "\"protocolFailureGeneration\":83,"
          "\"lastApplicationCapnwebGeneration\":84,"
          "\"lastApplicationCapnwebStatus\":-4,"
          "\"lastControlReceiveStatus\":0,\"messagesSent\":85,"
          "\"messagesDiscarded\":86,\"inboxDiscarded\":87,"
          "\"outboxDiscarded\":88,"
          "\"inbox\":{\"capacitySlots\":4,\"messagesPublished\":89,"
          "\"messagesConsumed\":90,\"producerBackpressure\":0,"
          "\"highWaterSlots\":3,\"currentSlots\":0},"
          "\"outbox\":{\"capacitySlots\":8,\"messagesPublished\":91,"
          "\"messagesConsumed\":90,\"producerBackpressure\":1,"
          "\"highWaterSlots\":8,\"currentSlots\":1}},"
          "\"network\":{\"wifiConnected\":true,\"wifiRssiDbm\":-67,"
          "\"pcmWebsocketConnections\":92,"
          "\"pcmWebsocketDisconnects\":93,"
          "\"pcmWebsocketErrors\":94,"
          "\"pcmWebsocketRawWriteFailures\":95,"
          "\"pcmTransportFailureIncidents\":96,"
          "\"pcmLastFailureOperation\":3,"
          "\"pcmLastRawResult\":-1,"
          "\"pcmLastSocketErrno\":104,"
          "\"pcmLastEspTlsError\":32776,"
          "\"pcmLastTlsStackError\":-29312,"
          "\"pcmLastTlsCertFlags\":0}") != NULL);
  /*
   * The eight-slot physical run still lost a resolution after 21 seconds.
   * These retained counters are the minimum evidence needed to tell a full
   * application outbox from callback ingress or a host/protocol correlation
   * defect. They must cross the real borrowed Cap'n Web reply; a serial-only
   * counter would disappear when the rig intentionally avoids attaching a
   * timing-perturbing monitor.
   */
  assert(
      strstr(
          fixture.captured[0],
          "\"lastApplicationCapnwebStatus\":-4") != NULL);
  assert(fixture.captured_lengths[0] < MESSAGE_CAPACITY);

  capnweb_session_close(&fixture.session);
  fixture.module.session_ended(fixture.module.context);
}

/*
 * Station association and AP measurement are related but not interchangeable:
 * ESP-IDF may report a connection while an instantaneous AP-info lookup fails
 * during a roam. The one-shot snapshot must therefore carry current connection
 * state while omitting RSSI whose provenance is unavailable. A sentinel would
 * be numerically plausible and could poison later outage analysis.
 */
static void network_diagnostics_omit_unobserved_wifi_rssi(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  fixture.include_control_diagnostics = true;
  fixture.dispatch_method_index = 3U;
  fixture.wifi_connected = true;
  fixture.wifi_rssi_dbm = -21;

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"getDiagnostics\"],[]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(
      strstr(
          fixture.captured[0],
          "\"network\":{\"wifiConnected\":true,"
          "\"pcmWebsocketConnections\":92,"
          "\"pcmWebsocketDisconnects\":93,"
          "\"pcmWebsocketErrors\":94,"
          "\"pcmWebsocketRawWriteFailures\":95,"
          "\"pcmTransportFailureIncidents\":96,"
          "\"pcmLastFailureOperation\":3,"
          "\"pcmLastRawResult\":-1,"
          "\"pcmLastSocketErrno\":104,"
          "\"pcmLastEspTlsError\":32776,"
          "\"pcmLastTlsStackError\":-29312,"
          "\"pcmLastTlsCertFlags\":0}") != NULL);
  assert(strstr(fixture.captured[0], "wifiRssiDbm") == NULL);

  capnweb_session_close(&fixture.session);
  fixture.module.session_ended(fixture.module.context);
}

/*
 * A borrowed Cap'n Web reply may remain pending between push and pull. A
 * second request during that interval must be rejected rather than rewrite the
 * first request's only retained buffer. This regression is the difference
 * between a bounded one-slot diagnostic and subtly returning the wrong socket
 * incident to one of two concurrent operators.
 */
static void control_diagnostics_do_not_overwrite_an_unpulled_snapshot(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  fixture.include_control_diagnostics = true;
  fixture.dispatch_method_index = 3U;

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"getDiagnostics\"],[]]]");
  assert(fixture.metrics.diagnostics_reply_in_flight);
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"getDiagnostics\"],[]]]");
  receive(&fixture, "[\"pull\",2]");
  assert(
      strstr(
          fixture.captured[0],
          "control diagnostics snapshot already in flight") != NULL);
  assert(fixture.metrics.diagnostics_reply_in_flight);

  receive(&fixture, "[\"pull\",1]");
  assert(
      strstr(fixture.captured[1], "\"lastErrorGeneration\":82") !=
      NULL);
  assert(!fixture.metrics.diagnostics_reply_in_flight);

  capnweb_session_close(&fixture.session);
  fixture.module.session_ended(fixture.module.context);
}

/*
 * Long endurance is precisely when counters reach their widest rendering.
 * Exercise the legal public integer domains through the real retained reply so
 * a later field addition cannot make diagnostics truncate only after the
 * control socket has already failed.
 */
static void maximum_control_diagnostics_fit_the_static_reply_budget(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  fixture.include_control_diagnostics = true;
  fixture.maximum_metrics = true;
  fixture.dispatch_method_index = 3U;
  fixture.wifi_connected = true;
  fixture.has_wifi_rssi_dbm = true;
  fixture.wifi_rssi_dbm = INT32_MIN;

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"getDiagnostics\"],[]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(
      strlen(fixture.diagnostics_expression) <=
      sizeof(fixture.diagnostics_expression) - 64U);
  assert(
      strstr(
          fixture.captured[0],
          "\"websocketStartAttempts\":4294967295") != NULL);
  assert(
      strstr(
          fixture.captured[0],
          "\"lastTlsStackError\":-2147483648") != NULL);
  assert(
      strstr(
          fixture.captured[0],
          "\"network\":{\"wifiConnected\":true,"
          "\"wifiRssiDbm\":-2147483648,"
          "\"pcmWebsocketConnections\":4294967295,"
          "\"pcmWebsocketDisconnects\":4294967295,"
          "\"pcmWebsocketErrors\":4294967295,"
          "\"pcmWebsocketRawWriteFailures\":4294967295,"
          "\"pcmTransportFailureIncidents\":4294967295,"
          "\"pcmLastFailureOperation\":4294967295,"
          "\"pcmLastRawResult\":-2147483648,"
          "\"pcmLastSocketErrno\":-2147483648,"
          "\"pcmLastEspTlsError\":-2147483648,"
          "\"pcmLastTlsStackError\":-2147483648,"
          "\"pcmLastTlsCertFlags\":-2147483648}") != NULL);

  capnweb_session_close(&fixture.session);
  fixture.module.session_ended(fixture.module.context);
}

/*
 * A dashboard that sees `current: 0` without knowing how it was measured
 * will call an opaque TLS or Wi-Fi queue empty and hide delayed speech. Exercise
 * the real callback serializer with all four evidence classes so the public
 * API preserves the difference between exact occupancy, configured capacity,
 * and no trustworthy observation. A WebSocket PONG is deliberately not used
 * to synthesize a lower-layer PCM depth because it cannot observe proxy or
 * provider queues.
 */
static void buffer_metrics_preserve_the_strength_of_their_evidence(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  fixture.include_buffers = true;

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToMetrics\"],"
      "[[\"export\",-1]]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(
      fixture.module.poll(fixture.module.context, 0U).status ==
      ITERATE_KIT_POLL_OK);
  assert(fixture.captured_count == 3U);
  assert(
      strstr(
          fixture.captured[1],
          "\"buffers\":{\"uplinkApplication\":{\"evidence\":\"observed\","
          "\"current\":42,\"highWater\":43,\"capacity\":44},"
          "\"websocketTransmitter\":{\"evidence\":\"observed\","
          "\"current\":45,\"highWater\":46,\"capacity\":47},"
          "\"lwipSend\":{\"evidence\":\"capacityOnly\","
          "\"current\":0,\"highWater\":0,\"capacity\":48},"
          "\"tlsEgress\":{\"evidence\":\"unavailable\","
          "\"current\":0,\"highWater\":0,\"capacity\":0},"
          "\"wifiEgress\":{\"evidence\":\"unavailable\","
          "\"current\":0,\"highWater\":0,\"capacity\":0}}") !=
      NULL);

  capnweb_session_close(&fixture.session);
  fixture.module.session_ended(fixture.module.context);
}

/*
 * CoreS3 can prove capture and every transport queue today, but its 8 ms
 * synchronous codec writes do not carry the 20 ms content-frame identity
 * required for submitted/completed conservation. Publishing zero counters
 * would falsely certify clean playback. The optional object lets those real
 * metrics remain useful while making unavailable physical evidence explicit.
 */
static void unavailable_playback_evidence_is_omitted_not_zero_filled(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  fixture.include_playback = false;

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToMetrics\"],"
      "[[\"export\",-1]]]]");
  receive(&fixture, "[\"pull\",1]");
  assert(
      fixture.module.poll(fixture.module.context, 0U).status ==
      ITERATE_KIT_POLL_OK);
  assert(fixture.captured_count == 3U);
  assert(strstr(fixture.captured[1], "\"capture\":") != NULL);
  assert(strstr(fixture.captured[1], "\"downlink\":") != NULL);
  assert(strstr(fixture.captured[1], "\"playback\":") == NULL);
  assert(strstr(fixture.captured[1], "\"protocolFailures\":28") != NULL);

  capnweb_session_close(&fixture.session);
  fixture.module.session_ended(fixture.module.context);
}

/*
 * Treating an out-of-range driver enum as UNAVAILABLE would hide a firmware
 * defect behind an apparently deliberate lack of instrumentation. The sample
 * must fail before Cap'n Web opens a callback message, leaving no truncated
 * JSON in the one-slot control transmitter and surfacing the driver error to
 * the runtime diagnostics path.
 */
static void invalid_buffer_evidence_is_a_visible_driver_error(void) {
  struct fixture fixture;
  struct iterate_kit_poll_result result;
  fixture_init(&fixture);
  fixture.include_buffers = true;
  fixture.invalid_buffer_evidence = true;

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"subscribeToMetrics\"],"
      "[[\"export\",-1]]]]");
  receive(&fixture, "[\"pull\",1]");
  result = fixture.module.poll(fixture.module.context, 0U);
  assert(result.status == ITERATE_KIT_POLL_DRIVER_ERROR);
  assert(result.capnweb_status == CAPNWEB_OK);
  assert(fixture.captured_count == 1U);
  assert(!fixture.message_open);

  capnweb_session_close(&fixture.session);
  fixture.module.session_ended(fixture.module.context);
}

int main(void) {
  rejected_callback_is_released_before_slot_reuse();
  stable_owner_key_replaces_its_stale_metrics_callback();
  session_end_discards_callbacks_before_session_reuse();
  audio_metrics_fit_one_control_message();
  maximum_audio_counters_fit_one_control_message();
  playback_metrics_use_a_bounded_dedicated_view();
  aec_metrics_are_mounted_as_a_dedicated_view();
  avatar_metrics_are_mounted_as_a_bounded_dedicated_view();
  raw_clean_aec_metrics_preserve_the_truthful_topology();
  callback_budget_rotates_past_a_backpressured_subscriber();
  metrics_fanout_and_inbound_resolutions_fit_one_owner_burst();
  control_diagnostics_are_available_as_a_one_shot_snapshot();
  network_diagnostics_omit_unobserved_wifi_rssi();
  control_diagnostics_do_not_overwrite_an_unpulled_snapshot();
  maximum_control_diagnostics_fit_the_static_reply_budget();
  buffer_metrics_preserve_the_strength_of_their_evidence();
  unavailable_playback_evidence_is_omitted_not_zero_filled();
  invalid_buffer_evidence_is_a_visible_driver_error();
  return 0;
}
