// Copyright (c) 2026 Iterate
// Licensed under the MIT license found in the repository root.

#include "capnweb/capnweb.h"

#include <inttypes.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>

enum {
  MESSAGE_CAPACITY = 65536,
  OUTPUT_SCRATCH_CAPACITY = 128,
  TOKEN_CAPACITY = 256,
  PENDING_CALL_CAPACITY = 16,
  EXPORT_CAPACITY = 16,
  IMPORT_CAPACITY = 16,
  COUNTER_CAPACITY = 8,
  CALLBACK_CAPACITY = 8,
  EXPRESSION_CAPACITY = 16,
  EXPRESSION_BYTES = 1024,
  LARGE_BYTE_CAPACITY = 131072,
};

struct counter {
  int64_t value;
  bool occupied;
};

struct peer;

struct callback_operation {
  struct peer *peer;
  struct capnweb_responder responder;
  struct capnweb_remote_capability capability;
  char expression[64];
  bool wrap_result;
  bool expression_borrowed;
  bool callback_complete;
  bool occupied;
};

struct expression_slot {
  char bytes[EXPRESSION_BYTES];
  bool occupied;
};

struct peer {
  struct capnweb_session *session;
  struct callback_operation callbacks[CALLBACK_CAPACITY];
  struct expression_slot expressions[EXPRESSION_CAPACITY];
  enum capnweb_status asynchronous_failure;
};

struct stdio_transport {
  bool message_open;
};

enum input_status {
  INPUT_MESSAGE = 0,
  INPUT_END,
  INPUT_LIMIT,
  INPUT_ERROR,
};

static struct counter counters[COUNTER_CAPACITY];
static uint8_t large_bytes[LARGE_BYTE_CAPACITY];

static const char *status_name(enum capnweb_status status) {
  switch (status) {
    case CAPNWEB_OK:
      return "CAPNWEB_OK";
    case CAPNWEB_E_INVALID_ARGUMENT:
      return "CAPNWEB_E_INVALID_ARGUMENT";
    case CAPNWEB_E_INVALID_MESSAGE:
      return "CAPNWEB_E_INVALID_MESSAGE";
    case CAPNWEB_E_LIMIT:
      return "CAPNWEB_E_LIMIT";
    case CAPNWEB_E_TRANSPORT:
      return "CAPNWEB_E_TRANSPORT";
    case CAPNWEB_E_REMOTE_ABORT:
      return "CAPNWEB_E_REMOTE_ABORT";
    case CAPNWEB_E_CLOSED:
      return "CAPNWEB_E_CLOSED";
    case CAPNWEB_E_UNSUPPORTED:
      return "CAPNWEB_E_UNSUPPORTED";
    case CAPNWEB_E_STATE:
      return "CAPNWEB_E_STATE";
    case CAPNWEB_E_CANCELED:
      return "CAPNWEB_E_CANCELED";
    default:
      return "CAPNWEB_E_UNKNOWN";
  }
}

static enum capnweb_status counter_dispatch(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply);

static void dispose_counter(void *context) {
  struct counter *counter = context;
  memset(counter, 0, sizeof(*counter));
}

static bool path_equals(
    const struct capnweb_call *call, const char *segment) {
  const char *segments[] = {segment};
  return capnweb_call_path_equals(call, segments, 1U);
}

static struct expression_slot *allocate_expression(
    struct peer *peer) {
  size_t index;
  for (index = 0U; index < EXPRESSION_CAPACITY; ++index) {
    if (!peer->expressions[index].occupied) {
      peer->expressions[index].occupied = true;
      return &peer->expressions[index];
    }
  }
  return NULL;
}

static void release_expression(void *context) {
  struct expression_slot *slot = context;
  memset(slot, 0, sizeof(*slot));
}

static enum capnweb_status publish_expression(
    struct capnweb_reply *reply,
    struct expression_slot *slot,
    size_t length) {
  enum capnweb_status status =
      capnweb_reply_set_borrowed_expression(
          reply,
          slot->bytes,
          length,
          release_expression,
          slot);
  if (status != CAPNWEB_OK) {
    release_expression(slot);
  }
  return status;
}

