#include "iterate/kit/platforms/posix_itx_transport.h"

#include "iterate/kit/atomic.h"
#include "iterate/kit/voice_device_profile.h"

#include <errno.h>
#include <limits.h>
#include <string.h>
#include <time.h>

enum {
  WEBSOCKET_RETRY_INITIAL_MS = 250,
  WEBSOCKET_RETRY_MAX_MS = 8000,
  NETWORK_RECEIVE_BURST = 8,
  NETWORK_SEND_BURST = 4,
};

/*
 * One poll pass alternates bounded network and application phases. Unlike the
 * device there is no Wi-Fi callback or network task, but generation changes,
 * session-scoped discards, mount deadlines, and ring ownership retain the same
 * ordering. A healthy TCP upgrade never counts as READY until Cap'n Web mount
 * succeeds, so an incompatible peer cannot collapse reconnect backoff.
 */

static int64_t platform_monotonic_microseconds(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
    return 0;
  }
  return (int64_t)now.tv_sec * 1000000 +
      (int64_t)now.tv_nsec / 1000;
}

static void increment(uint32_t *value) {
  iterate_kit_atomic_saturating_increment_relaxed_u32(value);
}

static bool ring_empty(const struct iterate_kit_spsc_ring *ring) {
  struct iterate_kit_spsc_ring_metrics metrics;
  iterate_kit_spsc_ring_metrics(ring, &metrics);
  return metrics.current_slots == 0U;
}

static void discard_inbox(
    struct iterate_kit_posix_itx_transport *transport) {
  const void *message;
  size_t length;
  while (iterate_kit_spsc_ring_read_acquire(
             transport->options.control_inbox,
             &message,
             &length) == ITERATE_KIT_OK) {
    (void)message;
    (void)length;
    (void)iterate_kit_spsc_ring_read_release(
        transport->options.control_inbox);
    increment(&transport->control_messages_discarded);
    increment(&transport->control_inbox_discarded);
  }
}

static void close_generation(
    struct iterate_kit_posix_itx_transport *transport,
    int64_t now_us) {
  if (transport->socket_connected || transport->websocket.upgraded) {
    increment(&transport->websocket_disconnects);
  }
  transport->socket_connected = false;
  transport->websocket_open_attempt_active = false;
  transport->websocket_open_deadline_us = 0;
  /* Reset the writer before its borrowed ring head can be released. */
  iterate_kit_posix_websocket_client_close(&transport->websocket);
  iterate_kit_itx_outbox_sender_discard(&transport->control_sender);
  iterate_kit_itx_connection_lost(transport->options.connection);
  discard_inbox(transport);
  transport->mount_deadline_us = 0;
  transport->mount_deadline_generation = 0U;
  iterate_kit_retry_gate_defer(&transport->websocket_retry, now_us);
  transport->state = ITERATE_KIT_POSIX_ITX_WEBSOCKET_CONNECTING;
}

static void protocol_failure(
    struct iterate_kit_posix_itx_transport *transport,
    enum capnweb_status status,
    int64_t now_us) {
  transport->last_capnweb_status = status;
  increment(&transport->protocol_failures);
  increment(&transport->control_receive_failures);
  transport->state = ITERATE_KIT_POSIX_ITX_FAILED;
  close_generation(transport, now_us);
  /* Keep the failing result visible until the caller chooses to poll again. */
  transport->state = ITERATE_KIT_POSIX_ITX_FAILED;
}

static bool inbox_has_room(
    struct iterate_kit_posix_itx_transport *transport) {
  struct iterate_kit_spsc_ring_metrics metrics;
  if (transport->control_inbox.write_acquired) {
    return true;
  }
  iterate_kit_spsc_ring_metrics(
      transport->options.control_inbox, &metrics);
  return metrics.current_slots <
      (uint32_t)transport->options.control_inbox->slot_count;
}

