#include "iterate/kit/capabilities/metrics.h"

#include "rpc_internal.h"

#include <inttypes.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>

/*
 * Metrics are a latest-state subscription, not a telemetry queue. One owner
 * task samples only when a callback can accept a call, builds the expression in
 * bounded stack storage, and never overlaps deliveries to the same callback.
 * Buffering every missed second was rejected: a slow or disconnected observer
 * must not consume device RAM or delay realtime work with stale diagnostics.
 *
 * All subscription state is owned by the Cap'n Web polling task. Completion
 * callbacks run as part of that same session's receive/poll path; no fields in
 * this module are safe for concurrent mutation.
 */
static const char *const subscribe_path[] = {"subscribeToMetrics"};
static const char *const subscribe_playback_path[] = {
  "subscribeToPlaybackMetrics",
};
static const char *const subscribe_aec_path[] = {
  "subscribeToAecMetrics",
};
static const char *const get_diagnostics_path[] = {"getDiagnostics"};

static struct iterate_kit_poll_result poll_ok(void) {
  const struct iterate_kit_poll_result result = {
    ITERATE_KIT_POLL_OK,
    CAPNWEB_OK,
  };
  return result;
}

static struct iterate_kit_poll_result poll_capnweb(
    enum capnweb_status status) {
  const struct iterate_kit_poll_result result = {
    ITERATE_KIT_POLL_CAPNWEB_ERROR,
    status,
  };
  return result;
}

static enum iterate_kit_status reserve_callback_budget(
    struct iterate_kit_metrics *metrics,
    struct iterate_kit_metrics_subscription *subscription) {
  enum iterate_kit_status status;
  if (metrics->options.callback_budget == NULL) {
    return ITERATE_KIT_OK;
  }
  status = iterate_kit_callback_budget_acquire(
      metrics->options.callback_budget);
  if (status == ITERATE_KIT_OK) {
    subscription->callback_budget_reserved = true;
  }
  return status;
}

static bool release_callback_budget(
    struct iterate_kit_metrics *metrics,
    struct iterate_kit_metrics_subscription *subscription) {
  if (!subscription->callback_budget_reserved) {
    return true;
  }
  subscription->callback_budget_reserved = false;
  if (metrics->options.callback_budget == NULL ||
      iterate_kit_callback_budget_release(
          metrics->options.callback_budget) != ITERATE_KIT_OK) {
    /*
     * Budget underflow is profile accounting corruption. Preserve it as a
     * module failure instead of allowing the next poll to exceed the transport
     * burst that the device proved safe.
     */
    metrics->pending_result = (struct iterate_kit_poll_result){
      ITERATE_KIT_POLL_DRIVER_ERROR,
      CAPNWEB_OK,
    };
    return false;
  }
  return true;
}

static struct capnweb_expression integer_expression(int64_t value) {
  struct capnweb_expression expression = {0};
  expression.kind = CAPNWEB_EXPRESSION_INT64;
  expression.value.integer = value;
  return expression;
}

struct metrics_expression_workspace {
  /*
   * Expressions point into this aggregate and into the driver sample. Cap'n
   * Web serializes call expressions during call construction; retaining these
   * pointers after poll returns would be invalid. A single aggregate makes the
   * lifetime and stack budget reviewable instead of scattering VLAs/helpers.
   */
  struct capnweb_expression root_values[8];
  struct capnweb_object_field root_fields[9];
  struct capnweb_expression capture_values[3];
  struct capnweb_object_field capture_fields[3];
  struct capnweb_expression capture_object;
  struct capnweb_expression uplink_values[21];
  struct capnweb_object_field uplink_fields[21];
  struct capnweb_expression uplink_object;
  struct capnweb_expression downlink_values[5];
  struct capnweb_object_field downlink_fields[5];
  struct capnweb_expression downlink_object;
  struct capnweb_expression playback_values[6];
  struct capnweb_object_field playback_fields[6];
  struct capnweb_expression playback_object;
  struct capnweb_expression protocol_failures;
  /*
   * Each buffer is a discriminated public object. Keeping the workspace on the
   * polling task's stack avoids permanent RAM and cross-subscriber lifetime
   * state; the size gate below makes that choice an explicit stack budget.
   */
  struct {
    struct capnweb_expression values[4];
    struct capnweb_object_field fields[4];
    struct capnweb_expression object;
  } buffer_values[5];
  struct capnweb_object_field buffer_fields[5];
  struct capnweb_expression buffers_object;
  struct capnweb_object_field audio_fields[6];
  struct capnweb_expression audio_object;
  struct capnweb_expression root_object;
};

_Static_assert(
    sizeof(struct metrics_expression_workspace) <= 4096U,
    "one metrics callback must use at most 4 KiB of host stack workspace");

enum {
  PLAYBACK_VIEW_PLAYBACK_FIELD_COUNT = 35,
  PLAYBACK_VIEW_RUNTIME_FIELD_COUNT = 19,
  AEC_VIEW_FIELD_COUNT = 24,
  RAW_CLEAN_AEC_VIEW_FIELD_COUNT = 21,
};

struct playback_metrics_expression_workspace {
  /*
   * This view is intentionally flat inside two semantic groups. Repeating a
   * `playback_` prefix on every key would spend hundreds of bytes in every
   * callback and reserve no extra diagnostic value; splitting timing into a
   * third object would add expression workspace and more wire punctuation.
   * The public TypeScript adapter supplies the longer flattened names used by
   * retained evidence files.
   */
  struct capnweb_expression root_values[4];
  struct capnweb_object_field root_fields[6];
  struct capnweb_expression
      playback_values[PLAYBACK_VIEW_PLAYBACK_FIELD_COUNT];
  struct capnweb_object_field
      playback_fields[PLAYBACK_VIEW_PLAYBACK_FIELD_COUNT];
  struct capnweb_expression playback_object;
  struct capnweb_expression
      runtime_values[PLAYBACK_VIEW_RUNTIME_FIELD_COUNT];
  struct capnweb_object_field
      runtime_fields[PLAYBACK_VIEW_RUNTIME_FIELD_COUNT];
  struct capnweb_expression runtime_object;
  struct capnweb_expression root_object;
};

struct aec_metrics_expression_workspace {
  /*
   * This diagnostic is deliberately flat: every value belongs to one exact
   * signal window, so nested signal/timing objects would add punctuation and
   * stack workspace without clarifying lifetime. The compile-time count and
   * maximum-width wire test make future schema growth explicit.
   */
  struct capnweb_expression values[AEC_VIEW_FIELD_COUNT];
  struct capnweb_object_field fields[AEC_VIEW_FIELD_COUNT];
  struct capnweb_expression root_object;
};

struct raw_clean_aec_metrics_expression_workspace {
  /*
   * This view deliberately has its own workspace rather than forcing absent
   * reference/DSP fields through the three-tap serializer. The topology is
   * part of the wire value, while the union below means supporting it costs no
   * permanent RAM and does not increase the metrics task's worst-case stack.
   */
  struct capnweb_expression values[RAW_CLEAN_AEC_VIEW_FIELD_COUNT];
  struct capnweb_object_field fields[RAW_CLEAN_AEC_VIEW_FIELD_COUNT];
  struct capnweb_expression root_object;
};

union any_metrics_expression_workspace {
  /*
   * Only one callback expression exists at a time. Cap'n Web serializes it
   * synchronously while constructing the outgoing call, so a union keeps the
   * polling task's worst-case stack equal to the larger view instead of adding
   * both. There is still one coherent driver sample behind every subscriber.
   */
  struct metrics_expression_workspace general;
  struct playback_metrics_expression_workspace playback;
  struct aec_metrics_expression_workspace aec;
  struct raw_clean_aec_metrics_expression_workspace raw_clean_aec;
};

_Static_assert(
    sizeof(union any_metrics_expression_workspace) <= 4096U,
    "either metrics callback view must use at most 4 KiB of stack workspace");

static void set_integer_field(
    struct capnweb_expression *value,
    struct capnweb_object_field *field,
    const char *key,
    size_t key_length,
    int64_t integer) {
  *value = integer_expression(integer);
  *field = (struct capnweb_object_field){
    {key, key_length},
    value,
  };
}

static void set_string_field(
    struct capnweb_expression *value,
    struct capnweb_object_field *field,
    const char *key,
    size_t key_length,
    const char *string) {
  const char *const safe_string =
      string == NULL ? "none" : string;
  *value = (struct capnweb_expression){
    .kind = CAPNWEB_EXPRESSION_STRING,
    .value.string = {safe_string, strlen(safe_string)},
  };
  *field = (struct capnweb_object_field){
    {key, key_length},
    value,
  };
}

