#include "iterate/kit/platforms/esp_tls_stream.h"

#include <errno.h>
#include <fcntl.h>
#include <string.h>

#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>

#include "esp_crt_bundle.h"
#include "esp_random.h"
#include "esp_tls.h"
#include "esp_tls_crypto.h"

/*
 * ESP-TLS as a byte stream. The WebSocket client above owns every frame
 * boundary, so all this adapter decides is whether a step moved bytes, could
 * not yet, or lost the connection. A read that finds nothing is the network
 * task's ordinary pass, never an error.
 */
enum {
  /*
   * TCP keepalive is a last-resort dead-peer detector, deliberately slower
   * than the client's WebSocket keepalive. Making it aggressive would add
   * radio traffic and false reconnects on brief Wi-Fi loss.
   */
  KEEP_ALIVE_IDLE_SECONDS = 10,
  KEEP_ALIVE_INTERVAL_SECONDS = 5,
  KEEP_ALIVE_PROBES = 3,
};

/*
 * ESP-TLS keeps a failure's cause in an error handle that is destroyed with
 * the connection, and its getters clear what they return. Take it once, at
 * the failure, before anything closes.
 */
static void remember_failure(
    struct iterate_kit_esp_tls_stream *stream, int raw, int socket_errno) {
  esp_tls_error_handle_t handle = NULL;
  esp_err_t esp_error = ESP_OK;
  int captured_errno = 0;
  int tls_code = 0;
  int tls_flags = 0;
  if (stream->tls != NULL &&
      esp_tls_get_error_handle(stream->tls, &handle) == ESP_OK &&
      handle != NULL) {
    (void)esp_tls_get_and_clear_error_type(
        handle, ESP_TLS_ERR_TYPE_SYSTEM, &captured_errno);
    esp_error = esp_tls_get_and_clear_last_error(handle, &tls_code, &tls_flags);
  }
  stream->last_error = esp_error != ESP_OK
      ? (int32_t)esp_error
      : (captured_errno != 0
             ? (int32_t)captured_errno
             : (socket_errno != 0 ? (int32_t)socket_errno : (int32_t)raw));
}

static void destroy(struct iterate_kit_esp_tls_stream *stream) {
  if (stream->tls != NULL) {
    (void)esp_tls_conn_destroy(stream->tls);
    stream->tls = NULL;
  }
}

/*
 * Nonblocking, so a pass takes only what lwIP holds, and TCP_NODELAY, because
 * one stream event is already the packet: Nagle holding a short tail behind
 * an unacknowledged one is audible jitter. A socket that refuses either is
 * refused, rather than run with timing nobody chose.
 */
static bool configure_socket(struct iterate_kit_esp_tls_stream *stream) {
  int descriptor = -1;
  int flags;
  int enabled = 1;
  if (esp_tls_get_conn_sockfd(stream->tls, &descriptor) != ESP_OK ||
      descriptor < 0) {
    stream->last_error = EBADF;
    return false;
  }
  flags = fcntl(descriptor, F_GETFL, 0);
  if (flags < 0 || fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) < 0 ||
      setsockopt(
          descriptor, IPPROTO_TCP, TCP_NODELAY, &enabled, sizeof(enabled)) !=
          0) {
    stream->last_error = errno;
    return false;
  }
  return true;
}

static enum iterate_kit_byte_stream_result stream_connect(void *context) {
  struct iterate_kit_esp_tls_stream *stream = context;
  tls_keep_alive_cfg_t keep_alive = {
    .keep_alive_enable = true,
    .keep_alive_idle = KEEP_ALIVE_IDLE_SECONDS,
    .keep_alive_interval = KEEP_ALIVE_INTERVAL_SECONDS,
    .keep_alive_count = KEEP_ALIVE_PROBES,
  };
  const esp_tls_cfg_t configuration = {
    .timeout_ms = stream->timeout_ms,
    .keep_alive_cfg = &keep_alive,
    .crt_bundle_attach =
        stream->endpoint->secure ? esp_crt_bundle_attach : NULL,
    .is_plain_tcp = !stream->endpoint->secure,
  };
  int result;
  destroy(stream);
  stream->tls = esp_tls_init();
  if (stream->tls == NULL) {
    stream->last_error = ESP_ERR_NO_MEM;
    return ITERATE_KIT_BYTE_STREAM_FAILED;
  }
  result = esp_tls_conn_new_sync(
      stream->endpoint->host,
      (int)strlen(stream->endpoint->host),
      stream->endpoint->port,
      &configuration,
      stream->tls);
  if (result != 1) {
    remember_failure(stream, result, errno);
    destroy(stream);
    return ITERATE_KIT_BYTE_STREAM_FAILED;
  }
  if (!configure_socket(stream)) {
    destroy(stream);
    return ITERATE_KIT_BYTE_STREAM_FAILED;
  }
  return ITERATE_KIT_BYTE_STREAM_PROGRESS;
}

