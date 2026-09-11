#include "esp_timer.h"

#include "iterate/kit/voice_device_profile.h"
#include "iterate/kit/platforms/esp_idf_websocket_connection.h"

#include "iterate/kit/atomic.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <string.h>

#include "esp_crt_bundle.h"
#include "esp_random.h"
#include "esp_tls.h"
#include "esp_tls_errors.h"
#include "esp_transport_ssl.h"
#include "esp_transport_tcp.h"
#include "esp_transport_ws.h"
#include "http_parser.h"
#include "lwip/sockets.h"
#include "lwip/tcp.h"

/*
 * ESP-IDF lower-transport adapter for the single A1 WebSocket.
 *
 * A1 carries latency-sensitive audio events and ordinary capability traffic
 * together, so the steady-state owner must never wait for a hidden client task
 * or writable socket. ESP-IDF still performs the difficult DNS/TLS/HTTP
 * upgrade, but after that upgrade this module retains the parent transport and
 * drives a portable resumable writer with zero-timeout operations. A local
 * write only means TLS/TCP accepted bytes; higher layers use stream identities
 * and freshness deadlines before calling speech delivered.
 *
 * One task owns every transport handle and parser/writer transition. The only
 * cross-task access is to saturating counters through relaxed atomics. All
 * frame storage is supplied by the caller, so reconnects do not grow a heap
 * backlog and close can abandon a stale partial frame in bounded time.
 */
enum {
  /*
   * TCP keepalive is a last-resort dead-peer detector, deliberately slower
   * than the A1 stream-freshness policy. Making it aggressive would add radio
   * traffic and false reconnects on brief Wi-Fi loss; treating it as delivery
   * evidence would be wrong because the remote kernel can ACK while the voice
   * peer is wedged.
   */
  WEBSOCKET_KEEP_ALIVE_IDLE_SECONDS = 10,
  WEBSOCKET_KEEP_ALIVE_INTERVAL_SECONDS = 5,
  WEBSOCKET_KEEP_ALIVE_PROBES = 3,
};

/*
 * ESP-IDF exposes this function from tcp_transport but omits it from the
 * public header. Its own component tests use the same declaration. We need
 * the descriptor to enforce nonblocking writes and TCP_NODELAY after the
 * lower transport completes the HTTP upgrade.
 */
extern int esp_transport_get_socket(esp_transport_handle_t transport);

static bool copy_url_field(
    char *destination,
    size_t destination_capacity,
    const char *url,
    const struct http_parser_url *parsed,
    enum http_parser_url_fields field) {
  const size_t length = parsed->field_data[field].len;
  const size_t offset = parsed->field_data[field].off;
  if (length == 0U || length >= destination_capacity) {
    return false;
  }
  memcpy(destination, url + offset, length);
  destination[length] = '\0';
  return true;
}

/*
 * Parse once into fixed storage so repeated reconnects do not allocate or
 * depend on a caller's temporary URL buffer. Userinfo is rejected because
 * secrets belong in explicit headers, where redaction and substitution
 * boundaries are unambiguous; fragments are client-side concepts and must
 * never silently alter a WebSocket request target.
 */
