// Copyright (c) 2026 Iterate
// Licensed under the MIT license found in the repository root.

#include "capnweb/capnweb.h"

#include <stdio.h>
#include <string.h>

enum {
  TOKEN_CAPACITY = 128,
  CALL_CAPACITY = 8,
  OUTPUT_CAPACITY = 13,
  MESSAGE_CAPACITY = 8192,
  CAPTURE_CAPACITY = 16,
  LARGE_BYTES_LENGTH = 4096,
};

struct fixture {
  struct capnweb_session session;
  struct capnweb_json_token tokens[TOKEN_CAPACITY];
  struct capnweb_pending_call pending_calls[CALL_CAPACITY];
  struct capnweb_export exports[CALL_CAPACITY];
  struct capnweb_import imports[CALL_CAPACITY];
  char output_buffer[OUTPUT_CAPACITY];
  char captured[CAPTURE_CAPACITY][MESSAGE_CAPACITY];
  size_t captured_lengths[CAPTURE_CAPACITY];
  size_t captured_count;
  size_t data_fragment_count;
  size_t fail_on_data_fragment;
  size_t dispose_count;
  size_t borrowed_release_count;
  struct capnweb_responder deferred_responder;
  enum capnweb_status reentrant_receive_status;
  bool numeric_path_seen;
  bool message_open;
  bool receive_during_send;
};

struct completion_capture {
  size_t call_count;
  enum capnweb_result_kind kind;
  enum capnweb_status status;
};

