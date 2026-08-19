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
      nonempty(options->conversation_id) &&
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

/*
 * THE UPLINK MU-LAW ENCODER WAS HERE, AND WHY IT MIGHT HAVE TO COME BACK.
 *
 * It was removed deliberately: two codecs on one wire is two chances for the
 * ends to disagree, and they did — a server that read the bytes as PCM16 while
 * the device sent mu-law produced a call that heard nothing, answered nothing
 * and logged nothing. PCM16 both ways deletes that whole class of fault.
 *
 * What it cost is on record and is NOT theoretical. Before mu-law, a 3-second
 * turn put roughly 100 KB/s of base64 PCM16 on the wire in one burst and the
 * TCP flow stalled dead — both directions, no errors, twenty seconds at a
 * time. That is the "I hold the button and nothing happens" this lab spent
 * days on. Halving the bytes fixed it, and also quartered the message rate,
 * because twice as many frames fit one append.
 *
 * So the uplink is back to where that happened. A host CLI on a wired network
 * will never show it; only a board on Wi-Fi can. If the stall returns, this is
 * the first thing to put back, and `git log` has the exact encoder.
 */

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

/*
 * THE DOWNLINK MU-LAW EXPANDER WAS HERE. Same story as the encoder above, and
 * the same warning: it was measured delivering 9-31 frames a second against
 * the 50 that realtime needs, and halving the bytes was the only lever that
 * did not require the far end to guess at this network. PCM16 is what the
 * speaker path wants anyway, so nothing decodes anything now — but if a board
 * starts concealing, this is where the fix went.
 */

/*
 * THE WHOLE OF THE DEVICE'S SPEAKER POLICY: clear it, or write it.
 *
 * WHAT USED TO BE HERE. Every chunk carried an answer number, a frame index
 * and a sequence, and the board ran a 230-line classifier (`audio_playout.c`)
 * over them to work out for itself whether the audio was still wanted:
 * high-water marks, abandoned-answer latches, restart detection, duplicate
 * rejection. Three separate bugs in it silenced the device PERMANENTLY — each
 * one a number the sender could never reach again — and all three were found
 * by listening to a board go quiet and then guessing. It was answering a
 * question the sender already knows the answer to.
 *
 * The sender says `drop` instead, on the first chunk of a replacing answer.
 * It cannot be reordered against the audio it invalidates because it IS that
 * audio, and there is nothing left to get wrong.
 *
 * DEDUPLICATION IS NOT DONE HERE EITHER. A make-before-break recycle really
 * does deliver the same events twice, and that is handled one layer up by
 * event OFFSET (`dispatch_batch`), which is where the identity of an event
 * actually lives. Doing it again by audio content was a second answer to the
 * same question, and the two could disagree.
 */
