/* cli_capabilities.c: owns remote controls and byte-stable health JSON. */

#include <assert.h>
#include <inttypes.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "cli_capabilities.h"
#include "cli_runtime.h"
#include "iterate/kit/voice_device_profile.h"

enum {
  CLI_CAPABILITIES_STATS_BYTES = 1792,
  CLI_CAPABILITIES_STATS_SUFFIX_BYTES = 2,
};

#define CLI_CAPABILITIES_STATS_PREFIX \
  "[{\"type\":\"voice-agent/dev-stats\",\"ephemeral\":true,\"payload\":"
#define CLI_CAPABILITIES_DESCRIPTION \
  "{\"instructions\":\"The macOS execution target of the Iterate voice " \
  "device. It has the device's bounded queues, manual push-to-talk call, " \
  "speaker playout policy, health and restart controls.\",\"children\":{" \
  "\"conversation\":{\"start\":\"Start a voice call.\"," \
  "\"hangUp\":\"End the voice call.\"},\"pushToTalk\":{" \
  "\"start\":\"Begin the configured WAV utterance.\"," \
  "\"stop\":\"Commit the utterance and ask for an answer.\"}," \
  "\"health\":\"Return device-compatible health JSON.\"," \
  "\"restart\":\"Re-exec this process.\"}}"

/** A bounded append cursor. Once overflowed, later appends are no-ops. */
struct cli_capabilities_writer {
  char *out;
  size_t capacity;
  size_t used;
  bool overflowed;
};

/* Appends formatted text without ever exposing a truncated length. */
static void cli_capabilities_append(
    struct cli_capabilities_writer *writer, const char *format, ...);

/* Writes transport, call, and capture fields in their wire order. */
static void cli_capabilities_write_health_start(
    struct cli_capabilities_writer *writer, struct cli_runtime *runtime);

/* Writes playback and liveness fields in their wire order. */
static void cli_capabilities_write_health_audio(
    struct cli_capabilities_writer *writer, struct cli_runtime *runtime);

/* Writes transport accounting fields in their wire order. */
static void cli_capabilities_write_health_transport(
    struct cli_capabilities_writer *writer,
    struct cli_runtime *runtime,
    const struct iterate_kit_posix_itx_transport_metrics *metrics);

/* Writes the remaining ring and platform fields, including the closing brace. */
static void cli_capabilities_write_health_end(
    struct cli_capabilities_writer *writer,
    struct cli_runtime *runtime,
    const struct iterate_kit_spsc_ring_metrics *outbox);

/* Replies true after a remote state mutation. */
static enum capnweb_status cli_capabilities_reply_true(
    struct capnweb_reply *reply);

/* Capability methods mutate only the desired call and talk state. */
static enum capnweb_status cli_capabilities_start_call(
    void *context, const struct capnweb_call *call, struct capnweb_reply *reply);
static enum capnweb_status cli_capabilities_hang_up(
    void *context, const struct capnweb_call *call, struct capnweb_reply *reply);
static enum capnweb_status cli_capabilities_health(
    void *context, const struct capnweb_call *call, struct capnweb_reply *reply);
static enum capnweb_status cli_capabilities_restart(
    void *context, const struct capnweb_call *call, struct capnweb_reply *reply);

static const char *const CLI_CAPABILITIES_START_PATH[] = {
  "conversation", "start"};
static const char *const CLI_CAPABILITIES_HANG_UP_PATH[] = {
  "conversation", "hangUp"};
static const char *const CLI_CAPABILITIES_HEALTH_PATH[] = {"health"};
static const char *const CLI_CAPABILITIES_RESTART_PATH[] = {"restart"};

static const struct iterate_kit_method CLI_CAPABILITIES_METHODS[] = {
  {CLI_CAPABILITIES_START_PATH,
   sizeof(CLI_CAPABILITIES_START_PATH) /
       sizeof(CLI_CAPABILITIES_START_PATH[0]),
   cli_capabilities_start_call},
  {CLI_CAPABILITIES_HANG_UP_PATH,
   sizeof(CLI_CAPABILITIES_HANG_UP_PATH) /
       sizeof(CLI_CAPABILITIES_HANG_UP_PATH[0]),
   cli_capabilities_hang_up},
  {CLI_CAPABILITIES_HEALTH_PATH,
   sizeof(CLI_CAPABILITIES_HEALTH_PATH) /
       sizeof(CLI_CAPABILITIES_HEALTH_PATH[0]),
   cli_capabilities_health},
  {CLI_CAPABILITIES_RESTART_PATH,
   sizeof(CLI_CAPABILITIES_RESTART_PATH) /
       sizeof(CLI_CAPABILITIES_RESTART_PATH[0]),
   cli_capabilities_restart},
};