#define CHECK(condition) \
  do { \
    if (!(condition)) { \
      fprintf(stderr, "check failed at %s:%d: %s\n", \
          __FILE__, __LINE__, #condition); \
      return false; \
    } \
  } while (0)

static bool path_equals(
    const struct capnweb_call *call, const char *segment) {
  const char *const path[] = {segment};
  return capnweb_call_path_equals(call, path, 1U);
}

static bool is_numeric_path(const struct capnweb_call *call) {
  struct capnweb_value name;
  struct capnweb_value index;
  int64_t index_value;
  return capnweb_value_array_size(&call->path) == 2U &&
      capnweb_value_array_at(&call->path, 0U, &name) &&
      capnweb_value_string_equals(&name, "items") &&
      capnweb_value_array_at(&call->path, 1U, &index) &&
      capnweb_value_get_int64(&index, &index_value) &&
      index_value == 1;
}

static enum capnweb_status inert_dispatch(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  (void)context;
  (void)call;
  return capnweb_reply_set_int64(reply, 1);
}

static void count_dispose(void *context) {
  struct fixture *fixture = context;
  ++fixture->dispose_count;
}

static void count_borrowed_release(void *context) {
  struct fixture *fixture = context;
  ++fixture->borrowed_release_count;
}

static enum capnweb_status move_servos(
    const struct capnweb_call *call, struct capnweb_reply *reply) {
  static const char result[] = "{\"yaw\":12,\"pitch\":-3}";
  struct capnweb_value options;
  struct capnweb_value yaw;
  struct capnweb_value pitch;
  int64_t yaw_value;
  int64_t pitch_value;

  if (!call->has_arguments ||
      !capnweb_value_array_at(&call->arguments, 0U, &options) ||
      !capnweb_value_object_get(&options, "yaw", &yaw) ||
      !capnweb_value_object_get(&options, "pitch", &pitch) ||
      !capnweb_value_get_int64(&yaw, &yaw_value) ||
      !capnweb_value_get_int64(&pitch, &pitch_value) ||
      yaw_value != 12 ||
      pitch_value != -3) {
    return capnweb_reply_set_error(
        reply, "TypeError", "invalid servo arguments");
  }
  return capnweb_reply_set_borrowed_expression(
      reply, result, sizeof(result) - 1U, NULL, NULL);
}

static enum capnweb_status render_on_screen(
    const struct capnweb_call *call, struct capnweb_reply *reply) {
  static const char expected[] =
      "https://example.com/snowman-\342\230\203?q=\"quoted\"";
  struct capnweb_value options;
  struct capnweb_value url;
  char decoded[128];
  size_t decoded_length;

  if (!call->has_arguments ||
      !capnweb_value_array_at(&call->arguments, 0U, &options) ||
      !capnweb_value_object_get(&options, "url", &url) ||
      capnweb_value_copy_string(
          &url, decoded, sizeof(decoded), &decoded_length) != CAPNWEB_OK ||
      decoded_length != sizeof(expected) - 1U ||
      memcmp(decoded, expected, sizeof(expected) - 1U) != 0) {
    return capnweb_reply_set_error(
        reply, "TypeError", "invalid render URL");
  }
  return capnweb_reply_set_boolean(reply, true);
}

static enum capnweb_status fixture_dispatch(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  static const char *const servo_path[] = {"servos", "move"};
  static const uint8_t small_bytes[] = {0, 1, 2, 127, 128, 254, 255};
  static const uint8_t large_bytes[LARGE_BYTES_LENGTH] = {0};
  struct fixture *fixture = context;

  if (is_numeric_path(call)) {
    fixture->numeric_path_seen = true;
    return capnweb_reply_set_int64(reply, 7);
  }
  if (path_equals(call, "deferred")) {
    fixture->deferred_responder = call->responder;
    return capnweb_reply_defer(reply);
  }
  if (path_equals(call, "owned")) {
    return capnweb_reply_set_capability(
        reply,
        (struct capnweb_capability){
          inert_dispatch,
          fixture,
          count_dispose,
        });
  }
  if (path_equals(call, "bytes")) {
    return capnweb_reply_set_bytes(
        reply,
        small_bytes,
        sizeof(small_bytes),
        count_borrowed_release,
        fixture);
  }
  if (path_equals(call, "largeBytes")) {
    return capnweb_reply_set_bytes(
        reply,
        large_bytes,
        sizeof(large_bytes),
        count_borrowed_release,
        fixture);
  }
  if (path_equals(call, "reject")) {
    return capnweb_reply_set_error(
        reply, "RangeError", "application rejected the call");
  }
  if (capnweb_call_path_equals(call, servo_path, 2U)) {
    return move_servos(call, reply);
  }
  if (path_equals(call, "renderOnScreen")) {
    return render_on_screen(call, reply);
  }
  if (path_equals(call, "invalidReply")) {
    reply->kind = (enum capnweb_reply_kind)999;
    return CAPNWEB_OK;
  }
  return capnweb_reply_set_int64(reply, 1);
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
        data != NULL ||
        length != 0U ||
        fixture->captured_count >= CAPTURE_CAPACITY) {
      return CAPNWEB_E_STATE;
    }
    fixture->message_open = true;
    fixture->captured_lengths[fixture->captured_count] = 0U;
    if (fixture->receive_during_send) {
      static const char reentrant_message[] =
          "[\"push\",[\"pipeline\",0,[\"echo\"],[]]]";
      fixture->receive_during_send = false;
      fixture->reentrant_receive_status = capnweb_session_receive(
          &fixture->session,
          reentrant_message,
          sizeof(reentrant_message) - 1U);
    }
    return CAPNWEB_OK;
  }
  if (kind == CAPNWEB_TEXT_DATA) {
    if (!fixture->message_open || data == NULL || length == 0U) {
      return CAPNWEB_E_STATE;
    }
    if (fixture->data_fragment_count == fixture->fail_on_data_fragment) {
      return CAPNWEB_E_TRANSPORT;
    }
    ++fixture->data_fragment_count;
    captured_length = &fixture->captured_lengths[fixture->captured_count];
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
    if (!fixture->message_open || data != NULL || length != 0U) {
      return CAPNWEB_E_STATE;
    }
    captured_length = &fixture->captured_lengths[fixture->captured_count];
    fixture->captured[fixture->captured_count][*captured_length] = '\0';
    ++fixture->captured_count;
    fixture->message_open = false;
    return CAPNWEB_OK;
  }
  return CAPNWEB_E_INVALID_ARGUMENT;
}