static enum capnweb_status write_fibonacci(
    struct peer *peer,
    struct capnweb_reply *reply,
    int64_t length) {
  int64_t values[64] = {0, 1};
  struct expression_slot *slot;
  size_t position = 0U;
  int64_t index;

  if (length < 0 ||
      length > (int64_t)(sizeof(values) / sizeof(values[0]))) {
    return capnweb_reply_set_error(
        reply, "RangeError", "invalid Fibonacci length");
  }
  slot = allocate_expression(peer);
  if (slot == NULL) {
    return capnweb_reply_set_error(
        reply, "Error", "expression limit reached");
  }
  for (index = 2; index < length; ++index) {
    values[index] = values[index - 1] + values[index - 2];
  }

  slot->bytes[position++] = '[';
  slot->bytes[position++] = '[';
  for (index = 0; index < length; ++index) {
    int written;
    if (index > 0) {
      slot->bytes[position++] = ',';
    }
    written = snprintf(
        slot->bytes + position,
        sizeof(slot->bytes) - position,
        "%" PRId64,
        values[index]);
    if (written < 0 ||
        (size_t)written >= sizeof(slot->bytes) - position) {
      release_expression(slot);
      return CAPNWEB_E_LIMIT;
    }
    position += (size_t)written;
  }
  slot->bytes[position++] = ']';
  slot->bytes[position++] = ']';
  return publish_expression(reply, slot, position);
}

static enum capnweb_status write_servo_position(
    struct peer *peer,
    struct capnweb_reply *reply,
    int64_t yaw,
    int64_t pitch) {
  struct expression_slot *slot = allocate_expression(peer);
  int written;
  if (slot == NULL) {
    return capnweb_reply_set_error(
        reply, "Error", "expression limit reached");
  }
  written = snprintf(
      slot->bytes,
      sizeof(slot->bytes),
      "{\"yaw\":%" PRId64 ",\"pitch\":%" PRId64 "}",
      yaw,
      pitch);
  if (written < 0 || (size_t)written >= sizeof(slot->bytes)) {
    release_expression(slot);
    return CAPNWEB_E_LIMIT;
  }
  return publish_expression(reply, slot, (size_t)written);
}

static void release_callback_expression(void *context) {
  struct callback_operation *operation = context;
  operation->expression_borrowed = false;
  if (operation->callback_complete) {
    memset(operation, 0, sizeof(*operation));
  }
}

static void complete_callback(
    void *context, const struct capnweb_result *result) {
  struct callback_operation *operation = context;
  struct peer *peer = operation->peer;
  struct capnweb_session *session = operation->responder.session;
  struct capnweb_remote_capability capability = operation->capability;
  int64_t value;
  enum capnweb_status status;
  enum capnweb_status release_status;

  if (result->kind != CAPNWEB_RESULT_VALUE ||
      !capnweb_value_get_int64(&result->value, &value)) {
    status = capnweb_responder_set_error(
        operation->responder, "Error", "callback rejected");
  } else if (operation->wrap_result) {
    int length = snprintf(
        operation->expression,
        sizeof(operation->expression),
        "{\"result\":%" PRId64 "}",
        value);
    if (length < 0 ||
        (size_t)length >= sizeof(operation->expression)) {
      status = CAPNWEB_E_LIMIT;
    } else {
      operation->expression_borrowed = true;
      status = capnweb_responder_set_borrowed_expression(
          operation->responder,
          operation->expression,
          (size_t)length,
          release_callback_expression,
          operation);
      if (status != CAPNWEB_OK) {
        operation->expression_borrowed = false;
      }
    }
  } else {
    status = capnweb_responder_set_int64(
        operation->responder, value);
  }

  release_status = capnweb_session_release_remote(session, capability);
  if (status == CAPNWEB_OK) {
    status = release_status;
  }
  if (status != CAPNWEB_OK) {
    peer->asynchronous_failure = status;
  }
  operation->callback_complete = true;
  if (!operation->expression_borrowed) {
    memset(operation, 0, sizeof(*operation));
  }
}

