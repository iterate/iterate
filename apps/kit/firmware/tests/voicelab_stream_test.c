/*
 * voicelab_stream: single-WebSocket device end of the voicelab protocol —
 * authenticate -> projects.get -> streams.get, then one-way mic-frame
 * appends (base64 PCM16, ephemeral) and a pulled ping append as RTT probe.
 */
#include "iterate/kit/voicelab_stream.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum {
  /* Matches the device: a delivery batch carrying a nested
   * conversation.item.added transcript needs more than a trivial budget. */
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
    .call_id = "wsdev",
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

static uint8_t spoken[64];
static size_t spoken_length;
static int64_t spoken_sequence = -1;
static int speech_started_count;
static int response_done_count;

static uint32_t spoken_answer;

/*
 * Records the identity the frame CARRIED, not one reconstructed here. A stub
 * that invented the answer number would have passed while the production call
 * sites did exactly that and could never detect a superseded answer.
 */
static void record_speaker(
    void *context,
    const uint8_t *pcm,
    size_t pcm_length,
    const struct iterate_kit_playout_frame *identity) {
  (void)context;
  if (pcm_length <= sizeof(spoken)) {
    memcpy(spoken, pcm, pcm_length);
    spoken_length = pcm_length;
  }
  spoken_sequence = identity == NULL ? -1 : (int64_t)identity->frame;
  spoken_answer = identity == NULL ? 0U : identity->answer;
}

static char heard_user[192];
static char heard_assistant[256];
static bool assistant_final;

static int heard_user_count;

static void record_transcript(
    void *context, bool from_user, const char *text, bool final) {
  (void)context;
  if (from_user) {
    snprintf(heard_user, sizeof(heard_user), "%s", text);
    ++heard_user_count;
    return;
  }
  snprintf(heard_assistant, sizeof(heard_assistant), "%s", text);
  assistant_final = final;
}

static void record_control(
    void *context, enum iterate_kit_voicelab_control control) {
  (void)context;
  if (control == ITERATE_KIT_VOICELAB_CONTROL_SPEECH_STARTED) {
    ++speech_started_count;
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_RESPONSE_DONE) {
    ++response_done_count;
  }
}

static int viseme_count;
static uint32_t viseme_answer;
static uint32_t viseme_offset_samples;
static uint8_t viseme_id;
static uint8_t viseme_confidence;

