/*
 * voicelab_stream: single-WebSocket device end of the voicelab protocol —
 * authenticate -> projects.get -> streams.get, then one-way mic-frame
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
  CAPTURE_CAPACITY = 32,
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
    .session = &fixture->session,
    .project_id = "prj_test",
    .project_api_key = "itxk_secret-never-log",
    .stream_path = "/voice-agent/dev-test",
    .conversation_id = "wsdev",
    .now_ms = fixture_now_ms,
    .clock_context = fixture,
  };
  assert(
      iterate_kit_voicelab_start(&fixture->voicelab, &options) ==
      CAPNWEB_OK);
  assert(
      fixture->voicelab.state == ITERATE_KIT_VOICELAB_AUTHENTICATING);
  assert(fixture->captured_count == 2U);
  assert(strcmp(
      fixture->captured[0],
      "[\"push\",[\"pipeline\",0,[\"authenticate\"],"
      "[{\"type\":\"project-secret\",\"projectId\":\"prj_test\","
      "\"secret\":\"itxk_secret-never-log\"}]]]") == 0);
  assert(strcmp(fixture->captured[1], "[\"pull\",1]") == 0);

  receive(fixture, "[\"resolve\",1,[\"export\",-10]]");
  assert(
      fixture->voicelab.state == ITERATE_KIT_VOICELAB_GETTING_PROJECT);
  assert(strcmp(
      fixture->captured[3],
      "[\"push\",[\"pipeline\",-10,[\"projects\",\"get\"],"
      "[\"prj_test\"]]]") == 0);

  receive(fixture, "[\"resolve\",2,[\"export\",-11]]");
  assert(
      fixture->voicelab.state == ITERATE_KIT_VOICELAB_GETTING_STREAM);
  /* release of import 2, release of session cap -10, then streams.get */
  assert(strcmp(
      fixture->captured[7],
      "[\"push\",[\"pipeline\",-11,[\"streams\",\"get\"],"
      "[\"/voice-agent/dev-test\"]]]") == 0);
  assert(strcmp(fixture->captured[8], "[\"pull\",3]") == 0);

  receive(fixture, "[\"resolve\",3,[\"export\",-12]]");
  assert(fixture->voicelab.state == ITERATE_KIT_VOICELAB_READY);
  assert(fixture->voicelab.has_stream_capability);
  /* Kept until the common close path releases the session's imported stubs. */
  assert(fixture->voicelab.has_project_capability);
  assert(!fixture->voicelab.has_session_capability);
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
static void push_spk(
    struct fixture *fixture,
    int release_id,
    int64_t offset,
    const char *flags,
    const char *pcm_b64) {
  static char message[16384];
  (void)snprintf(
      message, sizeof(message),
      "[\"push\",[\"pipeline\",-1,[],[{\"events\":[["
      "{\"type\":\"events.iterate.com/voice-agent/spk-frame\",\"offset\":%lld,"
      "\"payload\":{%s\"pcm\":\"%s\"}}"
      "]],\"scannedThroughOffset\":%lld,\"state\":null}]]]",
      (long long)offset, flags, pcm_b64, (long long)offset);
  receive(fixture, message);
  {
    char release[64];
    (void)snprintf(release, sizeof(release), "[\"release\",%d,1]", release_id);
    receive(fixture, release);
  }
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
  {
    const struct iterate_kit_voicelab_options options = {
      .session = &fixture.session,
      .project_id = "prj_test",
      .project_api_key = "itxk_secret-never-log",
      .stream_path = "/voice-agent/dev-test",
      .conversation_id = "wsdev",
      .now_ms = fixture_now_ms,
      .clock_context = &fixture,
      .on_speaker = record_speaker,
      .on_control = record_control,
      .downlink_context = NULL,
    };
    assert(
        iterate_kit_voicelab_start(&fixture.voicelab, &options) ==
        CAPNWEB_OK);
  }
  receive(&fixture, "[\"resolve\",1,[\"export\",-10]]");
  receive(&fixture, "[\"resolve\",2,[\"export\",-11]]");
  receive(&fixture, "[\"resolve\",3,[\"export\",-12]]");
  assert(
      fixture.voicelab.state == ITERATE_KIT_VOICELAB_OPENING_CONNECTION);

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
    assert(strstr(open_message, "\"connectionKey\":\"wsdev-cb-g1\"") != NULL);
    /*
     * The subscription IS the wire contract, so it is pinned literally rather
     * than checked for membership: a type quietly added or dropped upstream
     * must fail here and not on a bench.
     *
     * THREE, down from six. `pong` went with the ping that earned it;
     * `grok-event` carried two facts that now ride `spk-frame` as `drop` and
     * `last`; `viseme` is deleted from the contract because the face is
     * reduced state published through `liveState`.
     */
    assert(
        strstr(
            open_message,
            "\"eventTypes\":[["
            "\"events.iterate.com/voice-agent/spk-frame\","
            "\"events.iterate.com/voice-agent/conversation-ended\","
            "\"events.iterate.com/voice-agent/conversation-accepted\"]]") !=
        NULL);
    assert(strstr(open_message, "\"maxDeliveryEvents\":16") != NULL);
    assert(strstr(open_message, "\"maxDeliveryBytes\":13000") != NULL);
    assert(strstr(open_message, "\"state\":false") != NULL);
    assert(strstr(open_message, "\"processEventBatch\":[\"export\",-1]") != NULL);
  }
  receive(&fixture, "[\"resolve\",4,[\"export\",-13]]");
  assert(fixture.voicelab.state == ITERATE_KIT_VOICELAB_READY);
  assert(fixture.voicelab.has_connection_capability);

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
        "\"offset\":39,\"payload\":{\"conversationId\":\"wsdev\"}},"
        "{\"type\":\"events.iterate.com/voice-agent/spk-frame\",\"offset\":40,"
        "\"payload\":{\"pcm\":\"%s\"}},"
        "{\"type\":\"events.iterate.com/voice-agent/spk-frame\",\"offset\":41,"
        "\"payload\":{\"drop\":true,\"pcm\":\"%s\"}}"
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
  push_spk(&fixture, 2, 43, "\"last\":true,", frames_b64(1U, 0x49));
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
   * never drained and never released its half-duplex fence, and the next
   * answer played into a queue still holding the previous one. Heard on a HA
   * Voice PE as speech that speeds up and then stops, two or three turns into
   * a conversation — the turn it bites depends on whether that answer's deltas
   * happened to land on a frame boundary, which is why it looked intermittent.
   */
  order_length = 0U;
  response_done_count = 0;
  push_spk(&fixture, 3, 44, "\"last\":true,", "");
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
      "\"payload\":{\"conversationId\":\"wsdev\",\"bridge\":\"worker\"}}"
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
        "\"payload\":{\"pcm\":\"%s\"}},"
        "{\"type\":\"events.iterate.com/voice-agent/spk-frame\",\"offset\":43,"
        "\"payload\":{\"last\":true,\"pcm\":\"%s\"}}"
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

  /* Proactive recycle: successor opens under g2, incumbent released after. */
  fixture.voicelab.batches_on_connection =
      ITERATE_KIT_VOICELAB_RECYCLE_AFTER_BATCHES;
  assert(iterate_kit_voicelab_needs_recycle(&fixture.voicelab));
  assert(
      iterate_kit_voicelab_recycle_connection(&fixture.voicelab) ==
      CAPNWEB_OK);
  {
    const char *second_open = fixture.captured[fixture.captured_count - 2U];
    assert(strstr(second_open, "\"connectionKey\":\"wsdev-cb-g2\"") != NULL);
  }
  receive(&fixture, "[\"resolve\",5,[\"export\",-14]]");
  assert(fixture.voicelab.state == ITERATE_KIT_VOICELAB_READY);
  assert(fixture.voicelab.batches_on_connection < 2U);
  assert(!fixture.voicelab.has_previous_connection_capability);

  assert(iterate_kit_voicelab_close(&fixture.voicelab) == CAPNWEB_OK);
}


