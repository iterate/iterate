#ifndef ITERATE_KIT_PLATFORMS_POSIX_ITX_TRANSPORT_H
#define ITERATE_KIT_PLATFORMS_POSIX_ITX_TRANSPORT_H

#include "iterate/kit/configuration.h"
#include "iterate/kit/itx_connection.h"
#include "iterate/kit/itx_outbox_sender.h"
#include "iterate/kit/platforms/posix_websocket_client.h"
#include "iterate/kit/retry_gate.h"
#include "iterate/kit/spsc_ring.h"
#include "iterate/kit/status.h"
#include "iterate/kit/websocket_text.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  ITERATE_KIT_POSIX_CONTROL_MESSAGE_CAPACITY = 8192,
  ITERATE_KIT_POSIX_ITX_MOUNT_TIMEOUT_MS = 10000,
};

enum iterate_kit_posix_itx_transport_state {
  ITERATE_KIT_POSIX_ITX_IDLE = 0,
  ITERATE_KIT_POSIX_ITX_WEBSOCKET_CONNECTING,
  ITERATE_KIT_POSIX_ITX_MOUNTING,
  ITERATE_KIT_POSIX_ITX_READY,
  ITERATE_KIT_POSIX_ITX_FAILED,
  ITERATE_KIT_POSIX_ITX_STOPPED,
};

enum iterate_kit_posix_itx_fatal_failure_reason {
  ITERATE_KIT_POSIX_ITX_FATAL_NONE = 0,
  ITERATE_KIT_POSIX_ITX_FATAL_SOCKET_GENERATION_EXHAUSTED,
  ITERATE_KIT_POSIX_ITX_FATAL_CONTROL_RING_RESET,
  ITERATE_KIT_POSIX_ITX_FATAL_CONNECTION_OPEN,
  ITERATE_KIT_POSIX_ITX_FATAL_CONNECTION_STATE,
};

struct iterate_kit_posix_itx_transport_options {
  const struct iterate_kit_configuration *configuration;
  struct iterate_kit_itx_connection *connection;
  struct iterate_kit_spsc_ring *control_inbox;
  struct iterate_kit_spsc_ring *control_outbox;
  bool DANGEROUS_disable_certificate_verification;
  /**
   * Monotonic microseconds, or NULL for this platform's own clock.
   *
   * The transport takes one phase snapshot per poll, plus fresh samples
   * immediately before and after a potentially expensive establishment step.
   * This one pointer remains the whole clock dependency, so sealed runs replay
   * deadlines bit for bit while a DNS or TLS call cannot cross a deadline
   * behind a stale sample.
   *
   * `context` is handed back unexamined.
   */
  int64_t (*now_us)(void *context);
  void *now_us_context;
};

struct iterate_kit_posix_itx_transport_metrics {
  uint32_t websocket_connections;
  uint32_t websocket_start_attempts;
  uint32_t websocket_open_timeouts;
  uint32_t websocket_disconnects;
  uint32_t websocket_errors;
  uint32_t ready_socket_generation;
  uint32_t mount_timeouts;
  uint32_t protocol_failures;
  uint32_t control_messages_sent;
  uint32_t control_messages_discarded;
  uint32_t control_inbox_discarded;
  uint32_t control_inbox_deferrals;
  uint32_t control_outbox_discarded;
  uint32_t control_receive_failures;
  uint32_t control_send_failures;
  int32_t last_platform_error;
  int32_t last_capnweb_status;
  bool fatal_failure_latched;
  enum iterate_kit_posix_itx_fatal_failure_reason fatal_failure_reason;
  struct iterate_kit_spsc_ring_metrics control_inbox;
  struct iterate_kit_spsc_ring_metrics control_outbox;
};

struct iterate_kit_posix_itx_transport_lifecycle {
  bool fatal_failure_latched;
  enum iterate_kit_posix_itx_fatal_failure_reason fatal_failure_reason;
  uint32_t ready_socket_generation;
};