static void record_viseme(
    void *context, uint32_t answer, uint32_t offset_samples,
    uint8_t viseme, uint8_t confidence) {
  (void)context;
  ++viseme_count;
  viseme_answer = answer;
  viseme_offset_samples = offset_samples;
  viseme_id = viseme;
  viseme_confidence = confidence;
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
      .call_id = "wsdev",
      .now_ms = fixture_now_ms,
      .clock_context = &fixture,
      .on_speaker = record_speaker,
      .on_control = record_control,
      .on_transcript = record_transcript,
      .on_viseme = record_viseme,
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
     * A quiet call still needs one positive liveness observation. The bridge's
     * durable pong event is therefore part of the same bounded subscription as
     * audio and lifecycle events; omitting it here previously let the wire
     * contract change while the native suite stayed stale.
     */
    assert(
        strstr(
            open_message,
            "\"eventTypes\":[[\"voice-agent/spk-frame\",\"voice-agent/grok-event\","
      "\"voice-agent/call-ended\",\"voice-agent/call-accepted\","
      "\"voice-agent/pong\",\"voice-agent/viseme\"]]") !=
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
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",-1,[],[{\"projectId\":\"prj_test\","
      "\"path\":\"/voice-agent/dev-test\",\"streamId\":\"sid\",\"events\":[["
      "{\"type\":\"voice-agent/spk-frame\",\"offset\":40,"
      "\"payload\":{\"seq\":0,\"pcm\":\"QUJDRA\"}},"
      "{\"type\":\"voice-agent/grok-event\",\"offset\":41,"
      "\"payload\":{\"event\":{\"type\":\"input_audio_buffer.speech_started\"}}}"
      "]],\"scannedAfterOffset\":39,\"scannedThroughOffset\":41,"
      "\"streamMaxOffset\":41,\"state\":null}]]]");
  receive(&fixture, "[\"release\",1,1]");
  assert(fixture.voicelab.spk_frames_received == 1U);
  assert(spoken_length == 4U);
  assert(memcmp(spoken, "ABCD", 4U) == 0);
  assert(spoken_sequence == 0);
  assert(speech_started_count == 1);
  assert(fixture.voicelab.last_event_offset == 41);

  /* Assistant text streams as deltas and completes; the user's line arrives
   * whole on conversation.item.added. */
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",-1,[],[{\"events\":[["
      "{\"type\":\"voice-agent/grok-event\",\"offset\":43,"
      "\"payload\":{\"event\":{\"type\":\"response.created\"}}},"
      "{\"type\":\"voice-agent/grok-event\",\"offset\":44,"
      "\"payload\":{\"event\":{\"type\":"
      "\"response.output_audio_transcript.delta\",\"delta\":\"Hel\"}}}"
      "]],\"scannedThroughOffset\":44,\"state\":null}]]]");
  receive(&fixture, "[\"release\",2,1]");
  assert(strcmp(heard_assistant, "Hel") == 0);
  assert(!assistant_final);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",-1,[],[{\"events\":[["
      "{\"type\":\"voice-agent/grok-event\",\"offset\":45,"
      "\"payload\":{\"event\":{\"type\":"
      "\"response.output_audio_transcript.delta\",\"delta\":\"lo.\"}}},"
      "{\"type\":\"voice-agent/grok-event\",\"offset\":46,"
      "\"payload\":{\"event\":{\"type\":\"response.done\"}}}"
      "]],\"scannedThroughOffset\":46,\"state\":null}]]]");
  receive(&fixture, "[\"release\",3,1]");
  assert(strcmp(heard_assistant, "Hello.") == 0);
  assert(assistant_final);

  receive(
      &fixture,
      "[\"push\",[\"pipeline\",-1,[],[{\"events\":[["
      "{\"type\":\"voice-agent/grok-event\",\"offset\":47,"
      "\"payload\":{\"event\":{\"type\":\"conversation.item.added\","
      "\"item\":{\"id\":\"item_1\",\"role\":\"user\",\"content\":[[{\"type\":"
      "\"input_audio\",\"transcript\":\"what is the capital of France\"}]]}}}}"
      "]],\"scannedThroughOffset\":47,\"state\":null}]]]");
  receive(&fixture, "[\"release\",4,1]");
  assert(strcmp(heard_user, "what is the capital of France") == 0);
  assert(heard_user_count == 1);

  /* The SAME turn also arrives as a transcription.completed. One spoken turn
   * is one line on screen, however many events describe it. */
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",-1,[],[{\"events\":[["
      "{\"type\":\"voice-agent/grok-event\",\"offset\":48,"
      "\"payload\":{\"event\":{\"type\":"
      "\"conversation.item.input_audio_transcription.completed\","
      "\"item_id\":\"item_1\","
      "\"transcript\":\"what is the capital of France\"}}}"
      "]],\"scannedThroughOffset\":48,\"state\":null}]]]");
  receive(&fixture, "[\"release\",5,1]");
  assert(heard_user_count == 1);

  /* A genuinely new turn with the same words is still its own line. */
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",-1,[],[{\"events\":[["
      "{\"type\":\"voice-agent/grok-event\",\"offset\":49,"
      "\"payload\":{\"event\":{\"type\":"
      "\"conversation.item.input_audio_transcription.completed\","
      "\"item_id\":\"item_2\","
      "\"transcript\":\"what is the capital of France\"}}}"
      "]],\"scannedThroughOffset\":49,\"state\":null}]]]");
  receive(&fixture, "[\"release\",6,1]");
  assert(heard_user_count == 2);

  /* call-accepted on the stream is what makes a call live. */
  assert(!fixture.voicelab.call_active);
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",-1,[],[{\"events\":[["
      "{\"type\":\"voice-agent/call-accepted\",\"offset\":50,"
      "\"payload\":{\"callId\":\"wsdev\",\"bridge\":\"worker\"}}"
      "]],\"scannedThroughOffset\":50,\"state\":null}]]]");
  receive(&fixture, "[\"release\",7,1]");
  assert(fixture.voicelab.call_active);

  /*
   * The mouth track: a well-formed viseme reaches the callback with the
   * identity it carried; a shape with an out-of-range viseme id or a missing
   * position is dropped whole rather than clamped into a confidently wrong
   * mouth.
   */
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",-1,[],[{\"events\":[["
      "{\"type\":\"voice-agent/viseme\",\"offset\":51,"
      "\"payload\":{\"callId\":\"wsdev\",\"answer\":3,"
      "\"playoutSamples\":6400,\"viseme\":9,\"confidence\":204}},"
      "{\"type\":\"voice-agent/viseme\",\"offset\":52,"
      "\"payload\":{\"callId\":\"wsdev\",\"answer\":3,"
      "\"playoutSamples\":9600,\"viseme\":15,\"confidence\":204}},"
      "{\"type\":\"voice-agent/viseme\",\"offset\":53,"
      "\"payload\":{\"callId\":\"wsdev\",\"answer\":3,\"viseme\":2,"
      "\"confidence\":100}}"
      "]],\"scannedThroughOffset\":53,\"state\":null}]]]");
  receive(&fixture, "[\"release\",8,1]");
  assert(viseme_count == 1);
  assert(viseme_answer == 3U);
  assert(viseme_offset_samples == 6400U);
  assert(viseme_id == 9U);
  assert(viseme_confidence == 204U);

  /* Redelivery of the same offsets (recycle overlap) is deduped; every
   * invocation is push + release, and pending slots must recycle. */
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",-1,[],[{\"events\":[["
      "{\"type\":\"voice-agent/spk-frame\",\"offset\":40,"
      "\"payload\":{\"seq\":0,\"pcm\":\"QUJDRA\"}},"
      "{\"type\":\"voice-agent/grok-event\",\"offset\":42,"
      "\"payload\":{\"event\":{\"type\":\"response.done\"}}}"
      "]],\"scannedThroughOffset\":42,\"state\":null}]]]");
  receive(&fixture, "[\"release\",9,1]");
  assert(fixture.voicelab.spk_frames_received == 1U);
  assert(response_done_count == 1);
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

