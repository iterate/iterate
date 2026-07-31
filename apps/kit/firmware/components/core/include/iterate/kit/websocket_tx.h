#ifndef ITERATE_KIT_WEBSOCKET_TX_H
#define ITERATE_KIT_WEBSOCKET_TX_H

#include "iterate/kit/status.h"
#include "iterate/kit/websocket_frame_writer.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Result from one nonblocking write to the already-connected byte stream.
 *
 * WROTE requires 1..byte_count bytes_written. WOULD_BLOCK and DISCONNECTED
 * require zero bytes_written. The byte stream callback never owns `bytes`.
 */
enum iterate_kit_websocket_tx_raw_write_result {
  ITERATE_KIT_WEBSOCKET_TX_RAW_WROTE = 0,
  ITERATE_KIT_WEBSOCKET_TX_RAW_WOULD_BLOCK,
  ITERATE_KIT_WEBSOCKET_TX_RAW_DISCONNECTED,
};

typedef enum iterate_kit_websocket_tx_raw_write_result
    (*iterate_kit_websocket_tx_raw_write_fn)(
        void *context,
        const uint8_t *bytes,
        size_t byte_count,
        size_t *bytes_written);

typedef enum iterate_kit_status
    (*iterate_kit_websocket_tx_random_fn)(
        void *context, uint8_t *bytes, size_t byte_count);

enum iterate_kit_websocket_tx_result {
  ITERATE_KIT_WEBSOCKET_TX_IDLE = 0,
  ITERATE_KIT_WEBSOCKET_TX_SENT,
  ITERATE_KIT_WEBSOCKET_TX_PROGRESS,
  ITERATE_KIT_WEBSOCKET_TX_DEFERRED,
  ITERATE_KIT_WEBSOCKET_TX_DISCONNECTED,
  ITERATE_KIT_WEBSOCKET_TX_FAILED,
};

struct iterate_kit_websocket_tx_options {
  uint8_t *frame_storage;
  size_t frame_storage_capacity;
  iterate_kit_websocket_tx_raw_write_fn raw_write;
  void *raw_write_context;
  iterate_kit_websocket_tx_random_fn random;
  void *random_context;
};

/**
 * Exact occupancy of the user-space WebSocket transmitter.
 *
 * `pending_wire_bytes` includes the unsent portion of the active masked frame
 * plus the complete wire size of both bounded control obligations when queued.
 * Bytes disappear from this count when the raw transport accepts them; from
 * that boundary onward TLS/lwIP/Wi-Fi occupancy is opaque and must be
 * represented separately.
 *
 * The owner updates these fields atomically so another task can take a
 * diagnostic snapshot without racing the hot path. Capacity is the fixed frame
 * workspace plus the two fixed pending-control slots, not a claim about kernel
 * or radio buffers.
 */
struct iterate_kit_websocket_tx_metrics {
  uint32_t pending_wire_bytes;
  uint32_t maximum_pending_wire_bytes;
  uint32_t capacity_wire_bytes;
};

enum iterate_kit_websocket_tx_active_kind {
  ITERATE_KIT_WEBSOCKET_TX_ACTIVE_NONE = 0,
  ITERATE_KIT_WEBSOCKET_TX_ACTIVE_DATA,
  ITERATE_KIT_WEBSOCKET_TX_ACTIVE_CONTROL,
};

/**
 * Allocation-free, single-owner RFC 6455 transmit state machine.
 *
 * Exactly one caller/task owns this object. A short byte-stream write resumes
 * the same masked frame. Control frames may wait behind a partially written
 * data frame, but they are never interleaved into that frame.
 *
 * There are deliberately two, and only two, pending control obligations:
 *
 * - one CLOSE replying to peer shutdown; and
 * - one mandatory PONG replying to the peer's latest PING.
 *
 * Client-originated PING is intentionally not admitted here. A PONG proves
 * only ordered parsing on this WebSocket hop, so using it as PCM delivery
 * credit caused long push-to-talk to stall behind a false acknowledgement
 * boundary. A general queue would turn network stalls into memory growth.
 *
 * The pending-byte fields are atomic publications for diagnostics only. They
 * do not transfer ownership and must never be used by another task to drive
 * transmission.
 */
struct iterate_kit_websocket_tx {
  struct iterate_kit_websocket_tx_options options;
  struct iterate_kit_websocket_frame_writer frame;
  uint8_t pending_close_payload[
      ITERATE_KIT_WEBSOCKET_CONTROL_PAYLOAD_MAX_BYTES];
  uint8_t pending_reply_pong_payload[
      ITERATE_KIT_WEBSOCKET_CONTROL_PAYLOAD_MAX_BYTES];
  size_t pending_close_payload_size;
  size_t pending_reply_pong_payload_size;
  size_t active_data_payload_size;
  enum iterate_kit_websocket_opcode active_control_opcode;
  enum iterate_kit_websocket_opcode active_data_opcode;
  enum iterate_kit_websocket_tx_active_kind active_kind;
  uint32_t pending_wire_bytes;
  uint32_t maximum_pending_wire_bytes;
  bool close_pending;
  bool reply_pong_pending;
  bool initialized;
};

enum iterate_kit_status iterate_kit_websocket_tx_init(
    struct iterate_kit_websocket_tx *tx,
    const struct iterate_kit_websocket_tx_options *options);

/**
 * Starts or resumes one data frame. While a frame is active, callers must
 * offer the same logical frame (opcode and payload size) until SENT.
 */
enum iterate_kit_websocket_tx_result
iterate_kit_websocket_tx_send(
    struct iterate_kit_websocket_tx *tx,
    enum iterate_kit_websocket_opcode opcode,
    const void *payload,
    size_t payload_size);

/**
 * Copies a bounded PONG or CLOSE obligation into its fixed slot. A newer PONG
 * replaces the older pending reply because RFC 6455 permits replying to the
 * latest processed PING. CLOSE replaces pending PONG because no later traffic
 * is useful once shutdown begins. Client PING returns INVALID_ARGUMENT: hop
 * liveness must never become PCM admission credit.
 */
enum iterate_kit_status iterate_kit_websocket_tx_queue_control(
    struct iterate_kit_websocket_tx *tx,
    enum iterate_kit_websocket_opcode opcode,
    const void *payload,
    size_t payload_size);

/**
 * Starts or resumes a pending control frame. Returns DEFERRED while a data
 * frame still owns the wire, and IDLE when no control frame needs service.
 * CLOSE wins over a pending reply PONG. No client-originated keepalive is
 * generated by this state machine.
 */
enum iterate_kit_websocket_tx_result
iterate_kit_websocket_tx_poll_control(
    struct iterate_kit_websocket_tx *tx);

/**
 * Discards all connection-bound transmit state after disconnect/restart.
 */
void iterate_kit_websocket_tx_reset(
    struct iterate_kit_websocket_tx *tx);

void iterate_kit_websocket_tx_metrics(
    const struct iterate_kit_websocket_tx *tx,
    struct iterate_kit_websocket_tx_metrics *metrics);

#ifdef __cplusplus
}
#endif

#endif
