/*
 * capnweb_session_call_oneway_path: pushes the pipeline expression, releases
 * the result import instead of pulling it, and frees the import slot before
 * returning — the shape high-frequency stream appends (PCM frames) depend on.
 */
#include "capnweb/capnweb.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum {
  TOKEN_CAPACITY = 128,
  CALL_CAPACITY = 4,
  OUTPUT_CAPACITY = 64,
  CAPTURE_CAPACITY = 12,
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

static size_t occupied_imports(const struct fixture *fixture) {
  size_t count = 0U;
  size_t index;
  for (index = 0U; index < CALL_CAPACITY; ++index) {
    if (fixture->imports[index].occupied) {
      ++count;
    }
  }
  return count;
}

static bool pulled_completion_called = false;

static void pulled_completion(
    void *context, const struct capnweb_result *result) {
  (void)context;
  (void)result;
  pulled_completion_called = true;
}

int main(void) {
  static struct fixture fixture;
  static const char *const append_path[] = {"append"};
  static const char arguments[] =
      "[{\"type\":\"voicelab/mic-frame\",\"ephemeral\":true,"
      "\"payload\":{\"seq\":1,\"pcm\":\"QUJDRA\"}}]";
  const struct capnweb_remote_capability main_capability = {0};

  fixture_init(&fixture);

  /* One-way call: exactly push + release, no pull, no retained import. */
  assert(
      capnweb_session_call_oneway_path(
          &fixture.session,
          main_capability,
          append_path,
          1U,
          arguments,
          sizeof(arguments) - 1U) == CAPNWEB_OK);
  assert(fixture.captured_count == 2U);
  assert(
      strcmp(
          fixture.captured[0],
          "[\"push\",[\"pipeline\",0,[\"append\"],"
          "[{\"type\":\"voicelab/mic-frame\",\"ephemeral\":true,"
          "\"payload\":{\"seq\":1,\"pcm\":\"QUJDRA\"}}]]]") == 0);
  assert(strcmp(fixture.captured[1], "[\"release\",1,1]") == 0);
  assert(occupied_imports(&fixture) == 0U);

  /* Ids stay strictly sequential across one-way calls. */
  assert(
      capnweb_session_call_oneway_path(
          &fixture.session,
          main_capability,
          append_path,
          1U,
          arguments,
          sizeof(arguments) - 1U) == CAPNWEB_OK);
  assert(fixture.captured_count == 4U);
  assert(strcmp(fixture.captured[3], "[\"release\",2,1]") == 0);
  assert(occupied_imports(&fixture) == 0U);

  /* A pulled call after one-way traffic uses the next sequential id. */
  assert(
      capnweb_session_call(
          &fixture.session,
          main_capability,
          "ping",
          "[]",
          2U,
          pulled_completion,
          NULL) == CAPNWEB_OK);
  assert(fixture.captured_count == 6U);
  assert(strcmp(fixture.captured[5], "[\"pull\",3]") == 0);
  assert(occupied_imports(&fixture) == 1U);
  assert(!pulled_completion_called);

  /* Arguments must be a JSON array, same contract as pulled calls. */
  assert(
      capnweb_session_call_oneway_path(
          &fixture.session,
          main_capability,
          append_path,
          1U,
          "{\"not\":\"array\"}",
          sizeof("{\"not\":\"array\"}") - 1U) == CAPNWEB_E_INVALID_ARGUMENT);

  printf("capnweb oneway call test passed\n");
  return 0;
}
