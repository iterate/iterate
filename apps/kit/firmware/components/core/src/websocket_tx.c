#include "iterate/kit/websocket_tx.h"

#include <limits.h>
#include <string.h>

#define MAX_CONTROL_WIRE_BYTES                                           \
  ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(                              \
      ITERATE_KIT_WEBSOCKET_CONTROL_PAYLOAD_MAX_BYTES)

/*
 * All application and control bytes for one socket pass through this single-owner
 * state machine. That is what makes RFC 6455 ordering testable: a partially
 * written data frame cannot be interleaved with PONG/CLOSE, but the next
 * frame chosen at a boundary must respect protocol urgency.
 *
 * We retain one active materialized frame plus two coalescing control
 * obligations. One slot is for CLOSE; the other is the mandatory reply to the
 * peer's latest PING. An unbounded control queue consumes RAM during exactly
 * the network fault where memory must stay fixed. CLOSE supersedes an unsent
 * PONG; neither control frame may interrupt an active data frame. There is no
 * client PING path because hop-level echo cannot prove provider receipt.
 *
 * Every public operation performs at most one raw nonblocking write and never
 * allocates, sleeps, retries, or logs. The conductor owns repeated scheduling
 * and freshness deadlines. Reset clears local wire state only; connection
 * replacement must additionally destroy bytes already accepted below the raw
 * callback.
 */

/*
 * Transmission state has one owner, but diagnostics may read these two scalar
 * publications from another core. Relaxed ordering is enough: the snapshot is
 * descriptive and never authorizes a write. Making the whole transmitter
 * cross-task synchronized would add fences to every data chunk for no stronger
 * guarantee.
 */
static uint32_t atomic_load_u32(const uint32_t *value) {
  return __atomic_load_n(value, __ATOMIC_RELAXED);
}

static void atomic_store_u32(
    uint32_t *destination, uint32_t value) {
  __atomic_store_n(destination, value, __ATOMIC_RELAXED);
}

static void atomic_update_max(
    uint32_t *value, uint32_t candidate) {
  uint32_t current = atomic_load_u32(value);
  while (candidate > current &&
         !__atomic_compare_exchange_n(
             value,
             &current,
             candidate,
             false,
             __ATOMIC_RELAXED,
             __ATOMIC_RELAXED)) {
  }
}

static bool data_opcode(
    enum iterate_kit_websocket_opcode opcode) {
  return opcode == ITERATE_KIT_WEBSOCKET_TEXT ||
      opcode == ITERATE_KIT_WEBSOCKET_BINARY;
}

static bool control_opcode(
    enum iterate_kit_websocket_opcode opcode) {
  return opcode == ITERATE_KIT_WEBSOCKET_CLOSE ||
      opcode == ITERATE_KIT_WEBSOCKET_PONG;
}

static void clear_active(
    struct iterate_kit_websocket_tx *tx) {
  tx->active_kind = ITERATE_KIT_WEBSOCKET_TX_ACTIVE_NONE;
  tx->active_data_opcode = ITERATE_KIT_WEBSOCKET_BINARY;
  tx->active_control_opcode = ITERATE_KIT_WEBSOCKET_PONG;
  tx->active_data_payload_size = 0U;
}

/*
 * Publish one exact owner-side snapshot after every transition that changes
 * queued wire bytes. The active frame already contains its RFC 6455 header and
 * mask. Pending controls have not been materialized yet, so account for their
 * deterministic headers here. Both can coexist, but neither can multiply:
 * this is an exact bounded user-space queue, not an estimate. Nothing below
 * the raw_write boundary is included.
 */
static void publish_pending_wire_bytes(
    struct iterate_kit_websocket_tx *tx) {
  size_t pending = 0U;
  if (iterate_kit_websocket_frame_writer_busy(&tx->frame)) {
    pending =
        tx->frame.frame_size - tx->frame.frame_offset;
  }
  if (tx->close_pending) {
    pending += ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(
        tx->pending_close_payload_size);
  }
  if (tx->reply_pong_pending) {
    pending += ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(
        tx->pending_reply_pong_payload_size);
  }
  atomic_store_u32(
      &tx->pending_wire_bytes, (uint32_t)pending);
  atomic_update_max(
      &tx->maximum_pending_wire_bytes, (uint32_t)pending);
}

