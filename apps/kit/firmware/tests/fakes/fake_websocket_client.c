#include "fake_websocket_client.h"

#include <string.h>

static bool peer_close_queued;
static enum iterate_kit_websocket_open_result open_result =
    ITERATE_KIT_WEBSOCKET_OPEN_READY;
static int32_t upgrade_status = 101;

void iterate_kit_fake_websocket_client_queue_peer_close(void) {
  peer_close_queued = true;
}

void iterate_kit_fake_websocket_client_set_open_result(
    enum iterate_kit_websocket_open_result result) {
  open_result = result;
  upgrade_status = result == ITERATE_KIT_WEBSOCKET_OPEN_READY ? 101 : 0;
}

void iterate_kit_fake_websocket_client_answer_upgrade(int32_t status) {
  open_result = status == 101
      ? ITERATE_KIT_WEBSOCKET_OPEN_READY
      : ITERATE_KIT_WEBSOCKET_OPEN_FAILED;
  upgrade_status = status;
}

enum iterate_kit_status iterate_kit_websocket_client_prepare(
    struct iterate_kit_websocket_client *client,
    const struct iterate_kit_websocket_client_options *options) {
  static const char scheme[] = "wss://";
  const char *host;
  size_t host_length;
  if (client == NULL || options == NULL || options->url == NULL ||
      strncmp(options->url, scheme, sizeof(scheme) - 1U) != 0) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(client, 0, sizeof(*client));
  client->options = *options;
  /* The platform dials this endpoint; only its host matters here. */
  host = options->url + sizeof(scheme) - 1U;
  host_length = strcspn(host, "/");
  memcpy(client->endpoint.host, host, host_length);
  client->endpoint.port = 443U;
  client->endpoint.secure = true;
  client->initialized = true;
  peer_close_queued = false;
  open_result = ITERATE_KIT_WEBSOCKET_OPEN_READY;
  upgrade_status = 101;
  return ITERATE_KIT_OK;
}

enum iterate_kit_websocket_open_result iterate_kit_websocket_client_open(
    struct iterate_kit_websocket_client *client, int64_t now_us) {
  (void)now_us;
  if (client == NULL || !client->initialized) {
    return ITERATE_KIT_WEBSOCKET_OPEN_FAILED;
  }
  client->upgraded = open_result == ITERATE_KIT_WEBSOCKET_OPEN_READY;
  client->last_upgrade_status = upgrade_status;
  return open_result;
}

enum iterate_kit_websocket_receive_result
iterate_kit_websocket_client_receive(
    struct iterate_kit_websocket_client *client,
    int64_t now_us,
    struct iterate_kit_websocket_chunk *chunk) {
  (void)client;
  (void)now_us;
  if (chunk != NULL) {
    memset(chunk, 0, sizeof(*chunk));
  }
  if (peer_close_queued) {
    peer_close_queued = false;
    return ITERATE_KIT_WEBSOCKET_RECEIVE_PEER_CLOSE;
  }
  return ITERATE_KIT_WEBSOCKET_RECEIVE_IDLE;
}

enum iterate_kit_websocket_tx_result iterate_kit_websocket_client_send(
    struct iterate_kit_websocket_client *client,
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
iterate_kit_websocket_client_service_control(
    struct iterate_kit_websocket_client *client, int64_t now_us) {
  (void)client;
  (void)now_us;
  return ITERATE_KIT_WEBSOCKET_TX_IDLE;
}

void iterate_kit_websocket_client_close(
    struct iterate_kit_websocket_client *client) {
  if (client != NULL) {
    client->upgraded = false;
  }
}

void iterate_kit_websocket_client_metrics(
    const struct iterate_kit_websocket_client *client,
    struct iterate_kit_websocket_client_metrics *metrics) {
  (void)client;
  if (metrics != NULL) {
    memset(metrics, 0, sizeof(*metrics));
  }
}
