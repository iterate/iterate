// Copyright (c) 2026 Iterate
// Licensed under the MIT license found in the repository root.

#include "iterate/kit/voicelab_stream.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

static const char *const authenticate_path[] = {"authenticate"};
static const char *const streams_get_path[] = {"streams", "get"};
static const char *const project_path[] = {"projects", "get"};
static const char *const append_path[] = {"append"};
/* The project's own worker.ts — dotted paths flatten into one RPC. */
static const char *const start_call_path[] = {"worker", "startCall"};

static bool nonempty(const char *value) {
  return value != NULL && value[0] != '\0';
}

static bool valid_options(
    const struct iterate_kit_voicelab_options *options) {
  return options != NULL &&
      options->session != NULL &&
      nonempty(options->project_id) &&
      nonempty(options->project_api_key) &&
      nonempty(options->stream_path) &&
      nonempty(options->call_id) &&
      options->now_ms != NULL;
}

static enum capnweb_status fail(
    struct iterate_kit_voicelab *voicelab,
    enum iterate_kit_voicelab_failure failure,
    enum capnweb_status status) {
  voicelab->state = ITERATE_KIT_VOICELAB_FAILED;
  voicelab->failure = failure;
  voicelab->capnweb_status = status;
  return status;
}

static enum capnweb_status release_remote(
    struct iterate_kit_voicelab *voicelab,
    struct capnweb_remote_capability *capability,
    bool *owned) {
  enum capnweb_status status;
  if (!*owned) {
    return CAPNWEB_OK;
  }
  status = capnweb_session_release_remote(
      voicelab->options.session, *capability);
  if (status == CAPNWEB_OK) {
    *owned = false;
  }
  return status;
}

static bool take_result_capability(
    const struct capnweb_result *result,
    struct capnweb_remote_capability *capability) {
  return result->kind == CAPNWEB_RESULT_VALUE &&
      result->status == CAPNWEB_OK &&
      capnweb_value_get_remote_capability(&result->value, capability);
}

/* --- base64 (RFC 4648, unpadded — matches the vendored writer) ---------- */

static const char base64_alphabet[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static size_t base64_encode(
    const uint8_t *bytes,
    size_t byte_count,
    char *destination,
    size_t destination_capacity) {
  size_t out = 0U;
  size_t index = 0U;
  while (index + 3U <= byte_count) {
    uint32_t chunk = ((uint32_t)bytes[index] << 16) |
        ((uint32_t)bytes[index + 1U] << 8) |
        (uint32_t)bytes[index + 2U];
    if (out + 4U > destination_capacity) {
      return 0U;
    }
    destination[out++] = base64_alphabet[(chunk >> 18) & 0x3fU];
    destination[out++] = base64_alphabet[(chunk >> 12) & 0x3fU];
    destination[out++] = base64_alphabet[(chunk >> 6) & 0x3fU];
    destination[out++] = base64_alphabet[chunk & 0x3fU];
    index += 3U;
  }
  if (index < byte_count) {
    uint32_t chunk = (uint32_t)bytes[index] << 16;
    size_t remainder = byte_count - index;
    if (remainder == 2U) {
      chunk |= (uint32_t)bytes[index + 1U] << 8;
    }
    if (out + (remainder == 2U ? 3U : 2U) > destination_capacity) {
      return 0U;
    }
    destination[out++] = base64_alphabet[(chunk >> 18) & 0x3fU];
    destination[out++] = base64_alphabet[(chunk >> 12) & 0x3fU];
    if (remainder == 2U) {
      destination[out++] = base64_alphabet[(chunk >> 6) & 0x3fU];
    }
  }
  return out;
}

/* --- base64 decode (accepts padded and unpadded input) -------------------- */

static int base64_value(char character) {
  if (character >= 'A' && character <= 'Z') {
    return character - 'A';
  }
  if (character >= 'a' && character <= 'z') {
    return character - 'a' + 26;
  }
  if (character >= '0' && character <= '9') {
    return character - '0' + 52;
  }
  if (character == '+') {
    return 62;
  }
  if (character == '/') {
    return 63;
  }
  return -1;
}

static bool base64_decode(
    const char *text,
    size_t text_length,
    uint8_t *destination,
    size_t destination_capacity,
    size_t *decoded_length) {
  uint32_t accumulator = 0U;
  int bits = 0;
  size_t out = 0U;
  size_t index;
  while (text_length > 0U && text[text_length - 1U] == '=') {
    --text_length;
  }
  for (index = 0U; index < text_length; ++index) {
    const int value = base64_value(text[index]);
    if (value < 0) {
      return false;
    }
    accumulator = (accumulator << 6) | (uint32_t)value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (out >= destination_capacity) {
        return false;
      }
      destination[out++] = (uint8_t)((accumulator >> bits) & 0xffU);
    }
  }
  *decoded_length = out;
  return true;
}

/* --- inbound delivery batches (the exported callback capability) ---------- */

static void handle_spk_frame(
    struct iterate_kit_voicelab *voicelab,
    const struct capnweb_value *payload) {
  struct capnweb_value pcm_value;
  struct capnweb_value sequence_value;
  int64_t sequence = -1;
  size_t b64_length;
  size_t pcm_length;
  if (capnweb_value_object_get(payload, "seq", &sequence_value)) {
    (void)capnweb_value_get_int64(&sequence_value, &sequence);
  }
  if (!capnweb_value_object_get(payload, "pcm", &pcm_value) ||
      capnweb_value_copy_string(
          &pcm_value,
          voicelab->b64_buffer,
          sizeof(voicelab->b64_buffer),
          &b64_length) != CAPNWEB_OK ||
      !base64_decode(
          voicelab->b64_buffer,
          b64_length,
          voicelab->pcm_buffer,
          sizeof(voicelab->pcm_buffer),
          &pcm_length)) {
    ++voicelab->spk_decode_failures;
    return;
  }
  if (voicelab->last_spk_sequence >= 0 &&
      sequence > voicelab->last_spk_sequence + 1) {
    ++voicelab->spk_seq_gaps;
  }
  if (sequence > voicelab->last_spk_sequence) {
    voicelab->last_spk_sequence = sequence;
  }
  ++voicelab->spk_frames_received;
  if (voicelab->options.on_speaker != NULL) {
    voicelab->options.on_speaker(
        voicelab->options.downlink_context,
        voicelab->pcm_buffer,
        pcm_length,
        sequence);
  }
}

