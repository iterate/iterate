#include "iterate/kit/websocket_tx.h"

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

struct fake_raw_writer {
  uint8_t bytes[128];
  size_t byte_count;
  size_t maximum_write;
  unsigned int writes_to_defer;
};

static enum iterate_kit_websocket_tx_raw_write_result
fake_raw_write(
    void *context,
    const uint8_t *bytes,
    size_t byte_count,
    size_t *bytes_written) {
  struct fake_raw_writer *writer = context;
  size_t written;
  *bytes_written = 0U;
  if (writer->writes_to_defer > 0U) {
    writer->writes_to_defer--;
    return ITERATE_KIT_WEBSOCKET_TX_RAW_WOULD_BLOCK;
  }
  written = byte_count < writer->maximum_write
      ? byte_count
      : writer->maximum_write;
  CHECK(written > 0U);
  CHECK(written <= sizeof(writer->bytes) - writer->byte_count);
  memcpy(writer->bytes + writer->byte_count, bytes, written);
  writer->byte_count += written;
  *bytes_written = written;
  return ITERATE_KIT_WEBSOCKET_TX_RAW_WROTE;
}

static enum iterate_kit_status fixed_random(
    void *context, uint8_t *bytes, size_t byte_count) {
  uint8_t *next = context;
  size_t index;
  for (index = 0U; index < byte_count; ++index) {
    bytes[index] = (*next)++;
  }
  return ITERATE_KIT_OK;
}

static void initialize(
    struct iterate_kit_websocket_tx *tx,
    uint8_t *storage,
    size_t storage_size,
    struct fake_raw_writer *raw,
    uint8_t *next_random) {
  const struct iterate_kit_websocket_tx_options options = {
    .frame_storage = storage,
    .frame_storage_capacity = storage_size,
    .raw_write = fake_raw_write,
    .raw_write_context = raw,
    .random = fixed_random,
    .random_context = next_random,
  };
  CHECK(iterate_kit_websocket_tx_init(tx, &options) ==
      ITERATE_KIT_OK);
}

/*
 * A nonblocking TLS socket may accept only a prefix and then report EAGAIN.
 * The transmitter must retain one already-masked RFC 6455 frame and resume at
 * its exact byte offset; rebuilding with a new mask would turn the remainder
 * into corrupt payload, while restarting at byte zero would duplicate speech.
 * The deliberately tiny writes prove recovery without an allocation, copy, or
 * hidden retry loop in the realtime owner task.
 */
static void partial_writes_and_would_block_resume_one_frame(
    void) {
  static const uint8_t payload[] = {0x10U, 0x20U, 0x30U};
  static const uint8_t expected[] = {
    0x82U, 0x83U,
    0x01U, 0x02U, 0x03U, 0x04U,
    0x11U, 0x22U, 0x33U,
  };
  uint8_t storage[
      ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(
          sizeof(payload))];
  uint8_t next_random = 1U;
  struct fake_raw_writer raw = {
    .maximum_write = 2U,
    .writes_to_defer = 1U,
  };
  struct iterate_kit_websocket_tx tx;
  enum iterate_kit_websocket_tx_result result;

  initialize(
      &tx,
      storage,
      sizeof(storage),
      &raw,
      &next_random);
  result = iterate_kit_websocket_tx_send(
      &tx,
      ITERATE_KIT_WEBSOCKET_BINARY,
      payload,
      sizeof(payload));
  CHECK(result == ITERATE_KIT_WEBSOCKET_TX_DEFERRED);
  CHECK(raw.byte_count == 0U);

  do {
    result = iterate_kit_websocket_tx_send(
        &tx,
        ITERATE_KIT_WEBSOCKET_BINARY,
        payload,
        sizeof(payload));
  } while (result == ITERATE_KIT_WEBSOCKET_TX_PROGRESS);

  CHECK(result == ITERATE_KIT_WEBSOCKET_TX_SENT);
  CHECK(raw.byte_count == sizeof(expected));
  CHECK(memcmp(raw.bytes, expected, sizeof(expected)) == 0);
}

/*
 * Server keepalive PINGs can arrive while a PCM frame is only partly inside
 * TLS. A PONG is urgent, but RFC 6455 does not permit its bytes to be inserted
 * into the middle of another frame. Park the reply until the finite PCM frame
 * boundary and then prove the peer observes two valid frames in that order.
 * Closing the socket on every such collision was rejected because ordinary
 * short writes would become audible reconnects.
 */
