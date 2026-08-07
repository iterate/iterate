#include "fake_posix_websocket.h"
#include "iterate/kit/peer.h"
#include "iterate/kit/platforms/posix_itx_transport.h"
#include "iterate/kit/voice_device_profile.h"

#include <assert.h>
#include <errno.h>
#include <string.h>

enum {
  SLOT_COUNT = 2,
  CALL_COUNT = 4,
  TOKEN_COUNT = 32,
};

struct fixture {
  struct iterate_kit_configuration configuration;
  struct iterate_kit_posix_itx_transport transport;
  struct iterate_kit_itx_connection connection;
  struct iterate_kit_peer peer;
  struct iterate_kit_module module;
  struct capnweb_pending_call pending_calls[CALL_COUNT];
  struct capnweb_export exports[CALL_COUNT];
  struct capnweb_import imports[CALL_COUNT];
  struct capnweb_json_token tokens[TOKEN_COUNT];
  char outbound[256];
  struct iterate_kit_spsc_ring inbox;
  uint8_t inbox_storage[SLOT_COUNT][ITERATE_KIT_POSIX_CONTROL_MESSAGE_CAPACITY];
  size_t inbox_lengths[SLOT_COUNT];
  struct iterate_kit_spsc_ring outbox;
  uint8_t outbox_storage[SLOT_COUNT][ITERATE_KIT_POSIX_CONTROL_MESSAGE_CAPACITY];
  size_t outbox_lengths[SLOT_COUNT];
  int64_t now_us;
  int64_t advanced_now_us;
  unsigned int advance_on_clock_read;
  unsigned int clock_reads;
};

static int64_t fixture_now_us(void *context) {
  struct fixture *fixture = context;
  assert(fixture != NULL);
  ++fixture->clock_reads;
  if (fixture->advance_on_clock_read == fixture->clock_reads) {
    fixture->now_us = fixture->advanced_now_us;
  }
  return fixture->now_us;
}

static struct iterate_kit_poll_result close_module(void *context) {
  (void)context;
  return (struct iterate_kit_poll_result){ITERATE_KIT_POLL_OK, CAPNWEB_OK};
}

