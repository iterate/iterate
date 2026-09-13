/*
 * voicelab_stream: single-WebSocket device end of the voicelab protocol —
 * caller-owned streams.get -> bind -> openConnection, then one-way mic-frame
 * appends (base64 PCM16, ephemeral).
 */
#include "iterate/kit/voicelab_stream.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum {
  /* Matches the device: a delivery batch is a nested pipeline expression and
   * needs more than a trivial budget. */
  TOKEN_CAPACITY = 256,
  CALL_CAPACITY = 8,
  OUTPUT_CAPACITY = 64,
  CAPTURE_CAPACITY = 128,
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

#define TEST_ACTIVATION "0123456789abcdef0123456789abcdef"

struct fixture {
  struct capnweb_session session;
  struct capnweb_pending_call pending_calls[CALL_CAPACITY];
  struct capnweb_export exports[CALL_CAPACITY];
  struct capnweb_import imports[CALL_CAPACITY];
  struct capnweb_json_token tokens[TOKEN_CAPACITY];
  char output_buffer[OUTPUT_CAPACITY];
  char captured[CAPTURE_CAPACITY][MESSAGE_CAPACITY];
  size_t captured_lengths[CAPTURE_CAPACITY];
  size_t captured_count;
  bool message_open;
  uint64_t clock_ms;
  struct iterate_kit_voicelab voicelab;
  struct iterate_kit_stream stream;
  struct iterate_kit_stream_subscription subscription;
  struct iterate_kit_stream_subscription replacement_subscription;
};

struct observed_face {
  uint32_t answer;
  uint32_t offset_samples;
  uint8_t viseme;
  uint8_t confidence;
  size_t count;
};

static struct observed_face observed_face;
static void record_speaker(void *context, const uint8_t *pcm, size_t pcm_length);
static void record_control(void *context, enum iterate_kit_voicelab_control control);


static void record_face(
    void *context,
    uint32_t answer,
    uint32_t offset_samples,
    uint8_t viseme,
    uint8_t confidence) {
  (void)context;
  observed_face.answer = answer;
  observed_face.offset_samples = offset_samples;
  observed_face.viseme = viseme;
  observed_face.confidence = confidence;
  ++observed_face.count;
}

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
    if (!fixture->message_open || data == NULL || length == 0U) {
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
    ++fixture->captured_count;
    fixture->message_open = false;
    return CAPNWEB_OK;
  }
  return CAPNWEB_E_INVALID_ARGUMENT;
}

static enum capnweb_status inert_dispatch(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  (void)context;
  (void)call;
  return capnweb_reply_set_null(reply);
}

static uint64_t fixture_now_ms(void *context) {
  struct fixture *fixture = context;
  return fixture->clock_ms;
}