static void handle_spk_frame(
    struct iterate_kit_voicelab *voicelab,
    const struct capnweb_value *payload) {
  struct capnweb_value pcm_value;
  struct capnweb_value flag;
  size_t b64_length;
  size_t chunk_length = 0U;
  bool drop = false;
  bool last = false;

  /*
   * NOTHING PLAYS INTO A CALL THIS DEVICE IS NOT ON. The end button's
   * abandon empties the queue, but the rest of the answer is still IN
   * FLIGHT and refilled it — "call ended", then the call kept talking. The
   * device's own end clears `call_active` synchronously, so the tail dies
   * here; a far-end goodbye keeps the call until its obituary, so it plays.
   */
  if (!voicelab->call_active) return;


  if (capnweb_value_object_get(payload, "drop", &flag)) {
    (void)capnweb_value_get_boolean(&flag, &drop);
  }
  /*
   * THE SAME INSTRUCTION UNDER THE SECOND AGENT'S NAME FOR IT.
   *
   * `drop` named no audio: it said "empty your ring" and nothing about which
   * answer it meant, so a late one discarded the answer that had already
   * replaced the one it was about. The rewrite binds the clear to a numbered
   * frame and calls it what the device DOES — clear the buffer, then play THIS
   * frame — and the device's whole buffer policy is readable off the payload.
   *
   * Both are honoured, because both agents are in service and the point of
   * running them side by side is that the instrument does not change between
   * them. Either being true means clear.
   */
  if (!drop &&
      capnweb_value_object_get(payload, "clearSpeakerBufferBeforeFrame", &flag)) {
    (void)capnweb_value_get_boolean(&flag, &drop);
  }
  if (capnweb_value_object_get(payload, "last", &flag)) {
    (void)capnweb_value_get_boolean(&flag, &last);
  }
  /*
   * The second agent's name for the same edge. It says what the frame MEANS —
   * this is the last frame of the answer — rather than `last`, which needed
   * the reader to already know what it was the last of.
   */
  if (!last && capnweb_value_object_get(payload, "lastFrameOfAnswer", &flag)) {
    (void)capnweb_value_get_boolean(&flag, &last);
  }

  /*
   * COUNTED BEFORE THE AUDIO IS TOUCHED, so a chunk that fails to decode is
   * still counted as having ARRIVED. Continuity is a question about the
   * delivery lane; whether the bytes were good is a separate counter, and
   * folding the two would let a decode failure masquerade as a lost frame.
   */
  {
    struct capnweb_value seq_value;
    int64_t seq = 0;
    if (capnweb_value_object_get(payload, "deviceSpeakerFrameSeq", &seq_value) &&
        capnweb_value_get_int64(&seq_value, &seq)) {
      if (voicelab->spk_seq_last >= 0) {
        if (seq > voicelab->spk_seq_last + 1) {
          ++voicelab->spk_seq_gaps;
          voicelab->spk_seq_missing +=
              (uint32_t)(seq - voicelab->spk_seq_last - 1);
        } else if (seq <= voicelab->spk_seq_last) {
          ++voicelab->spk_seq_regressions;
        }
      }
      /* Only ever forwards: a regression must not rewind the watermark, or the
       * frames after it would each be counted as a gap in turn. */
      if (seq > voicelab->spk_seq_last) voicelab->spk_seq_last = seq;
    }
  }

  /*
   * `drop` FIRST, AND BEFORE ANYTHING CAN GO WRONG WITH THE AUDIO.
   *
   * The device does not decide turns; it does what the server's frames say.
   * `drop` is the server saying "empty your ring", and it is true whether or
   * not this chunk carries audio, so nothing about decoding audio may stand
   * between it and being obeyed.
   *
   * It used to sit BELOW the decode, which has an early `return` on failure.
   * A barge-in is exactly the case where the sender has no audio left to
   * attach the flag to — it has just thrown the answer away — so it sends the
   * flag on an empty chunk, whose empty `pcm` string decodes to nothing, takes
   * that early return, and never reaches the drop. The server said stop, the
   * device agreed to obey, and the message was discarded on the doorstep for
   * being an empty envelope. Three fixes upstream of here were measured
   * against that and moved nothing.
   */
  if (drop && voicelab->options.on_control != NULL) {
    voicelab->options.on_control(
        voicelab->options.downlink_context,
        ITERATE_KIT_VOICELAB_CONTROL_SPEECH_STARTED);
  }

  /*
   * A CHUNK WITH NO AUDIO IS NOT A BROKEN CHUNK. The sender closes an answer
   * whose audio has already all gone with a bare `last`, and that chunk is the
   * only thing that releases the half-duplex fence. Treating it as a decode
   * failure and returning early is what made a conversation go deaf after two
   * or three turns.
   */
  if (capnweb_value_object_get(payload, "pcm", &pcm_value)) {
    if (capnweb_value_copy_string(
            &pcm_value,
            voicelab->b64_buffer,
            sizeof(voicelab->b64_buffer),
            &b64_length) != CAPNWEB_OK ||
        !base64_decode(
            voicelab->b64_buffer,
            b64_length,
            voicelab->chunk_buffer,
            sizeof(voicelab->chunk_buffer),
            &chunk_length)) {
      ++voicelab->spk_decode_failures;
      return;
    }
  }

  /*
   * STRAIGHT THROUGH, WHATEVER THE LENGTH. The speaker is a byte ring and the
   * chunk is appended to the end of it; where one chunk stops and the next
   * starts is not a thing either side has to agree on.
   *
   * IT USED TO GO OUT 640 BYTES AT A TIME, and that rule cost more than it ever
   * bought. It made a chunk with anything left over on the end a protocol
   * violation to be counted and dropped, which every chunk had, because Grok's
   * deltas are audio of no particular length: 118 dropped chunks in three turns.
   * Buying it back needed the sender to carry a remainder between deltas and pad
   * an answer's tail with silence. The click that the rule was supposed to
   * prevent cannot happen — a ring has no phase, and consecutive PCM16 samples
   * written consecutively are the same waveform however they were cut.
   */
  if (chunk_length > 0U && voicelab->options.on_speaker != NULL) {
    ++voicelab->spk_frames_received;
    voicelab->options.on_speaker(
        voicelab->options.downlink_context, voicelab->chunk_buffer, chunk_length);
  }

  /*
   * AND THE END OF THE ANSWER RIDES ITS LAST CHUNK, announced AFTER the audio
   * is handed over so the buffer the owner is about to call drained already
   * holds everything it will ever hold. This was once a separate
   * `response.done` on the provider's own event lane, where it routinely
   * arrived FIRST and cost 258 received frames that were never played.
   */
  if (last && voicelab->options.on_control != NULL) {
    voicelab->options.on_control(
        voicelab->options.downlink_context,
        ITERATE_KIT_VOICELAB_CONTROL_RESPONSE_DONE);
  }
}