/** Emit the assistant line accumulated so far, then reset the buffer. */
static void flush_assistant_transcript(
    struct iterate_kit_voicelab *voicelab, bool final) {
  if (voicelab->options.on_transcript == NULL ||
      voicelab->transcript_length == 0U) {
    return;
  }
  voicelab->transcript_buffer[voicelab->transcript_length] = '\0';
  voicelab->options.on_transcript(
      voicelab->options.downlink_context,
      false,
      voicelab->transcript_buffer,
      final);
  if (final) {
    voicelab->transcript_length = 0U;
  }
}

/**
 * Hand one user line to the transcript callback, at most once per
 * conversation item. `item_id_value` may be NULL, in which case the line is
 * always emitted.
 */
static void emit_user_transcript(
    struct iterate_kit_voicelab *voicelab,
    const struct capnweb_value *text_value,
    const struct capnweb_value *item_id_value) {
  char text[192];
  size_t length = 0U;
  if (voicelab->options.on_transcript == NULL ||
      capnweb_value_copy_string(text_value, text, sizeof(text), &length) !=
          CAPNWEB_OK ||
      length == 0U) {
    return;
  }
  if (item_id_value != NULL) {
    char item_id[sizeof(voicelab->last_user_item_id)];
    size_t item_id_length = 0U;
    if (capnweb_value_copy_string(
            item_id_value, item_id, sizeof(item_id), &item_id_length) ==
            CAPNWEB_OK &&
        item_id_length > 0U) {
      if (strcmp(item_id, voicelab->last_user_item_id) == 0) {
        return;
      }
      memcpy(voicelab->last_user_item_id, item_id, item_id_length + 1U);
    }
  }
  voicelab->options.on_transcript(
      voicelab->options.downlink_context, true, text, true);
}

static void handle_grok_event(
    struct iterate_kit_voicelab *voicelab,
    const struct capnweb_value *payload) {
  struct capnweb_value event_value;
  struct capnweb_value type_value;
  if (!capnweb_value_object_get(payload, "event", &event_value) ||
      !capnweb_value_object_get(&event_value, "type", &type_value)) {
    return;
  }
  if (capnweb_value_string_equals(
          &type_value, "input_audio_buffer.speech_started")) {
    if (voicelab->options.on_control != NULL) {
      voicelab->options.on_control(
          voicelab->options.downlink_context,
          ITERATE_KIT_VOICELAB_CONTROL_SPEECH_STARTED);
    }
    return;
  }
  if (capnweb_value_string_equals(&type_value, "response.created")) {
    voicelab->transcript_length = 0U;
    return;
  }
  if (capnweb_value_string_equals(
          &type_value, "response.output_audio_transcript.done")) {
    /*
     * The authoritative complete line. Preferring it over the accumulated
     * deltas makes delta loss, truncation and reordering cosmetic rather
     * than corrupting: whatever ends up on screen came from one field.
     */
    struct capnweb_value transcript_value;
    size_t length = 0U;
    if (capnweb_value_object_get(&event_value, "transcript", &transcript_value) &&
        capnweb_value_copy_string(
            &transcript_value,
            voicelab->transcript_buffer,
            sizeof(voicelab->transcript_buffer),
            &length) != CAPNWEB_E_INVALID_ARGUMENT) {
      if (length >= sizeof(voicelab->transcript_buffer)) {
        length = sizeof(voicelab->transcript_buffer) - 1U;
      }
      voicelab->transcript_length = length;
      flush_assistant_transcript(voicelab, true);
    }
    return;
  }
  if (capnweb_value_string_equals(&type_value, "response.done")) {
    flush_assistant_transcript(voicelab, true);
    voicelab->transcript_length = 0U; /* never carry text into the next answer */
    if (voicelab->options.on_control != NULL) {
      voicelab->options.on_control(
          voicelab->options.downlink_context,
          ITERATE_KIT_VOICELAB_CONTROL_RESPONSE_DONE);
    }
    return;
  }
  if (capnweb_value_string_equals(
          &type_value, "response.output_audio_transcript.delta")) {
    struct capnweb_value delta_value;
    char delta[256];
    size_t delta_length = 0U;
    enum capnweb_status copied;
    if (!capnweb_value_object_get(&event_value, "delta", &delta_value)) {
      return;
    }
    copied = capnweb_value_copy_string(
        &delta_value, delta, sizeof(delta), &delta_length);
    /*
     * E_LIMIT still NUL-terminates and reports the FULL length, so treating
     * it as failure discarded the whole delta — a sentence-sized one simply
     * vanished from the line. Take what fits instead.
     */
    if (copied != CAPNWEB_OK && copied != CAPNWEB_E_LIMIT) {
      return;
    }
    if (delta_length >= sizeof(delta)) {
      delta_length = sizeof(delta) - 1U;
    }
    /*
     * Keep the NEWEST words on overflow, not the oldest: restarting at zero
     * threw away everything said so far, so a long answer appeared to begin
     * mid-sentence ("twenty-six, twenty-seven, ..."). Slide the buffer
     * instead, so the line stays coherent at its tail.
     */
    if (voicelab->transcript_length + delta_length >=
        sizeof(voicelab->transcript_buffer)) {
      const size_t keep = sizeof(voicelab->transcript_buffer) / 2U;
      if (voicelab->transcript_length > keep) {
        memmove(
            voicelab->transcript_buffer,
            voicelab->transcript_buffer + voicelab->transcript_length - keep,
            keep);
        voicelab->transcript_length = keep;
      }
      if (voicelab->transcript_length + delta_length >=
          sizeof(voicelab->transcript_buffer)) {
        voicelab->transcript_length = 0U;
      }
    }
    memcpy(
        voicelab->transcript_buffer + voicelab->transcript_length,
        delta,
        delta_length);
    voicelab->transcript_length += delta_length;
    flush_assistant_transcript(voicelab, false);
    return;
  }
  if (capnweb_value_string_equals(
          &type_value, "conversation.item.input_audio_transcription.completed")) {
    struct capnweb_value transcript_value;
    struct capnweb_value item_id_value;
    const bool has_item_id =
        capnweb_value_object_get(&event_value, "item_id", &item_id_value);
    if (capnweb_value_object_get(
            &event_value, "transcript", &transcript_value)) {
      emit_user_transcript(
          voicelab, &transcript_value, has_item_id ? &item_id_value : NULL);
    }
    return;
  }
  if (capnweb_value_string_equals(&type_value, "conversation.item.added")) {
    struct capnweb_value item;
    struct capnweb_value role;
    struct capnweb_value item_id_value;
    struct capnweb_value content_wrapper;
    struct capnweb_value content;
    bool has_item_id;
    size_t index;
    if (!capnweb_value_object_get(&event_value, "item", &item) ||
        !capnweb_value_object_get(&item, "role", &role) ||
        !capnweb_value_string_equals(&role, "user") ||
        !capnweb_value_object_get(&item, "content", &content_wrapper) ||
        !capnweb_value_get_expression_array(&content_wrapper, &content)) {
      return;
    }
    has_item_id = capnweb_value_object_get(&item, "id", &item_id_value);
    for (index = 0U; index < capnweb_value_array_size(&content); ++index) {
      struct capnweb_value part;
      struct capnweb_value transcript_value;
      if (capnweb_value_array_at(&content, index, &part) &&
          capnweb_value_object_get(&part, "transcript", &transcript_value)) {
        emit_user_transcript(
            voicelab, &transcript_value, has_item_id ? &item_id_value : NULL);
        return;
      }
    }
  }
}