int main(void) {
  static struct fixture fixture;
  /* "ABCD" + 0x00 0x01: exercises multi-chunk + 2-byte-tail base64. */
  static const uint8_t pcm[6] = {0x41U, 0x42U, 0x43U, 0x44U, 0x00U, 0x01U};
  size_t before;

  fixture_init(&fixture);
  start_and_mount(&fixture);

  /* Frame appends are one-way: push + release, no pull, no import held. */
  before = fixture.captured_count;
  fixture.clock_ms = 1234U;
  assert(
      iterate_kit_voicelab_append_frame(
          &fixture.voicelab, pcm, sizeof(pcm), 7U, 1234U) == CAPNWEB_OK);
  assert(fixture.captured_count == before + 2U);
  assert(strcmp(
      fixture.captured[before],
      "[\"push\",[\"pipeline\",-12,[\"append\"],"
      "[{\"type\":\"voice-agent/mic-frame\",\"ephemeral\":true,"
      "\"payload\":{\"callId\":\"wsdev\",\"seq\":7,\"t\":1234,"
      "\"pcm\":\"QUJDRAAB\"}}]]]") == 0);
  assert(strstr(fixture.captured[before + 1U], "[\"release\",") != NULL);
  assert(fixture.voicelab.frames_sent == 1U);
  assert(fixture.voicelab.frame_send_failures == 0U);

  /* Ping is pulled; completion measures RTT with the injected clock. */
  before = fixture.captured_count;
  fixture.clock_ms = 2000U;
  assert(iterate_kit_voicelab_ping(&fixture.voicelab) == CAPNWEB_OK);
  assert(fixture.voicelab.ping_pending);
  assert(strstr(
      fixture.captured[before],
      "{\"type\":\"voice-agent/ping\",\"ephemeral\":true,"
      "\"payload\":{\"id\":\"wsdev-0\",\"t0\":2000}}") != NULL);
  /* Second probe while pending is refused. */
  assert(
      iterate_kit_voicelab_ping(&fixture.voicelab) == CAPNWEB_E_STATE);
  fixture.clock_ms = 2087U;
  receive(&fixture, "[\"resolve\",5,[[]]]");
  assert(!fixture.voicelab.ping_pending);
  assert(fixture.voicelab.ping_count == 1U);
  assert(fixture.voicelab.last_rtt_ms == 87U);

  /* A full 640-byte frame fits the args buffer and one outbox slot. */
  {
    static uint8_t full_frame[ITERATE_KIT_VOICELAB_FRAME_BYTES];
    size_t index;
    for (index = 0U; index < sizeof(full_frame); ++index) {
      full_frame[index] = (uint8_t)(index & 0xffU);
    }
    before = fixture.captured_count;
    assert(
        iterate_kit_voicelab_append_frame(
            &fixture.voicelab,
            full_frame,
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
    before = fixture.captured_count;
    assert(
        iterate_kit_voicelab_start_call(&fixture.voicelab, "Ready.") ==
        CAPNWEB_OK);
    assert(fixture.voicelab.call_pending);
    for (index = before; index < fixture.captured_count; ++index) {
      if (strstr(fixture.captured[index], "call-requested") != NULL) {
        start_message = fixture.captured[index];
      }
    }
    assert(start_message != NULL);
    assert(strstr(start_message, "[\"append\"]") != NULL);
    assert(strstr(start_message, "\"type\":\"voice-agent/call-requested\"") != NULL);
    assert(strstr(start_message, "\"callId\":\"wsdev\"") != NULL);
    assert(strstr(start_message, "\"colleague\":true") != NULL);
    assert(strstr(start_message, "\"turns\":\"manual\"") != NULL);
    assert(strstr(start_message, "\"greet\":\"Ready.\"") != NULL);
    /* One start in flight at a time. */
    assert(
        iterate_kit_voicelab_start_call(&fixture.voicelab, NULL) ==
        CAPNWEB_E_STATE);
    receive(&fixture, "[\"resolve\",7,[{\"ok\":true}]]");
    assert(!fixture.voicelab.call_pending);
    assert(fixture.voicelab.call_starts == 1U);
    /* The reply does not make the call live — the stream's call-accepted
     * does, because the reply can be slow or lost and a call opened by
     * anyone else counts just the same. */
    assert(!fixture.voicelab.call_active);

    before = fixture.captured_count;
    assert(
        iterate_kit_voicelab_end_call(&fixture.voicelab, "button") ==
        CAPNWEB_OK);
    assert(!fixture.voicelab.call_active);
    for (index = before; index < fixture.captured_count; ++index) {
      if (strstr(fixture.captured[index], "call-ended") != NULL) {
        end_message = fixture.captured[index];
      }
    }
    assert(end_message != NULL);
    assert(strstr(end_message, "\"callId\":\"wsdev\"") != NULL);
    assert(strstr(end_message, "\"reason\":\"button\"") != NULL);
    /* Durable: no ephemeral marker, or the bridge would still see it but
     * nothing would record that the call was hung up. */
    assert(strstr(end_message, "ephemeral") == NULL);
  }

  /* Raw diagnostics appends share the one-way lane. */
  {
    static const char stats[] =
        "[{\"type\":\"voice-agent/dev-stats\",\"ephemeral\":true,"
        "\"payload\":{\"heapFree\":123456}}]";
    assert(
        iterate_kit_voicelab_append_raw(
            &fixture.voicelab, stats, sizeof(stats) - 1U) == CAPNWEB_OK);
  }

  assert(iterate_kit_voicelab_close(&fixture.voicelab) == CAPNWEB_OK);
  assert(fixture.voicelab.state == ITERATE_KIT_VOICELAB_CLOSED);

  downlink_flow();

  printf("voicelab stream test passed\n");
  return 0;
}