const char *cli_capabilities_status_name(enum cli_capabilities_status status)
{
  switch (status) {
    case CLI_CAPABILITIES_OK: return "ok";
    case CLI_CAPABILITIES_ERR_ARG: return "bad-argument";
    case CLI_CAPABILITIES_ERR_OVERFLOW: return "health-overflow";
    case CLI_CAPABILITIES_ERR_APPEND: return "append-failed";
    default: return "unknown";
  }
}

struct iterate_kit_module cli_capabilities_module(
    struct cli_capabilities *capabilities, struct cli_runtime *runtime)
{
  struct iterate_kit_module module = {0};
  if (capabilities == NULL || runtime == NULL) return module;
  capabilities->runtime = runtime;
  module.methods = CLI_CAPABILITIES_METHODS;
  module.method_count =
      sizeof(CLI_CAPABILITIES_METHODS) / sizeof(CLI_CAPABILITIES_METHODS[0]);
  module.context = capabilities;
  return module;
}

const char *cli_capabilities_description(size_t *out_length)
{
  if (out_length == NULL) return NULL;
  *out_length = sizeof(CLI_CAPABILITIES_DESCRIPTION) - 1U;
  return CLI_CAPABILITIES_DESCRIPTION;
}

size_t cli_capabilities_health_json(
    struct cli_runtime *runtime, char *out, size_t capacity)
{
  if (runtime == NULL || out == NULL || capacity == 0U) return 0U;
  struct iterate_kit_posix_itx_transport_metrics metrics = {0};
  struct iterate_kit_spsc_ring_metrics outbox = {0};
  iterate_kit_posix_itx_transport_metrics(&runtime->transport, &metrics);
  iterate_kit_spsc_ring_metrics(&runtime->control_outbox, &outbox);
  struct cli_capabilities_writer writer = {
    .out = out,
    .capacity = capacity,
    .used = 0U,
    .overflowed = false,
  };
  cli_capabilities_write_health_start(&writer, runtime);
  cli_capabilities_write_health_audio(&writer, runtime);
  cli_capabilities_write_health_transport(&writer, runtime, &metrics);
  cli_capabilities_write_health_end(&writer, runtime, &outbox);
  return writer.overflowed ? 0U : writer.used;
}

enum cli_capabilities_status cli_capabilities_append_stats(
    struct cli_runtime *runtime)
{
  if (runtime == NULL) return CLI_CAPABILITIES_ERR_ARG;
  char message[CLI_CAPABILITIES_STATS_BYTES] = {0};
  const size_t prefix_length = sizeof(CLI_CAPABILITIES_STATS_PREFIX) - 1U;
  memcpy(message, CLI_CAPABILITIES_STATS_PREFIX, prefix_length);
  const size_t available = sizeof(message) - prefix_length -
      CLI_CAPABILITIES_STATS_SUFFIX_BYTES - 1U;
  const size_t body = cli_capabilities_health_json(
      runtime, message + prefix_length, available);
  if (body == 0U) return CLI_CAPABILITIES_ERR_OVERFLOW;
  message[prefix_length + body] = '}';
  message[prefix_length + body + 1U] = ']';
  const enum capnweb_status status = iterate_kit_voicelab_append_raw(
      &runtime->voicelab, message,
      prefix_length + body + CLI_CAPABILITIES_STATS_SUFFIX_BYTES);
  return status == CAPNWEB_OK
      ? CLI_CAPABILITIES_OK
      : CLI_CAPABILITIES_ERR_APPEND;
}

void cli_capabilities_request_restart(
    struct cli_runtime *runtime, uint64_t now_ms)
{
  if (runtime == NULL) return;
  if (!runtime->restart_requested) runtime->restart_requested_at_ms = now_ms;
  runtime->restart_requested = true;
}

void cli_capabilities_session_ended(void *context)
{
  struct cli_runtime *runtime = context;
  if (runtime == NULL) return;
  runtime->voicelab.state = ITERATE_KIT_VOICELAB_FAILED;
  runtime->voicelab.failure = ITERATE_KIT_VOICELAB_FAILURE_SESSION_ENDED;
  runtime->voicelab.has_session_capability = false;
  runtime->voicelab.has_project_capability = false;
  runtime->voicelab.has_stream_capability = false;
  runtime->voicelab.has_connection_capability = false;
  runtime->voicelab.has_previous_connection_capability = false;
  runtime->voicelab.has_callback_capability = false;
  runtime->voicelab_generation = 0U;
}