static enum capnweb_status batch_dispatch(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct iterate_kit_voicelab *voicelab = context;
  struct capnweb_value batch;
  struct capnweb_value events_wrapper;
  struct capnweb_value events;
  size_t event_count;
  size_t index;
  ++voicelab->batches_on_connection;
  if (!call->has_arguments ||
      !capnweb_value_array_at(&call->arguments, 0U, &batch)) {
    return capnweb_reply_set_null(reply);
  }
  /* Application arrays ride the wire escaped as [[item, ...]]. */
  if (!capnweb_value_object_get(&batch, "events", &events_wrapper) ||
      !capnweb_value_get_expression_array(&events_wrapper, &events)) {
    return capnweb_reply_set_null(reply);
  }
  event_count = capnweb_value_array_size(&events);
  for (index = 0U; index < event_count; ++index) {
    struct capnweb_value event;
    struct capnweb_value offset_value;
    struct capnweb_value type_value;
    struct capnweb_value payload;
    int64_t offset = -1;
    if (!capnweb_value_array_at(&events, index, &event)) {
      continue;
    }
    if (capnweb_value_object_get(&event, "offset", &offset_value)) {
      (void)capnweb_value_get_int64(&offset_value, &offset);
    }
    /* Overlapping generations during a recycle re-deliver; offset dedupe. */
    if (offset >= 0 && offset <= voicelab->last_event_offset) {
      continue;
    }
    if (offset > voicelab->last_event_offset) {
      voicelab->last_event_offset = offset;
    }
    if (!capnweb_value_object_get(&event, "type", &type_value) ||
        !capnweb_value_object_get(&event, "payload", &payload)) {
      continue;
    }
    /*
     * Every event here was appended BY THE BRIDGE, so any of them is proof
     * that the far end of the call is still running. Stamping it once, here,
     * means the owner never has to reason about which event type counts.
     */
    voicelab->last_bridge_ms =
        voicelab->options.now_ms(voicelab->options.clock_context);
    if (capnweb_value_string_equals(&type_value, "voicelab/spk-frame")) {
      handle_spk_frame(voicelab, &payload);
    } else if (capnweb_value_string_equals(&type_value, "voicelab/grok-event")) {
      handle_grok_event(voicelab, &payload);
    } else if (capnweb_value_string_equals(&type_value, "voicelab/pong")) {
      /* Liveness only; the RTT number comes from the append's own echo. */
    } else if (capnweb_value_string_equals(
                   &type_value, "voicelab/call-accepted")) {
      /*
       * The stream is what says a call is live, not the startCall reply: the
       * reply can be slow or lost, and a call opened by anyone else counts
       * just the same.
       */
      {
        struct capnweb_value bridge_value;
        size_t length = 0U;
        voicelab->live_bridge_id[0] = '\0';
        if (capnweb_value_object_get(&payload, "bridgeId", &bridge_value)) {
          (void)capnweb_value_copy_string(
              &bridge_value,
              voicelab->live_bridge_id,
              sizeof(voicelab->live_bridge_id),
              &length);
        }
      }
      voicelab->call_active = true;
      voicelab->call_pending = false;
      if (voicelab->options.on_control != NULL) {
        voicelab->options.on_control(
            voicelab->options.downlink_context,
            ITERATE_KIT_VOICELAB_CONTROL_CALL_ACCEPTED);
      }
    } else if (capnweb_value_string_equals(&type_value, "voicelab/call-ended")) {
      /* Only the bridge serving this call may end it. */
      struct capnweb_value bridge_value;
      char ended_by[sizeof(voicelab->live_bridge_id)] = {0};
      size_t length = 0U;
      if (voicelab->live_bridge_id[0] != '\0' &&
          capnweb_value_object_get(&payload, "bridgeId", &bridge_value) &&
          capnweb_value_copy_string(
              &bridge_value, ended_by, sizeof(ended_by), &length) ==
              CAPNWEB_OK &&
          strcmp(ended_by, voicelab->live_bridge_id) != 0) {
        continue; /* a stale bridge shutting down; not our call */
      }
      voicelab->live_bridge_id[0] = '\0';
      voicelab->call_active = false;
      if (voicelab->options.on_control != NULL) {
        voicelab->options.on_control(
            voicelab->options.downlink_context,
            ITERATE_KIT_VOICELAB_CONTROL_CALL_ENDED);
      }
    }
  }
  return capnweb_reply_set_null(reply);
}

/* --- live connection open / recycle --------------------------------------- */