static bool parse_url(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    const char *url) {
  static const char secure_scheme[] = "wss";
  static const char insecure_scheme[] = "ws";
  struct http_parser_url parsed;
  const char *scheme;
  size_t scheme_size;
  size_t path_size;
  size_t query_size = 0U;

  http_parser_url_init(&parsed);
  if (http_parser_parse_url(
          url, strlen(url), 0, &parsed) != 0 ||
      (parsed.field_set & (1U << UF_SCHEMA)) == 0U ||
      (parsed.field_set & (1U << UF_HOST)) == 0U ||
      (parsed.field_set & (1U << UF_USERINFO)) != 0U ||
      (parsed.field_set & (1U << UF_FRAGMENT)) != 0U) {
    return false;
  }
  scheme = url + parsed.field_data[UF_SCHEMA].off;
  scheme_size = parsed.field_data[UF_SCHEMA].len;
  if (scheme_size == sizeof(secure_scheme) - 1U &&
      memcmp(
          scheme, secure_scheme, sizeof(secure_scheme) - 1U) ==
          0) {
    connection->secure = true;
    connection->port = 443;
  } else if (
      scheme_size == sizeof(insecure_scheme) - 1U &&
      memcmp(
          scheme,
          insecure_scheme,
          sizeof(insecure_scheme) - 1U) == 0) {
    connection->secure = false;
    connection->port = 80;
  } else {
    return false;
  }
  if (!copy_url_field(
          connection->host,
          sizeof(connection->host),
          url,
          &parsed,
          UF_HOST)) {
    return false;
  }
  if ((parsed.field_set & (1U << UF_PORT)) != 0U) {
    if (parsed.port == 0U) {
      return false;
    }
    connection->port = parsed.port;
  }

  if ((parsed.field_set & (1U << UF_PATH)) != 0U) {
    path_size = parsed.field_data[UF_PATH].len;
    if (path_size == 0U ||
        path_size >= sizeof(connection->path)) {
      return false;
    }
    memcpy(
        connection->path,
        url + parsed.field_data[UF_PATH].off,
        path_size);
  } else {
    connection->path[0] = '/';
    path_size = 1U;
  }
  if ((parsed.field_set & (1U << UF_QUERY)) != 0U) {
    const size_t remaining = sizeof(connection->path) - path_size;
    query_size = parsed.field_data[UF_QUERY].len;
    /*
     * Account for '?' and the trailing NUL before subtracting query_size.
     * Subtracting an attacker-controlled query length first wrapped size_t
     * for long queries and turned this bounds check into an overflow permit.
     */
    if (query_size == 0U || remaining < 2U || query_size > remaining - 2U) {
      return false;
    }
    connection->path[path_size++] = '?';
    memcpy(
        connection->path + path_size,
        url + parsed.field_data[UF_QUERY].off,
        query_size);
    path_size += query_size;
  }
  connection->path[path_size] = '\0';
  return true;
}

