#include "iterate/kit/websocket_frame_reader.h"

#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

struct raw_reader {
  const uint8_t *wire;
  size_t wire_size;
  size_t offset;
  unsigned int would_block_count;
};

static enum iterate_kit_websocket_raw_read_result scripted_read(
    void *context,
    uint8_t *bytes,
    size_t capacity,
    size_t *bytes_read) {
  struct raw_reader *reader = context;
  if (reader->would_block_count > 0U) {
    --reader->would_block_count;
    *bytes_read = 0U;
    return ITERATE_KIT_WEBSOCKET_RAW_READ_WOULD_BLOCK;
  }
  if (reader->offset == reader->wire_size) {
    *bytes_read = 0U;
    return ITERATE_KIT_WEBSOCKET_RAW_READ_WOULD_BLOCK;
  }
  *bytes_read = capacity < reader->wire_size - reader->offset
      ? capacity
      : reader->wire_size - reader->offset;
  memcpy(bytes, reader->wire + reader->offset, *bytes_read);
  reader->offset += *bytes_read;
  return ITERATE_KIT_WEBSOCKET_RAW_READ;
}

/*
 * A proxy can split a TLS record after either header byte and then provide no
 * socket progress for several scheduler passes. Reinterpreting WOULD_BLOCK as
 * EOF would reconnect forever; forgetting the partial header would parse the
 * second byte as a new opcode. This proves the decoder retains exact progress.
 */
static void would_block_read_loop_retains_frame_boundary(void) {
  static const uint8_t wire[] = {0x81U, 0x02U, 'o', 'k'};
  uint8_t payload[8];
  struct raw_reader raw = {
    .wire = wire,
    .wire_size = sizeof(wire),
    .would_block_count = 2U,
  };
  struct iterate_kit_websocket_frame_reader reader;
  struct iterate_kit_websocket_rx_read read;
  const struct iterate_kit_websocket_frame_reader_options options = {
    .payload_storage = payload,
    .payload_storage_capacity = sizeof(payload),
    .raw_read = scripted_read,
    .raw_read_context = &raw,
  };
  assert(iterate_kit_websocket_frame_reader_init(
             &reader, &options) == ITERATE_KIT_OK);
  assert(iterate_kit_websocket_frame_reader_poll(
             &reader, &read) == ITERATE_KIT_UNAVAILABLE);
  assert(iterate_kit_websocket_frame_reader_poll(
             &reader, &read) == ITERATE_KIT_UNAVAILABLE);
  assert(iterate_kit_websocket_frame_reader_poll(
             &reader, &read) == ITERATE_KIT_OK);
  assert(read.has_frame);
  assert(read.byte_count == 0U);
  assert(iterate_kit_websocket_frame_reader_poll(
             &reader, &read) == ITERATE_KIT_OK);
  assert(read.has_frame);
  assert(read.opcode == ITERATE_KIT_WEBSOCKET_TEXT);
  assert(read.byte_count == 2U);
  assert(memcmp(read.bytes, "ok", 2U) == 0);
}

int main(void) {
  would_block_read_loop_retains_frame_boundary();
  return 0;
}
