#include "fake_esp_idf_pcm_websocket.h"

#include "iterate/kit/pcm_websocket.h"
#include "iterate/kit/platforms/esp_idf_websocket_connection.h"

#include <stdbool.h>
#include <string.h>

/*
 * This fake replaces only the already-upgraded, nonblocking WebSocket
 * boundary. The production PCM transport, portable lane, conductor, retry
 * policy, and host pthread standing in for the FreeRTOS owner all remain real.
 * That is the narrowest useful seam for deterministically placing one server
 * frame in the dangerous CONNECTED-before-application-poll window.
 */
enum {
  /*
   * Five is intentional: four items fill the production test lane and the
   * fifth proves that losing an already-received ordered item invalidates the
   * socket generation. It remains below the production receive burst of eight,
   * so the fake cannot hide queue pressure behind a scheduling yield.
   */
  PENDING_ITEM_CAPACITY = 5,
};

struct pending_item {
  uint8_t frame[ITERATE_KIT_PCM_V1_FRAME_BYTES];
  size_t byte_count;
};

static struct pending_item pending_items[PENDING_ITEM_CAPACITY];
static uint32_t pending_item_count;
static uint32_t next_pending_item;
static uint32_t receive_calls;
static uint32_t deliveries;

static enum iterate_kit_websocket_tx_raw_write_result raw_write(
    void *context,
    const uint8_t *bytes,
    size_t byte_count,
    size_t *bytes_written) {
  (void)context;
  (void)bytes;
  *bytes_written = byte_count;
  return ITERATE_KIT_WEBSOCKET_TX_RAW_WROTE;
}