static enum iterate_kit_status random_mask(
    void *context, uint8_t *bytes, size_t byte_count) {
  (void)context;
  if (bytes == NULL || byte_count == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  esp_fill_random(bytes, byte_count);
  return ITERATE_KIT_OK;
}

/*
 * ESP-IDF's transport error handle belongs to the live parent and is cleared
 * by its public getters. Capture every domain exactly once before close()
 * destroys that evidence. Keeping the raw result alongside the decoded tuple
 * is important: the WebSocket wrapper itself can return -1 without a lower
 * socket/TLS error, which is a parser-layer failure rather than peer FIN.
 */
static void remember_transport_failure(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    enum iterate_kit_esp_idf_websocket_failure_operation operation,
    int raw_result,
    int observed_socket_errno) {
  esp_tls_error_handle_t error_handle = NULL;
  esp_err_t esp_tls_error = ESP_OK;
  int tls_stack_error = 0;
  int tls_cert_flags = 0;

  if (connection->parent != NULL) {
    error_handle =
        esp_transport_get_error_handle(connection->parent);
    if (error_handle != NULL) {
      esp_tls_error = esp_tls_get_and_clear_last_error(
          error_handle, &tls_stack_error, &tls_cert_flags);
    }
  }

  __atomic_store_n(
      &connection->last_failure_operation,
      (uint32_t)operation,
      __ATOMIC_RELEASE);
  __atomic_store_n(
      &connection->last_raw_result,
      (int32_t)raw_result,
      __ATOMIC_RELEASE);
  __atomic_store_n(
      &connection->last_socket_errno,
      (int32_t)observed_socket_errno,
      __ATOMIC_RELEASE);
  __atomic_store_n(
      &connection->last_esp_tls_error,
      (int32_t)esp_tls_error,
      __ATOMIC_RELEASE);
  __atomic_store_n(
      &connection->last_tls_stack_error,
      (int32_t)tls_stack_error,
      __ATOMIC_RELEASE);
  __atomic_store_n(
      &connection->last_tls_cert_flags,
      (int32_t)tls_cert_flags,
      __ATOMIC_RELEASE);
  iterate_kit_atomic_saturating_increment_relaxed_u32(
      &connection->transport_failure_incidents);

  connection->last_error = esp_tls_error != ESP_OK
      ? (int)esp_tls_error
      : (observed_socket_errno != 0
              ? observed_socket_errno
              : raw_result);
}

/*
 * `esp_transport_get_errno()` is destructive: it returns and clears the
 * socket-domain cause. Read it exactly once at the failure site, before the
 * transport is closed, then pass that value into the tuple recorder. This is
 * separate from `remember_transport_failure()` because the write path must
 * inspect the same value to distinguish ordinary nonblocking backpressure
 * from a terminal incident; letting both helpers read it made the retained
 * diagnosis depend on call order.
 */
static int take_socket_errno(
    struct iterate_kit_esp_idf_websocket_connection *connection) {
  int socket_errno;
  if (connection->parent == NULL) {
    return 0;
  }
  socket_errno = esp_transport_get_errno(connection->parent);
  return socket_errno > 0 ? socket_errno : 0;
}

static enum iterate_kit_websocket_tx_raw_write_result
raw_write(
    void *context,
    const uint8_t *bytes,
    size_t byte_count,
    size_t *bytes_written) {
  struct iterate_kit_esp_idf_websocket_connection *connection =
      context;
  int result;
  int socket_error;
  *bytes_written = 0U;
  iterate_kit_atomic_saturating_increment_relaxed_u32(
      &connection->raw_write_calls);
  if (!connection->connected ||
      connection->parent == NULL ||
      byte_count == 0U ||
      byte_count > (size_t)INT_MAX) {
    iterate_kit_atomic_saturating_increment_relaxed_u32(
        &connection->raw_write_failures);
    return ITERATE_KIT_WEBSOCKET_TX_RAW_DISCONNECTED;
  }
  result = esp_transport_write(
      connection->parent,
      (const char *)bytes,
      (int)byte_count,
      0);
  if (result > 0) {
    *bytes_written = (size_t)result;
    if ((size_t)result < byte_count) {
      iterate_kit_atomic_saturating_increment_relaxed_u32(
          &connection->raw_write_partial);
    }
    return ITERATE_KIT_WEBSOCKET_TX_RAW_WROTE;
  }
  if (result == 0 ||
      result == ESP_TLS_ERR_SSL_WANT_READ ||
      result == ESP_TLS_ERR_SSL_WANT_WRITE) {
    /*
     * TLS may need the opposite socket direction while advancing a write.
     * Both WANT states are ordinary scheduler deferrals, not disconnects;
     * converting either to failure would create reconnect storms under normal
     * record/key-update behavior. The portable writer retains its exact cursor
     * and the owner retries on a later bounded pass.
     */
    iterate_kit_atomic_saturating_increment_relaxed_u32(
        &connection->raw_write_deferrals);
    return ITERATE_KIT_WEBSOCKET_TX_RAW_WOULD_BLOCK;
  }
  socket_error = take_socket_errno(connection);
  if (socket_error == EAGAIN ||
      socket_error == EWOULDBLOCK ||
      socket_error == EINPROGRESS ||
      socket_error == EINTR) {
    iterate_kit_atomic_saturating_increment_relaxed_u32(
        &connection->raw_write_deferrals);
    return ITERATE_KIT_WEBSOCKET_TX_RAW_WOULD_BLOCK;
  }
  remember_transport_failure(
      connection,
      ITERATE_KIT_ESP_IDF_WEBSOCKET_FAILURE_WRITE,
      result,
      socket_error);
  iterate_kit_atomic_saturating_increment_relaxed_u32(
      &connection->raw_write_failures);
  return ITERATE_KIT_WEBSOCKET_TX_RAW_DISCONNECTED;
}

static void destroy_transports(
    struct iterate_kit_esp_idf_websocket_connection *connection) {
  /*
   * The WebSocket wrapper borrows the parent. Destroy it first so no wrapper
   * destructor can inspect a parent that has already been freed. ESP-IDF does
   * not transfer parent ownership, hence both handles must be destroyed.
   */
  if (connection->websocket != NULL) {
    (void)esp_transport_destroy(connection->websocket);
    connection->websocket = NULL;
  }
  if (connection->parent != NULL) {
    (void)esp_transport_destroy(connection->parent);
    connection->parent = NULL;
  }
}

enum iterate_kit_status
iterate_kit_esp_idf_websocket_connection_prepare(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    const struct
        iterate_kit_esp_idf_websocket_connection_options *options) {
  struct iterate_kit_websocket_tx_options tx_options;
  enum iterate_kit_status status;
  if (connection == NULL ||
      options == NULL ||
      options->url == NULL ||
      options->receive_storage == NULL ||
      options->receive_storage_capacity == 0U ||
      options->receive_storage_capacity > (size_t)INT_MAX ||
      options->transmit_storage == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(connection, 0, sizeof(*connection));
  connection->options = *options;
  if (!parse_url(connection, options->url)) {
    memset(connection, 0, sizeof(*connection));
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  tx_options = (struct iterate_kit_websocket_tx_options){
    .frame_storage = options->transmit_storage,
    .frame_storage_capacity = options->transmit_storage_capacity,
    .raw_write = raw_write,
    .raw_write_context = connection,
    .random = random_mask,
    .random_context = connection,
  };
  status = iterate_kit_websocket_tx_init(
      &connection->tx, &tx_options);
  if (status != ITERATE_KIT_OK) {
    memset(connection, 0, sizeof(*connection));
    return status;
  }
  status = iterate_kit_websocket_rx_init(&connection->rx);
  if (status != ITERATE_KIT_OK) {
    memset(connection, 0, sizeof(*connection));
    return status;
  }
  connection->initialized = true;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status configure_socket(
    struct iterate_kit_esp_idf_websocket_connection *connection) {
  const int descriptor =
      esp_transport_get_socket(connection->parent);
  int flags;
  int enabled = 1;
  if (descriptor < 0) {
    connection->last_error = EBADF;
    return ITERATE_KIT_IO_ERROR;
  }
  flags = fcntl(descriptor, F_GETFL, 0);
  if (flags < 0 ||
      fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) < 0) {
    connection->last_error = errno;
    return ITERATE_KIT_IO_ERROR;
  }
  /*
   * Stream-event messages are already the packetization unit. Nagle could hold a
   * short tail behind an earlier unacknowledged packet, turning a bounded
   * partial write into audible jitter. We reject the connection if either
   * nonblocking mode or TCP_NODELAY cannot be proven, rather than running with
   * unexplained timing behavior.
   */
  if (setsockopt(
          descriptor,
          IPPROTO_TCP,
          TCP_NODELAY,
          &enabled,
          sizeof(enabled)) != 0) {
    connection->last_error = errno;
    return ITERATE_KIT_IO_ERROR;
  }
  return ITERATE_KIT_OK;
}

enum iterate_kit_status
iterate_kit_esp_idf_websocket_connection_open(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    int timeout_ms) {
  esp_transport_keep_alive_t keep_alive = {
    .keep_alive_enable = true,
    .keep_alive_idle = WEBSOCKET_KEEP_ALIVE_IDLE_SECONDS,
    .keep_alive_interval =
        WEBSOCKET_KEEP_ALIVE_INTERVAL_SECONDS,
    .keep_alive_count = WEBSOCKET_KEEP_ALIVE_PROBES,
  };
  esp_transport_ws_config_t websocket_configuration = {
    .ws_path = connection != NULL ? connection->path : NULL,
    .sub_protocol = connection != NULL
        ? connection->options.subprotocol
        : NULL,
    .user_agent = "iterate-kit/0",
    .headers = connection != NULL
        ? connection->options.headers
        : NULL,
    .auth = NULL,
    .propagate_control_frames = true,
  };
  int result;
  enum iterate_kit_status status;
  if (connection == NULL ||
      !connection->initialized ||
      connection->connected ||
      timeout_ms <= 0) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  destroy_transports(connection);
  /*
   * Handles are created per generation instead of recycled. Parser/TLS state
   * from an interrupted frame is not meaningful on a new WebSocket, and a
   * clean generation boundary is cheaper to reason about than attempting to
   * repair opaque ESP-IDF state.
   */
  connection->parent = connection->secure
      ? esp_transport_ssl_init()
      : esp_transport_tcp_init();
  if (connection->parent == NULL) {
    connection->last_error = ESP_ERR_NO_MEM;
    return ITERATE_KIT_IO_ERROR;
  }
  if (connection->secure) {
    esp_transport_ssl_crt_bundle_attach(
        connection->parent, esp_crt_bundle_attach);
    esp_transport_ssl_set_keep_alive(
        connection->parent, &keep_alive);
  } else {
    esp_transport_tcp_set_keep_alive(
        connection->parent, &keep_alive);
  }
  connection->websocket =
      esp_transport_ws_init(connection->parent);
  if (connection->websocket == NULL) {
    connection->last_error = ESP_ERR_NO_MEM;
    destroy_transports(connection);
    return ITERATE_KIT_IO_ERROR;
  }
  if (esp_transport_ws_set_config(
          connection->websocket,
          &websocket_configuration) != ESP_OK) {
    connection->last_error = ESP_ERR_NO_MEM;
    destroy_transports(connection);
    return ITERATE_KIT_IO_ERROR;
  }
  result = esp_transport_connect(
      connection->websocket,
      connection->host,
      connection->port,
      timeout_ms);
  if (result != 0) {
    remember_transport_failure(
        connection,
        ITERATE_KIT_ESP_IDF_WEBSOCKET_FAILURE_CONNECT,
        result,
        take_socket_errno(connection));
    destroy_transports(connection);
    return ITERATE_KIT_IO_ERROR;
  }
  status = configure_socket(connection);
  if (status != ITERATE_KIT_OK) {
    (void)esp_transport_close(connection->websocket);
    destroy_transports(connection);
    return status;
  }
  connection->peer_close_pending = false;
  connection->connected = true;
  /*
   * Reset only after the upgraded socket is fully configured. Publishing
   * connected sooner could let the owner emit bytes through a blocking or
   * Nagle-enabled descriptor.
   */
  iterate_kit_websocket_rx_reset(&connection->rx);
  iterate_kit_websocket_tx_reset(&connection->tx);
  /*
   * Start the quiet clocks NOW rather than at zero. Zero means "nothing has
   * ever moved", which the keepalive treats as not-yet-idle — otherwise a
   * freshly upgraded socket would be probed before the handshake traffic it is
   * about to carry.
   */
  connection->last_inbound_us = esp_timer_get_time();
  connection->last_outbound_us = connection->last_inbound_us;
  return ITERATE_KIT_OK;
}

enum iterate_kit_esp_idf_websocket_receive_result
iterate_kit_esp_idf_websocket_connection_receive(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    int timeout_ms,
    struct iterate_kit_esp_idf_websocket_chunk *chunk) {
  ws_transport_opcodes_t opcode;
  struct iterate_kit_websocket_rx_read read;
  struct iterate_kit_websocket_rx_chunk classified;
  enum iterate_kit_websocket_rx_result classification;
  int payload_size;
  int result;
  bool final;
  enum iterate_kit_status queue_status;
  if (chunk != NULL) {
    memset(chunk, 0, sizeof(*chunk));
  }
  if (connection == NULL ||
      !connection->initialized ||
      !connection->connected ||
      connection->websocket == NULL ||
      chunk == NULL ||
      timeout_ms < 0) {
    return
        ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_PROTOCOL_FAILURE;
  }
  iterate_kit_atomic_saturating_increment_relaxed_u32(
      &connection->receive_calls);
  result = esp_transport_read(
      connection->websocket,
      (char *)connection->options.receive_storage,
      (int)connection->options.receive_storage_capacity,
      timeout_ms);
  opcode = esp_transport_ws_get_read_opcode(
      connection->websocket);
  payload_size = esp_transport_ws_get_read_payload_len(
      connection->websocket);
  final = esp_transport_ws_get_fin_flag(
      connection->websocket);

  if (result < 0) {
    /*
     * Once the lower transport reports failure, any retained fragment may end
     * mid-frame. Reset immediately and require a new generation; replaying the
     * fragment would risk classifying stale bytes as fresh session traffic.
     */
    remember_transport_failure(
        connection,
        ITERATE_KIT_ESP_IDF_WEBSOCKET_FAILURE_READ,
        result,
        take_socket_errno(connection));
    connection->connected = false;
    iterate_kit_websocket_rx_reset(&connection->rx);
    iterate_kit_websocket_tx_reset(&connection->tx);
    return ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_DISCONNECTED;
  }
  if (payload_size < 0) {
    return
        ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_PROTOCOL_FAILURE;
  }

  if (result > 0) {
    iterate_kit_atomic_saturating_increment_relaxed_u32(
        &connection->receive_chunks);
  }
  read = (struct iterate_kit_websocket_rx_read){
    .bytes = result > 0
        ? connection->options.receive_storage
        : NULL,
    .byte_count = (size_t)result,
    .payload_size = (size_t)payload_size,
    .opcode = (enum iterate_kit_websocket_opcode)opcode,
    .final = final,
    .has_frame = opcode != WS_TRANSPORT_OPCODES_NONE,
  };
  classification = iterate_kit_websocket_rx_feed(
      &connection->rx, &read, &classified);
  /*
   * A zero-byte read is not EOF in ESP-IDF's nonblocking transport. The
   * portable classifier distinguishes idle from a retained partial frame; the
   * patched lower transport preserves its payload cursor across that result.
   */
  if (classification == ITERATE_KIT_WEBSOCKET_RX_IDLE ||
      classification == ITERATE_KIT_WEBSOCKET_RX_PARTIAL) {
    return ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_IDLE;
  }
  /*
   * A COMPLETE FRAME ARRIVED, of any kind, so the hop is demonstrably carrying
   * bytes this way and the keepalive in service_control has nothing to learn.
   * Stamped after the idle/partial returns above, because a zero-byte read is
   * not evidence of anything.
   */
  connection->last_inbound_us = esp_timer_get_time();
  if (classification == ITERATE_KIT_WEBSOCKET_RX_DROPPED) {
    iterate_kit_atomic_saturating_increment_relaxed_u32(
        &connection->receive_dropped);
    return ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_DROPPED;
  }
  if (classification == ITERATE_KIT_WEBSOCKET_RX_DATA) {
    chunk->bytes = classified.bytes;
    chunk->byte_count = classified.byte_count;
    chunk->payload_size = classified.payload_size;
    chunk->payload_offset = classified.payload_offset;
    chunk->opcode = (uint8_t)classified.opcode;
    chunk->final = classified.final;
    return ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_DATA;
  }
  if (classification == ITERATE_KIT_WEBSOCKET_RX_CONTROL) {
    chunk->bytes = classified.bytes;
    chunk->byte_count = classified.byte_count;
    chunk->payload_size = classified.payload_size;
    chunk->payload_offset = classified.payload_offset;
    chunk->opcode = (uint8_t)classified.opcode;
    chunk->final = classified.final;
    if (classified.opcode ==
        (uint8_t)ITERATE_KIT_WEBSOCKET_PING) {
      iterate_kit_atomic_saturating_increment_relaxed_u32(
          &connection->pings_received);
      queue_status = iterate_kit_websocket_tx_queue_control(
          &connection->tx,
          ITERATE_KIT_WEBSOCKET_PONG,
          classified.bytes,
          classified.byte_count);
      if (queue_status != ITERATE_KIT_OK) {
        /*
         * PONG is queued rather than written in the receive path because a
         * data frame may already be partially on the wire. The bounded control
         * slot coalesces/reports pressure; direct writes here could corrupt
         * framing and make receive latency depend on socket writability.
         */
        iterate_kit_atomic_saturating_increment_relaxed_u32(
            &connection->control_backpressure);
        return queue_status == ITERATE_KIT_BACKPRESSURE
            ? ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_CONTROL
            : ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_PROTOCOL_FAILURE;
      }
      return
          ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_CONTROL;
    }
    if (classified.opcode ==
        (uint8_t)ITERATE_KIT_WEBSOCKET_PONG) {
      iterate_kit_atomic_saturating_increment_relaxed_u32(
          &connection->pongs_received);
      /*
       * HOP LIVENESS, AND NOTHING ELSE. This counter proves the far end parsed
       * a frame in order. It must never be read as an application message
       * delivered, acknowledged or admitted — see the rule at
       * iterate_kit_websocket_tx_queue_control. Its one legitimate reader is
       * the liveness watchdog.
       */
      return
          ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_CONTROL;
    }
    queue_status = iterate_kit_websocket_tx_queue_control(
        &connection->tx,
        ITERATE_KIT_WEBSOCKET_CLOSE,
        classified.bytes,
        classified.byte_count);
    if (queue_status != ITERATE_KIT_OK) {
      iterate_kit_atomic_saturating_increment_relaxed_u32(
          &connection->control_backpressure);
      return queue_status == ITERATE_KIT_BACKPRESSURE
          ? ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_PEER_CLOSE
          : ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_PROTOCOL_FAILURE;
    }
    connection->peer_close_pending = true;
    /*
     * Stop admitting data as soon as CLOSE is parsed, while allowing the
     * owner to service the matching CLOSE reply. Continuing stream traffic
     * after peer close would turn an orderly generation boundary into
     * unexplained loss.
     */
    return ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_PEER_CLOSE;
  }
  return ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_PROTOCOL_FAILURE;
}

enum iterate_kit_websocket_tx_result
iterate_kit_esp_idf_websocket_connection_send(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    enum iterate_kit_websocket_opcode opcode,
    const void *payload,
    size_t payload_size) {
  if (connection == NULL ||
      !connection->initialized ||
      !connection->connected ||
      connection->peer_close_pending) {
    return ITERATE_KIT_WEBSOCKET_TX_DISCONNECTED;
  }
  /* Bytes going out are proof this way too; see the keepalive below. */
  connection->last_outbound_us = esp_timer_get_time();
  return iterate_kit_websocket_tx_send(
      &connection->tx, opcode, payload, payload_size);
}

enum iterate_kit_websocket_tx_result
iterate_kit_esp_idf_websocket_connection_service_control(
    struct iterate_kit_esp_idf_websocket_connection *connection) {
  if (connection == NULL ||
      !connection->initialized ||
      !connection->connected) {
    return ITERATE_KIT_WEBSOCKET_TX_DISCONNECTED;
  }
  /*
   * ASK, WHEN NOBODY HAS SAID ANYTHING FOR A WHILE.
   *
   * Both ends of this connection answered pings and neither asked, so a
   * half-open TCP connection — socket open, transport READY, nothing moving in
   * either direction — was invisible to everybody. This is the one thing that
   * makes it visible, and the PONG it earns is the only evidence a liveness
   * watchdog can key on that still moves on a perfectly IDLE board.
   *
   * Only when the hop is quiet BOTH ways: a connection carrying audio proves
   * itself continuously, and probing it would spend a control frame to learn
   * what the last data frame already said.
   *
   * Queued, never written here, for the same reason the reply PONG is: a data
   * frame may already be partially on the wire, and the bounded slot coalesces
   * rather than growing. A probe that cannot be queued is simply skipped —
   * pressure on that slot is itself evidence the socket is not idle.
   */
  {
    const int64_t now_us = esp_timer_get_time();
    const int64_t quiet_us =
        (int64_t)ITERATE_KIT_VOICE_HOP_KEEPALIVE_MS * 1000;
    if (connection->last_inbound_us != 0 &&
        connection->last_outbound_us != 0 &&
        now_us - connection->last_inbound_us > quiet_us &&
        now_us - connection->last_outbound_us > quiet_us) {
      if (iterate_kit_websocket_tx_queue_control(
              &connection->tx,
              ITERATE_KIT_WEBSOCKET_PING,
              NULL,
              0U) == ITERATE_KIT_OK) {
        /* Stamped as outbound so one quiet period yields one probe. */
        connection->last_outbound_us = now_us;
      }
    }
  }
  return iterate_kit_websocket_tx_poll_control(
      &connection->tx);
}

void iterate_kit_esp_idf_websocket_connection_close(
    struct iterate_kit_esp_idf_websocket_connection *connection) {
  if (connection == NULL || !connection->initialized) {
    return;
  }
  connection->connected = false;
  connection->peer_close_pending = false;
  iterate_kit_websocket_rx_reset(&connection->rx);
  iterate_kit_websocket_tx_reset(&connection->tx);
  if (connection->websocket != NULL) {
    /*
     * Do not wait for a graceful close handshake here. Realtime recovery is a
     * generation replacement, and any queued stream bytes have already lost
     * their freshness or session context.
     */
    (void)esp_transport_close(connection->websocket);
  }
  destroy_transports(connection);
}

void iterate_kit_esp_idf_websocket_connection_metrics(
    const struct iterate_kit_esp_idf_websocket_connection *connection,
    struct iterate_kit_esp_idf_websocket_connection_metrics *metrics) {
  if (metrics == NULL) {
    return;
  }
  memset(metrics, 0, sizeof(*metrics));
  if (connection == NULL || !connection->initialized) {
    return;
  }
  /*
   * The connection owner updates these while the main task samples metrics.
   * They carry no publication semantics, so relaxed loads are sufficient, but
   * plain reads would still be a C data race against the atomic increments.
   */
  metrics->raw_write_calls =
      iterate_kit_atomic_load_relaxed_u32(
          &connection->raw_write_calls);
  metrics->raw_write_partial =
      iterate_kit_atomic_load_relaxed_u32(
          &connection->raw_write_partial);
  metrics->raw_write_deferrals =
      iterate_kit_atomic_load_relaxed_u32(
          &connection->raw_write_deferrals);
  metrics->raw_write_failures =
      iterate_kit_atomic_load_relaxed_u32(
          &connection->raw_write_failures);
  metrics->receive_calls =
      iterate_kit_atomic_load_relaxed_u32(
          &connection->receive_calls);
  metrics->receive_chunks =
      iterate_kit_atomic_load_relaxed_u32(
          &connection->receive_chunks);
  metrics->receive_dropped =
      iterate_kit_atomic_load_relaxed_u32(
          &connection->receive_dropped);
  metrics->pings_received =
      iterate_kit_atomic_load_relaxed_u32(
          &connection->pings_received);
  metrics->pongs_received =
      iterate_kit_atomic_load_relaxed_u32(
          &connection->pongs_received);
  metrics->control_backpressure =
      iterate_kit_atomic_load_relaxed_u32(
          &connection->control_backpressure);
  metrics->transport_failure_incidents =
      iterate_kit_atomic_load_relaxed_u32(
          &connection->transport_failure_incidents);
  metrics->last_failure_operation =
      (enum iterate_kit_esp_idf_websocket_failure_operation)
          __atomic_load_n(
              &connection->last_failure_operation,
              __ATOMIC_ACQUIRE);
  metrics->last_raw_result = __atomic_load_n(
      &connection->last_raw_result, __ATOMIC_ACQUIRE);
  metrics->last_socket_errno = __atomic_load_n(
      &connection->last_socket_errno, __ATOMIC_ACQUIRE);
  metrics->last_esp_tls_error = __atomic_load_n(
      &connection->last_esp_tls_error, __ATOMIC_ACQUIRE);
  metrics->last_tls_stack_error = __atomic_load_n(
      &connection->last_tls_stack_error, __ATOMIC_ACQUIRE);
  metrics->last_tls_cert_flags = __atomic_load_n(
      &connection->last_tls_cert_flags, __ATOMIC_ACQUIRE);
  iterate_kit_websocket_tx_metrics(
      &connection->tx, &metrics->tx);
}
