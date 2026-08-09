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

static uint8_t spoken[64];
static size_t spoken_length;
static int64_t spoken_sequence = -1;
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
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",-1,[],[{\"projectId\":\"prj_test\","
      "\"path\":\"/voice-agent/dev-test\",\"streamId\":\"sid\",\"events\":[["
      "{\"type\":\"events.iterate.com/voice-agent/spk-frame\",\"offset\":40,"
      "\"payload\":{\"seq\":0,\"pcm\":\"QUJDRA\"}},"
      "{\"type\":\"events.iterate.com/voice-agent/spk-frame\",\"offset\":41,"
      "\"payload\":{\"seq\":1,\"answer\":1,\"frame\":0,\"drop\":true,"
      "\"pcm\":\"RUZHSA\"}}"
      "]],\"scannedAfterOffset\":39,\"scannedThroughOffset\":41,"
      "\"streamMaxOffset\":41,\"state\":null}]]]");
  receive(&fixture, "[\"release\",1,1]");
  assert(fixture.voicelab.spk_frames_received == 2U);
  assert(spoken_length == 4U);
  assert(memcmp(spoken, "EFGH", 4U) == 0);
  assert(spoken_answer == 1U);
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
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",-1,[],[{\"events\":[["
      "{\"type\":\"events.iterate.com/voice-agent/spk-frame\",\"offset\":43,"
      "\"payload\":{\"seq\":2,\"answer\":1,\"frame\":1,\"last\":true,"
      "\"pcm\":\"SUpLTA\"}}"
      "]],\"scannedThroughOffset\":43,\"state\":null}]]]");
  receive(&fixture, "[\"release\",2,1]");
  assert(response_done_count == 1);
  assert(memcmp(spoken, "IJKL", 4U) == 0);
  assert(order_length == 2U);
  assert(memcmp(order_log, "fl", 2U) == 0);

  /* conversation-accepted on the stream is what makes a call live. */
  assert(!fixture.voicelab.call_active);
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",-1,[],[{\"events\":[["
      "{\"type\":\"events.iterate.com/voice-agent/conversation-accepted\",\"offset\":50,"
      "\"payload\":{\"conversationId\":\"wsdev\",\"bridge\":\"worker\"}}"
      "]],\"scannedThroughOffset\":50,\"state\":null}]]]");
  receive(&fixture, "[\"release\",3,1]");
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
  receive(
      &fixture,
      "[\"push\",[\"pipeline\",-1,[],[{\"events\":[["
      "{\"type\":\"events.iterate.com/voice-agent/spk-frame\",\"offset\":40,"
      "\"payload\":{\"seq\":0,\"pcm\":\"QUJDRA\"}},"
      "{\"type\":\"events.iterate.com/voice-agent/spk-frame\",\"offset\":43,"
      "\"payload\":{\"seq\":2,\"answer\":1,\"frame\":1,\"last\":true,"
      "\"pcm\":\"SUpLTA\"}}"
      "]],\"scannedThroughOffset\":43,\"state\":null}]]]");
  receive(&fixture, "[\"release\",4,1]");
  assert(fixture.voicelab.spk_frames_received == 3U);
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
  assert(strstr(fixture.captured[before], "\"enc\":\"u\"") != NULL);
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

  printf("voicelab stream test passed\n");
  return 0;
}
