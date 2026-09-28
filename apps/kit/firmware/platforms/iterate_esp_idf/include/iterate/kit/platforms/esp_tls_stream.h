#ifndef ITERATE_KIT_PLATFORMS_ESP_TLS_STREAM_H
#define ITERATE_KIT_PLATFORMS_ESP_TLS_STREAM_H

#include "iterate/kit/websocket_client.h"

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

struct esp_tls;

enum {
  /*
   * connect verifies the server's certificate on its caller's stack. A
   * production M5StickS3 trace proved that 3072 bytes crosses the stack canary
   * inside mbedTLS P-384 verification, so the network task that owns the
   * stream reserves 8 KiB: static, visible RAM rather than an allocator
   * gamble. Once clean physical runs report the minimum-ever headroom, that
   * evidence may justify a smaller value.
   */
  ITERATE_KIT_ESP_TLS_STREAM_OWNER_STACK_BYTES = 8192,
};

/**
 * The board's byte stream under the WebSocket client: ESP-TLS over lwIP, or
 * plain TCP for a ws:// development server.
 *
 * connect is ESP-TLS's own blocking setup within timeout_ms (DNS, TCP, the
 * TLS handshake and certificate verification against ESP-IDF's bundle), so it
 * belongs on the network task, never an audio one. The socket is then made
 * nonblocking with Nagle off: read and write take only what is there, and
 * ESP-TLS's WANT_READ and WANT_WRITE are an empty pass, not a failure.
 *
 * One owner, the network task, calls every operation. endpoint is borrowed
 * from the client that dials it.
 */
struct iterate_kit_esp_tls_stream {
  const struct iterate_kit_websocket_endpoint *endpoint;
  struct esp_tls *tls;
  int timeout_ms;
  /**
   * Why the latest failed operation failed: ESP-TLS's error when it recorded
   * one, else the socket's errno, else the operation's raw result. Taken from
   * ESP-TLS's error handle before close destroys it.
   */
  int32_t last_error;
};

extern const struct iterate_kit_byte_stream_ops
    iterate_kit_esp_tls_stream_ops;

/** Binds the endpoint and the connect bound. No I/O. */
void iterate_kit_esp_tls_stream_prepare(
    struct iterate_kit_esp_tls_stream *stream,
    const struct iterate_kit_websocket_endpoint *endpoint,
    int timeout_ms);

#ifdef __cplusplus
}
#endif

#endif
