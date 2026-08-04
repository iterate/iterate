#include "fake_posix_websocket.h"
#include "iterate/kit/peer.h"
#include "iterate/kit/platforms/posix_itx_transport.h"

#include <assert.h>
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
};

static struct iterate_kit_poll_result close_module(void *context) {
  (void)context;
  return (struct iterate_kit_poll_result){ITERATE_KIT_POLL_OK, CAPNWEB_OK};
}

static void fixture_init(struct fixture *fixture) {
  static const char *const mount_path[] = {"kit", "posix"};
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
    .mount_path = mount_path,
    .mount_path_count = 2U,
    .capability = iterate_kit_peer_capability(&fixture->peer),
  };
  assert(iterate_kit_itx_connection_init(
             &fixture->connection, &connection_options) == CAPNWEB_OK);
  transport_options = (struct iterate_kit_posix_itx_transport_options){
    .configuration = &fixture->configuration,
    .connection = &fixture->connection,
    .control_inbox = &fixture->inbox,
    .control_outbox = &fixture->outbox,
  };
  assert(iterate_kit_posix_itx_transport_prepare(
             &fixture->transport, &transport_options) == ITERATE_KIT_OK);
  assert(iterate_kit_posix_itx_transport_start(&fixture->transport) ==
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
  peer_close_reconnects_with_new_generation();
  return 0;
}