/*
 * `handle_viseme` and `handle_grok_event` were here.
 *
 * The face is no longer an event: it is reduced state in the facet's runtime
 * bag, published through `liveState`, and the `viseme` type is deleted from
 * the contract. `grok-event` carried exactly two facts this device acted on,
 * `speech_started` and `response.done`, and both now ride the `spk-frame` that
 * they are about — see the two notes in `handle_spk_frame` for why that is not
 * merely tidier but removes an ordering question neither lane could answer.
 */

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
  /*
   * Stamped for the BATCH, before its contents are inspected and regardless
   * of what it holds: this is the proof that the delivery lane still exists,
   * which is a different question from whether anything interesting was on
   * it. An empty batch proves the lane; a dropped duplicate proves it too.
   */
  voicelab->last_batch_ms =
      voicelab->options.now_ms(voicelab->options.clock_context);
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
    /* Report the type before dispatching, so an event nothing handles is still
     * visible — "arrived and was ignored" and "never arrived" are different
     * bugs and used to look identical from outside. */
    if (voicelab->options.on_event_seen != NULL) {
      /* Bounded stack copy: a type is a short constant, and the observability
       * path must not be able to allocate or to outlive the value it read. */
      char seen_type[96];
      size_t seen_length = 0U;
      if (capnweb_value_copy_string(
              &type_value, seen_type, sizeof(seen_type), &seen_length) ==
          CAPNWEB_OK) {
        voicelab->options.on_event_seen(
            voicelab->options.downlink_context, seen_type, seen_length);
      }
    }
    if (capnweb_value_string_equals(
            &type_value, "events.iterate.com/voice-agent/spk-frame")) {
      handle_spk_frame(voicelab, &payload);
    } else if (capnweb_value_string_equals(
                   &type_value, "events.iterate.com/voice-agent/conversation-accepted")) {
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
      {
        struct capnweb_value conversation_value;
        size_t length = 0U;
        voicelab->live_conversation_id[0] = '\0';
        if (capnweb_value_object_get(
                &payload, "conversationId", &conversation_value)) {
          (void)capnweb_value_copy_string(
              &conversation_value,
              voicelab->live_conversation_id,
              sizeof(voicelab->live_conversation_id),
              &length);
        }
      }
      voicelab->call_active = true;
      voicelab->call_pending = false;
      /*
       * THE WATERMARK IS PER-CONVERSATION; THE TOTALS ARE PER-RUN.
       *
       * Sequence numbers restart at zero with each call, so carrying the
       * watermark across one would score every new call's first frame as a
       * regression and the rest as a fresh gap. The gap and regression TOTALS
       * deliberately survive: the question a long session is asking is how
       * much audio it lost in all, not how much it lost since the last time
       * somebody pressed the button.
       */
      voicelab->spk_seq_last = -1;
      if (voicelab->options.on_control != NULL) {
        voicelab->options.on_control(
            voicelab->options.downlink_context,
            ITERATE_KIT_VOICELAB_CONTROL_CALL_ACCEPTED);
      }
    } else if (capnweb_value_string_equals(
                   &type_value,
                   "events.iterate.com/voice-agent/conversation-ended")) {
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
      /*
       * AND ONLY THIS CONVERSATION'S OBITUARY COUNTS. Consecutive calls on
       * one stream share a bridge, so the bridge guard alone let the
       * previous call's late obituary kill the call a person had JUST
       * opened — accepted at 14:41:09.576, dead at .647, and the device
       * then announced an end it never asked for.
       */
      {
        struct capnweb_value conversation_value;
        char ended_conversation[sizeof(voicelab->live_conversation_id)] = {0};
        size_t ended_length = 0U;
        if (voicelab->live_conversation_id[0] != '\0' &&
            capnweb_value_object_get(
                &payload, "conversationId", &conversation_value) &&
            capnweb_value_copy_string(
                &conversation_value,
                ended_conversation,
                sizeof(ended_conversation),
                &ended_length) == CAPNWEB_OK &&
            strcmp(ended_conversation, voicelab->live_conversation_id) != 0) {
          continue; /* an earlier conversation's obituary; not our call */
        }
      }
      voicelab->live_bridge_id[0] = '\0';
      voicelab->live_conversation_id[0] = '\0';
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
  /* A fresh lane starts its deadline now, not from whenever it last spoke. */
  voicelab->last_batch_ms =
      voicelab->options.now_ms(voicelab->options.clock_context);
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
  struct capnweb_expression event_type_items[3];
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
      voicelab->options.conversation_id,
      voicelab->connection_generation);
  if (key_length < 0 || (size_t)key_length >= sizeof(key_text)) {
    return CAPNWEB_E_LIMIT;
  }

  event_type_items[0] = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_STRING,
    {.string = {
      "events.iterate.com/voice-agent/spk-frame",
      sizeof("events.iterate.com/voice-agent/spk-frame") - 1U,
    }},
  };
  event_type_items[1] = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_STRING,
    {.string = {
      "events.iterate.com/voice-agent/conversation-ended",
      sizeof("events.iterate.com/voice-agent/conversation-ended") - 1U,
    }},
  };
  event_type_items[2] = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_STRING,
    {.string = {
      "events.iterate.com/voice-agent/conversation-accepted",
      sizeof("events.iterate.com/voice-agent/conversation-accepted") - 1U,
    }},
  };
  event_types = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_ARRAY,
    {.array = {event_type_items, 3U}},
  };
  connection_key = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_STRING,
    {.string = {key_text, (size_t)key_length}},
  };
  /*
   * SIXTEEN events per batch, because delivery is one batch at a time and
   * the batch is therefore the unit of BANDWIDTH, not just of memory.
   *
   * Measured: 5.7 batches a second, so four events per batch carried 80 ms
   * of speech every 175 ms. Under half realtime. The device played 94 of the
   * 200 frames in one answer and concealed 122 — heard as speech that breaks
   * up and then stops. Twelve carried 1.37x realtime at the same rate; now
   * that viseme events (~10/s during speech, tiny) share the lane with the
   * 50/s of audio, sixteen keeps the audio at ~1.5x realtime so the mouth
   * track never costs the voice its cushion.
   *
   * The floor on this is the inbox slot (16 KiB) — sixteen mu-law frames are
   * ~10 KiB of batch, still inside it; the ceiling is politeness to the
   * platform's own read budget.
   */
  max_events = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_INT64,
    {.integer = 16},
  };
  max_bytes = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_INT64,
    {.integer = 13000},
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
  /* The project capability remains until close because the common session
   * teardown releases imported stubs in reverse acquisition order. Call
   * control itself now rides this stream capability. */
  if (voicelab->options.on_speaker == NULL) {
    voicelab->state = ITERATE_KIT_VOICELAB_READY;
    voicelab->failure = ITERATE_KIT_VOICELAB_FAILURE_NONE;
    voicelab->capnweb_status = CAPNWEB_OK;
    return;
  }
  voicelab->state = ITERATE_KIT_VOICELAB_OPENING_CONNECTION;
  status = iterate_kit_voicelab_recycle_connection(voicelab);
  /*
   * KEEP THE SPECIFIC FAILURE. `recycle_connection` fails through `fail()`
   * itself for the causes it can name — a full export table is
   * FAILURE_EXPORT — and overwriting that here relabelled every one of them
   * "open-call". Which is how a leaked capability spent an evening looking
   * like a networking problem.
   */
  if (status != CAPNWEB_OK && voicelab->state != ITERATE_KIT_VOICELAB_FAILED) {
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
  /*
   * HAND BACK WHAT THE LAST MOUNT HELD, BEFORE FORGETTING IT.
   *
   * The memset below is what a fresh mount needs and what made re-mounting
   * leak: it threw away `callback_capability` and its `has_` flag while the
   * SESSION still held that export slot, so every re-mount burned one. The
   * export table holds four and a healthy board already uses two — so the
   * second re-mount filled it, `capnweb_session_export_capability` refused,
   * and the voicelab latched failed with a ready transport and a ready
   * connection under it. Measured on the HA Voice PE: exports 4/4, imports
   * 0/16, nothing delivered, every call request ignored for the three minutes
   * it took the liveness watchdog to restart the whole chip.
   *
   * A zeroed struct — a static on its first mount — has no session and no
   * `has_` flags set, so this is a no-op there rather than a release of
   * whatever the stack happened to hold.
   */
  if (voicelab->options.session != NULL) {
    (void)iterate_kit_voicelab_close(voicelab);
  }
  memset(voicelab, 0, sizeof(*voicelab));
  /* -1 rather than the memset's 0, because 0 is a legal first sequence number
   * and "none seen yet" has to be a value no frame can carry. */
  voicelab->spk_seq_last = -1;
  if (!valid_options(options)) {
    voicelab->state = ITERATE_KIT_VOICELAB_FAILED;
    voicelab->failure = ITERATE_KIT_VOICELAB_FAILURE_INVALID_OPTIONS;
    voicelab->capnweb_status = CAPNWEB_E_INVALID_ARGUMENT;
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  voicelab->options = *options;
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
        /*
         * NO conversationId. The client does not know which call it is on and
         * does not need to: frames belong to whatever call its own press
         * opened. Naming one here made the device a second source of truth for
         * a fact only the server holds.
         */
        "%s{\"type\":\"events.iterate.com/voice-agent/mic-frame\",\"ephemeral\":true,"
        "\"payload\":{\"seq\":%" PRIu32
        /* No codec field. It said "p" for PCM16 while the servers still had a
         * mu-law arm to avoid; with that arm gone it was a constant nobody
         * read, sent fifty times a second. */
        ",\"t\":%" PRIu64 ",\"pcm\":\"",
        index == 0U ? "" : ",",
        sequence + (uint32_t)index,
        captured_at_ms);
    if (written < 0 ||
        (size_t)written >= sizeof(voicelab->args_buffer) - offset) {
      ++voicelab->frame_send_failures;
      return CAPNWEB_E_LIMIT;
    }
    offset += (size_t)written;
    /* Straight from the capture buffer: no transcode, no staging buffer. */
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

/* --- the face, pulled out of the processor's own runtime bag ------------- */

static const char *const runtime_state_path[] = {"getProcessorRuntimeState"};

/**
 * `{ snapshot, runtime }`, and `runtime.face` is what this is for.
 *
 * `face` is NULL until the mouth has first moved, which is the normal state at
 * the opening of every answer — so a missing field is not a failure and is not
 * counted as one.
 */
static void face_poll_completed(
    void *context, const struct capnweb_result *result) {
  struct iterate_kit_voicelab *voicelab = context;
  struct capnweb_value runtime_bag = {0};
  struct capnweb_value face = {0};
  struct capnweb_value field = {0};
  int64_t answer = 0;
  int64_t playout_samples = 0;
  int64_t viseme = 0;
  int64_t confidence = 0;
  int64_t at = 0;

  voicelab->face_poll_pending = false;
  if (result->kind != CAPNWEB_RESULT_VALUE || result->status != CAPNWEB_OK) {
    return;
  }
  if (!capnweb_value_object_get(&result->value, "runtime", &runtime_bag) ||
      !capnweb_value_object_get(&runtime_bag, "face", &face)) {
    return;
  }
  if (!capnweb_value_object_get(&face, "answer", &field) ||
      !capnweb_value_get_int64(&field, &answer) ||
      !capnweb_value_object_get(&face, "playoutSamples", &field) ||
      !capnweb_value_get_int64(&field, &playout_samples) ||
      !capnweb_value_object_get(&face, "viseme", &field) ||
      !capnweb_value_get_int64(&field, &viseme) ||
      !capnweb_value_object_get(&face, "at", &field) ||
      !capnweb_value_get_int64(&field, &at)) {
    return;
  }
  /* Confidence is the one field the classifier may legitimately omit. */
  if (capnweb_value_object_get(&face, "confidence", &field)) {
    (void)capnweb_value_get_int64(&field, &confidence);
  }
  if (answer < 0 || playout_samples < 0 || viseme < 0 || viseme > 14 ||
      at <= 0) {
    return;
  }
  /*
   * THE SAME SHAPE COMES BACK UNTIL THE MOUTH MOVES, because this is state and
   * not an event stream. Forwarding it every poll would feed the avatar's
   * queue ten identical changes a second and make its ledger count shapes that
   * never happened.
   */
  if ((uint64_t)at == voicelab->last_face_at_ms) return;
  voicelab->last_face_at_ms = (uint64_t)at;
  ++voicelab->face_updates;
  if (voicelab->options.on_face != NULL) {
    voicelab->options.on_face(
        voicelab->options.downlink_context,
        (uint32_t)answer,
        (uint32_t)playout_samples,
        (uint8_t)viseme,
        confidence < 0 ? 0U : (uint8_t)(confidence > 255 ? 255 : confidence));
  }
}

enum capnweb_status iterate_kit_voicelab_poll_face(
    struct iterate_kit_voicelab *voicelab) {
  static const char args[] = "[{\"name\":\"voice-agent\"}]";
  enum capnweb_status status;
  if (voicelab == NULL) return CAPNWEB_E_INVALID_ARGUMENT;
  if (voicelab->state != ITERATE_KIT_VOICELAB_READY ||
      !voicelab->has_stream_capability || voicelab->face_poll_pending) {
    return CAPNWEB_E_STATE;
  }
  status = capnweb_session_call_path(
      voicelab->options.session,
      voicelab->stream_capability,
      runtime_state_path,
      sizeof(runtime_state_path) / sizeof(runtime_state_path[0]),
      args,
      sizeof(args) - 1U,
      face_poll_completed,
      voicelab);
  if (status == CAPNWEB_OK) {
    voicelab->face_poll_pending = true;
    ++voicelab->face_polls;
  }
  return status;
}

static bool json_literal_contents_are_safe(const char *value) {
  const unsigned char *cursor = (const unsigned char *)value;
  if (value == NULL) {
    return true;
  }
  while (*cursor != '\0') {
    if (*cursor < 0x20U || *cursor == '"' || *cursor == '\\') {
      return false;
    }
    ++cursor;
  }
  return true;
}

/*
 * THE PRESS OPENS THE CALL, so this asks for one WITHOUT naming it.
 *
 * This used to append `conversation-requested` carrying a device-minted
 * conversationId, a greeting, a turn mode and a colleague flag — a device
 * telling the server what kind of call to have. The server holds the state
 * that decides all of that, and two sides holding one fact is how a stream
 * wedges: the device asked for a call the server already had, nine times, and
 * every request went unanswered in silence.
 *
 * `ptt-start` is the whole request now. A device with no call gets one; a
 * device already on a call gets a fresh utterance. The client path still
 * rides along so the conversation can subscribe to this board's presence.
 */
enum capnweb_status iterate_kit_voicelab_start_call(
    struct iterate_kit_voicelab *voicelab, const char *greeting) {
  int length;
  enum capnweb_status status;
  if (voicelab == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (voicelab->state != ITERATE_KIT_VOICELAB_READY ||
      voicelab->call_pending || !voicelab->has_stream_capability) {
    return CAPNWEB_E_STATE;
  }
  /* Greetings are the server's to decide; accepted for source compatibility
   * with the four device loops and deliberately not sent. */
  (void)greeting;
  length = snprintf(
      voicelab->args_buffer,
      sizeof(voicelab->args_buffer),
      /* DURABLE, deliberately: the opening press must survive the Durable
       * Object reset that first touch of an idle stream provokes, so the
       * rebuilt facet's catch-up can mint the call the reset swallowed. */
      "[{\"type\":\"events.iterate.com/voice-agent/ptt-start\","
      "\"payload\":{\"t\":%" PRIu64 "%s%s%s}}]",
      voicelab->options.now_ms(voicelab->options.clock_context),
      voicelab->options.client_path != NULL ? ",\"client\":\"" : "",
      voicelab->options.client_path != NULL ? voicelab->options.client_path : "",
      voicelab->options.client_path != NULL ? "\"" : "");
  if (length < 0 || (size_t)length >= sizeof(voicelab->args_buffer)) {
    return CAPNWEB_E_LIMIT;
  }
  status = capnweb_session_call_path(
      voicelab->options.session,
      voicelab->stream_capability,
      append_path,
      sizeof(append_path) / sizeof(append_path[0]),
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
  /* Forgotten along with the call it belonged to — see the note where
   * conversation-accepted resets it. */
  voicelab->spk_seq_last = -1;
}

enum capnweb_status iterate_kit_voicelab_note_button(
    struct iterate_kit_voicelab *voicelab, const char *control) {
  int length;
  if (voicelab == NULL) return CAPNWEB_E_INVALID_ARGUMENT;
  if (voicelab->state != ITERATE_KIT_VOICELAB_READY) return CAPNWEB_E_STATE;
  if (!json_literal_contents_are_safe(control)) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  /* DURABLE, deliberately: the audit's whole point is that somebody can
   * read it later, and a server that wants to react subscribes to it. */
  length = snprintf(
      voicelab->args_buffer,
      sizeof(voicelab->args_buffer),
      "[{\"type\":\"events.iterate.com/voice-agent/button-pressed\",\"payload\":{"
      "\"control\":\"%s\"}}]",
      control != NULL ? control : "press");
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

enum capnweb_status iterate_kit_voicelab_end_call(
    struct iterate_kit_voicelab *voicelab, const char *reason) {
  int length;
  if (voicelab == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (voicelab->state != ITERATE_KIT_VOICELAB_READY) {
    return CAPNWEB_E_STATE;
  }
  if (!json_literal_contents_are_safe(reason)) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  length = snprintf(
      voicelab->args_buffer,
      sizeof(voicelab->args_buffer),
      "[{\"type\":\"events.iterate.com/voice-agent/conversation-ended\",\"payload\":{"
      "\"conversationId\":\"%s\",\"reason\":\"%s\"}}]",
      /* The conversation actually being ended, not the compiled-in default:
       * an end named "scdev" is unattributable in the stream record. */
      voicelab->live_conversation_id[0] != '\0'
          ? voicelab->live_conversation_id
          : voicelab->options.conversation_id,
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
  }
  length = snprintf(
      voicelab->args_buffer,
      sizeof(voicelab->args_buffer),
      /*
       * THE PRESS IS THE VERB. A start/commit pair inside one `turn` event
       * asked the reader to decode an action before it knew what happened;
       * two named events say it outright, and `ptt-start` is also what opens
       * a call — so a device that has never called before needs no separate
       * request, and one already on a call needs no special case.
       */
      /* ptt-start durable (it can open a call and must outlive a DO reset);
       * ptt-end stays ephemeral (losing it costs a turn, not a call). */
      "[{\"type\":\"events.iterate.com/voice-agent/%s\"%s,"
      "\"payload\":{\"t\":%" PRIu64 "}}]",
      turn == ITERATE_KIT_VOICELAB_TURN_START ? "ptt-start" : "ptt-end",
      turn == ITERATE_KIT_VOICELAB_TURN_START ? "" : ",\"ephemeral\":true",
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
