#include "iterate/kit/websocket_frame_reader.h"

#include <limits.h>
#include <string.h>

/*
 * POSIX exposes a TLS byte stream while ESP-IDF happens to expose decoded
 * WebSocket metadata. Keeping this missing wire boundary freestanding lets a
 * host target feed the exact same websocket_rx policy without teaching core
 * about sockets, TLS, or macOS. One raw read per call preserves cooperative
 * scheduling; a caller pumps header and payload progress explicitly.
 */

static void clear_frame(
    struct iterate_kit_websocket_frame_reader *reader) {
  reader->header_size = 0U;
  reader->header_needed = 2U;
  reader->payload_size = 0U;
  reader->payload_offset = 0U;
  reader->opcode = ITERATE_KIT_WEBSOCKET_CONTINUATION;
  reader->final = false;
  reader->frame_ready = false;
}

void iterate_kit_websocket_frame_reader_reset(
    struct iterate_kit_websocket_frame_reader *reader) {
  if (reader == NULL || !reader->initialized) {
    return;
  }
  clear_frame(reader);
}

enum iterate_kit_status iterate_kit_websocket_frame_reader_init(
    struct iterate_kit_websocket_frame_reader *reader,
    const struct iterate_kit_websocket_frame_reader_options *options) {
  if (reader == NULL || options == NULL ||
      options->payload_storage == NULL ||
      options->payload_storage_capacity == 0U ||
      options->raw_read == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(reader, 0, sizeof(*reader));
  reader->options = *options;
  reader->initialized = true;
  clear_frame(reader);
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status read_once(
    struct iterate_kit_websocket_frame_reader *reader,
    uint8_t *destination,
    size_t capacity,
    size_t *byte_count) {
  const enum iterate_kit_websocket_raw_read_result result =
      reader->options.raw_read(
          reader->options.raw_read_context,
          destination,
          capacity,
          byte_count);
  if (result == ITERATE_KIT_WEBSOCKET_RAW_READ) {
    return *byte_count > 0U && *byte_count <= capacity
        ? ITERATE_KIT_OK
        : ITERATE_KIT_IO_ERROR;
  }
  if (*byte_count != 0U) {
    return ITERATE_KIT_IO_ERROR;
  }
  return result == ITERATE_KIT_WEBSOCKET_RAW_READ_WOULD_BLOCK
      ? ITERATE_KIT_UNAVAILABLE
      : ITERATE_KIT_IO_ERROR;
}

static enum iterate_kit_status decode_header(
    struct iterate_kit_websocket_frame_reader *reader) {
  uint64_t payload_size;
  size_t index;
  const uint8_t first = reader->header[0];
  const uint8_t second = reader->header[1];
  const uint8_t length_code = second & 0x7fU;
  if ((first & 0x70U) != 0U || (second & 0x80U) != 0U) {
    /* Extensions were not negotiated and servers must not mask their frames. */
    return ITERATE_KIT_IO_ERROR;
  }
  reader->final = (first & 0x80U) != 0U;
  reader->opcode =
      (enum iterate_kit_websocket_opcode)(first & 0x0fU);
  if (length_code <= 125U) {
    payload_size = length_code;
  } else {
    const size_t length_bytes = length_code == 126U ? 2U : 8U;
    payload_size = 0U;
    for (index = 0U; index < length_bytes; ++index) {
      payload_size = (payload_size << 8U) |
          reader->header[2U + index];
    }
    if ((length_code == 126U && payload_size < 126U) ||
        (length_code == 127U &&
         (payload_size < 65536U ||
          (reader->header[2] & 0x80U) != 0U))) {
      /* Reject non-canonical lengths before exposing attacker-sized state. */
      return ITERATE_KIT_IO_ERROR;
    }
  }
  if (payload_size > (uint64_t)SIZE_MAX) {
    return ITERATE_KIT_LIMIT;
  }
  reader->payload_size = (size_t)payload_size;
  reader->payload_offset = 0U;
  reader->frame_ready = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_websocket_frame_reader_poll(
    struct iterate_kit_websocket_frame_reader *reader,
    struct iterate_kit_websocket_rx_read *read) {
  size_t byte_count = 0U;
  enum iterate_kit_status status;
  if (read != NULL) {
    memset(read, 0, sizeof(*read));
  }
  if (reader == NULL || !reader->initialized || read == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (!reader->frame_ready) {
    status = read_once(
        reader,
        reader->header + reader->header_size,
        reader->header_needed - reader->header_size,
        &byte_count);
    if (status != ITERATE_KIT_OK) {
      return status;
    }
    reader->header_size += byte_count;
    if (reader->header_size < reader->header_needed) {
      return ITERATE_KIT_UNAVAILABLE;
    }
    if (reader->header_needed == 2U) {
      const uint8_t length_code = reader->header[1] & 0x7fU;
      reader->header_needed = length_code <= 125U
          ? 2U
          : (length_code == 126U ? 4U : 10U);
      if (reader->header_size < reader->header_needed) {
        return ITERATE_KIT_UNAVAILABLE;
      }
    }
    status = decode_header(reader);
    if (status != ITERATE_KIT_OK) {
      clear_frame(reader);
      return status;
    }
    if (reader->payload_size > 0U) {
      /*
       * Header completion consumed this poll's one lower read. Publish stable
       * frame metadata with zero payload progress so websocket_rx can retain
       * the boundary, then let the next caller-driven pass read its payload.
       */
      read->payload_size = reader->payload_size;
      read->opcode = reader->opcode;
      read->final = reader->final;
      read->has_frame = true;
      return ITERATE_KIT_OK;
    }
  }

  read->payload_size = reader->payload_size;
  read->opcode = reader->opcode;
  read->final = reader->final;
  read->has_frame = true;
  if (reader->payload_size == 0U) {
    clear_frame(reader);
    return ITERATE_KIT_OK;
  }
  status = read_once(
      reader,
      reader->options.payload_storage,
      reader->payload_size - reader->payload_offset <
              reader->options.payload_storage_capacity
          ? reader->payload_size - reader->payload_offset
          : reader->options.payload_storage_capacity,
      &byte_count);
  if (status == ITERATE_KIT_UNAVAILABLE) {
    return ITERATE_KIT_OK;
  }
  if (status != ITERATE_KIT_OK) {
    clear_frame(reader);
    return status;
  }
  read->bytes = reader->options.payload_storage;
  read->byte_count = byte_count;
  reader->payload_offset += byte_count;
  if (reader->payload_offset == reader->payload_size) {
    clear_frame(reader);
  }
  return ITERATE_KIT_OK;
}
