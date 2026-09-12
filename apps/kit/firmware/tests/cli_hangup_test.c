#include "cli_main_test.h"
#include "cli_runtime.h"

#include <assert.h>
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
};

static enum capnweb_status capture(
    void *context, enum capnweb_text_fragment_kind kind, const char *data, size_t length) {
  struct fixture *fixture = context;
  if (kind == CAPNWEB_TEXT_BEGIN) {
    if (fixture->open) return CAPNWEB_E_STATE;
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

static void mount_ready(struct cli_runtime *runtime, struct fixture *fixture, uint64_t *clock) {
  memset(fixture, 0, sizeof(*fixture));
  const struct capnweb_session_options session_options = {
    {dispatch, fixture, NULL}, capture, fixture,
    fixture->pending_calls, CALL_CAPACITY, fixture->exports, CALL_CAPACITY,
    fixture->imports, CALL_CAPACITY, fixture->tokens, TOKEN_CAPACITY,
    fixture->output, OUTPUT_CAPACITY,
  };
  assert(capnweb_session_init(&fixture->session, &session_options) == CAPNWEB_OK);
  const struct iterate_kit_voicelab_options options = {
    .session = &fixture->session, .project_id = "prj_test", .project_api_key = "secret",
    .stream_path = "/test", .activation = runtime->activation,
    .now_ms = now_ms, .clock_context = clock,
  };
  assert(iterate_kit_voicelab_start(&runtime->voicelab, &options) == CAPNWEB_OK);
  receive(fixture, "[\"resolve\",1,[\"export\",-10]]");
  receive(fixture, "[\"resolve\",2,[\"export\",-11]]");
  receive(fixture, "[\"resolve\",3,[\"export\",-12]]");
  assert(runtime->voicelab.state == ITERATE_KIT_VOICELAB_READY);
}

static bool captured_terminal(
    const struct fixture *fixture, const char *activation) {
  for (size_t i = 0U; i < fixture->captured_count; ++i) {
    if (strstr(fixture->captured[i], "conversation-ended") != NULL &&
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
  iterate_kit_cli_main_test_reconcile_call(&runtime, 3U);
  assert(fixture.captured_count > before);
  assert(captured_terminal(&fixture, ACTIVATION));
  assert(!runtime.stop_requested);

  const size_t after_first = fixture.captured_count;
  iterate_kit_cli_main_test_reconcile_call(&runtime, 3U);
  assert(fixture.captured_count == after_first);
  runtime.connection.generation = 8U;
  iterate_kit_cli_main_test_reconcile_call(&runtime, 3U);
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

int main(void) {
  remount_does_not_replace_the_bridge_acknowledgement();
  grace_deadline_stops_a_hung_terminal();
  return 0;
}
