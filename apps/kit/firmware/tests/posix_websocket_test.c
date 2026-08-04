#include "iterate/kit/itx_outbox_sender.h"
#include "iterate/kit/platforms/posix_websocket_client.h"
#include "iterate/kit/websocket_frame_reader.h"

#include <assert.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

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

static void websocket_url_selects_plain_or_secure_transport(void) {
  uint8_t receive_storage[64];
  uint8_t transmit_storage[64];
  struct iterate_kit_posix_websocket_client client;
  struct iterate_kit_posix_websocket_client_options options = {
    .url = "ws://localhost:8080/api/itx",
    .receive_storage = receive_storage,
    .receive_storage_capacity = sizeof(receive_storage),
    .transmit_storage = transmit_storage,
    .transmit_storage_capacity = sizeof(transmit_storage),
  };
  assert(iterate_kit_posix_websocket_client_prepare(
             &client, &options) == ITERATE_KIT_OK);
  assert(!client.secure);
  assert(!client.stream.use_tls);
  assert(client.port == 8080U);
  assert(strcmp(client.host, "localhost") == 0);
  assert(strcmp(client.path, "/api/itx") == 0);
  iterate_kit_posix_websocket_client_cleanup(&client);

  /* URL selection does not need an external DNS dependency. */
  options.url = "wss://127.0.0.1/socket";
  assert(iterate_kit_posix_websocket_client_prepare(
             &client, &options) == ITERATE_KIT_OK);
  assert(client.secure);
  assert(client.stream.use_tls);
  assert(client.port == 443U);
  iterate_kit_posix_websocket_client_cleanup(&client);

  options.url = "http://localhost/api/itx";
  assert(iterate_kit_posix_websocket_client_prepare(
             &client, &options) == ITERATE_KIT_INVALID_ARGUMENT);
}

static void plain_stream_transfers_bytes_over_loopback(void) {
  static const uint8_t request[] = "ping";
  static const uint8_t response[] = "pong";
  struct sockaddr_in address;
  socklen_t address_length = sizeof(address);
  struct iterate_kit_posix_tls_stream stream;
  struct iterate_kit_posix_tls_stream_options options = {
    /* macOS resolves ::1 first; the listener is deliberately IPv4-only. */
    .host = "localhost",
    .use_tls = false,
  };
  uint8_t bytes[sizeof(response)];
  size_t byte_count = 0U;
  int listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  int peer;
  unsigned int poll_count;
  assert(listener >= 0);
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = 0;
  assert(bind(
             listener,
             (const struct sockaddr *)&address,
             sizeof(address)) == 0);
  assert(getsockname(
             listener,
             (struct sockaddr *)&address,
             &address_length) == 0);
  assert(listen(listener, 1) == 0);
  options.port = ntohs(address.sin_port);
  assert(iterate_kit_posix_tls_stream_prepare(
             &stream, &options) == ITERATE_KIT_OK);
  for (poll_count = 0U; poll_count < 1000U; ++poll_count) {
    const enum iterate_kit_posix_tls_connect_result result =
        iterate_kit_posix_tls_stream_connect(&stream);
    if (result == ITERATE_KIT_POSIX_TLS_CONNECT_READY) {
      break;
    }
    assert(result == ITERATE_KIT_POSIX_TLS_CONNECT_WOULD_BLOCK);
  }
  assert(stream.ready);
  peer = accept(listener, NULL, NULL);
  assert(peer >= 0);
  assert(iterate_kit_posix_tls_stream_write(
             &stream,
             request,
             sizeof(request),
             &byte_count) == ITERATE_KIT_POSIX_TLS_IO_PROGRESS);
  assert(byte_count == sizeof(request));
  assert(read(peer, bytes, sizeof(request)) == (ssize_t)sizeof(request));
  assert(memcmp(bytes, request, sizeof(request)) == 0);
  assert(write(peer, response, sizeof(response)) == (ssize_t)sizeof(response));
  for (poll_count = 0U; poll_count < 1000U; ++poll_count) {
    const enum iterate_kit_posix_tls_io_result result =
        iterate_kit_posix_tls_stream_read(
            &stream, bytes, sizeof(bytes), &byte_count);
    if (result == ITERATE_KIT_POSIX_TLS_IO_PROGRESS) {
      break;
    }
    assert(result == ITERATE_KIT_POSIX_TLS_IO_WOULD_BLOCK);
  }
  assert(byte_count == sizeof(response));
  assert(memcmp(bytes, response, sizeof(response)) == 0);
  iterate_kit_posix_tls_stream_cleanup(&stream);
  assert(close(peer) == 0);
  assert(close(listener) == 0);
}

/*
 * Resolution used to run synchronously in prepare(), before the transport
 * armed its open-attempt deadline. A deliberately unresolvable name must be
 * accepted here without starting DNS; the first connect() poll owns that work
 * and the surrounding transport can therefore cancel it at its deadline.
 */
static void endpoint_resolution_starts_inside_connect(void) {
  struct iterate_kit_posix_tls_stream stream;
  const struct iterate_kit_posix_tls_stream_options options = {
    .host = "deadline-proof.invalid",
    .port = 443U,
    .use_tls = true,
  };
  assert(iterate_kit_posix_tls_stream_prepare(&stream, &options) ==
         ITERATE_KIT_OK);
  assert(stream.resolver == NULL);
  assert(stream.address_count == 0U);
  iterate_kit_posix_tls_stream_cleanup(&stream);
}

int main(void) {
  handshake_accept_key_matches_rfc_vector();
  websocket_url_selects_plain_or_secure_transport();
  plain_stream_transfers_bytes_over_loopback();
  endpoint_resolution_starts_inside_connect();
  would_block_read_loop_retains_frame_boundary();
  short_write_resumes_one_outbox_slot();
  return 0;
}