static void set_object(
    struct capnweb_expression *object,
    struct capnweb_object_field *fields,
    size_t count) {
  *object = (struct capnweb_expression){
    .kind = CAPNWEB_EXPRESSION_OBJECT,
    .value.object = {fields, count},
  };
}

static void set_object_field(
    struct capnweb_object_field *field,
    const char *key,
    size_t key_length,
    const struct capnweb_expression *object) {
  *field = (struct capnweb_object_field){
    {key, key_length},
    object,
  };
}

static const char *buffer_evidence_name(
    enum iterate_kit_buffer_metric_evidence evidence) {
  switch (evidence) {
    case ITERATE_KIT_BUFFER_OBSERVED:
      return "observed";
    case ITERATE_KIT_BUFFER_DERIVED_BOUND:
      return "derivedBound";
    case ITERATE_KIT_BUFFER_CAPACITY_ONLY:
      return "capacityOnly";
    case ITERATE_KIT_BUFFER_UNAVAILABLE:
      return "unavailable";
  }
  return NULL;
}

static bool build_buffer_expression(
    const struct iterate_kit_buffer_metrics *metrics,
    struct capnweb_expression values[4],
    struct capnweb_object_field fields[4],
    struct capnweb_expression *object) {
  const char *const evidence =
      buffer_evidence_name(metrics->evidence);
  if (evidence == NULL) {
    /*
     * Do not coerce an invalid driver enum to UNAVAILABLE. That fallback would
     * turn a firmware defect into apparently honest missing telemetry and make
     * the public diagnostic stream contradict local state.
     */
    return false;
  }
  set_string_field(
      &values[0],
      &fields[0],
      "evidence",
      sizeof("evidence") - 1U,
      evidence);
  /*
   * These names deliberately omit a repeated "Bytes" suffix. The containing
   * buffer contract already fixes the unit, while spelling it out on all
   * eighteen numeric fields pushes the valid worst-case callback beyond the
   * 2 KiB control slot. Enlarging that slot would reserve another 2 KiB across
   * the fixed inbox/outbox rings on every device. Keep the wire form compact
   * and put the unit in the type/documentation instead.
   */
  set_integer_field(
      &values[1],
      &fields[1],
      "current",
      sizeof("current") - 1U,
      metrics->current_bytes);
  set_integer_field(
      &values[2],
      &fields[2],
      "highWater",
      sizeof("highWater") - 1U,
      metrics->high_water_bytes);
  set_integer_field(
      &values[3],
      &fields[3],
      "capacity",
      sizeof("capacity") - 1U,
      metrics->capacity_bytes);
  set_object(object, fields, 4U);
  return true;
}

static bool build_buffers_expression(
    const struct iterate_kit_metrics_sample *sample,
    struct metrics_expression_workspace *workspace) {
  const struct iterate_kit_buffer_metrics *const metrics[] = {
    &sample->audio.buffers.uplink_application,
    &sample->audio.buffers.websocket_transmitter,
    &sample->audio.buffers.lwip_send,
    &sample->audio.buffers.tls_egress,
    &sample->audio.buffers.wifi_egress,
  };
  static const struct capnweb_string names[] = {
    {"uplinkApplication", sizeof("uplinkApplication") - 1U},
    {"websocketTransmitter",
     sizeof("websocketTransmitter") - 1U},
    {"lwipSend", sizeof("lwipSend") - 1U},
    {"tlsEgress", sizeof("tlsEgress") - 1U},
    {"wifiEgress", sizeof("wifiEgress") - 1U},
  };
  size_t index;
  _Static_assert(
      sizeof(metrics) / sizeof(metrics[0]) ==
          sizeof(names) / sizeof(names[0]),
      "every buffer sample needs one stable public name");
  for (index = 0U;
       index < sizeof(metrics) / sizeof(metrics[0]);
       ++index) {
    if (!build_buffer_expression(
            metrics[index],
            workspace->buffer_values[index].values,
            workspace->buffer_values[index].fields,
            &workspace->buffer_values[index].object)) {
      return false;
    }
    workspace->buffer_fields[index] =
        (struct capnweb_object_field){
          names[index],
          &workspace->buffer_values[index].object,
        };
  }
  set_object(
      &workspace->buffers_object,
      workspace->buffer_fields,
      sizeof(workspace->buffer_fields) /
          sizeof(workspace->buffer_fields[0]));
  return true;
}

static bool build_audio_expression(
    const struct iterate_kit_metrics_sample *sample,
    struct metrics_expression_workspace *workspace) {
  size_t audio_count = 0U;
  set_integer_field(
      &workspace->capture_values[0],
      &workspace->capture_fields[0],
      "sent",
      4U,
      sample->audio.capture.sent);
  set_integer_field(
      &workspace->capture_values[1],
      &workspace->capture_fields[1],
      "dropped",
      7U,
      sample->audio.capture.dropped);
  set_integer_field(
      &workspace->capture_values[2],
      &workspace->capture_fields[2],
      "failures",
      8U,
      sample->audio.capture.failures);
  set_object(
      &workspace->capture_object,
      workspace->capture_fields,
      sizeof(workspace->capture_fields) /
          sizeof(workspace->capture_fields[0]));

  set_integer_field(
      &workspace->uplink_values[0],
      &workspace->uplink_fields[0],
      "sent",
      4U,
      sample->audio.uplink.sent);
  set_integer_field(
      &workspace->uplink_values[1],
      &workspace->uplink_fields[1],
      "dropped",
      7U,
      sample->audio.uplink.dropped);
  set_integer_field(
      &workspace->uplink_values[2],
      &workspace->uplink_fields[2],
      "depth",
      5U,
      sample->audio.uplink.depth);
  set_integer_field(
      &workspace->uplink_values[3],
      &workspace->uplink_fields[3],
      "highWater",
      9U,
      sample->audio.uplink.high_water);
  set_integer_field(
      &workspace->uplink_values[4],
      &workspace->uplink_fields[4],
      "sendDeferrals",
      13U,
      sample->audio.uplink.send_deferrals);
  set_integer_field(
      &workspace->uplink_values[5],
      &workspace->uplink_fields[5],
      "consecutiveSendDeferrals",
      24U,
      sample->audio.uplink.consecutive_send_deferrals);
  set_integer_field(
      &workspace->uplink_values[6],
      &workspace->uplink_fields[6],
      "maximumConsecutiveSendDeferrals",
      31U,
      sample->audio.uplink.maximum_consecutive_send_deferrals);
  set_integer_field(
      &workspace->uplink_values[7],
      &workspace->uplink_fields[7],
      "failures",
      8U,
      sample->audio.uplink.failures);
  set_integer_field(
      &workspace->uplink_values[8],
      &workspace->uplink_fields[8],
      "restartIncidents",
      sizeof("restartIncidents") - 1U,
      sample->audio.uplink.restart_incidents);
  set_integer_field(
      &workspace->uplink_values[9],
      &workspace->uplink_fields[9],
      "inPlaceFreshnessRecoveries",
      sizeof("inPlaceFreshnessRecoveries") - 1U,
      sample->audio.uplink.in_place_freshness_recoveries);
  set_integer_field(
      &workspace->uplink_values[10],
      &workspace->uplink_fields[10],
      "socketRestarts",
      sizeof("socketRestarts") - 1U,
      sample->audio.uplink.socket_restarts);
  set_integer_field(
      &workspace->uplink_values[11],
      &workspace->uplink_fields[11],
      "producerBackpressureRestarts",
      sizeof("producerBackpressureRestarts") - 1U,
      sample->audio.uplink.producer_backpressure_restarts);
  set_integer_field(
      &workspace->uplink_values[12],
      &workspace->uplink_fields[12],
      "transportDisconnectRestarts",
      sizeof("transportDisconnectRestarts") - 1U,
      sample->audio.uplink.transport_disconnect_restarts);
  set_integer_field(
      &workspace->uplink_values[13],
      &workspace->uplink_fields[13],
      "noProgressTimeoutRestarts",
      sizeof("noProgressTimeoutRestarts") - 1U,
      sample->audio.uplink.no_progress_timeout_restarts);
  set_integer_field(
      &workspace->uplink_values[14],
      &workspace->uplink_fields[14],
      "frameSendTimeoutRestarts",
      sizeof("frameSendTimeoutRestarts") - 1U,
      sample->audio.uplink.frame_send_timeout_restarts);
  set_integer_field(
      &workspace->uplink_values[15],
      &workspace->uplink_fields[15],
      "captureStaleRestarts",
      sizeof("captureStaleRestarts") - 1U,
      sample->audio.uplink.capture_stale_restarts);
  set_integer_field(
      &workspace->uplink_values[16],
      &workspace->uplink_fields[16],
      "lastTransportAcceptAgeMs",
      sizeof("lastTransportAcceptAgeMs") - 1U,
      sample->audio.uplink.last_transport_accept_age_ms);
  set_integer_field(
      &workspace->uplink_values[17],
      &workspace->uplink_fields[17],
      "maximumTransportAcceptAgeMs",
      sizeof("maximumTransportAcceptAgeMs") - 1U,
      sample->audio.uplink.maximum_transport_accept_age_ms);
  set_integer_field(
      &workspace->uplink_values[18],
      &workspace->uplink_fields[18],
      "lastRestartOldestCaptureAgeMs",
      sizeof("lastRestartOldestCaptureAgeMs") - 1U,
      sample->audio.uplink.last_restart_oldest_capture_age_ms);
  set_string_field(
      &workspace->uplink_values[19],
      &workspace->uplink_fields[19],
      "lastRestartReason",
      sizeof("lastRestartReason") - 1U,
      sample->audio.uplink.last_restart_reason);
  set_integer_field(
      &workspace->uplink_values[20],
      &workspace->uplink_fields[20],
      "lastRestartFramesDiscarded",
      sizeof("lastRestartFramesDiscarded") - 1U,
      sample->audio.uplink.last_restart_frames_discarded);
  set_object(
      &workspace->uplink_object,
      workspace->uplink_fields,
      sizeof(workspace->uplink_fields) /
          sizeof(workspace->uplink_fields[0]));

  set_integer_field(
      &workspace->downlink_values[0],
      &workspace->downlink_fields[0],
      "received",
      8U,
      sample->audio.downlink.received);
  set_integer_field(
      &workspace->downlink_values[1],
      &workspace->downlink_fields[1],
      "dropped",
      7U,
      sample->audio.downlink.dropped);
  set_integer_field(
      &workspace->downlink_values[2],
      &workspace->downlink_fields[2],
      "depth",
      5U,
      sample->audio.downlink.depth);
  set_integer_field(
      &workspace->downlink_values[3],
      &workspace->downlink_fields[3],
      "highWater",
      9U,
      sample->audio.downlink.high_water);
  set_integer_field(
      &workspace->downlink_values[4],
      &workspace->downlink_fields[4],
      "failures",
      8U,
      sample->audio.downlink.failures);
  set_object(
      &workspace->downlink_object,
      workspace->downlink_fields,
      sizeof(workspace->downlink_fields) /
          sizeof(workspace->downlink_fields[0]));

  set_object_field(
      &workspace->audio_fields[audio_count++],
      "capture",
      7U,
      &workspace->capture_object);
  set_object_field(
      &workspace->audio_fields[audio_count++],
      "uplink",
      6U,
      &workspace->uplink_object);
  set_object_field(
      &workspace->audio_fields[audio_count++],
      "downlink",
      8U,
      &workspace->downlink_object);
  if (sample->audio.has_playback) {
    set_integer_field(
        &workspace->playback_values[0],
        &workspace->playback_fields[0],
        "submitted",
        9U,
        sample->audio.playback.submitted);
    set_integer_field(
        &workspace->playback_values[1],
        &workspace->playback_fields[1],
        "completed",
        9U,
        sample->audio.playback.completed);
    set_integer_field(
        &workspace->playback_values[2],
        &workspace->playback_fields[2],
        "flushed",
        7U,
        sample->audio.playback.flushed);
    set_integer_field(
        &workspace->playback_values[3],
        &workspace->playback_fields[3],
        "depth",
        5U,
        sample->audio.playback.depth);
    set_integer_field(
        &workspace->playback_values[4],
        &workspace->playback_fields[4],
        "highWater",
        9U,
        sample->audio.playback.high_water);
    set_integer_field(
        &workspace->playback_values[5],
        &workspace->playback_fields[5],
        "failures",
        8U,
        sample->audio.playback.failures);
    set_object(
        &workspace->playback_object,
        workspace->playback_fields,
        sizeof(workspace->playback_fields) /
            sizeof(workspace->playback_fields[0]));
    set_object_field(
        &workspace->audio_fields[audio_count++],
        "playback",
        8U,
        &workspace->playback_object);
  }
  set_integer_field(
      &workspace->protocol_failures,
      &workspace->audio_fields[audio_count++],
      "protocolFailures",
      16U,
      sample->audio.protocol_failures);
  if (sample->audio.has_buffers) {
    if (!build_buffers_expression(sample, workspace)) {
      return false;
    }
    set_object_field(
        &workspace->audio_fields[audio_count],
        "buffers",
        sizeof("buffers") - 1U,
        &workspace->buffers_object);
    ++audio_count;
  }
  set_object(
      &workspace->audio_object,
      workspace->audio_fields,
      audio_count);
  return true;
}