static enum capnweb_status fixture_init(
    struct fixture *fixture,
    size_t token_count,
    size_t pending_call_count) {
  struct capnweb_session_options options;
  memset(fixture, 0, sizeof(*fixture));
  fixture->fail_on_data_fragment = SIZE_MAX;
  options = (struct capnweb_session_options){
    {fixture_dispatch, fixture, NULL},
    capture_fragment,
    fixture,
    fixture->pending_calls,
    pending_call_count,
    fixture->exports,
    CALL_CAPACITY,
    fixture->imports,
    CALL_CAPACITY,
    fixture->tokens,
    token_count,
    fixture->output_buffer,
    sizeof(fixture->output_buffer),
  };
  return capnweb_session_init(&fixture->session, &options);
}

static bool receive(
    struct fixture *fixture, const char *message) {
  return capnweb_session_receive(
      &fixture->session, message, strlen(message)) == CAPNWEB_OK;
}

static void capture_completion(
    void *context, const struct capnweb_result *result) {
  struct completion_capture *capture = context;
  ++capture->call_count;
  capture->kind = result->kind;
  capture->status = result->status;
}

static bool test_malformed_message_is_classified(void) {
  struct fixture fixture;
  CHECK(fixture_init(&fixture, TOKEN_CAPACITY, CALL_CAPACITY) == CAPNWEB_OK);
  CHECK(capnweb_session_receive(&fixture.session, "{", 1U) ==
      CAPNWEB_E_INVALID_MESSAGE);
  CHECK(fixture.captured_count == 1U);
  CHECK(strstr(
      fixture.captured[0], "CAPNWEB_E_INVALID_MESSAGE") != NULL);
  CHECK(capnweb_session_get_state(&fixture.session) ==
      CAPNWEB_SESSION_LOCAL_ABORTED);
  CHECK(capnweb_session_get_terminal_status(&fixture.session) ==
      CAPNWEB_E_INVALID_MESSAGE);
  return true;
}

static bool test_escaped_command_is_accepted(void) {
  struct fixture fixture;

  CHECK(fixture_init(&fixture, TOKEN_CAPACITY, CALL_CAPACITY) == CAPNWEB_OK);
  CHECK(receive(
      &fixture,
      "[\"\\u0070ush\",[\"pipeline\",0,[\"echo\"],[]]]"));
  CHECK(receive(&fixture, "[\"pull\",1]"));
  CHECK(strcmp(fixture.captured[0], "[\"resolve\",1,1]") == 0);
  return true;
}

static bool test_numeric_path_is_delivered_to_the_application(void) {
  struct fixture fixture;

  CHECK(fixture_init(&fixture, TOKEN_CAPACITY, CALL_CAPACITY) == CAPNWEB_OK);
  CHECK(receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"items\",1],[]]]"));
  CHECK(fixture.numeric_path_seen);
  CHECK(receive(&fixture, "[\"pull\",1]"));
  CHECK(strcmp(fixture.captured[0], "[\"resolve\",1,7]") == 0);
  return true;
}

static bool test_unsupported_stream_is_classified(void) {
  static const char message[] =
      "[\"stream\",[\"pipeline\",0,[\"echo\"],[]]]";
  struct fixture fixture;

  CHECK(fixture_init(&fixture, TOKEN_CAPACITY, CALL_CAPACITY) == CAPNWEB_OK);
  CHECK(capnweb_session_receive(
      &fixture.session, message, sizeof(message) - 1U) ==
      CAPNWEB_E_UNSUPPORTED);
  CHECK(fixture.captured_count == 1U);
  CHECK(strstr(
      fixture.captured[0], "CAPNWEB_E_UNSUPPORTED_STREAM") != NULL);
  CHECK(capnweb_session_get_terminal_status(&fixture.session) ==
      CAPNWEB_E_UNSUPPORTED);
  return true;
}

