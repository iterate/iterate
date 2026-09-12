#include "iterate/kit/platforms/esp_idf_websocket_connection.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition)                                                     \
  do {                                                                       \
    if (!(condition)) {                                                      \
      fprintf(stderr, "%s:%d: check failed: %s\n",                         \
              __FILE__, __LINE__, #condition);                              \
      abort();                                                               \
    }                                                                        \
  } while (0)

struct raw_writer {
  uint8_t bytes[32];
  size_t count;
};

static enum iterate_kit_websocket_tx_raw_write_result raw_write(
    void *context,
    const uint8_t *bytes,
    size_t byte_count,
    size_t *bytes_written) {
  struct raw_writer *writer = context;
  CHECK(byte_count <= sizeof(writer->bytes) - writer->count);
  memcpy(writer->bytes + writer->count, bytes, byte_count);
  writer->count += byte_count;
  *bytes_written = byte_count;
  return ITERATE_KIT_WEBSOCKET_TX_RAW_WROTE;
}

static enum iterate_kit_status random_bytes(
    void *context, uint8_t *bytes, size_t byte_count) {
  uint8_t *next = context;
  size_t index;
  for (index = 0U; index < byte_count; ++index) bytes[index] = (*next)++;
  return ITERATE_KIT_OK;
}

static void initialize(
    struct iterate_kit_websocket_tx *tx,
    uint8_t *storage,
    struct raw_writer *writer,
    uint8_t *next_random) {
  const struct iterate_kit_websocket_tx_options options = {
    .frame_storage = storage,
    .frame_storage_capacity =
        ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(0U),
    .raw_write = raw_write,
    .raw_write_context = writer,
    .random = random_bytes,
    .random_context = next_random,
  };
  CHECK(iterate_kit_websocket_tx_init(tx, &options) == ITERATE_KIT_OK);
}

static void inbound_silence_queues_once_and_fresh_inbound_defers_it(void) {
  enum { INTERVAL_US = 120000000 };
  uint8_t storage[ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(0U)];
  uint8_t next_random = 1U;
  struct raw_writer writer = {0};
  struct iterate_kit_esp_idf_websocket_connection connection = {0};

  initialize(&connection.tx, storage, &writer, &next_random);
  connection.last_inbound_us = 1;

  /* Continuous microphone writes must not defer the PING. */
  connection.last_outbound_us = INTERVAL_US + 2;
  CHECK(iterate_kit_esp_idf_websocket_queue_keepalive(
      &connection, INTERVAL_US + 2, INTERVAL_US));
  CHECK(connection.last_probe_us == INTERVAL_US + 2);
  CHECK(!iterate_kit_esp_idf_websocket_queue_keepalive(
      &connection, INTERVAL_US + 3, INTERVAL_US));
  CHECK(iterate_kit_websocket_tx_poll_control(&connection.tx) ==
      ITERATE_KIT_WEBSOCKET_TX_SENT);
  CHECK(writer.count == 6U);
  CHECK(writer.bytes[0] == 0x89U); /* masked RFC 6455 PING */

  /* A peer frame resets the inbound lease, so the next PING waits again. */
  connection.last_inbound_us = 2 * INTERVAL_US - 1;
  connection.last_outbound_us = 2 * INTERVAL_US;
  CHECK(!iterate_kit_esp_idf_websocket_queue_keepalive(
      &connection, 2 * INTERVAL_US, INTERVAL_US));
  connection.last_outbound_us = 3 * INTERVAL_US + 1;
  CHECK(iterate_kit_esp_idf_websocket_queue_keepalive(
      &connection, 3 * INTERVAL_US + 1, INTERVAL_US));
}

int main(void) {
  inbound_silence_queues_once_and_fresh_inbound_defers_it();
  return 0;
}
