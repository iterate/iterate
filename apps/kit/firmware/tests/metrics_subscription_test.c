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
  size_t captured_count;
  bool message_open;
  struct iterate_kit_metrics metrics;
  struct iterate_kit_metrics_subscription subscription;
  struct iterate_kit_module module;
  size_t dispatch_method_index;
  bool maximum_metrics;
  bool include_buffers;
  bool invalid_buffer_evidence;
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
        fixture->captured_count >= CAPTURE_CAPACITY) {
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
    },
    false,
    {0},
  };
  sample->audio.uplink.send_deferrals =
      fixture->maximum_metrics ? maximum_counter : 29U;
  sample->audio.uplink.consecutive_send_deferrals =
      fixture->maximum_metrics ? maximum_counter : 30U;
  sample->audio.uplink.maximum_consecutive_send_deferrals =
      fixture->maximum_metrics ? maximum_counter : 31U;
  sample->audio.uplink.restart_incidents =
      fixture->maximum_metrics ? maximum_counter : 32U;
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
  sample->audio.has_buffers = fixture->include_buffers;
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
  sample->audio.buffers.peer_unconfirmed.evidence =
      ITERATE_KIT_BUFFER_DERIVED_BOUND;
  sample->audio.buffers.peer_unconfirmed.current_bytes =
      fixture->maximum_metrics ? UINT32_MAX : 48U;
  sample->audio.buffers.peer_unconfirmed.high_water_bytes =
      fixture->maximum_metrics ? UINT32_MAX : 49U;
  sample->audio.buffers.peer_unconfirmed.capacity_bytes =
      fixture->maximum_metrics ? UINT32_MAX : 50U;
  sample->audio.buffers.lwip_send.evidence =
      ITERATE_KIT_BUFFER_CAPACITY_ONLY;
  sample->audio.buffers.lwip_send.capacity_bytes =
      fixture->maximum_metrics ? UINT32_MAX : 51U;
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
    sample->audio.buffers.peer_unconfirmed =
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
  sample->playback_detail.schema_version = 3U;
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
  sample->playback_detail.runtime.control_network_max_work_cycles =
      fixture->maximum_metrics ? UINT32_MAX : 69U;
  sample->playback_detail.runtime.pcm_network_max_work_cycles =
      fixture->maximum_metrics ? UINT32_MAX : 70U;
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

static void fixture_init(struct fixture *fixture) {
  struct iterate_kit_metrics_options metrics_options;
  struct capnweb_session_options session_options;
  memset(fixture, 0, sizeof(*fixture));

  metrics_options = (struct iterate_kit_metrics_options){
    &fixture->session,
    {fixture, sample_metrics},
    &fixture->subscription,
    1U,
    1000U,
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
  assert(fixture.subscription.occupied);

  capnweb_session_close(&fixture.session);
  assert(fixture.module.session_ended != NULL);
  fixture.module.session_ended(fixture.module.context);
  assert(!fixture.subscription.occupied);
  assert(!fixture.subscription.call_in_flight);
  assert(!fixture.subscription.release_pending);
  assert(fixture.subscription.owner == &fixture.metrics);

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
  assert(fixture.subscription.occupied);
  assert(fixture.subscription.callback.id == -42);
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
          "\"audio\":{\"capture\":{\"sent\":9,\"dropped\":10,"
          "\"failures\":11},\"uplink\":{\"sent\":12,\"dropped\":13,"
          "\"depth\":14,\"highWater\":15,\"sendDeferrals\":29,"
          "\"consecutiveSendDeferrals\":30,"
          "\"maximumConsecutiveSendDeferrals\":31,\"failures\":16,"
          "\"restartIncidents\":32,"
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

  assert(fixture.module.method_count == 2U);
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
          "\"schemaVersion\":3,"
          "\"sequence\":4294967295,"
          "\"producedAtMs\":9223372036854775807,"
          "\"downlinkAccepted\":4294967295") != NULL);
  assert(
      strstr(
          fixture.captured[1],
          "\"successfulRefillTimingSamples\":4294967295") != NULL);
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
          "\"controlNetworkMaximumWorkCycles\":4294967295,"
          "\"pcmNetworkMaximumWorkCycles\":4294967295") != NULL);
  assert(fixture.captured_lengths[1] <= MESSAGE_CAPACITY - 64U);

  capnweb_session_close(&fixture.session);
  fixture.module.session_ended(fixture.module.context);
}

/*
 * A dashboard that sees `current: 0` without knowing how it was measured
 * will call an opaque TLS or Wi-Fi queue empty and hide delayed speech. Exercise
 * the real callback serializer with all four evidence classes so the public
 * API preserves the difference between exact occupancy, a conservative bound,
 * configured capacity, and no trustworthy observation.
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
          "\"peerUnconfirmed\":{\"evidence\":\"derivedBound\","
          "\"current\":48,\"highWater\":49,\"capacity\":50},"
          "\"lwipSend\":{\"evidence\":\"capacityOnly\","
          "\"current\":0,\"highWater\":0,\"capacity\":51},"
          "\"tlsEgress\":{\"evidence\":\"unavailable\","
          "\"current\":0,\"highWater\":0,\"capacity\":0},"
          "\"wifiEgress\":{\"evidence\":\"unavailable\","
          "\"current\":0,\"highWater\":0,\"capacity\":0}}") !=
      NULL);

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
  session_end_discards_callbacks_before_session_reuse();
  audio_metrics_fit_one_control_message();
  maximum_audio_counters_fit_one_control_message();
  playback_metrics_use_a_bounded_dedicated_view();
  buffer_metrics_preserve_the_strength_of_their_evidence();
  invalid_buffer_evidence_is_a_visible_driver_error();
  return 0;
}
