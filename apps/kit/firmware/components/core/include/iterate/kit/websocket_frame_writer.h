#ifndef ITERATE_KIT_WEBSOCKET_FRAME_WRITER_H
#define ITERATE_KIT_WEBSOCKET_FRAME_WRITER_H

#include "iterate/kit/status.h"
#include "iterate/kit/websocket_protocol.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(payload_bytes)             \
  ((size_t)(payload_bytes) +                                                \
      ((size_t)(payload_bytes) <= 125U                                      \
              ? 6U                                                         \
              : ((size_t)(payload_bytes) <= 65535U ? 8U : 14U)))

/**
 * Allocation-free writer for one complete RFC 6455 client frame.
 *
 * The caller supplies the exact bounded storage. begin() copies and masks one
 * payload into that storage. pending()/advance() then expose a resumable byte
 * stream: a short TLS write advances within the same declared frame rather
 * than emitting a second WebSocket header.
 */
struct iterate_kit_websocket_frame_writer {
  uint8_t *storage;
  size_t storage_capacity;
  size_t frame_size;
  size_t frame_offset;
  bool initialized;
};

enum iterate_kit_status iterate_kit_websocket_frame_writer_init(
    struct iterate_kit_websocket_frame_writer *writer,
    uint8_t *storage,
    size_t storage_capacity);

enum iterate_kit_status iterate_kit_websocket_frame_writer_begin(
    struct iterate_kit_websocket_frame_writer *writer,
    enum iterate_kit_websocket_opcode opcode,
    const void *payload,
    size_t payload_size,
    const uint8_t mask[4]);

enum iterate_kit_status iterate_kit_websocket_frame_writer_pending(
    const struct iterate_kit_websocket_frame_writer *writer,
    const uint8_t **bytes,
    size_t *byte_count);

enum iterate_kit_status iterate_kit_websocket_frame_writer_advance(
    struct iterate_kit_websocket_frame_writer *writer,
    size_t byte_count);

void iterate_kit_websocket_frame_writer_reset(
    struct iterate_kit_websocket_frame_writer *writer);

bool iterate_kit_websocket_frame_writer_busy(
    const struct iterate_kit_websocket_frame_writer *writer);

#ifdef __cplusplus
}
#endif

#endif