static bool test_unsupported_import_push_is_classified(void) {
  static const char message[] =
      "[\"push\",[\"import\",-1,[\"echo\"],[]]]";
  struct fixture fixture;

  CHECK(fixture_init(&fixture, TOKEN_CAPACITY, CALL_CAPACITY) == CAPNWEB_OK);
  CHECK(capnweb_session_receive(
      &fixture.session, message, sizeof(message) - 1U) ==
      CAPNWEB_E_UNSUPPORTED);
  CHECK(fixture.captured_count == 1U);
  CHECK(strstr(
      fixture.captured[0], "CAPNWEB_E_UNSUPPORTED_IMPORT") != NULL);
  CHECK(capnweb_session_get_terminal_status(&fixture.session) ==
      CAPNWEB_E_UNSUPPORTED);
  return true;
}

static bool test_unsupported_pipeline_target_is_rejected_per_call(void) {
  struct fixture fixture;

  CHECK(fixture_init(&fixture, TOKEN_CAPACITY, CALL_CAPACITY) == CAPNWEB_OK);
  CHECK(receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"deferred\"],[]]]"));
  CHECK(receive(
      &fixture,
      "[\"push\",[\"pipeline\",1,[\"ignored\"],[]]]"));
  CHECK(capnweb_session_get_state(&fixture.session) == CAPNWEB_SESSION_OPEN);
  CHECK(receive(&fixture, "[\"pull\",2]"));
  CHECK(strcmp(
      fixture.captured[0],
      "[\"reject\",2,[\"error\",\"Error\","
      "\"CAPNWEB_E_UNSUPPORTED_PIPELINE\"]]") == 0);
  CHECK(receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"echo\"],[]]]"));
  CHECK(receive(&fixture, "[\"pull\",3]"));
  CHECK(strcmp(fixture.captured[1], "[\"resolve\",3,1]") == 0);

  CHECK(fixture_init(&fixture, TOKEN_CAPACITY, CALL_CAPACITY) == CAPNWEB_OK);
  CHECK(receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"echo\"],[]]]"));
  CHECK(receive(
      &fixture,
      "[\"push\",[\"pipeline\",1,[\"ignored\"],[]]]"));
  CHECK(capnweb_session_get_state(&fixture.session) == CAPNWEB_SESSION_OPEN);
  CHECK(receive(&fixture, "[\"pull\",2]"));
  CHECK(strcmp(
      fixture.captured[0],
      "[\"reject\",2,[\"error\",\"Error\","
      "\"CAPNWEB_E_UNSUPPORTED_PIPELINE\"]]") == 0);
  return true;
}

static bool test_rejected_pipeline_target_propagates_original_error(void) {
  struct fixture fixture;

  CHECK(fixture_init(&fixture, TOKEN_CAPACITY, CALL_CAPACITY) == CAPNWEB_OK);
  CHECK(receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"reject\"],[]]]"));
  CHECK(receive(
      &fixture,
      "[\"push\",[\"pipeline\",1,[],[]]]"));
  CHECK(receive(&fixture, "[\"pull\",2]"));
  CHECK(strcmp(
      fixture.captured[0],
      "[\"reject\",2,[\"error\",\"RangeError\","
      "\"application rejected the call\"]]") == 0);
  CHECK(capnweb_session_get_state(&fixture.session) == CAPNWEB_SESSION_OPEN);
  return true;
}

static bool test_canceled_deferred_responder_is_classified(void) {
  struct fixture fixture;

  CHECK(fixture_init(&fixture, TOKEN_CAPACITY, CALL_CAPACITY) == CAPNWEB_OK);
  CHECK(receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"deferred\"],[]]]"));
  CHECK(receive(&fixture, "[\"release\",1,1]"));
  CHECK(capnweb_responder_set_int64(fixture.deferred_responder, 1) ==
      CAPNWEB_E_CANCELED);
  CHECK(capnweb_session_get_state(&fixture.session) == CAPNWEB_SESSION_OPEN);
  return true;
}

