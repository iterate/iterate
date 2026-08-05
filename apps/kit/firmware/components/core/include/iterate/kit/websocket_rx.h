#ifndef ITERATE_KIT_WEBSOCKET_RX_H
#define ITERATE_KIT_WEBSOCKET_RX_H

#include "iterate/kit/status.h"
#include "iterate/kit/websocket_protocol.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum iterate_kit_websocket_rx_result {
  ITERATE_KIT_WEBSOCKET_RX_IDLE = 0,
  ITERATE_KIT_WEBSOCKET_RX_PARTIAL,
  ITERATE_KIT_WEBSOCKET_RX_DATA,
  ITERATE_KIT_WEBSOCKET_RX_CONTROL,
  ITERATE_KIT_WEBSOCKET_RX_DROPPED,
  ITERATE_KIT_WEBSOCKET_RX_PROTOCOL_FAILURE,
};

/**
 * One read returned by a lower WebSocket transport.
 *
 * `payload_size`, `opcode`, and `final` describe the whole WebSocket frame
 * and must remain stable across short reads. `has_frame` distinguishes an
 * idle read from a zero-length frame, which is consumed and reported as
 * DROPPED. Adapters must set `has_frame` for such a frame even though no
 * payload pointer exists. Once a non-empty frame has started,
 * `byte_count == 0` means that this nonblocking attempt made no payload
 * progress; it does not terminate or restart the frame.
 *
 * That distinction exists because TLS record boundaries, TCP segmentation,
 * retransmission, and ESP-IDF task scheduling are unrelated to WebSocket frame
 * boundaries. A lower adapter that forgets frame metadata across a zero-byte
 * read cannot be repaired here and violates this contract.
 */
struct iterate_kit_websocket_rx_read {
  const uint8_t *bytes;
  size_t byte_count;
  size_t payload_size;
  enum iterate_kit_websocket_opcode opcode;
  bool final;
  bool has_frame;
};

struct iterate_kit_websocket_rx_chunk {
  const uint8_t *bytes;
  size_t byte_count;
  size_t payload_size;
  size_t payload_offset;
  enum iterate_kit_websocket_opcode opcode;
  bool final;
};

/**
 * Allocation-free receive classifier owned by one connection task.
 *
 * Data chunks are borrowed from the lower read buffer. Control frames are
 * accumulated in fixed storage so split pings, pongs, and closes are emitted
 * exactly once with their complete payload. We deliberately do not accumulate
 * data frames: a whole-message copy would spend scarce internal RAM merely to
 * hide normal short reads from the message consumer, which already supports
 * chunked reassembly.
 *
 * The classifier never blocks, allocates, logs, or retains a borrowed data
 * pointer after `feed` returns. `reset` is required when a socket generation is
 * abandoned, because bytes from two TCP connections must never complete one
 * logical WebSocket frame.
 */
struct iterate_kit_websocket_rx {
  uint8_t control_payload[
      ITERATE_KIT_WEBSOCKET_CONTROL_PAYLOAD_MAX_BYTES];
  size_t payload_size;
  size_t payload_offset;
  enum iterate_kit_websocket_opcode opcode;
  bool final;
  bool active;
  bool dropping;
  bool initialized;
};

enum iterate_kit_status iterate_kit_websocket_rx_init(
    struct iterate_kit_websocket_rx *rx);

enum iterate_kit_websocket_rx_result
iterate_kit_websocket_rx_feed(
    struct iterate_kit_websocket_rx *rx,
    const struct iterate_kit_websocket_rx_read *read,
    struct iterate_kit_websocket_rx_chunk *chunk);

void iterate_kit_websocket_rx_reset(
    struct iterate_kit_websocket_rx *rx);

#ifdef __cplusplus
}
#endif

#endif
