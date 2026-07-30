#include "fake_esp_idf_platform.h"
#include "iterate/kit/peer.h"
#include "iterate/kit/platforms/esp_idf_itx_transport.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

enum {
  RING_SLOT_COUNT = 8,
  MESSAGE_CAPACITY = ITERATE_KIT_ESP_IDF_CONTROL_MESSAGE_CAPACITY,
  /*
   * Match the physical M5StickS3 profile. A host-only larger parser budget
   * would miss failures that appear only under the device's reviewed RAM cap.
   */
  TOKEN_CAPACITY = 64,
  CALL_CAPACITY = 8,
  OUTBOUND_CAPACITY = 256,
  TEST_TIMEOUT_MS = 2000,
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
  struct iterate_kit_configuration configuration;
  struct iterate_kit_esp_idf_itx_transport transport;
  struct iterate_kit_itx_connection connection;
  struct iterate_kit_peer peer;
  struct iterate_kit_module module;
  struct capnweb_pending_call pending_calls[CALL_CAPACITY];
  struct capnweb_export exports[CALL_CAPACITY];
  struct capnweb_import imports[CALL_CAPACITY];
  struct capnweb_json_token tokens[TOKEN_CAPACITY];
  char outbound_buffer[OUTBOUND_CAPACITY];
  struct iterate_kit_spsc_ring inbox;
  uint8_t inbox_storage[RING_SLOT_COUNT][MESSAGE_CAPACITY];
  size_t inbox_lengths[RING_SLOT_COUNT];
  struct iterate_kit_spsc_ring outbox;
  uint8_t outbox_storage[RING_SLOT_COUNT][MESSAGE_CAPACITY];
  size_t outbox_lengths[RING_SLOT_COUNT];
};

static struct iterate_kit_poll_result close_module(void *context) {
  (void)context;
  return (struct iterate_kit_poll_result){
    ITERATE_KIT_POLL_OK,
    CAPNWEB_OK,
  };
}

static void connection_session_ended(void *context) {
  iterate_kit_peer_session_ended(context);
}