static void fixture_init(struct fixture *fixture) {
  static const char *const client_path = "/clients/posix";
  static const char description[] = "{}";
  struct iterate_kit_peer_options peer_options;
  struct iterate_kit_itx_connection_options connection_options;
  struct iterate_kit_posix_itx_transport_options transport_options;
  memset(fixture, 0, sizeof(*fixture));
  fixture->configuration = (struct iterate_kit_configuration){
    .os_base_url = "https://example.invalid",
    .project_id = "project",
    .project_api_key = "key",
  };
  assert(iterate_kit_spsc_ring_init(
             &fixture->inbox,
             fixture->inbox_storage,
             sizeof(fixture->inbox_storage[0]),
             SLOT_COUNT,
             fixture->inbox_lengths) == ITERATE_KIT_OK);
  assert(iterate_kit_spsc_ring_init(
             &fixture->outbox,
             fixture->outbox_storage,
             sizeof(fixture->outbox_storage[0]),
             SLOT_COUNT,
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
  assert(iterate_kit_peer_init(&fixture->peer, &peer_options) == CAPNWEB_OK);
  connection_options = (struct iterate_kit_itx_connection_options){
    .pending_calls = fixture->pending_calls,
    .pending_call_count = CALL_COUNT,
    .exports = fixture->exports,
    .export_count = CALL_COUNT,
    .imports = fixture->imports,
    .import_count = CALL_COUNT,
    .tokens = fixture->tokens,
    .token_count = TOKEN_COUNT,
    .outbound_buffer = fixture->outbound,
    .outbound_buffer_size = sizeof(fixture->outbound),
    .send_text = iterate_kit_posix_itx_transport_send_text,
    .send_text_context = &fixture->transport,
    .project_id = fixture->configuration.project_id,
    .project_api_key = fixture->configuration.project_api_key,
    .client_path = client_path,
    .capability = iterate_kit_peer_capability(&fixture->peer),
    .description = "posix test device",
  };
  assert(iterate_kit_itx_connection_init(
             &fixture->connection, &connection_options) == CAPNWEB_OK);
  transport_options = (struct iterate_kit_posix_itx_transport_options){
    .configuration = &fixture->configuration,
    .connection = &fixture->connection,
    .control_inbox = &fixture->inbox,
    .control_outbox = &fixture->outbox,
    .now_us = fixture_now_us,
    .now_us_context = fixture,
  };
  assert(iterate_kit_posix_itx_transport_prepare(
             &fixture->transport, &transport_options) == ITERATE_KIT_OK);
  assert(iterate_kit_posix_itx_transport_start(&fixture->transport) ==
         ITERATE_KIT_OK);
}

/*
 * DNS/TCP/TLS/upgrade is one bounded attempt. A nonblocking platform can keep
 * returning WOULD_BLOCK, but it cannot leave the device in CONNECTING forever.
 * The timeout is a classified retriable outcome rather than unexplained error
 * telemetry, and the same owner proves the next generation can recover.
 */
static void stalled_open_times_out_and_recovers(void) {
  struct fixture fixture;
  struct iterate_kit_posix_itx_transport_metrics metrics;
  fixture_init(&fixture);
  iterate_kit_fake_posix_websocket_set_open_result(
      ITERATE_KIT_POSIX_WEBSOCKET_OPEN_WOULD_BLOCK);

  assert(iterate_kit_posix_itx_transport_poll(
             &fixture.transport, SLOT_COUNT) == ITERATE_KIT_OK);
  assert(fixture.transport.websocket_open_attempt_active);
  fixture.now_us =
      (int64_t)ITERATE_KIT_VOICE_CONNECTION_OPEN_TIMEOUT_MS * 1000;
  assert(iterate_kit_posix_itx_transport_poll(
             &fixture.transport, SLOT_COUNT) == ITERATE_KIT_OK);
  assert(!fixture.transport.websocket_open_attempt_active);
  assert(!fixture.transport.socket_connected);
  iterate_kit_posix_itx_transport_metrics(&fixture.transport, &metrics);
  assert(metrics.websocket_open_timeouts == 1U);
  assert(metrics.websocket_errors == 0U);

  iterate_kit_fake_posix_websocket_set_open_result(
      ITERATE_KIT_POSIX_WEBSOCKET_OPEN_READY);
  fixture.transport.websocket_retry.ready_at_us = fixture.now_us;
  assert(iterate_kit_posix_itx_transport_poll(
             &fixture.transport, SLOT_COUNT) == ITERATE_KIT_OK);
  assert(fixture.transport.socket_connected);
  assert(fixture.transport.socket_generation == 1U);
  assert(iterate_kit_posix_itx_transport_stop(&fixture.transport) ==
         ITERATE_KIT_OK);
}

/*
 * A resolver or TLS step can start before the deadline and finish after it.
 * READY is not allowed to erase that elapsed time: the crossed attempt is a
 * timeout, its partially opened generation is closed, and no socket generation
 * becomes visible to Cap'n Web.
 */
static void ready_step_that_crosses_deadline_times_out(void) {
  struct fixture fixture;
  struct iterate_kit_posix_itx_transport_metrics metrics;
  fixture_init(&fixture);
  fixture.advance_on_clock_read = 3U;
  fixture.advanced_now_us =
      (int64_t)ITERATE_KIT_VOICE_CONNECTION_OPEN_TIMEOUT_MS * 1000;
  iterate_kit_fake_posix_websocket_set_open_result(
      ITERATE_KIT_POSIX_WEBSOCKET_OPEN_READY);

  assert(iterate_kit_posix_itx_transport_poll(
             &fixture.transport, SLOT_COUNT) == ITERATE_KIT_OK);
  assert(!fixture.transport.socket_connected);
  assert(fixture.transport.socket_generation == 0U);
  assert(!fixture.transport.websocket_open_attempt_active);
  iterate_kit_posix_itx_transport_metrics(&fixture.transport, &metrics);
  assert(metrics.websocket_open_timeouts == 1U);
  assert(metrics.websocket_connections == 0U);
  assert(metrics.websocket_errors == 0U);
  assert(metrics.last_platform_error == ETIMEDOUT);
  assert(iterate_kit_posix_itx_transport_stop(&fixture.transport) ==
         ITERATE_KIT_OK);
}

/*
 * A peer FIN/CLOSE used to strand the hardware session until a physical reset.
 * The POSIX owner must discard generation-scoped state, respect the same retry
 * gate, and then create a strictly newer socket generation. Forcing the gate's
 * clock only removes wall-clock delay; every production transition remains.
 */
static void peer_close_reconnects_with_new_generation(void) {
  struct fixture fixture;
  fixture_init(&fixture);
  assert(iterate_kit_posix_itx_transport_poll(
             &fixture.transport, SLOT_COUNT) == ITERATE_KIT_OK);
  assert(fixture.transport.socket_generation == 1U);
  iterate_kit_fake_posix_websocket_queue_peer_close();
  assert(iterate_kit_posix_itx_transport_poll(
             &fixture.transport, SLOT_COUNT) == ITERATE_KIT_OK);
  assert(!fixture.transport.socket_connected);
  fixture.transport.websocket_retry.ready_at_us = 0;
  assert(iterate_kit_posix_itx_transport_poll(
             &fixture.transport, SLOT_COUNT) == ITERATE_KIT_OK);
  assert(fixture.transport.socket_generation == 2U);
  assert(fixture.transport.socket_connected);
  assert(iterate_kit_posix_itx_transport_stop(&fixture.transport) ==
         ITERATE_KIT_OK);
}

int main(void) {
  stalled_open_times_out_and_recovers();
  ready_step_that_crosses_deadline_times_out();
  peer_close_reconnects_with_new_generation();
  return 0;
}