/*
 * No progress, as opposed to no connection. Over TLS that is mbedTLS's
 * WANT_READ and WANT_WRITE (it may need the other direction to advance) and
 * its TIMEOUT, whatever errno says; over plain TCP, the socket's EAGAIN. None
 * of them is logged or remembered. Every other negative result is fatal:
 * ESP-TLS itself reads on past a TLS 1.3 NewSessionTicket, and this build
 * enables neither asynchronous nor restartable crypto, mbedTLS's other
 * "call again" answers.
 */
static bool no_progress(
    const struct iterate_kit_esp_tls_stream *stream,
    ssize_t result,
    int socket_errno) {
  if (stream->endpoint->secure) {
    return result == ESP_TLS_ERR_SSL_WANT_READ ||
        result == ESP_TLS_ERR_SSL_WANT_WRITE ||
        result == ESP_TLS_ERR_SSL_TIMEOUT;
  }
  return result < 0 &&
      (socket_errno == EAGAIN || socket_errno == EWOULDBLOCK ||
       socket_errno == EINPROGRESS || socket_errno == EINTR);
}

static enum iterate_kit_byte_stream_result stream_read(
    void *context, uint8_t *bytes, size_t capacity, size_t *bytes_read) {
  struct iterate_kit_esp_tls_stream *stream = context;
  ssize_t result;
  *bytes_read = 0U;
  if (stream->tls == NULL) {
    return ITERATE_KIT_BYTE_STREAM_FAILED;
  }
  errno = 0;
  result = esp_tls_conn_read(stream->tls, bytes, capacity);
  if (result > 0) {
    *bytes_read = (size_t)result;
    return ITERATE_KIT_BYTE_STREAM_PROGRESS;
  }
  if (no_progress(stream, result, errno)) {
    return ITERATE_KIT_BYTE_STREAM_WOULD_BLOCK;
  }
  /* Zero is the peer's end of the stream, a FIN or TLS close_notify. */
  remember_failure(stream, (int)result, result == 0 ? ECONNRESET : errno);
  return ITERATE_KIT_BYTE_STREAM_FAILED;
}

static enum iterate_kit_byte_stream_result stream_write(
    void *context,
    const uint8_t *bytes,
    size_t byte_count,
    size_t *bytes_written) {
  struct iterate_kit_esp_tls_stream *stream = context;
  ssize_t result;
  *bytes_written = 0U;
  if (stream->tls == NULL) {
    return ITERATE_KIT_BYTE_STREAM_FAILED;
  }
  errno = 0;
  result = esp_tls_conn_write(stream->tls, bytes, byte_count);
  if (result > 0) {
    *bytes_written = (size_t)result;
    return ITERATE_KIT_BYTE_STREAM_PROGRESS;
  }
  /* mbedTLS answers 0 when a full record buffer took nothing. */
  if (result == 0 || no_progress(stream, result, errno)) {
    return ITERATE_KIT_BYTE_STREAM_WOULD_BLOCK;
  }
  remember_failure(stream, (int)result, errno);
  return ITERATE_KIT_BYTE_STREAM_FAILED;
}

static void stream_close(void *context) {
  destroy(context);
}

static enum iterate_kit_status stream_random(
    void *context, uint8_t *bytes, size_t byte_count) {
  (void)context;
  esp_fill_random(bytes, byte_count);
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status stream_sha1(
    void *context, const uint8_t *input, size_t size, uint8_t digest[20]) {
  (void)context;
  return esp_crypto_sha1(input, size, digest) == 0 ? ITERATE_KIT_OK
                                                    : ITERATE_KIT_IO_ERROR;
}

const struct iterate_kit_byte_stream_ops iterate_kit_esp_tls_stream_ops = {
  .connect = stream_connect,
  .read = stream_read,
  .write = stream_write,
  .close = stream_close,
  .random = stream_random,
  .sha1 = stream_sha1,
};

void iterate_kit_esp_tls_stream_prepare(
    struct iterate_kit_esp_tls_stream *stream,
    const struct iterate_kit_websocket_endpoint *endpoint,
    int timeout_ms) {
  memset(stream, 0, sizeof(*stream));
  stream->endpoint = endpoint;
  stream->timeout_ms = timeout_ms;
}