static void fixture_init(struct fixture *fixture) {
  struct capnweb_session_options options;
  memset(fixture, 0, sizeof(*fixture));
  options = (struct capnweb_session_options){
    {inert_dispatch, fixture, NULL},
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
  assert(capnweb_session_init(&fixture->session, &options) == CAPNWEB_OK);
}

static void receive(struct fixture *fixture, const char *message) {
  const enum capnweb_status status =
      capnweb_session_receive(&fixture->session, message, strlen(message));
  if (status != CAPNWEB_OK) {
    fprintf(stderr, "receive failed status=%d for %s\n", (int)status, message);
  }
  assert(status == CAPNWEB_OK);
}

static void start_and_mount(struct fixture *fixture) {
  const struct iterate_kit_voicelab_options options = {
    .stream_path = "/voice-agent/dev-test",
    .activation = TEST_ACTIVATION,
    .now_ms = fixture_now_ms,
    .clock_context = fixture,
    .on_face = record_face,
    .on_speaker = record_speaker,
    .on_control = record_control,
  };
  assert(iterate_kit_stream_get(&fixture->stream, &fixture->session,
      (struct capnweb_remote_capability){-77}, options.stream_path) == CAPNWEB_OK);
  receive(fixture, "[\"resolve\",1,[\"export\",-12]]");
  assert(fixture->stream.state == ITERATE_KIT_STREAM_READY);
  assert(iterate_kit_voicelab_bind(&fixture->voicelab, &options,
      &fixture->stream, &fixture->subscription) == CAPNWEB_OK);
  receive(fixture, "[\"resolve\",2,[\"export\",-13]]");
  iterate_kit_voicelab_update(&fixture->voicelab);
  assert(fixture->voicelab.state == ITERATE_KIT_VOICELAB_READY);
}

static uint8_t spoken[ITERATE_KIT_VOICELAB_CHUNK_BYTES];
static size_t spoken_length;
/* Audio handed over in total, which is the unit that survived alignment. */
static size_t spoken_bytes;
static int speech_started_count;
static int response_done_count;
/*
 * WHAT HAPPENED IN WHICH ORDER, not just how often.
 *
 * `drop` and `last` ride the audio they are about, and their whole advantage
 * over the two event types they replace is that they CANNOT be reordered
 * against it. A count cannot tell a barge-in that flushed BEFORE its replacing
 * frame from one that flushed after and threw that frame away, and those are
 * the working case and the bug. Same at the other end: `last` must land after
 * the final frame, or the owner marks an answer drained that still has audio
 * to play and the drain is recorded as starvation.
 */
static char order_log[64];
static size_t order_length;
static void note_order(char mark) {
  if (order_length + 1U < sizeof(order_log)) order_log[order_length++] = mark;
}

/*
 * THE SENDER SHIPS CHUNKS NOW, so a test has to build one.
 *
 * A `pcm` payload is a whole number of 320-byte mu-law wire frames — that is
 * the sender's guarantee and the only thing the module accepts, because both
 * speaker consumers reject any PCM length but 640. Four-byte fixtures were
 * fine when one event was one frame; they are now a protocol violation, which
 * is itself worth a test.
 */
static const char *pcm_b64(size_t byte_count, uint8_t fill) {
  static const char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  static char encoded[8192];
  size_t out = 0U;
  size_t at = 0U;
  assert((byte_count + 2U) / 3U * 4U < sizeof(encoded));
  for (; at + 3U <= byte_count; at += 3U) {
    const uint32_t triple =
        ((uint32_t)fill << 16) | ((uint32_t)fill << 8) | (uint32_t)fill;
    encoded[out++] = alphabet[(triple >> 18) & 0x3FU];
    encoded[out++] = alphabet[(triple >> 12) & 0x3FU];
    encoded[out++] = alphabet[(triple >> 6) & 0x3FU];
    encoded[out++] = alphabet[triple & 0x3FU];
  }
  if (at < byte_count) {
    const size_t left = byte_count - at;
    const uint32_t triple = left == 2U
        ? (((uint32_t)fill << 16) | ((uint32_t)fill << 8))
        : ((uint32_t)fill << 16);
    encoded[out++] = alphabet[(triple >> 18) & 0x3FU];
    encoded[out++] = alphabet[(triple >> 12) & 0x3FU];
    if (left == 2U) encoded[out++] = alphabet[(triple >> 6) & 0x3FU];
  }
  encoded[out] = '\0';
  return encoded;
}

/** `frames` whole wire frames of mu-law, base64. */
static const char *frames_b64(size_t frames, uint8_t fill) {
  return pcm_b64(frames * (size_t)ITERATE_KIT_VOICELAB_FRAME_BYTES, fill);
}

/** Deliver one `spk-frame` event, with whatever extra payload keys it needs. */
static void push_spk_to(
    struct fixture *fixture,
    int callback_id,
    int release_id,
    int64_t offset,
    const char *flags,
    const char *pcm_b64) {
  static char message[16384];
  (void)snprintf(
      message, sizeof(message),
      "[\"push\",[\"pipeline\",%d,[],[{\"events\":[["
      "{\"type\":\"events.iterate.com/voice-agent/spk-frame\",\"offset\":%lld,"
      "\"payload\":{\"activation\":\"" TEST_ACTIVATION "\",%s\"pcm\":\"%s\"}}"
      "]],\"scannedThroughOffset\":%lld,\"state\":null}]]]",
      callback_id, (long long)offset, flags, pcm_b64, (long long)offset);
  receive(fixture, message);
  {
    char release[64];
    (void)snprintf(release, sizeof(release), "[\"release\",%d,1]", release_id);
    receive(fixture, release);
  }
}

static void push_spk(
    struct fixture *fixture, int release_id, int64_t offset,
    const char *flags, const char *pcm_b64) {
  push_spk_to(fixture, -1, release_id, offset, flags, pcm_b64);
}

/** How many whole 640-byte frames the module handed over. */
static uint32_t spoken_frames;

/*
 * Records the LAST chunk handed over, and counts chunks and bytes.
 *
 * There is no identity to record any more. Frames used to carry an answer
 * number and a position, and the device ran a classifier over them to decide
 * for itself whether audio was still wanted; `drop` and `last` say it outright
 * now, so what a test can check is how much audio came out and what was in the
 * final chunk.
 *
 * IT ASSERTS RATHER THAN TRUNCATING. This used to copy only if the payload fit
 * and silently ignore it otherwise, which meant a chunk longer than the buffer
 * left `spoken_length` describing some earlier chunk — a fake that quietly
 * answers the previous question is worse than one that crashes.
 */
static void record_speaker(void *context, const uint8_t *pcm, size_t pcm_length) {
  (void)context;
  assert(pcm_length <= sizeof(spoken));
  memcpy(spoken, pcm, pcm_length);
  spoken_length = pcm_length;
  spoken_bytes += pcm_length;
  ++spoken_frames;
  note_order('f');
}

static void record_control(
    void *context, enum iterate_kit_voicelab_control control) {
  (void)context;
  if (control == ITERATE_KIT_VOICELAB_CONTROL_SPEECH_STARTED) {
    ++speech_started_count;
    note_order('d');
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_RESPONSE_DONE) {
    ++response_done_count;
    note_order('l');
  }
}

/*
 * Full downlink shape: the module exports a callback capability, opens the
 * live connection with the constrained-consumer caps, decodes inbound
 * spk-frames, forwards barge-in control, dedupes across an overlapping
 * recycle, and recycles make-before-break.
 */
static void downlink_flow(void) {
  static struct fixture fixture;
  fixture_init(&fixture);
  start_and_mount(&fixture);
  /* The open call rides the wire with the caps and the exported callback. */
  {
    const char *open_message = NULL;
    size_t index;
    for (index = 0U; index < fixture.captured_count; ++index) {
      if (strstr(fixture.captured[index], "openConnection") != NULL) {
        open_message = fixture.captured[index];
      }
    }
    assert(open_message != NULL);
    assert(strstr(open_message,
        "\"connectionKey\":\"kit-voice-") != NULL);
    /*
     * The subscription IS the wire contract, so it is pinned literally rather
     * than checked for membership: a type quietly added or dropped upstream
     * must fail here and not on a bench.
     *
     * THREE, down from six. `pong` went with the ping that earned it;
     * `grok-event` carried two facts that now ride `spk-frame` as `drop` and
     * `last`; `viseme` is deleted from the contract because the face is
     * reduced processor runtime state read by a direct RPC poll.
     */
    assert(
        strstr(
            open_message,
            "\"eventTypes\":[["
            "\"events.iterate.com/voice-agent/spk-frame\","
            "\"events.iterate.com/voice-agent/conversation-ended\","
            "\"events.iterate.com/voice-agent/conversation-accepted\","
            "\"events.iterate.com/voice-agent/call-started\"]]") !=
        NULL);
    assert(strstr(open_message, "\"maxDeliveryEvents\":16") != NULL);
    assert(strstr(open_message, "\"maxDeliveryBytes\":13000") != NULL);
    assert(strstr(open_message, "\"state\":false") != NULL);
    assert(strstr(open_message, "\"processEventBatch\":[\"export\",-1]") != NULL);
  }
  /* The platform invokes the exported callback exactly like the live wire:
   * a push with an EMPTY path, followed by a release of the result import
   * (the zero-return-frame lane never pulls). */
  {
    static char message[16384];
    /*
     * The acceptance leads the audio, as it does on the wire: the delivery
     * lane refuses `spk-frame`s for a call the device is not on — that
     * refusal is what keeps an ended call's in-flight tail from playing
     * after the end chime — so an answer with no accepted call in front of
     * it is silence by design, here as on the desk.
     */
    (void)snprintf(
        message, sizeof(message),
        "[\"push\",[\"pipeline\",-1,[],[{\"projectId\":\"prj_test\","
        "\"path\":\"/voice-agent/dev-test\",\"streamId\":\"sid\",\"events\":[["
        "{\"type\":\"events.iterate.com/voice-agent/conversation-accepted\","
        "\"offset\":39,\"payload\":{\"activation\":\"" TEST_ACTIVATION "\",\"conversationId\":\"wsdev\"}},"
        "{\"type\":\"events.iterate.com/voice-agent/spk-frame\",\"offset\":40,"
        "\"payload\":{\"activation\":\"" TEST_ACTIVATION "\",\"pcm\":\"%s\"}},"
        "{\"type\":\"events.iterate.com/voice-agent/spk-frame\",\"offset\":41,"
        "\"payload\":{\"activation\":\"" TEST_ACTIVATION "\",\"clearSpeakerBufferBeforeFrame\":true,\"pcm\":\"%s\"}}"
        "]],\"scannedAfterOffset\":38,\"scannedThroughOffset\":41,"
        "\"streamMaxOffset\":41,\"state\":null}]]]",
        frames_b64(1U, 0x41), frames_b64(1U, 0x45));
    receive(&fixture, message);
  }
  receive(&fixture, "[\"release\",1,1]");
  assert(fixture.voicelab.spk_frames_received == 2U);
  assert(spoken_frames == 2U);
  /* Expanded: 320 mu-law bytes became one whole 640-byte PCM frame. */
  assert(spoken_length == ITERATE_KIT_VOICELAB_FRAME_BYTES);
  assert(speech_started_count == 1);
  /*
   * THE ORDER, WHICH IS THE POINT. The flush is announced BEFORE the frame
   * that replaces what it flushed — 'f' then 'd' then 'f' — so the owner has
   * emptied its queue by the time the new answer's first frame is classified
   * into it. The old `grok-event` lane could deliver these either way round.
   */
  assert(order_length == 3U);
  assert(memcmp(order_log, "fdf", 3U) == 0);
  assert(fixture.voicelab.last_event_offset == 41);

  /*
   * THE END OF AN ANSWER, ON ITS LAST FRAME.
   *
   * This used to be a `response.done` on the `grok-event` lane — one small text
   * event against hundreds of large audio events, so it routinely overtook them
   * and a device that treated it as "the answer is over" received 258 frames
   * and played none. `last` cannot overtake anything: it IS the final frame,
   * and it carries the padded remainder that used to be dropped.
   *
   * The edge is announced AFTER that frame is delivered — 'f' then 'l' — so the
   * buffer the owner is about to call drained already holds everything it will
   * ever hold. Announced first, the owner marks an answer drained with audio
   * still queued and the normal end of every answer is recorded as starvation.
   */
  order_length = 0U;
  push_spk(&fixture, 2, 43, "\"lastFrameOfAnswer\":true,", frames_b64(1U, 0x49));
  assert(response_done_count == 1);
  assert(spoken_length == ITERATE_KIT_VOICELAB_FRAME_BYTES);
  assert(order_length == 2U);
  assert(memcmp(order_log, "fl", 2U) == 0);

  /*
   * A CLOSING FRAME WITH NO AUDIO STILL ENDS THE ANSWER.
   *
   * The sender's last frame carries the answer's leftover remainder, and when
   * the audio divided evenly by 640 there is no remainder — `pcm` is empty.
   * That is the ordinary case roughly half the time.
   *
   * The decode used to treat zero samples as a failure and return BEFORE
   * reading `last`, so the end of the answer was never announced: the owner
   * never drained the finished answer, and the next
   * answer played into a queue still holding the previous one. Heard on a HA
   * Voice PE as speech that speeds up and then stops, two or three turns into
   * a conversation — the turn it bites depends on whether that answer's deltas
   * happened to land on a frame boundary, which is why it looked intermittent.
   */
  order_length = 0U;
  response_done_count = 0;
  push_spk(&fixture, 3, 44, "\"lastFrameOfAnswer\":true,", "");
  assert(response_done_count == 1);
  /* And it is not counted as a broken chunk. */
  assert(fixture.voicelab.spk_decode_failures == 0U);
  /* It carried no audio, so nothing was handed to the speaker. */
  assert(spoken_frames == 3U);

  /*
   * ONE EVENT, ONE HAND-OVER — the point of the whole change.
   *
   * The sender holds the answer and releases it in chunks, so a single event
   * routinely carries several frames' worth of audio where it used to carry
   * one. Fifty events a second was never something this transport could
   * sustain: it runs a few dozen messages a second in total, and each one
   * costs the board a JSON parse and a dispatch.
   *
   * The chunk is decoded ONCE and handed over ONCE, whole. It used to be cut
   * into 640-byte pieces here, on the theory that 640 was the only length the
   * speaker consumers accepted — see the unaligned case below for what that
   * cost. Device memory does not grow with the chunk either way.
   */
  spoken_frames = 0U;
  spoken_bytes = 0U;
  order_length = 0U;
  push_spk(&fixture, 4, 45, "", frames_b64(4U, 0x51));
  assert(spoken_frames == 1U);
  assert(spoken_bytes == 4U * (size_t)ITERATE_KIT_VOICELAB_FRAME_BYTES);
  assert(spoken_length == 4U * (size_t)ITERATE_KIT_VOICELAB_FRAME_BYTES);
  assert(order_length == 1U);
  assert(memcmp(order_log, "f", 1U) == 0);
  assert(fixture.voicelab.spk_decode_failures == 0U);

  /*
   * A CHUNK OF ANY LENGTH IS AUDIO, and goes to the speaker whole.
   *
   * This asserted the opposite until the alignment rule came out: a chunk with
   * a remainder was a protocol violation, counted and partly discarded. The
   * rule was unkeepable, because Grok's deltas are audio of no particular
   * length and none of them divides by 640 — the sender had to carry a
   * remainder between deltas and pad each answer's tail with silence to obey
   * it, and 118 chunks in three turns were dropped when it could not. The
   * speaker below is a byte ring, so there was never anything to obey.
   */
  spoken_bytes = 0U;
  push_spk(&fixture, 5, 46, "", pcm_b64(720U, 0x55)); /* 640 + 80 */
  assert(fixture.voicelab.spk_decode_failures == 0U);
  assert(spoken_frames == 2U);
  assert(spoken_bytes == 720U);
  assert(spoken_length == 720U);

  /* conversation-accepted on the stream is what made the call live — it led
   * the audio above, so by here the call has been live the whole time. A
   * re-delivered acceptance is idempotent. */
  assert(fixture.voicelab.call_active);
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",-1,[],[{\"events\":[["
      "{\"type\":\"events.iterate.com/voice-agent/conversation-accepted\",\"offset\":50,"
      "\"payload\":{\"activation\":\"" TEST_ACTIVATION "\",\"conversationId\":\"wsdev\",\"bridge\":\"worker\"}}"
      "]],\"scannedThroughOffset\":50,\"state\":null}]]]");
  receive(&fixture, "[\"release\",6,1]");
  assert(fixture.voicelab.call_active);

  /*
   * Redelivery of the same offsets (recycle overlap) is deduped; every
   * invocation is push + release, and pending slots must recycle.
   *
   * The dedupe matters more now that the control edges ride the audio: a
   * re-delivered final frame that got past the offset filter would raise a
   * SECOND end-of-answer against an answer already drained.
   */
  order_length = 0U;
  {
    static char message[16384];
    (void)snprintf(
        message, sizeof(message),
        "[\"push\",[\"pipeline\",-1,[],[{\"events\":[["
        "{\"type\":\"events.iterate.com/voice-agent/spk-frame\",\"offset\":40,"
        "\"payload\":{\"activation\":\"" TEST_ACTIVATION "\",\"pcm\":\"%s\"}},"
        "{\"type\":\"events.iterate.com/voice-agent/spk-frame\",\"offset\":43,"
        "\"payload\":{\"activation\":\"" TEST_ACTIVATION "\",\"lastFrameOfAnswer\":true,\"pcm\":\"%s\"}}"
        "]],\"scannedThroughOffset\":43,\"state\":null}]]]",
        frames_b64(1U, 0x41), frames_b64(1U, 0x49));
    receive(&fixture, message);
  }
  receive(&fixture, "[\"release\",7,1]");
  /* One per spk-frame event that carried audio, which is what the name says.
   * It read 8 when a single event could increment it once per 640 bytes. */
  assert(fixture.voicelab.spk_frames_received == 5U);
  assert(response_done_count == 1);
  assert(order_length == 0U);
  assert(capnweb_session_get_state(&fixture.session) == CAPNWEB_SESSION_OPEN);
  {
    size_t occupied = 0U;
    size_t index;
    for (index = 0U; index < CALL_CAPACITY; ++index) {
      if (fixture.pending_calls[index].occupied) {
        ++occupied;
      }
    }
    assert(occupied == 0U);
  }

  assert(iterate_kit_voicelab_close(&fixture.voicelab) == CAPNWEB_OK);
}

