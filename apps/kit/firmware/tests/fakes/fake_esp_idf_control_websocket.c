#include "fake_esp_idf_control_websocket.h"

#include "iterate/kit/platforms/esp_idf_itx_transport.h"
#include "iterate/kit/websocket_protocol.h"

#include <string.h>

enum {
  /*
   * The largest existing test queues two fragments while the network owner is
   * paused. Sixteen leaves room for future interleaving tests without modeling
   * an unbounded peer backlog. Fullness is returned explicitly to the test.
   */
  PENDING_ITEM_CAPACITY = 16,
  PENDING_ITEM_BYTES =
      ITERATE_KIT_ESP_IDF_CONTROL_MESSAGE_CAPACITY,
};

enum pending_kind {
  PENDING_FRAME = 0,
  PENDING_DISCONNECT,
};

struct pending_item {
  uint8_t bytes[PENDING_ITEM_BYTES];
  size_t byte_count;
  size_t payload_size;
  size_t payload_offset;
  uint8_t opcode;
  int error;
  enum pending_kind kind;
  bool final;
};

static struct pending_item pending_items[PENDING_ITEM_CAPACITY];
static struct iterate_kit_esp_idf_websocket_connection
    *active_connection;
static uint32_t producer_sequence;
static uint32_t consumer_sequence;
static uint32_t short_next_write;

static enum iterate_kit_websocket_tx_raw_write_result
raw_write(
    void *context,
    const uint8_t *bytes,
    size_t byte_count,
    size_t *bytes_written) {
  struct iterate_kit_esp_idf_websocket_connection *connection =
      context;
  (void)bytes;
  if (bytes_written == NULL) {
    return ITERATE_KIT_WEBSOCKET_TX_RAW_DISCONNECTED;
  }
  *bytes_written = 0U;
  if (connection == NULL ||
      !connection->connected ||
      byte_count == 0U) {
    return ITERATE_KIT_WEBSOCKET_TX_RAW_DISCONNECTED;
  }
  if (__atomic_exchange_n(
          &short_next_write, 0U, __ATOMIC_ACQ_REL) != 0U &&
      byte_count > 1U) {
    *bytes_written = byte_count - 1U;
    return ITERATE_KIT_WEBSOCKET_TX_RAW_WROTE;
  }
  *bytes_written = byte_count;
  return ITERATE_KIT_WEBSOCKET_TX_RAW_WROTE;
}