/** Occupied slots in the fixture session's export table. */
static size_t exports_in_use(const struct fixture *fixture) {
  size_t index;
  size_t used = 0U;
  for (index = 0U; index < CALL_CAPACITY; ++index) {
    if (fixture->exports[index].occupied) used++;
  }
  return used;
}

/**
 * One complete mount with a downlink, answering each of its four calls.
 *
 * Ids are counted rather than written down: a second mount on the SAME session
 * continues the numbering, and that is the whole point of the test below.
 */
static void mount_with_downlink(struct fixture *fixture, int *next_id) {
  const struct iterate_kit_voicelab_options options = {
    .session = &fixture->session,
    .project_id = "prj_test",
    .project_api_key = "itxk_secret-never-log",
    .stream_path = "/voice-agent/dev-test",
    .conversation_id = "wsdev",
    .now_ms = fixture_now_ms,
    .clock_context = fixture,
    .on_speaker = record_speaker,
    .on_control = record_control,
    .downlink_context = NULL,
  };
  char message[64];
  int index;

  assert(iterate_kit_voicelab_start(&fixture->voicelab, &options) == CAPNWEB_OK);
  for (index = 0; index < 4; ++index) {
    (void)snprintf(
        message, sizeof(message), "[\"resolve\",%d,[\"export\",-%d]]",
        *next_id, 10 + *next_id);
    receive(fixture, message);
    (*next_id)++;
  }
  assert(fixture->voicelab.state == ITERATE_KIT_VOICELAB_READY);
}