void iterate_kit_websocket_tx_reset(
    struct iterate_kit_websocket_tx *tx) {
  if (tx == NULL || !tx->initialized) {
    return;
  }
  iterate_kit_websocket_frame_writer_reset(&tx->frame);
  clear_active(tx);
  tx->pending_close_payload_size = 0U;
  tx->pending_reply_pong_payload_size = 0U;
  tx->close_pending = false;
  tx->reply_pong_pending = false;
  publish_pending_wire_bytes(tx);
}

enum iterate_kit_websocket_tx_data_cancel_result
iterate_kit_websocket_tx_cancel_unwritten_data(
    struct iterate_kit_websocket_tx *tx) {
  if (tx == NULL || !tx->initialized) {
    return ITERATE_KIT_WEBSOCKET_TX_DATA_CANCEL_FAILED;
  }
  if (tx->active_kind !=
      ITERATE_KIT_WEBSOCKET_TX_ACTIVE_DATA) {
    return ITERATE_KIT_WEBSOCKET_TX_DATA_NOT_ACTIVE;
  }
  if (!iterate_kit_websocket_frame_writer_busy(&tx->frame)) {
    return ITERATE_KIT_WEBSOCKET_TX_DATA_CANCEL_FAILED;
  }
  if (tx->frame.frame_offset > 0U) {
    return
        ITERATE_KIT_WEBSOCKET_TX_DATA_PARTIALLY_WRITTEN;
  }

  /*
   * Do not call reset(): peer PING/CLOSE obligations may have arrived while
   * this data frame waited for socket capacity. Only the zero-byte data frame
   * is disposable; the next poll_control() must still observe those bounded
   * obligations.
   */
  iterate_kit_websocket_frame_writer_reset(&tx->frame);
  clear_active(tx);
  publish_pending_wire_bytes(tx);
  return ITERATE_KIT_WEBSOCKET_TX_DATA_CANCELLED;
}

