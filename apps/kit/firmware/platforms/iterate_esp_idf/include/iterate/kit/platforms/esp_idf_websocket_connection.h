#ifndef ITERATE_KIT_PLATFORMS_ESP_IDF_WEBSOCKET_CONNECTION_H
#define ITERATE_KIT_PLATFORMS_ESP_IDF_WEBSOCKET_CONNECTION_H

#if defined(__GNUC__)
#pragma GCC system_header
#endif

#include "iterate/kit/status.h"
#include "iterate/kit/websocket_rx.h"
#include "iterate/kit/websocket_tx.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_transport.h"

#ifdef __cplusplus
extern "C" {
#endif

enum {
  /*
   * These are protocol/configuration bounds, not estimates of ESP-IDF's
   * hidden buffers. Keeping the parsed authority and request target inline
   * makes reconnect allocation-free after prepare(); rejecting a longer URL
   * is preferable to truncating it and authenticating against the wrong
   * endpoint.
   */
  ITERATE_KIT_ESP_IDF_WEBSOCKET_HOST_CAPACITY = 129,
  ITERATE_KIT_ESP_IDF_WEBSOCKET_PATH_CAPACITY = 160,
  /*
   * open() performs synchronous certificate verification on its caller. A
   * production M5StickS3 trace proved that 3072 bytes crosses the stack canary
   * inside mbedTLS P-384 verification even though every ws:// host test passed.
   * The single A1 owner therefore reserves the same proven conservative 8 KiB
   * TLS envelope. This is static, visible RAM rather than an allocator gamble;
   * once clean physical runs report the minimum-ever headroom, that evidence
   * may justify a smaller shared value. Giving the two callers different
   * budgets was rejected because it only postpones the same crash until the
   * a later reconnect performs certificate verification.
   */
  ITERATE_KIT_ESP_IDF_WEBSOCKET_TLS_OWNER_STACK_BYTES = 8192,
};

/**
 * Result of one bounded receive attempt.
 *
 * IDLE includes both "no bytes available" and a partial frame that the
 * portable parser has retained. DROPPED is an explicitly classified data loss
 * (for example an unsupported frame), while DISCONNECTED means the transport
 * must be replaced. A protocol failure is terminal for this connection: the
 * caller must not continue parsing bytes whose frame boundary is no longer
 * trustworthy.
 */
enum iterate_kit_esp_idf_websocket_receive_result {
  ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_IDLE = 0,
  ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_DATA,
  ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_CONTROL,
  ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_DROPPED,
  ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_PEER_CLOSE,
  ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_DISCONNECTED,
  ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_PROTOCOL_FAILURE,
};

/** Owner operation which most recently observed a terminal transport error. */
enum iterate_kit_esp_idf_websocket_failure_operation {
  ITERATE_KIT_ESP_IDF_WEBSOCKET_FAILURE_NONE = 0,
  ITERATE_KIT_ESP_IDF_WEBSOCKET_FAILURE_CONNECT,
  ITERATE_KIT_ESP_IDF_WEBSOCKET_FAILURE_READ,
  ITERATE_KIT_ESP_IDF_WEBSOCKET_FAILURE_WRITE,
};

/**
 * Borrowed view into receive_storage.
 *
 * The view is valid only until the next receive(), close(), or open() on the
 * same connection. Consumers must finish or copy it before yielding ownership;
 * retaining this pointer would let a later network read silently rewrite an
 * stream-event frame that is still being processed.
 */
struct iterate_kit_esp_idf_websocket_chunk {
  const uint8_t *bytes;
  size_t byte_count;
  size_t payload_size;
  size_t payload_offset;
  uint8_t opcode;
  bool final;
};

/**
 * Caller-owned lifetime and storage for a connection.
 *
 * url is consumed during prepare() and may then be released. A non-NULL
 * subprotocol or headers string is borrowed again by open() and must outlive
 * the connection; NULL means that optional upgrade field is absent. The
 * receive and transmit workspaces are also borrowed for the whole lifecycle.
 * Their explicit capacities are this adapter's complete application-level
 * parser/writer workspace budget; ESP-IDF's TLS/lwIP allocations remain opaque
 * and must be measured separately. This abstraction does not allocate a second
 * application queue.
 */
struct iterate_kit_esp_idf_websocket_connection_options {
  const char *url;
  const char *subprotocol;
  const char *headers;
  uint8_t *receive_storage;
  size_t receive_storage_capacity;
  uint8_t *transmit_storage;
  size_t transmit_storage_capacity;
};

/**
 * Saturating diagnostic counters.
 *
 * These count calls and classifications visible at this adapter. They do not
 * claim to measure TLS, lwIP, or Wi-Fi queue occupancy, and a successful raw
 * write proves only local transport acceptance—not peer parsing or audible
 * playback. websocket_tx metrics provide the exact portable-writer state.
 */
struct iterate_kit_esp_idf_websocket_connection_metrics {
  uint32_t raw_write_calls;
  uint32_t raw_write_partial;
  uint32_t raw_write_deferrals;
  uint32_t raw_write_failures;
  uint32_t receive_calls;
  uint32_t receive_chunks;
  uint32_t receive_dropped;
  uint32_t pings_received;
  uint32_t pongs_received;
  uint32_t control_backpressure;
  /*
   * ESP-IDF keeps socket, ESP-TLS, and TLS-stack causes in a mutable error
   * handle which is destroyed with the transport. Retain the exact tuple at
   * the failure boundary; `last_raw_result == -1` alone cannot distinguish a
   * peer FIN from a parser failure or an opaque TLS incident.
   */
  uint32_t transport_failure_incidents;
  enum iterate_kit_esp_idf_websocket_failure_operation
      last_failure_operation;
  int32_t last_raw_result;
  int32_t last_socket_errno;
  int32_t last_esp_tls_error;
  int32_t last_tls_stack_error;
  int32_t last_tls_cert_flags;
  struct iterate_kit_websocket_tx_metrics tx;
};

/**
 * One-task owner for one ESP-IDF WebSocket connection.
 *
 * The owner task alone calls open, receive, send, service_control, and close.
 * ESP-IDF's lower WebSocket transport supplies the HTTP upgrade and bounded
 * receive parser; outbound bytes use the portable resumable writer directly
 * over the retained parent TLS/TCP transport. There is no esp_event loop,
 * hidden client task, transmit mutex, or hot-path allocation.
 *
 * This split is intentional for the latency-sensitive A1 connection. The
 * higher-level ESP WebSocket client owns a task and may serialize callbacks
 * behind unrelated work; retaining the lower transport lets the one owner make
 * a bounded nonblocking read/write attempt whenever it is scheduled. The abstraction
 * still does not make DNS, TCP, TLS, or the HTTP upgrade realtime: open() is a
 * blocking setup operation and must run away from capture/playback.
 *
 * The once-per-second diagnostics task may call metrics concurrently. Only the
 * diagnostic counters support that access, through relaxed atomic operations;
 * connection/parser state remains owner-only. Relaxed is enough because a
 * count never publishes bytes or grants socket access.
 */
struct iterate_kit_esp_idf_websocket_connection {
  struct iterate_kit_esp_idf_websocket_connection_options options;
  char host[ITERATE_KIT_ESP_IDF_WEBSOCKET_HOST_CAPACITY];
  char path[ITERATE_KIT_ESP_IDF_WEBSOCKET_PATH_CAPACITY];
  esp_transport_handle_t parent;
  esp_transport_handle_t websocket;
  struct iterate_kit_websocket_rx rx;
  struct iterate_kit_websocket_tx tx;
  uint32_t raw_write_calls;
  uint32_t raw_write_partial;
  uint32_t raw_write_deferrals;
  uint32_t raw_write_failures;
  uint32_t receive_calls;
  uint32_t receive_chunks;
  uint32_t receive_dropped;
  uint32_t pings_received;
  uint32_t pongs_received;
  /*
   * WHEN THE HOP LAST CARRIED A BYTE, EACH WAY.
   *
   * A keepalive is only informative when the socket is otherwise silent: a
   * connection carrying audio proves itself continuously, and probing it would
   * spend a control frame to learn what the last data frame already said. Both
   * directions must be quiet, because a hop that is only receiving is still a
   * hop that works.
   */
  int64_t last_inbound_us;
  int64_t last_outbound_us;
  uint32_t control_backpressure;
  uint32_t transport_failure_incidents;
  uint32_t last_failure_operation;
  int32_t last_raw_result;
  int32_t last_socket_errno;
  int32_t last_esp_tls_error;
  int32_t last_tls_stack_error;
  int32_t last_tls_cert_flags;
  int port;
  int last_error;
  bool secure;
  bool connected;
  bool peer_close_pending;
  bool initialized;
};

/**
 * Parses immutable connection metadata and binds caller-owned workspaces.
 *
 * prepare() performs no network I/O and no heap allocation. On failure the
 * object is cleared rather than left partly usable. Thereafter, all mutable
 * connection/parser state is owned by one task until close().
 */
enum iterate_kit_status
iterate_kit_esp_idf_websocket_connection_prepare(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    const struct
        iterate_kit_esp_idf_websocket_connection_options *options);

/**
 * Performs DNS/TCP/TLS/WebSocket setup on the owner task. This operation may
 * wait up to timeout_ms and may allocate inside ESP-IDF, so it is intentionally
 * outside the realtime audio task. A failed open leaves no lower transports to
 * accidentally reuse on the next generation.
 */
enum iterate_kit_status
iterate_kit_esp_idf_websocket_connection_open(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    int timeout_ms);

/**
 * Makes at most one lower-transport read attempt into receive_storage.
 *
 * timeout_ms may be zero; the network owner uses that form so one slow frame
 * cannot delay capture or playback. Fragmented frames remain in the portable
 * parser across IDLE results. Returned chunk storage is borrowed as described
 * above.
 */
enum iterate_kit_esp_idf_websocket_receive_result
iterate_kit_esp_idf_websocket_connection_receive(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    int timeout_ms,
    struct iterate_kit_esp_idf_websocket_chunk *chunk);

/**
 * Starts or resumes one data frame without blocking.
 *
 * A WOULD_BLOCK result preserves the exact encoded frame cursor in tx; the
 * caller must invoke send() with the same logical frame until it completes.
 * No later data frame may overtake it. Local completion is deliberately not a
 * peer-delivery guarantee; higher-level stream identities and acknowledgements
 * establish semantic progress separately.
 */
enum iterate_kit_websocket_tx_result
iterate_kit_esp_idf_websocket_connection_send(
    struct iterate_kit_esp_idf_websocket_connection *connection,
    enum iterate_kit_websocket_opcode opcode,
    const void *payload,
    size_t payload_size);

/**
 * Gives queued PONG/CLOSE work one bounded nonblocking write opportunity.
 *
 * Control frames share the same wire writer as data so bytes can never be
 * interleaved inside a partially written frame. Call this frequently even
 * during uplink backpressure; it never waits for socket writability.
 */
enum iterate_kit_websocket_tx_result
iterate_kit_esp_idf_websocket_connection_service_control(
    struct iterate_kit_esp_idf_websocket_connection *connection);

/**
 * Abandons all partial frame/parser state and destroys the lower transports.
 *
 * close() is owner-task-only and idempotent after prepare(). It intentionally
 * does not attempt a blocking graceful drain: stale session traffic must not
 * delay replacing an unhealthy connection.
 */
void iterate_kit_esp_idf_websocket_connection_close(
    struct iterate_kit_esp_idf_websocket_connection *connection);

/**
 * Takes a race-free diagnostic snapshot without granting socket ownership.
 *
 * Counter values can be slightly different ages, which is acceptable for
 * telemetry; callers must not infer an atomic state transition from the group.
 */
void iterate_kit_esp_idf_websocket_connection_metrics(
    const struct iterate_kit_esp_idf_websocket_connection *connection,
    struct iterate_kit_esp_idf_websocket_connection_metrics *metrics);

#ifdef __cplusplus
}
#endif

#endif
