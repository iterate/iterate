#include "iterate/kit/websocket_text.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum {
  MESSAGE_CAPACITY = 64,
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

struct ingress_fixture {
  char received[MESSAGE_CAPACITY];
  size_t received_length;
  size_t count;
  enum capnweb_status result;
};

static enum capnweb_status capture_message(
    void *context, const char *message, size_t length) {
  struct ingress_fixture *fixture = context;
  assert(length <= sizeof(fixture->received));
  memcpy(fixture->received, message, length);
  fixture->received_length = length;
  ++fixture->count;
  return fixture->result;
}

/*
 * ESP-IDF reports both chunks within a frame and RFC 6455 continuation frames,
 * so callback boundaries are not Cap'n Web message boundaries. Dispatching
 * each callback was rejected because a scheduler split would feed partial JSON
 * to the RPC parser. The ingress object must retain buffer ownership until the
 * final continuation and invoke its consumer exactly once.
 */
static void ingress_reassembles_chunks_and_continuation_frames(void) {
  char buffer[MESSAGE_CAPACITY];
  struct ingress_fixture fixture = {{0}, 0U, 0U, CAPNWEB_OK};
  struct iterate_kit_websocket_text_ingress ingress;
  assert(
      iterate_kit_websocket_text_ingress_init(
          &ingress,
          buffer,
          sizeof(buffer),
          capture_message,
          &fixture) == CAPNWEB_OK);
  assert(
      iterate_kit_websocket_text_ingress_feed(
          &ingress,
          ITERATE_KIT_WEBSOCKET_TEXT,
          false,
          4U,
          0U,
          "ab",
          2U) == CAPNWEB_OK);
  assert(
      iterate_kit_websocket_text_ingress_feed(
          &ingress,
          ITERATE_KIT_WEBSOCKET_TEXT,
          false,
          4U,
          2U,
          "cd",
          2U) == CAPNWEB_OK);
  assert(fixture.count == 0U);
  assert(
      iterate_kit_websocket_text_ingress_feed(
          &ingress,
          ITERATE_KIT_WEBSOCKET_CONTINUATION,
          true,
          2U,
          0U,
          "ef",
          2U) == CAPNWEB_OK);
  assert(fixture.count == 1U);
  assert(fixture.received_length == 6U);
  assert(memcmp(fixture.received, "abcdef", 6U) == 0);
}

/*
 * A peer may interleave ping or pong control frames while a fragmented text
 * message is in flight. Treating every opcode change as a text reset was
 * rejected because an ordinary keepalive would then poison valid RPC traffic.
 * Control frames do not take ownership of the assembly buffer, and the
 * surrounding text message must remain intact through their arrival.
 */
static void ingress_ignores_control_frames_without_poisoning_text(void) {
  char buffer[MESSAGE_CAPACITY];
  struct ingress_fixture fixture = {{0}, 0U, 0U, CAPNWEB_OK};
  struct iterate_kit_websocket_text_ingress ingress;
  assert(
      iterate_kit_websocket_text_ingress_init(
          &ingress,
          buffer,
          sizeof(buffer),
          capture_message,
          &fixture) == CAPNWEB_OK);

  assert(
      iterate_kit_websocket_text_ingress_feed(
          &ingress,
          ITERATE_KIT_WEBSOCKET_TEXT,
          false,
          3U,
          0U,
          "abc",
          3U) == CAPNWEB_OK);
  assert(
      iterate_kit_websocket_text_ingress_feed(
          &ingress,
          ITERATE_KIT_WEBSOCKET_PING,
          true,
          1U,
          0U,
          "x",
          1U) == CAPNWEB_OK);
  assert(
      iterate_kit_websocket_text_ingress_feed(
          &ingress,
          ITERATE_KIT_WEBSOCKET_PONG,
          true,
          1U,
          0U,
          "x",
          1U) == CAPNWEB_OK);
  assert(
      iterate_kit_websocket_text_ingress_feed(
          &ingress,
          ITERATE_KIT_WEBSOCKET_CONTINUATION,
          true,
          3U,
          0U,
          "def",
          3U) == CAPNWEB_OK);
  assert(fixture.count == 1U);
  assert(fixture.received_length == 6U);
  assert(memcmp(fixture.received, "abcdef", 6U) == 0);

  assert(
      iterate_kit_websocket_text_ingress_feed(
          &ingress,
          ITERATE_KIT_WEBSOCKET_CLOSE,
          true,
          0U,
          0U,
      NULL,
      0U) == CAPNWEB_OK);
}

