#include "iterate/kit/websocket_text.h"

#include <string.h>

/*
 * Cap'n Web emits/accepts logical text messages, while ESP-IDF exposes
 * WebSocket frame fragments and may split one frame across callback chunks.
 * These adapters preserve both boundaries with fixed caller-owned storage.
 *
 * A partial RPC message is never dropped and parsing resumed on the same
 * connection. Any ordering, size, transport, or queue error becomes terminal
 * until explicit reset/reconnect, because guessing the next boundary could
 * splice stale JSON into a later capability call. Direct egress is synchronous;
 * inbox/outbox variants bridge the network and capability tasks through an
 * SPSC ring without blocking or allocation.
 */
static enum capnweb_status egress_fail(
    struct iterate_kit_websocket_text_egress *egress,
    enum capnweb_status status) {
  /*
   * Once BEGIN or DATA has escaped, no local rollback can retract the partial
   * RFC 6455 message. Latching the first failure forces the owner to replace
   * the connection instead of accidentally emitting a new message mid-frame.
   */
  egress->terminal_status = status;
  egress->message_open = false;
  egress->sent_data = false;
  return status;
}

void iterate_kit_websocket_text_egress_init(
    struct iterate_kit_websocket_text_egress *egress,
    iterate_kit_websocket_send_frame_fn send_frame,
    void *context) {
  if (egress == NULL) {
    return;
  }
  *egress = (struct iterate_kit_websocket_text_egress){
    send_frame,
    context,
    false,
    false,
    CAPNWEB_OK,
  };
}