static void cli_capabilities_append(
    struct cli_capabilities_writer *writer, const char *format, ...)
{
  assert(writer != NULL && format != NULL);
  if (writer->overflowed) return;
  va_list args;
  va_start(args, format);
  const size_t remaining = writer->capacity - writer->used;
  const int length = vsnprintf(writer->out + writer->used, remaining,
                               format, args);
  va_end(args);
  if (length < 0 || (size_t)length >= remaining) {
    writer->overflowed = true;
    return;
  }
  writer->used += (size_t)length;
  assert(writer->used < writer->capacity);
}

static void cli_capabilities_write_health_start(
    struct cli_capabilities_writer *writer, struct cli_runtime *runtime)
{
  assert(writer != NULL && runtime != NULL);
  const bool gate = runtime->voicelab.state == ITERATE_KIT_VOICELAB_READY &&
      runtime->transport.state == ITERATE_KIT_POSIX_ITX_READY &&
      runtime->voicelab_generation == runtime->connection.generation;
  const uint32_t mic_dropped =
      runtime->mic_frames_dropped + runtime->microphone.dropped;
  cli_capabilities_append(
      writer,
      "{\"transport\":\"%s\",\"voicelab\":\"%s\","
      "\"voicelabFailure\":\"%s\",\"connectionState\":%d,"
      "\"callActive\":%s,\"callPending\":%s,\"wantsCall\":%s,"
      "\"talking\":%s,\"gateOpen\":%s,\"seq\":%u,\"t\":%" PRIu64
      ",\"framesSent\":%u,\"frameFailures\":%u,\"micCaptured\":%u,"
      "\"micDropped\":%u,\"micGated\":%u,\"spkFrames\":%u,"
      "\"spkPlayed\":%u,\"spkOverflow\":%u",
      iterate_kit_posix_itx_transport_state_name(runtime->transport.state),
      iterate_kit_voicelab_state_name(runtime->voicelab.state),
      iterate_kit_voicelab_failure_name(runtime->voicelab.failure),
      (int)runtime->connection.state,
      runtime->voicelab.call_active ? "true" : "false",
      runtime->voicelab.call_pending ? "true" : "false",
      runtime->wants_call ? "true" : "false",
      runtime->talking ? "true" : "false", gate ? "true" : "false",
      runtime->stats_sequence++, cli_runtime_now_ms(NULL),
      runtime->voicelab.frames_sent, runtime->voicelab.frame_send_failures,
      runtime->mic_frames_captured, mic_dropped, runtime->mic_frames_gated,
      runtime->voicelab.spk_frames_received, runtime->speaker_frames_played,
      runtime->speaker_overflow_drops);
}

static void cli_capabilities_write_health_audio(
    struct cli_capabilities_writer *writer, struct cli_runtime *runtime)
{
  assert(writer != NULL && runtime != NULL);
  const uint64_t now_ms = cli_runtime_now_ms(NULL);
  const uint32_t bridge_age = runtime->voicelab.last_bridge_ms == 0U
      ? 0U
      : (uint32_t)iterate_kit_voice_elapsed_ms(
            now_ms, runtime->voicelab.last_bridge_ms);
  const uint32_t batch_age = runtime->voicelab.last_batch_ms == 0U
      ? 0U
      : (uint32_t)iterate_kit_voice_elapsed_ms(
            now_ms, runtime->voicelab.last_batch_ms);
  cli_capabilities_append(
      writer,
      ",\"spkUnderruns\":%u,\"spkConceal\":%u,\"spkCatchup\":%u,"
      "\"spkDebtPaid\":%u,\"spkWriteFailures\":%u,"
      "\"talkReadFailures\":0,\"spkMarginMaxMs\":%u,"
      "\"spkBadFrames\":%u,\"spkSeqGaps\":%u,"
      "\"spkDecodeFailures\":%u,\"bargeIns\":%u,\"batches\":%u,"
      "\"connGeneration\":%u,\"rttMs\":%u,\"pings\":%u,"
      "\"pingFailures\":%u,\"livenessRestarts\":%u,\"bridgeLosses\":%u,"
      "\"bridgeAgeMs\":%u,\"downlinkRecycles\":%u,\"batchAgeMs\":%u,"
      "\"uptimeMs\":%" PRIu64,
      runtime->speaker_underruns, runtime->speaker_conceal_frames,
      runtime->speaker_catchup_frames, runtime->speaker_debt_paid,
      runtime->speaker_write_failures, runtime->speaker_margin_max_ms,
      runtime->speaker_bad_frames, runtime->playout.gaps,
      runtime->voicelab.spk_decode_failures, runtime->barge_in_flushes,
      runtime->voicelab.batches_on_connection,
      runtime->voicelab.connection_generation, runtime->voicelab.last_rtt_ms,
      runtime->voicelab.ping_count, runtime->voicelab.ping_failures,
      runtime->liveness_restarts, runtime->bridge_losses, bridge_age,
      runtime->downlink_recycles, batch_age,
      iterate_kit_voice_elapsed_ms(now_ms, runtime->started_ms));
}

