#include "cli_main_test.h"
#include "cli_runtime.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

enum { CALL_CAPACITY = 8, TOKEN_CAPACITY = 256, OUTPUT_CAPACITY = 64, MESSAGE_CAPACITY = 2048, CAPTURE_CAPACITY = 32 };
#define ACTIVATION "0123456789abcdef0123456789abcdef"

struct fixture {
  struct capnweb_session session;
  struct capnweb_pending_call pending_calls[CALL_CAPACITY];
  struct capnweb_export exports[CALL_CAPACITY];
  struct capnweb_import imports[CALL_CAPACITY];
  struct capnweb_json_token tokens[TOKEN_CAPACITY];
  char output[OUTPUT_CAPACITY];
  char captured[CAPTURE_CAPACITY][MESSAGE_CAPACITY];
  size_t captured_length;
  size_t captured_count;
  bool open;
  bool fail_next_append;
};

static enum capnweb_status capture(
    void *context, enum capnweb_text_fragment_kind kind, const char *data, size_t length) {
  struct fixture *fixture = context;
  if (kind == CAPNWEB_TEXT_BEGIN) {
    if (fixture->open) return CAPNWEB_E_STATE;
    if (fixture->fail_next_append) {
      fixture->fail_next_append = false;
      return CAPNWEB_E_STATE;
    }
    fixture->open = true;
    if (fixture->captured_count == CAPTURE_CAPACITY) return CAPNWEB_E_LIMIT;
    fixture->captured_length = 0U;
    return CAPNWEB_OK;
  }
  if (kind == CAPNWEB_TEXT_DATA) {
    if (!fixture->open || fixture->captured_length + length >= sizeof(fixture->captured[0])) {
      return CAPNWEB_E_LIMIT;
    }
    memcpy(fixture->captured[fixture->captured_count] + fixture->captured_length, data, length);
    fixture->captured_length += length;
    return CAPNWEB_OK;
  }
  if (kind == CAPNWEB_TEXT_END) {
    if (!fixture->open) return CAPNWEB_E_STATE;
    fixture->captured[fixture->captured_count][fixture->captured_length] = '\0';
    ++fixture->captured_count;
    fixture->open = false;
    return CAPNWEB_OK;
  }
  return CAPNWEB_E_INVALID_ARGUMENT;
}

static enum capnweb_status dispatch(
    void *context, const struct capnweb_call *call, struct capnweb_reply *reply) {
  (void)context;
  (void)call;
  return capnweb_reply_set_null(reply);
}

static uint64_t now_ms(void *context) { return *(uint64_t *)context; }

static void receive(struct fixture *fixture, const char *message) {
  assert(capnweb_session_receive(&fixture->session, message, strlen(message)) == CAPNWEB_OK);
}

/* The stream invokes these mounted callbacks; tests never call the CLI fences
 * directly when asserting a delayed wire delivery. */
static void deliver_speaker(void *context, const uint8_t *pcm, size_t length) {
  iterate_kit_cli_main_test_on_speaker(context, pcm, length);
}

static void deliver_control(
    void *context, enum iterate_kit_voicelab_control control) {
  iterate_kit_cli_main_test_on_control(context, control);
}

static void mount_ready(struct cli_runtime *runtime, struct fixture *fixture, uint64_t *clock) {
  if (runtime->voice_stream.session != NULL) {
    (void)capnweb_session_close(runtime->voice_stream.session);
    iterate_kit_stream_session_ended(&runtime->voice_stream);
    iterate_kit_stream_subscription_session_ended(&runtime->voice_subscription);
    iterate_kit_stream_subscription_session_ended(&runtime->recycled_voice_subscription);
    (void)iterate_kit_voicelab_close(&runtime->voicelab);
  }
  memset(fixture, 0, sizeof(*fixture));
  const struct capnweb_session_options session_options = {
    {dispatch, fixture, NULL}, capture, fixture,
    fixture->pending_calls, CALL_CAPACITY, fixture->exports, CALL_CAPACITY,
    fixture->imports, CALL_CAPACITY, fixture->tokens, TOKEN_CAPACITY,
    fixture->output, OUTPUT_CAPACITY,
  };
  assert(capnweb_session_init(&fixture->session, &session_options) == CAPNWEB_OK);
  const struct iterate_kit_voicelab_options options = {
    .stream_path = "/test", .activation = runtime->activation,
    .now_ms = now_ms, .clock_context = clock,
    .on_speaker = deliver_speaker, .on_control = deliver_control,
    .downlink_context = runtime,
  };
  assert(iterate_kit_stream_get(&runtime->voice_stream, &fixture->session,
      (struct capnweb_remote_capability){-10}, "/test") == CAPNWEB_OK);
  receive(fixture, "[\"resolve\",1,[\"export\",-12]]");
  assert(iterate_kit_voicelab_bind(&runtime->voicelab, &options,
      &runtime->voice_stream, &runtime->voice_subscription) == CAPNWEB_OK);
  receive(fixture, "[\"resolve\",2,[\"export\",-13]]");
  iterate_kit_voicelab_update(&runtime->voicelab);
  assert(runtime->voicelab.state == ITERATE_KIT_VOICELAB_READY);
}