static void pong_waits_until_the_pcm_frame_boundary(void) {
  static const uint8_t pcm[] = {0x55U, 0x66U, 0x77U};
  static const uint8_t ping_payload[] = {0xa5U, 0x5aU};
  static const uint8_t expected[] = {
    0x82U, 0x83U,
    0x01U, 0x02U, 0x03U, 0x04U,
    0x54U, 0x64U, 0x74U,
    0x8aU, 0x82U,
    0x05U, 0x06U, 0x07U, 0x08U,
    0xa0U, 0x5cU,
  };
  uint8_t storage[
      ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(sizeof(pcm))];
  uint8_t next_random = 1U;
  struct fake_raw_writer raw = {
    .maximum_write = 1U,
  };
  struct iterate_kit_websocket_tx tx;
  enum iterate_kit_websocket_tx_result result;

  initialize(
      &tx,
      storage,
      sizeof(storage),
      &raw,
      &next_random);
  CHECK(iterate_kit_websocket_tx_send(
      &tx,
      ITERATE_KIT_WEBSOCKET_BINARY,
      pcm,
      sizeof(pcm)) == ITERATE_KIT_WEBSOCKET_TX_PROGRESS);
  CHECK(iterate_kit_websocket_tx_queue_control(
      &tx,
      ITERATE_KIT_WEBSOCKET_PONG,
      ping_payload,
      sizeof(ping_payload)) == ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_tx_poll_control(&tx) ==
      ITERATE_KIT_WEBSOCKET_TX_DEFERRED);

  do {
    result = iterate_kit_websocket_tx_send(
        &tx,
        ITERATE_KIT_WEBSOCKET_BINARY,
        pcm,
        sizeof(pcm));
  } while (result == ITERATE_KIT_WEBSOCKET_TX_PROGRESS);
  CHECK(result == ITERATE_KIT_WEBSOCKET_TX_SENT);
  CHECK(raw.byte_count == 9U);

  do {
    result = iterate_kit_websocket_tx_poll_control(&tx);
  } while (result == ITERATE_KIT_WEBSOCKET_TX_PROGRESS);
  CHECK(result == ITERATE_KIT_WEBSOCKET_TX_SENT);
  CHECK(raw.byte_count == sizeof(expected));
  CHECK(memcmp(raw.bytes, expected, sizeof(expected)) == 0);
}

/*
 * A peer may send another PING before the reply to its previous PING has left
 * our fixed control slot. RFC 6455 permits replying only to the most recently
 * processed outstanding PING, which lets the firmware coalesce this burst
 * instead of allocating an unbounded queue during a network stall. Prove the
 * superseded payload cannot leak onto the wire.
 */
static void newest_pending_pong_replaces_the_older_payload(void) {
  static const uint8_t first[] = {1U};
  static const uint8_t second[] = {2U};
  static const uint8_t expected[] = {
    0x8aU, 0x81U,
    0x01U, 0x02U, 0x03U, 0x04U,
    0x03U,
  };
  uint8_t storage[16];
  uint8_t next_random = 1U;
  struct fake_raw_writer raw = {
    .maximum_write = sizeof(raw.bytes),
  };
  struct iterate_kit_websocket_tx tx;

  initialize(
      &tx,
      storage,
      sizeof(storage),
      &raw,
      &next_random);
  CHECK(iterate_kit_websocket_tx_queue_control(
      &tx,
      ITERATE_KIT_WEBSOCKET_PONG,
      first,
      sizeof(first)) == ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_tx_queue_control(
      &tx,
      ITERATE_KIT_WEBSOCKET_PONG,
      second,
      sizeof(second)) == ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_tx_poll_control(&tx) ==
      ITERATE_KIT_WEBSOCKET_TX_SENT);
  CHECK(raw.byte_count == sizeof(expected));
  CHECK(memcmp(raw.bytes, expected, sizeof(expected)) == 0);
}

/*
 * The peer-delivery guard can park its own ping while a partial PCM frame owns
 * the wire. If the server then sends a keepalive ping, dropping the required
 * reply pong can make a healthy but lagged connection fail the server's
 * liveness timeout. Keep both bounded obligations and send the peer response
 * first; allocating a general unbounded control queue is unnecessary.
 */