static void connection_opened(
    void *context, const struct capnweb_result *result) {
  struct iterate_kit_voicelab *voicelab = context;
  enum capnweb_status status;
  if (voicelab->state == ITERATE_KIT_VOICELAB_CLOSED) {
    return;
  }
  voicelab->recycle_pending = false;
  if (result->kind == CAPNWEB_RESULT_SESSION_ENDED) {
    (void)fail(
        voicelab,
        ITERATE_KIT_VOICELAB_FAILURE_SESSION_ENDED,
        result->status);
    return;
  }
  if (result->kind == CAPNWEB_RESULT_REJECTION) {
    (void)fail(
        voicelab, ITERATE_KIT_VOICELAB_FAILURE_OPEN_REJECTED, CAPNWEB_OK);
    return;
  }
  if (voicelab->has_connection_capability) {
    /* Make-before-break: the incumbent becomes the outgoing generation. */
    voicelab->previous_connection_capability =
        voicelab->connection_capability;
    voicelab->has_previous_connection_capability = true;
    voicelab->has_connection_capability = false;
  }
  if (!take_result_capability(result, &voicelab->connection_capability)) {
    (void)fail(
        voicelab,
        ITERATE_KIT_VOICELAB_FAILURE_OPEN_RESULT,
        CAPNWEB_E_INVALID_MESSAGE);
    return;
  }
  voicelab->has_connection_capability = true;
  voicelab->batches_on_connection = 0U;
  voicelab->recycle_pending = false;
  status = release_remote(
      voicelab,
      &voicelab->previous_connection_capability,
      &voicelab->has_previous_connection_capability);
  if (status != CAPNWEB_OK) {
    (void)fail(voicelab, ITERATE_KIT_VOICELAB_FAILURE_RELEASE, status);
    return;
  }
  voicelab->state = ITERATE_KIT_VOICELAB_READY;
  voicelab->failure = ITERATE_KIT_VOICELAB_FAILURE_NONE;
  voicelab->capnweb_status = CAPNWEB_OK;
}

bool iterate_kit_voicelab_needs_recycle(
    const struct iterate_kit_voicelab *voicelab) {
  return voicelab != NULL &&
      !voicelab->recycle_pending &&
      voicelab->state == ITERATE_KIT_VOICELAB_READY &&
      voicelab->has_connection_capability &&
      voicelab->batches_on_connection >=
          ITERATE_KIT_VOICELAB_RECYCLE_AFTER_BATCHES;
}

/*
 * openConnection with the constrained-consumer contract this device needs:
 * one exported callback capability, at most 2 events / 2600 event-bytes per
 * batch (one inbox slot's worth), and no per-batch core state. Serves both
 * the first open and every proactive recycle; the incumbent connection is
 * released only after its successor resolves (make-before-break, offset
 * dedupe handles the overlap).
 */
enum capnweb_status iterate_kit_voicelab_recycle_connection(
    struct iterate_kit_voicelab *voicelab) {
  static const char *const open_path[] = {"openConnection"};
  struct capnweb_expression event_type_items[5];
  struct capnweb_expression event_types;
  struct capnweb_expression connection_key;
  struct capnweb_expression max_events;
  struct capnweb_expression max_bytes;
  struct capnweb_expression no_state;
  struct capnweb_expression callback;
  struct capnweb_object_field fields[6];
  struct capnweb_expression argument;
  char key_text[64];
  int key_length;
  enum capnweb_status status;

  if (voicelab == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (voicelab->state != ITERATE_KIT_VOICELAB_READY &&
      voicelab->state != ITERATE_KIT_VOICELAB_OPENING_CONNECTION) {
    return CAPNWEB_E_STATE;
  }
  if (!voicelab->has_callback_capability) {
    const struct capnweb_capability dispatch = {
      batch_dispatch,
      voicelab,
      NULL,
    };
    status = capnweb_session_export_capability(
        voicelab->options.session, dispatch, &voicelab->callback_capability);
    if (status != CAPNWEB_OK) {
      return fail(voicelab, ITERATE_KIT_VOICELAB_FAILURE_EXPORT, status);
    }
    voicelab->has_callback_capability = true;
  }

  ++voicelab->connection_generation;
  key_length = snprintf(
      key_text,
      sizeof(key_text),
      "%s-cb-g%" PRIu32,
      voicelab->options.call_id,
      voicelab->connection_generation);
  if (key_length < 0 || (size_t)key_length >= sizeof(key_text)) {
    return CAPNWEB_E_LIMIT;
  }

  event_type_items[0] = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_STRING,
    {.string = {"voicelab/spk-frame", sizeof("voicelab/spk-frame") - 1U}},
  };
  event_type_items[1] = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_STRING,
    {.string = {"voicelab/grok-event", sizeof("voicelab/grok-event") - 1U}},
  };
  event_type_items[2] = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_STRING,
    {.string = {"voicelab/call-ended", sizeof("voicelab/call-ended") - 1U}},
  };
  event_type_items[3] = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_STRING,
    {.string = {"voicelab/call-accepted", sizeof("voicelab/call-accepted") - 1U}},
  };
  /*
   * The pong exists to be heard, not read: it is the only bridge-sourced
   * event that arrives during a SILENT call, and silence is exactly when a
   * dead bridge is indistinguishable from a patient one.
   */
  event_type_items[4] = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_STRING,
    {.string = {"voicelab/pong", sizeof("voicelab/pong") - 1U}},
  };
  event_types = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_ARRAY,
    {.array = {event_type_items, 5U}},
  };
  connection_key = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_STRING,
    {.string = {key_text, (size_t)key_length}},
  };
  /*
   * Four events per batch, not two. The inbound MESSAGE count is what the
   * bounded inbox spends, and overflowing it is session-fatal: a long answer
   * at 100 speaker events/s arrived as 50 batches/s and overran the ring
   * (measured inboxDiscarded=8 mid-story, which killed the session). Same
   * audio in half the messages.
   */
  max_events = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_INT64,
    {.integer = 4},
  };
  max_bytes = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_INT64,
    {.integer = 5200},
  };
  no_state = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_BOOLEAN,
    {.boolean = false},
  };
  callback = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_CAPABILITY,
    {.capability = voicelab->callback_capability},
  };
  fields[0] = (struct capnweb_object_field){
    {"connectionKey", sizeof("connectionKey") - 1U},
    &connection_key,
  };
  fields[1] = (struct capnweb_object_field){
    {"eventTypes", sizeof("eventTypes") - 1U},
    &event_types,
  };
  fields[2] = (struct capnweb_object_field){
    {"maxDeliveryEvents", sizeof("maxDeliveryEvents") - 1U},
    &max_events,
  };
  fields[3] = (struct capnweb_object_field){
    {"maxDeliveryBytes", sizeof("maxDeliveryBytes") - 1U},
    &max_bytes,
  };
  fields[4] = (struct capnweb_object_field){
    {"state", sizeof("state") - 1U},
    &no_state,
  };
  fields[5] = (struct capnweb_object_field){
    {"processEventBatch", sizeof("processEventBatch") - 1U},
    &callback,
  };
  argument = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_OBJECT,
    {.object = {fields, 6U}},
  };
  status = capnweb_session_call_expressions(
      voicelab->options.session,
      voicelab->stream_capability,
      open_path,
      sizeof(open_path) / sizeof(open_path[0]),
      &argument,
      1U,
      connection_opened,
      voicelab);
  if (status == CAPNWEB_OK) {
    voicelab->recycle_pending = true;
  }
  return status;
}

