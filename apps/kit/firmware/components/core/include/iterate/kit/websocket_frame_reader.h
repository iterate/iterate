#ifndef ITERATE_KIT_WEBSOCKET_FRAME_READER_H
#define ITERATE_KIT_WEBSOCKET_FRAME_READER_H

#include "iterate/kit/status.h"
#include "iterate/kit/websocket_rx.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum iterate_kit_websocket_raw_read_result {
  ITERATE_KIT_WEBSOCKET_RAW_READ = 0,
  ITERATE_KIT_WEBSOCKET_RAW_READ_WOULD_BLOCK,
  ITERATE_KIT_WEBSOCKET_RAW_READ_DISCONNECTED,
  ITERATE_KIT_WEBSOCKET_RAW_READ_FAILED,
};

typedef enum iterate_kit_websocket_raw_read_result
    (*iterate_kit_websocket_raw_read_fn)(
        void *context,
        uint8_t *bytes,
        size_t byte_capacity,
        size_t *bytes_read);

struct iterate_kit_websocket_frame_reader_options {
  uint8_t *payload_storage;
  size_t payload_storage_capacity;
  iterate_kit_websocket_raw_read_fn raw_read;
  void *raw_read_context;
};

/**
 * Allocation-free RFC 6455 server-frame decoder for a byte stream.
 *
 * The transport callback is attempted at most once per poll and must never
 * block. Header bytes are retained inline; payload chunks borrow the
 * caller-owned workspace only until the next poll. Server frames must be
 * unmasked, and lengths larger than SIZE_MAX are rejected before any payload
 * is exposed. This object establishes frame boundaries only: fragmented text,
 * ping/pong/close policy, and bounded control accumulation remain owned by
 * websocket_rx and websocket_text.
 */
struct iterate_kit_websocket_frame_reader {
  struct iterate_kit_websocket_frame_reader_options options;
  uint8_t header[10];
  size_t header_size;
  size_t header_needed;
  size_t payload_size;
  size_t payload_offset;
  enum iterate_kit_websocket_opcode opcode;
  bool final;
  bool frame_ready;
  bool initialized;
};

enum iterate_kit_status iterate_kit_websocket_frame_reader_init(
    struct iterate_kit_websocket_frame_reader *reader,
    const struct iterate_kit_websocket_frame_reader_options *options);

/**
 * Performs one bounded lower read and returns metadata suitable for
 * websocket_rx. UNAVAILABLE is ordinary would-block/header progress; IO_ERROR
 * means the generation has lost framing trust and must be replaced.
 */
enum iterate_kit_status iterate_kit_websocket_frame_reader_poll(
    struct iterate_kit_websocket_frame_reader *reader,
    struct iterate_kit_websocket_rx_read *read);

void iterate_kit_websocket_frame_reader_reset(
    struct iterate_kit_websocket_frame_reader *reader);

#ifdef __cplusplus
}
#endif

#endif