static void reply_pong_survives_a_parked_client_ping(void) {
  static const uint8_t client_ping[] = {0x11U};
  static const uint8_t reply_pong[] = {0x22U};
  static const uint8_t expected[] = {
    0x8aU, 0x81U,
    0x01U, 0x02U, 0x03U, 0x04U,
    0x23U,
    0x89U, 0x81U,
    0x05U, 0x06U, 0x07U, 0x08U,
    0x14U,
  };
  uint8_t storage[16];
  uint8_t next_random = 1U;
  struct fake_raw_writer raw = {
    .maximum_write = sizeof(raw.bytes),
  };
  struct iterate_kit_websocket_tx tx;

  initialize(
      &tx,
      storage,
      sizeof(storage),
      &raw,
      &next_random);
  CHECK(iterate_kit_websocket_tx_queue_control(
      &tx,
      ITERATE_KIT_WEBSOCKET_PING,
      client_ping,
      sizeof(client_ping)) == ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_tx_queue_control(
      &tx,
      ITERATE_KIT_WEBSOCKET_PONG,
      reply_pong,
      sizeof(reply_pong)) == ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_tx_poll_control(&tx) ==
      ITERATE_KIT_WEBSOCKET_TX_SENT);
  CHECK(iterate_kit_websocket_tx_poll_control(&tx) ==
      ITERATE_KIT_WEBSOCKET_TX_SENT);
  CHECK(raw.byte_count == sizeof(expected));
  CHECK(memcmp(raw.bytes, expected, sizeof(expected)) == 0);
}

/*
 * Once local policy has decided to close a generation, a not-yet-started PONG
 * cannot make that generation useful again. CLOSE must replace the pending
 * reply so shutdown is bounded and no stale audio remains trusted while a
 * lower-priority keepalive drains. This replacement is safe only before any
 * bytes of the PONG have entered the stream; the next test protects the
 * opposite case.
 */
static void close_replaces_a_pending_pong(void) {
  static const uint8_t ping_payload[] = {0xa5U};
  static const uint8_t close_payload[] = {0x03U, 0xe8U};
  static const uint8_t expected[] = {
    0x88U, 0x82U,
    0x01U, 0x02U, 0x03U, 0x04U,
    0x02U, 0xeaU,
  };
  uint8_t storage[16];
  uint8_t next_random = 1U;
  struct fake_raw_writer raw = {
    .maximum_write = sizeof(raw.bytes),
  };
  struct iterate_kit_websocket_tx tx;

  initialize(
      &tx,
      storage,
      sizeof(storage),
      &raw,
      &next_random);
  CHECK(iterate_kit_websocket_tx_queue_control(
      &tx,
      ITERATE_KIT_WEBSOCKET_PONG,
      ping_payload,
      sizeof(ping_payload)) == ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_tx_queue_control(
      &tx,
      ITERATE_KIT_WEBSOCKET_CLOSE,
      close_payload,
      sizeof(close_payload)) == ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_tx_poll_control(&tx) ==
      ITERATE_KIT_WEBSOCKET_TX_SENT);
  CHECK(raw.byte_count == sizeof(expected));
  CHECK(memcmp(raw.bytes, expected, sizeof(expected)) == 0);
}

/*
 * A CLOSE decision can race with a PONG whose header is already partly
 * written. Overwriting that active buffer would produce neither a valid PONG
 * nor a valid CLOSE and could leave the peer parsing masked payload as a new
 * header. Finish the one bounded active control frame, then send CLOSE; the
 * platform remains free to destroy the socket immediately if its own deadline
 * expires.
 */
static void close_waits_behind_an_active_control_frame(void) {
  static const uint8_t pong_payload[] = {0xa5U};
  static const uint8_t close_payload[] = {0x03U, 0xe8U};
  static const uint8_t expected[] = {
    0x8aU, 0x81U,
    0x01U, 0x02U, 0x03U, 0x04U,
    0xa4U,
    0x88U, 0x82U,
    0x05U, 0x06U, 0x07U, 0x08U,
    0x06U, 0xeeU,
  };
  uint8_t storage[16];
  uint8_t next_random = 1U;
  struct fake_raw_writer raw = {
    .maximum_write = 1U,
  };
  struct iterate_kit_websocket_tx tx;
  enum iterate_kit_websocket_tx_result result;

  initialize(
      &tx,
      storage,
      sizeof(storage),
      &raw,
      &next_random);
  CHECK(iterate_kit_websocket_tx_queue_control(
      &tx,
      ITERATE_KIT_WEBSOCKET_PONG,
      pong_payload,
      sizeof(pong_payload)) == ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_tx_poll_control(&tx) ==
      ITERATE_KIT_WEBSOCKET_TX_PROGRESS);
  CHECK(iterate_kit_websocket_tx_queue_control(
      &tx,
      ITERATE_KIT_WEBSOCKET_CLOSE,
      close_payload,
      sizeof(close_payload)) == ITERATE_KIT_OK);

  do {
    result = iterate_kit_websocket_tx_poll_control(&tx);
  } while (result == ITERATE_KIT_WEBSOCKET_TX_PROGRESS);
  CHECK(result == ITERATE_KIT_WEBSOCKET_TX_SENT);
  do {
    result = iterate_kit_websocket_tx_poll_control(&tx);
  } while (result == ITERATE_KIT_WEBSOCKET_TX_PROGRESS);
  CHECK(result == ITERATE_KIT_WEBSOCKET_TX_SENT);
  CHECK(raw.byte_count == sizeof(expected));
  CHECK(memcmp(raw.bytes, expected, sizeof(expected)) == 0);
}