static bool test_deferred_capability_has_one_export_owner(void) {
  struct fixture fixture;

  CHECK(fixture_init(&fixture, TOKEN_CAPACITY, CALL_CAPACITY) == CAPNWEB_OK);
  CHECK(receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"deferred\"],[]]]"));
  CHECK(receive(&fixture, "[\"pull\",1]"));
  CHECK(fixture.captured_count == 0U);
  CHECK(capnweb_responder_set_capability(
      fixture.deferred_responder,
      (struct capnweb_capability){
        inert_dispatch,
        &fixture,
        count_dispose,
      }) == CAPNWEB_OK);
  CHECK(fixture.captured_count == 1U);
  CHECK(strcmp(
      fixture.captured[0], "[\"resolve\",1,[\"export\",-1]]") == 0);
  CHECK(receive(&fixture, "[\"release\",-1,1]"));
  CHECK(fixture.dispose_count == 0U);
  CHECK(receive(&fixture, "[\"release\",1,1]"));
  CHECK(fixture.dispose_count == 1U);
  capnweb_session_close(&fixture.session);
  CHECK(fixture.dispose_count == 1U);
  return true;
}

static bool test_token_limit_is_classified(void) {
  static const char message[] =
      "[\"push\",[\"pipeline\",0,[\"echo\"],[1]]]";
  struct fixture fixture;
  CHECK(fixture_init(&fixture, 4U, CALL_CAPACITY) == CAPNWEB_OK);
  CHECK(capnweb_session_receive(
      &fixture.session, message, sizeof(message) - 1U) ==
      CAPNWEB_E_LIMIT);
  CHECK(fixture.captured_count == 1U);
  CHECK(strstr(fixture.captured[0], "CAPNWEB_E_TOKEN_LIMIT") != NULL);
  return true;
}

static bool test_pending_call_limit_is_classified(void) {
  static const char message[] =
      "[\"push\",[\"pipeline\",0,[\"echo\"],[1]]]";
  struct fixture fixture;
  CHECK(fixture_init(&fixture, TOKEN_CAPACITY, 1U) == CAPNWEB_OK);
  CHECK(receive(&fixture, message));
  CHECK(capnweb_session_receive(
      &fixture.session, message, sizeof(message) - 1U) ==
      CAPNWEB_E_LIMIT);
  CHECK(fixture.captured_count == 1U);
  CHECK(strstr(
      fixture.captured[0], "CAPNWEB_E_PENDING_CALL_LIMIT") != NULL);
  return true;
}

static bool test_capability_lives_until_both_references_are_released(void) {
  struct fixture fixture;

  CHECK(fixture_init(&fixture, TOKEN_CAPACITY, CALL_CAPACITY) == CAPNWEB_OK);
  CHECK(receive(
      &fixture, "[\"push\",[\"pipeline\",0,[\"owned\"],[]]]"));
  CHECK(receive(&fixture, "[\"pull\",1]"));
  CHECK(strcmp(
      fixture.captured[0], "[\"resolve\",1,[\"export\",-1]]") == 0);
  CHECK(receive(&fixture, "[\"release\",-1,1]"));
  CHECK(fixture.dispose_count == 0U);
  CHECK(receive(&fixture, "[\"release\",1,1]"));
  CHECK(fixture.dispose_count == 1U);
  capnweb_session_close(&fixture.session);
  CHECK(fixture.dispose_count == 1U);
  return true;
}

static bool test_bytes_are_released_after_fragmented_send(void) {
  struct fixture fixture;

  CHECK(fixture_init(&fixture, TOKEN_CAPACITY, CALL_CAPACITY) == CAPNWEB_OK);
  CHECK(receive(
      &fixture, "[\"push\",[\"pipeline\",0,[\"bytes\"],[]]]"));
  CHECK(fixture.borrowed_release_count == 0U);
  CHECK(receive(&fixture, "[\"pull\",1]"));
  CHECK(strcmp(
      fixture.captured[0],
      "[\"resolve\",1,[\"bytes\",\"AAECf4D+/w\"]]") == 0);
  CHECK(fixture.data_fragment_count > 1U);
  CHECK(fixture.borrowed_release_count == 1U);
  return true;
}