/**
 * Single-threaded POSIX Cap'n Web transport.
 *
 * The caller pumping poll() owns every socket, parser, connection, and ring
 * transition. The rings retain the same producer/consumer roles as ESP-IDF,
 * but the roles are cooperative phases instead of FreeRTOS tasks. All HTTP,
 * frame, and message buffers are inline, making reconnect resource use visible
 * in sizeof(transport); OpenSSL's opaque TLS allocations are the only external
 * workspace and are destroyed at each generation boundary.
 */
struct iterate_kit_posix_itx_transport {
  struct iterate_kit_posix_itx_transport_options options;
  struct iterate_kit_websocket_text_inbox control_inbox;
  struct iterate_kit_websocket_text_outbox control_outbox;
  struct iterate_kit_itx_outbox_sender control_sender;
  char websocket_url[ITERATE_KIT_ITX_WEBSOCKET_URL_CAPACITY];
  uint8_t websocket_receive_storage[
      ITERATE_KIT_POSIX_CONTROL_MESSAGE_CAPACITY];
  uint8_t websocket_transmit_storage[
      ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(
          ITERATE_KIT_POSIX_CONTROL_MESSAGE_CAPACITY)];
  struct iterate_kit_posix_websocket_client websocket;
  struct iterate_kit_retry_gate websocket_retry;
  enum iterate_kit_posix_itx_transport_state state;
  enum capnweb_status last_capnweb_status;
  int64_t websocket_open_deadline_us;
  int64_t mount_deadline_us;
  uint32_t mount_deadline_generation;
  uint32_t socket_generation;
  uint32_t handled_socket_generation;
  uint32_t ready_socket_generation;
  uint32_t websocket_connections;
  uint32_t websocket_start_attempts;
  uint32_t websocket_open_timeouts;
  uint32_t websocket_disconnects;
  uint32_t websocket_errors;
  uint32_t mount_timeouts;
  uint32_t protocol_failures;
  uint32_t control_messages_discarded;
  uint32_t control_inbox_discarded;
  uint32_t control_inbox_deferrals;
  uint32_t control_receive_failures;
  int32_t last_platform_error;
  uint32_t fatal_failure_reason;
  bool socket_connected;
  bool websocket_open_attempt_active;
  bool restart_requested;
  bool fatal_failure_latched;
  bool initialized;
  bool started;
};

enum iterate_kit_status iterate_kit_posix_itx_transport_prepare(
    struct iterate_kit_posix_itx_transport *transport,
    const struct iterate_kit_posix_itx_transport_options *options);

enum iterate_kit_status iterate_kit_posix_itx_transport_start(
    struct iterate_kit_posix_itx_transport *transport);

enum iterate_kit_status iterate_kit_posix_itx_transport_poll(
    struct iterate_kit_posix_itx_transport *transport,
    size_t max_control_messages);

enum capnweb_status iterate_kit_posix_itx_transport_send_text(
    void *context,
    enum capnweb_text_fragment_kind kind,
    const char *data,
    size_t length);

void iterate_kit_posix_itx_transport_request_restart(
    struct iterate_kit_posix_itx_transport *transport);

enum iterate_kit_status iterate_kit_posix_itx_transport_stop(
    struct iterate_kit_posix_itx_transport *transport);

void iterate_kit_posix_itx_transport_metrics(
    const struct iterate_kit_posix_itx_transport *transport,
    struct iterate_kit_posix_itx_transport_metrics *metrics);

void iterate_kit_posix_itx_transport_lifecycle(
    const struct iterate_kit_posix_itx_transport *transport,
    struct iterate_kit_posix_itx_transport_lifecycle *lifecycle);

const char *iterate_kit_posix_itx_transport_state_name(
    enum iterate_kit_posix_itx_transport_state state);

#ifdef __cplusplus
}
#endif

#endif