static void cli_capabilities_write_health_transport(
    struct cli_capabilities_writer *writer,
    struct cli_runtime *runtime,
    const struct iterate_kit_posix_itx_transport_metrics *metrics)
{
  assert(writer != NULL && runtime != NULL && metrics != NULL);
  cli_capabilities_append(
      writer,
      ",\"resetReason\":0,\"heapFree\":0,\"heapMin\":0,\"wsSent\":%u,"
      "\"outboxDiscarded\":%u,\"inboxPublished\":%u,"
      "\"inboxConsumed\":%u,\"inboxDiscarded\":%u,"
      "\"inboxHighWater\":%u,\"sessionGeneration\":%u,"
      "\"openTimeouts\":%u,\"protoFailures\":%u,"
      "\"recvFailures\":%u,\"sendFailures\":%u,"
      "\"inboxDeferrals\":%u,\"lastAppStatus\":%d,\"dmaLargest\":0",
      metrics->control_messages_sent, metrics->control_outbox_discarded,
      metrics->control_inbox.messages_published,
      metrics->control_inbox.messages_consumed,
      metrics->control_inbox_discarded, metrics->control_inbox.high_water_slots,
      runtime->connection.generation, metrics->websocket_open_timeouts,
      metrics->protocol_failures,
      metrics->control_receive_failures, metrics->control_send_failures,
      metrics->control_inbox_deferrals, metrics->last_capnweb_status);
}

static void cli_capabilities_write_health_end(
    struct cli_capabilities_writer *writer,
    struct cli_runtime *runtime,
    const struct iterate_kit_spsc_ring_metrics *outbox)
{
  assert(writer != NULL && runtime != NULL && outbox != NULL);
  cli_capabilities_append(
      writer,
      ",\"spkMarginMinMs\":%u,\"spkMarginP10Ms\":%u,\"spkWrites\":%u,"
      "\"outboxUsed\":%u,\"outboxSlots\":%u}",
      runtime->speaker_margin_min_ms, 0U, runtime->speaker_writes,
      outbox->current_slots, ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS);
}

static enum capnweb_status cli_capabilities_reply_true(
    struct capnweb_reply *reply)
{
  assert(reply != NULL);
  return capnweb_reply_set_boolean(reply, true);
}

static enum capnweb_status cli_capabilities_start_call(
    void *context, const struct capnweb_call *call, struct capnweb_reply *reply)
{
  (void)call;
  struct cli_capabilities *capabilities = context;
  assert(capabilities != NULL && capabilities->runtime != NULL);
  capabilities->runtime->wants_call = true;
  return cli_capabilities_reply_true(reply);
}

static enum capnweb_status cli_capabilities_hang_up(
    void *context, const struct capnweb_call *call, struct capnweb_reply *reply)
{
  (void)call;
  struct cli_capabilities *capabilities = context;
  assert(capabilities != NULL && capabilities->runtime != NULL);
  if (cli_device_controls_request_talk(
          &capabilities->runtime->device_controls,
          false,
          ITERATE_KIT_DEVICE_EVENT_SOURCE_REMOTE) != ITERATE_KIT_OK) {
    return capnweb_reply_set_error(
        reply, "Error", "device control queue is full");
  }
  capabilities->runtime->wants_call = false;
  return cli_capabilities_reply_true(reply);
}

static enum capnweb_status cli_capabilities_health(
    void *context, const struct capnweb_call *call, struct capnweb_reply *reply)
{
  (void)call;
  struct cli_capabilities *capabilities = context;
  assert(capabilities != NULL && capabilities->runtime != NULL);
  const size_t length = cli_capabilities_health_json(
      capabilities->runtime, capabilities->health, sizeof(capabilities->health));
  if (length == 0U) {
    return capnweb_reply_set_error(reply, "Error", "health overflow");
  }
  return capnweb_reply_set_borrowed_expression(
      reply, capabilities->health, length, NULL, NULL);
}

static enum capnweb_status cli_capabilities_restart(
    void *context, const struct capnweb_call *call, struct capnweb_reply *reply)
{
  (void)call;
  struct cli_capabilities *capabilities = context;
  assert(capabilities != NULL && capabilities->runtime != NULL);
  cli_capabilities_request_restart(
      capabilities->runtime, cli_runtime_now_ms(NULL));
  return cli_capabilities_reply_true(reply);
}