static bool build_metrics_expression(
    const struct iterate_kit_metrics_sample *sample,
    struct metrics_expression_workspace *workspace) {
  size_t root_count = 8U;
  set_integer_field(
      &workspace->root_values[0],
      &workspace->root_fields[0],
      "uptimeMs",
      8U,
      sample->uptime_ms);
  set_integer_field(
      &workspace->root_values[1],
      &workspace->root_fields[1],
      "freeHeapBytes",
      13U,
      sample->free_heap_bytes);
  set_integer_field(
      &workspace->root_values[2],
      &workspace->root_fields[2],
      "minimumFreeHeapBytes",
      20U,
      sample->minimum_free_heap_bytes);
  set_integer_field(
      &workspace->root_values[3],
      &workspace->root_fields[3],
      "freeInternalHeapBytes",
      21U,
      sample->free_internal_heap_bytes);
  set_integer_field(
      &workspace->root_values[4],
      &workspace->root_fields[4],
      "minimumFreeInternalHeapBytes",
      28U,
      sample->minimum_free_internal_heap_bytes);
  set_integer_field(
      &workspace->root_values[5],
      &workspace->root_fields[5],
      "freePsramBytes",
      14U,
      sample->free_psram_bytes);
  set_integer_field(
      &workspace->root_values[6],
      &workspace->root_fields[6],
      "taskStackHighWaterBytes",
      23U,
      sample->task_stack_high_water_bytes);
  set_integer_field(
      &workspace->root_values[7],
      &workspace->root_fields[7],
      "cpuPermille",
      11U,
      sample->cpu_permille);
  if (sample->has_audio) {
    if (!build_audio_expression(sample, workspace)) {
      return false;
    }
    set_object_field(
        &workspace->root_fields[root_count],
        "audio",
        5U,
        &workspace->audio_object);
    ++root_count;
  }
  set_object(
      &workspace->root_object,
      workspace->root_fields,
      root_count);
  return true;
}