static void stream_completed(
    void *context, const struct capnweb_result *result) {
  struct iterate_kit_voicelab *voicelab = context;
  enum capnweb_status status;
  if (voicelab->state == ITERATE_KIT_VOICELAB_CLOSED) {
    return;
  }
  if (result->kind == CAPNWEB_RESULT_SESSION_ENDED) {
    (void)fail(
        voicelab,
        ITERATE_KIT_VOICELAB_FAILURE_SESSION_ENDED,
        result->status);
    return;
  }
  if (result->kind == CAPNWEB_RESULT_REJECTION) {
    (void)fail(
        voicelab, ITERATE_KIT_VOICELAB_FAILURE_STREAM_REJECTED, CAPNWEB_OK);
    return;
  }
  if (!take_result_capability(result, &voicelab->stream_capability)) {
    (void)fail(
        voicelab,
        ITERATE_KIT_VOICELAB_FAILURE_STREAM_RESULT,
        CAPNWEB_E_INVALID_MESSAGE);
    return;
  }
  voicelab->has_stream_capability = true;
  /*
   * The project capability is deliberately KEPT for the session's life: it is
   * what `worker.startCall` is dialled on, so the device can open its own
   * call. One import slot is a cheap price for not needing a second
   * projects.get round trip per call.
   */
  if (voicelab->options.on_speaker == NULL) {
    voicelab->state = ITERATE_KIT_VOICELAB_READY;
    voicelab->failure = ITERATE_KIT_VOICELAB_FAILURE_NONE;
    voicelab->capnweb_status = CAPNWEB_OK;
    return;
  }
  voicelab->state = ITERATE_KIT_VOICELAB_OPENING_CONNECTION;
  status = iterate_kit_voicelab_recycle_connection(voicelab);
  if (status != CAPNWEB_OK) {
    (void)fail(voicelab, ITERATE_KIT_VOICELAB_FAILURE_OPEN_CALL, status);
  }
}

static void project_completed(
    void *context, const struct capnweb_result *result) {
  struct iterate_kit_voicelab *voicelab = context;
  struct capnweb_expression stream_path;
  enum capnweb_status status;
  if (voicelab->state == ITERATE_KIT_VOICELAB_CLOSED) {
    return;
  }
  if (result->kind == CAPNWEB_RESULT_SESSION_ENDED) {
    (void)fail(
        voicelab,
        ITERATE_KIT_VOICELAB_FAILURE_SESSION_ENDED,
        result->status);
    return;
  }
  if (result->kind == CAPNWEB_RESULT_REJECTION) {
    (void)fail(
        voicelab, ITERATE_KIT_VOICELAB_FAILURE_PROJECT_REJECTED, CAPNWEB_OK);
    return;
  }
  if (!take_result_capability(result, &voicelab->project_capability)) {
    (void)fail(
        voicelab,
        ITERATE_KIT_VOICELAB_FAILURE_PROJECT_RESULT,
        CAPNWEB_E_INVALID_MESSAGE);
    return;
  }
  voicelab->has_project_capability = true;
  status = release_remote(
      voicelab,
      &voicelab->session_capability,
      &voicelab->has_session_capability);
  if (status != CAPNWEB_OK) {
    (void)fail(voicelab, ITERATE_KIT_VOICELAB_FAILURE_RELEASE, status);
    return;
  }
  stream_path = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_STRING,
    {.string = {
      voicelab->options.stream_path,
      strlen(voicelab->options.stream_path),
    }},
  };
  voicelab->state = ITERATE_KIT_VOICELAB_GETTING_STREAM;
  status = capnweb_session_call_expressions(
      voicelab->options.session,
      voicelab->project_capability,
      streams_get_path,
      sizeof(streams_get_path) / sizeof(streams_get_path[0]),
      &stream_path,
      1U,
      stream_completed,
      voicelab);
  if (status != CAPNWEB_OK) {
    (void)fail(voicelab, ITERATE_KIT_VOICELAB_FAILURE_STREAM_CALL, status);
  }
}

static void authenticated(
    void *context, const struct capnweb_result *result) {
  struct iterate_kit_voicelab *voicelab = context;
  struct capnweb_expression project_id;
  enum capnweb_status status;
  if (voicelab->state == ITERATE_KIT_VOICELAB_CLOSED) {
    return;
  }
  if (result->kind == CAPNWEB_RESULT_SESSION_ENDED) {
    (void)fail(
        voicelab,
        ITERATE_KIT_VOICELAB_FAILURE_SESSION_ENDED,
        result->status);
    return;
  }
  if (result->kind == CAPNWEB_RESULT_REJECTION) {
    (void)fail(
        voicelab, ITERATE_KIT_VOICELAB_FAILURE_AUTH_REJECTED, CAPNWEB_OK);
    return;
  }
  if (!take_result_capability(result, &voicelab->session_capability)) {
    (void)fail(
        voicelab,
        ITERATE_KIT_VOICELAB_FAILURE_AUTH_RESULT,
        CAPNWEB_E_INVALID_MESSAGE);
    return;
  }
  voicelab->has_session_capability = true;
  project_id = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_STRING,
    {.string = {
      voicelab->options.project_id,
      strlen(voicelab->options.project_id),
    }},
  };
  voicelab->state = ITERATE_KIT_VOICELAB_GETTING_PROJECT;
  status = capnweb_session_call_expressions(
      voicelab->options.session,
      voicelab->session_capability,
      project_path,
      sizeof(project_path) / sizeof(project_path[0]),
      &project_id,
      1U,
      project_completed,
      voicelab);
  if (status != CAPNWEB_OK) {
    (void)fail(voicelab, ITERATE_KIT_VOICELAB_FAILURE_PROJECT_CALL, status);
  }
}

