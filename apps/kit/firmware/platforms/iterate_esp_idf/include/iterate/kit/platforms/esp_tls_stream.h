#ifndef ITERATE_KIT_PLATFORMS_ESP_TLS_STREAM_H
#define ITERATE_KIT_PLATFORMS_ESP_TLS_STREAM_H

#include "iterate/kit/websocket_client.h"

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

struct esp_tls;

/**
 * The board's byte stream under the WebSocket client: ESP-TLS over lwIP, or
 * plain TCP for a ws:// development server.
 *
 * connect is ESP-TLS's own blocking setup within timeout_ms (DNS, TCP, the
 * TLS handshake and certificate verification against ESP-IDF's bundle), so it
 * belongs on the network task, never an audio one. Verification runs on the
 * caller's stack, which ITERATE_KIT_ESP_IDF_NETWORK_TASK_STACK_BYTES sizes for
 * it. The socket is then made nonblocking with Nagle off: read and write take
 * only what is there, and ESP-TLS's WANT_READ and WANT_WRITE are an empty
 * pass, not a failure.
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