static bool build_playback_metrics_expression(
    const struct iterate_kit_metrics_sample *sample,
    struct playback_metrics_expression_workspace *workspace) {
  const struct iterate_kit_playback_metrics_sample *const detail =
      &sample->playback_detail;
  size_t playback_count = 0U;
  size_t runtime_count = 0U;
  if (!sample->has_playback_detail || detail->schema_version == 0U) {
    /*
     * Publishing a zero-filled detail object from a platform that did not opt
     * in would turn missing instrumentation into a clean endurance result.
     * Fail before opening any callback message so the caller sees a bounded,
     * retryable driver defect instead of plausible but false evidence.
     */
    return false;
  }

#define SET_PLAYBACK_INTEGER(public_name, member)                         \
  do {                                                                   \
    if (playback_count >= PLAYBACK_VIEW_PLAYBACK_FIELD_COUNT) {          \
      return false;                                                      \
    }                                                                    \
    set_integer_field(                                                   \
        &workspace->playback_values[playback_count],                     \
        &workspace->playback_fields[playback_count],                     \
        public_name,                                                     \
        sizeof(public_name) - 1U,                                        \
        detail->playback.member);                                        \
    ++playback_count;                                                     \
  } while (0)

  SET_PLAYBACK_INTEGER("submitted", submitted);
  SET_PLAYBACK_INTEGER("completed", completed);
  SET_PLAYBACK_INTEGER(
      "generationFramesFlushed", generation_frames_flushed);
  SET_PLAYBACK_INTEGER(
      "freshnessFramesDropped", freshness_frames_dropped);
  SET_PLAYBACK_INTEGER(
      "partialPrebufferFramesDropped",
      partial_prebuffer_frames_dropped);
  SET_PLAYBACK_INTEGER(
      "underrunFramesFlushed", underrun_frames_flushed);
  SET_PLAYBACK_INTEGER("underrunIncidents", underrun_incidents);
  SET_PLAYBACK_INTEGER(
      "underrunSilenceFramesSubmitted",
      underrun_silence_frames_submitted);
  SET_PLAYBACK_INTEGER(
      "underrunSilenceFramesCompleted",
      underrun_silence_frames_completed);
  SET_PLAYBACK_INTEGER(
      "underrunSilenceFramesRetired",
      underrun_silence_frames_retired);
  SET_PLAYBACK_INTEGER(
      "underrunLateFramesDropped",
      underrun_late_frames_dropped);
  SET_PLAYBACK_INTEGER(
      "dmaDeadlineMissIncidents", dma_deadline_miss_incidents);
  SET_PLAYBACK_INTEGER("freshnessIncidents", freshness_incidents);
  SET_PLAYBACK_INTEGER(
      "partialPrebufferIncidents", partial_prebuffer_incidents);
  SET_PLAYBACK_INTEGER(
      "endOfStreamMarkersConsumed",
      end_of_stream_markers_consumed);
  SET_PLAYBACK_INTEGER(
      "endOfStreamResponses", end_of_stream_responses);
  SET_PLAYBACK_INTEGER(
      "endOfStreamSilenceDescriptors",
      end_of_stream_silence_descriptors);
  SET_PLAYBACK_INTEGER(
      "endOfStreamPaddingDescriptorsCompleted",
      end_of_stream_padding_descriptors_completed);
  SET_PLAYBACK_INTEGER(
      "driverQueueOverflowIncidents",
      driver_queue_overflow_incidents);
  SET_PLAYBACK_INTEGER("driverFailures", driver_failures);
  SET_PLAYBACK_INTEGER("driverStopFailures", driver_stop_failures);
  SET_PLAYBACK_INTEGER("fatalFramesFlushed", fatal_frames_flushed);
  SET_PLAYBACK_INTEGER(
      "writeBackpressureIncidents", write_backpressure_incidents);
  SET_PLAYBACK_INTEGER(
      "writeBackpressureDestructiveResets",
      write_backpressure_destructive_resets);
  SET_PLAYBACK_INTEGER(
      "writeBackpressureFramesDropped",
      write_backpressure_frames_dropped);
  SET_PLAYBACK_INTEGER("invalidFrames", invalid_frames);
  SET_PLAYBACK_INTEGER("stateErrors", state_errors);
  SET_PLAYBACK_INTEGER(
      "ownerClockRegressions", owner_clock_regressions);
  SET_PLAYBACK_INTEGER(
      "receiveToDmaStartSamples",
      receive_to_dma_start_samples);
  SET_PLAYBACK_INTEGER(
      "maximumReceiveToDmaStartMs",
      maximum_receive_to_dma_start_ms);
  SET_PLAYBACK_INTEGER(
      "downlinkInterarrivalSamples",
      downlink_interarrival_samples);
  SET_PLAYBACK_INTEGER(
      "maximumDownlinkInterarrivalMs",
      maximum_downlink_interarrival_ms);
  SET_PLAYBACK_INTEGER(
      "maximumEofToSuccessfulRefillUs",
      maximum_eof_to_successful_refill_us);
  SET_PLAYBACK_INTEGER(
      "maximumWriteCallDurationUs",
      maximum_write_call_duration_us);
  SET_PLAYBACK_INTEGER(
      "minimumReuseLeadAtSuccessfulRefillUs",
      minimum_reuse_lead_at_successful_refill_us);
#undef SET_PLAYBACK_INTEGER

#define SET_RUNTIME_INTEGER(public_name, member)                          \
  do {                                                                   \
    if (runtime_count >= PLAYBACK_VIEW_RUNTIME_FIELD_COUNT) {            \
      return false;                                                      \
    }                                                                    \
    set_integer_field(                                                   \
        &workspace->runtime_values[runtime_count],                       \
        &workspace->runtime_fields[runtime_count],                       \
        public_name,                                                     \
        sizeof(public_name) - 1U,                                        \
        detail->runtime.member);                                         \
    ++runtime_count;                                                      \
  } while (0)

  SET_RUNTIME_INTEGER(
      "audioOwnerStackHeadroomBytes",
      audio_owner_stack_headroom_bytes);
  SET_RUNTIME_INTEGER(
      "mainStackHeadroomBytes", main_stack_headroom_bytes);
  SET_RUNTIME_INTEGER(
      "controlNetworkStackHeadroomBytes",
      control_network_stack_headroom_bytes);
  SET_RUNTIME_INTEGER(
      "pcmNetworkStackHeadroomBytes",
      pcm_network_stack_headroom_bytes);
  SET_RUNTIME_INTEGER(
      "freeInternalHeapBytes", free_internal_heap_bytes);
  SET_RUNTIME_INTEGER(
      "minimumFreeInternalHeapBytes",
      minimum_free_internal_heap_bytes);
  SET_RUNTIME_INTEGER("freeDmaHeapBytes", free_dma_heap_bytes);
  SET_RUNTIME_INTEGER(
      "minimumFreeDmaHeapBytes", minimum_free_dma_heap_bytes);
  SET_RUNTIME_INTEGER(
      "largestFreeInternalHeapBlockBytes",
      largest_free_internal_heap_block_bytes);
  SET_RUNTIME_INTEGER(
      "largestFreeDmaBlockBytes",
      largest_free_dma_block_bytes);
  SET_RUNTIME_INTEGER("cpuPermille", cpu_permille);
  SET_RUNTIME_INTEGER(
      "generationFenceAcknowledgementTimeouts",
      generation_fence_acknowledgement_timeouts);
  SET_RUNTIME_INTEGER(
      "lifecycleAcknowledgementTimeouts",
      lifecycle_acknowledgement_timeouts);
  SET_RUNTIME_INTEGER(
      "controlNetworkStackExhaustions",
      control_network_stack_exhaustions);
  SET_RUNTIME_INTEGER(
      "pcmNetworkStackExhaustions",
      pcm_network_stack_exhaustions);
  SET_RUNTIME_INTEGER(
      "pcmReceiveCalls", pcm_receive_calls);
  SET_RUNTIME_INTEGER(
      "pcmReceiveChunks", pcm_receive_chunks);
  SET_RUNTIME_INTEGER(
      "controlNetworkMaximumWorkCycles",
      control_network_max_work_cycles);
  SET_RUNTIME_INTEGER(
      "pcmNetworkMaximumWorkCycles",
      pcm_network_max_work_cycles);
#undef SET_RUNTIME_INTEGER

  if (playback_count != PLAYBACK_VIEW_PLAYBACK_FIELD_COUNT ||
      runtime_count != PLAYBACK_VIEW_RUNTIME_FIELD_COUNT) {
    /*
     * Every macro guards before writing, so growing the schema without growing
     * its named capacity fails safely instead of corrupting the polling-task
     * stack. Requiring exact counts in the other direction prevents reserving
     * forgotten/dead slots. The old check happened only after all writes and
     * therefore detected overflow after memory had already been overwritten.
     */
    return false;
  }
  set_object(
      &workspace->playback_object,
      workspace->playback_fields,
      playback_count);
  set_object(
      &workspace->runtime_object,
      workspace->runtime_fields,
      runtime_count);

  set_integer_field(
      &workspace->root_values[0],
      &workspace->root_fields[0],
      "schemaVersion",
      sizeof("schemaVersion") - 1U,
      detail->schema_version);
  set_integer_field(
      &workspace->root_values[1],
      &workspace->root_fields[1],
      "sequence",
      sizeof("sequence") - 1U,
      detail->sequence);
  set_integer_field(
      &workspace->root_values[2],
      &workspace->root_fields[2],
      "producedAtMs",
      sizeof("producedAtMs") - 1U,
      detail->produced_at_ms);
  set_integer_field(
      &workspace->root_values[3],
      &workspace->root_fields[3],
      "downlinkAccepted",
      sizeof("downlinkAccepted") - 1U,
      detail->downlink_accepted);
  set_object_field(
      &workspace->root_fields[4],
      "playback",
      sizeof("playback") - 1U,
      &workspace->playback_object);
  set_object_field(
      &workspace->root_fields[5],
      "runtime",
      sizeof("runtime") - 1U,
      &workspace->runtime_object);
  set_object(
      &workspace->root_object,
      workspace->root_fields,
      sizeof(workspace->root_fields) /
          sizeof(workspace->root_fields[0]));
  return true;
}

