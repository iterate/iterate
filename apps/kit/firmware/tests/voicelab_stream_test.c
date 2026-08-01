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
  TOKEN_CAPACITY = 128,
  CALL_CAPACITY = 8,
  OUTPUT_CAPACITY = 64,
  CAPTURE_CAPACITY = 24,
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
  assert(
      capnweb_session_receive(
          &fixture->session, message, strlen(message)) ==
      CAPNWEB_OK);
}

static void start_and_mount(struct fixture *fixture) {
  const struct iterate_kit_voicelab_options options = {
    &fixture->session,
    "prj_test",
    "itxk_secret-never-log",
    "/voicelab/dev-test",
    "wsdev",
    fixture_now_ms,
    fixture,
    NULL,
    NULL,
    NULL,
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
      "[\"/voicelab/dev-test\"]]]") == 0);
  assert(strcmp(fixture->captured[8], "[\"pull\",3]") == 0);

  receive(fixture, "[\"resolve\",3,[\"export\",-12]]");
  assert(fixture->voicelab.state == ITERATE_KIT_VOICELAB_READY);
  assert(fixture->voicelab.has_stream_capability);
  assert(!fixture->voicelab.has_project_capability);
  assert(!fixture->voicelab.has_session_capability);
}

static uint8_t spoken[64];
static size_t spoken_length;
static int64_t spoken_sequence = -1;
static int speech_started_count;
static int response_done_count;

static void record_speaker(
    void *context, const uint8_t *pcm, size_t pcm_length, int64_t sequence) {
  (void)context;
  if (pcm_length <= sizeof(spoken)) {
    memcpy(spoken, pcm, pcm_length);
    spoken_length = pcm_length;
  }
  spoken_sequence = sequence;
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
      &fixture.session,
      "prj_test",
      "itxk_secret-never-log",
      "/voicelab/dev-test",
      "wsdev",
      fixture_now_ms,
      &fixture,
      record_speaker,
      record_control,
      NULL,
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
    assert(
        strstr(
            open_message,
            "\"eventTypes\":[[\"voicelab/spk-frame\",\"voicelab/grok-event\"]]") !=
        NULL);
    assert(strstr(open_message, "\"maxDeliveryEvents\":2") != NULL);
    assert(strstr(open_message, "\"maxDeliveryBytes\":2600") != NULL);
    assert(strstr(open_message, "\"state\":false") != NULL);
    assert(strstr(open_message, "\"processEventBatch\":[\"export\",-1]") != NULL);
  }
  receive(&fixture, "[\"resolve\",4,[\"export\",-13]]");
  assert(fixture.voicelab.state == ITERATE_KIT_VOICELAB_READY);
  assert(fixture.voicelab.has_connection_capability);

  /* The platform invokes the exported callback: push, result never pulled. */
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",-1,[],[{\"events\":[["
      "{\"type\":\"voicelab/spk-frame\",\"offset\":40,"
      "\"payload\":{\"seq\":0,\"pcm\":\"QUJDRA\"}},"
      "{\"type\":\"voicelab/grok-event\",\"offset\":41,"
      "\"payload\":{\"event\":{\"type\":\"input_audio_buffer.speech_started\"}}}"
      "]],\"scannedThroughOffset\":41,\"state\":null}]]]");
  assert(fixture.voicelab.spk_frames_received == 1U);
  assert(spoken_length == 4U);
  assert(memcmp(spoken, "ABCD", 4U) == 0);
  assert(spoken_sequence == 0);
  assert(speech_started_count == 1);
  assert(fixture.voicelab.last_event_offset == 41);

  /* Redelivery of the same offsets (recycle overlap) is deduped. */
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",-1,[],[{\"events\":[["
      "{\"type\":\"voicelab/spk-frame\",\"offset\":40,"
      "\"payload\":{\"seq\":0,\"pcm\":\"QUJDRA\"}},"
      "{\"type\":\"voicelab/grok-event\",\"offset\":42,"
      "\"payload\":{\"event\":{\"type\":\"response.done\"}}}"
      "]],\"scannedThroughOffset\":42,\"state\":null}]]]");
  assert(fixture.voicelab.spk_frames_received == 1U);
  assert(response_done_count == 1);

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
      "[{\"type\":\"voicelab/mic-frame\",\"ephemeral\":true,"
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
      "{\"type\":\"voicelab/ping\",\"ephemeral\":true,"
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

  /* Raw diagnostics appends share the one-way lane. */
  {
    static const char stats[] =
        "[{\"type\":\"voicelab/dev-stats\",\"ephemeral\":true,"
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