static void face_runtime_state_is_polled_and_deduped(void) {
  static struct fixture fixture;
  size_t before;

  fixture_init(&fixture);
  memset(&observed_face, 0, sizeof(observed_face));
  start_and_mount(&fixture);

  before = fixture.captured_count;
  assert(iterate_kit_voicelab_poll_face(&fixture.voicelab) == CAPNWEB_OK);
  assert(strstr(fixture.captured[before], "getProcessorRuntimeState") != NULL);
  assert(strstr(fixture.captured[before], "watch-v3") == NULL);
  assert(fixture.voicelab.face_poll_pending);
  receive(
      &fixture,
      "[\"resolve\",3,{\"runtime\":{\"face\":{\"answer\":7,\"playoutSamples\":1600,\"viseme\":9,\"confidence\":200,\"at\":100}}}]");
  assert(!fixture.voicelab.face_poll_pending);
  assert(observed_face.count == 1U);
  assert(observed_face.answer == 7U);
  assert(observed_face.offset_samples == 1600U);
  assert(observed_face.viseme == 9U);
  assert(observed_face.confidence == 200U);

  /* A reduced value is returned again until it changes; `at` makes it one fact. */
  assert(iterate_kit_voicelab_poll_face(&fixture.voicelab) == CAPNWEB_OK);
  receive(
      &fixture,
      "[\"resolve\",4,{\"runtime\":{\"face\":{\"answer\":7,\"playoutSamples\":1600,\"viseme\":9,\"confidence\":200,\"at\":100}}}]");
  assert(observed_face.count == 1U);

  /* A malformed shape is harmless and does not poison the next valid value. */
  assert(iterate_kit_voicelab_poll_face(&fixture.voicelab) == CAPNWEB_OK);
  receive(
      &fixture,
      "[\"resolve\",5,{\"runtime\":{\"face\":{\"answer\":7,\"playoutSamples\":1700,\"viseme\":99,\"at\":101}}}]");
  assert(observed_face.count == 1U);

  assert(iterate_kit_voicelab_poll_face(&fixture.voicelab) == CAPNWEB_OK);
  receive(
      &fixture,
      "[\"resolve\",6,{\"runtime\":{\"face\":{\"answer\":7,\"playoutSamples\":1700,\"viseme\":14,\"at\":101}}}]");
  assert(observed_face.count == 2U);
  assert(observed_face.offset_samples == 1700U);
  assert(observed_face.viseme == 14U);
  assert(observed_face.confidence == 0U);
  assert(fixture.voicelab.face_polls == 4U);
  assert(fixture.voicelab.face_updates == 2U);
  assert(fixture.voicelab.last_face_at_ms == 101U);
  assert(iterate_kit_voicelab_close(&fixture.voicelab) == CAPNWEB_OK);
}