static bool test_large_bytes_do_not_require_a_large_output_buffer(void) {
  static const char prefix[] = "[\"resolve\",1,[\"bytes\",\"";
  static const char suffix[] = "\"]]";
  const size_t encoded_length = (LARGE_BYTES_LENGTH / 3U) * 4U + 2U;
  struct fixture fixture;
  size_t index;

  CHECK(fixture_init(&fixture, TOKEN_CAPACITY, CALL_CAPACITY) == CAPNWEB_OK);
  CHECK(receive(
      &fixture, "[\"push\",[\"pipeline\",0,[\"largeBytes\"],[]]]"));
  CHECK(receive(&fixture, "[\"pull\",1]"));
  CHECK(fixture.captured_count == 1U);
  CHECK(fixture.captured_lengths[0] ==
      sizeof(prefix) - 1U + encoded_length + sizeof(suffix) - 1U);
  CHECK(memcmp(fixture.captured[0], prefix, sizeof(prefix) - 1U) == 0);
  for (index = 0U; index < encoded_length; ++index) {
    CHECK(fixture.captured[0][sizeof(prefix) - 1U + index] == 'A');
  }
  CHECK(memcmp(
      fixture.captured[0] + sizeof(prefix) - 1U + encoded_length,
      suffix,
      sizeof(suffix) - 1U) == 0);
  CHECK(fixture.data_fragment_count > 100U);
  CHECK(fixture.borrowed_release_count == 1U);
  return true;
}

static bool test_nested_paths_and_structured_values(void) {
  struct fixture fixture;

  CHECK(fixture_init(&fixture, TOKEN_CAPACITY, CALL_CAPACITY) == CAPNWEB_OK);
  CHECK(receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"servos\",\"move\"],"
      "[{\"yaw\":12,\"pitch\":-3}]]]"));
  CHECK(receive(&fixture, "[\"pull\",1]"));
  CHECK(strcmp(
      fixture.captured[0],
      "[\"resolve\",1,{\"yaw\":12,\"pitch\":-3}]") == 0);
  CHECK(receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"renderOnScreen\"],"
      "[{\"url\":\"https://example.com/snowman-\\u2603?q=\\\"quoted\\\"\"}]]]"));
  CHECK(receive(&fixture, "[\"pull\",2]"));
  CHECK(strcmp(fixture.captured[1], "[\"resolve\",2,true]") == 0);
  return true;
}

static bool test_transport_failure_is_terminal_and_releases_payload(void) {
  struct fixture fixture;

  CHECK(fixture_init(&fixture, TOKEN_CAPACITY, CALL_CAPACITY) == CAPNWEB_OK);
  CHECK(receive(
      &fixture, "[\"push\",[\"pipeline\",0,[\"largeBytes\"],[]]]"));
  fixture.fail_on_data_fragment = fixture.data_fragment_count;
  CHECK(capnweb_session_receive(
      &fixture.session, "[\"pull\",1]", strlen("[\"pull\",1]")) ==
      CAPNWEB_E_TRANSPORT);
  CHECK(fixture.borrowed_release_count == 1U);
  CHECK(capnweb_session_get_state(&fixture.session) ==
      CAPNWEB_SESSION_TRANSPORT_FAILED);
  CHECK(capnweb_session_receive(&fixture.session, "[]", 2U) ==
      CAPNWEB_E_TRANSPORT);
  return true;
}

