#include "iterate/kit/websocket_rx.h"

#include <string.h>

/*
 * This module is the policy boundary between a short-read-oriented transport
 * and message-oriented consumers. The lower layer owns RFC 6455 header parsing;
 * we own only progress across repeated payload reads. Keeping that boundary
 * portable lets the host rig reproduce loss and stalls without ESP-IDF, while
 * keeping the hot path to one small state object and no heap.
 *
 * Remote malformed input is either rejected as a protocol failure when it
 * contradicts an in-progress frame, or drained as DROPPED when its length is
 * known and bounded progress remains possible. The latter avoids converting an
 * irrelevant bad control/empty data frame into delayed audio on a new socket,
 * while still forcing the caller to count the loss visibly.
 */
static bool control_opcode(
    enum iterate_kit_websocket_opcode opcode) {
  return opcode == ITERATE_KIT_WEBSOCKET_CLOSE ||
      opcode == ITERATE_KIT_WEBSOCKET_PING ||
      opcode == ITERATE_KIT_WEBSOCKET_PONG;
}

static bool data_opcode(
    enum iterate_kit_websocket_opcode opcode) {
  return opcode == ITERATE_KIT_WEBSOCKET_TEXT ||
      opcode == ITERATE_KIT_WEBSOCKET_BINARY ||
      opcode == ITERATE_KIT_WEBSOCKET_CONTINUATION;
}

static void clear_active(
    struct iterate_kit_websocket_rx *rx) {
  rx->payload_size = 0U;
  rx->payload_offset = 0U;
  rx->opcode = ITERATE_KIT_WEBSOCKET_CONTINUATION;
  rx->final = false;
  rx->active = false;
  rx->dropping = false;
}

void iterate_kit_websocket_rx_reset(
    struct iterate_kit_websocket_rx *rx) {
  if (rx == NULL || !rx->initialized) {
    return;
  }
  clear_active(rx);
}

enum iterate_kit_status iterate_kit_websocket_rx_init(
    struct iterate_kit_websocket_rx *rx) {
  if (rx == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(rx, 0, sizeof(*rx));
  rx->initialized = true;
  clear_active(rx);
  return ITERATE_KIT_OK;
}

static bool same_frame(
    const struct iterate_kit_websocket_rx *rx,
    const struct iterate_kit_websocket_rx_read *read) {
  return rx->opcode == read->opcode &&
      rx->final == read->final &&
      rx->payload_size == read->payload_size;
}

enum iterate_kit_websocket_rx_result
iterate_kit_websocket_rx_feed(
    struct iterate_kit_websocket_rx *rx,
    const struct iterate_kit_websocket_rx_read *read,
    struct iterate_kit_websocket_rx_chunk *chunk) {
  if (chunk != NULL) {
    memset(chunk, 0, sizeof(*chunk));
  }
  if (rx == NULL ||
      !rx->initialized ||
      read == NULL ||
      chunk == NULL ||
      (read->bytes == NULL && read->byte_count > 0U)) {
    return ITERATE_KIT_WEBSOCKET_RX_PROTOCOL_FAILURE;
  }
  if (!read->has_frame) {
    return read->byte_count == 0U
        ? ITERATE_KIT_WEBSOCKET_RX_IDLE
        : ITERATE_KIT_WEBSOCKET_RX_PROTOCOL_FAILURE;
  }
  if (!rx->active) {
    rx->payload_size = read->payload_size;
    rx->payload_offset = 0U;
    rx->opcode = read->opcode;
    rx->final = read->final;
    rx->active = true;
    rx->dropping =
        (!control_opcode(read->opcode) &&
         !data_opcode(read->opcode)) ||
        (control_opcode(read->opcode) &&
         (!read->final ||
          read->payload_size >
              ITERATE_KIT_WEBSOCKET_CONTROL_PAYLOAD_MAX_BYTES));
  } else if (!same_frame(rx, read)) {
    clear_active(rx);
    return ITERATE_KIT_WEBSOCKET_RX_PROTOCOL_FAILURE;
  }
  if (rx->payload_offset > rx->payload_size ||
      read->byte_count >
          rx->payload_size - rx->payload_offset) {
    clear_active(rx);
    return ITERATE_KIT_WEBSOCKET_RX_PROTOCOL_FAILURE;
  }
  if (data_opcode(rx->opcode)) {
    if (rx->payload_size == 0U) {
      /*
       * PCM EOS is deliberately an ordinary final empty BINARY frame. Keeping
       * it in this ordered data path means it cannot overtake the content it
       * terminates, while `has_frame` keeps it distinct from a transport read
       * that merely made no progress. TEXT has no such meaning, and a
       * non-final empty BINARY frame would require continuation state this
       * bounded classifier intentionally does not retain.
       */
      if (rx->opcode == ITERATE_KIT_WEBSOCKET_BINARY &&
          rx->final) {
        chunk->bytes = NULL;
        chunk->byte_count = 0U;
        chunk->payload_size = 0U;
        chunk->payload_offset = 0U;
        chunk->opcode = rx->opcode;
        chunk->final = true;
        clear_active(rx);
        return ITERATE_KIT_WEBSOCKET_RX_DATA;
      }
      clear_active(rx);
      return ITERATE_KIT_WEBSOCKET_RX_DROPPED;
    }
    /*
     * Frame metadata may remain visible after a nonblocking lower read makes
     * no progress. Emitting DATA here would feed an empty fragment to the PCM
     * lane; clearing state would reinterpret the remaining payload as a new
     * message. Retaining only counters—not a borrowed pointer—makes the wait
     * both safe and allocation-free.
     */
    if (read->byte_count == 0U) {
      return ITERATE_KIT_WEBSOCKET_RX_IDLE;
    }
    chunk->bytes = read->bytes;
    chunk->byte_count = read->byte_count;
    chunk->payload_size = rx->payload_size;
    chunk->payload_offset = rx->payload_offset;
    chunk->opcode = rx->opcode;
    chunk->final = rx->final;
    rx->payload_offset += read->byte_count;
    if (rx->payload_offset == rx->payload_size) {
      clear_active(rx);
    }
    return ITERATE_KIT_WEBSOCKET_RX_DATA;
  }
  if (rx->dropping) {
    rx->payload_offset += read->byte_count;
    if (rx->payload_offset < rx->payload_size) {
      return read->byte_count == 0U
          ? ITERATE_KIT_WEBSOCKET_RX_IDLE
          : ITERATE_KIT_WEBSOCKET_RX_PARTIAL;
    }
    clear_active(rx);
    return ITERATE_KIT_WEBSOCKET_RX_DROPPED;
  }
  if (read->byte_count > 0U) {
    memcpy(
        rx->control_payload + rx->payload_offset,
        read->bytes,
        read->byte_count);
    rx->payload_offset += read->byte_count;
  }
  if (rx->payload_offset < rx->payload_size) {
    return read->byte_count == 0U
        ? ITERATE_KIT_WEBSOCKET_RX_IDLE
        : ITERATE_KIT_WEBSOCKET_RX_PARTIAL;
  }

  chunk->bytes = rx->payload_size > 0U
      ? rx->control_payload
      : NULL;
  chunk->byte_count = rx->payload_size;
  chunk->payload_size = rx->payload_size;
  chunk->payload_offset = 0U;
  chunk->opcode = rx->opcode;
  chunk->final = rx->final;
  clear_active(rx);
  return ITERATE_KIT_WEBSOCKET_RX_CONTROL;
}
