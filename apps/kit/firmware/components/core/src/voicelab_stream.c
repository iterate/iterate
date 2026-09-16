// Copyright (c) 2026 Iterate
// Licensed under the MIT license found in the repository root.

#include "iterate/kit/voicelab_stream.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

/*
 * NAMED ONE BY ONE, BECAUSE "*" NEVER SWEEPS AN EPHEMERAL. `spk-frame` is
 * ephemeral and os-next's `consumesEvent` is explicit that a wildcard does not
 * reach one, so the type that carries every syllable of every answer is the
 * one a shorthand would silently drop.
 */
static const char *const consumed_event_types[] = {
  "events.iterate.com/voice-agent/spk-frame",
  "events.iterate.com/voice-agent/conversation-ended",
  "events.iterate.com/voice-agent/conversation-accepted",
  "events.iterate.com/voice-agent/call-started",
};


static bool nonempty(const char *value) {
  return value != NULL && value[0] != '\0';
}

static bool valid_activation(const char *value) {
  size_t length = 0U;
  if (!nonempty(value)) return false;
  while (value[length] != '\0') {
    const char c = value[length];
    if (length >= 64U ||
        !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') ||
          (c >= 'A' && c <= 'Z') || c == '-' || c == '_')) {
      return false;
    }
    ++length;
  }
  return true;
}

static bool valid_stream_options(
    const struct iterate_kit_voicelab_options *options) {
  return options != NULL && nonempty(options->stream_path) &&
      valid_activation(options->activation) &&
      options->now_ms != NULL;
}