/*
 * THE SECOND VOICE AGENT'S DIALECT.
 *
 * Two agents speak this contract. They differ in exactly one payload:
 * `drop: true` became `clearSpeakerBufferBeforeFrame: true` riding on a
 * numbered frame, and `last` became `lastFrameOfAnswer`. The rename is not
 * cosmetic — `drop` named no audio, so a late one discarded the answer that
 * had already replaced the one it was about.
 *
 * One binary understands both dialects on purpose. The two agents are meant to
 * be run side by side and compared, and an instrument that changes between the
 * two measurements measures itself. The numbering itself is carried and
 * ignored: nothing on the device ever acted on it.
 */
static void the_second_agents_dialect(void) {
  static struct fixture fixture;
  fixture_init(&fixture);
  start_and_mount(&fixture);

  speech_started_count = 0;
  spoken_frames = 0U;

  /* The acceptance leads the audio in one batch, as it does on the wire — the
   * delivery lane refuses frames for a call the device is not on. */
  {
    static char message[16384];
    (void)snprintf(
        message, sizeof(message),
        "[\"push\",[\"pipeline\",-1,[],[{\"events\":[["
        "{\"type\":\"events.iterate.com/voice-agent/conversation-accepted\","
        "\"offset\":99,\"payload\":{\"activation\":\"" TEST_ACTIVATION "\",\"conversationId\":\"wsdev\"}},"
        "{\"type\":\"events.iterate.com/voice-agent/spk-frame\",\"offset\":100,"
        "\"payload\":{\"activation\":\"" TEST_ACTIVATION "\",\"deviceSpeakerFrameSeq\":0,\"pcm\":\"%s\"}}"
        "]],\"scannedThroughOffset\":100,\"state\":null}]]]",
        frames_b64(1U, 0x40));
    receive(&fixture, message);
    receive(&fixture, "[\"release\",1,1]");
  }
  push_spk(
      &fixture, 2, 101, "\"deviceSpeakerFrameSeq\":1,", frames_b64(1U, 0x41));
  push_spk(
      &fixture, 3, 102, "\"deviceSpeakerFrameSeq\":2,", frames_b64(1U, 0x42));
  assert(spoken_frames == 3U);

  /* The first agent sends no number at all, and its frames play the same. */
  push_spk(&fixture, 4, 103, "", frames_b64(1U, 0x46));

  /*
   * AND THE NEW NAME FOR THE END OF AN ANSWER, on its own empty frame.
   *
   * The second agent raises this at the DRAIN point rather than attaching it to
   * whichever frame turned out to be final, so when the answer is short the
   * marker arrives as a frame of its own carrying no audio. That is the exact
   * shape the decode's early return used to swallow.
   */
  response_done_count = 0;
  spoken_frames = 0U;
  order_length = 0U;
  push_spk(
      &fixture,
      5,
      104,
      "\"deviceSpeakerFrameSeq\":8,\"lastFrameOfAnswer\":true,",
      "");
  assert(response_done_count == 1);
  assert(spoken_frames == 0U);
  assert(fixture.voicelab.spk_decode_failures == 0U);

  /* And when it does ride audio, the edge follows the frame — 'f' then 'l' —
   * so the owner never marks an answer drained with audio still queued. */
  order_length = 0U;
  push_spk(
      &fixture,
      6,
      105,
      "\"deviceSpeakerFrameSeq\":9,\"lastFrameOfAnswer\":true,",
      frames_b64(1U, 0x4a));
  assert(response_done_count == 2);
  assert(order_length == 2U);
  assert(memcmp(order_log, "fl", 2U) == 0);

  /* The first agent's `last` still means what it always did. */
  push_spk(&fixture, 7, 106, "\"lastFrameOfAnswer\":true,", "");
  assert(response_done_count == 3);

  /* A chunk of any length is audio, and reaches the speaker whole. */
  spoken_bytes = 0U;
  push_spk(
      &fixture,
      8,
      107,
      "\"deviceSpeakerFrameSeq\":10,",
      pcm_b64(ITERATE_KIT_VOICELAB_FRAME_BYTES + 64U, 0x34));
  assert(fixture.voicelab.spk_decode_failures == 0U);
  assert(spoken_bytes == (size_t)ITERATE_KIT_VOICELAB_FRAME_BYTES + 64U);

  /* The new name for the clear raises the same edge the old one did. */
  assert(speech_started_count == 0);
  push_spk(
      &fixture,
      9,
      108,
      "\"deviceSpeakerFrameSeq\":11,\"clearSpeakerBufferBeforeFrame\":true,",
      frames_b64(1U, 0x47));
  assert(speech_started_count == 1);

  /*
   * AND ON AN EMPTY ENVELOPE, which is the case that matters most.
   *
   * An interruption is exactly when the sender has no audio left to attach the
   * flag to — it has just thrown the answer away — so the clear rides a frame
   * whose `pcm` is empty. The decode has an early return on failure and this
   * used to sit below it: the server said stop, the device agreed to obey, and
   * the message was discarded on the doorstep for being an empty envelope.
   * Three fixes upstream were measured against that and moved nothing.
   */
  spoken_frames = 0U;
  push_spk(
      &fixture,
      10,
      109,
      "\"deviceSpeakerFrameSeq\":12,\"clearSpeakerBufferBeforeFrame\":true,",
      "");
  assert(speech_started_count == 2);
  assert(spoken_frames == 0U);
  /* Nothing in this run failed to DECODE, which is all the counter means now
   * that an unaligned chunk is ordinary audio rather than a violation. */
  assert(fixture.voicelab.spk_decode_failures == 0U);

  (void)iterate_kit_voicelab_close(&fixture.voicelab);
}