/*
 * RE-MOUNTING MUST HAND BACK WHAT THE LAST MOUNT HELD.
 *
 * `iterate_kit_voicelab_start` memsets the struct, and for a long time it did
 * that while the SESSION still held the capabilities the last mount had taken:
 * the exported callback, and the imported connection whose reference is what
 * keeps that callback alive at the platform. So every re-mount burned an export
 * slot. A real board's table holds four and a healthy one already uses two, so
 * the second re-mount filled it — the export was refused, the voicelab latched
 * failed underneath a perfectly ready transport and connection, and nothing
 * recovered it but the 180-second liveness restart of the whole chip. Measured
 * on the HA Voice PE at exports 4/4, imports 0/16, nothing delivered.
 *
 * What is asserted is what this side controls: a re-mount says `release` for
 * the previous mount before it asks for anything new. Whether the peer then
 * drops its own reference is the peer's half of the contract, and no fixture
 * here can stand in for it.
 */
/*
 * THE SECOND VOICE AGENT'S DIALECT, and the counters that make a long call
 * provable.
 *
 * Two agents now speak this contract. They differ in exactly one payload:
 * `drop: true` became `clearSpeakerBufferBeforeFrame: true` riding on a
 * NUMBERED frame, and every chunk carries `deviceSpeakerFrameSeq`. The rename
 * is not cosmetic — `drop` named no audio, so a late one discarded the answer
 * that had already replaced the one it was about — but the numbering is what
 * this test is really for: `spk-frame` is ephemeral and never persisted, so
 * the device is the only witness that can say whether the answer arrived
 * whole. A hole in the numbering is a lost chunk, and until it was counted,
 * "the answer was short" and "the answer was cut" looked identical.
 *
 * One binary understands both dialects on purpose. The two agents are meant to
 * be run side by side and compared, and an instrument that changes between the
 * two measurements measures itself.
 */