enum capnweb_status iterate_kit_websocket_text_egress_send(
    void *context,
    enum capnweb_text_fragment_kind kind,
    const char *data,
    size_t length) {
  struct iterate_kit_websocket_text_egress *egress = context;
  enum iterate_kit_websocket_text_frame_kind frame_kind;
  enum capnweb_status status;
  if (egress == NULL || egress->send_frame == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (egress->terminal_status != CAPNWEB_OK) {
    return egress->terminal_status;
  }
  if (kind == CAPNWEB_TEXT_BEGIN) {
    if (egress->message_open || data != NULL || length != 0U) {
      return egress_fail(egress, CAPNWEB_E_STATE);
    }
    egress->message_open = true;
    egress->sent_data = false;
    return CAPNWEB_OK;
  }
  if (kind == CAPNWEB_TEXT_DATA) {
    if (!egress->message_open || data == NULL || length == 0U) {
      return egress_fail(egress, CAPNWEB_E_STATE);
    }
    frame_kind = egress->sent_data
        ? ITERATE_KIT_WEBSOCKET_TEXT_CONTINUATION_PARTIAL
        : ITERATE_KIT_WEBSOCKET_TEXT_FIRST_PARTIAL;
    status = egress->send_frame(
        egress->context, frame_kind, data, length);
    if (status != CAPNWEB_OK) {
      return egress_fail(egress, CAPNWEB_E_TRANSPORT);
    }
    egress->sent_data = true;
    return CAPNWEB_OK;
  }
  if (kind == CAPNWEB_TEXT_END) {
    if (!egress->message_open ||
        !egress->sent_data ||
        data != NULL ||
        length != 0U) {
      return egress_fail(egress, CAPNWEB_E_STATE);
    }
    status = egress->send_frame(
        egress->context,
        ITERATE_KIT_WEBSOCKET_TEXT_FINISH,
        NULL,
        0U);
    /*
     * Cap'n Web's END carries no bytes, but RFC 6455 still needs FIN. Sending
     * one empty continuation avoids copying or holding back the final DATA
     * fragment merely to discover whether it was last.
     */
    if (status != CAPNWEB_OK) {
      return egress_fail(egress, CAPNWEB_E_TRANSPORT);
    }
    egress->message_open = false;
    egress->sent_data = false;
    return CAPNWEB_OK;
  }
  return egress_fail(egress, CAPNWEB_E_INVALID_ARGUMENT);
}

static enum capnweb_status ingress_fail(
    struct iterate_kit_websocket_text_ingress *ingress,
    enum capnweb_status status) {
  /*
   * Clear transient cursors for diagnostics/reset hygiene, but retain terminal
   * status. Continuing after a missing/duplicated callback chunk would corrupt
   * JSON even if the byte buffer itself remained in bounds.
   */
  ingress->terminal_status = status;
  ingress->message_open = false;
  ingress->frame_open = false;
  ingress->message_length = 0U;
  ingress->frame_length = 0U;
  ingress->frame_received = 0U;
  return status;
}

enum capnweb_status iterate_kit_websocket_text_ingress_init(
    struct iterate_kit_websocket_text_ingress *ingress,
    char *buffer,
    size_t capacity,
    iterate_kit_websocket_receive_text_fn receive_text,
    void *context) {
  if (ingress == NULL ||
      buffer == NULL ||
      capacity == 0U ||
      receive_text == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  *ingress = (struct iterate_kit_websocket_text_ingress){
    buffer,
    capacity,
    0U,
    0U,
    0U,
    0U,
    false,
    false,
    false,
    receive_text,
    context,
    CAPNWEB_OK,
  };
  return CAPNWEB_OK;
}

enum capnweb_status iterate_kit_websocket_text_ingress_feed(
    struct iterate_kit_websocket_text_ingress *ingress,
    uint8_t opcode,
    bool fin,
    size_t payload_length,
    size_t payload_offset,
    const char *data,
    size_t length) {
  bool frame_finished;
  enum capnweb_status status;
  if (ingress == NULL ||
      (data == NULL && length > 0U)) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (ingress->terminal_status != CAPNWEB_OK) {
    return ingress->terminal_status;
  }
  if (opcode == ITERATE_KIT_WEBSOCKET_CLOSE ||
      opcode == ITERATE_KIT_WEBSOCKET_PING ||
      opcode == ITERATE_KIT_WEBSOCKET_PONG) {
    /*
     * Control frames may appear between fragments of a data message. Validate
     * their RFC 6455 single-frame bound, then leave message cursors untouched;
     * ping/pong/close policy belongs to the transport owner.
     */
    if (!fin ||
        payload_length > 125U ||
        payload_offset != 0U ||
        length != payload_length) {
      return ingress_fail(ingress, CAPNWEB_E_INVALID_MESSAGE);
    }
    return CAPNWEB_OK;
  }
  if (payload_offset == 0U) {
    if (ingress->frame_open) {
      return ingress_fail(ingress, CAPNWEB_E_INVALID_MESSAGE);
    }
    if (opcode == ITERATE_KIT_WEBSOCKET_TEXT) {
      if (ingress->message_open) {
        return ingress_fail(ingress, CAPNWEB_E_INVALID_MESSAGE);
      }
      ingress->message_open = true;
      ingress->message_length = 0U;
    } else if (opcode == ITERATE_KIT_WEBSOCKET_CONTINUATION) {
      if (!ingress->message_open) {
        return ingress_fail(ingress, CAPNWEB_E_INVALID_MESSAGE);
      }
    } else {
      return ingress_fail(ingress, CAPNWEB_E_UNSUPPORTED);
    }
    ingress->frame_open = true;
    /*
     * Preserve frame metadata because ESP-IDF may deliver the payload in
     * several events. Every later chunk must agree exactly, which detects
     * callback loss/reordering instead of silently concatenating wrong bytes.
     */
    ingress->frame_length = payload_length;
    ingress->frame_received = 0U;
    ingress->frame_opcode = opcode;
    ingress->frame_fin = fin;
  } else if (!ingress->frame_open ||
             opcode != ingress->frame_opcode ||
             fin != ingress->frame_fin ||
             payload_length != ingress->frame_length) {
    return ingress_fail(ingress, CAPNWEB_E_INVALID_MESSAGE);
  }
  if (payload_offset != ingress->frame_received ||
      length > ingress->frame_length - ingress->frame_received) {
    return ingress_fail(ingress, CAPNWEB_E_INVALID_MESSAGE);
  }
  if (length > ingress->capacity - ingress->message_length) {
    /*
     * Reject before memcpy using subtraction rather than addition, avoiding
     * size_t overflow. There is intentionally no truncation: truncated JSON
     * must never become a different valid RPC request.
     */
    return ingress_fail(ingress, CAPNWEB_E_LIMIT);
  }
  if (length > 0U) {
    memcpy(
        ingress->buffer + ingress->message_length, data, length);
  }
  ingress->message_length += length;
  ingress->frame_received += length;
  frame_finished =
      ingress->frame_received == ingress->frame_length;
  if (!frame_finished) {
    return CAPNWEB_OK;
  }
  ingress->frame_open = false;
  if (!ingress->frame_fin) {
    return CAPNWEB_OK;
  }
  status = ingress->receive_text(
      ingress->context,
      ingress->buffer,
      ingress->message_length);
  /*
   * Delivery is synchronous, so the caller may reuse the fixed buffer after
   * return. Reset logical-message state before propagating callback failure;
   * terminal_status still prevents any further use on this connection.
   */
  ingress->message_open = false;
  ingress->message_length = 0U;
  ingress->frame_length = 0U;
  ingress->frame_received = 0U;
  if (status != CAPNWEB_OK) {
    return ingress_fail(ingress, status);
  }
  return CAPNWEB_OK;
}

static enum capnweb_status ring_status(
    enum iterate_kit_status status) {
  switch (status) {
    case ITERATE_KIT_OK:
      return CAPNWEB_OK;
    /*
     * A full/unavailable ring means this connection cannot preserve an
     * accepted complete RPC message. Treat it as transport-fatal rather than a
     * retryable protocol condition: Cap'n Web cannot replay half-built output
     * safely.
     */
    case ITERATE_KIT_BACKPRESSURE:
    case ITERATE_KIT_IO_ERROR:
    case ITERATE_KIT_UNAVAILABLE:
      return CAPNWEB_E_TRANSPORT;
    case ITERATE_KIT_LIMIT:
      return CAPNWEB_E_LIMIT;
    case ITERATE_KIT_INVALID_ARGUMENT:
      return CAPNWEB_E_INVALID_ARGUMENT;
    case ITERATE_KIT_STATE_ERROR:
      return CAPNWEB_E_STATE;
  }
  return CAPNWEB_E_TRANSPORT;
}

static enum capnweb_status outbox_fail(
    struct iterate_kit_websocket_text_outbox *outbox,
    enum capnweb_status status) {
  if (outbox->message_open) {
    /*
     * Cancel the unpublished reservation so reconnect/reset can reuse the
     * bounded slot. No consumer has observed it because publication occurs
     * only at END.
     */
    (void)iterate_kit_spsc_ring_write_cancel(outbox->ring);
  }
  outbox->message = NULL;
  outbox->capacity = 0U;
  outbox->length = 0U;
  outbox->message_open = false;
  outbox->terminal_status = status;
  return status;
}

enum capnweb_status iterate_kit_websocket_text_outbox_init(
    struct iterate_kit_websocket_text_outbox *outbox,
    struct iterate_kit_spsc_ring *ring) {
  if (outbox == NULL || ring == NULL || !ring->initialized) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  memset(outbox, 0, sizeof(*outbox));
  outbox->ring = ring;
  return CAPNWEB_OK;
}

enum capnweb_status iterate_kit_websocket_text_outbox_send(
    void *context,
    enum capnweb_text_fragment_kind kind,
    const char *data,
    size_t length) {
  struct iterate_kit_websocket_text_outbox *outbox = context;
  enum iterate_kit_status queue_status;
  void *message;
  size_t capacity;
  if (outbox == NULL || outbox->ring == NULL) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (outbox->terminal_status != CAPNWEB_OK) {
    return outbox->terminal_status;
  }
  if (kind == CAPNWEB_TEXT_BEGIN) {
    if (outbox->message_open || data != NULL || length != 0U) {
      return outbox_fail(outbox, CAPNWEB_E_STATE);
    }
    queue_status = iterate_kit_spsc_ring_write_acquire(
        outbox->ring, &message, &capacity);
    if (queue_status != ITERATE_KIT_OK) {
      return outbox_fail(outbox, ring_status(queue_status));
    }
    outbox->message = message;
    /*
     * Hold exactly one slot across Cap'n Web's fragment callbacks. Building
     * directly there avoids a second message buffer; the one-producer contract
     * guarantees nobody else can claim the reservation meanwhile.
     */
    outbox->capacity = capacity;
    outbox->length = 0U;
    outbox->message_open = true;
    return CAPNWEB_OK;
  }
  if (kind == CAPNWEB_TEXT_DATA) {
    if (!outbox->message_open || data == NULL || length == 0U) {
      return outbox_fail(outbox, CAPNWEB_E_STATE);
    }
    if (length > outbox->capacity - outbox->length) {
      return outbox_fail(outbox, CAPNWEB_E_LIMIT);
    }
    memcpy(outbox->message + outbox->length, data, length);
    outbox->length += length;
    return CAPNWEB_OK;
  }
  if (kind == CAPNWEB_TEXT_END) {
    if (!outbox->message_open || data != NULL || length != 0U) {
      return outbox_fail(outbox, CAPNWEB_E_STATE);
    }
    queue_status = iterate_kit_spsc_ring_write_publish(
        outbox->ring, outbox->length);
    if (queue_status != ITERATE_KIT_OK) {
      return outbox_fail(outbox, ring_status(queue_status));
    }
    outbox->message = NULL;
    /*
     * Publication is the sole visibility point for the network consumer, so it
     * can never observe incomplete JSON even if Cap'n Web emitted many DATA
     * fragments over several calls into this adapter.
     */
    outbox->capacity = 0U;
    outbox->length = 0U;
    outbox->message_open = false;
    return CAPNWEB_OK;
  }
  return outbox_fail(outbox, CAPNWEB_E_INVALID_ARGUMENT);
}

enum capnweb_status iterate_kit_websocket_text_outbox_reset(
    struct iterate_kit_websocket_text_outbox *outbox) {
  struct iterate_kit_spsc_ring *ring;
  if (outbox == NULL ||
      outbox->ring == NULL ||
      !outbox->ring->initialized) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  ring = outbox->ring;
  /*
   * Reset is a lifecycle operation, not error recovery on a live connection.
   * Cancel any private reservation first, then retain only the borrowed ring;
   * callers must already have dealt with the terminal transport generation.
   */
  if (outbox->message_open &&
      iterate_kit_spsc_ring_write_cancel(ring) != ITERATE_KIT_OK) {
    return CAPNWEB_E_STATE;
  }
  memset(outbox, 0, sizeof(*outbox));
  outbox->ring = ring;
  return CAPNWEB_OK;
}

static enum capnweb_status publish_inbox_message(
    void *context, const char *message, size_t length) {
  struct iterate_kit_websocket_text_inbox *inbox = context;
  const enum iterate_kit_status status =
      iterate_kit_spsc_ring_write_publish(inbox->ring, length);
  (void)message;
  /*
   * ingress wrote directly into the currently reserved slot. Publish by length
   * only after the final frame chunk; the capability consumer never sees a
   * partial WebSocket message.
   */
  if (status != ITERATE_KIT_OK) {
    return ring_status(status);
  }
  inbox->write_acquired = false;
  return CAPNWEB_OK;
}

enum capnweb_status iterate_kit_websocket_text_inbox_init(
    struct iterate_kit_websocket_text_inbox *inbox,
    struct iterate_kit_spsc_ring *ring) {
  if (inbox == NULL || ring == NULL || !ring->initialized) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  memset(inbox, 0, sizeof(*inbox));
  inbox->ring = ring;
  return CAPNWEB_OK;
}

enum capnweb_status iterate_kit_websocket_text_inbox_feed(
    struct iterate_kit_websocket_text_inbox *inbox,
    uint8_t opcode,
    bool fin,
    size_t payload_length,
    size_t payload_offset,
    const char *data,
    size_t length) {
  enum capnweb_status status;
  if (inbox == NULL ||
      inbox->ring == NULL ||
      (data == NULL && length > 0U)) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  if (inbox->terminal_status != CAPNWEB_OK) {
    return inbox->terminal_status;
  }
  if (!inbox->write_acquired) {
    void *message;
    size_t capacity;
    const enum iterate_kit_status queue_status =
        iterate_kit_spsc_ring_write_acquire(
            inbox->ring, &message, &capacity);
    if (queue_status != ITERATE_KIT_OK) {
      /*
       * Do not consume/drop a network message when no slot exists. Mark the
       * connection terminal so the peer cannot believe an RPC was delivered
       * while the local capability task never saw it.
       */
      inbox->terminal_status = ring_status(queue_status);
      return inbox->terminal_status;
    }
    status = iterate_kit_websocket_text_ingress_init(
        &inbox->ingress,
        message,
        capacity,
        publish_inbox_message,
        inbox);
    if (status != CAPNWEB_OK) {
      (void)iterate_kit_spsc_ring_write_cancel(inbox->ring);
      inbox->terminal_status = status;
      return status;
    }
    inbox->write_acquired = true;
    /*
     * The reservation persists across all chunks/frames of this one logical
     * message. Interleaved control frames do not publish or release it.
     */
  }

  status = iterate_kit_websocket_text_ingress_feed(
      &inbox->ingress,
      opcode,
      fin,
      payload_length,
      payload_offset,
      data,
      length);
  if (status != CAPNWEB_OK) {
    if (inbox->write_acquired) {
      /*
       * A malformed/oversized partial message remains private. Cancel it before
       * latching failure so the fixed ring has no permanently wedged slot.
       */
      (void)iterate_kit_spsc_ring_write_cancel(inbox->ring);
      inbox->write_acquired = false;
    }
    inbox->terminal_status = status;
  }
  return status;
}

enum capnweb_status iterate_kit_websocket_text_inbox_reset(
    struct iterate_kit_websocket_text_inbox *inbox) {
  struct iterate_kit_spsc_ring *ring;
  if (inbox == NULL ||
      inbox->ring == NULL ||
      !inbox->ring->initialized) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  ring = inbox->ring;
  /*
   * As with outbox reset, this is valid only at a connection boundary. A live
   * peer may still be sending the abandoned message; resetting without closing
   * transport would permit suffix splicing into the next slot.
   */
  if (inbox->write_acquired &&
      iterate_kit_spsc_ring_write_cancel(ring) != ITERATE_KIT_OK) {
    return CAPNWEB_E_STATE;
  }
  memset(inbox, 0, sizeof(*inbox));
  inbox->ring = ring;
  return CAPNWEB_OK;
}