static bool build_aec_metrics_expression(
    const struct iterate_kit_metrics_sample *sample,
    struct aec_metrics_expression_workspace *workspace) {
  const struct iterate_kit_aec_metrics_sample *const detail =
      &sample->aec_detail;
  size_t count = 0U;
  if (!sample->has_aec_detail || detail->schema_version == 0U ||
      detail->sample_stride == 0U ||
      detail->window_started_at_ms > detail->produced_at_ms) {
    /*
     * Zero-filled signal data is actively dangerous: it would say that a quiet
     * clean channel proved AEC suppression when the platform never measured a
     * sample. Reject malformed platform evidence before opening a callback
     * message, preserving a visible driver failure instead of a false pass.
     */
    return false;
  }

#define SET_AEC_INTEGER(public_name, member)                               \
  do {                                                                    \
    if (count >= AEC_VIEW_FIELD_COUNT) {                                  \
      return false;                                                       \
    }                                                                     \
    set_integer_field(                                                    \
        &workspace->values[count],                                        \
        &workspace->fields[count],                                        \
        public_name,                                                      \
        sizeof(public_name) - 1U,                                         \
        detail->member);                                                  \
    ++count;                                                              \
  } while (0)

  SET_AEC_INTEGER("schemaVersion", schema_version);
  SET_AEC_INTEGER("sequence", sequence);
  SET_AEC_INTEGER("windowStartedAtMs", window_started_at_ms);
  SET_AEC_INTEGER("producedAtMs", produced_at_ms);
  SET_AEC_INTEGER("sampleStride", sample_stride);
  SET_AEC_INTEGER("sampledSamples", sampled_samples);
  SET_AEC_INTEGER("nearPeak", near_peak);
  SET_AEC_INTEGER("referencePeak", reference_peak);
  SET_AEC_INTEGER("cleanPeak", clean_peak);
  SET_AEC_INTEGER("nearMeanAbsolute", near_mean_absolute);
  SET_AEC_INTEGER("referenceMeanAbsolute", reference_mean_absolute);
  SET_AEC_INTEGER("cleanMeanAbsolute", clean_mean_absolute);
  SET_AEC_INTEGER(
      "lifetimeFramesProcessed", lifetime_frames_processed);
  SET_AEC_INTEGER("lifetimeRecreates", lifetime_recreates);
  SET_AEC_INTEGER(
      "lifetimeRecreateFailures", lifetime_recreate_failures);
  SET_AEC_INTEGER("lastLinearUs", last_linear_us);
  SET_AEC_INTEGER("maximumLinearUs", maximum_linear_us);
  SET_AEC_INTEGER("lastNlpUs", last_nlp_us);
  SET_AEC_INTEGER("maximumNlpUs", maximum_nlp_us);
  SET_AEC_INTEGER("lastCaptureToUplinkUs", last_capture_to_uplink_us);
  SET_AEC_INTEGER(
      "maximumCaptureToUplinkUs", maximum_capture_to_uplink_us);
  SET_AEC_INTEGER(
      "lifetimeCaptureReserveDroppedChunks",
      lifetime_capture_reserve_dropped_chunks);
  SET_AEC_INTEGER(
      "lifetimeCaptureBridgeErrors", lifetime_capture_bridge_errors);
  SET_AEC_INTEGER(
      "lifetimeSignalMeasurementFailures",
      lifetime_signal_measurement_failures);
#undef SET_AEC_INTEGER

  if (count != AEC_VIEW_FIELD_COUNT) {
    return false;
  }
  set_object(&workspace->root_object, workspace->fields, count);
  return true;
}

static bool build_raw_clean_aec_metrics_expression(
    const struct iterate_kit_metrics_sample *sample,
    struct raw_clean_aec_metrics_expression_workspace *workspace) {
  const struct iterate_kit_raw_clean_aec_metrics_sample *const detail =
      &sample->raw_clean_aec_detail;
  size_t count = 0U;
  if (!sample->has_raw_clean_aec_detail ||
      detail->schema_version != 3U ||
      detail->sample_stride == 0U ||
      detail->window_started_at_ms > detail->produced_at_ms) {
    /*
     * A zero sample would look like perfect echo removal. Reject incomplete
     * evidence before opening a callback message so instrumentation failure is
     * visible rather than silently improving the reported AEC result.
     */
    return false;
  }

#define SET_RAW_CLEAN_AEC_INTEGER(public_name, member)                    \
  do {                                                                    \
    if (count >= RAW_CLEAN_AEC_VIEW_FIELD_COUNT) {                        \
      return false;                                                       \
    }                                                                     \
    set_integer_field(                                                    \
        &workspace->values[count],                                        \
        &workspace->fields[count],                                        \
        public_name,                                                      \
        sizeof(public_name) - 1U,                                         \
        detail->member);                                                  \
    ++count;                                                              \
  } while (0)

  SET_RAW_CLEAN_AEC_INTEGER("schemaVersion", schema_version);
  set_string_field(
      &workspace->values[count],
      &workspace->fields[count],
      "topology",
      sizeof("topology") - 1U,
      "raw-clean");
  ++count;
  SET_RAW_CLEAN_AEC_INTEGER("sequence", sequence);
  SET_RAW_CLEAN_AEC_INTEGER("windowStartedAtMs", window_started_at_ms);
  SET_RAW_CLEAN_AEC_INTEGER("producedAtMs", produced_at_ms);
  SET_RAW_CLEAN_AEC_INTEGER("sampleStride", sample_stride);
  SET_RAW_CLEAN_AEC_INTEGER("sampledSamples", sampled_samples);
  SET_RAW_CLEAN_AEC_INTEGER("rawPeak", raw_peak);
  SET_RAW_CLEAN_AEC_INTEGER("cleanPeak", clean_peak);
  SET_RAW_CLEAN_AEC_INTEGER("rawMeanAbsolute", raw_mean_absolute);
  SET_RAW_CLEAN_AEC_INTEGER("cleanMeanAbsolute", clean_mean_absolute);
  SET_RAW_CLEAN_AEC_INTEGER("rawAbsoluteSum", raw_absolute_sum);
  SET_RAW_CLEAN_AEC_INTEGER("cleanAbsoluteSum", clean_absolute_sum);
  SET_RAW_CLEAN_AEC_INTEGER(
      "playbackContentSamples", playback_content_samples);
  SET_RAW_CLEAN_AEC_INTEGER(
      "lifetimeCaptureFrames", lifetime_capture_frames);
  SET_RAW_CLEAN_AEC_INTEGER(
      "lifetimeCleanUplinkFrames", lifetime_clean_uplink_frames);
  SET_RAW_CLEAN_AEC_INTEGER(
      "lifetimeCleanUplinkDrops", lifetime_clean_uplink_drops);
  SET_RAW_CLEAN_AEC_INTEGER(
      "lifetimeCaptureFailures", lifetime_capture_failures);
  SET_RAW_CLEAN_AEC_INTEGER(
      "lifetimeSignalMeasurementFailures",
      lifetime_signal_measurement_failures);
  SET_RAW_CLEAN_AEC_INTEGER(
      "lastCaptureToUplinkUs", last_capture_to_uplink_us);
  SET_RAW_CLEAN_AEC_INTEGER(
      "maximumCaptureToUplinkUs", maximum_capture_to_uplink_us);
#undef SET_RAW_CLEAN_AEC_INTEGER

  if (count != RAW_CLEAN_AEC_VIEW_FIELD_COUNT) {
    return false;
  }
  set_object(&workspace->root_object, workspace->fields, count);
  return true;
}

static enum capnweb_status subscribe_view(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply,
  enum iterate_kit_metrics_view view) {
  struct iterate_kit_metrics *metrics = context;
  struct capnweb_remote_capability callback = {0};
  struct iterate_kit_subscription_owner_key owner_key = {0};
  struct iterate_kit_metrics_subscription *selected = NULL;
  size_t index;
  enum capnweb_status status;
  bool arguments_valid = false;
  status = iterate_kit_read_subscription_arguments(
      metrics->options.session,
      call,
      reply,
      "expected a metrics callback capability and optional owner key",
      &callback,
      &owner_key,
      &arguments_valid);
  if (status != CAPNWEB_OK || !arguments_valid) {
    return status;
  }

  if (owner_key.present) {
    for (index = 0U;
         index < metrics->options.subscription_count;
         ++index) {
      struct iterate_kit_metrics_subscription *subscription =
          &metrics->options.subscriptions[index];
      if (!iterate_kit_subscription_owner_keys_equal(
              &subscription->owner_key, &owner_key)) {
        continue;
      }
      if (subscription->call_in_flight || subscription->release_pending) {
        status = capnweb_session_release_remote(
            metrics->options.session, callback);
        if (status != CAPNWEB_OK) {
          return status;
        }
        return capnweb_reply_set_error(
            reply,
            "Error",
            "metrics subscription replacement is busy");
      }
      status = capnweb_session_release_remote(
          metrics->options.session, subscription->callback);
      if (status != CAPNWEB_OK) {
        (void)capnweb_session_release_remote(
            metrics->options.session, callback);
        return status;
      }
      (void)release_callback_budget(metrics, subscription);
      memset(subscription, 0, sizeof(*subscription));
      subscription->owner = metrics;
      selected = subscription;
      break;
    }
  }

  if (selected == NULL) {
    for (index = 0U;
         index < metrics->options.subscription_count;
         ++index) {
      struct iterate_kit_metrics_subscription *subscription =
          &metrics->options.subscriptions[index];
      if (!subscription->occupied &&
          !subscription->call_in_flight &&
          !subscription->release_pending) {
        selected = subscription;
        break;
      }
    }
  }

  if (selected != NULL) {
    /*
     * Taking the remote capability transfers a protocol resource into this
     * slot. Sampling immediately (next_sample_at_ms = 0) gives a subscriber
     * useful state without first waiting a full interval.
     */
    selected->callback = callback;
    selected->owner_key = owner_key;
    selected->occupied = true;
    selected->view = view;
    metrics->next_sample_at_ms = 0U;
    return capnweb_reply_set_null(reply);
  }

  /*
   * No slot took ownership, so explicitly release the imported callback before
   * reporting exhaustion. Merely returning an RPC error would leak a remote
   * capability on every retry by an over-eager client.
   */
  status = capnweb_session_release_remote(metrics->options.session, callback);
  if (status != CAPNWEB_OK) {
    return status;
  }
  return capnweb_reply_set_error(
      reply, "Error", "metrics subscription limit reached");
}