static bool payload_matches_activation(
    const struct iterate_kit_voicelab *voicelab,
    const struct capnweb_value *payload) {
  struct capnweb_value value;
  char activation[65];
  size_t length = 0U;
  return valid_activation(voicelab->options.activation) &&
      capnweb_value_object_get(payload, "activation", &value) &&
      capnweb_value_copy_string(
          &value, activation, sizeof(activation), &length) == CAPNWEB_OK &&
      strcmp(activation, voicelab->options.activation) == 0;
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


/* --- base64 (RFC 4648; the uplink pads, see append_frames) -------------- */

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
  /*
   * The second agent's name for the same edge. It says what the frame MEANS —
   * this is the last frame of the answer — rather than `last`, which needed
   * the reader to already know what it was the last of.
   */
  if (!last && capnweb_value_object_get(payload, "lastFrameOfAnswer", &flag)) {
    (void)capnweb_value_get_boolean(&flag, &last);
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
   * only marker that completes the answer. Treating it as a decode
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
   * violation to be counted and dropped, which every chunk had, because audio
   * deltas are of no particular length: 118 dropped chunks in three turns.
   * Buying it back needed the sender to carry a remainder between deltas and pad
   * an answer's tail with silence. The click that the rule was supposed to
   * prevent cannot happen — a ring has no phase, and consecutive PCM16 samples
   * written consecutively are the same waveform however they were cut.
   */
  /* The lane owes more frames until `last`; an empty clear frame owes none. */
  voicelab->answer_open = !last && chunk_length > 0U;
  if (chunk_length > 0U && voicelab->options.on_speaker != NULL) {
    ++voicelab->spk_frames_received;
    voicelab->options.on_speaker(
        voicelab->options.downlink_context, voicelab->chunk_buffer, chunk_length);
  }

  /*
   * AND THE END OF THE ANSWER RIDES ITS LAST CHUNK, announced AFTER the audio
   * is handed over so the buffer the owner is about to call drained already
   * holds everything it will ever hold. This was once a separate
   * terminal event on a separate lane, where it routinely
   * arrived FIRST and cost 258 received frames that were never played.
   */
  if (last && voicelab->options.on_control != NULL) {
    voicelab->options.on_control(
        voicelab->options.downlink_context,
        ITERATE_KIT_VOICELAB_CONTROL_RESPONSE_DONE);
  }
}

/*
 * WHAT THE SERVER BELIEVES IT HAS SENT, CHECKED AGAINST WHAT WE HAVE SEEN.
 *
 * `range` is `{after, through}`. Delivery to a live client is fire-and-forget
 * on os-next — nothing is awaited, nothing is retried, and a push past the
 * in-flight budget is simply dropped — so a gap has no other symptom. It cannot
 * be HEALED here either: `readEvents` never returns an ephemeral, and every
 * syllable of an answer is one. Counting it is the whole remedy, and it is
 * still worth more than the silence it replaces.
 */
static void observe_delivery_range(
    struct iterate_kit_voicelab *voicelab,
    const struct capnweb_value *range) {
  struct capnweb_value field;
  int64_t after = -1;
  int64_t through = -1;
  if (range == NULL ||
      !capnweb_value_object_get(range, "after", &field) ||
      !capnweb_value_get_int64(&field, &after) ||
      !capnweb_value_object_get(range, "through", &field) ||
      !capnweb_value_get_int64(&field, &through)) {
    return;
  }
  if (voicelab->last_delivery_through >= 0 &&
      after != voicelab->last_delivery_through &&
      voicelab->delivery_gaps < UINT32_MAX) {
    ++voicelab->delivery_gaps;
  }
  voicelab->last_delivery_through = through;
}

static void process_batch(
    struct iterate_kit_voicelab *voicelab,
    const struct capnweb_value *delivered_events,
    const struct capnweb_value *range,
    bool counts_for_current_subscription) {
  struct capnweb_value events;
  size_t event_count;
  size_t index;
  if (voicelab == NULL || delivered_events == NULL) return;
  /*
   * Stamped for the BATCH, before its contents are inspected and regardless
   * of what it holds: this is the proof that the delivery lane still exists,
   * which is a different question from whether anything interesting was on
   * it. An empty batch proves the lane; a dropped duplicate proves it too.
   */
  if (counts_for_current_subscription) {
    ++voicelab->batches_on_connection;
    voicelab->last_batch_ms =
        voicelab->options.now_ms(voicelab->options.clock_context);
    observe_delivery_range(voicelab, range);
  }
  /*
   * ARGUMENT 0 IS THE ARRAY ITSELF. `openConnection` delivered `{events: [...]}`
   * as one object; os-next calls the lent stub as a bare function whose first
   * argument IS the events array. Application arrays still ride the wire
   * escaped as [[item, ...]], which is what this unwraps.
   */
  if (!capnweb_value_get_expression_array(delivered_events, &events)) {
    return;
  }
  event_count = capnweb_value_array_size(&events);
  for (index = 0U; index < event_count; ++index) {
    struct capnweb_value event;
    struct capnweb_value offset_value;
    struct capnweb_value type_value;
    struct capnweb_value payload;
    int64_t offset = -1;
    /* A terminal's owner can synchronously fence this call while handling
     * the preceding event. Nothing later in the same delivery belongs to it. */
    if (voicelab->state != ITERATE_KIT_VOICELAB_OPENING_CONNECTION &&
        voicelab->state != ITERATE_KIT_VOICELAB_READY) break;
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
    if ((capnweb_value_string_equals(
             &type_value, "events.iterate.com/voice-agent/call-started") ||
         capnweb_value_string_equals(
             &type_value, "events.iterate.com/voice-agent/conversation-accepted") ||
         capnweb_value_string_equals(
             &type_value, "events.iterate.com/voice-agent/conversation-ended") ||
         capnweb_value_string_equals(
             &type_value, "events.iterate.com/voice-agent/spk-frame")) &&
        !payload_matches_activation(voicelab, &payload)) {
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
      voicelab->call_active = true;
      voicelab->answer_open = false;
      if (voicelab->options.on_control != NULL) {
        voicelab->options.on_control(
            voicelab->options.downlink_context,
            ITERATE_KIT_VOICELAB_CONTROL_CALL_ACCEPTED);
      }
    } else if (capnweb_value_string_equals(
                   &type_value,
                   "events.iterate.com/voice-agent/conversation-ended")) {
      voicelab->call_active = false;
      voicelab->answer_open = false;
      voicelab->last_presence_at_ms = 0U;
      if (voicelab->options.on_control != NULL) {
        voicelab->options.on_control(
            voicelab->options.downlink_context,
            ITERATE_KIT_VOICELAB_CONTROL_CALL_ENDED);
      }
    }
  }
}


void iterate_kit_voicelab_on_subscription_update(
    void *owner,
    uint32_t owner_epoch,
    const struct capnweb_value *events,
    const struct capnweb_value *range) {
  struct iterate_kit_voicelab *const voicelab = owner;
  const bool current = voicelab != NULL && voicelab->subscription != NULL &&
      owner_epoch == voicelab->subscription->owner_epoch;
  const bool previous = voicelab != NULL &&
      voicelab->previous_subscription != NULL &&
      owner_epoch == voicelab->previous_subscription->owner_epoch;
  if (voicelab == NULL || (!current && !previous) ||
      (voicelab->state != ITERATE_KIT_VOICELAB_OPENING_CONNECTION &&
       voicelab->state != ITERATE_KIT_VOICELAB_READY)) return;
  process_batch(voicelab, events, range, current);
}


enum capnweb_status iterate_kit_voicelab_bind(
    struct iterate_kit_voicelab *voicelab,
    const struct iterate_kit_voicelab_options *options,
    struct iterate_kit_stream *stream,
    struct iterate_kit_stream_subscription *subscription) {
  char key[96];
  int key_length;
  enum capnweb_status status;
  uint32_t next_epoch;
  if (voicelab == NULL || voicelab->face_poll_pending ||
      (voicelab->state != ITERATE_KIT_VOICELAB_IDLE &&
       voicelab->state != ITERATE_KIT_VOICELAB_CLOSED) ||
      !valid_stream_options(options) || stream == NULL || subscription == NULL ||
      stream->state != ITERATE_KIT_STREAM_READY || !stream->has_capability ||
      !iterate_kit_stream_subscription_reclaimable(subscription)) return CAPNWEB_E_STATE;
  next_epoch = voicelab->connection_generation + 1U;
  if (next_epoch == 0U) return CAPNWEB_E_LIMIT;
  memset(voicelab, 0, sizeof(*voicelab));
  voicelab->connection_generation = next_epoch;
  voicelab->options = *options;
  voicelab->stream = stream;
  voicelab->subscription = subscription;
  voicelab->state = ITERATE_KIT_VOICELAB_OPENING_CONNECTION;
  voicelab->last_event_offset = -1;
  voicelab->last_delivery_through = -1;
  voicelab->subscription_epoch = voicelab->connection_generation;
  key_length = snprintf(key, sizeof(key), "kit-voice-%s-%" PRIu32,
      options->activation, voicelab->subscription_epoch);
  if (key_length < 0 || (size_t)key_length >= sizeof(key)) {
    return fail(voicelab, ITERATE_KIT_VOICELAB_FAILURE_OPEN_CALL, CAPNWEB_E_LIMIT);
  }
  status = iterate_kit_stream_subscription_open(subscription, stream, key,
      consumed_event_types,
      sizeof(consumed_event_types) / sizeof(consumed_event_types[0]),
      iterate_kit_voicelab_on_subscription_update, voicelab,
      voicelab->connection_generation);
  if (status != CAPNWEB_OK) {
    return fail(voicelab, ITERATE_KIT_VOICELAB_FAILURE_OPEN_CALL, status);
  }
  return CAPNWEB_OK;
}

void iterate_kit_voicelab_update(struct iterate_kit_voicelab *voicelab) {
  if (voicelab == NULL || voicelab->subscription == NULL ||
      voicelab->state == ITERATE_KIT_VOICELAB_CLOSED ||
      voicelab->state == ITERATE_KIT_VOICELAB_FAILED) return;
  if (voicelab->subscription->state == ITERATE_KIT_SUBSCRIPTION_OPEN) {
    if (voicelab->previous_subscription != NULL) {
      const enum capnweb_status status = iterate_kit_stream_subscription_close(
          voicelab->previous_subscription);
      if (status != CAPNWEB_OK) {
        (void)fail(voicelab, ITERATE_KIT_VOICELAB_FAILURE_RELEASE, status);
        return;
      }
      voicelab->previous_subscription = NULL;
    }
    voicelab->state = ITERATE_KIT_VOICELAB_READY;
  } else if (voicelab->subscription->state == ITERATE_KIT_SUBSCRIPTION_FAILED ||
      voicelab->subscription->state == ITERATE_KIT_SUBSCRIPTION_CLOSED) {
    (void)fail(voicelab, ITERATE_KIT_VOICELAB_FAILURE_OPEN_RESULT,
        voicelab->subscription->status);
  }
}


enum capnweb_status iterate_kit_voicelab_recycle_subscription(
    struct iterate_kit_voicelab *voicelab,
    struct iterate_kit_stream_subscription *fresh_subscription) {
  char key[96];
  int key_length;
  enum capnweb_status status;
  if (voicelab == NULL || voicelab->stream == NULL ||
      voicelab->state != ITERATE_KIT_VOICELAB_READY ||
      fresh_subscription == NULL ||
      !iterate_kit_stream_subscription_reclaimable(fresh_subscription)) {
    return CAPNWEB_E_STATE;
  }
  if (voicelab->connection_generation == UINT32_MAX) return CAPNWEB_E_LIMIT;
  ++voicelab->connection_generation;
  key_length = snprintf(key, sizeof(key), "kit-voice-%s-%" PRIu32,
      voicelab->options.activation, voicelab->connection_generation);
  if (key_length < 0 || (size_t)key_length >= sizeof(key)) return CAPNWEB_E_LIMIT;
  voicelab->previous_subscription = voicelab->subscription;
  voicelab->subscription = fresh_subscription;
  voicelab->state = ITERATE_KIT_VOICELAB_OPENING_CONNECTION;
  voicelab->batches_on_connection = 0U;
  /* A fresh subscription starts a fresh range; the predecessor's `through`
   * belongs to a different delivery lane and comparing across them would
   * manufacture a gap on every recycle. */
  voicelab->last_delivery_through = -1;
  voicelab->last_batch_ms =
      voicelab->options.now_ms(voicelab->options.clock_context);
  status = iterate_kit_stream_subscription_open(fresh_subscription, voicelab->stream,
      key, consumed_event_types,
      sizeof(consumed_event_types) / sizeof(consumed_event_types[0]),
      iterate_kit_voicelab_on_subscription_update, voicelab,
      voicelab->connection_generation);
  if (status != CAPNWEB_OK) {
    (void)iterate_kit_stream_subscription_close(fresh_subscription);
    voicelab->subscription = voicelab->previous_subscription;
    voicelab->previous_subscription = NULL;
    voicelab->state = ITERATE_KIT_VOICELAB_READY;
  }
  return status;
}


/* --- appends -------------------------------------------------------------- */

enum capnweb_status iterate_kit_voicelab_append_frames(
    struct iterate_kit_voicelab *voicelab,
    const uint8_t *pcm,
    size_t frame_count,
    size_t frame_length,
    const char *activation) {
  int written;
  size_t offset;
  size_t encoded_length;
  enum capnweb_status status;
  if (voicelab == NULL ||
      pcm == NULL ||
      !valid_activation(activation) ||
      frame_count == 0U ||
      frame_count > ITERATE_KIT_VOICELAB_MAX_FRAMES_PER_APPEND ||
      frame_length == 0U ||
      frame_length > ITERATE_KIT_VOICELAB_FRAME_BYTES) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (voicelab->state != ITERATE_KIT_VOICELAB_READY) {
    return CAPNWEB_E_STATE;
  }
  offset = 0U;
  voicelab->args_buffer[offset++] = '[';
  /*
   * ONE EVENT FOR THE WHOLE FLUSH. The frames of a flush are one continuous
   * run of capture, so they go out as one `pcm` body: the facet forwards it
   * to GPT-Live verbatim, and every event costs the stream's single
   * thread a fold and a fan-out — eight of them per append was eight times
   * the work for the same audio. `seq` is the first frame's; the count is
   * implied by the byte length.
   */
  written = snprintf(
      voicelab->args_buffer + offset,
      sizeof(voicelab->args_buffer) - offset,
      /*
       * NO conversationId. The client does not know which call it is on and
       * does not need to: frames belong to whatever call its own press
       * opened. Naming one here made the device a second source of truth for
       * a fact only the server holds.
       */
      "{\"type\":\"events.iterate.com/voice-agent/mic-frame\",\"ephemeral\":true,"
      "\"payload\":{\"activation\":\"%s\",\"pcm\":\"",
      activation);
  if (written < 0 ||
      (size_t)written >= sizeof(voicelab->args_buffer) - offset) {
    ++voicelab->frame_send_failures;
    return CAPNWEB_E_LIMIT;
  }
  offset += (size_t)written;
  /*
   * ONE ENCODE OVER THE WHOLE FLUSH. 640 is not a multiple of 3, so encoding
   * frame by frame would leave a broken base64 group at every seam — but the
   * frames of a flush are one continuous run of capture and the caller hands
   * them over contiguous, so there are no seams to straddle.
   */
  {
    const size_t body_capacity =
        sizeof(voicelab->args_buffer) - sizeof("\"}}]") - 4U;
    size_t padding;
    encoded_length = base64_encode(
        pcm,
        frame_count * frame_length,
        voicelab->args_buffer + offset,
        body_capacity > offset ? body_capacity - offset : 0U);
    if (encoded_length == 0U) {
      /* The args buffer could not hold this flush — count it, or the
       * microphone goes quiet with every counter reading zero. */
      ++voicelab->frame_send_failures;
      return CAPNWEB_E_LIMIT;
    }
    offset += encoded_length;
    /* PADDED: GPT-Live's decoder rejects unpadded base64 ("illegal base64
     * data at input byte 852" — a Mac talk run heard nothing back until the
     * facet learned to pad). */
    padding = (4U - (encoded_length % 4U)) % 4U;
    if (offset + padding > body_capacity) {
      ++voicelab->frame_send_failures;
      return CAPNWEB_E_LIMIT;
    }
    while (padding-- > 0U) voicelab->args_buffer[offset++] = '=';
  }
  if (offset + 4U >= sizeof(voicelab->args_buffer)) {
    ++voicelab->frame_send_failures;
    return CAPNWEB_E_LIMIT;
  }
  memcpy(voicelab->args_buffer + offset, "\"}}", 3U);
  offset += 3U;
  voicelab->args_buffer[offset++] = ']';

  status = iterate_kit_stream_append(
      voicelab->stream, voicelab->args_buffer, offset);
  if (status == CAPNWEB_OK) {
    voicelab->frames_sent += (uint32_t)frame_count;
    voicelab->last_presence_at_ms =
        voicelab->options.now_ms(voicelab->options.clock_context);
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
  return iterate_kit_stream_append(
      voicelab->stream, events_json_array, length);
}


/* --- the face, pulled out of the processor's own runtime bag ------------- */

/*
 * A PLAIN METHOD NAME ON THE CONVERSATION'S CONTEXT, exactly like
 * `setupVoiceAgent` on the project root. os-next has no `getProcessorRuntimeState`
 * built-in; anything that is not a built-in resolves through the context's
 * rewrite rules, so the voice worker owns this name the same way it owns setup.
 * The device keeps the call and the reply shape and expresses no opinion about
 * which worker answers.
 *
 * It is armed only on a board with a mouth (`observe_answer`), so a deployment
 * whose worker has not claimed the name yet costs the HAVPE nothing.
 */
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
  const struct iterate_kit_voicelab_face_request *const request = context;
  struct iterate_kit_voicelab *const voicelab = request != NULL ? request->voicelab : NULL;
  struct capnweb_value runtime_bag = {0};
  struct capnweb_value face = {0};
  struct capnweb_value field = {0};
  int64_t answer = 0;
  int64_t playout_samples = 0;
  int64_t viseme = 0;
  int64_t confidence = 0;
  int64_t at = 0;

  if (voicelab == NULL || !voicelab->face_poll_pending ||
      request->subscription_epoch != voicelab->subscription_epoch) return;
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
      voicelab->stream == NULL || !voicelab->stream->has_capability ||
      voicelab->face_poll_pending) {
    return CAPNWEB_E_STATE;
  }
  status = capnweb_session_call_path(
      voicelab->stream->session,
      voicelab->stream->capability,
      runtime_state_path,
      sizeof(runtime_state_path) / sizeof(runtime_state_path[0]),
      args,
      sizeof(args) - 1U,
      face_poll_completed,
      &voicelab->face_request);
  if (status == CAPNWEB_OK) {
    voicelab->face_request.voicelab = voicelab;
    voicelab->face_request.subscription_epoch = voicelab->subscription_epoch;
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

static enum capnweb_status iterate_kit_voicelab_send_keepalive(
    struct iterate_kit_voicelab *voicelab) {
  static const char args[] =
      "[{\"type\":\"events.iterate.com/voice-agent/keepalive\",\"ephemeral\":true,"
      "\"payload\":{}}]";
  const enum capnweb_status status = iterate_kit_stream_append(
      voicelab->stream, args, sizeof(args) - 1U);
  if (status == CAPNWEB_OK) {
    voicelab->last_presence_at_ms =
        voicelab->options.now_ms(voicelab->options.clock_context);
  }
  return status;
}

bool iterate_kit_voicelab_downlink_expected(
    const struct iterate_kit_voicelab *voicelab) {
  return voicelab != NULL && (!voicelab->call_active || voicelab->answer_open);
}

enum capnweb_status iterate_kit_voicelab_keepalive_if_due(
    struct iterate_kit_voicelab *voicelab) {
  uint64_t now;
  if (voicelab == NULL) return CAPNWEB_E_INVALID_ARGUMENT;
  if (voicelab->state != ITERATE_KIT_VOICELAB_READY ||
      !voicelab->call_active) return CAPNWEB_E_STATE;
  now = voicelab->options.now_ms(voicelab->options.clock_context);
  if (voicelab->last_presence_at_ms != 0U &&
      now - voicelab->last_presence_at_ms <
          ITERATE_KIT_VOICE_CALL_KEEPALIVE_MS) {
    return CAPNWEB_OK;
  }
  return iterate_kit_voicelab_send_keepalive(voicelab);
}

enum capnweb_status iterate_kit_voicelab_end_activation(
    const struct iterate_kit_stream *stream,
    const char *activation,
    const char *reason) {
  char arguments[256];
  int length;
  if (stream == NULL || !valid_activation(activation) ||
      !json_literal_contents_are_safe(reason)) return CAPNWEB_E_INVALID_ARGUMENT;
  length = snprintf(arguments, sizeof(arguments),
      "[{\"type\":\"events.iterate.com/voice-agent/conversation-ended\",\"payload\":{"
      "\"activation\":\"%s\",\"reason\":\"%s\"}}]",
      activation, reason != NULL ? reason : "hangup");
  if (length < 0 || (size_t)length >= sizeof(arguments)) return CAPNWEB_E_LIMIT;
  return iterate_kit_stream_append(stream, arguments, (size_t)length);
}

enum capnweb_status iterate_kit_voicelab_end_call(
    struct iterate_kit_voicelab *voicelab, const char *reason) {
  enum capnweb_status status;
  if (voicelab == NULL) return CAPNWEB_E_INVALID_ARGUMENT;
  status = iterate_kit_voicelab_end_activation(
      voicelab->stream, voicelab->options.activation, reason);
  if (status != CAPNWEB_OK) return status;
  voicelab->call_active = false;
  voicelab->answer_open = false;
  voicelab->last_presence_at_ms = 0U;
  return CAPNWEB_OK;
}


enum capnweb_status iterate_kit_voicelab_close(
    struct iterate_kit_voicelab *voicelab) {
  enum capnweb_status status = CAPNWEB_OK;
  enum capnweb_status previous_status;
  if (voicelab == NULL) return CAPNWEB_E_INVALID_ARGUMENT;
  if (voicelab->subscription != NULL) {
    status = iterate_kit_stream_subscription_close(voicelab->subscription);
    if (status == CAPNWEB_OK) voicelab->subscription = NULL;
  }
  if (voicelab->previous_subscription != NULL) {
    previous_status = iterate_kit_stream_subscription_close(
        voicelab->previous_subscription);
    if (previous_status == CAPNWEB_OK) voicelab->previous_subscription = NULL;
    if (status == CAPNWEB_OK) status = previous_status;
  }
  voicelab->state = ITERATE_KIT_VOICELAB_CLOSED;
  voicelab->call_active = false;
  voicelab->answer_open = false;
  return status;
}

const char *iterate_kit_voicelab_state_name(
    enum iterate_kit_voicelab_state state) {
  switch (state) {
    case ITERATE_KIT_VOICELAB_IDLE: return "idle";
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
    case ITERATE_KIT_VOICELAB_FAILURE_OPEN_CALL: return "open-call";
    case ITERATE_KIT_VOICELAB_FAILURE_OPEN_REJECTED: return "open-rejected";
    case ITERATE_KIT_VOICELAB_FAILURE_OPEN_RESULT: return "open-result";
    case ITERATE_KIT_VOICELAB_FAILURE_RELEASE: return "release";
    case ITERATE_KIT_VOICELAB_FAILURE_SESSION_ENDED:
      return "session-ended";
    default: return "unknown";
  }
}
