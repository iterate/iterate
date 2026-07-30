#include "iterate/kit/websocket_frame_writer.h"

#include <limits.h>
#include <string.h>

/*
 * A WebSocket frame is one immutable wire object once any byte has reached
 * TLS. Short writes must resume the same header, mask key, masked payload, and
 * offset; regenerating a frame after EAGAIN would corrupt the ordered stream
 * and could replay PCM with a different mask. This writer materializes that
 * whole object in caller-owned fixed storage, then exposes only a monotonic
 * pending/advance cursor.
 *
 * Copying/masking one 640-byte audio frame costs a bounded pass and one 648-byte
 * workspace, but avoids retaining a platform callback's borrowed microphone
 * pointer across arbitrary network stalls. Scatter/gather masking in the raw
 * transport was rejected for the MVP because ESP-IDF's TLS API still permits
 * partial writes and would spread cursor ownership across several layers.
 *
 * The writer performs no I/O, allocation, waiting, random generation, or
 * retry. One connection owner serializes access. Reset abandons only local
 * bytes; the caller must also close the socket generation to destroy any
 * suffix already accepted by TLS/lwIP/Wi-Fi.
 */

static bool valid_opcode(
    enum iterate_kit_websocket_opcode opcode) {
  return opcode == ITERATE_KIT_WEBSOCKET_TEXT ||
      opcode == ITERATE_KIT_WEBSOCKET_BINARY ||
      opcode == ITERATE_KIT_WEBSOCKET_CLOSE ||
      opcode == ITERATE_KIT_WEBSOCKET_PING ||
      opcode == ITERATE_KIT_WEBSOCKET_PONG;
}

static bool control_opcode(
    enum iterate_kit_websocket_opcode opcode) {
  return opcode == ITERATE_KIT_WEBSOCKET_CLOSE ||
      opcode == ITERATE_KIT_WEBSOCKET_PING ||
      opcode == ITERATE_KIT_WEBSOCKET_PONG;
}

enum iterate_kit_status iterate_kit_websocket_frame_writer_init(
    struct iterate_kit_websocket_frame_writer *writer,
    uint8_t *storage,
    size_t storage_capacity) {
  if (writer == NULL ||
      storage == NULL ||
      storage_capacity < 6U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(writer, 0, sizeof(*writer));
  writer->storage = storage;
  writer->storage_capacity = storage_capacity;
  writer->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_websocket_frame_writer_begin(
    struct iterate_kit_websocket_frame_writer *writer,
    enum iterate_kit_websocket_opcode opcode,
    const void *payload,
    size_t payload_size,
    const uint8_t mask[4]) {
  const uint8_t *payload_bytes = payload;
  uint64_t wire_payload_size = (uint64_t)payload_size;
  size_t header_size;
  size_t mask_offset;
  size_t payload_offset;
  size_t index;

  if (writer == NULL ||
      !writer->initialized ||
      mask == NULL ||
      !valid_opcode(opcode) ||
      (payload == NULL && payload_size > 0U) ||
      (control_opcode(opcode) && payload_size > 125U)) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (iterate_kit_websocket_frame_writer_busy(writer)) {
    return ITERATE_KIT_BACKPRESSURE;
  }
  if (payload_size > SIZE_MAX -
          (ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(0U))) {
    return ITERATE_KIT_LIMIT;
  }
  header_size =
      ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(payload_size) -
      payload_size;
  if (header_size > writer->storage_capacity ||
      payload_size > writer->storage_capacity - header_size) {
    return ITERATE_KIT_LIMIT;
  }

  writer->storage[0] = (uint8_t)(0x80U | (uint8_t)opcode);
  if (payload_size <= 125U) {
    writer->storage[1] = (uint8_t)(0x80U | payload_size);
    mask_offset = 2U;
  } else if (payload_size <= 65535U) {
    writer->storage[1] = 0xfeU;
    writer->storage[2] =
        (uint8_t)(wire_payload_size >> 8U);
    writer->storage[3] = (uint8_t)wire_payload_size;
    mask_offset = 4U;
  } else {
    unsigned int byte;
    writer->storage[1] = 0xffU;
    for (byte = 0U; byte < 8U; ++byte) {
      writer->storage[2U + byte] = (uint8_t)(
          wire_payload_size >> (56U - 8U * byte));
    }
    mask_offset = 10U;
  }
  memcpy(writer->storage + mask_offset, mask, 4U);
  payload_offset = mask_offset + 4U;
  /*
   * RFC 6455 requires every client frame to be masked. Pre-masking once keeps
   * each later nonblocking write a single contiguous slice and ensures retries
   * cannot accidentally advance the four-byte mask phase independently of the
   * byte-stream cursor.
   */
  for (index = 0U; index < payload_size; ++index) {
    writer->storage[payload_offset + index] =
        (uint8_t)(payload_bytes[index] ^ mask[index % 4U]);
  }
  writer->frame_size = payload_offset + payload_size;
  writer->frame_offset = 0U;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_websocket_frame_writer_pending(
    const struct iterate_kit_websocket_frame_writer *writer,
    const uint8_t **bytes,
    size_t *byte_count) {
  if (bytes != NULL) {
    *bytes = NULL;
  }
  if (byte_count != NULL) {
    *byte_count = 0U;
  }
  if (writer == NULL ||
      !writer->initialized ||
      bytes == NULL ||
      byte_count == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (!iterate_kit_websocket_frame_writer_busy(writer)) {
    return ITERATE_KIT_UNAVAILABLE;
  }
  *bytes = writer->storage + writer->frame_offset;
  *byte_count = writer->frame_size - writer->frame_offset;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_websocket_frame_writer_advance(
    struct iterate_kit_websocket_frame_writer *writer,
    size_t byte_count) {
  size_t remaining;
  if (writer == NULL ||
      !writer->initialized ||
      !iterate_kit_websocket_frame_writer_busy(writer) ||
      byte_count == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  remaining = writer->frame_size - writer->frame_offset;
  if (byte_count > remaining) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  writer->frame_offset += byte_count;
  if (writer->frame_offset == writer->frame_size) {
    writer->frame_offset = 0U;
    writer->frame_size = 0U;
  }
  return ITERATE_KIT_OK;
}

void iterate_kit_websocket_frame_writer_reset(
    struct iterate_kit_websocket_frame_writer *writer) {
  if (writer == NULL || !writer->initialized) {
    return;
  }
  writer->frame_size = 0U;
  writer->frame_offset = 0U;
}

bool iterate_kit_websocket_frame_writer_busy(
    const struct iterate_kit_websocket_frame_writer *writer) {
  return writer != NULL &&
      writer->initialized &&
      writer->frame_size > writer->frame_offset;
}