static void speaker_sequence_continuity(void) {
  static struct fixture fixture;
  fixture_init(&fixture);
  {
    const struct iterate_kit_voicelab_options options = {
      .session = &fixture.session,
      .project_id = "prj_test",
      .project_api_key = "itxk_secret-never-log",
      .stream_path = "/voice-agent/dev-test",
      .conversation_id = "wsdev",
      .now_ms = fixture_now_ms,
      .clock_context = &fixture,
      .on_speaker = record_speaker,
      .on_control = record_control,
      .downlink_context = NULL,
    };
    assert(
        iterate_kit_voicelab_start(&fixture.voicelab, &options) == CAPNWEB_OK);
  }
  receive(&fixture, "[\"resolve\",1,[\"export\",-10]]");
  receive(&fixture, "[\"resolve\",2,[\"export\",-11]]");
  receive(&fixture, "[\"resolve\",3,[\"export\",-12]]");
  receive(&fixture, "[\"resolve\",4,[\"export\",-13]]");

  /* Nothing seen yet, and that is a different state from "frame zero seen". */
  assert(fixture.voicelab.spk_seq_last == -1);

  speech_started_count = 0;
  spoken_frames = 0U;

  /* Contiguous from zero: no gaps, no regressions, watermark follows. The
   * acceptance leads the audio in one batch, as it does on the wire — the
   * delivery lane refuses frames for a call the device is not on. */
  {
    static char message[16384];
    (void)snprintf(
        message, sizeof(message),
        "[\"push\",[\"pipeline\",-1,[],[{\"events\":[["
        "{\"type\":\"events.iterate.com/voice-agent/conversation-accepted\","
        "\"offset\":99,\"payload\":{\"conversationId\":\"wsdev\"}},"
        "{\"type\":\"events.iterate.com/voice-agent/spk-frame\",\"offset\":100,"
        "\"payload\":{\"deviceSpeakerFrameSeq\":0,\"pcm\":\"%s\"}}"
        "]],\"scannedThroughOffset\":100,\"state\":null}]]]",
        frames_b64(1U, 0x40));
    receive(&fixture, message);
    receive(&fixture, "[\"release\",1,1]");
  }
  push_spk(
      &fixture, 2, 101, "\"deviceSpeakerFrameSeq\":1,", frames_b64(1U, 0x41));
  push_spk(
      &fixture, 3, 102, "\"deviceSpeakerFrameSeq\":2,", frames_b64(1U, 0x42));
  assert(fixture.voicelab.spk_seq_last == 2);
  assert(fixture.voicelab.spk_seq_gaps == 0U);
  assert(fixture.voicelab.spk_seq_missing == 0U);
  assert(fixture.voicelab.spk_seq_regressions == 0U);
  assert(spoken_frames == 3U);

  /*
   * A HOLE: 3, 4 and 5 never arrived. ONE gap event, THREE missing frames —
   * the two are counted separately because one hole of forty is a different
   * failure from forty holes of one, and a single total cannot tell them
   * apart.
   */
  push_spk(
      &fixture, 4, 103, "\"deviceSpeakerFrameSeq\":6,", frames_b64(1U, 0x43));
  assert(fixture.voicelab.spk_seq_gaps == 1U);
  assert(fixture.voicelab.spk_seq_missing == 3U);
  assert(fixture.voicelab.spk_seq_last == 6);

  /*
   * A NUMBER ALREADY SEEN. The offset dedupe at the top of the dispatch drops
   * REDELIVERED events, so this is something it cannot see — a sender
   * renumbering mid-call, or two senders on one stream — which is exactly why
   * it is worth a counter of its own rather than being folded into gaps.
   */
  push_spk(
      &fixture, 5, 104, "\"deviceSpeakerFrameSeq\":4,", frames_b64(1U, 0x44));
  assert(fixture.voicelab.spk_seq_regressions == 1U);
  /* And the watermark did NOT rewind: if it had, every frame after this one
   * would be scored as a fresh gap in turn and one glitch would report as a
   * ruined call. */
  assert(fixture.voicelab.spk_seq_last == 6);
  push_spk(
      &fixture, 6, 105, "\"deviceSpeakerFrameSeq\":7,", frames_b64(1U, 0x45));
  assert(fixture.voicelab.spk_seq_gaps == 1U);

  /*
   * THE FIRST AGENT SENDS NO NUMBER AT ALL, and absent is not zero. A frame
   * with no `deviceSpeakerFrameSeq` must leave every one of these untouched,
   * or running the two tracks side by side would report the older one as
   * having lost its entire answer.
   */
  push_spk(&fixture, 7, 106, "", frames_b64(1U, 0x46));
  assert(fixture.voicelab.spk_seq_last == 7);
  assert(fixture.voicelab.spk_seq_gaps == 1U);
  assert(fixture.voicelab.spk_seq_missing == 3U);
  assert(fixture.voicelab.spk_seq_regressions == 1U);

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
      8,
      107,
      "\"deviceSpeakerFrameSeq\":8,\"lastFrameOfAnswer\":true,",
      "");
  assert(response_done_count == 1);
  assert(spoken_frames == 0U);
  assert(fixture.voicelab.spk_decode_failures == 0U);
  assert(fixture.voicelab.spk_seq_last == 8);

  /* And when it does ride audio, the edge follows the frame — 'f' then 'l' —
   * so the owner never marks an answer drained with audio still queued. */
  order_length = 0U;
  push_spk(
      &fixture,
      9,
      108,
      "\"deviceSpeakerFrameSeq\":9,\"lastFrameOfAnswer\":true,",
      frames_b64(1U, 0x4a));
  assert(response_done_count == 2);
  assert(order_length == 2U);
  assert(memcmp(order_log, "fl", 2U) == 0);

  /* The first agent's `last` still means what it always did. */
  push_spk(&fixture, 10, 109, "\"last\":true,", "");
  assert(response_done_count == 3);

  /* A chunk of any length is audio, and reaches the speaker whole. */
  spoken_bytes = 0U;
  push_spk(
      &fixture,
      11,
      112,
      "\"deviceSpeakerFrameSeq\":10,",
      pcm_b64(ITERATE_KIT_VOICELAB_FRAME_BYTES + 64U, 0x34));
  assert(fixture.voicelab.spk_decode_failures == 0U);
  assert(spoken_bytes == (size_t)ITERATE_KIT_VOICELAB_FRAME_BYTES + 64U);

  /* The new name for the clear raises the same edge the old one did. */
  assert(speech_started_count == 0);
  push_spk(
      &fixture,
      12,
      113,
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
      13,
      114,
      "\"deviceSpeakerFrameSeq\":12,\"clearSpeakerBufferBeforeFrame\":true,",
      "");
  assert(speech_started_count == 2);
  assert(spoken_frames == 0U);
  /* A numbered clear still counts as arrived: it is a frame in the sequence,
   * and skipping it here would make the NEXT frame look like a gap. */
  assert(fixture.voicelab.spk_seq_last == 12);
  assert(fixture.voicelab.spk_seq_gaps == 1U);
  /* Nothing in this run failed to DECODE, which is all the counter means now
   * that an unaligned chunk is ordinary audio rather than a violation. */
  assert(fixture.voicelab.spk_decode_failures == 0U);

  /*
   * A NEW CALL RESTARTS THE NUMBERING, so the watermark is per-conversation
   * while the totals are per-run. Carrying the watermark across a call would
   * score the next call's frame 0 as a regression and everything after it as a
   * gap; resetting the TOTALS would answer the wrong question, which is how
   * much audio the whole session lost.
   */
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",-1,[],[{\"events\":[["
      "{\"type\":\"events.iterate.com/voice-agent/conversation-accepted\","
      "\"offset\":115,\"payload\":{\"bridgeId\":\"b1\"}}"
      "]],\"scannedThroughOffset\":115,\"state\":null}]]]");
  receive(&fixture, "[\"release\",14,1]");
  assert(fixture.voicelab.call_active);
  assert(fixture.voicelab.spk_seq_last == -1);
  assert(fixture.voicelab.spk_seq_gaps == 1U);
  assert(fixture.voicelab.spk_seq_missing == 3U);

  push_spk(
      &fixture, 15, 116, "\"deviceSpeakerFrameSeq\":0,", frames_b64(1U, 0x48));
  assert(fixture.voicelab.spk_seq_regressions == 1U); /* unchanged */
  assert(fixture.voicelab.spk_seq_gaps == 1U);
  assert(fixture.voicelab.spk_seq_last == 0);

  (void)iterate_kit_voicelab_close(&fixture.voicelab);
}