/*
 * Out-of-order continuations and messages larger than the caller's fixed
 * workspace mean frame boundaries can no longer be trusted. Trying to skip the
 * offending bytes and resynchronize was rejected: it risks executing a suffix
 * as a different RPC and hides a peer/proxy defect. Both failures must latch
 * terminally, with no callback and no allocation beyond the declared limit.
 */
static void ingress_limit_and_protocol_errors_are_terminal(void) {
  char buffer[4];
  struct ingress_fixture fixture = {{0}, 0U, 0U, CAPNWEB_OK};
  struct iterate_kit_websocket_text_ingress ingress;
  assert(
      iterate_kit_websocket_text_ingress_init(
          &ingress,
          buffer,
          sizeof(buffer),
          capture_message,
          &fixture) == CAPNWEB_OK);
  assert(
      iterate_kit_websocket_text_ingress_feed(
          &ingress,
          ITERATE_KIT_WEBSOCKET_CONTINUATION,
          true,
          1U,
          0U,
          "x",
          1U) == CAPNWEB_E_INVALID_MESSAGE);
  assert(
      iterate_kit_websocket_text_ingress_feed(
          &ingress,
          ITERATE_KIT_WEBSOCKET_TEXT,
          true,
          1U,
          0U,
          "x",
          1U) == CAPNWEB_E_INVALID_MESSAGE);

  assert(
      iterate_kit_websocket_text_ingress_init(
          &ingress,
          buffer,
          sizeof(buffer),
          capture_message,
          &fixture) == CAPNWEB_OK);
  assert(
      iterate_kit_websocket_text_ingress_feed(
          &ingress,
          ITERATE_KIT_WEBSOCKET_TEXT,
          true,
          5U,
          0U,
          "abcde",
          5U) == CAPNWEB_E_LIMIT);
  assert(fixture.count == 0U);
}

/*
 * This ingress has only Cap'n Web text protocol authority. Ignoring binary
 * data here would turn a wiring error into silent data loss while later text
 * appeared healthy, so the mismatch is terminal for this ingress session.
 */
static void ingress_rejects_binary_as_a_control_protocol_error(void) {
  char buffer[MESSAGE_CAPACITY];
  struct ingress_fixture fixture = {{0}, 0U, 0U, CAPNWEB_OK};
  struct iterate_kit_websocket_text_ingress ingress;
  assert(
      iterate_kit_websocket_text_ingress_init(
          &ingress,
          buffer,
          sizeof(buffer),
          capture_message,
          &fixture) == CAPNWEB_OK);

  assert(
      iterate_kit_websocket_text_ingress_feed(
          &ingress,
          ITERATE_KIT_WEBSOCKET_BINARY,
          true,
          3U,
          0U,
          "raw",
          3U) == CAPNWEB_E_UNSUPPORTED);
  assert(fixture.count == 0U);
  assert(
      iterate_kit_websocket_text_ingress_feed(
          &ingress,
          ITERATE_KIT_WEBSOCKET_TEXT,
          true,
          2U,
          0U,
      "[]",
      2U) == CAPNWEB_E_UNSUPPORTED);
}

/*
 * A complete text frame can still be rejected by the Cap'n Web session, for
 * example after a remote abort or invalid capability transition. Continuing
 * to dispatch later frames was rejected because they would run against
 * partially torn-down protocol state. The consumer's first failure therefore
 * becomes the ingress owner's terminal result and is never retried implicitly.
 */
static void receive_failure_is_terminal(void) {
  char buffer[MESSAGE_CAPACITY];
  struct ingress_fixture fixture = {
    {0}, 0U, 0U, CAPNWEB_E_REMOTE_ABORT,
  };
  struct iterate_kit_websocket_text_ingress ingress;
  assert(
      iterate_kit_websocket_text_ingress_init(
          &ingress,
          buffer,
          sizeof(buffer),
          capture_message,
          &fixture) == CAPNWEB_OK);
  assert(
      iterate_kit_websocket_text_ingress_feed(
          &ingress,
          ITERATE_KIT_WEBSOCKET_TEXT,
          true,
          2U,
          0U,
          "[]",
          2U) == CAPNWEB_E_REMOTE_ABORT);
  assert(fixture.count == 1U);
  assert(
      iterate_kit_websocket_text_ingress_feed(
          &ingress,
          ITERATE_KIT_WEBSOCKET_TEXT,
          true,
          2U,
          0U,
          "[]",
          2U) == CAPNWEB_E_REMOTE_ABORT);
}

int main(void) {
  ingress_reassembles_chunks_and_continuation_frames();
  ingress_ignores_control_frames_without_poisoning_text();
  ingress_limit_and_protocol_errors_are_terminal();
  ingress_rejects_binary_as_a_control_protocol_error();
  receive_failure_is_terminal();
  return 0;
}