static void recycle_keeps_call_epoch_and_fences_closed_predecessor(void) {
  struct fixture fixture;
  size_t batches;
  fixture_init(&fixture);
  start_and_mount(&fixture);
  assert(iterate_kit_voicelab_recycle_subscription(
      &fixture.voicelab, &fixture.replacement_subscription) == CAPNWEB_OK);
  assert(fixture.voicelab.previous_subscription == &fixture.subscription);
  receive(&fixture, "[\"resolve\",3,[\"export\",-14]]");
  iterate_kit_voicelab_update(&fixture.voicelab);
  assert(fixture.voicelab.state == ITERATE_KIT_VOICELAB_READY);
  assert(fixture.voicelab.previous_subscription == NULL);
  /* The successor uses a new exported callback (-2), but the immutable call
   * epoch still accepts its first audio batch. */
  push_spk_to(&fixture, -2, 1, 10, "", frames_b64(1U, 0x42));
  assert(fixture.voicelab.batches_on_connection > 0U);
  batches = fixture.voicelab.batches_on_connection;
  /* The predecessor was closed once -2 opened, so a late -1 delivery cannot
   * advance the call's watermark or invoke its audio/control callbacks. */
  push_spk_to(&fixture, -1, 2, 11, "", frames_b64(1U, 0x43));
  assert(fixture.voicelab.batches_on_connection == batches);
}