static enum capnweb_status call_remote(
    struct peer *peer,
    const struct capnweb_call *call,
    struct capnweb_reply *reply,
    const char *method,
    bool wrap_result) {
  struct capnweb_value capability_value;
  struct capnweb_value argument;
  struct capnweb_remote_capability capability;
  struct callback_operation *operation = NULL;
  int64_t value;
  size_t index;
  char arguments[32];
  int arguments_length;
  enum capnweb_status status;

  if (!capnweb_value_array_at(
          &call->arguments, 0U, &capability_value) ||
      !capnweb_value_get_remote_capability(
          &capability_value, &capability) ||
      !capnweb_value_array_at(&call->arguments, 1U, &argument) ||
      !capnweb_value_get_int64(&argument, &value)) {
    return capnweb_reply_set_error(
        reply,
        "TypeError",
        "expected capability and integer arguments");
  }
  for (index = 0U; index < CALLBACK_CAPACITY; ++index) {
    if (!peer->callbacks[index].occupied) {
      operation = &peer->callbacks[index];
      break;
    }
  }
  if (operation == NULL) {
    return capnweb_reply_set_error(
        reply, "Error", "callback limit reached");
  }

  arguments_length = snprintf(
      arguments, sizeof(arguments), "[%" PRId64 "]", value);
  if (arguments_length < 0 ||
      (size_t)arguments_length >= sizeof(arguments)) {
    return CAPNWEB_E_LIMIT;
  }
  memset(operation, 0, sizeof(*operation));
  operation->peer = peer;
  operation->occupied = true;
  operation->responder = call->responder;
  operation->capability = capability;
  operation->wrap_result = wrap_result;
  status = capnweb_reply_defer(reply);
  if (status == CAPNWEB_OK) {
    status = capnweb_session_call(
        peer->session,
        capability,
        method,
        arguments,
        (size_t)arguments_length,
        complete_callback,
        operation);
  }
  if (status != CAPNWEB_OK) {
    if (operation->occupied) {
      memset(operation, 0, sizeof(*operation));
    }
    if (reply->kind == CAPNWEB_REPLY_DEFERRED) {
      return capnweb_reply_set_error(
          reply, "Error", "CAPNWEB_E_CALLBACK_CALL");
    }
  }
  return CAPNWEB_OK;
}

static enum capnweb_status dispatch_servo_move(
    struct peer *peer,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct capnweb_value position;
  struct capnweb_value yaw_value;
  struct capnweb_value pitch_value;
  int64_t yaw;
  int64_t pitch;
  if (!capnweb_value_array_at(&call->arguments, 0U, &position) ||
      !capnweb_value_object_get(&position, "yaw", &yaw_value) ||
      !capnweb_value_object_get(
          &position, "pitch", &pitch_value) ||
      !capnweb_value_get_int64(&yaw_value, &yaw) ||
      !capnweb_value_get_int64(&pitch_value, &pitch)) {
    return capnweb_reply_set_error(
        reply, "TypeError", "expected yaw and pitch integers");
  }
  return write_servo_position(peer, reply, yaw, pitch);
}

static enum capnweb_status dispatch_render(
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  static const char expected_url[] =
      "https://example.com/snowman-\xe2\x98\x83?q=\"quoted\"";
  struct capnweb_value options;
  struct capnweb_value url_value;
  char url[256];
  size_t url_length;
  enum capnweb_status status;
  if (!capnweb_value_array_at(&call->arguments, 0U, &options) ||
      !capnweb_value_object_get(&options, "url", &url_value)) {
    return capnweb_reply_set_error(
        reply, "TypeError", "expected a URL option");
  }
  status = capnweb_value_copy_string(
      &url_value, url, sizeof(url), &url_length);
  if (status != CAPNWEB_OK) {
    return capnweb_reply_set_error(
        reply, "TypeError", "invalid or oversized URL");
  }
  return capnweb_reply_set_boolean(
      reply,
      url_length == strlen(expected_url) &&
          memcmp(url, expected_url, url_length) == 0);
}