static bool captured_terminal(
    const struct fixture *fixture, const char *activation) {
  for (size_t i = 0U; i < fixture->captured_count; ++i) {
    if (strstr(fixture->captured[i],
            "\"type\":\"events.iterate.com/voice-agent/conversation-ended\"") != NULL &&
        strstr(fixture->captured[i], activation) != NULL) return true;
  }
  return false;
}

static void remount_does_not_replace_the_bridge_acknowledgement(void) {
  struct cli_runtime runtime;
  struct fixture fixture;
  uint64_t clock = 500U;
  memset(&runtime, 0, sizeof(runtime));
  memcpy(runtime.activation, ACTIVATION, sizeof(ACTIVATION));
  runtime.hanging_up = true;
  runtime.activation_active = true;
  runtime.hangup_deadline_ms = 0U; /* capability hang-up supplies no clock */
  mount_ready(&runtime, &fixture, &clock);
  runtime.connection.generation = 7U;
  runtime.voicelab_generation = 7U;
  runtime.voicelab.call_active = false; /* a remount erased this volatile fact */

  iterate_kit_cli_main_test_poll_hangup(&runtime, clock);
  assert(runtime.hangup_deadline_ms == 3500U);
  const size_t before = fixture.captured_count;
  fixture.fail_next_append = true;
  iterate_kit_cli_main_test_reconcile_call(&runtime, clock, 3U);
  assert(fixture.captured_count == before);
  assert(!runtime.hangup_terminal_sent);
  assert(runtime.hangup_terminal_retry_at_ms == 750U);
  /* A failed writer remounts before the paced retry uses a fresh session. */
  mount_ready(&runtime, &fixture, &clock);
  iterate_kit_cli_main_test_reconcile_call(&runtime, clock + 249U, 3U);
  assert(!captured_terminal(&fixture, ACTIVATION));
  iterate_kit_cli_main_test_reconcile_call(&runtime, clock + 250U, 3U);
  assert(fixture.captured_count > before);
  assert(captured_terminal(&fixture, ACTIVATION));
  assert(runtime.hangup_terminal_sent);
  assert(!runtime.stop_requested);

  const size_t after_first = fixture.captured_count;
  iterate_kit_cli_main_test_reconcile_call(&runtime, clock + 250U, 3U);
  assert(fixture.captured_count == after_first);
  runtime.connection.generation = 8U;
  iterate_kit_cli_main_test_reconcile_call(&runtime, clock + 250U, 3U);
  assert(fixture.captured_count > after_first);
  assert(captured_terminal(&fixture, ACTIVATION));

  iterate_kit_cli_main_test_on_control(
      &runtime, ITERATE_KIT_VOICELAB_CONTROL_CALL_ENDED);
  assert(runtime.calls_lost == 0U);
  iterate_kit_cli_main_test_poll_hangup(&runtime, clock + 1U);
  assert(runtime.stop_requested);
}

static void grace_deadline_stops_a_hung_terminal(void) {
  struct cli_runtime runtime;
  memset(&runtime, 0, sizeof(runtime));
  runtime.hanging_up = true;
  runtime.activation_active = true;
  runtime.hangup_deadline_ms = 1000U;
  iterate_kit_cli_main_test_poll_hangup(&runtime, 1000U);
  assert(runtime.stop_requested);
}

