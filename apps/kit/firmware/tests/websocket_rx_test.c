#include "iterate/kit/websocket_rx.h"

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition)                                                     \
  do {                                                                       \
    if (!(condition)) {                                                      \
      fprintf(stderr, "%s:%d: check failed: %s\n",                         \
          __FILE__, __LINE__, #condition);                                   \
      abort();                                                               \
    }                                                                        \
  } while (0)

/*
 * WebSocket libraries commonly write a control header and payload separately,
 * so a one- or two-byte PING can cross lower-transport read boundaries even
 * though it is one RFC 6455 frame. Restarting on that split turns harmless TCP
 * segmentation into a reconnect storm; replying to the first fragment would
 * instead acknowledge a payload the peer never sent. The classifier therefore
 * owns a fixed 125-byte control accumulator and emits exactly one complete
 * control event.
 */
static void a_ping_split_across_reads_is_delivered_once(void) {
  static const uint8_t first[] = {0xa5U};
  static const uint8_t second[] = {0x5aU};
  static const uint8_t expected[] = {0xa5U, 0x5aU};
  struct iterate_kit_websocket_rx rx;
  struct iterate_kit_websocket_rx_chunk chunk;
  struct iterate_kit_websocket_rx_read read = {
    .bytes = first,
    .byte_count = sizeof(first),
    .payload_size = sizeof(expected),
    .opcode = ITERATE_KIT_WEBSOCKET_PING,
    .final = true,
    .has_frame = true,
  };

  CHECK(iterate_kit_websocket_rx_init(&rx) == ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_rx_feed(&rx, &read, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RX_PARTIAL);

  read.bytes = second;
  read.byte_count = sizeof(second);
  CHECK(iterate_kit_websocket_rx_feed(&rx, &read, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RX_CONTROL);
  CHECK(chunk.opcode == ITERATE_KIT_WEBSOCKET_PING);
  CHECK(chunk.final);
  CHECK(chunk.payload_offset == 0U);
  CHECK(chunk.payload_size == sizeof(expected));
  CHECK(chunk.byte_count == sizeof(expected));
  CHECK(memcmp(chunk.bytes, expected, sizeof(expected)) == 0);
}

/*
 * PCM deliberately avoids a second whole-frame receive buffer: the audio lane
 * can consume borrowed chunks directly and thereby saves RAM and a copy. That
 * only works if every short read carries its offset in the original frame, so
 * this test protects the reassembly contract at the zero-copy boundary.
 */
static void data_chunks_preserve_their_frame_offsets(void) {
  static const uint8_t first[] = {0x10U, 0x20U};
  static const uint8_t second[] = {0x30U, 0x40U};
  struct iterate_kit_websocket_rx rx;
  struct iterate_kit_websocket_rx_chunk chunk;
  struct iterate_kit_websocket_rx_read read = {
    .bytes = first,
    .byte_count = sizeof(first),
    .payload_size = sizeof(first) + sizeof(second),
    .opcode = ITERATE_KIT_WEBSOCKET_BINARY,
    .final = true,
    .has_frame = true,
  };

  CHECK(iterate_kit_websocket_rx_init(&rx) == ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_rx_feed(&rx, &read, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RX_DATA);
  CHECK(chunk.bytes == first);
  CHECK(chunk.byte_count == sizeof(first));
  CHECK(chunk.payload_size == sizeof(first) + sizeof(second));
  CHECK(chunk.payload_offset == 0U);

  read.bytes = second;
  read.byte_count = sizeof(second);
  CHECK(iterate_kit_websocket_rx_feed(&rx, &read, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RX_DATA);
  CHECK(chunk.bytes == second);
  CHECK(chunk.byte_count == sizeof(second));
  CHECK(chunk.payload_size == sizeof(first) + sizeof(second));
  CHECK(chunk.payload_offset == sizeof(first));
}

/*
 * RFC 6455 caps control payloads at 125 bytes. A corrupt or hostile peer must
 * not make the fixed accumulator overflow, and one bad frame must not leave
 * state that misclassifies later valid traffic. The outer connection records
 * DROPPED observably; this layer's job is bounded recovery, not logging from
 * the realtime owner.
 */
static void oversized_control_is_dropped_without_poisoning_the_peer(void) {
  static const uint8_t oversized[126] = {0U};
  static const uint8_t valid[] = {0x42U};
  struct iterate_kit_websocket_rx rx;
  struct iterate_kit_websocket_rx_chunk chunk;
  struct iterate_kit_websocket_rx_read read = {
    .bytes = oversized,
    .byte_count = sizeof(oversized),
    .payload_size = sizeof(oversized),
    .opcode = ITERATE_KIT_WEBSOCKET_PING,
    .final = true,
    .has_frame = true,
  };

  CHECK(iterate_kit_websocket_rx_init(&rx) == ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_rx_feed(&rx, &read, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RX_DROPPED);

  read.bytes = valid;
  read.byte_count = sizeof(valid);
  read.payload_size = sizeof(valid);
  CHECK(iterate_kit_websocket_rx_feed(&rx, &read, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RX_CONTROL);
  CHECK(chunk.opcode == ITERATE_KIT_WEBSOCKET_PING);
  CHECK(chunk.byte_count == sizeof(valid));
  CHECK(chunk.bytes[0] == valid[0]);
}

/*
 * The PCM protocol uses one final empty binary frame as its ordered
 * end-of-stream marker. It must travel through the same receive ordering as
 * content: a side-channel "stop" message could overtake buffered PCM and clip
 * the tail. `has_frame` is what distinguishes this real wire frame from an
 * idle nonblocking read, so collapsing the two here would make finite playback
 * impossible to complete cleanly on hardware.
 */
static void a_final_empty_binary_frame_is_delivered_as_data(void) {
  static const uint8_t valid[] = {0x11U};
  struct iterate_kit_websocket_rx rx;
  struct iterate_kit_websocket_rx_chunk chunk;
  struct iterate_kit_websocket_rx_read read = {
    .bytes = NULL,
    .byte_count = 0U,
    .payload_size = 0U,
    .opcode = ITERATE_KIT_WEBSOCKET_BINARY,
    .final = true,
    .has_frame = true,
  };

  CHECK(iterate_kit_websocket_rx_init(&rx) == ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_rx_feed(&rx, &read, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RX_DATA);
  CHECK(chunk.bytes == NULL);
  CHECK(chunk.byte_count == 0U);
  CHECK(chunk.payload_size == 0U);
  CHECK(chunk.payload_offset == 0U);
  CHECK(chunk.opcode == ITERATE_KIT_WEBSOCKET_BINARY);
  CHECK(chunk.final);

  /*
   * Delivering a zero-length marker must also retire its frame state. Otherwise
   * the first content frame of a later response is mistaken for a metadata
   * change in the still-active marker and forces a reconnect.
   */
  read.bytes = valid;
  read.byte_count = sizeof(valid);
  read.payload_size = sizeof(valid);
  CHECK(iterate_kit_websocket_rx_feed(&rx, &read, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RX_DATA);
  CHECK(chunk.payload_offset == 0U);
  CHECK(chunk.byte_count == sizeof(valid));
  CHECK(chunk.bytes == valid);
}

/*
 * Only binary owns the PCM EOS meaning. Empty text is not a hidden control
 * channel and accepting it would let unrelated Cap'n Web traffic masquerade
 * as audio lifecycle. Keep dropping it observably while preserving the socket.
 */
static void an_empty_text_frame_is_dropped_without_a_restart(void) {
  struct iterate_kit_websocket_rx rx;
  struct iterate_kit_websocket_rx_chunk chunk;
  const struct iterate_kit_websocket_rx_read read = {
    .bytes = NULL,
    .byte_count = 0U,
    .payload_size = 0U,
    .opcode = ITERATE_KIT_WEBSOCKET_TEXT,
    .final = true,
    .has_frame = true,
  };

  CHECK(iterate_kit_websocket_rx_init(&rx) == ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_rx_feed(&rx, &read, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RX_DROPPED);
}

/*
 * Control frames are forbidden from using WebSocket continuation semantics.
 * We reject that remote defect without allocating or carrying a half-control
 * message forever. The classifier must still pass a later continuation to the
 * message-aware text layer—where a stray continuation is rejected—because
 * suppressing every continuation would also break valid fragmented RPCs. A
 * valid PING afterwards proves malformed input cannot poison parser state.
 */
static void fragmented_control_is_dropped_without_poisoning_the_peer(void) {
  static const uint8_t first[] = {0x01U};
  static const uint8_t continuation[] = {0x02U};
  static const uint8_t valid[] = {0x03U};
  struct iterate_kit_websocket_rx rx;
  struct iterate_kit_websocket_rx_chunk chunk;
  struct iterate_kit_websocket_rx_read read = {
    .bytes = first,
    .byte_count = sizeof(first),
    .payload_size = sizeof(first),
    .opcode = ITERATE_KIT_WEBSOCKET_PING,
    .final = false,
    .has_frame = true,
  };

  CHECK(iterate_kit_websocket_rx_init(&rx) == ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_rx_feed(&rx, &read, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RX_DROPPED);

  read.bytes = continuation;
  read.byte_count = sizeof(continuation);
  read.payload_size = sizeof(continuation);
  read.opcode = ITERATE_KIT_WEBSOCKET_CONTINUATION;
  read.final = true;
  CHECK(iterate_kit_websocket_rx_feed(&rx, &read, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RX_DATA);
  CHECK(chunk.opcode == ITERATE_KIT_WEBSOCKET_CONTINUATION);

  read.bytes = valid;
  read.byte_count = sizeof(valid);
  read.payload_size = sizeof(valid);
  read.opcode = ITERATE_KIT_WEBSOCKET_PING;
  CHECK(iterate_kit_websocket_rx_feed(&rx, &read, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RX_CONTROL);
  CHECK(chunk.bytes[0] == valid[0]);
}

/*
 * A nonblocking TLS read can report that a frame is in progress while yielding
 * zero new payload bytes. Treating that as a data chunk sends an empty fragment
 * into the PCM lane and causes a reconnect; resetting the offset makes the next
 * bytes look like a new frame. Preserve the in-progress frame across the idle
 * observation so ordinary packet loss or record splitting cannot corrupt the
 * audio stream.
 */
static void a_zero_byte_payload_stall_preserves_data_offset(void) {
  static const uint8_t first[] = {0x10U, 0x20U};
  static const uint8_t second[] = {0x30U, 0x40U};
  struct iterate_kit_websocket_rx rx;
  struct iterate_kit_websocket_rx_chunk chunk;
  struct iterate_kit_websocket_rx_read read = {
    .bytes = first,
    .byte_count = sizeof(first),
    .payload_size = sizeof(first) + sizeof(second),
    .opcode = ITERATE_KIT_WEBSOCKET_BINARY,
    .final = true,
    .has_frame = true,
  };

  CHECK(iterate_kit_websocket_rx_init(&rx) == ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_rx_feed(&rx, &read, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RX_DATA);
  CHECK(chunk.payload_offset == 0U);

  read.bytes = NULL;
  read.byte_count = 0U;
  CHECK(iterate_kit_websocket_rx_feed(&rx, &read, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RX_IDLE);

  read.bytes = second;
  read.byte_count = sizeof(second);
  CHECK(iterate_kit_websocket_rx_feed(&rx, &read, &chunk) ==
      ITERATE_KIT_WEBSOCKET_RX_DATA);
  CHECK(chunk.bytes == second);
  CHECK(chunk.payload_offset == sizeof(first));
  CHECK(chunk.byte_count == sizeof(second));
}

int main(void) {
  a_ping_split_across_reads_is_delivered_once();
  data_chunks_preserve_their_frame_offsets();
  oversized_control_is_dropped_without_poisoning_the_peer();
  a_final_empty_binary_frame_is_delivered_as_data();
  an_empty_text_frame_is_dropped_without_a_restart();
  fragmented_control_is_dropped_without_poisoning_the_peer();
  a_zero_byte_payload_stall_preserves_data_offset();
  return 0;
}