enum iterate_kit_status iterate_kit_websocket_tx_init(
    struct iterate_kit_websocket_tx *tx,
    const struct iterate_kit_websocket_tx_options *options) {
  enum iterate_kit_status status;
  if (tx == NULL ||
      options == NULL ||
      options->frame_storage == NULL ||
      options->raw_write == NULL ||
      options->random == NULL ||
      options->frame_storage_capacity >
          (size_t)UINT32_MAX -
              (2U * MAX_CONTROL_WIRE_BYTES)) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(tx, 0, sizeof(*tx));
  status = iterate_kit_websocket_frame_writer_init(
      &tx->frame,
      options->frame_storage,
      options->frame_storage_capacity);
  if (status != ITERATE_KIT_OK) {
    return status;
  }
  tx->options = *options;
  tx->initialized = true;
  iterate_kit_websocket_tx_reset(tx);
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status begin_frame(
    struct iterate_kit_websocket_tx *tx,
    enum iterate_kit_websocket_opcode opcode,
    const void *payload,
    size_t payload_size) {
  uint8_t mask[4];
  enum iterate_kit_status status = tx->options.random(
      tx->options.random_context, mask, sizeof(mask));
  if (status != ITERATE_KIT_OK) {
    return status;
  }
  return iterate_kit_websocket_frame_writer_begin(
      &tx->frame, opcode, payload, payload_size, mask);
}

static enum iterate_kit_websocket_tx_result flush_active(
    struct iterate_kit_websocket_tx *tx) {
  const uint8_t *pending = NULL;
  size_t pending_size = 0U;
  size_t bytes_written = 0U;
  enum iterate_kit_websocket_tx_raw_write_result raw_result;
  enum iterate_kit_status status =
      iterate_kit_websocket_frame_writer_pending(
          &tx->frame, &pending, &pending_size);
  if (status != ITERATE_KIT_OK ||
      tx->active_kind == ITERATE_KIT_WEBSOCKET_TX_ACTIVE_NONE) {
    iterate_kit_websocket_tx_reset(tx);
    return ITERATE_KIT_WEBSOCKET_TX_FAILED;
  }

  raw_result = tx->options.raw_write(
      tx->options.raw_write_context,
      pending,
      pending_size,
      &bytes_written);
  if (raw_result == ITERATE_KIT_WEBSOCKET_TX_RAW_WROTE) {
    if (bytes_written == 0U || bytes_written > pending_size ||
        iterate_kit_websocket_frame_writer_advance(
            &tx->frame, bytes_written) != ITERATE_KIT_OK) {
      iterate_kit_websocket_tx_reset(tx);
      return ITERATE_KIT_WEBSOCKET_TX_FAILED;
    }
    if (iterate_kit_websocket_frame_writer_busy(&tx->frame)) {
      publish_pending_wire_bytes(tx);
      return ITERATE_KIT_WEBSOCKET_TX_PROGRESS;
    }
    clear_active(tx);
    publish_pending_wire_bytes(tx);
    return ITERATE_KIT_WEBSOCKET_TX_SENT;
  }
  if (bytes_written != 0U) {
    iterate_kit_websocket_tx_reset(tx);
    return ITERATE_KIT_WEBSOCKET_TX_FAILED;
  }
  if (raw_result ==
      ITERATE_KIT_WEBSOCKET_TX_RAW_WOULD_BLOCK) {
    return ITERATE_KIT_WEBSOCKET_TX_DEFERRED;
  }
  iterate_kit_websocket_tx_reset(tx);
  return raw_result ==
          ITERATE_KIT_WEBSOCKET_TX_RAW_DISCONNECTED
      ? ITERATE_KIT_WEBSOCKET_TX_DISCONNECTED
      : ITERATE_KIT_WEBSOCKET_TX_FAILED;
}

enum iterate_kit_websocket_tx_result
iterate_kit_websocket_tx_send(
    struct iterate_kit_websocket_tx *tx,
    enum iterate_kit_websocket_opcode opcode,
    const void *payload,
    size_t payload_size) {
  if (tx == NULL ||
      !tx->initialized ||
      !data_opcode(opcode) ||
      (payload == NULL && payload_size > 0U)) {
    return ITERATE_KIT_WEBSOCKET_TX_FAILED;
  }
  if (tx->active_kind ==
      ITERATE_KIT_WEBSOCKET_TX_ACTIVE_CONTROL ||
      (tx->active_kind ==
           ITERATE_KIT_WEBSOCKET_TX_ACTIVE_NONE &&
       (tx->close_pending || tx->reply_pong_pending))) {
    return ITERATE_KIT_WEBSOCKET_TX_DEFERRED;
  }
  if (tx->active_kind ==
      ITERATE_KIT_WEBSOCKET_TX_ACTIVE_DATA) {
    if (tx->active_data_opcode != opcode ||
        tx->active_data_payload_size != payload_size) {
      iterate_kit_websocket_tx_reset(tx);
      return ITERATE_KIT_WEBSOCKET_TX_FAILED;
    }
    return flush_active(tx);
  }
  if (begin_frame(tx, opcode, payload, payload_size) !=
      ITERATE_KIT_OK) {
    return ITERATE_KIT_WEBSOCKET_TX_FAILED;
  }
  tx->active_kind = ITERATE_KIT_WEBSOCKET_TX_ACTIVE_DATA;
  tx->active_data_opcode = opcode;
  tx->active_data_payload_size = payload_size;
  publish_pending_wire_bytes(tx);
  return flush_active(tx);
}

enum iterate_kit_status iterate_kit_websocket_tx_queue_control(
    struct iterate_kit_websocket_tx *tx,
    enum iterate_kit_websocket_opcode opcode,
    const void *payload,
    size_t payload_size) {
  if (tx == NULL ||
      !tx->initialized ||
      !control_opcode(opcode) ||
      (payload == NULL && payload_size > 0U) ||
      payload_size >
          ITERATE_KIT_WEBSOCKET_CONTROL_PAYLOAD_MAX_BYTES) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(payload_size) >
      tx->options.frame_storage_capacity) {
    return ITERATE_KIT_LIMIT;
  }

  /*
   * Once CLOSE owns either the active frame or pending slot, a later PONG
   * cannot make the generation useful again. Reject it so shutdown remains a
   * bounded terminal transition.
   */
  if ((tx->active_kind ==
           ITERATE_KIT_WEBSOCKET_TX_ACTIVE_CONTROL &&
       tx->active_control_opcode ==
           ITERATE_KIT_WEBSOCKET_CLOSE) ||
      (tx->close_pending &&
       opcode != ITERATE_KIT_WEBSOCKET_CLOSE)) {
    return ITERATE_KIT_BACKPRESSURE;
  }

  if (opcode == ITERATE_KIT_WEBSOCKET_PONG) {
    if (payload_size > 0U) {
      memcpy(
          tx->pending_reply_pong_payload,
          payload,
          payload_size);
    }
    tx->pending_reply_pong_payload_size = payload_size;
    tx->reply_pong_pending = true;
    publish_pending_wire_bytes(tx);
    return ITERATE_KIT_OK;
  }

  /*
   * CLOSE supersedes both pending obligations. We cannot cancel an active
   * frame after bytes have reached the stream—the RFC 6455 frame must remain
   * contiguous—but the close will be selected immediately afterward.
   */
  tx->reply_pong_pending = false;
  tx->pending_reply_pong_payload_size = 0U;

  if (payload_size > 0U) {
    memcpy(
        tx->pending_close_payload,
        payload,
        payload_size);
  }
  tx->pending_close_payload_size = payload_size;
  tx->close_pending = true;
  publish_pending_wire_bytes(tx);
  return ITERATE_KIT_OK;
}