static void local_hangup_fences_late_acceptance_and_audio(void) {
  struct cli_runtime runtime;
  struct fixture fixture;
  uint64_t clock = 500U;
  const uint8_t queued_pcm[] = {1U, 2U, 3U, 4U};
  char delayed_delivery[MESSAGE_CAPACITY];
  struct capnweb_reply reply = {0};
  memset(&runtime, 0, sizeof(runtime));
  memcpy(runtime.activation, ACTIVATION, sizeof(ACTIVATION));
  runtime.activation_active = true;
  runtime.opening_pending = true;
  assert(cli_device_controls_init(&runtime.device_controls, &runtime) == ITERATE_KIT_OK);
  mount_ready(&runtime, &fixture, &clock);
  runtime.connection.generation = 7U;
  runtime.voicelab_generation = 7U;
  /* The stream still owns this observed call until the terminal is acknowledged. */
  runtime.voicelab.call_active = true;
  assert(runtime.voicelab.call_active);
  assert(cli_speaker_write(&runtime.speaker, queued_pcm, sizeof(queued_pcm)) == CLI_SPEAKER_OK);

  const struct iterate_kit_module module =
      cli_capabilities_module(&runtime.capabilities, &runtime);
  assert(module.method_count > 1U);
  assert(module.methods[1].dispatch(module.context, NULL, &reply) == CAPNWEB_OK);
  assert(reply.kind == CAPNWEB_REPLY_BOOLEAN);
  assert(runtime.hanging_up);
  assert(runtime.activation_active);
  assert(runtime.hangup_deadline_ms == 0U);
  assert(!runtime.opening_pending);
  assert(runtime.speaker.used == 0U);

  /* A remote endpoint has no local clock; the polling owner starts its grace. */
  iterate_kit_cli_main_test_poll_hangup(&runtime, clock);
  assert(runtime.hangup_deadline_ms == 3500U);

  /* Deliver an actual callback batch after the local end. The core may still
   * report its server-side call live, but the CLI must not reopen or queue it. */
  (void)snprintf(
      delayed_delivery, sizeof(delayed_delivery),
      "[\"push\",[\"pipeline\",-1,[],[[["
      "{\"type\":\"events.iterate.com/voice-agent/conversation-accepted\","
      "\"offset\":39,\"payload\":{\"activation\":\"" ACTIVATION "\",\"conversationId\":\"wsdev\"}},"
      "{\"type\":\"events.iterate.com/voice-agent/spk-frame\",\"offset\":40,"
      "\"payload\":{\"activation\":\"" ACTIVATION "\",\"pcm\":\"AQIDBA==\"}}"
      "]],{\"after\":39,\"through\":40}]]]" );
  receive(&fixture, delayed_delivery);
  receive(&fixture, "[\"release\",1,1]");
  assert(runtime.hanging_up);
  assert(runtime.voicelab.call_active);
  assert(runtime.voicelab.spk_frames_received == 1U);
  assert(!runtime.opening_pending);
  assert(runtime.speaker.used == 0U);

  /* The retained activation still sends and receives the terminal acknowledgement. */
  iterate_kit_cli_main_test_reconcile_call(&runtime, clock, 3U);
  assert(captured_terminal(&fixture, ACTIVATION));
  iterate_kit_cli_main_test_on_control(
      &runtime, ITERATE_KIT_VOICELAB_CONTROL_CALL_ENDED);
  assert(runtime.calls_lost == 0U);
  assert(!runtime.activation_active);
  iterate_kit_cli_main_test_poll_hangup(&runtime, clock + 1U);
  assert(runtime.stop_requested);
}
/* Both asynchronous startup failures terminate the CLI instead of polling
 * forever or returning a successful process status. */
static void rejected_startup_stops_once(bool reject_subscription) {
  struct cli_runtime runtime = {0};
  struct fixture fixture = {0};
  const struct capnweb_session_options session_options = {
    {dispatch, &fixture, NULL}, capture, &fixture,
    fixture.pending_calls, CALL_CAPACITY, fixture.exports, CALL_CAPACITY,
    fixture.imports, CALL_CAPACITY, fixture.tokens, TOKEN_CAPACITY,
    fixture.output, OUTPUT_CAPACITY,
  };
  assert(capnweb_session_init(&runtime.connection.session, &session_options) == CAPNWEB_OK);
  runtime.transport.state = ITERATE_KIT_POSIX_ITX_READY;
  runtime.connection.state = ITERATE_KIT_ITX_CONNECTION_READY;
  runtime.connection.generation = 1U;
  runtime.connection.mount.project_capability.id = -10;
  runtime.options.stream_path = "/test";
  memcpy(runtime.activation, ACTIVATION, sizeof(ACTIVATION));
  iterate_kit_cli_main_test_start_voicelab(&runtime);
  assert(runtime.voice_stream.state == ITERATE_KIT_STREAM_GETTING);
  if (reject_subscription) {
    const char *resolved = "[\"resolve\",1,[\"export\",-12]]";
    assert(capnweb_session_receive(&runtime.connection.session, resolved, strlen(resolved)) == CAPNWEB_OK);
    iterate_kit_cli_main_test_start_voicelab(&runtime);
    assert(runtime.voicelab.state == ITERATE_KIT_VOICELAB_OPENING_CONNECTION);
  }
  const char *rejected = reject_subscription
      ? "[\"reject\",2,[\"error\",\"Error\",\"subscription denied\"]]"
      : "[\"reject\",1,[\"error\",\"Error\",\"stream denied\"]]";
  assert(capnweb_session_receive(&runtime.connection.session, rejected, strlen(rejected)) == CAPNWEB_OK);
  iterate_kit_cli_main_test_start_voicelab(&runtime);
  assert(runtime.startup_failed);
  assert(runtime.stop_requested);
  const size_t sent = fixture.captured_count;
  iterate_kit_cli_main_test_start_voicelab(&runtime);
  assert(fixture.captured_count == sent);
  capnweb_session_close(&runtime.connection.session);
}

int main(void) {
  remount_does_not_replace_the_bridge_acknowledgement();
  grace_deadline_stops_a_hung_terminal();
  local_hangup_fences_late_acceptance_and_audio();
  rejected_startup_stops_once(false);
  rejected_startup_stops_once(true);
  return 0;
}