/*
 * This is the last exact queue before bytes enter opaque TLS/lwIP/Wi-Fi
 * storage. Diagnostics need its unsent byte count to distinguish application
 * backlog from lower-layer backlog, including the control frame that may wait
 * behind a partial PCM write. The sequence deliberately defers, partially
 * writes, and drains both frames so a stale cached depth cannot pass.
 */
static void pending_wire_bytes_track_partial_data_and_control(
    void) {
  static const uint8_t pcm[] = {0x55U, 0x66U, 0x77U};
  static const uint8_t ping_payload[] = {0xa5U, 0x5aU};
  uint8_t storage[
      ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(sizeof(pcm))];
  uint8_t next_random = 1U;
  struct fake_raw_writer raw = {
    .maximum_write = 2U,
    .writes_to_defer = 1U,
  };
  struct iterate_kit_websocket_tx tx;
  struct iterate_kit_websocket_tx_metrics metrics;
  enum iterate_kit_websocket_tx_result result;

  initialize(
      &tx,
      storage,
      sizeof(storage),
      &raw,
      &next_random);
  CHECK(iterate_kit_websocket_tx_send(
      &tx,
      ITERATE_KIT_WEBSOCKET_BINARY,
      pcm,
      sizeof(pcm)) == ITERATE_KIT_WEBSOCKET_TX_DEFERRED);
  iterate_kit_websocket_tx_metrics(&tx, &metrics);
  CHECK(metrics.pending_wire_bytes == 9U);

  CHECK(iterate_kit_websocket_tx_queue_control(
      &tx,
      ITERATE_KIT_WEBSOCKET_PING,
      ping_payload,
      sizeof(ping_payload)) == ITERATE_KIT_OK);
  iterate_kit_websocket_tx_metrics(&tx, &metrics);
  CHECK(metrics.pending_wire_bytes == 17U);
  CHECK(metrics.maximum_pending_wire_bytes == 17U);
  CHECK(metrics.capacity_wire_bytes ==
      sizeof(storage) +
          (2U *
           ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(
               ITERATE_KIT_WEBSOCKET_CONTROL_PAYLOAD_MAX_BYTES)));

  CHECK(iterate_kit_websocket_tx_send(
      &tx,
      ITERATE_KIT_WEBSOCKET_BINARY,
      pcm,
      sizeof(pcm)) == ITERATE_KIT_WEBSOCKET_TX_PROGRESS);
  iterate_kit_websocket_tx_metrics(&tx, &metrics);
  CHECK(metrics.pending_wire_bytes == 15U);

  do {
    result = iterate_kit_websocket_tx_send(
        &tx,
        ITERATE_KIT_WEBSOCKET_BINARY,
        pcm,
        sizeof(pcm));
  } while (result == ITERATE_KIT_WEBSOCKET_TX_PROGRESS);
  CHECK(result == ITERATE_KIT_WEBSOCKET_TX_SENT);
  iterate_kit_websocket_tx_metrics(&tx, &metrics);
  CHECK(metrics.pending_wire_bytes == 8U);

  do {
    result = iterate_kit_websocket_tx_poll_control(&tx);
  } while (result == ITERATE_KIT_WEBSOCKET_TX_PROGRESS);
  CHECK(result == ITERATE_KIT_WEBSOCKET_TX_SENT);
  iterate_kit_websocket_tx_metrics(&tx, &metrics);
  CHECK(metrics.pending_wire_bytes == 0U);
  CHECK(metrics.maximum_pending_wire_bytes == 17U);
}

int main(void) {
  partial_writes_and_would_block_resume_one_frame();
  pong_waits_until_the_pcm_frame_boundary();
  newest_pending_pong_replaces_the_older_payload();
  reply_pong_survives_a_parked_client_ping();
  close_replaces_a_pending_pong();
  close_waits_behind_an_active_control_frame();
  pending_wire_bytes_track_partial_data_and_control();
  return 0;
}
