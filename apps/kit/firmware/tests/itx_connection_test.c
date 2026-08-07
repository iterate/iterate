#include "iterate/kit/itx_connection.h"
#include "iterate/kit/peer.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum {
  TOKEN_CAPACITY = 128,
  CALL_CAPACITY = 8,
  OUTPUT_CAPACITY = 32,
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
  struct iterate_kit_itx_connection connection;
  struct iterate_kit_peer peer;
  struct iterate_kit_module module;
  struct capnweb_pending_call pending_calls[CALL_CAPACITY];
  struct capnweb_export exports[CALL_CAPACITY];
  struct capnweb_import imports[CALL_CAPACITY];
  struct capnweb_json_token tokens[TOKEN_CAPACITY];
  char output_buffer[OUTPUT_CAPACITY];
  char captured[CAPTURE_CAPACITY][MESSAGE_CAPACITY];
  size_t captured_lengths[CAPTURE_CAPACITY];
  size_t captured_count;
  size_t module_close_count;
  size_t session_ended_count;
  bool message_open;
};

static enum capnweb_status capture_text(
    void *context,
    enum capnweb_text_fragment_kind kind,
    const char *data,
    size_t length) {
  struct fixture *fixture = context;
  size_t *captured_length;
  if (kind == CAPNWEB_TEXT_BEGIN) {
    if (fixture->message_open ||
        fixture->captured_count >= CAPTURE_CAPACITY ||
        data != NULL ||
        length != 0U) {
      return CAPNWEB_E_TRANSPORT;
    }
    fixture->message_open = true;
    fixture->captured_lengths[fixture->captured_count] = 0U;
    return CAPNWEB_OK;
  }
  if (kind != CAPNWEB_TEXT_DATA && kind != CAPNWEB_TEXT_END) {
    return CAPNWEB_E_TRANSPORT;
  }
  if (!fixture->message_open) {
    return CAPNWEB_E_TRANSPORT;
  }
  captured_length =
      &fixture->captured_lengths[fixture->captured_count];
  if (kind == CAPNWEB_TEXT_END &&
      (data != NULL || length != 0U)) {
    return CAPNWEB_E_TRANSPORT;
  }
  if (length > MESSAGE_CAPACITY - 1U - *captured_length ||
      (kind == CAPNWEB_TEXT_DATA && data == NULL)) {
    return CAPNWEB_E_TRANSPORT;
  }
  if (length > 0U) {
    memcpy(
        fixture->captured[fixture->captured_count] + *captured_length,
        data,
        length);
    *captured_length += length;
  }
  if (kind == CAPNWEB_TEXT_END) {
    fixture->captured[fixture->captured_count][*captured_length] = '\0';
    ++fixture->captured_count;
    fixture->message_open = false;
  }
  return CAPNWEB_OK;
}

static struct iterate_kit_poll_result track_module_close(void *context) {
  struct fixture *fixture = context;
  ++fixture->module_close_count;
  return (struct iterate_kit_poll_result){
    ITERATE_KIT_POLL_OK,
    CAPNWEB_OK,
  };
}

static void track_module_session_ended(void *context) {
  struct fixture *fixture = context;
  ++fixture->session_ended_count;
}

static void notify_peer_session_ended(void *context) {
  struct fixture *fixture = context;
  iterate_kit_peer_session_ended(&fixture->peer);
}

static void fixture_init(struct fixture *fixture) {
  static const char *const client_path = "/clients/m5stick-s3";
  static const char description[] = "{}";
  struct iterate_kit_itx_connection_options options;
  struct iterate_kit_peer_options peer_options;
  memset(fixture, 0, sizeof(*fixture));
  fixture->module = (struct iterate_kit_module){
    .context = fixture,
    .close = track_module_close,
    .session_ended = track_module_session_ended,
  };
  peer_options = (struct iterate_kit_peer_options){
    .description_expression = description,
    .description_expression_length = sizeof(description) - 1U,
    .modules = &fixture->module,
    .module_count = 1U,
  };
  assert(
      iterate_kit_peer_init(
          &fixture->peer, &peer_options) == CAPNWEB_OK);
  options = (struct iterate_kit_itx_connection_options){
    .pending_calls = fixture->pending_calls,
    .pending_call_count = CALL_CAPACITY,
    .exports = fixture->exports,
    .export_count = CALL_CAPACITY,
    .imports = fixture->imports,
    .import_count = CALL_CAPACITY,
    .tokens = fixture->tokens,
    .token_count = TOKEN_CAPACITY,
    .outbound_buffer = fixture->output_buffer,
    .outbound_buffer_size = OUTPUT_CAPACITY,
    .send_text = capture_text,
    .send_text_context = fixture,
    .project_id = "prj_test",
    .project_api_key = "itxk_test",
    .client_path = client_path,
    .capability = iterate_kit_peer_capability(&fixture->peer),
    .description = "test device",
    .types = NULL,
    .session_ended = notify_peer_session_ended,
    .session_ended_context = fixture,
  };
  assert(
      iterate_kit_itx_connection_init(
          &fixture->connection, &options) == CAPNWEB_OK);
}

static void receive(
    struct fixture *fixture, const char *message) {
  const size_t length = strlen(message);
  assert(
      iterate_kit_itx_connection_receive_text(
          &fixture->connection, message, length) == CAPNWEB_OK);
}

/*
 * Wi-Fi can disappear after a live provision is mounted and return with bytes
 * from a wholly new WebSocket. Reusing Cap'n Web imports or mount state across
 * that boundary was rejected because stale capability IDs could address the
 * new peer. Loss must end one session exactly once, reopen must create a new
 * generation and authentication flow, and only a clean writable close may
 * release the provision handle on the wire.
 */