enum capnweb_status iterate_kit_voicelab_start(
    struct iterate_kit_voicelab *voicelab,
    const struct iterate_kit_voicelab_options *options) {
  static const struct capnweb_expression project_secret = {
    CAPNWEB_EXPRESSION_STRING,
    {.string = {"project-secret", sizeof("project-secret") - 1U}},
  };
  struct capnweb_expression project_id;
  struct capnweb_expression secret;
  struct capnweb_object_field auth_fields[3];
  struct capnweb_expression auth;
  enum capnweb_status status;

  if (voicelab == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  memset(voicelab, 0, sizeof(*voicelab));
  if (!valid_options(options)) {
    voicelab->state = ITERATE_KIT_VOICELAB_FAILED;
    voicelab->failure = ITERATE_KIT_VOICELAB_FAILURE_INVALID_OPTIONS;
    voicelab->capnweb_status = CAPNWEB_E_INVALID_ARGUMENT;
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  voicelab->options = *options;
  voicelab->last_spk_sequence = -1;
  voicelab->last_event_offset = -1;
  voicelab->state = ITERATE_KIT_VOICELAB_AUTHENTICATING;
  project_id = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_STRING,
    {.string = {options->project_id, strlen(options->project_id)}},
  };
  secret = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_STRING,
    {.string = {
      options->project_api_key,
      strlen(options->project_api_key),
    }},
  };
  auth_fields[0] = (struct capnweb_object_field){
    {"type", sizeof("type") - 1U},
    &project_secret,
  };
  auth_fields[1] = (struct capnweb_object_field){
    {"projectId", sizeof("projectId") - 1U},
    &project_id,
  };
  auth_fields[2] = (struct capnweb_object_field){
    {"secret", sizeof("secret") - 1U},
    &secret,
  };
  auth = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_OBJECT,
    {.object = {auth_fields, 3U}},
  };
  status = capnweb_session_call_expressions(
      options->session,
      (struct capnweb_remote_capability){0},
      authenticate_path,
      sizeof(authenticate_path) / sizeof(authenticate_path[0]),
      &auth,
      1U,
      authenticated,
      voicelab);
  if (status != CAPNWEB_OK) {
    return fail(voicelab, ITERATE_KIT_VOICELAB_FAILURE_AUTH_CALL, status);
  }
  return CAPNWEB_OK;
}

/* --- appends -------------------------------------------------------------- */

enum capnweb_status iterate_kit_voicelab_append_frame(
    struct iterate_kit_voicelab *voicelab,
    const uint8_t *pcm,
    size_t pcm_length,
    uint32_t sequence,
    uint64_t captured_at_ms) {
  int prefix_length;
  size_t encoded_length;
  size_t offset;
  enum capnweb_status status;
  if (voicelab == NULL ||
      pcm == NULL ||
      pcm_length == 0U ||
      pcm_length > ITERATE_KIT_VOICELAB_FRAME_BYTES) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (voicelab->state != ITERATE_KIT_VOICELAB_READY) {
    return CAPNWEB_E_STATE;
  }
  prefix_length = snprintf(
      voicelab->args_buffer,
      sizeof(voicelab->args_buffer),
      "[{\"type\":\"voicelab/mic-frame\",\"ephemeral\":true,"
      "\"payload\":{\"callId\":\"%s\",\"seq\":%" PRIu32
      ",\"t\":%" PRIu64 ",\"pcm\":\"",
      voicelab->options.call_id,
      sequence,
      captured_at_ms);
  if (prefix_length < 0 ||
      (size_t)prefix_length >= sizeof(voicelab->args_buffer)) {
    return CAPNWEB_E_LIMIT;
  }
  offset = (size_t)prefix_length;
  encoded_length = base64_encode(
      pcm,
      pcm_length,
      voicelab->args_buffer + offset,
      sizeof(voicelab->args_buffer) - offset - sizeof("\"}}]"));
  if (encoded_length == 0U) {
    return CAPNWEB_E_LIMIT;
  }
  offset += encoded_length;
  memcpy(voicelab->args_buffer + offset, "\"}}]", sizeof("\"}}]"));
  offset += sizeof("\"}}]") - 1U;

  status = capnweb_session_call_oneway_path(
      voicelab->options.session,
      voicelab->stream_capability,
      append_path,
      1U,
      voicelab->args_buffer,
      offset);
  if (status == CAPNWEB_OK) {
    ++voicelab->frames_sent;
  } else {
    ++voicelab->frame_send_failures;
  }
  return status;
}

enum capnweb_status iterate_kit_voicelab_append_frames(
    struct iterate_kit_voicelab *voicelab,
    const uint8_t *const *frames,
    size_t frame_count,
    size_t frame_length,
    uint32_t sequence,
    uint64_t captured_at_ms) {
  int written;
  size_t offset;
  size_t encoded_length;
  size_t index;
  enum capnweb_status status;
  if (voicelab == NULL ||
      frames == NULL ||
      frame_count == 0U ||
      frame_count > ITERATE_KIT_VOICELAB_MAX_FRAMES_PER_APPEND ||
      frame_length == 0U ||
      frame_length > ITERATE_KIT_VOICELAB_FRAME_BYTES) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (voicelab->state != ITERATE_KIT_VOICELAB_READY) {
    return CAPNWEB_E_STATE;
  }
  for (index = 0U; index < frame_count; ++index) {
    if (frames[index] == NULL) {
      return CAPNWEB_E_INVALID_ARGUMENT;
    }
  }
  offset = 0U;
  voicelab->args_buffer[offset++] = '[';
  for (index = 0U; index < frame_count; ++index) {
    written = snprintf(
        voicelab->args_buffer + offset,
        sizeof(voicelab->args_buffer) - offset,
        "%s{\"type\":\"voicelab/mic-frame\",\"ephemeral\":true,"
        "\"payload\":{\"callId\":\"%s\",\"seq\":%" PRIu32
        ",\"t\":%" PRIu64 ",\"pcm\":\"",
        index == 0U ? "" : ",",
        voicelab->options.call_id,
        sequence + (uint32_t)index,
        captured_at_ms);
    if (written < 0 ||
        (size_t)written >= sizeof(voicelab->args_buffer) - offset) {
      ++voicelab->frame_send_failures;
      return CAPNWEB_E_LIMIT;
    }
    offset += (size_t)written;
    encoded_length = base64_encode(
        frames[index],
        frame_length,
        voicelab->args_buffer + offset,
        sizeof(voicelab->args_buffer) - offset - sizeof("\"}}]"));
    if (encoded_length == 0U) {
      /* The args buffer could not hold this batch — count it, or the
       * microphone goes quiet with every counter reading zero. */
      ++voicelab->frame_send_failures;
      return CAPNWEB_E_LIMIT;
    }
    offset += encoded_length;
    if (offset + 4U >= sizeof(voicelab->args_buffer)) {
      ++voicelab->frame_send_failures;
      return CAPNWEB_E_LIMIT;
    }
    memcpy(voicelab->args_buffer + offset, "\"}}", 3U);
    offset += 3U;
  }
  voicelab->args_buffer[offset++] = ']';

  status = capnweb_session_call_oneway_path(
      voicelab->options.session,
      voicelab->stream_capability,
      append_path,
      1U,
      voicelab->args_buffer,
      offset);
  if (status == CAPNWEB_OK) {
    voicelab->frames_sent += (uint32_t)frame_count;
  } else {
    ++voicelab->frame_send_failures;
  }
  return status;
}