static enum capnweb_status dispatch(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  static const char *servo_path[] = {"servos", "move"};
  struct peer *peer = context;
  struct capnweb_value argument;
  int64_t value;

  if (capnweb_call_path_equals(call, servo_path, 2U)) {
    return dispatch_servo_move(peer, call, reply);
  }
  if (path_equals(call, "renderOnScreen")) {
    return dispatch_render(call, reply);
  }
  if (path_equals(call, "throwError")) {
    return capnweb_reply_set_error(
        reply, "RangeError", "test error");
  }
  if (path_equals(call, "getBytes")) {
    static const uint8_t bytes[] = {
      0, 1, 2, 127, 128, 254, 255,
    };
    return capnweb_reply_set_bytes(
        reply, bytes, sizeof(bytes), NULL, NULL);
  }
  if (path_equals(call, "getLargeBytes")) {
    if (!capnweb_value_array_at(
            &call->arguments, 0U, &argument) ||
        !capnweb_value_get_int64(&argument, &value) ||
        value < 0 ||
        value > LARGE_BYTE_CAPACITY) {
      return capnweb_reply_set_error(
          reply, "RangeError", "invalid byte length");
    }
    return capnweb_reply_set_bytes(
        reply, large_bytes, (size_t)value, NULL, NULL);
  }
  if (path_equals(call, "incrementCounter")) {
    return call_remote(peer, call, reply, "increment", false);
  }
  if (path_equals(call, "callFunction")) {
    return call_remote(peer, call, reply, NULL, true);
  }
  if (path_equals(call, "makeCounter")) {
    size_t index;
    if (!capnweb_value_array_at(
            &call->arguments, 0U, &argument) ||
        !capnweb_value_get_int64(&argument, &value)) {
      return capnweb_reply_set_error(
          reply, "TypeError", "expected integer argument");
    }
    for (index = 0U; index < COUNTER_CAPACITY; ++index) {
      if (!counters[index].occupied) {
        counters[index].occupied = true;
        counters[index].value = value;
        return capnweb_reply_set_capability(
            reply,
            (struct capnweb_capability){
              counter_dispatch,
              &counters[index],
              dispose_counter,
            });
      }
    }
    return capnweb_reply_set_error(
        reply, "Error", "counter limit reached");
  }
  if (path_equals(call, "makeDeferredCounter")) {
    return capnweb_reply_defer(reply);
  }
  if (path_equals(call, "makeValue")) {
    struct expression_slot *slot;
    int written;
    if (!capnweb_value_array_at(
            &call->arguments, 0U, &argument) ||
        !capnweb_value_get_int64(&argument, &value)) {
      return capnweb_reply_set_error(
          reply, "TypeError", "expected integer argument");
    }
    slot = allocate_expression(peer);
    if (slot == NULL) {
      return capnweb_reply_set_error(
          reply, "Error", "expression limit reached");
    }
    written = snprintf(
        slot->bytes,
        sizeof(slot->bytes),
        "{\"value\":%" PRId64 "}",
        value);
    if (written < 0 || (size_t)written >= sizeof(slot->bytes)) {
      release_expression(slot);
      return CAPNWEB_E_LIMIT;
    }
    return publish_expression(reply, slot, (size_t)written);
  }
  if (!capnweb_value_array_at(
          &call->arguments, 0U, &argument) ||
      !capnweb_value_get_int64(&argument, &value)) {
    return capnweb_reply_set_error(
        reply, "TypeError", "expected integer argument");
  }
  if (path_equals(call, "square")) {
    if (value > INT64_C(3037000499) ||
        value < -INT64_C(3037000499)) {
      return capnweb_reply_set_error(
          reply, "RangeError", "square overflow");
    }
    return capnweb_reply_set_int64(reply, value * value);
  }
  if (path_equals(call, "generateFibonacci")) {
    return write_fibonacci(peer, reply, value);
  }

  return capnweb_reply_set_error(
      reply, "TypeError", "unknown method");
}

static enum capnweb_status counter_dispatch(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct counter *counter = context;
  struct capnweb_value argument;
  int64_t amount;

  if (path_equals(call, "value") &&
      capnweb_value_array_size(&call->arguments) == 0U) {
    return capnweb_reply_set_int64(reply, counter->value);
  }
  if (!path_equals(call, "increment")) {
    return capnweb_reply_set_error(
        reply, "TypeError", "unknown counter method");
  }
  amount = 1;
  if (capnweb_value_array_size(&call->arguments) > 0U &&
      (!capnweb_value_array_at(
           &call->arguments, 0U, &argument) ||
       !capnweb_value_get_int64(&argument, &amount))) {
    return capnweb_reply_set_error(
        reply, "TypeError", "expected integer argument");
  }
  if ((amount > 0 && counter->value > INT64_MAX - amount) ||
      (amount < 0 && counter->value < INT64_MIN - amount)) {
    return capnweb_reply_set_error(
        reply, "RangeError", "counter overflow");
  }
  counter->value += amount;
  return capnweb_reply_set_int64(reply, counter->value);
}