enum iterate_kit_websocket_tx_result
iterate_kit_websocket_tx_poll_control(
    struct iterate_kit_websocket_tx *tx) {
  if (tx == NULL || !tx->initialized) {
    return ITERATE_KIT_WEBSOCKET_TX_FAILED;
  }
  if (tx->active_kind ==
      ITERATE_KIT_WEBSOCKET_TX_ACTIVE_DATA) {
    return ITERATE_KIT_WEBSOCKET_TX_DEFERRED;
  }
  if (tx->active_kind ==
      ITERATE_KIT_WEBSOCKET_TX_ACTIVE_CONTROL) {
    return flush_active(tx);
  }
  if (!tx->close_pending && !tx->reply_pong_pending) {
    return ITERATE_KIT_WEBSOCKET_TX_IDLE;
  }

  /*
   * A queued CLOSE is the only work allowed to discard a reply PONG. Once
   * shutdown is requested, replying to an earlier keepalive cannot restore the
   * generation and would only delay its bounded close transition.
   */
  const bool send_reply_pong =
      tx->reply_pong_pending && !tx->close_pending;
  const enum iterate_kit_websocket_opcode opcode =
      send_reply_pong
      ? ITERATE_KIT_WEBSOCKET_PONG
      : ITERATE_KIT_WEBSOCKET_CLOSE;
  const uint8_t *payload = send_reply_pong
      ? tx->pending_reply_pong_payload
      : tx->pending_close_payload;
  const size_t payload_size = send_reply_pong
      ? tx->pending_reply_pong_payload_size
      : tx->pending_close_payload_size;

  if (begin_frame(
          tx,
          opcode,
          payload_size > 0U ? payload : NULL,
          payload_size) != ITERATE_KIT_OK) {
    return ITERATE_KIT_WEBSOCKET_TX_FAILED;
  }
  tx->active_kind =
      ITERATE_KIT_WEBSOCKET_TX_ACTIVE_CONTROL;
  tx->active_control_opcode = opcode;
  if (send_reply_pong) {
    tx->reply_pong_pending = false;
    tx->pending_reply_pong_payload_size = 0U;
  } else {
    tx->close_pending = false;
    tx->pending_close_payload_size = 0U;
  }
  publish_pending_wire_bytes(tx);
  return flush_active(tx);
}

void iterate_kit_websocket_tx_metrics(
    const struct iterate_kit_websocket_tx *tx,
    struct iterate_kit_websocket_tx_metrics *metrics) {
  if (metrics == NULL) {
    return;
  }
  memset(metrics, 0, sizeof(*metrics));
  if (tx == NULL || !tx->initialized) {
    return;
  }
  metrics->pending_wire_bytes =
      atomic_load_u32(&tx->pending_wire_bytes);
  metrics->maximum_pending_wire_bytes =
      atomic_load_u32(&tx->maximum_pending_wire_bytes);
  metrics->capacity_wire_bytes = (uint32_t)(
      tx->options.frame_storage_capacity +
      (2U * MAX_CONTROL_WIRE_BYTES));
}