static void receive_messages(
    struct iterate_kit_posix_itx_transport *transport,
    int64_t now_us) {
  unsigned int index;
  for (index = 0U;
       index < NETWORK_RECEIVE_BURST && transport->socket_connected;
       ++index) {
    struct iterate_kit_posix_websocket_chunk chunk;
    enum iterate_kit_posix_websocket_receive_result result;
    enum capnweb_status status;
    if (!inbox_has_room(transport)) {
      increment(&transport->control_inbox_deferrals);
      return;
    }
    result = iterate_kit_posix_websocket_client_receive(
        &transport->websocket, &chunk);
    if (result == ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_IDLE) {
      return;
    }
    if (result == ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_DATA) {
      status = iterate_kit_websocket_text_inbox_feed(
          &transport->control_inbox,
          chunk.opcode,
          chunk.final,
          chunk.payload_size,
          chunk.payload_offset,
          (const char *)chunk.bytes,
          chunk.byte_count);
      if (status != CAPNWEB_OK) {
        protocol_failure(transport, status, now_us);
        return;
      }
    } else if (result ==
               ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_CONTROL) {
      continue;
    } else if (result ==
               ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_PEER_CLOSE) {
      (void)iterate_kit_posix_websocket_client_service_control(
          &transport->websocket);
      close_generation(transport, now_us);
      return;
    } else if (result ==
               ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_DROPPED) {
      transport->last_platform_error = transport->websocket.last_error;
      protocol_failure(transport, CAPNWEB_E_UNSUPPORTED, now_us);
      return;
    } else if (result ==
               ITERATE_KIT_POSIX_WEBSOCKET_RECEIVE_PROTOCOL_FAILURE) {
      transport->last_platform_error = transport->websocket.last_error;
      protocol_failure(transport, CAPNWEB_E_INVALID_MESSAGE, now_us);
      return;
    } else {
      transport->last_platform_error = transport->websocket.last_error;
      increment(&transport->websocket_errors);
      close_generation(transport, now_us);
      return;
    }
  }
}

static enum iterate_kit_websocket_tx_result send_message(
    void *context, const void *message, size_t length) {
  struct iterate_kit_posix_itx_transport *transport = context;
  return iterate_kit_posix_websocket_client_send(
      &transport->websocket,
      ITERATE_KIT_WEBSOCKET_TEXT,
      message,
      length);
}

static void send_messages(
    struct iterate_kit_posix_itx_transport *transport,
    int64_t now_us) {
  unsigned int index;
  for (index = 0U;
       index < NETWORK_SEND_BURST && transport->socket_connected;
       ++index) {
    const enum iterate_kit_itx_outbox_poll_result result =
        iterate_kit_itx_outbox_sender_poll(
            &transport->control_sender, send_message, transport);
    if (result == ITERATE_KIT_ITX_OUTBOX_SENT ||
        result == ITERATE_KIT_ITX_OUTBOX_PROGRESS) {
      continue;
    }
    if (result == ITERATE_KIT_ITX_OUTBOX_IDLE ||
        result == ITERATE_KIT_ITX_OUTBOX_DEFERRED) {
      return;
    }
    transport->last_platform_error = transport->websocket.last_error;
    increment(&transport->websocket_errors);
    close_generation(transport, now_us);
    return;
  }
}

static void service_control_messages(
    struct iterate_kit_posix_itx_transport *transport,
    int64_t now_us) {
  const enum iterate_kit_websocket_tx_result result =
      iterate_kit_posix_websocket_client_service_control(
          &transport->websocket);
  if (result == ITERATE_KIT_WEBSOCKET_TX_FAILED ||
      result == ITERATE_KIT_WEBSOCKET_TX_DISCONNECTED) {
    transport->last_platform_error = transport->websocket.last_error;
    increment(&transport->websocket_errors);
    close_generation(transport, now_us);
  }
}

static int64_t transport_now_us(
    const struct iterate_kit_posix_itx_transport *transport);

static void timeout_open_attempt(
    struct iterate_kit_posix_itx_transport *transport,
    int64_t now_us) {
  increment(&transport->websocket_open_timeouts);
  transport->last_platform_error = ETIMEDOUT;
  transport->websocket_open_attempt_active = false;
  transport->websocket_open_deadline_us = 0;
  iterate_kit_posix_websocket_client_close(&transport->websocket);
  iterate_kit_retry_gate_defer(&transport->websocket_retry, now_us);
}