static enum capnweb_status send_fragment(
    void *context,
    enum capnweb_text_fragment_kind kind,
    const char *data,
    size_t length) {
  struct stdio_transport *transport = context;
  switch (kind) {
    case CAPNWEB_TEXT_BEGIN:
      if (transport->message_open || data != NULL || length != 0U) {
        return CAPNWEB_E_TRANSPORT;
      }
      transport->message_open = true;
      return CAPNWEB_OK;
    case CAPNWEB_TEXT_DATA:
      if (!transport->message_open ||
          (data == NULL && length > 0U)) {
        return CAPNWEB_E_TRANSPORT;
      }
      return fwrite(data, 1U, length, stdout) == length
          ? CAPNWEB_OK
          : CAPNWEB_E_TRANSPORT;
    case CAPNWEB_TEXT_END:
      if (!transport->message_open || data != NULL || length != 0U) {
        return CAPNWEB_E_TRANSPORT;
      }
      transport->message_open = false;
      return fputc('\n', stdout) != EOF && fflush(stdout) == 0
          ? CAPNWEB_OK
          : CAPNWEB_E_TRANSPORT;
    default:
      return CAPNWEB_E_TRANSPORT;
  }
}

static enum input_status read_message(
    char *message, size_t capacity, size_t *length) {
  size_t position = 0U;
  bool limited = false;
  int character;

  while ((character = fgetc(stdin)) != EOF) {
    if (character == '\n') {
      *length = position;
      return limited ? INPUT_LIMIT : INPUT_MESSAGE;
    }
    if (position < capacity) {
      message[position++] = (char)character;
    } else {
      limited = true;
    }
  }
  if (ferror(stdin)) {
    return INPUT_ERROR;
  }
  if (limited) {
    return INPUT_LIMIT;
  }
  if (position == 0U) {
    return INPUT_END;
  }
  *length = position;
  return INPUT_MESSAGE;
}

int main(void) {
  char message[MESSAGE_CAPACITY];
  char output_scratch[OUTPUT_SCRATCH_CAPACITY];
  struct capnweb_json_token tokens[TOKEN_CAPACITY];
  struct capnweb_pending_call pending_calls[PENDING_CALL_CAPACITY];
  struct capnweb_export exports[EXPORT_CAPACITY];
  struct capnweb_import imports[IMPORT_CAPACITY];
  struct capnweb_session session;
  struct stdio_transport transport = {false};
  struct peer peer = {&session, {{0}}, {{0}}, CAPNWEB_OK};
  struct capnweb_session_options options = {
    {dispatch, &peer, NULL},
    send_fragment,
    &transport,
    pending_calls,
    PENDING_CALL_CAPACITY,
    exports,
    EXPORT_CAPACITY,
    imports,
    IMPORT_CAPACITY,
    tokens,
    TOKEN_CAPACITY,
    output_scratch,
    sizeof(output_scratch),
  };
  size_t index;
  int exit_code = 0;

  for (index = 0U; index < sizeof(large_bytes); ++index) {
    large_bytes[index] = (uint8_t)(index % 251U);
  }
  if (capnweb_session_init(&session, &options) != CAPNWEB_OK) {
    return 2;
  }
  for (;;) {
    size_t message_length;
    enum input_status input_status =
        read_message(message, sizeof(message), &message_length);
    enum capnweb_status status;
    if (input_status == INPUT_END) {
      break;
    }
    if (input_status == INPUT_LIMIT) {
      fprintf(
          stderr,
          "native transport failed: CAPNWEB_E_INPUT_LIMIT "
          "(maximum %u bytes)\n",
          MESSAGE_CAPACITY);
      exit_code = 5;
      break;
    }
    if (input_status == INPUT_ERROR) {
      fprintf(stderr, "native transport failed: CAPNWEB_E_INPUT\n");
      exit_code = 6;
      break;
    }
    status = capnweb_session_receive(
        &session, message, message_length);
    if (status != CAPNWEB_OK) {
      fprintf(
          stderr,
          "capnweb_session_receive failed: %s (%d)\n",
          status_name(status),
          (int)status);
      exit_code = 4;
      break;
    }
    if (peer.asynchronous_failure != CAPNWEB_OK) {
      fprintf(
          stderr,
          "asynchronous RPC operation failed: %s (%d)\n",
          status_name(peer.asynchronous_failure),
          (int)peer.asynchronous_failure);
      exit_code = 3;
      break;
    }
  }
  capnweb_session_close(&session);
  return exit_code;
}