static void connection_mounts_reconnects_and_revokes(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  assert(
      iterate_kit_itx_connection_open(&fixture.connection) ==
      CAPNWEB_OK);
  assert(
      fixture.connection.state ==
      ITERATE_KIT_ITX_CONNECTION_MOUNTING);
  assert(fixture.connection.generation == 1U);
  assert(fixture.captured_count == 2U);

  /* Two calls mount a client now: authenticate, then projects.connect. */
  receive(&fixture, "[\"resolve\",1,[\"export\",-10]]");
  receive(&fixture, "[\"resolve\",2,[\"export\",-11]]");
  assert(
      fixture.connection.state ==
      ITERATE_KIT_ITX_CONNECTION_READY);

  iterate_kit_itx_connection_lost(&fixture.connection);
  assert(fixture.session_ended_count == 1U);
  assert(
      fixture.connection.state ==
      ITERATE_KIT_ITX_CONNECTION_DISCONNECTED);
  assert(
      iterate_kit_itx_connection_open(&fixture.connection) ==
      CAPNWEB_OK);
  assert(fixture.connection.generation == 2U);
  assert(strstr(
      fixture.captured[fixture.captured_count - 2U],
      "\"authenticate\"") != NULL);

  receive(&fixture, "[\"resolve\",1,[\"export\",-20]]");
  receive(&fixture, "[\"resolve\",2,[\"export\",-21]]");
  assert(
      fixture.connection.state ==
      ITERATE_KIT_ITX_CONNECTION_READY);
  assert(
      iterate_kit_itx_connection_close(&fixture.connection) ==
      CAPNWEB_OK);
  assert(fixture.session_ended_count == 2U);
  assert(
      fixture.connection.state ==
      ITERATE_KIT_ITX_CONNECTION_CLOSED);
  assert(strcmp(
      fixture.captured[fixture.captured_count - 1U],
      "[\"release\",-21,1]") == 0);
}

/*
 * Malformed text on an established Cap'n Web socket is a protocol defect, not
 * transient radio loss. Treating it as reconnectable transport failure was
 * rejected because the same incompatible peer could cause an infinite retry
 * storm. The connection owner must emit an abort, preserve the precise parser
 * status, and enter FAILED until an outer policy deliberately replaces it.
 */
static void malformed_protocol_text_fails_without_retry(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  assert(
      iterate_kit_itx_connection_open(&fixture.connection) ==
      CAPNWEB_OK);
  assert(
      iterate_kit_itx_connection_receive_text(
          &fixture.connection, "{", 1U) ==
      CAPNWEB_E_INVALID_MESSAGE);
  assert(
      fixture.connection.state ==
      ITERATE_KIT_ITX_CONNECTION_FAILED);
  assert(
      fixture.connection.capnweb_status ==
      CAPNWEB_E_INVALID_MESSAGE);
  assert(fixture.captured_count == 3U);
  assert(strstr(fixture.captured[2], "\"abort\"") != NULL);
  assert(strstr(
      fixture.captured[2], "CAPNWEB_E_INVALID_MESSAGE") != NULL);
}

/*
 * ESP-IDF connection callbacks can report a disconnect during startup before
 * the protocol owner has opened any session. Unconditionally closing or
 * notifying modules was rejected because it would operate on uninitialized
 * Cap'n Web state and manufacture a lifecycle event. Loss is therefore a safe
 * no-op for session ownership while still leaving the connection openable.
 */
static void loss_before_open_does_not_close_an_uninitialized_session(void) {
  struct fixture fixture;
  fixture_init(&fixture);

  iterate_kit_itx_connection_lost(&fixture.connection);
  assert(fixture.session_ended_count == 0U);
  assert(
      fixture.connection.state ==
      ITERATE_KIT_ITX_CONNECTION_DISCONNECTED);
  assert(
      iterate_kit_itx_connection_open(&fixture.connection) ==
      CAPNWEB_OK);
}

/*
 * A capability WebSocket is replaceable; the physical device, microphone, and
 * screen are not. Folding socket loss into device teardown was rejected because
 * a brief access-point roam would shut hardware down and make reconnect
 * impossible. This proves the connection ends the peer session once but leaves
 * module ownership intact until the peer itself is explicitly closed.
 */
static void session_loss_does_not_close_device_modules(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  assert(
      iterate_kit_itx_connection_open(&fixture.connection) ==
      CAPNWEB_OK);
  /* Two calls mount a client now: authenticate, then projects.connect. */
  receive(&fixture, "[\"resolve\",1,[\"export\",-10]]");
  receive(&fixture, "[\"resolve\",2,[\"export\",-11]]");

  iterate_kit_itx_connection_lost(&fixture.connection);

  assert(fixture.peer.initialized);
  assert(fixture.module_close_count == 0U);
  assert(fixture.session_ended_count == 1U);
  iterate_kit_itx_connection_lost(&fixture.connection);
  assert(fixture.session_ended_count == 1U);
  assert(
      iterate_kit_itx_connection_open(&fixture.connection) ==
      CAPNWEB_OK);
  assert(
      iterate_kit_peer_close(&fixture.peer).status ==
      ITERATE_KIT_POLL_OK);
  assert(fixture.module_close_count == 1U);
}

int main(void) {
  connection_mounts_reconnects_and_revokes();
  malformed_protocol_text_fails_without_retry();
  loss_before_open_does_not_close_an_uninitialized_session();
  session_loss_does_not_close_device_modules();
  return 0;
}