static enum iterate_kit_status random_mask(
    void *context, uint8_t *bytes, size_t byte_count) {
  (void)context;
  if (bytes == NULL || byte_count == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(bytes, 0x5a, byte_count);
  return ITERATE_KIT_OK;
}

static void reset_script(void) {
  memset(pending_items, 0, sizeof(pending_items));
  __atomic_store_n(
      &producer_sequence, 0U, __ATOMIC_RELEASE);
  __atomic_store_n(
      &consumer_sequence, 0U, __ATOMIC_RELEASE);
  __atomic_store_n(
      &short_next_write, 0U, __ATOMIC_RELEASE);
}

static enum iterate_kit_status queue_item(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    const struct pending_item *item) {
  const uint32_t producer = __atomic_load_n(
      &producer_sequence, __ATOMIC_RELAXED);
  const uint32_t consumer = __atomic_load_n(
      &consumer_sequence, __ATOMIC_ACQUIRE);
  if (connection == NULL ||
      connection != active_connection ||
      !connection->connected ||
      item == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if ((uint32_t)(producer - consumer) >=
      PENDING_ITEM_CAPACITY) {
    return ITERATE_KIT_BACKPRESSURE;
  }
  pending_items[
      producer & (PENDING_ITEM_CAPACITY - 1U)] = *item;
  /*
   * Publish metadata and copied bytes together. The production network thread
   * is the sole consumer; tests are the sole producer for one fixture.
   */
  __atomic_store_n(
      &producer_sequence, producer + 1U, __ATOMIC_RELEASE);
  return ITERATE_KIT_OK;
}

enum iterate_kit_status
iterate_kit_fake_control_websocket_queue_frame(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    uint8_t opcode,
    const void *data,
    size_t data_length,
    size_t payload_length,
    size_t payload_offset,
    bool final) {
  struct pending_item item = {
    .byte_count = data_length,
    .payload_size = payload_length,
    .payload_offset = payload_offset,
    .opcode = opcode,
    .kind = PENDING_FRAME,
    .final = final,
  };
  if ((data == NULL && data_length > 0U) ||
      data_length > sizeof(item.bytes) ||
      payload_offset > payload_length ||
      data_length > payload_length - payload_offset) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (data_length > 0U) {
    memcpy(item.bytes, data, data_length);
  }
  return queue_item(connection, &item);
}

enum iterate_kit_status
iterate_kit_fake_control_websocket_queue_text(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    const char *data,
    size_t data_length,
    size_t payload_length,
    size_t payload_offset,
    bool final) {
  return iterate_kit_fake_control_websocket_queue_frame(
      connection,
      (uint8_t)ITERATE_KIT_WEBSOCKET_TEXT,
      data,
      data_length,
      payload_length,
      payload_offset,
      final);
}

enum iterate_kit_status
iterate_kit_fake_control_websocket_queue_disconnect(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    int error) {
  const struct pending_item item = {
    .error = error,
    .kind = PENDING_DISCONNECT,
  };
  return queue_item(connection, &item);
}

void iterate_kit_fake_control_websocket_short_next_write(void) {
  __atomic_store_n(
      &short_next_write, 1U, __ATOMIC_RELEASE);
}

uint32_t iterate_kit_fake_control_websocket_pending_items(void) {
  return __atomic_load_n(
             &producer_sequence, __ATOMIC_ACQUIRE) -
      __atomic_load_n(
             &consumer_sequence, __ATOMIC_ACQUIRE);
}

enum iterate_kit_status
iterate_kit_esp_idf_websocket_connection_prepare(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    const struct
        iterate_kit_esp_idf_websocket_connection_options *options) {
  struct iterate_kit_websocket_tx_options tx_options;
  if (connection == NULL ||
      options == NULL ||
      options->url == NULL ||
      options->receive_storage == NULL ||
      options->receive_storage_capacity == 0U ||
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
          &connection->tx, &tx_options) != ITERATE_KIT_OK ||
      iterate_kit_websocket_rx_init(
          &connection->rx) != ITERATE_KIT_OK) {
    memset(connection, 0, sizeof(*connection));
    return ITERATE_KIT_STATE_ERROR;
  }
  reset_script();
  active_connection = connection;
  connection->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status
iterate_kit_esp_idf_websocket_connection_open(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    int timeout_ms) {
  if (connection == NULL ||
      connection != active_connection ||
      !connection->initialized ||
      connection->connected ||
      timeout_ms <= 0) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  connection->connected = true;
  /*
   * Non-NULL sentinels exercise the production close path without pretending
   * the fake owns an ESP transport allocation.
   */
  connection->parent = connection;
  connection->websocket = connection;
  iterate_kit_websocket_rx_reset(&connection->rx);
  iterate_kit_websocket_tx_reset(&connection->tx);
  return ITERATE_KIT_OK;
}

enum iterate_kit_esp_idf_websocket_receive_result
iterate_kit_esp_idf_websocket_connection_receive(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    int timeout_ms,
    struct iterate_kit_esp_idf_websocket_chunk *chunk) {
  uint32_t consumer;
  uint32_t producer;
  struct pending_item *item;
  enum iterate_kit_status control_status;
  if (chunk != NULL) {
    memset(chunk, 0, sizeof(*chunk));
  }
  if (connection == NULL ||
      connection != active_connection ||
      !connection->connected ||
      chunk == NULL ||
      timeout_ms < 0) {
    return
        ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_PROTOCOL_FAILURE;
  }
  consumer = __atomic_load_n(
      &consumer_sequence, __ATOMIC_RELAXED);
  producer = __atomic_load_n(
      &producer_sequence, __ATOMIC_ACQUIRE);
  if (consumer == producer) {
    return ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_IDLE;
  }
  item = &pending_items[
      consumer & (PENDING_ITEM_CAPACITY - 1U)];
  if (item->kind == PENDING_DISCONNECT) {
    connection->last_error = item->error;
    connection->connected = false;
    __atomic_store_n(
        &consumer_sequence, consumer + 1U, __ATOMIC_RELEASE);
    return
        ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_DISCONNECTED;
  }
  if (item->byte_count >
      connection->options.receive_storage_capacity) {
    connection->last_error = ITERATE_KIT_LIMIT;
    __atomic_store_n(
        &consumer_sequence, consumer + 1U, __ATOMIC_RELEASE);
    return
        ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_PROTOCOL_FAILURE;
  }
  if (item->byte_count > 0U) {
    memcpy(
        connection->options.receive_storage,
        item->bytes,
        item->byte_count);
  }
  *chunk = (struct iterate_kit_esp_idf_websocket_chunk){
    .bytes = item->byte_count > 0U
        ? connection->options.receive_storage
        : NULL,
    .byte_count = item->byte_count,
    .payload_size = item->payload_size,
    .payload_offset = item->payload_offset,
    .opcode = item->opcode,
    .final = item->final,
  };
  __atomic_store_n(
      &consumer_sequence, consumer + 1U, __ATOMIC_RELEASE);
  /*
   * Publishing consumer_sequence transfers this slot back to the producer.
   * Read only the caller-owned chunk from this point onward: a fast producer
   * is otherwise allowed to recycle `item` while this function is still
   * interpreting the frame.
   */
  if (chunk->opcode == ITERATE_KIT_WEBSOCKET_PING) {
    control_status = iterate_kit_websocket_tx_queue_control(
        &connection->tx,
        ITERATE_KIT_WEBSOCKET_PONG,
        chunk->bytes,
        chunk->byte_count);
    return control_status == ITERATE_KIT_OK
        ? ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_CONTROL
        : ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_PROTOCOL_FAILURE;
  }
  if (chunk->opcode == ITERATE_KIT_WEBSOCKET_PONG) {
    return ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_CONTROL;
  }
  if (chunk->opcode == ITERATE_KIT_WEBSOCKET_CLOSE) {
    control_status = iterate_kit_websocket_tx_queue_control(
        &connection->tx,
        ITERATE_KIT_WEBSOCKET_CLOSE,
        chunk->bytes,
        chunk->byte_count);
    connection->peer_close_pending = true;
    return control_status == ITERATE_KIT_OK
        ? ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_PEER_CLOSE
        : ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_PROTOCOL_FAILURE;
  }
  return ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_DATA;
}

enum iterate_kit_websocket_tx_result
iterate_kit_esp_idf_websocket_connection_send(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    enum iterate_kit_websocket_opcode opcode,
    const void *payload,
    size_t payload_size) {
  if (connection == NULL ||
      !connection->connected ||
      connection->peer_close_pending) {
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
  connection->peer_close_pending = false;
  connection->parent = NULL;
  connection->websocket = NULL;
  iterate_kit_websocket_rx_reset(&connection->rx);
  iterate_kit_websocket_tx_reset(&connection->tx);
  /*
   * A generation boundary discards scripted bytes not yet observed by the
   * owner, matching destruction of the real TCP stream.
   */
  __atomic_store_n(
      &consumer_sequence,
      __atomic_load_n(
          &producer_sequence, __ATOMIC_ACQUIRE),
      __ATOMIC_RELEASE);
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
