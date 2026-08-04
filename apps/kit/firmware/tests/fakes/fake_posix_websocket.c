#include "fake_posix_websocket.h"

#include <string.h>

static bool peer_close_queued;

void iterate_kit_fake_posix_websocket_queue_peer_close(void) {
  peer_close_queued = true;
}

enum iterate_kit_status iterate_kit_posix_websocket_client_prepare(
    struct iterate_kit_posix_websocket_client *client,
    const struct iterate_kit_posix_websocket_client_options *options) {
  if (client == NULL || options == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(client, 0, sizeof(*client));
  client->options = *options;
  client->initialized = true;
  peer_close_queued = false;
  return ITERATE_KIT_OK;
}

enum iterate_kit_posix_websocket_open_result
iterate_kit_posix_websocket_client_open(
    struct iterate_kit_posix_websocket_client *client) {
  if (client == NULL || !client->initialized) {
    return ITERATE_KIT_POSIX_WEBSOCKET_OPEN_FAILED;
  }
  client->upgraded = true;
  return ITERATE_KIT_POSIX_WEBSOCKET_OPEN_READY;
}

enum iterate_kit_posix_websocket_receive_result
iterate_kit_posix_websocket_client_receive(
    struct iterate_kit_posix_websocket_client *client,
    struct iterate_kit_posix_websocket_chunk *chunk) {
  (void)client;
  if (chunk != NULL) {
    memset(chunk, 0, sizeof(*chunk));
  }
  if (peer_close_queued) {
    peer_close_queued = false;
    return ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_PEER_CLOSE;
  }
  return ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_IDLE;
}

enum iterate_kit_websocket_tx_result
iterate_kit_posix_websocket_client_send(
    struct iterate_kit_posix_websocket_client *client,
    enum iterate_kit_websocket_opcode opcode,
    const void *payload,
    size_t payload_size) {
  (void)client;
  (void)opcode;
  (void)payload;
  (void)payload_size;
  return ITERATE_KIT_WEBSOCKET_TX_SENT;
}

enum iterate_kit_websocket_tx_result
iterate_kit_posix_websocket_client_service_control(
    struct iterate_kit_posix_websocket_client *client) {
  (void)client;
  return ITERATE_KIT_WEBSOCKET_TX_IDLE;
}

void iterate_kit_posix_websocket_client_close(
    struct iterate_kit_posix_websocket_client *client) {
  if (client != NULL) {
    client->upgraded = false;
  }
}

void iterate_kit_posix_websocket_client_cleanup(
    struct iterate_kit_posix_websocket_client *client) {
  if (client != NULL) {
    memset(client, 0, sizeof(*client));
  }
}