static void drive_socket(
    struct iterate_kit_posix_itx_transport *transport,
    int64_t now_us) {
  enum iterate_kit_posix_websocket_open_result result;
  int64_t step_now_us;
  if (!transport->socket_connected &&
      transport->state == ITERATE_KIT_POSIX_ITX_FAILED) {
    /* FAILED describes the preceding poll; a later poll begins recovery. */
    transport->state = ITERATE_KIT_POSIX_ITX_WEBSOCKET_CONNECTING;
  }
  if (transport->restart_requested) {
    transport->restart_requested = false;
    close_generation(transport, now_us);
    return;
  }
  if (!transport->socket_connected) {
    if (!iterate_kit_retry_gate_ready(
            &transport->websocket_retry, now_us)) {
      return;
    }
    if (!transport->websocket_open_attempt_active) {
      increment(&transport->websocket_start_attempts);
      transport->websocket_open_attempt_active = true;
      transport->websocket_open_deadline_us = now_us +
          (int64_t)ITERATE_KIT_VOICE_CONNECTION_OPEN_TIMEOUT_MS * 1000;
    }
    step_now_us = transport_now_us(transport);
    if (step_now_us >= transport->websocket_open_deadline_us) {
      timeout_open_attempt(transport, step_now_us);
      return;
    }
    result = iterate_kit_posix_websocket_client_open(
        &transport->websocket);
    step_now_us = transport_now_us(transport);
    if (step_now_us >= transport->websocket_open_deadline_us) {
      timeout_open_attempt(transport, step_now_us);
      return;
    }
    if (result == ITERATE_KIT_POSIX_WEBSOCKET_OPEN_WOULD_BLOCK) {
      return;
    }
    if (result == ITERATE_KIT_POSIX_WEBSOCKET_OPEN_FAILED) {
      transport->websocket_open_attempt_active = false;
      transport->websocket_open_deadline_us = 0;
      transport->last_platform_error =
          transport->websocket.last_error;
      increment(&transport->websocket_errors);
      iterate_kit_posix_websocket_client_close(
          &transport->websocket);
      iterate_kit_retry_gate_defer(
          &transport->websocket_retry, step_now_us);
      return;
    }
    if (transport->socket_generation == UINT32_MAX) {
      transport->fatal_failure_latched = true;
      transport->fatal_failure_reason =
          ITERATE_KIT_POSIX_ITX_FATAL_SOCKET_GENERATION_EXHAUSTED;
      iterate_kit_posix_websocket_client_close(
          &transport->websocket);
      transport->state = ITERATE_KIT_POSIX_ITX_FAILED;
      return;
    }
    ++transport->socket_generation;
    transport->websocket_open_attempt_active = false;
    transport->websocket_open_deadline_us = 0;
    transport->socket_connected = true;
    increment(&transport->websocket_connections);
  }
  receive_messages(transport, now_us);
  if (transport->socket_connected) {
    service_control_messages(transport, now_us);
  }
}