static void remounting_releases_the_previous_mount(void) {
  static struct fixture fixture;
  int next_id = 1;
  size_t before;
  size_t index;
  size_t releases = 0U;

  fixture_init(&fixture);
  mount_with_downlink(&fixture, &next_id);
  assert(exports_in_use(&fixture) > 0U);

  /*
   * The connection stub of the first mount, named exactly. `mount_with_downlink`
   * answers the fourth call — openConnection — with export -(10 + id), and the
   * ids start at 1, so the first mount's connection is -14. A re-mount that
   * forgets it never sends this, and the platform goes on holding the callback
   * that reference keeps alive.
   */
  before = fixture.captured_count;
  mount_with_downlink(&fixture, &next_id);
  for (index = before; index < fixture.captured_count; ++index) {
    if (strstr(fixture.captured[index], "[\"release\",-14") != NULL) releases++;
  }
  assert(releases > 0U);
}

int main(void) {
  static struct fixture fixture;
  /* "ABCD" + 0x00 0x01: exercises multi-chunk + 2-byte-tail base64. */
  static const uint8_t pcm[6] = {0x41U, 0x42U, 0x43U, 0x44U, 0x00U, 0x01U};
  static const uint8_t *const pcm_frames[] = {pcm};
  size_t before;

  remounting_releases_the_previous_mount();

  fixture_init(&fixture);
  start_and_mount(&fixture);

  /* Frame appends are one-way: push + release, no pull, no import held. */
  before = fixture.captured_count;
  fixture.clock_ms = 1234U;
  assert(
      iterate_kit_voicelab_append_frames(
          &fixture.voicelab,
          pcm_frames,
          1U,
          sizeof(pcm),
          7U,
          1234U) == CAPNWEB_OK);
  assert(fixture.captured_count == before + 2U);
  assert(strstr(fixture.captured[before], "\"seq\":7,\"t\":1234") != NULL);
  /* "p": the uplink is PCM16. It was "u" and the transcode is gone — see the
   * note where the encoder used to be for what that cost and might cost
   * again. */
  /* No codec field on the wire: the lane carries PCM16 and nothing else. */
  assert(strstr(fixture.captured[before], "\"enc\"") == NULL);
  assert(strstr(fixture.captured[before + 1U], "[\"release\",") != NULL);
  assert(fixture.voicelab.frames_sent == 1U);
  assert(fixture.voicelab.frame_send_failures == 0U);

  /* A full 640-byte frame fits the args buffer and one outbox slot. */
  {
    static uint8_t full_frame[ITERATE_KIT_VOICELAB_FRAME_BYTES];
    static const uint8_t *full_frames[] = {full_frame};
    size_t index;
    for (index = 0U; index < sizeof(full_frame); ++index) {
      full_frame[index] = (uint8_t)(index & 0xffU);
    }
    before = fixture.captured_count;
    assert(
        iterate_kit_voicelab_append_frames(
            &fixture.voicelab,
            full_frames,
            1U,
            sizeof(full_frame),
            8U,
            1254U) == CAPNWEB_OK);
    assert(fixture.captured_count == before + 2U);
    assert(
        fixture.captured_lengths[before] < MESSAGE_CAPACITY);
  }

  /* Call control is entirely stream-owned: a pulled append requests setup,
   * and hangup is a durable one-way append the bridge is subscribed to. */
  {
    const char *start_message = NULL;
    const char *end_message = NULL;
    size_t index;
    assert(
        iterate_kit_voicelab_end_call(&fixture.voicelab, "not\\json") ==
        CAPNWEB_E_INVALID_ARGUMENT);
    before = fixture.captured_count;
    /*
     * A GREETING CANNOT REACH THE WIRE AT ALL NOW, which is a stronger
     * guarantee than rejecting an unsafe one. This used to embed the caller's
     * greeting in the JSON and therefore had to screen it for quotes; the
     * press carries no greeting, so the injection it was screening for is not
     * representable. Passing a hostile one must simply be harmless.
     */
    assert(
        iterate_kit_voicelab_start_call(&fixture.voicelab, "not \"json") ==
        CAPNWEB_OK);
    assert(fixture.voicelab.call_pending);
    for (index = before; index < fixture.captured_count; ++index) {
      if (strstr(fixture.captured[index], "ptt-start") != NULL) {
        start_message = fixture.captured[index];
      }
    }
    assert(start_message != NULL);
    assert(strstr(start_message, "[\"append\"]") != NULL);
    assert(
        strstr(
            start_message,
            "\"type\":\"events.iterate.com/voice-agent/ptt-start\"") != NULL);
    /* The press names no call, no turn mode and no greeting: all three are
     * the server's, and a device asserting them was a second source of truth
     * for state only the server holds. */
    assert(strstr(start_message, "conversationId") == NULL);
    assert(strstr(start_message, "greet") == NULL);
    assert(strstr(start_message, "not \\\"json") == NULL);
    /* One start in flight at a time. */
    assert(
        iterate_kit_voicelab_start_call(&fixture.voicelab, NULL) ==
        CAPNWEB_E_STATE);
    receive(&fixture, "[\"resolve\",6,[{\"ok\":true}]]");
    assert(!fixture.voicelab.call_pending);
    assert(fixture.voicelab.call_starts == 1U);
    /* The reply does not make the call live — the stream's conversation-accepted
     * does, because the reply can be slow or lost and a call opened by
     * anyone else counts just the same. */
    assert(!fixture.voicelab.call_active);

    before = fixture.captured_count;
    assert(
        iterate_kit_voicelab_end_call(&fixture.voicelab, "button") ==
        CAPNWEB_OK);
    assert(!fixture.voicelab.call_active);
    for (index = before; index < fixture.captured_count; ++index) {
      if (strstr(fixture.captured[index], "conversation-ended") != NULL) {
        end_message = fixture.captured[index];
      }
    }
    assert(end_message != NULL);
    assert(strstr(end_message, "\"conversationId\":\"wsdev\"") != NULL);
    assert(strstr(end_message, "\"reason\":\"button\"") != NULL);
    /* Durable: no ephemeral marker, or the bridge would still see it but
     * nothing would record that the call was hung up. */
    assert(strstr(end_message, "ephemeral") == NULL);

    /*
     * THE TURN MODE IS NOT THE DEVICE'S TO DECLARE. A board used to announce
     * "manual" or "vad" in its request and the server obeyed; the press is
     * now identical either way, because the client segmenting with its own
     * button IS manual turns and server VAD on top of that answers halfway
     * through a sentence.
     */
    fixture.voicelab.options.turns = "vad";
    before = fixture.captured_count;
    start_message = NULL;
    assert(
        iterate_kit_voicelab_start_call(&fixture.voicelab, NULL) ==
        CAPNWEB_OK);
    for (index = before; index < fixture.captured_count; ++index) {
      if (strstr(fixture.captured[index], "ptt-start") != NULL) {
        start_message = fixture.captured[index];
      }
    }
    assert(start_message != NULL);
    assert(strstr(start_message, "turns") == NULL);
    receive(&fixture, "[\"resolve\",8,[{\"ok\":true}]]");
    assert(!fixture.voicelab.call_pending);
  }

  /* Raw diagnostics appends share the one-way lane. */
  {
    static const char stats[] =
        "[{\"type\":\"events.iterate.com/voice-agent/dev-stats\",\"ephemeral\":true,"
        "\"payload\":{\"heapFree\":123456}}]";
    assert(
        iterate_kit_voicelab_append_raw(
            &fixture.voicelab, stats, sizeof(stats) - 1U) == CAPNWEB_OK);
  }

  assert(iterate_kit_voicelab_close(&fixture.voicelab) == CAPNWEB_OK);
  assert(fixture.voicelab.state == ITERATE_KIT_VOICELAB_CLOSED);

  downlink_flow();
  speaker_sequence_continuity();

  printf("voicelab stream test passed\n");
  return 0;
}
