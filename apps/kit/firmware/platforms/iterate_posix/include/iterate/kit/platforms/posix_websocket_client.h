#ifndef ITERATE_KIT_PLATFORMS_POSIX_WEBSOCKET_CLIENT_H
#define ITERATE_KIT_PLATFORMS_POSIX_WEBSOCKET_CLIENT_H

#include "iterate/kit/platforms/posix_tls_stream.h"
#include "iterate/kit/status.h"
#include "iterate/kit/websocket_frame_reader.h"
#include "iterate/kit/websocket_rx.h"
#include "iterate/kit/websocket_tx.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  ITERATE_KIT_POSIX_WEBSOCKET_PATH_CAPACITY = 160,
  ITERATE_KIT_POSIX_WEBSOCKET_REQUEST_CAPACITY = 512,
  ITERATE_KIT_POSIX_WEBSOCKET_RESPONSE_CAPACITY = 4096,
  ITERATE_KIT_POSIX_WEBSOCKET_ACCEPT_CAPACITY = 29,
};

enum iterate_kit_posix_websocket_open_result {
  ITERATE_KIT_POSIX_WEBSOCKET_OPEN_READY = 0,
  ITERATE_KIT_POSIX_WEBSOCKET_OPEN_WOULD_BLOCK,
  ITERATE_KIT_POSIX_WEBSOCKET_OPEN_FAILED,
};

enum iterate_kit_posix_websocket_receive_result {
  ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_IDLE = 0,
  ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_DATA,
  ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_CONTROL,
  ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_DROPPED,
  ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_PEER_CLOSE,
  ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_DISCONNECTED,
  ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_PROTOCOL_FAILURE,
};

struct iterate_kit_posix_websocket_chunk {
  const uint8_t *bytes;
  size_t byte_count;
  size_t payload_size;
  size_t payload_offset;
  uint8_t opcode;
  bool final;
};

struct iterate_kit_posix_websocket_client_options {
  const char *url;
  uint8_t *receive_storage;
  size_t receive_storage_capacity;
  uint8_t *transmit_storage;
  size_t transmit_storage_capacity;
  bool DANGEROUS_disable_certificate_verification;
};

/**
 * Poll-driven RFC 6455 client over one POSIX TLS stream.
 *
 * HTTP upgrade, frame parsing, masked transmission, and control obligations
 * all use fixed caller-visible storage. The portable websocket_rx/tx modules
 * remain the policy owners; this adapter supplies only TLS bytes and the
 * bounded HTTP/wire decoding that ESP-IDF otherwise supplies internally.
 */
struct iterate_kit_posix_websocket_client {
  struct iterate_kit_posix_websocket_client_options options;
  struct iterate_kit_posix_tls_stream stream;
  struct iterate_kit_websocket_frame_reader frame_reader;
  struct iterate_kit_websocket_rx rx;
  struct iterate_kit_websocket_tx tx;
  char host[ITERATE_KIT_POSIX_TLS_HOST_CAPACITY];
  char path[ITERATE_KIT_POSIX_WEBSOCKET_PATH_CAPACITY];
  char request[ITERATE_KIT_POSIX_WEBSOCKET_REQUEST_CAPACITY];
  char response[ITERATE_KIT_POSIX_WEBSOCKET_RESPONSE_CAPACITY];
  char expected_accept[ITERATE_KIT_POSIX_WEBSOCKET_ACCEPT_CAPACITY];
  size_t request_size;
  size_t request_offset;
  size_t response_size;
  uint16_t port;
  int last_error;
  bool request_built;
  bool upgraded;
  bool peer_close_pending;
  bool initialized;
};

/** Computes RFC 6455's accept value; exposed to pin the handshake proof. */
enum iterate_kit_status
iterate_kit_posix_websocket_compute_accept(
    const char *client_key,
    char *destination,
    size_t destination_capacity);

enum iterate_kit_status iterate_kit_posix_websocket_client_prepare(
    struct iterate_kit_posix_websocket_client *client,
    const struct iterate_kit_posix_websocket_client_options *options);

enum iterate_kit_posix_websocket_open_result
iterate_kit_posix_websocket_client_open(
    struct iterate_kit_posix_websocket_client *client);

enum iterate_kit_posix_websocket_receive_result
iterate_kit_posix_websocket_client_receive(
    struct iterate_kit_posix_websocket_client *client,
    struct iterate_kit_posix_websocket_chunk *chunk);

enum iterate_kit_websocket_tx_result
iterate_kit_posix_websocket_client_send(
    struct iterate_kit_posix_websocket_client *client,
    enum iterate_kit_websocket_opcode opcode,
    const void *payload,
    size_t payload_size);

enum iterate_kit_websocket_tx_result
iterate_kit_posix_websocket_client_service_control(
    struct iterate_kit_posix_websocket_client *client);

void iterate_kit_posix_websocket_client_close(
    struct iterate_kit_posix_websocket_client *client);

void iterate_kit_posix_websocket_client_cleanup(
    struct iterate_kit_posix_websocket_client *client);

#ifdef __cplusplus
}
#endif

#endif