static int latest_callback_id(const struct fixture *fixture) {
  size_t index;
  for (index = fixture->captured_count; index > 0U; --index) {
    const char *at = strstr(fixture->captured[index - 1U],
        "\"processEventBatch\":[\"export\",");
    if (at != NULL) {
      return atoi(at + sizeof("\"processEventBatch\":[\"export\",") - 1U);
    }
  }
  assert(false);
  return 0;
}

static int latest_pull_id(const struct fixture *fixture) {
  size_t index;
  for (index = fixture->captured_count; index > 0U; --index) {
    const char *at = strstr(fixture->captured[index - 1U], "[\"pull\",");
    if (at != NULL) return atoi(at + sizeof("[\"pull\",") - 1U);
  }
  assert(false);
  return 0;
}

static void resolve_latest_pull(struct fixture *fixture, const char *value) {
  char message[128];
  const int length = snprintf(message, sizeof(message),
      "[\"resolve\",%d,%s]", latest_pull_id(fixture), value);
  assert(length > 0 && (size_t)length < sizeof(message));
  receive(fixture, message);
}

static void release_server_callback(struct fixture *fixture, int callback) {
  char message[64];
  const int length = snprintf(message, sizeof(message),
      "[\"release\",%d,1]", callback);
  assert(length > 0 && (size_t)length < sizeof(message));
  receive(fixture, message);
}