static void fixture_init(struct fixture *fixture) {
  static const char *const mount_path[] = {"kit", "m5sticks3"};
  static const char description[] = "{}";
  struct iterate_kit_peer_options peer_options;
  struct iterate_kit_itx_connection_options connection_options;
  struct iterate_kit_esp_idf_itx_transport_options transport_options;
  memset(fixture, 0, sizeof(*fixture));
  fixture->configuration = (struct iterate_kit_configuration){
    .wifi_ssid = "host-test-network",
    .wifi_password = "test-password",
    .os_base_url = "https://example.invalid",
    .project_id = "prj_host_test",
    .project_api_key = "itxk_host_test",
  };
  assert(
      iterate_kit_spsc_ring_init(
          &fixture->inbox,
          fixture->inbox_storage,
          MESSAGE_CAPACITY,
          RING_SLOT_COUNT,
          fixture->inbox_lengths) == ITERATE_KIT_OK);
  assert(
      iterate_kit_spsc_ring_init(
          &fixture->outbox,
          fixture->outbox_storage,
          MESSAGE_CAPACITY,
          RING_SLOT_COUNT,
          fixture->outbox_lengths) == ITERATE_KIT_OK);
  fixture->module = (struct iterate_kit_module){
    .context = fixture,
    .close = close_module,
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
  connection_options =
      (struct iterate_kit_itx_connection_options){
        .pending_calls = fixture->pending_calls,
        .pending_call_count = CALL_CAPACITY,
        .exports = fixture->exports,
        .export_count = CALL_CAPACITY,
        .imports = fixture->imports,
        .import_count = CALL_CAPACITY,
        .tokens = fixture->tokens,
        .token_count = TOKEN_CAPACITY,
        .outbound_buffer = fixture->outbound_buffer,
        .outbound_buffer_size = OUTBOUND_CAPACITY,
        .send_text =
            iterate_kit_esp_idf_itx_transport_send_text,
        .send_text_context = &fixture->transport,
        .project_id = fixture->configuration.project_id,
        .project_api_key =
            fixture->configuration.project_api_key,
        .mount_path = mount_path,
        .mount_path_count = 2U,
        .capability =
            iterate_kit_peer_capability(&fixture->peer),
        .session_ended = connection_session_ended,
        .session_ended_context = &fixture->peer,
      };
  assert(
      iterate_kit_itx_connection_init(
          &fixture->connection,
          &connection_options) == CAPNWEB_OK);
  transport_options =
      (struct iterate_kit_esp_idf_itx_transport_options){
        .configuration = &fixture->configuration,
        .connection = &fixture->connection,
        .control_inbox = &fixture->inbox,
        .control_outbox = &fixture->outbox,
      };
  assert(
      iterate_kit_esp_idf_itx_transport_prepare(
          &fixture->transport,
          &transport_options) == ITERATE_KIT_OK);
  assert(
      iterate_kit_esp_idf_itx_transport_start(
          &fixture->transport) == ITERATE_KIT_OK);
}

static int64_t monotonic_milliseconds(void) {
  struct timespec now;
  (void)clock_gettime(CLOCK_MONOTONIC, &now);
  return (int64_t)now.tv_sec * 1000 +
      (int64_t)now.tv_nsec / 1000000;
}

static void pause_one_millisecond(void) {
  const struct timespec delay = {
    .tv_sec = 0,
    .tv_nsec = 1000000L,
  };
  (void)nanosleep(&delay, NULL);
}

static bool wait_for_socket_generation(
    struct fixture *fixture, uint32_t generation) {
  const int64_t deadline =
      monotonic_milliseconds() + TEST_TIMEOUT_MS;
  while (monotonic_milliseconds() < deadline) {
    (void)iterate_kit_esp_idf_itx_transport_poll(
        &fixture->transport, RING_SLOT_COUNT);
    if (__atomic_load_n(
            &fixture->transport.socket_connected,
            __ATOMIC_ACQUIRE) != 0U &&
        __atomic_load_n(
            &fixture->transport.socket_generation,
            __ATOMIC_ACQUIRE) >= generation &&
        fixture->transport.handled_socket_generation >= generation &&
        fixture->connection.session_open) {
      return true;
    }
    pause_one_millisecond();
  }
  /*
   * A reconnect timeout has several materially different causes: the retry
   * gate may not attempt, the callback may not publish a generation, or the
   * application may reject the new session. Preserve those distinctions in CI
   * instead of reducing the regression to an unexplained boolean timeout.
   */
  fprintf(
      stderr,
      "generation timeout: wanted=%u socket=%u handled=%u accepted=%u "
      "ready=%u failed=%u fatal=%u connected=%u ws_started=%u state=%s "
      "session_open=%d starts=%u disconnects=%u protocol_failures=%u\n",
      generation,
      __atomic_load_n(
          &fixture->transport.socket_generation,
          __ATOMIC_ACQUIRE),
      fixture->transport.handled_socket_generation,
      __atomic_load_n(
          &fixture->transport.accepted_socket_generation,
          __ATOMIC_ACQUIRE),
      __atomic_load_n(
          &fixture->transport.ready_socket_generation,
          __ATOMIC_ACQUIRE),
      __atomic_load_n(
          &fixture->transport.protocol_failure_generation,
          __ATOMIC_ACQUIRE),
      __atomic_load_n(
          &fixture->transport.fatal_failure_latched,
          __ATOMIC_ACQUIRE),
      __atomic_load_n(
          &fixture->transport.socket_connected,
          __ATOMIC_ACQUIRE),
      __atomic_load_n(
          &fixture->transport.websocket_started,
          __ATOMIC_ACQUIRE),
      iterate_kit_esp_idf_itx_transport_state_name(
          fixture->transport.state),
      fixture->connection.session_open ? 1 : 0,
      __atomic_load_n(
          &fixture->transport.websocket_start_attempts,
          __ATOMIC_ACQUIRE),
      __atomic_load_n(
          &fixture->transport.websocket_disconnects,
          __ATOMIC_ACQUIRE),
      __atomic_load_n(
          &fixture->transport.protocol_failures,
          __ATOMIC_ACQUIRE));
  return false;
}

static bool wait_for_outbox_empty(struct fixture *fixture) {
  const int64_t deadline =
      monotonic_milliseconds() + TEST_TIMEOUT_MS;
  while (monotonic_milliseconds() < deadline) {
    struct iterate_kit_spsc_ring_metrics metrics;
    iterate_kit_spsc_ring_metrics(
        &fixture->outbox, &metrics);
    if (metrics.current_slots == 0U) {
      return true;
    }
    pause_one_millisecond();
  }
  return false;
}

static bool wait_for_fatal_failure(struct fixture *fixture) {
  const int64_t deadline =
      monotonic_milliseconds() + TEST_TIMEOUT_MS;
  while (monotonic_milliseconds() < deadline) {
    if (__atomic_load_n(
            &fixture->transport.fatal_failure_latched,
            __ATOMIC_ACQUIRE) != 0U) {
      return true;
    }
    pause_one_millisecond();
  }
  return false;
}

static bool wait_for_websocket_start_without_generation(
    struct fixture *fixture) {
  const int64_t deadline =
      monotonic_milliseconds() + TEST_TIMEOUT_MS;
  while (monotonic_milliseconds() < deadline) {
    if (__atomic_load_n(
            &fixture->transport.websocket_started,
            __ATOMIC_ACQUIRE) != 0U &&
        __atomic_load_n(
            &fixture->transport.socket_generation,
            __ATOMIC_ACQUIRE) == 0U) {
      return true;
    }
    pause_one_millisecond();
  }
  return false;
}

static void emit_message(
    struct fixture *fixture, const char *message) {
  enum iterate_kit_status status;
  /*
   * A resolve is causally downstream of the corresponding request. Let the
   * network owner consume that request before synthesizing its reply; otherwise
   * the host could manufacture an impossible peer that resolves calls before
   * their bytes have left the device and fill the deliberately small outbox.
   */
  assert(wait_for_outbox_empty(fixture));
  assert(
      iterate_kit_fake_websocket_emit_text(
          fixture->transport.websocket,
          message,
          strlen(message),
          strlen(message),
          0U,
          true) == ESP_OK);
  status = iterate_kit_esp_idf_itx_transport_poll(
      &fixture->transport, RING_SLOT_COUNT);
  if (status != ITERATE_KIT_OK) {
    fprintf(
        stderr,
        "receive failed for %s: transport=%s connection=%d capnweb=%d\n",
        message,
        iterate_kit_esp_idf_itx_transport_state_name(
            fixture->transport.state),
        (int)fixture->connection.state,
        (int)fixture->transport.last_capnweb_status);
  }
  assert(status == ITERATE_KIT_OK);
  assert(wait_for_outbox_empty(fixture));
}

static void emit_message_expect_generation_failure(
    struct fixture *fixture, const char *message) {
  /*
   * Protocol rejection is an expected result of this helper, not an ignored
   * error. Requiring the exact transport/state outcome keeps a future parser
   * fallback from silently accepting a peer response the mount contract
   * classified as terminal for this generation.
   */
  assert(wait_for_outbox_empty(fixture));
  assert(
      iterate_kit_fake_websocket_emit_text(
          fixture->transport.websocket,
          message,
          strlen(message),
          strlen(message),
          0U,
          true) == ESP_OK);
  assert(
      iterate_kit_esp_idf_itx_transport_poll(
          &fixture->transport,
          RING_SLOT_COUNT) == ITERATE_KIT_STATE_ERROR);
  assert(
      fixture->transport.state ==
      ITERATE_KIT_ESP_IDF_ITX_FAILED);
}

static void resolve_mount(struct fixture *fixture, int export_base) {
  char message[64];
  unsigned int call_id;
  for (call_id = 1U; call_id <= 3U; ++call_id) {
    const int length = snprintf(
        message,
        sizeof(message),
        "[\"resolve\",%u,[\"export\",-%d]]",
        call_id,
        export_base + (int)call_id);
    assert(length > 0 && (size_t)length < sizeof(message));
    emit_message(fixture, message);
  }
  assert(
      fixture->transport.state ==
      ITERATE_KIT_ESP_IDF_ITX_READY);
}

static void fixture_finish(struct fixture *fixture) {
  struct iterate_kit_spsc_ring_metrics outbox_metrics;
  assert(
      iterate_kit_esp_idf_itx_transport_stop(
          &fixture->transport) == ITERATE_KIT_OK);
  iterate_kit_spsc_ring_metrics(
      &fixture->outbox, &outbox_metrics);
  assert(outbox_metrics.current_slots == 0U);
  /*
   * Joining the pthread is fixture ownership, not fake WebSocket destruction.
   * Keeping those lifetimes distinct makes the host rig reject production
   * teardown that destroys a client before its static task has deleted itself.
   */
  assert(iterate_kit_fake_platform_finish() == ESP_OK);
  assert(
      iterate_kit_peer_close(&fixture->peer).status ==
      ITERATE_KIT_POLL_OK);
}

static void poison_generation_with_oversized_message(
    struct fixture *fixture) {
  char first_chunk[MESSAGE_CAPACITY];
  const char final_byte = ']';
  memset(first_chunk, ' ', sizeof(first_chunk));
  first_chunk[0] = '[';
  /*
   * Use the same two callbacks ESP-IDF produces for a fragmented 2049-byte
   * message. A one-byte callback that merely claimed a larger payload would
   * test fake metadata, not the real bounded assembler reaching its capacity.
   */
  assert(
      iterate_kit_fake_websocket_emit_text(
          fixture->transport.websocket,
          first_chunk,
          sizeof(first_chunk),
          MESSAGE_CAPACITY + 1U,
          0U,
          true) == ESP_OK);
  assert(
      iterate_kit_fake_websocket_emit_text(
          fixture->transport.websocket,
          &final_byte,
          1U,
          MESSAGE_CAPACITY + 1U,
          MESSAGE_CAPACITY,
          true) == ESP_OK);
}

/*
 * A large or corrupt control message can come from a proxy bug, version skew,
 * or a hostile peer while the physical device itself remains healthy. Power
 * cycling the device was rejected as recovery policy: the next valid socket
 * generation must remount the same capability with no stale fragments or
 * session messages. This scenario drives the real ESP-IDF transport task and
 * callbacks to prove one oversized generation is counted, abandoned, and
 * replaced instead of permanently bricking remote control.
 */
static void oversized_message_recovers_on_a_fresh_generation(void) {
  struct iterate_kit_esp_idf_itx_transport_metrics metrics;
  struct fixture fixture;
  fixture_init(&fixture);

  assert(wait_for_socket_generation(&fixture, 1U));
  resolve_mount(&fixture, 10);

  poison_generation_with_oversized_message(&fixture);

  /*
   * The old implementation latched every peer/input failure forever. This is
   * the key production assertion: a bounded reconnect may report FAILED while
   * replacing the generation, but it must eventually accept generation two.
   */
  assert(wait_for_socket_generation(&fixture, 2U));
  resolve_mount(&fixture, 20);

  iterate_kit_esp_idf_itx_transport_metrics(
      &fixture.transport, &metrics);
  assert(metrics.protocol_failures == 1U);
  assert(metrics.control_receive_failures == 1U);
  assert(metrics.websocket_connections == 2U);
  /*
   * CAPNWEB_E_LIMIT classifies bounded control input; it is not an esp_err_t.
   * Conflating the two domains makes a device diagnostic claim the platform
   * failed with an invented SDK code and destroys the causal evidence.
   */
  assert(metrics.last_platform_error == ESP_OK);
  assert(
      metrics.last_control_receive_status ==
      CAPNWEB_E_LIMIT);
  /*
   * stop() has already retired the sole socket/outbox consumer. A graceful
   * Cap'n Web close performed after that point would serialize release frames
   * into a queue no task can drain, turning every ordinary shutdown into a
   * hidden backlog. Shutdown must instead classify the transport as lost
   * before closing local session state, leaving the bounded queue empty.
   */
  fixture_finish(&fixture);
}

/*
 * A WebSocket CONNECTED callback proves only a transport handshake. If that
 * reset retry history, a peer that rejects every mount could sustain four TLS
 * handshakes per second forever. Only a generation that reaches READY earns a
 * reset: after one healthy generation, two consecutive pre-READY failures must
 * therefore wait roughly 250 ms and 500 ms before their replacements.
 */
static void pre_ready_failures_retain_exponential_retry_pacing(void) {
  int64_t first_failed_at;
  int64_t second_failed_at;
  int64_t first_delay;
  int64_t second_delay;
  struct iterate_kit_esp_idf_itx_transport_metrics metrics;
  struct fixture fixture;
  fixture_init(&fixture);

  assert(wait_for_socket_generation(&fixture, 1U));
  resolve_mount(&fixture, 10);

  poison_generation_with_oversized_message(&fixture);
  first_failed_at = monotonic_milliseconds();
  assert(wait_for_socket_generation(&fixture, 2U));
  first_delay =
      monotonic_milliseconds() - first_failed_at;
  assert(first_delay >= 200);

  assert(wait_for_outbox_empty(&fixture));
  poison_generation_with_oversized_message(&fixture);
  second_failed_at = monotonic_milliseconds();
  assert(wait_for_socket_generation(&fixture, 3U));
  second_delay =
      monotonic_milliseconds() - second_failed_at;
  /*
   * Leave scheduling tolerance below the policy delta. Host load can lengthen
   * a wait but cannot make a correctly gated 500 ms reconnect arrive early.
   */
  assert(second_delay >= 400);
  resolve_mount(&fixture, 30);

  iterate_kit_esp_idf_itx_transport_metrics(
      &fixture.transport, &metrics);
  assert(metrics.protocol_failures == 2U);
  assert(metrics.websocket_start_attempts == 3U);
  assert(metrics.websocket_connections == 3U);
  fixture_finish(&fixture);
}

/*
 * ESP-IDF can deliver several terminal callbacks before the network owner acts
 * on the first wakeup. Those are evidence about one poisoned socket, not
 * several incidents: overcounting would make rates topology/scheduling
 * dependent and could drive an outer health policy into a false failure.
 */
static void repeated_callback_failures_count_once_per_generation(void) {
  static const char trailing_byte = ']';
  struct iterate_kit_esp_idf_itx_transport_metrics metrics;
  struct fixture fixture;
  fixture_init(&fixture);

  assert(wait_for_socket_generation(&fixture, 1U));
  resolve_mount(&fixture, 10);
  assert(iterate_kit_fake_network_task_pause() == ESP_OK);

  poison_generation_with_oversized_message(&fixture);
  /*
   * The assembler is already terminal. Feeding one further callback exercises
   * the idempotent generation publication while the paused socket owner cannot
   * yet stop the client underneath the test thread.
   */
  assert(
      iterate_kit_fake_websocket_emit_text(
          fixture.transport.websocket,
          &trailing_byte,
          1U,
          1U,
          0U,
          true) == ESP_OK);
  iterate_kit_esp_idf_itx_transport_metrics(
      &fixture.transport, &metrics);
  assert(metrics.control_receive_failures == 2U);
  assert(metrics.protocol_failures == 1U);

  assert(iterate_kit_fake_network_task_resume() == ESP_OK);
  assert(wait_for_socket_generation(&fixture, 2U));
  resolve_mount(&fixture, 20);
  iterate_kit_esp_idf_itx_transport_metrics(
      &fixture.transport, &metrics);
  assert(metrics.protocol_failures == 1U);
  fixture_finish(&fixture);
}

/*
 * Production ESP-IDF dispatches CONNECTED asynchronously from its WebSocket
 * task. A synchronous fake would hide the valid interval in which client_start
 * has succeeded but no generation exists yet; polling there must remain
 * nonblocking and must not open a Cap'n Web session against generation zero.
 * Delivering CONNECTED from this test thread also exercises the same
 * generation-before-connected publication consumed by the application task.
 */
static void asynchronous_connected_callback_opens_one_clean_generation(void) {
  struct fixture fixture;
  iterate_kit_fake_websocket_defer_connected(true);
  fixture_init(&fixture);

  assert(
      wait_for_websocket_start_without_generation(
          &fixture));
  assert(
      iterate_kit_esp_idf_itx_transport_poll(
          &fixture.transport,
          RING_SLOT_COUNT) == ITERATE_KIT_OK);
  assert(!fixture.connection.session_open);
  assert(
      fixture.transport.state ==
      ITERATE_KIT_ESP_IDF_ITX_WEBSOCKET_CONNECTING);

  assert(
      iterate_kit_fake_websocket_emit_connected(
          fixture.transport.websocket) == ESP_OK);
  iterate_kit_fake_websocket_defer_connected(false);
  assert(wait_for_socket_generation(&fixture, 1U));
  resolve_mount(&fixture, 10);
  fixture_finish(&fixture);
}

/*
 * ESP-IDF's whole-message API does not reveal whether a short write reached
 * the peer. Retrying that serialized Cap'n Web call could duplicate an RPC;
 * retaining it across generations would reuse session-scoped references. The
 * only safe response is visible loss plus a clean remount, with no stale
 * outbox backlog and no permanent device failure.
 */
static void short_control_send_discards_and_remounts(void) {
  static const char message[] = "[]";
  struct iterate_kit_esp_idf_itx_transport_metrics metrics;
  struct fixture fixture;
  fixture_init(&fixture);

  assert(wait_for_socket_generation(&fixture, 1U));
  resolve_mount(&fixture, 10);
  assert(wait_for_outbox_empty(&fixture));
  iterate_kit_fake_websocket_short_next_send();
  assert(
      iterate_kit_esp_idf_itx_transport_send_text(
          &fixture.transport,
          CAPNWEB_TEXT_BEGIN,
          NULL,
          0U) == CAPNWEB_OK);
  assert(
      iterate_kit_esp_idf_itx_transport_send_text(
          &fixture.transport,
          CAPNWEB_TEXT_DATA,
          message,
          sizeof(message) - 1U) == CAPNWEB_OK);
  assert(
      iterate_kit_esp_idf_itx_transport_send_text(
          &fixture.transport,
          CAPNWEB_TEXT_END,
          NULL,
          0U) == CAPNWEB_OK);

  assert(wait_for_socket_generation(&fixture, 2U));
  resolve_mount(&fixture, 20);
  iterate_kit_esp_idf_itx_transport_metrics(
      &fixture.transport, &metrics);
  assert(metrics.control_send_failures == 1U);
  assert(metrics.protocol_failures == 0U);
  assert(metrics.websocket_connections == 2U);
  fixture_finish(&fixture);
}

/*
 * Destroying the WebSocket client while the static owner task can still access
 * it is a production use-after-free, not something a pthread fake may repair
 * by secretly joining that task. The fake must reject the wrong ownership
 * order and preserve the client so the normal cooperative stop still works.
 */
static void websocket_destroy_rejects_a_live_transport_task(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  assert(wait_for_socket_generation(&fixture, 1U));
  resolve_mount(&fixture, 10);

  assert(
      esp_websocket_client_destroy(
          fixture.transport.websocket) ==
      ESP_ERR_INVALID_STATE);
  fixture_finish(&fixture);
}

/*
 * Authentication rejection is terminal for one Cap'n Web session, but it is
 * not a corrupt ESP32 invariant. The outer transport must preserve the exact
 * rejection long enough to count it, then open a new generation so rotated
 * credentials or a transient proxy policy can recover without a power cycle.
 * This also proves that a failure whose Cap'n Web status is CAPNWEB_OK is not
 * accidentally mistaken for success: the mount's semantic state is decisive.
 */
static void mount_rejection_recovers_on_a_fresh_generation(void) {
  static const char rejection[] =
      "[\"reject\",1,[\"error\",\"Error\",\"invalid auth\"]]";
  struct iterate_kit_esp_idf_itx_transport_metrics metrics;
  struct fixture fixture;
  fixture_init(&fixture);

  assert(wait_for_socket_generation(&fixture, 1U));
  emit_message_expect_generation_failure(
      &fixture, rejection);
  assert(wait_for_socket_generation(&fixture, 2U));
  resolve_mount(&fixture, 20);

  iterate_kit_esp_idf_itx_transport_metrics(
      &fixture.transport, &metrics);
  assert(metrics.protocol_failures == 1U);
  assert(metrics.control_receive_failures == 0U);
  assert(metrics.websocket_connections == 2U);
  fixture_finish(&fixture);
}

static size_t build_token_overflow_message(
    char *message, size_t capacity) {
  size_t length;
  size_t index;
  int written = snprintf(
      message,
      capacity,
      "[\"push\",[\"pipeline\",0,[\"echo\"],[");
  assert(written > 0 && (size_t)written < capacity);
  length = (size_t)written;
  /*
   * Flat scalar arguments are intentional. The peer message stays far below
   * the 2 KiB WebSocket cap while exceeding only the production JSON-token
   * workspace, isolating parser-memory pressure from frame reassembly policy.
   */
  for (index = 0U; index <= TOKEN_CAPACITY; ++index) {
    written = snprintf(
        message + length,
        capacity - length,
        index == 0U ? "0" : ",0");
    assert(
        written > 0 &&
        (size_t)written < capacity - length);
    length += (size_t)written;
  }
  written = snprintf(
      message + length, capacity - length, "]]]");
  assert(
      written > 0 &&
      (size_t)written < capacity - length);
  return length + (size_t)written;
}

/*
 * Fixed parser memory is a required ESP property, not permission to brick the
 * control plane when a peer exceeds it. The current generation must fail with
 * CAPNWEB_E_LIMIT, discard all session state, and remount cleanly; retrying the
 * same oversized message or growing memory dynamically were both rejected.
 */
static void token_budget_overflow_recovers_on_a_fresh_generation(void) {
  char message[512];
  struct iterate_kit_esp_idf_itx_transport_metrics metrics;
  struct fixture fixture;
  const size_t message_length =
      build_token_overflow_message(
          message, sizeof(message));
  assert(message_length == strlen(message));
  fixture_init(&fixture);

  assert(wait_for_socket_generation(&fixture, 1U));
  resolve_mount(&fixture, 10);
  emit_message_expect_generation_failure(
      &fixture, message);
  assert(
      fixture.transport.last_capnweb_status ==
      CAPNWEB_E_LIMIT);
  assert(wait_for_socket_generation(&fixture, 2U));
  resolve_mount(&fixture, 20);

  iterate_kit_esp_idf_itx_transport_metrics(
      &fixture.transport, &metrics);
  assert(metrics.protocol_failures == 1U);
  assert(metrics.control_receive_failures == 0U);
  assert(metrics.websocket_connections == 2U);
  fixture_finish(&fixture);
}

/*
 * Generation zero is the never-connected sentinel, so allowing uint32 wrap
 * would make ancient callbacks indistinguishable from a new socket. This
 * synthetic boundary is unreachable in ordinary test time but must fail once,
 * visibly, and stop all later starts; treating it as peer input would create an
 * endless reconnect loop at the exact point epoch comparisons become unsafe.
 */
static void socket_generation_exhaustion_is_fatal_and_bounded(void) {
  struct iterate_kit_esp_idf_itx_transport_metrics before_wait;
  struct iterate_kit_esp_idf_itx_transport_metrics after_wait;
  struct fixture fixture;
  const struct timespec observation_window = {
    .tv_sec = 0,
    .tv_nsec = 600000000L,
  };
  fixture_init(&fixture);

  assert(wait_for_socket_generation(&fixture, 1U));
  resolve_mount(&fixture, 10);
  __atomic_store_n(
      &fixture.transport.socket_generation,
      UINT32_MAX,
      __ATOMIC_RELEASE);
  iterate_kit_esp_idf_itx_transport_request_restart(
      &fixture.transport);

  assert(wait_for_fatal_failure(&fixture));
  assert(
      iterate_kit_esp_idf_itx_transport_poll(
          &fixture.transport,
          RING_SLOT_COUNT) == ITERATE_KIT_STATE_ERROR);
  iterate_kit_esp_idf_itx_transport_metrics(
      &fixture.transport, &before_wait);
  assert(before_wait.websocket_start_attempts == 2U);
  assert(before_wait.websocket_connections == 1U);
  assert(before_wait.protocol_failures == 0U);
  assert(before_wait.control_receive_failures == 1U);

  /*
   * Wait beyond two initial retry intervals. Exact equality proves the fatal
   * latch suppresses starts rather than merely making the next attempt slow.
   */
  (void)nanosleep(&observation_window, NULL);
  iterate_kit_esp_idf_itx_transport_metrics(
      &fixture.transport, &after_wait);
  assert(
      after_wait.websocket_start_attempts ==
      before_wait.websocket_start_attempts);
  fixture_finish(&fixture);
}

int main(void) {
  oversized_message_recovers_on_a_fresh_generation();
  pre_ready_failures_retain_exponential_retry_pacing();
  repeated_callback_failures_count_once_per_generation();
  asynchronous_connected_callback_opens_one_clean_generation();
  short_control_send_discards_and_remounts();
  websocket_destroy_rejects_a_live_transport_task();
  mount_rejection_recovers_on_a_fresh_generation();
  token_budget_overflow_recovers_on_a_fresh_generation();
  socket_generation_exhaustion_is_fatal_and_bounded();
  return 0;
}