static enum iterate_kit_status accept_generation(
    struct iterate_kit_posix_itx_transport *transport,
    int64_t now_us) {
  enum capnweb_status status;
  if (!transport->socket_connected ||
      transport->handled_socket_generation ==
          transport->socket_generation) {
    return ITERATE_KIT_OK;
  }
  iterate_kit_itx_connection_lost(transport->options.connection);
  discard_inbox(transport);
  /*
   * This owner also performs network consumption, so unlike ESP-IDF it can
   * prove and perform the generation discard synchronously—there is no task
   * race to wait through. The same shared sender still enforces release order.
   */
  iterate_kit_itx_outbox_sender_discard(&transport->control_sender);
  if (!ring_empty(transport->options.control_outbox) ||
      iterate_kit_websocket_text_inbox_reset(
          &transport->control_inbox) != CAPNWEB_OK ||
      iterate_kit_websocket_text_outbox_reset(
          &transport->control_outbox) != CAPNWEB_OK) {
    transport->fatal_failure_latched = true;
    transport->fatal_failure_reason =
        ITERATE_KIT_POSIX_ITX_FATAL_CONTROL_RING_RESET;
    transport->state = ITERATE_KIT_POSIX_ITX_FAILED;
    return ITERATE_KIT_STATE_ERROR;
  }
  status = iterate_kit_itx_connection_open(
      transport->options.connection);
  if (status != CAPNWEB_OK) {
    transport->last_capnweb_status = status;
    transport->fatal_failure_latched = true;
    transport->fatal_failure_reason =
        ITERATE_KIT_POSIX_ITX_FATAL_CONNECTION_OPEN;
    transport->state = ITERATE_KIT_POSIX_ITX_FAILED;
    return ITERATE_KIT_STATE_ERROR;
  }
  transport->handled_socket_generation =
      transport->socket_generation;
  transport->mount_deadline_generation =
      transport->socket_generation;
  transport->mount_deadline_us = now_us +
      (int64_t)ITERATE_KIT_POSIX_ITX_MOUNT_TIMEOUT_MS * 1000;
  transport->last_capnweb_status = CAPNWEB_OK;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status drain_application(
    struct iterate_kit_posix_itx_transport *transport,
    size_t max_control_messages,
    int64_t now_us) {
  size_t processed = 0U;
  while (processed < max_control_messages) {
    const void *message;
    size_t length;
    enum capnweb_status status;
    if (iterate_kit_spsc_ring_read_acquire(
            transport->options.control_inbox,
            &message,
            &length) != ITERATE_KIT_OK) {
      break;
    }
    status = iterate_kit_itx_connection_receive_text(
        transport->options.connection, message, length);
    (void)iterate_kit_spsc_ring_read_release(
        transport->options.control_inbox);
    ++processed;
    if (status != CAPNWEB_OK) {
      protocol_failure(transport, status, now_us);
      return ITERATE_KIT_STATE_ERROR;
    }
  }
  switch (iterate_kit_itx_connection_refresh(
      transport->options.connection)) {
    case ITERATE_KIT_ITX_CONNECTION_MOUNTING:
      if (transport->mount_deadline_generation ==
              transport->socket_generation &&
          now_us >= transport->mount_deadline_us) {
        increment(&transport->mount_timeouts);
        protocol_failure(transport, CAPNWEB_E_STATE, now_us);
        return ITERATE_KIT_STATE_ERROR;
      }
      transport->state = ITERATE_KIT_POSIX_ITX_MOUNTING;
      return ITERATE_KIT_OK;
    case ITERATE_KIT_ITX_CONNECTION_READY:
      transport->mount_deadline_us = 0;
      transport->mount_deadline_generation = 0U;
      transport->ready_socket_generation =
          transport->socket_generation;
      iterate_kit_retry_gate_reset(&transport->websocket_retry);
      transport->state = ITERATE_KIT_POSIX_ITX_READY;
      return ITERATE_KIT_OK;
    case ITERATE_KIT_ITX_CONNECTION_FAILED:
      protocol_failure(
          transport,
          transport->options.connection->capnweb_status,
          now_us);
      return ITERATE_KIT_STATE_ERROR;
    case ITERATE_KIT_ITX_CONNECTION_DISCONNECTED:
    case ITERATE_KIT_ITX_CONNECTION_CLOSED:
      transport->state =
          ITERATE_KIT_POSIX_ITX_WEBSOCKET_CONNECTING;
      return ITERATE_KIT_OK;
  }
  transport->fatal_failure_latched = true;
  transport->fatal_failure_reason =
      ITERATE_KIT_POSIX_ITX_FATAL_CONNECTION_STATE;
  transport->state = ITERATE_KIT_POSIX_ITX_FAILED;
  return ITERATE_KIT_STATE_ERROR;
}

enum iterate_kit_status iterate_kit_posix_itx_transport_prepare(
    struct iterate_kit_posix_itx_transport *transport,
    const struct iterate_kit_posix_itx_transport_options *options) {
  struct iterate_kit_posix_websocket_client_options websocket_options;
  if (transport == NULL || options == NULL ||
      options->configuration == NULL || options->connection == NULL ||
      options->control_inbox == NULL ||
      !options->control_inbox->initialized ||
      options->control_outbox == NULL ||
      !options->control_outbox->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(transport, 0, sizeof(*transport));
  if (iterate_kit_configuration_build_itx_websocket_url(
          options->configuration->os_base_url,
          transport->websocket_url,
          sizeof(transport->websocket_url)) !=
      ITERATE_KIT_CONFIGURATION_OK) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  transport->options = *options;
  if (iterate_kit_websocket_text_inbox_init(
          &transport->control_inbox,
          options->control_inbox) != CAPNWEB_OK ||
      iterate_kit_websocket_text_outbox_init(
          &transport->control_outbox,
          options->control_outbox) != CAPNWEB_OK ||
      iterate_kit_itx_outbox_sender_init(
          &transport->control_sender,
          options->control_outbox) != ITERATE_KIT_OK ||
      iterate_kit_retry_gate_init(
          &transport->websocket_retry,
          WEBSOCKET_RETRY_INITIAL_MS,
          WEBSOCKET_RETRY_MAX_MS) != ITERATE_KIT_OK) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  websocket_options =
      (struct iterate_kit_posix_websocket_client_options){
        .url = transport->websocket_url,
        .receive_storage = transport->websocket_receive_storage,
        .receive_storage_capacity =
            sizeof(transport->websocket_receive_storage),
        .transmit_storage = transport->websocket_transmit_storage,
        .transmit_storage_capacity =
            sizeof(transport->websocket_transmit_storage),
        .DANGEROUS_disable_certificate_verification =
            options->DANGEROUS_disable_certificate_verification,
      };
  if (iterate_kit_posix_websocket_client_prepare(
          &transport->websocket, &websocket_options) != ITERATE_KIT_OK) {
    memset(transport, 0, sizeof(*transport));
    return ITERATE_KIT_IO_ERROR;
  }
  transport->state = ITERATE_KIT_POSIX_ITX_IDLE;
  transport->last_capnweb_status = CAPNWEB_OK;
  transport->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_posix_itx_transport_start(
    struct iterate_kit_posix_itx_transport *transport) {
  if (transport == NULL || !transport->initialized || transport->started ||
      transport->state == ITERATE_KIT_POSIX_ITX_STOPPED) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  transport->started = true;
  transport->state = ITERATE_KIT_POSIX_ITX_WEBSOCKET_CONNECTING;
  return ITERATE_KIT_OK;
}

enum capnweb_status iterate_kit_posix_itx_transport_send_text(
    void *context,
    enum capnweb_text_fragment_kind kind,
    const char *data,
    size_t length) {
  struct iterate_kit_posix_itx_transport *transport = context;
  if (transport == NULL || !transport->initialized) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  return iterate_kit_websocket_text_outbox_send(
      &transport->control_outbox, kind, data, length);
}

/** This transport's only clock source: the injected one, or the platform's. */
static int64_t transport_now_us(
    const struct iterate_kit_posix_itx_transport *transport) {
  if (transport == NULL || transport->options.now_us == NULL) {
    return platform_monotonic_microseconds();
  }
  return transport->options.now_us(transport->options.now_us_context);
}

enum iterate_kit_status iterate_kit_posix_itx_transport_poll(
    struct iterate_kit_posix_itx_transport *transport,
    size_t max_control_messages) {
  enum iterate_kit_status status;
  int64_t now_us;
  if (transport == NULL || !transport->initialized ||
      !transport->started || max_control_messages == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  now_us = transport_now_us(transport);
  if (transport->fatal_failure_latched) {
    transport->state = ITERATE_KIT_POSIX_ITX_FAILED;
    return ITERATE_KIT_STATE_ERROR;
  }
  drive_socket(transport, now_us);
  if (transport->fatal_failure_latched) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (transport->state == ITERATE_KIT_POSIX_ITX_FAILED) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (!transport->socket_connected) {
    transport->state = ITERATE_KIT_POSIX_ITX_WEBSOCKET_CONNECTING;
    return ITERATE_KIT_OK;
  }
  status = accept_generation(transport, now_us);
  if (status != ITERATE_KIT_OK) {
    return status;
  }
  status = drain_application(
      transport, max_control_messages, now_us);
  if (status != ITERATE_KIT_OK) {
    return status;
  }
  if (transport->socket_connected) {
    send_messages(transport, now_us);
    if (transport->socket_connected) {
      service_control_messages(transport, now_us);
    }
  }
  return ITERATE_KIT_OK;
}

void iterate_kit_posix_itx_transport_request_restart(
    struct iterate_kit_posix_itx_transport *transport) {
  if (transport != NULL && transport->initialized) {
    transport->restart_requested = true;
  }
}

enum iterate_kit_status iterate_kit_posix_itx_transport_stop(
    struct iterate_kit_posix_itx_transport *transport) {
  if (transport == NULL || !transport->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (transport->started) {
    transport->socket_connected = false;
    iterate_kit_posix_websocket_client_cleanup(&transport->websocket);
    iterate_kit_itx_outbox_sender_discard(&transport->control_sender);
    discard_inbox(transport);
    iterate_kit_itx_connection_lost(transport->options.connection);
    (void)iterate_kit_itx_connection_close(
        transport->options.connection);
  }
  transport->started = false;
  transport->state = ITERATE_KIT_POSIX_ITX_STOPPED;
  return ITERATE_KIT_OK;
}

void iterate_kit_posix_itx_transport_metrics(
    const struct iterate_kit_posix_itx_transport *transport,
    struct iterate_kit_posix_itx_transport_metrics *metrics) {
  struct iterate_kit_itx_outbox_sender_metrics sender_metrics;
  if (metrics == NULL) {
    return;
  }
  memset(metrics, 0, sizeof(*metrics));
  if (transport == NULL || !transport->initialized) {
    return;
  }
  iterate_kit_itx_outbox_sender_metrics(
      &transport->control_sender, &sender_metrics);
  metrics->websocket_connections = transport->websocket_connections;
  metrics->websocket_start_attempts = transport->websocket_start_attempts;
  metrics->websocket_open_timeouts = transport->websocket_open_timeouts;
  metrics->websocket_disconnects = transport->websocket_disconnects;
  metrics->websocket_errors = transport->websocket_errors;
  metrics->ready_socket_generation = transport->ready_socket_generation;
  metrics->mount_timeouts = transport->mount_timeouts;
  metrics->protocol_failures = transport->protocol_failures;
  metrics->control_messages_sent = sender_metrics.messages_sent;
  metrics->control_messages_discarded =
      transport->control_messages_discarded;
  if (sender_metrics.messages_discarded >
      UINT32_MAX - metrics->control_messages_discarded) {
    metrics->control_messages_discarded = UINT32_MAX;
  } else {
    metrics->control_messages_discarded +=
        sender_metrics.messages_discarded;
  }
  metrics->control_inbox_discarded = transport->control_inbox_discarded;
  metrics->control_inbox_deferrals = transport->control_inbox_deferrals;
  metrics->control_outbox_discarded = sender_metrics.messages_discarded;
  metrics->control_receive_failures = transport->control_receive_failures;
  metrics->control_send_failures = sender_metrics.send_failures;
  metrics->last_platform_error = transport->last_platform_error;
  metrics->last_capnweb_status = transport->last_capnweb_status;
  metrics->fatal_failure_latched = transport->fatal_failure_latched;
  metrics->fatal_failure_reason =
      (enum iterate_kit_posix_itx_fatal_failure_reason)
          transport->fatal_failure_reason;
  iterate_kit_spsc_ring_metrics(
      transport->options.control_inbox, &metrics->control_inbox);
  iterate_kit_spsc_ring_metrics(
      transport->options.control_outbox, &metrics->control_outbox);
}

void iterate_kit_posix_itx_transport_lifecycle(
    const struct iterate_kit_posix_itx_transport *transport,
    struct iterate_kit_posix_itx_transport_lifecycle *lifecycle) {
  if (lifecycle == NULL) {
    return;
  }
  memset(lifecycle, 0, sizeof(*lifecycle));
  if (transport == NULL || !transport->initialized) {
    return;
  }
  lifecycle->fatal_failure_latched = transport->fatal_failure_latched;
  lifecycle->fatal_failure_reason =
      (enum iterate_kit_posix_itx_fatal_failure_reason)
          transport->fatal_failure_reason;
  lifecycle->ready_socket_generation = transport->ready_socket_generation;
}

const char *iterate_kit_posix_itx_transport_state_name(
    enum iterate_kit_posix_itx_transport_state state) {
  switch (state) {
    case ITERATE_KIT_POSIX_ITX_IDLE:
      return "idle";
    case ITERATE_KIT_POSIX_ITX_WEBSOCKET_CONNECTING:
      return "websocket_connecting";
    case ITERATE_KIT_POSIX_ITX_MOUNTING:
      return "mounting";
    case ITERATE_KIT_POSIX_ITX_READY:
      return "ready";
    case ITERATE_KIT_POSIX_ITX_FAILED:
      return "failed";
    case ITERATE_KIT_POSIX_ITX_STOPPED:
      return "stopped";
  }
  return "unknown";
}