static void accept_call(
    struct fixture *fixture, int callback, int release, int64_t offset) {
  char message[768];
  char release_message[64];
  const int length = snprintf(message, sizeof(message),
      "[\"push\",[\"pipeline\",%d,[],[{\"events\":[["
      "{\"type\":\"events.iterate.com/voice-agent/conversation-accepted\","
      "\"offset\":%lld,\"payload\":{\"activation\":\"" TEST_ACTIVATION "\","
      "\"conversationId\":\"test\"}}"
      "]],\"scannedThroughOffset\":%lld,\"state\":null}]]]",
      callback, (long long)offset, (long long)offset);
  assert(length > 0 && (size_t)length < sizeof(message));
  receive(fixture, message);
  assert(snprintf(release_message, sizeof(release_message),
      "[\"release\",%d,1]", release) > 0);
  receive(fixture, release_message);
}

static void close_waits_for_server_callback_before_slot_reuse(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  start_and_mount(&fixture);
  assert(iterate_kit_voicelab_close(&fixture.voicelab) == CAPNWEB_OK);
  assert(!iterate_kit_stream_subscription_reclaimable(&fixture.subscription));
  release_server_callback(&fixture, latest_callback_id(&fixture));
  assert(iterate_kit_stream_subscription_reclaimable(&fixture.subscription));
  /* Repeating this across more than the old four-export ceiling proves each
   * close/rebind hands its callback slot back before it is reused. */
  for (int cycle = 0; cycle < 5; ++cycle) {
    assert(iterate_kit_voicelab_bind(&fixture.voicelab,
        &(const struct iterate_kit_voicelab_options){
          .stream_path = "/voice-agent/dev-test", .activation = TEST_ACTIVATION,
          .now_ms = fixture_now_ms, .clock_context = &fixture,
        }, &fixture.stream, &fixture.subscription) == CAPNWEB_OK);
    resolve_latest_pull(&fixture, "[\"export\",-13]");
    iterate_kit_voicelab_update(&fixture.voicelab);
    assert(fixture.voicelab.state == ITERATE_KIT_VOICELAB_READY);
    assert(iterate_kit_voicelab_close(&fixture.voicelab) == CAPNWEB_OK);
    assert(!iterate_kit_stream_subscription_reclaimable(&fixture.subscription));
    release_server_callback(&fixture, latest_callback_id(&fixture));
    assert(iterate_kit_stream_subscription_reclaimable(&fixture.subscription));
  }
}