static enum iterate_kit_status random_mask(
    void *context, uint8_t *bytes, size_t byte_count) {
  (void)context;
  memset(bytes, 0x5a, byte_count);
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_fake_pcm_websocket_queue_binary(
    const void *bytes, size_t byte_count) {
  const uint32_t index = __atomic_load_n(
      &pending_item_count, __ATOMIC_ACQUIRE);
  if ((byte_count != 0U &&
       byte_count != ITERATE_KIT_PCM_V1_FRAME_BYTES) ||
      (byte_count > 0U && bytes == NULL) ||
      (byte_count == 0U && bytes != NULL) ||
      index >= PENDING_ITEM_CAPACITY ||
      __atomic_load_n(
          &next_pending_item, __ATOMIC_ACQUIRE) != 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (byte_count > 0U) {
    memcpy(pending_items[index].frame, bytes, byte_count);
  }
  pending_items[index].byte_count = byte_count;
  /*
   * The release store makes both bytes and length visible to the network task.
   * Tests may publish a script before start or before its first item is
   * consumed; enqueuing after consumption begins is rejected above rather than
   * modeled with a fake lock the firmware does not have.
   */
  __atomic_store_n(
      &pending_item_count, index + 1U, __ATOMIC_RELEASE);
  return ITERATE_KIT_OK;
}

uint32_t iterate_kit_fake_pcm_websocket_receive_calls(void) {
  return __atomic_load_n(&receive_calls, __ATOMIC_ACQUIRE);
}

uint32_t iterate_kit_fake_pcm_websocket_deliveries(void) {
  return __atomic_load_n(&deliveries, __ATOMIC_ACQUIRE);
}

void iterate_kit_fake_pcm_websocket_reset(void) {
  memset(pending_items, 0, sizeof(pending_items));
  __atomic_store_n(
      &pending_item_count, 0U, __ATOMIC_RELEASE);
  __atomic_store_n(
      &next_pending_item, 0U, __ATOMIC_RELEASE);
  __atomic_store_n(&receive_calls, 0U, __ATOMIC_RELEASE);
  __atomic_store_n(&deliveries, 0U, __ATOMIC_RELEASE);
}

enum iterate_kit_status
iterate_kit_esp_idf_websocket_connection_prepare(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    const struct
        iterate_kit_esp_idf_websocket_connection_options *options) {
  struct iterate_kit_websocket_tx_options tx_options;
  if (connection == NULL ||
      options == NULL ||
      options->receive_storage == NULL ||
      options->transmit_storage == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(connection, 0, sizeof(*connection));
  connection->options = *options;
  tx_options = (struct iterate_kit_websocket_tx_options){
    .frame_storage = options->transmit_storage,
    .frame_storage_capacity = options->transmit_storage_capacity,
    .raw_write = raw_write,
    .raw_write_context = connection,
    .random = random_mask,
    .random_context = connection,
  };
  if (iterate_kit_websocket_tx_init(
          &connection->tx, &tx_options) != ITERATE_KIT_OK) {
    return ITERATE_KIT_STATE_ERROR;
  }
  connection->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status
iterate_kit_esp_idf_websocket_connection_open(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    int timeout_ms) {
  (void)timeout_ms;
  if (connection == NULL || !connection->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  connection->connected = true;
  /*
   * Non-null sentinels let production stop_websocket() take its ordinary open
   * path. They are never dereferenced by this whole-adapter fake.
   */
  connection->parent = connection;
  connection->websocket = connection;
  return ITERATE_KIT_OK;
}

enum iterate_kit_esp_idf_websocket_receive_result
iterate_kit_esp_idf_websocket_connection_receive(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    int timeout_ms,
    struct iterate_kit_esp_idf_websocket_chunk *chunk) {
  (void)timeout_ms;
  if (connection == NULL || chunk == NULL || !connection->connected) {
    return ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_DISCONNECTED;
  }
  const uint32_t index = __atomic_load_n(
      &next_pending_item, __ATOMIC_ACQUIRE);
  (void)__atomic_fetch_add(
      &receive_calls, 1U, __ATOMIC_RELAXED);
  if (index >= __atomic_load_n(
          &pending_item_count, __ATOMIC_ACQUIRE)) {
    return ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_IDLE;
  }
  __atomic_store_n(
      &next_pending_item, index + 1U, __ATOMIC_RELEASE);
  *chunk = (struct iterate_kit_esp_idf_websocket_chunk){
    .bytes = pending_items[index].byte_count > 0U
        ? pending_items[index].frame
        : NULL,
    .byte_count = pending_items[index].byte_count,
    .payload_size = pending_items[index].byte_count,
    .payload_offset = 0U,
    .opcode = (uint8_t)ITERATE_KIT_WEBSOCKET_BINARY,
    .final = true,
  };
  (void)__atomic_fetch_add(
      &deliveries, 1U, __ATOMIC_RELAXED);
  return ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_DATA;
}

enum iterate_kit_websocket_tx_result
iterate_kit_esp_idf_websocket_connection_send(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    enum iterate_kit_websocket_opcode opcode,
    const void *payload,
    size_t payload_size) {
  if (connection == NULL || !connection->connected) {
    return ITERATE_KIT_WEBSOCKET_TX_DISCONNECTED;
  }
  return iterate_kit_websocket_tx_send(
      &connection->tx, opcode, payload, payload_size);
}

enum iterate_kit_websocket_tx_result
iterate_kit_esp_idf_websocket_connection_service_control(
    struct iterate_kit_esp_idf_websocket_connection *connection) {
  if (connection == NULL || !connection->connected) {
    return ITERATE_KIT_WEBSOCKET_TX_DISCONNECTED;
  }
  return iterate_kit_websocket_tx_poll_control(&connection->tx);
}

void iterate_kit_esp_idf_websocket_connection_close(
    struct iterate_kit_esp_idf_websocket_connection *connection) {
  if (connection == NULL || !connection->initialized) {
    return;
  }
  connection->connected = false;
  connection->parent = NULL;
  connection->websocket = NULL;
  iterate_kit_websocket_tx_reset(&connection->tx);
}

void iterate_kit_esp_idf_websocket_connection_metrics(
    const struct iterate_kit_esp_idf_websocket_connection *connection,
    struct iterate_kit_esp_idf_websocket_connection_metrics *metrics) {
  if (metrics == NULL) {
    return;
  }
  memset(metrics, 0, sizeof(*metrics));
  if (connection != NULL && connection->initialized) {
    iterate_kit_websocket_tx_metrics(
        &connection->tx, &metrics->tx);
  }
}