static bool test_close_completes_outstanding_calls(void) {
  static const char arguments[] = "[]";
  const char *const path[] = {"tick"};
  struct fixture fixture;
  struct completion_capture capture = {0};

  CHECK(fixture_init(&fixture, TOKEN_CAPACITY, CALL_CAPACITY) == CAPNWEB_OK);
  CHECK(capnweb_session_call_path(
      &fixture.session,
      (struct capnweb_remote_capability){-1},
      path,
      1U,
      arguments,
      sizeof(arguments) - 1U,
      capture_completion,
      &capture) == CAPNWEB_OK);
  CHECK(capture.call_count == 0U);
  capnweb_session_close(&fixture.session);
  CHECK(capture.call_count == 1U);
  CHECK(capture.kind == CAPNWEB_RESULT_SESSION_ENDED);
  CHECK(capture.status == CAPNWEB_E_CLOSED);
  return true;
}

static bool test_outbound_expression_can_embed_a_local_capability(void) {
  struct fixture fixture;
  struct completion_capture capture = {0};
  struct capnweb_local_capability local_capability;
  const char *const method_path[] = {"provideCapability"};
  const struct capnweb_expression mount_path_items[] = {
    {
      CAPNWEB_EXPRESSION_STRING,
      {.string = {"kit", 3U}},
    },
    {
      CAPNWEB_EXPRESSION_STRING,
      {.string = {"stackchan", 9U}},
    },
  };
  const struct capnweb_expression mount_path = {
    CAPNWEB_EXPRESSION_ARRAY,
    {.array = {mount_path_items, 2U}},
  };
  const struct capnweb_expression type = {
    CAPNWEB_EXPRESSION_STRING,
    {.string = {"live", 4U}},
  };
  struct capnweb_expression capability_expression;
  const struct capnweb_expression flatten_nested_paths = {
    CAPNWEB_EXPRESSION_BOOLEAN,
    {.boolean = false},
  };
  struct capnweb_object_field fields[4];
  struct capnweb_expression argument;

  CHECK(fixture_init(&fixture, TOKEN_CAPACITY, CALL_CAPACITY) == CAPNWEB_OK);
  CHECK(capnweb_session_export_capability(
      &fixture.session,
      (struct capnweb_capability){
        inert_dispatch,
        &fixture,
        count_dispose,
      },
      &local_capability) == CAPNWEB_OK);
  capability_expression = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_CAPABILITY,
    {.capability = local_capability},
  };
  fields[0] = (struct capnweb_object_field){
    {"type", 4U},
    &type,
  };
  fields[1] = (struct capnweb_object_field){
    {"path", 4U},
    &mount_path,
  };
  fields[2] = (struct capnweb_object_field){
    {"capability", 10U},
    &capability_expression,
  };
  fields[3] = (struct capnweb_object_field){
    {"flattenNestedPaths", 18U},
    &flatten_nested_paths,
  };
  argument = (struct capnweb_expression){
    CAPNWEB_EXPRESSION_OBJECT,
    {.object = {fields, 4U}},
  };

  CHECK(capnweb_session_call_expressions(
      &fixture.session,
      (struct capnweb_remote_capability){-7},
      method_path,
      1U,
      &argument,
      1U,
      capture_completion,
      &capture) == CAPNWEB_OK);
  CHECK(fixture.captured_count == 2U);
  CHECK(strcmp(
      fixture.captured[0],
      "[\"push\",[\"pipeline\",-7,[\"provideCapability\"],"
      "[{\"type\":\"live\",\"path\":[[\"kit\",\"stackchan\"]],"
      "\"capability\":[\"export\",-1],"
      "\"flattenNestedPaths\":false}]]]") == 0);
  CHECK(strcmp(fixture.captured[1], "[\"pull\",1]") == 0);
  CHECK(capnweb_session_release_local_capability(
      &fixture.session, local_capability) == CAPNWEB_OK);
  CHECK(fixture.dispose_count == 0U);
  CHECK(receive(&fixture, "[\"release\",-1,1]"));
  CHECK(fixture.dispose_count == 1U);
  capnweb_session_close(&fixture.session);
  CHECK(capture.call_count == 1U);
  CHECK(capture.kind == CAPNWEB_RESULT_SESSION_ENDED);
  return true;
}

