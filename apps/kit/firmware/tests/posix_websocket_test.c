#include "iterate/kit/itx_outbox_sender.h"
#include "iterate/kit/platforms/posix_websocket_client.h"
#include "iterate/kit/websocket_frame_reader.h"

#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

struct raw_reader {
  const uint8_t *wire;
  size_t wire_size;
  size_t offset;
  unsigned int would_block_count;
};

static enum iterate_kit_websocket_raw_read_result scripted_read(
    void *context,
    uint8_t *bytes,
    size_t capacity,
    size_t *bytes_read) {
  struct raw_reader *reader = context;
  if (reader->would_block_count > 0U) {
    --reader->would_block_count;
    *bytes_read = 0U;
    return ITERATE_KIT_WEBSOCKET_RAW_READ_WOULD_BLOCK;
  }
  if (reader->offset == reader->wire_size) {
    *bytes_read = 0U;
    return ITERATE_KIT_WEBSOCKET_RAW_READ_WOULD_BLOCK;
  }
  *bytes_read = capacity < reader->wire_size - reader->offset
      ? capacity
      : reader->wire_size - reader->offset;
  memcpy(bytes, reader->wire + reader->offset, *bytes_read);
  reader->offset += *bytes_read;
  return ITERATE_KIT_WEBSOCKET_RAW_READ;
}

/*
 * A proxy can split a TLS record after either header byte and then provide no
 * socket progress for several scheduler passes. Reinterpreting WOULD_BLOCK as
 * EOF would reconnect forever; forgetting the partial header would parse the
 * second byte as a new opcode. This proves the decoder retains exact progress.
 */
static void would_block_read_loop_retains_frame_boundary(void) {
  static const uint8_t wire[] = {0x81U, 0x02U, 'o', 'k'};
  uint8_t payload[8];
  struct raw_reader raw = {
    .wire = wire,
    .wire_size = sizeof(wire),
    .would_block_count = 2U,
  };
  struct iterate_kit_websocket_frame_reader reader;
  struct iterate_kit_websocket_rx_read read;
  const struct iterate_kit_websocket_frame_reader_options options = {
    .payload_storage = payload,
    .payload_storage_capacity = sizeof(payload),
    .raw_read = scripted_read,
    .raw_read_context = &raw,
  };
  assert(iterate_kit_websocket_frame_reader_init(
             &reader, &options) == ITERATE_KIT_OK);
  assert(iterate_kit_websocket_frame_reader_poll(
             &reader, &read) == ITERATE_KIT_UNAVAILABLE);
  assert(iterate_kit_websocket_frame_reader_poll(
             &reader, &read) == ITERATE_KIT_UNAVAILABLE);
  assert(iterate_kit_websocket_frame_reader_poll(
             &reader, &read) == ITERATE_KIT_OK);
  assert(read.has_frame);
  assert(read.byte_count == 0U);
  assert(iterate_kit_websocket_frame_reader_poll(
             &reader, &read) == ITERATE_KIT_OK);
  assert(read.has_frame);
  assert(read.opcode == ITERATE_KIT_WEBSOCKET_TEXT);
  assert(read.byte_count == 2U);
  assert(memcmp(read.bytes, "ok", 2U) == 0);
}

struct short_writer {
  const void *first_message;
  size_t first_length;
  unsigned int calls;
};

static enum iterate_kit_websocket_tx_result short_send(
    void *context, const void *message, size_t length) {
  struct short_writer *writer = context;
  ++writer->calls;
  if (writer->calls == 1U) {
    writer->first_message = message;
    writer->first_length = length;
    return ITERATE_KIT_WEBSOCKET_TX_PROGRESS;
  }
  assert(message == writer->first_message);
  assert(length == writer->first_length);
  return ITERATE_KIT_WEBSOCKET_TX_SENT;
}

/*
 * TLS can accept only a frame prefix while the Cap'n Web producer is ready to
 * reuse its next ring slot. Releasing the head after that prefix loses the
 * suffix; reacquiring it emits a duplicate frame. This pins the shared sender
 * to one borrowed slot until the portable writer reports full completion.
 */
static void short_write_resumes_one_outbox_slot(void) {
  uint8_t storage[2][16];
  size_t lengths[2];
  void *slot;
  size_t capacity;
  struct iterate_kit_spsc_ring ring;
  struct iterate_kit_itx_outbox_sender sender;
  struct iterate_kit_itx_outbox_sender_metrics metrics;
  struct short_writer writer = {0};
  assert(iterate_kit_spsc_ring_init(
             &ring, storage, sizeof(storage[0]), 2U, lengths) ==
         ITERATE_KIT_OK);
  assert(iterate_kit_spsc_ring_write_acquire(
             &ring, &slot, &capacity) == ITERATE_KIT_OK);
  assert(capacity >= 3U);
  memcpy(slot, "rpc", 3U);
  assert(iterate_kit_spsc_ring_write_publish(&ring, 3U) == ITERATE_KIT_OK);
  assert(iterate_kit_itx_outbox_sender_init(&sender, &ring) == ITERATE_KIT_OK);
  assert(iterate_kit_itx_outbox_sender_poll(
             &sender, short_send, &writer) ==
         ITERATE_KIT_ITX_OUTBOX_PROGRESS);
  assert(ring.read_acquired);
  assert(iterate_kit_itx_outbox_sender_poll(
             &sender, short_send, &writer) ==
         ITERATE_KIT_ITX_OUTBOX_SENT);
  assert(!ring.read_acquired);
  iterate_kit_itx_outbox_sender_metrics(&sender, &metrics);
  assert(metrics.messages_sent == 1U);
  assert(metrics.messages_discarded == 0U);
  assert(writer.calls == 2U);
}

/*
 * A syntactically valid 101 response from a proxy is not proof it accepted
 * this client's nonce. Pinning RFC 6455's published vector prevents a client
 * from accepting a fixed, stale, or incorrectly concatenated Accept value.
 */
static void handshake_accept_key_matches_rfc_vector(void) {
  char accept[ITERATE_KIT_POSIX_WEBSOCKET_ACCEPT_CAPACITY];
  assert(iterate_kit_posix_websocket_compute_accept(
             "dGhlIHNhbXBsZSBub25jZQ==",
             accept,
             sizeof(accept)) == ITERATE_KIT_OK);
  assert(strcmp(accept, "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=") == 0);
}

int main(void) {
  handshake_accept_key_matches_rfc_vector();
  would_block_read_loop_retains_frame_boundary();
  short_write_resumes_one_outbox_slot();
  return 0;
}