static enum capnweb_status subscribe(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  return subscribe_view(
      context, call, reply, ITERATE_KIT_METRICS_GENERAL);
}

static enum capnweb_status subscribe_playback(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  return subscribe_view(
      context, call, reply, ITERATE_KIT_METRICS_PLAYBACK);
}

static enum capnweb_status subscribe_aec(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  const struct iterate_kit_metrics *const metrics = context;
  return subscribe_view(
      context,
      call,
      reply,
      metrics != NULL && metrics->options.enable_raw_clean_aec_view
          ? ITERATE_KIT_METRICS_RAW_CLEAN_AEC
          : ITERATE_KIT_METRICS_AEC);
}

static void diagnostics_reply_released(void *context) {
  struct iterate_kit_metrics *metrics = context;
  if (metrics != NULL) {
    /*
     * Cap'n Web calls this only after the pending resolution no longer borrows
     * the caller-owned buffer (including session teardown). Until then a
     * second request must not overwrite the first request's evidence.
     */
    metrics->diagnostics_reply_in_flight = false;
  }
}

static enum capnweb_status get_diagnostics(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_metrics *metrics = context;
  struct iterate_kit_metrics_sample sample = {0};
  const struct iterate_kit_control_diagnostics_sample *diagnostics;
  enum iterate_kit_status sample_status;
  enum capnweb_status reply_status;
  int length;
  int network_length;
  size_t remaining;
  if (metrics == NULL || call == NULL || reply == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (!call->has_arguments ||
      capnweb_value_array_size(&call->arguments) != 0U) {
    return capnweb_reply_set_error(
        reply, "TypeError", "getDiagnostics expects no arguments");
  }
  if (metrics->options.diagnostics_expression_buffer == NULL ||
      metrics->options.diagnostics_expression_capacity <
          ITERATE_KIT_METRICS_DIAGNOSTICS_EXPRESSION_CAPACITY) {
    return capnweb_reply_set_error(
        reply, "Error", "control diagnostics unavailable");
  }
  if (metrics->diagnostics_reply_in_flight) {
    /*
     * One retained reply is the complete RAM budget for this rare recovery
     * path. Rejection is preferable to overwriting a response that a remote
     * peer has not pulled yet or allocating an unbounded per-call history.
     */
    return capnweb_reply_set_error(
        reply, "Error", "control diagnostics snapshot already in flight");
  }

  sample_status = metrics->options.driver.sample(
      metrics->options.driver.context, &sample);
  if (sample_status != ITERATE_KIT_OK) {
    return capnweb_reply_set_error(
        reply, "Error", "control diagnostics sampling failed");
  }
  diagnostics = &sample.control_diagnostics;
  if (!sample.has_control_diagnostics ||
      diagnostics->schema_version == 0U) {
    /*
     * Zero-filled optional state must never look like a healthy transport.
     * Profiles opt in only after wiring the platform's real retained fields.
     */
    return capnweb_reply_set_error(
        reply, "Error", "control diagnostics unavailable");
  }

  length = snprintf(
      metrics->options.diagnostics_expression_buffer,
      metrics->options.diagnostics_expression_capacity,
      "{\"schemaVersion\":%" PRIu32
      ",\"producedAtMs\":%" PRId64
      ",\"control\":{\"websocketStartAttempts\":%" PRIu32
      ",\"websocketConnections\":%" PRIu32
      ",\"websocketDisconnects\":%" PRIu32
      ",\"websocketErrors\":%" PRIu32
      ",\"wifiDisconnects\":%" PRIu32
      ",\"protocolFailures\":%" PRIu32
      ",\"receiveFailures\":%" PRIu32
      ",\"sendFailures\":%" PRIu32
      ",\"lastWifiDisconnectReason\":%" PRId32
      ",\"lastErrorGeneration\":%" PRIu32
      ",\"lastErrorType\":%" PRId32
      ",\"lastTlsError\":%" PRId32
      ",\"lastTlsStackError\":%" PRId32
      ",\"lastTransportErrno\":%" PRId32
      ",\"lastHandshakeStatusCode\":%" PRId32
      ",\"lastCloseStatusCode\":%" PRId32
      ",\"protocolFailureGeneration\":%" PRIu32
      ",\"lastApplicationCapnwebGeneration\":%" PRIu32
      ",\"lastApplicationCapnwebStatus\":%" PRId32
      ",\"lastControlReceiveStatus\":%" PRId32
      ",\"messagesSent\":%" PRIu32
      ",\"messagesDiscarded\":%" PRIu32
      ",\"inboxDiscarded\":%" PRIu32
      ",\"outboxDiscarded\":%" PRIu32
      ",\"inbox\":{\"capacitySlots\":%" PRIu32
      ",\"messagesPublished\":%" PRIu32
      ",\"messagesConsumed\":%" PRIu32
      ",\"producerBackpressure\":%" PRIu32
      ",\"highWaterSlots\":%" PRIu32
      ",\"currentSlots\":%" PRIu32 "}"
      ",\"outbox\":{\"capacitySlots\":%" PRIu32
      ",\"messagesPublished\":%" PRIu32
      ",\"messagesConsumed\":%" PRIu32
      ",\"producerBackpressure\":%" PRIu32
      ",\"highWaterSlots\":%" PRIu32
      ",\"currentSlots\":%" PRIu32 "}}",
      diagnostics->schema_version,
      diagnostics->produced_at_ms,
      diagnostics->websocket_start_attempts,
      diagnostics->websocket_connections,
      diagnostics->websocket_disconnects,
      diagnostics->websocket_errors,
      diagnostics->wifi_disconnects,
      diagnostics->protocol_failures,
      diagnostics->control_receive_failures,
      diagnostics->control_send_failures,
      diagnostics->last_wifi_disconnect_reason,
      diagnostics->last_websocket_error_generation,
      diagnostics->last_websocket_error_type,
      diagnostics->last_websocket_tls_error,
      diagnostics->last_websocket_tls_stack_error,
      diagnostics->last_websocket_transport_errno,
      diagnostics->last_websocket_handshake_status_code,
      diagnostics->last_websocket_close_status_code,
      diagnostics->protocol_failure_generation,
      diagnostics->last_application_capnweb_generation,
      diagnostics->last_application_capnweb_status,
      diagnostics->last_control_receive_status,
      diagnostics->control_messages_sent,
      diagnostics->control_messages_discarded,
      diagnostics->control_inbox_discarded,
      diagnostics->control_outbox_discarded,
      diagnostics->control_inbox.capacity_slots,
      diagnostics->control_inbox.messages_published,
      diagnostics->control_inbox.messages_consumed,
      diagnostics->control_inbox.producer_backpressure,
      diagnostics->control_inbox.high_water_slots,
      diagnostics->control_inbox.current_slots,
      diagnostics->control_outbox.capacity_slots,
      diagnostics->control_outbox.messages_published,
      diagnostics->control_outbox.messages_consumed,
      diagnostics->control_outbox.producer_backpressure,
      diagnostics->control_outbox.high_water_slots,
      diagnostics->control_outbox.current_slots);
  if (length <= 0 ||
      (size_t)length >=
          metrics->options.diagnostics_expression_capacity) {
    /*
     * This is a firmware/schema defect, not a partial snapshot. snprintf's
     * truncation is deliberately rejected before Cap'n Web can retain it.
     */
    return capnweb_reply_set_error(
        reply, "Error", "control diagnostics snapshot exceeded its budget");
  }

  /*
   * Keep the established control object's formatter untouched apart from its
   * final root brace, then append the schema-v4 sibling. This makes review of
   * the recovery contract mechanical and avoids duplicating a long format
   * string solely because RSSI is optional.
   *
   * The AP-info lookup's presence bit controls whether the numeric field
   * exists at all. A sentinel such as 0 or INT32_MIN is still a valid JSON
   * number and would be indistinguishable from measured evidence to clients.
   */
  remaining =
      metrics->options.diagnostics_expression_capacity - (size_t)length;
  if (diagnostics->network.has_wifi_rssi_dbm) {
    network_length = snprintf(
        metrics->options.diagnostics_expression_buffer + length,
        remaining,
        ",\"network\":{\"wifiConnected\":%s"
        ",\"wifiRssiDbm\":%" PRId32
        ",\"pcmWebsocketConnections\":%" PRIu32
        ",\"pcmWebsocketDisconnects\":%" PRIu32
        ",\"pcmWebsocketErrors\":%" PRIu32
        ",\"pcmWebsocketRawWriteFailures\":%" PRIu32
        ",\"pcmTransportFailureIncidents\":%" PRIu32
        ",\"pcmLastFailureOperation\":%" PRIu32
        ",\"pcmLastRawResult\":%" PRId32
        ",\"pcmLastSocketErrno\":%" PRId32
        ",\"pcmLastEspTlsError\":%" PRId32
        ",\"pcmLastTlsStackError\":%" PRId32
        ",\"pcmLastTlsCertFlags\":%" PRId32 "}}",
        diagnostics->network.wifi_connected ? "true" : "false",
        diagnostics->network.wifi_rssi_dbm,
        diagnostics->network.pcm_websocket_connections,
        diagnostics->network.pcm_websocket_disconnects,
        diagnostics->network.pcm_websocket_errors,
        diagnostics->network.pcm_websocket_raw_write_failures,
        diagnostics->network.pcm_transport_failure_incidents,
        diagnostics->network.pcm_last_failure_operation,
        diagnostics->network.pcm_last_raw_result,
        diagnostics->network.pcm_last_socket_errno,
        diagnostics->network.pcm_last_esp_tls_error,
        diagnostics->network.pcm_last_tls_stack_error,
        diagnostics->network.pcm_last_tls_cert_flags);
  } else {
    network_length = snprintf(
        metrics->options.diagnostics_expression_buffer + length,
        remaining,
        ",\"network\":{\"wifiConnected\":%s"
        ",\"pcmWebsocketConnections\":%" PRIu32
        ",\"pcmWebsocketDisconnects\":%" PRIu32
        ",\"pcmWebsocketErrors\":%" PRIu32
        ",\"pcmWebsocketRawWriteFailures\":%" PRIu32
        ",\"pcmTransportFailureIncidents\":%" PRIu32
        ",\"pcmLastFailureOperation\":%" PRIu32
        ",\"pcmLastRawResult\":%" PRId32
        ",\"pcmLastSocketErrno\":%" PRId32
        ",\"pcmLastEspTlsError\":%" PRId32
        ",\"pcmLastTlsStackError\":%" PRId32
        ",\"pcmLastTlsCertFlags\":%" PRId32 "}}",
        diagnostics->network.wifi_connected ? "true" : "false",
        diagnostics->network.pcm_websocket_connections,
        diagnostics->network.pcm_websocket_disconnects,
        diagnostics->network.pcm_websocket_errors,
        diagnostics->network.pcm_websocket_raw_write_failures,
        diagnostics->network.pcm_transport_failure_incidents,
        diagnostics->network.pcm_last_failure_operation,
        diagnostics->network.pcm_last_raw_result,
        diagnostics->network.pcm_last_socket_errno,
        diagnostics->network.pcm_last_esp_tls_error,
        diagnostics->network.pcm_last_tls_stack_error,
        diagnostics->network.pcm_last_tls_cert_flags);
  }
  if (network_length <= 0 ||
      (size_t)network_length >= remaining) {
    /*
     * As with the control prefix, truncation is a firmware/schema defect.
     * Reject the whole snapshot: a syntactically valid prefix without network
     * evidence would violate schema v4 more dangerously than a visible error.
     */
    return capnweb_reply_set_error(
        reply, "Error", "control diagnostics snapshot exceeded its budget");
  }
  length += network_length;

  metrics->diagnostics_reply_in_flight = true;
  reply_status = capnweb_reply_set_borrowed_expression(
      reply,
      metrics->options.diagnostics_expression_buffer,
      (size_t)length,
      diagnostics_reply_released,
      metrics);
  if (reply_status != CAPNWEB_OK) {
    metrics->diagnostics_reply_in_flight = false;
  }
  return reply_status;
}

static void delivery_complete(
    void *context, const struct capnweb_result *result) {
  struct iterate_kit_metrics_subscription *subscription = context;
  struct iterate_kit_metrics *metrics;
  if (subscription == NULL ||
      result == NULL ||
      subscription->owner == NULL) {
    return;
  }
  metrics = subscription->owner;
  subscription->call_in_flight = false;
  (void)release_callback_budget(metrics, subscription);
  if (result->kind == CAPNWEB_RESULT_VALUE) {
    return;
  }

  /*
   * A failed callback is not retried: metrics describe current state, so an
   * old sample has no value after transport recovery. SESSION_ENDED needs no
   * explicit release because closing the session already settles all imports.
   */
  subscription->occupied = false;
  subscription->release_pending =
      result->kind != CAPNWEB_RESULT_SESSION_ENDED;
  if (metrics->pending_result.status != ITERATE_KIT_POLL_OK) {
    return;
  }
  if (result->kind == CAPNWEB_RESULT_REJECTION) {
    metrics->pending_result = (struct iterate_kit_poll_result){
      ITERATE_KIT_POLL_CALLBACK_REJECTED,
      CAPNWEB_OK,
    };
  } else {
    metrics->pending_result = poll_capnweb(result->status);
  }
}

static struct iterate_kit_poll_result poll(
    void *context, uint64_t now_ms) {
  struct iterate_kit_metrics *metrics = context;
  bool has_ready_subscription = false;
  size_t index;
  struct iterate_kit_metrics_sample sample = {0};
  union any_metrics_expression_workspace workspace;
  enum iterate_kit_status sample_status;
  if (metrics == NULL || !metrics->initialized) {
    return poll_capnweb(CAPNWEB_E_STATE);
  }

  for (index = 0U;
       index < metrics->options.subscription_count;
       ++index) {
    struct iterate_kit_metrics_subscription *subscription =
        &metrics->options.subscriptions[index];
    if (subscription->release_pending) {
      /*
       * Release from poll rather than recursively from the completion callback.
       * This keeps protocol mutation at one obvious scheduler boundary and
       * allows a release failure to become the module's explicit poll result.
       */
      const enum capnweb_status status = capnweb_session_release_remote(
          metrics->options.session, subscription->callback);
      if (status != CAPNWEB_OK) {
        return poll_capnweb(status);
      }
      memset(subscription, 0, sizeof(*subscription));
      subscription->owner = metrics;
    }
    if (subscription->occupied && !subscription->call_in_flight) {
      has_ready_subscription = true;
    }
  }

  if (metrics->pending_result.status != ITERATE_KIT_POLL_OK) {
    const struct iterate_kit_poll_result result = metrics->pending_result;
    metrics->pending_result = poll_ok();
    return result;
  }
  if (!has_ready_subscription || now_ms < metrics->next_sample_at_ms) {
    return poll_ok();
  }

  /*
   * Sample once, then fan out the same coherent snapshot. Sampling separately
   * per callback would multiply CPU cost and let subscribers disagree about
   * queue depths solely because of iteration order.
   */
  sample_status = metrics->options.driver.sample(
      metrics->options.driver.context, &sample);
  if (sample_status != ITERATE_KIT_OK) {
    const struct iterate_kit_poll_result result = {
      ITERATE_KIT_POLL_DRIVER_ERROR,
      CAPNWEB_OK,
    };
    return result;
  }

  for (index = 0U;
       index < metrics->options.subscription_count;
       ++index) {
    struct iterate_kit_metrics_subscription *subscription =
        &metrics->options.subscriptions[index];
    const struct capnweb_expression *root;
    enum iterate_kit_status budget_status;
    enum capnweb_status status;
    if (!subscription->occupied || subscription->call_in_flight) {
      continue;
    }
    budget_status = reserve_callback_budget(metrics, subscription);
    if (budget_status == ITERATE_KIT_BACKPRESSURE) {
      /*
       * Another callback-producing module owns the complete safe wire burst.
       * Metrics are latest-state data, so waiting for a later poll is both
       * lossless in meaning and cheaper than queueing an obsolete sample.
       */
      continue;
    }
    if (budget_status != ITERATE_KIT_OK) {
      return (struct iterate_kit_poll_result){
        ITERATE_KIT_POLL_DRIVER_ERROR,
        CAPNWEB_OK,
      };
    }
    if (subscription->view == ITERATE_KIT_METRICS_GENERAL) {
      if (!build_metrics_expression(&sample, &workspace.general)) {
        (void)release_callback_budget(metrics, subscription);
        const struct iterate_kit_poll_result result = {
          ITERATE_KIT_POLL_DRIVER_ERROR,
          CAPNWEB_OK,
        };
        return result;
      }
      root = &workspace.general.root_object;
    } else if (subscription->view == ITERATE_KIT_METRICS_PLAYBACK) {
      if (!build_playback_metrics_expression(
              &sample, &workspace.playback)) {
        (void)release_callback_budget(metrics, subscription);
        const struct iterate_kit_poll_result result = {
          ITERATE_KIT_POLL_DRIVER_ERROR,
          CAPNWEB_OK,
        };
        return result;
      }
      root = &workspace.playback.root_object;
    } else if (subscription->view == ITERATE_KIT_METRICS_AEC) {
      if (!build_aec_metrics_expression(&sample, &workspace.aec)) {
        (void)release_callback_budget(metrics, subscription);
        const struct iterate_kit_poll_result result = {
          ITERATE_KIT_POLL_DRIVER_ERROR,
          CAPNWEB_OK,
        };
        return result;
      }
      root = &workspace.aec.root_object;
    } else if (
        subscription->view == ITERATE_KIT_METRICS_RAW_CLEAN_AEC) {
      if (!build_raw_clean_aec_metrics_expression(
              &sample, &workspace.raw_clean_aec)) {
        (void)release_callback_budget(metrics, subscription);
        const struct iterate_kit_poll_result result = {
          ITERATE_KIT_POLL_DRIVER_ERROR,
          CAPNWEB_OK,
        };
        return result;
      }
      root = &workspace.raw_clean_aec.root_object;
    } else {
      /*
       * A corrupt view selector is owner-state corruption, not a request for
       * the default schema. Falling back to general metrics could let a
       * detailed acceptance subscriber continue on incomplete evidence.
       */
      (void)release_callback_budget(metrics, subscription);
      const struct iterate_kit_poll_result result = {
        ITERATE_KIT_POLL_DRIVER_ERROR,
        CAPNWEB_OK,
      };
      return result;
    }
    /*
     * call_in_flight is set only after Cap'n Web accepts the call. There is no
     * per-subscriber pending sample: a busy callback is deliberately skipped,
     * preserving bounded pending-call storage and newest-state semantics.
     */
    status = capnweb_session_call_expressions(
        metrics->options.session,
        subscription->callback,
        NULL,
        0U,
        root,
        1U,
        delivery_complete,
        subscription);
    if (status != CAPNWEB_OK) {
      (void)release_callback_budget(metrics, subscription);
      return poll_capnweb(status);
    }
    subscription->call_in_flight = true;
  }

  /*
   * Saturating the deadline avoids unsigned wrap making an extremely old
   * device enter a tight sampling loop. In practice this means "no more
   * samples until reboot" at an otherwise unrepresentable uptime.
   */
  if (now_ms > UINT64_MAX - metrics->options.interval_ms) {
    metrics->next_sample_at_ms = UINT64_MAX;
  } else {
    metrics->next_sample_at_ms = now_ms + metrics->options.interval_ms;
  }
  return poll_ok();
}

static struct iterate_kit_poll_result close_metrics(void *context) {
  struct iterate_kit_metrics *metrics = context;
  size_t index;
  struct iterate_kit_poll_result result = poll_ok();
  if (metrics == NULL || !metrics->initialized) {
    return poll_capnweb(CAPNWEB_E_STATE);
  }
  for (index = 0U;
       index < metrics->options.subscription_count;
       ++index) {
    struct iterate_kit_metrics_subscription *subscription =
        &metrics->options.subscriptions[index];
    if ((subscription->occupied || subscription->release_pending) &&
        capnweb_session_get_state(metrics->options.session) ==
            CAPNWEB_SESSION_OPEN) {
      /*
       * Best-effort release every owned import, retaining the first failure.
       * Cleanup must not stop at one bad slot and leak all later callbacks.
       */
      const enum capnweb_status status = capnweb_session_release_remote(
          metrics->options.session, subscription->callback);
      if (result.status == ITERATE_KIT_POLL_OK &&
          status != CAPNWEB_OK) {
        result = poll_capnweb(status);
      }
    }
    (void)release_callback_budget(metrics, subscription);
    memset(subscription, 0, sizeof(*subscription));
  }
  metrics->initialized = false;
  return result;
}

static void session_ended(void *context) {
  struct iterate_kit_metrics *metrics = context;
  size_t index;
  if (metrics == NULL || !metrics->initialized) {
    return;
  }
  for (index = 0U;
       index < metrics->options.subscription_count;
       ++index) {
    struct iterate_kit_metrics_subscription *subscription =
        &metrics->options.subscriptions[index];
    (void)release_callback_budget(metrics, subscription);
    memset(subscription, 0, sizeof(*subscription));
    subscription->owner = metrics;
  }
  /*
   * Session teardown invalidates every imported callback regardless of its
   * previous state. Resetting slots, rather than trying to release on a dead
   * transport, makes reconnect start from an empty ownership ledger.
   */
  metrics->next_sample_at_ms = 0U;
  metrics->pending_result = poll_ok();
  /*
   * capnweb_session_close() releases borrowed replies before the transport
   * invokes this lifecycle hook. Reset defensively so a freshly initialized
   * session cannot inherit a stale busy latch even if it ended without a pull.
   */
  metrics->diagnostics_reply_in_flight = false;
}

enum iterate_kit_status iterate_kit_metrics_init(
    struct iterate_kit_metrics *metrics,
    const struct iterate_kit_metrics_options *options) {
  size_t index;
  if (metrics == NULL ||
      options == NULL ||
      options->session == NULL ||
      options->driver.sample == NULL ||
      options->subscriptions == NULL ||
      options->subscription_count == 0U ||
      options->interval_ms == 0U ||
      (options->enable_aec_view &&
       options->enable_raw_clean_aec_view) ||
      ((options->diagnostics_expression_buffer == NULL) !=
       (options->diagnostics_expression_capacity == 0U)) ||
      (options->diagnostics_expression_buffer != NULL &&
       options->diagnostics_expression_capacity <
           ITERATE_KIT_METRICS_DIAGNOSTICS_EXPRESSION_CAPACITY)) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(metrics, 0, sizeof(*metrics));
  metrics->options = *options;
  metrics->pending_result = poll_ok();
  metrics->initialized = true;
  for (index = 0U; index < options->subscription_count; ++index) {
    memset(
        &options->subscriptions[index],
        0,
        sizeof(options->subscriptions[index]));
    options->subscriptions[index].owner = metrics;
  }
  return ITERATE_KIT_OK;
}

struct iterate_kit_module iterate_kit_metrics_module(
    struct iterate_kit_metrics *metrics) {
  static const struct iterate_kit_method base_methods[] = {
    {subscribe_path, 1U, subscribe},
    {get_diagnostics_path, 1U, get_diagnostics},
  };
  static const struct iterate_kit_method playback_methods[] = {
    {subscribe_path, 1U, subscribe},
    {subscribe_playback_path, 1U, subscribe_playback},
    {get_diagnostics_path, 1U, get_diagnostics},
  };
  static const struct iterate_kit_method aec_methods[] = {
    {subscribe_path, 1U, subscribe},
    {subscribe_aec_path, 1U, subscribe_aec},
    {get_diagnostics_path, 1U, get_diagnostics},
  };
  static const struct iterate_kit_method all_methods[] = {
    {subscribe_path, 1U, subscribe},
    {subscribe_playback_path, 1U, subscribe_playback},
    {subscribe_aec_path, 1U, subscribe_aec},
    {get_diagnostics_path, 1U, get_diagnostics},
  };
  const bool playback =
      metrics != NULL && metrics->options.enable_playback_view;
  const bool aec = metrics != NULL && metrics->options.enable_aec_view;
  const bool raw_clean_aec =
      metrics != NULL && metrics->options.enable_raw_clean_aec_view;
  const struct iterate_kit_method *methods;
  size_t method_count;
  if (playback && (aec || raw_clean_aec)) {
    methods = all_methods;
    method_count = sizeof(all_methods) / sizeof(all_methods[0]);
  } else if (playback) {
    methods = playback_methods;
    method_count = sizeof(playback_methods) /
        sizeof(playback_methods[0]);
  } else if (aec || raw_clean_aec) {
    methods = aec_methods;
    method_count = sizeof(aec_methods) / sizeof(aec_methods[0]);
  } else {
    methods = base_methods;
    method_count = sizeof(base_methods) / sizeof(base_methods[0]);
  }
  const struct iterate_kit_module module = {
    .methods = methods,
    .method_count = method_count,
    .context = metrics,
    .poll = poll,
    .close = close_metrics,
    .session_ended = session_ended,
  };
  return module;
}