static bool test_transport_cannot_reenter_receive_while_sending(void) {
  static const char arguments[] = "[]";
  struct fixture fixture;
  struct completion_capture capture = {0};

  CHECK(fixture_init(&fixture, TOKEN_CAPACITY, CALL_CAPACITY) == CAPNWEB_OK);
  fixture.receive_during_send = true;
  fixture.reentrant_receive_status = CAPNWEB_OK;
  CHECK(capnweb_session_call(
      &fixture.session,
      (struct capnweb_remote_capability){0},
      "echo",
      arguments,
      sizeof(arguments) - 1U,
      capture_completion,
      &capture) == CAPNWEB_OK);
  CHECK(fixture.reentrant_receive_status == CAPNWEB_E_STATE);
  CHECK(fixture.captured_count == 2U);
  capnweb_session_close(&fixture.session);
  return true;
}

static bool test_invalid_application_reply_is_rejected_before_sending(void) {
  struct fixture fixture;

  CHECK(fixture_init(&fixture, TOKEN_CAPACITY, CALL_CAPACITY) == CAPNWEB_OK);
  CHECK(receive(
      &fixture,
      "[\"push\",[\"pipeline\",0,[\"invalidReply\"],[]]]"));
  CHECK(receive(&fixture, "[\"pull\",1]"));
  CHECK(fixture.captured_count == 1U);
  CHECK(strcmp(
      fixture.captured[0],
      "[\"reject\",1,[\"error\",\"Error\",\"CAPNWEB_E_DISPATCH\"]]") == 0);
  CHECK(capnweb_session_get_state(&fixture.session) ==
      CAPNWEB_SESSION_OPEN);
  capnweb_session_close(&fixture.session);
  return true;
}

static bool test_unused_tables_can_have_zero_capacity(void) {
  struct fixture fixture;
  struct capnweb_session_options options;

  memset(&fixture, 0, sizeof(fixture));
  fixture.fail_on_data_fragment = SIZE_MAX;
  options = (struct capnweb_session_options){
    {fixture_dispatch, &fixture, NULL},
    capture_fragment,
    &fixture,
    fixture.pending_calls,
    1U,
    NULL,
    0U,
    NULL,
    0U,
    fixture.tokens,
    TOKEN_CAPACITY,
    fixture.output_buffer,
    sizeof(fixture.output_buffer),
  };
  CHECK(capnweb_session_init(&fixture.session, &options) == CAPNWEB_OK);
  CHECK(receive(
      &fixture, "[\"push\",[\"pipeline\",0,[\"echo\"],[]]]"));
  CHECK(receive(&fixture, "[\"pull\",1]"));
  CHECK(strcmp(fixture.captured[0], "[\"resolve\",1,1]") == 0);
  capnweb_session_close(&fixture.session);
  return true;
}

int main(void) {
  if (!test_malformed_message_is_classified() ||
      !test_escaped_command_is_accepted() ||
      !test_numeric_path_is_delivered_to_the_application() ||
      !test_unsupported_stream_is_classified() ||
      !test_unsupported_import_push_is_classified() ||
      !test_unsupported_pipeline_target_is_rejected_per_call() ||
      !test_rejected_pipeline_target_propagates_original_error() ||
      !test_canceled_deferred_responder_is_classified() ||
      !test_deferred_capability_has_one_export_owner() ||
      !test_token_limit_is_classified() ||
      !test_pending_call_limit_is_classified() ||
      !test_capability_lives_until_both_references_are_released() ||
      !test_bytes_are_released_after_fragmented_send() ||
      !test_large_bytes_do_not_require_a_large_output_buffer() ||
      !test_nested_paths_and_structured_values() ||
      !test_transport_failure_is_terminal_and_releases_payload() ||
      !test_close_completes_outstanding_calls() ||
      !test_outbound_expression_can_embed_a_local_capability() ||
      !test_transport_cannot_reenter_receive_while_sending() ||
      !test_invalid_application_reply_is_rejected_before_sending() ||
      !test_unused_tables_can_have_zero_capacity()) {
    return 1;
  }
  return 0;
}