enum capnweb_status iterate_kit_voicelab_append_raw(
    struct iterate_kit_voicelab *voicelab,
    const char *events_json_array,
    size_t length) {
  if (voicelab == NULL || events_json_array == NULL || length == 0U) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (voicelab->state != ITERATE_KIT_VOICELAB_READY) {
    return CAPNWEB_E_STATE;
  }
  return capnweb_session_call_oneway_path(
      voicelab->options.session,
      voicelab->stream_capability,
      append_path,
      1U,
      events_json_array,
      length);
}

static void start_call_completed(
    void *context, const struct capnweb_result *result) {
  struct iterate_kit_voicelab *voicelab = context;
  voicelab->call_pending = false;
  if (result->kind == CAPNWEB_RESULT_VALUE && result->status == CAPNWEB_OK) {
    ++voicelab->call_starts;
  } else {
    ++voicelab->call_failures;
  }
}

enum capnweb_status iterate_kit_voicelab_start_call(
    struct iterate_kit_voicelab *voicelab, const char *greeting) {
  int length;
  enum capnweb_status status;
  if (voicelab == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (voicelab->state != ITERATE_KIT_VOICELAB_READY ||
      voicelab->call_pending || !voicelab->has_project_capability) {
    return CAPNWEB_E_STATE;
  }
  /*
   * `pace` asks the worker to drip speaker frames at ~2x realtime: this
   * inbox is bounded and cannot absorb a whole answer arriving in one TCP
   * clump.
   */
  length = snprintf(
      voicelab->args_buffer,
      sizeof(voicelab->args_buffer),
      /*
       * `colleague` gives the voice its one tool and a text agent behind it.
       * The voice model is a mouth with a couple of hundred milliseconds to
       * think in; anything that has to be RIGHT is asked of a colleague with
       * no clock on it, and the voice says so and keeps talking meanwhile.
       */
      "[{\"path\":\"%s\",\"callId\":\"%s\",\"pace\":true,\"colleague\":true,"
      "\"turns\":\"manual\"%s%s%s}]",
      voicelab->options.stream_path,
      voicelab->options.call_id,
      greeting != NULL ? ",\"greet\":\"" : "",
      greeting != NULL ? greeting : "",
      greeting != NULL ? "\"" : "");
  if (length < 0 || (size_t)length >= sizeof(voicelab->args_buffer)) {
    return CAPNWEB_E_LIMIT;
  }
  status = capnweb_session_call_path(
      voicelab->options.session,
      voicelab->project_capability,
      start_call_path,
      sizeof(start_call_path) / sizeof(start_call_path[0]),
      voicelab->args_buffer,
      (size_t)length,
      start_call_completed,
      voicelab);
  if (status == CAPNWEB_OK) {
    voicelab->call_pending = true;
  }
  return status;
}

void iterate_kit_voicelab_forget_call(struct iterate_kit_voicelab *voicelab) {
  if (voicelab == NULL) {
    return;
  }
  voicelab->call_active = false;
  voicelab->call_pending = false;
  voicelab->live_bridge_id[0] = '\0';
  voicelab->last_bridge_ms = 0U;
}

enum capnweb_status iterate_kit_voicelab_end_call(
    struct iterate_kit_voicelab *voicelab, const char *reason) {
  int length;
  if (voicelab == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (voicelab->state != ITERATE_KIT_VOICELAB_READY) {
    return CAPNWEB_E_STATE;
  }
  length = snprintf(
      voicelab->args_buffer,
      sizeof(voicelab->args_buffer),
      "[{\"type\":\"voicelab/call-ended\",\"payload\":{"
      "\"callId\":\"%s\",\"reason\":\"%s\"}}]",
      voicelab->options.call_id,
      reason != NULL ? reason : "hangup");
  if (length < 0 || (size_t)length >= sizeof(voicelab->args_buffer)) {
    return CAPNWEB_E_LIMIT;
  }
  voicelab->call_active = false;
  return capnweb_session_call_oneway_path(
      voicelab->options.session,
      voicelab->stream_capability,
      append_path,
      1U,
      voicelab->args_buffer,
      (size_t)length);
}

enum capnweb_status iterate_kit_voicelab_mark_turn(
    struct iterate_kit_voicelab *voicelab,
    enum iterate_kit_voicelab_turn turn) {
  int length;
  if (voicelab == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (voicelab->state != ITERATE_KIT_VOICELAB_READY) {
    return CAPNWEB_E_STATE;
  }
  if (turn == ITERATE_KIT_VOICELAB_TURN_START) {
    /* A new turn cancels whatever answer was mid-flight; its partial text
     * must not prefix the next one. */
    voicelab->transcript_length = 0U;
  }
  length = snprintf(
      voicelab->args_buffer,
      sizeof(voicelab->args_buffer),
      "[{\"type\":\"voicelab/turn\",\"ephemeral\":true,\"payload\":{"
      "\"callId\":\"%s\",\"action\":\"%s\",\"t\":%" PRIu64 "}}]",
      voicelab->options.call_id,
      turn == ITERATE_KIT_VOICELAB_TURN_START ? "start" : "commit",
      voicelab->options.now_ms(voicelab->options.clock_context));
  if (length < 0 || (size_t)length >= sizeof(voicelab->args_buffer)) {
    return CAPNWEB_E_LIMIT;
  }
  return capnweb_session_call_oneway_path(
      voicelab->options.session,
      voicelab->stream_capability,
      append_path,
      1U,
      voicelab->args_buffer,
      (size_t)length);
}

static void ping_completed(
    void *context, const struct capnweb_result *result) {
  struct iterate_kit_voicelab *voicelab = context;
  uint64_t now;
  voicelab->ping_pending = false;
  if (result->kind == CAPNWEB_RESULT_VALUE && result->status == CAPNWEB_OK) {
    now = voicelab->options.now_ms(voicelab->options.clock_context);
    voicelab->last_rtt_ms = (uint32_t)(now - voicelab->ping_started_ms);
    ++voicelab->ping_count;
  } else {
    ++voicelab->ping_failures;
  }
}

enum capnweb_status iterate_kit_voicelab_ping(
    struct iterate_kit_voicelab *voicelab) {
  int length;
  enum capnweb_status status;
  if (voicelab == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (voicelab->state != ITERATE_KIT_VOICELAB_READY ||
      voicelab->ping_pending) {
    return CAPNWEB_E_STATE;
  }
  voicelab->ping_started_ms =
      voicelab->options.now_ms(voicelab->options.clock_context);
  length = snprintf(
      voicelab->args_buffer,
      sizeof(voicelab->args_buffer),
      "[{\"type\":\"voicelab/ping\",\"ephemeral\":true,"
      "\"payload\":{\"id\":\"%s-%" PRIu32 "\",\"t0\":%" PRIu64 "}}]",
      voicelab->options.call_id,
      voicelab->ping_count,
      voicelab->ping_started_ms);
  if (length < 0 || (size_t)length >= sizeof(voicelab->args_buffer)) {
    return CAPNWEB_E_LIMIT;
  }
  status = capnweb_session_call_path(
      voicelab->options.session,
      voicelab->stream_capability,
      append_path,
      1U,
      voicelab->args_buffer,
      (size_t)length,
      ping_completed,
      voicelab);
  if (status == CAPNWEB_OK) {
    voicelab->ping_pending = true;
  }
  return status;
}

enum capnweb_status iterate_kit_voicelab_close(
    struct iterate_kit_voicelab *voicelab) {
  enum capnweb_status first_error = CAPNWEB_OK;
  enum capnweb_status status;
  if (voicelab == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  status = release_remote(
      voicelab,
      &voicelab->connection_capability,
      &voicelab->has_connection_capability);
  if (status != CAPNWEB_OK && first_error == CAPNWEB_OK) {
    first_error = status;
  }
  status = release_remote(
      voicelab,
      &voicelab->previous_connection_capability,
      &voicelab->has_previous_connection_capability);
  if (status != CAPNWEB_OK && first_error == CAPNWEB_OK) {
    first_error = status;
  }
  if (voicelab->has_callback_capability) {
    status = capnweb_session_release_local_capability(
        voicelab->options.session, voicelab->callback_capability);
    if (status == CAPNWEB_OK) {
      voicelab->has_callback_capability = false;
    } else if (first_error == CAPNWEB_OK) {
      first_error = status;
    }
  }
  status = release_remote(
      voicelab,
      &voicelab->stream_capability,
      &voicelab->has_stream_capability);
  if (status != CAPNWEB_OK && first_error == CAPNWEB_OK) {
    first_error = status;
  }
  status = release_remote(
      voicelab,
      &voicelab->project_capability,
      &voicelab->has_project_capability);
  if (status != CAPNWEB_OK && first_error == CAPNWEB_OK) {
    first_error = status;
  }
  status = release_remote(
      voicelab,
      &voicelab->session_capability,
      &voicelab->has_session_capability);
  if (status != CAPNWEB_OK && first_error == CAPNWEB_OK) {
    first_error = status;
  }
  voicelab->state = ITERATE_KIT_VOICELAB_CLOSED;
  return first_error;
}

const char *iterate_kit_voicelab_state_name(
    enum iterate_kit_voicelab_state state) {
  switch (state) {
    case ITERATE_KIT_VOICELAB_IDLE: return "idle";
    case ITERATE_KIT_VOICELAB_AUTHENTICATING: return "authenticating";
    case ITERATE_KIT_VOICELAB_GETTING_PROJECT: return "getting-project";
    case ITERATE_KIT_VOICELAB_GETTING_STREAM: return "getting-stream";
    case ITERATE_KIT_VOICELAB_OPENING_CONNECTION: return "opening-connection";
    case ITERATE_KIT_VOICELAB_READY: return "ready";
    case ITERATE_KIT_VOICELAB_FAILED: return "failed";
    case ITERATE_KIT_VOICELAB_CLOSED: return "closed";
    default: return "unknown";
  }
}

const char *iterate_kit_voicelab_failure_name(
    enum iterate_kit_voicelab_failure failure) {
  switch (failure) {
    case ITERATE_KIT_VOICELAB_FAILURE_NONE: return "none";
    case ITERATE_KIT_VOICELAB_FAILURE_INVALID_OPTIONS:
      return "invalid-options";
    case ITERATE_KIT_VOICELAB_FAILURE_AUTH_CALL: return "auth-call";
    case ITERATE_KIT_VOICELAB_FAILURE_AUTH_REJECTED: return "auth-rejected";
    case ITERATE_KIT_VOICELAB_FAILURE_AUTH_RESULT: return "auth-result";
    case ITERATE_KIT_VOICELAB_FAILURE_PROJECT_CALL: return "project-call";
    case ITERATE_KIT_VOICELAB_FAILURE_PROJECT_REJECTED:
      return "project-rejected";
    case ITERATE_KIT_VOICELAB_FAILURE_PROJECT_RESULT:
      return "project-result";
    case ITERATE_KIT_VOICELAB_FAILURE_STREAM_CALL: return "stream-call";
    case ITERATE_KIT_VOICELAB_FAILURE_STREAM_REJECTED:
      return "stream-rejected";
    case ITERATE_KIT_VOICELAB_FAILURE_STREAM_RESULT: return "stream-result";
    case ITERATE_KIT_VOICELAB_FAILURE_OPEN_CALL: return "open-call";
    case ITERATE_KIT_VOICELAB_FAILURE_OPEN_REJECTED: return "open-rejected";
    case ITERATE_KIT_VOICELAB_FAILURE_OPEN_RESULT: return "open-result";
    case ITERATE_KIT_VOICELAB_FAILURE_EXPORT: return "export";
    case ITERATE_KIT_VOICELAB_FAILURE_RELEASE: return "release";
    case ITERATE_KIT_VOICELAB_FAILURE_SESSION_ENDED:
      return "session-ended";
    default: return "unknown";
  }
}