static void face_poll_blocks_rebind_until_its_completion(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  start_and_mount(&fixture);
  assert(iterate_kit_voicelab_poll_face(&fixture.voicelab) == CAPNWEB_OK);
  assert(iterate_kit_voicelab_close(&fixture.voicelab) == CAPNWEB_OK);
  assert(iterate_kit_voicelab_bind(&fixture.voicelab,
      &(const struct iterate_kit_voicelab_options){
        .stream_path = "/voice-agent/dev-test", .activation = TEST_ACTIVATION,
        .now_ms = fixture_now_ms, .clock_context = &fixture,
      }, &fixture.stream, &fixture.replacement_subscription) == CAPNWEB_E_STATE);
  resolve_latest_pull(&fixture, "{\"runtime\":{}}");
  assert(!fixture.voicelab.face_poll_pending);
  assert(iterate_kit_voicelab_close(&fixture.voicelab) == CAPNWEB_OK);
  release_server_callback(&fixture, latest_callback_id(&fixture));
  assert(iterate_kit_stream_subscription_reclaimable(&fixture.subscription));
}

static void append_frames_keeps_one_padded_base64_body(void) {
  struct fixture fixture;
  const uint8_t pcm[] = {'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'};
  size_t before;
  fixture_init(&fixture);
  start_and_mount(&fixture);
  before = fixture.captured_count;
  assert(iterate_kit_voicelab_append_frames(
      &fixture.voicelab, pcm, 2U, 4U, TEST_ACTIVATION) == CAPNWEB_OK);
  assert(fixture.captured_count == before + 2U);
  /* Two four-byte capture frames must be encoded as one padded PCM body. */
  assert(strstr(fixture.captured[before], "\"pcm\":\"QUJDREVGR0g=\"") != NULL);
  assert(iterate_kit_voicelab_close(&fixture.voicelab) == CAPNWEB_OK);
}

static void keepalive_is_quiet_for_twenty_seconds_after_success(void) {
  struct fixture fixture;
  size_t before;
  fixture_init(&fixture);
  start_and_mount(&fixture);
  accept_call(&fixture, -1, 1, 1);
  fixture.clock_ms = 100U;
  before = fixture.captured_count;
  assert(iterate_kit_voicelab_keepalive_if_due(&fixture.voicelab) == CAPNWEB_OK);
  assert(fixture.captured_count == before + 2U);
  assert(strstr(fixture.captured[before], "voice-agent/keepalive") != NULL);
  fixture.clock_ms += ITERATE_KIT_VOICE_CALL_KEEPALIVE_MS - 1U;
  assert(iterate_kit_voicelab_keepalive_if_due(&fixture.voicelab) == CAPNWEB_OK);
  assert(fixture.captured_count == before + 2U);
  ++fixture.clock_ms;
  assert(iterate_kit_voicelab_keepalive_if_due(&fixture.voicelab) == CAPNWEB_OK);
  assert(fixture.captured_count == before + 4U);
  assert(iterate_kit_voicelab_close(&fixture.voicelab) == CAPNWEB_OK);
}

static void terminal_rejects_unsafe_reason_without_an_ephemeral_append(void) {
  struct fixture fixture;
  size_t before;
  fixture_init(&fixture);
  start_and_mount(&fixture);
  before = fixture.captured_count;
  assert(iterate_kit_voicelab_end_activation(
      &fixture.stream, TEST_ACTIVATION, "bad\"reason") == CAPNWEB_E_INVALID_ARGUMENT);
  assert(fixture.captured_count == before);
  assert(iterate_kit_voicelab_end_activation(
      &fixture.stream, TEST_ACTIVATION, "hangup") == CAPNWEB_OK);
  assert(fixture.captured_count == before + 2U);
  assert(strstr(fixture.captured[before], "conversation-ended") != NULL);
  assert(strstr(fixture.captured[before], "\"ephemeral\"") == NULL);
  assert(iterate_kit_voicelab_close(&fixture.voicelab) == CAPNWEB_OK);
}

int main(void) {
  downlink_flow();
  face_runtime_state_is_polled_and_deduped();
  the_second_agents_dialect();
  recycle_keeps_call_epoch_and_fences_closed_predecessor();
  close_waits_for_server_callback_before_slot_reuse();
  face_poll_blocks_rebind_until_its_completion();
  append_frames_keeps_one_padded_base64_body();
  keepalive_is_quiet_for_twenty_seconds_after_success();
  terminal_rejects_unsafe_reason_without_an_ephemeral_append();
  return 0;
}
