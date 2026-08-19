#include "iterate/kit/platforms/esp_idf_itx_transport.h"
#include "iterate/kit/retry_gate.h"

#include <limits.h>
#include <string.h>

#include "esp_app_desc.h"
#include "esp_cpu.h"
#include "esp_mac.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "nvs_flash.h"

#include <stdio.h>

/*
 * ESP-IDF scheduler for the device's single A1 Cap'n Web connection.
 *
 * Three execution contexts are intentionally separated:
 *
 *   - ESP-IDF Wi-Fi callbacks publish only station lifecycle flags;
 *   - one static network task owns the WebSocket, reconnect policy, and I/O;
 *   - the application task alone parses Cap'n Web and invokes device code.
 *
 * The two SPSC rings are the only message handoff. This avoids locks and keeps
 * arbitrary RPC and stream-event work out of ESP-IDF's callback task, while
 * bounded poll/send bursts cap application and network-task work. A1 carries
 * mu-law media as ephemeral Cap'n Web stream events on this same /api socket;
 * there is no second binary PCM lane. We rejected a callback-driven session
 * because device methods could block ESP-IDF networking. The global queue and
 * four-frame append bounds provide the explicit pressure limit for media.
 *
 * Recovery always establishes a new socket generation. Fragments and outbound
 * messages from the old Cap'n Web session are discarded with saturating
 * diagnostics; replay across generations would be semantically unsafe even if
 * the bytes remained well formed.
 */
enum {
  /*
   * The 20 ms poll is a ceiling only when no notification arrives: Wi-Fi,
   * restart, and complete outbound messages wake the task immediately. Shorter
   * polling burns idle CPU/radio time; longer polling makes missed
   * notifications and reconnect bookkeeping unnecessarily visible to
   * capability users.
   */
  NETWORK_TASK_POLL_MS = 20,
  /* Below ESP-IDF's Wi-Fi/TCP owners; bounded passes keep application fair. */
  NETWORK_TASK_PRIORITY = 5,
  /* Prompt first recovery, then a thirty-second ceiling prevents storms. */
  WEBSOCKET_RETRY_INITIAL_MS = 250,
  WEBSOCKET_RETRY_MAX_MS = 30000,
  /* Handshake timeout is off the audio path but still bounded for recovery. */
  WEBSOCKET_CONNECT_TIMEOUT_MS = 10000,
  /*
   * Exponential retry absorbs access-point outages without a retry storm.
   * Thirty seconds caps quiet time so an unattended device still recovers
   * promptly when the network returns.
   */
  WIFI_RETRY_INITIAL_MS = 1000,
  WIFI_RETRY_MAX_MS = 30000,
  /* A connect callback must arrive before another attempt becomes eligible. */
  WIFI_CONNECT_WATCHDOG_MS = 30000,
  /*
   * Eight lower reads can consume a maximally fragmented 2 KiB control frame
   * without letting a permanently readable socket monopolize core zero.
   * Capacity remains fixed in the inbox; this is only a per-pass CPU budget.
   */
  NETWORK_RECEIVE_BURST = 8,
  /*
   * At most four complete control messages are written per network pass. This
   * amortizes wakeups while giving capability bursts a hard per-pass bound.
   */
  NETWORK_SEND_BURST = 4,
  /*
   * The sole blocking socket operation is the ten-second open handshake.
   * Shutdown must outlast that documented bound; a timeout still leaves owned
   * resources intact rather than force-deleting a task inside TLS.
   */
  STOP_TIMEOUT_MS = 12000,
  /*
   * Capability traffic can perform TLS and reconnect bookkeeping, so it shares
   * core 0 with the other network owners rather than core 1 with the 20 ms I2S
   * deadline. Priority alone is insufficient: an interrupt-disabled library
   * section on the audio core can still delay a higher-priority owner. Pinning
   * also gives cycle/headroom measurements a stable scheduling context; bounded
   * work remains necessary because both cores still share memory, radio, and
   * flash resources.
   */
  NETWORK_TASK_CORE = 0,
};

/*
 * Acquire/release is used for lifecycle flags because seeing "connected" or
 * "exited" must also make the producing task's preceding state changes visible.
 * These helpers are not a substitute for ownership: only the designated task
 * mutates each non-atomic parser/session object.
 */
static uint32_t atomic_load_u32(const uint32_t *value) {
  return __atomic_load_n(value, __ATOMIC_ACQUIRE);
}

static void atomic_store_u32(
    uint32_t *destination, uint32_t value) {
  __atomic_store_n(destination, value, __ATOMIC_RELEASE);
}

static uint32_t atomic_exchange_u32(
    uint32_t *destination, uint32_t value) {
  return __atomic_exchange_n(
      destination, value, __ATOMIC_ACQ_REL);
}

static bool atomic_publish_newer_generation(
    uint32_t *destination, uint32_t generation) {
  /*
   * Generation numbers never wrap: exhaustion is classified as a fatal local
   * limit before increment. Keeping the greatest observed failure therefore
   * solves two races without a lock: duplicate observers count one incident,
   * and a delayed callback from generation N cannot overwrite N+1.
   */
  uint32_t current = atomic_load_u32(destination);
  while (generation > current) {
    if (__atomic_compare_exchange_n(
            destination,
            &current,
            generation,
            false,
            __ATOMIC_ACQ_REL,
            __ATOMIC_ACQUIRE)) {
      return true;
    }
  }
  return false;
}

static uint32_t task_stack_headroom_bytes(TaskHandle_t task) {
  /*
   * ESP-IDF reports the minimum free stack observed since task creation. This
   * is retrospective headroom evidence, not the task's instantaneous stack
   * depth, which is why the public metric names it a high-water value.
   */
  return (uint32_t)(
      uxTaskGetStackHighWaterMark(task) * sizeof(StackType_t));
}

static void atomic_saturating_increment(uint32_t *value) {
  /*
   * Incident counters survive unattended endurance runs. Saturation preserves
   * the monotonic statement "at least UINT32_MAX" whereas wraparound would make
   * a worsening fault appear to recover.
   */
  uint32_t current = __atomic_load_n(value, __ATOMIC_RELAXED);
  while (current != UINT32_MAX &&
         !__atomic_compare_exchange_n(
             value,
             &current,
             current + 1U,
             false,
             __ATOMIC_RELAXED,
             __ATOMIC_RELAXED)) {
  }
}

static void atomic_max_u32(uint32_t *value, uint32_t candidate) {
  /* Relaxed is sufficient: this maximum is evidence, not a publication flag. */
  uint32_t current = __atomic_load_n(value, __ATOMIC_RELAXED);
  while (candidate > current &&
         !__atomic_compare_exchange_n(
             value,
             &current,
             candidate,
             false,
             __ATOMIC_RELAXED,
             __ATOMIC_RELAXED)) {
  }
}

static void remember_platform_error(
    struct iterate_kit_esp_idf_itx_transport *transport,
    esp_err_t error) {
  __atomic_store_n(
      &transport->last_platform_error,
      (int32_t)error,
      __ATOMIC_RELEASE);
}

static void wake_network_task(
    struct iterate_kit_esp_idf_itx_transport *transport) {
  TaskHandle_t task = transport->network_task;
  if (task != NULL) {
    xTaskNotifyGive(task);
  }
}

static bool valid_wifi_password(const char *password) {
  /*
   * Validate before passing credentials to ESP-IDF so a malformed 64-byte PSK
   * is classified as provisioning failure rather than an opaque asynchronous
   * Wi-Fi disconnect loop. Open networks are allowed for bring-up; passphrases
   * follow the WPA 8..63 text or 64-hex-PSK contract.
   */
  const size_t length = strlen(password);
  size_t index;
  if (length == 0U ||
      (length >= 8U && length <= 63U)) {
    return true;
  }
  if (length != 64U) {
    return false;
  }
  for (index = 0U; index < length; ++index) {
    const bool digit =
        password[index] >= '0' && password[index] <= '9';
    const bool lower =
        password[index] >= 'a' && password[index] <= 'f';
    const bool upper =
        password[index] >= 'A' && password[index] <= 'F';
    if (!digit && !lower && !upper) {
      return false;
    }
  }
  return true;
}

static bool control_ring_empty(
    const struct iterate_kit_spsc_ring *ring) {
  struct iterate_kit_spsc_ring_metrics metrics;
  iterate_kit_spsc_ring_metrics(ring, &metrics);
  return metrics.current_slots == 0U;
}

static void discard_control_inbox(
    struct iterate_kit_esp_idf_itx_transport *transport) {
  /*
   * Inbound fragments belong to the socket generation that produced them. A
   * parser reset without draining the SPSC ring would feed stale replies into
   * the new Cap'n Web session. Loss is explicit in both aggregate and
   * direction-specific counters.
   */
  const void *data;
  size_t length;
  while (iterate_kit_spsc_ring_read_acquire(
             transport->options.control_inbox,
             &data,
             &length) == ITERATE_KIT_OK) {
    (void)data;
    (void)length;
    (void)iterate_kit_spsc_ring_read_release(
        transport->options.control_inbox);
    atomic_saturating_increment(
        &transport->control_messages_discarded);
    atomic_saturating_increment(
        &transport->control_inbox_discarded);
  }
}

static void discard_control_outbox(
    struct iterate_kit_esp_idf_itx_transport *transport) {
  /*
   * Cap'n Web request IDs and export/import references are session-scoped.
   * Retrying old serialized messages after reconnect is not at-least-once
   * delivery; it is corruption. Discard and let the mount/session layer issue
   * fresh traffic against the new generation.
   */
  iterate_kit_itx_outbox_sender_discard(
      &transport->control_sender);
}

static void request_restart(
    struct iterate_kit_esp_idf_itx_transport *transport) {
  atomic_store_u32(&transport->restart_requested, 1U);
  wake_network_task(transport);
}

static void latch_fatal_failure(
    struct iterate_kit_esp_idf_itx_transport *transport,
    enum iterate_kit_esp_idf_itx_fatal_failure_reason reason) {
  uint32_t expected =
      (uint32_t)ITERATE_KIT_ESP_IDF_ITX_FATAL_NONE;
  /*
   * Several owners can observe fallout from one broken generation. Retain the
   * first local invariant, not whichever cleanup path happens to run last;
   * that first cause is what an unattended post-reboot diagnostic must report.
   */
  (void)__atomic_compare_exchange_n(
      &transport->fatal_failure_reason,
      &expected,
      (uint32_t)reason,
      false,
      __ATOMIC_ACQ_REL,
      __ATOMIC_ACQUIRE);
  atomic_store_u32(&transport->fatal_failure_latched, 1U);
  request_restart(transport);
}

static void record_protocol_failure(
    struct iterate_kit_esp_idf_itx_transport *transport,
    uint32_t generation) {
  if (generation == 0U) {
    /*
     * Peer data cannot precede the first CONNECTED event. Treating generation
     * zero as retryable would manufacture a recovery epoch for an impossible
     * local/platform ordering and hide the ownership defect.
     */
    latch_fatal_failure(
        transport,
        ITERATE_KIT_ESP_IDF_ITX_FATAL_PROTOCOL_WITHOUT_GENERATION);
    return;
  }
  if (atomic_publish_newer_generation(
          &transport->protocol_failure_generation,
          generation)) {
    /*
     * A malformed message makes this Cap'n Web session unusable, but it must
     * not brick an unattended physical device. Count once for this generation,
     * stop its I/O, and let the bounded network retry gate establish a clean
     * session. Replaying or skipping the bad message inside the same session
     * was rejected because request/reference state may already be incoherent.
     */
    atomic_saturating_increment(&transport->protocol_failures);
  }
  request_restart(transport);
}

static void remember_application_capnweb_failure(
    struct iterate_kit_esp_idf_itx_transport *transport,
    uint32_t generation,
    enum capnweb_status status) {
  if (status == CAPNWEB_OK) {
    return;
  }
  if (generation <=
      atomic_load_u32(
          &transport->last_application_capnweb_generation)) {
    /*
     * Session teardown can encounter a second transport error after the first
     * parser/serializer failure has already condemned this generation. The
     * first failure is causal; overwriting it with cleanup fallout would make
     * a token-limit or full-outbox incident look like a generic close error.
     * A newer socket epoch may replace the retained latest incident.
     */
    return;
  }
  /*
   * A healthy replacement must reset the current session status, but it must
   * not erase the reason its predecessor died. Store the status before the
   * generation publication: after the release/acquire edge, a later snapshot
   * of this settled incident cannot observe a new generation with an old
   * status. These writes occur only on the application owner and never in the
   * capture, playback, or other worker tasks.
   */
  __atomic_store_n(
      &transport->last_application_capnweb_status,
      (int32_t)status,
      __ATOMIC_RELEASE);
  atomic_store_u32(
      &transport->last_application_capnweb_generation,
      generation);
}

static void mark_socket_disconnected(
    struct iterate_kit_esp_idf_itx_transport *transport) {
  if (atomic_exchange_u32(
          &transport->socket_connected, 0U) != 0U) {
    /*
     * Multiple ESP-IDF terminal events describe one generation; count it once.
     */
    atomic_saturating_increment(
        &transport->websocket_disconnects);
  }
}

static void wifi_event(
    void *context,
    esp_event_base_t base,
    int32_t event_id,
    void *event_data) {
  struct iterate_kit_esp_idf_itx_transport *transport = context;
  (void)base;
  if (event_id == WIFI_EVENT_STA_START) {
    /*
     * Event callbacks publish intent and wake the owner; esp_wifi_connect() is
     * deliberately kept out of the event loop so retry/backoff has one owner.
     */
    atomic_store_u32(&transport->wifi_retry_now, 1U);
    wake_network_task(transport);
    return;
  }
  if (event_id == WIFI_EVENT_STA_DISCONNECTED) {
    const wifi_event_sta_disconnected_t *disconnected = event_data;
    atomic_store_u32(&transport->wifi_connected, 0U);
    atomic_saturating_increment(&transport->wifi_disconnects);
    if (disconnected != NULL) {
      __atomic_store_n(
          &transport->last_wifi_disconnect_reason,
          (int32_t)disconnected->reason,
          __ATOMIC_RELEASE);
    }
    atomic_store_u32(&transport->wifi_retry_later, 1U);
    wake_network_task(transport);
  }
}

static void ip_event(
    void *context,
    esp_event_base_t base,
    int32_t event_id,
    void *event_data) {
  struct iterate_kit_esp_idf_itx_transport *transport = context;
  (void)base;
  (void)event_data;
  if (event_id == IP_EVENT_STA_GOT_IP) {
    atomic_store_u32(&transport->wifi_connected, 1U);
    wake_network_task(transport);
  }
}

static void fail_receive(
    struct iterate_kit_esp_idf_itx_transport *transport,
    int32_t status) {
  atomic_saturating_increment(
      &transport->control_receive_failures);
  __atomic_store_n(
      &transport->last_control_receive_status,
      status,
      __ATOMIC_RELEASE);
  /*
   * The sole network owner is also the only producer of inbound control
   * messages, so the current generation is stable for this observation. If a
   * future platform introduces another socket task, generation must travel
   * with each queued chunk instead of reintroducing an implicit lookup race.
   */
  record_protocol_failure(
      transport,
      atomic_load_u32(&transport->socket_generation));
}

static void fail_receive_fatal(
    struct iterate_kit_esp_idf_itx_transport *transport,
    int32_t status) {
  /*
   * This path is reserved for a local epoch invariant that a fresh peer cannot
   * repair. It intentionally shares the receive diagnostics with bad input,
   * while the fatal latch distinguishes "replace this socket" from "continuing
   * could confuse an ancient generation with a new one."
   */
  atomic_saturating_increment(
      &transport->control_receive_failures);
  __atomic_store_n(
      &transport->last_control_receive_status,
      status,
      __ATOMIC_RELEASE);
  latch_fatal_failure(
      transport,
      ITERATE_KIT_ESP_IDF_ITX_FATAL_SOCKET_GENERATION_EXHAUSTED);
}

static bool mark_socket_connected(
    struct iterate_kit_esp_idf_itx_transport *transport) {
  const uint32_t generation =
      atomic_load_u32(&transport->socket_generation);
  if (atomic_load_u32(&transport->socket_connected)) {
    return false;
  }
  if (generation == UINT32_MAX) {
    /*
     * Generation zero is the never-connected sentinel and values are compared
     * exactly across tasks. Wrapping would make an ancient epoch look new, so
     * exhaustion is a fatal local limit even though the socket just opened.
     */
    fail_receive_fatal(transport, CAPNWEB_E_LIMIT);
    return false;
  }
  atomic_store_u32(
      &transport->socket_generation, generation + 1U);
  /*
   * Publish the incremented generation before connected. The application can
   * therefore never accept a connected flag paired with the prior session.
   */
  atomic_store_u32(&transport->socket_connected, 1U);
  atomic_saturating_increment(
      &transport->websocket_connections);
  return true;
}

static void remember_websocket_error(
    struct iterate_kit_esp_idf_itx_transport *transport,
    int32_t error) {
  /*
   * The lower taskless adapter exposes the errno/result at the point it loses
   * framing trust. It cannot expose the managed client's callback-only TLS and
   * HTTP tuple, so preserve the real domain and leave unavailable fields zero.
   */
  atomic_saturating_increment(&transport->websocket_errors);
  atomic_store_u32(
      &transport->last_websocket_error_generation,
      atomic_load_u32(&transport->socket_generation));
  __atomic_store_n(
      &transport->last_websocket_transport_errno,
      error,
      __ATOMIC_RELEASE);
  remember_platform_error(transport, (esp_err_t)error);
}

static bool service_websocket_control(
    struct iterate_kit_esp_idf_itx_transport *transport) {
  enum iterate_kit_websocket_tx_result result;
  /*
   * The application asked the hop a question. Consumed here because this is
   * the network task, which is the connection's only legal owner, and this
   * function is the one thing every path through the loop calls while the
   * socket is up. Exchanged rather than loaded so one request is one PING.
   */
  if (atomic_exchange_u32(&transport->probe_requested, 0U)) {
    (void)iterate_kit_esp_idf_websocket_connection_probe(
        &transport->websocket);
  }
  result =
      iterate_kit_esp_idf_websocket_connection_service_control(
          &transport->websocket);
  if (result == ITERATE_KIT_WEBSOCKET_TX_IDLE ||
      result == ITERATE_KIT_WEBSOCKET_TX_SENT ||
      result == ITERATE_KIT_WEBSOCKET_TX_PROGRESS ||
      result == ITERATE_KIT_WEBSOCKET_TX_DEFERRED) {
    return true;
  }
  remember_websocket_error(
      transport, transport->websocket.last_error);
  mark_socket_disconnected(transport);
  request_restart(transport);
  return false;
}

/*
 * Real backpressure, and the reason the inbox can no longer overflow.
 *
 * Reading a message the inbox cannot hold is fatal by design: dropping it
 * would let the peer believe an RPC was delivered that the capability task
 * never saw. But nothing obliged us to read it. The transport owns
 * non-blocking reads, so when there is no room we simply do not read — the
 * bytes stay in lwIP, the TCP window closes, and the sender backs off. That
 * turns the ring size into a latency knob instead of a liveness cliff.
 *
 * Deferring is only safe at a message boundary: mid-message, a slot is
 * already reserved and the remaining fragments must be consumed to keep the
 * JSON contiguous. `write_acquired` is exactly that flag.
 */
static bool inbox_has_room(
    struct iterate_kit_esp_idf_itx_transport *transport) {
  struct iterate_kit_spsc_ring_metrics metrics;
  if (transport->control_inbox.write_acquired) {
    return true; /* mid-message: the slot is already ours */
  }
  iterate_kit_spsc_ring_metrics(transport->options.control_inbox, &metrics);
  return metrics.current_slots <
      (uint32_t)transport->options.control_inbox->slot_count;
}

static void receive_control_messages(
    struct iterate_kit_esp_idf_itx_transport *transport) {
  unsigned int received;
  for (received = 0U;
       received < NETWORK_RECEIVE_BURST &&
       atomic_load_u32(&transport->socket_connected);
       ++received) {
    struct iterate_kit_esp_idf_websocket_chunk chunk;
    if (!inbox_has_room(transport)) {
      /*
       * Full: leave it on the socket. The consumer drains every poll, so this
       * resolves in milliseconds; if it somehow does not, the peer's own
       * timeouts apply rather than us corrupting the session.
       */
      atomic_saturating_increment(&transport->control_inbox_deferrals);
      return;
    }
    const enum iterate_kit_esp_idf_websocket_receive_result result =
        iterate_kit_esp_idf_websocket_connection_receive(
            &transport->websocket, 0, &chunk);
    if (result ==
        ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_IDLE) {
      return;
    }
    if (result ==
        ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_DATA) {
      const enum capnweb_status status =
          iterate_kit_websocket_text_inbox_feed(
              &transport->control_inbox,
              chunk.opcode,
              chunk.final,
              chunk.payload_size,
              chunk.payload_offset,
              (const char *)chunk.bytes,
              chunk.byte_count);
      if (status != CAPNWEB_OK) {
        /*
         * Dropping one fragment and continuing would splice later JSON onto a
         * stale prefix. The whole generation is replaced instead, with the
         * exact Cap'n Web classification retained for diagnostics.
         */
        fail_receive(transport, (int32_t)status);
        return;
      }
      continue;
    }
    if (result ==
        ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_CONTROL) {
      continue;
    }
    if (result ==
        ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_PEER_CLOSE) {
      /*
       * Give the queued CLOSE response one bounded write attempt before the
       * next owner pass tears the socket down. Peer close is lifecycle, not an
       * unexplained transport error.
       */
      (void)service_websocket_control(transport);
      mark_socket_disconnected(transport);
      request_restart(transport);
      return;
    }
    if (result ==
        ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_DROPPED) {
      fail_receive(transport, CAPNWEB_E_UNSUPPORTED);
      return;
    }
    if (result ==
        ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_PROTOCOL_FAILURE) {
      remember_websocket_error(
          transport, transport->websocket.last_error);
      fail_receive(transport, CAPNWEB_E_INVALID_MESSAGE);
      return;
    }
    remember_websocket_error(
        transport, transport->websocket.last_error);
    mark_socket_disconnected(transport);
    request_restart(transport);
    return;
  }
}

static enum iterate_kit_websocket_tx_result send_control_message(
    void *context, const void *message, size_t length) {
  struct iterate_kit_esp_idf_itx_transport *transport = context;
  return iterate_kit_esp_idf_websocket_connection_send(
      &transport->websocket,
      ITERATE_KIT_WEBSOCKET_TEXT,
      message,
      length);
}

static void send_control_messages(
    struct iterate_kit_esp_idf_itx_transport *transport) {
  unsigned int work_steps;
  if (atomic_load_u32(&transport->socket_generation) !=
      atomic_load_u32(
          &transport->accepted_socket_generation)) {
    /*
     * ESP-IDF can report CONNECTED before the application task has torn down
     * the old Cap'n Web session and mounted the new one. Sending during that
     * window could put old-session authentication/RPC bytes on the new socket.
     */
    discard_control_outbox(transport);
    return;
  }
  for (work_steps = 0U;
       work_steps < NETWORK_SEND_BURST;
       ++work_steps) {
    enum iterate_kit_itx_outbox_poll_result result;
    if (!atomic_load_u32(&transport->socket_connected)) {
      return;
    }
    result = iterate_kit_itx_outbox_sender_poll(
        &transport->control_sender,
        send_control_message,
        transport);
    if (result == ITERATE_KIT_ITX_OUTBOX_SENT) {
      continue;
    }
    if (result == ITERATE_KIT_ITX_OUTBOX_PROGRESS) {
      /*
       * A short write is ordinary nonblocking progress. Keep both the writer
       * cursor and ring head, then spend at most the remaining work budget on
       * its suffix; no second frame or duplicate RPC is manufactured.
       */
      continue;
    }
    if (result == ITERATE_KIT_ITX_OUTBOX_IDLE ||
        result == ITERATE_KIT_ITX_OUTBOX_DEFERRED) {
      return;
    }
    {
      /*
       * A failed frame may have a prefix below TLS. Retrying the logical
       * Cap'n Web message could duplicate a method call; carrying it into a new
       * generation would reuse session references. Abandon it visibly, close
       * the opaque byte stream, and let the remounted session reconstruct only
       * fresh work.
       */
      remember_websocket_error(
          transport, transport->websocket.last_error);
      mark_socket_disconnected(transport);
      request_restart(transport);
      return;
    }
  }
}

/*
 * Fleet forensics on the upgrade request itself: which radio conditions and
 * which build dialed. Written before every open so RSSI is this handshake's,
 * not boot's; the server reads them before the first Cap'n Web frame exists.
 * Failure here must never block dialing — a blank header beats no socket.
 */
static void refresh_handshake_headers(
    struct iterate_kit_esp_idf_itx_transport *transport) {
  uint8_t mac[6] = {0};
  wifi_ap_record_t ap_info;
  int rssi = 0;
  (void)esp_efuse_mac_get_default(mac);
  if (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) {
    rssi = ap_info.rssi;
  }
  (void)snprintf(
      transport->websocket_headers,
      sizeof(transport->websocket_headers),
      "X-Iterate-Mac: %02x:%02x:%02x:%02x:%02x:%02x\r\n"
      "X-Iterate-Fw: %s\r\n"
      "X-Wifi-Rssi: %d\r\n",
      mac[0], mac[1], mac[2], mac[3], mac[4], mac[5],
      esp_app_get_description()->version,
      rssi);
}

static void stop_websocket(
    struct iterate_kit_esp_idf_itx_transport *transport,
    bool *websocket_open) {
  if (!*websocket_open &&
      transport->websocket.parent == NULL &&
      transport->websocket.websocket == NULL) {
    iterate_kit_itx_outbox_sender_discard(
        &transport->control_sender);
    return;
  }
  mark_socket_disconnected(transport);
  /*
   * Reset the resumable writer and destroy the lower stream before releasing
   * any borrowed outbox head. That order proves no retained encoded suffix can
   * observe a slot after its producer is allowed to reuse it. Unlike
   * the former managed-client stop, this close has no private task to join with
   * an unbounded wait.
   */
  iterate_kit_esp_idf_websocket_connection_close(
      &transport->websocket);
  iterate_kit_itx_outbox_sender_discard(
      &transport->control_sender);
  *websocket_open = false;
  atomic_store_u32(&transport->websocket_started, 0U);
}

static void network_task(void *context) {
  struct iterate_kit_esp_idf_itx_transport *transport = context;
  struct iterate_kit_retry_gate websocket_retry;
  uint32_t wifi_retry_ms = WIFI_RETRY_INITIAL_MS;
  int64_t wifi_retry_at_us = 0;
  bool prior_wifi_connected = false;
  bool websocket_started = false;
  (void)iterate_kit_retry_gate_init(
      &websocket_retry,
      WEBSOCKET_RETRY_INITIAL_MS,
      WEBSOCKET_RETRY_MAX_MS);
  atomic_store_u32(&transport->network_task_running, 1U);
  /*
   * Subscribe to the task watchdog so a wedged transport becomes a classified
   * task-watchdog reset instead of a silently dead socket. The one blocking
   * operation in a pass — the ten-second open handshake — fits inside the
   * configured 20 s budget with the same headroom the voice loop relies on.
   */
  (void)esp_task_wdt_add(NULL);

  /*
   * One pass is intentionally bounded: consume published flags, make at most
   * one Wi-Fi/start transition, then send a small control burst. Notifications
   * collapse duplicate wakeups, so correctness cannot depend on receiving one
   * wake per event; the 20 ms timed poll closes that liveness gap.
   */
  while (atomic_load_u32(&transport->network_task_running)) {
    (void)esp_task_wdt_reset();
    TickType_t wait_ticks = pdMS_TO_TICKS(NETWORK_TASK_POLL_MS);
    int64_t now_us;
    bool wifi_connected;
    if (wait_ticks == 0U) {
      wait_ticks = 1U;
    }
    (void)ulTaskNotifyTake(pdTRUE, wait_ticks);
    const uint32_t work_started_at = esp_cpu_get_cycle_count();
    now_us = esp_timer_get_time();
    wifi_connected =
        atomic_load_u32(&transport->wifi_connected) != 0U;
    if (atomic_load_u32(&transport->socket_connected) &&
        atomic_load_u32(&transport->ready_socket_generation) ==
            atomic_load_u32(&transport->socket_generation)) {
      /*
       * A CONNECTED callback proves only TCP/TLS/WebSocket setup. Resetting the
       * gate there let an incompatible peer force four handshakes per second.
       * The application publishes READY only after authentication and mount,
       * so repeated pre-mount protocol failures retain exponential backoff.
       */
      iterate_kit_retry_gate_reset(&websocket_retry);
    }

    if (wifi_connected && !prior_wifi_connected) {
      /*
       * A proven IP lease resets both retry histories for immediate recovery.
       */
      wifi_retry_ms = WIFI_RETRY_INITIAL_MS;
      wifi_retry_at_us = 0;
      iterate_kit_retry_gate_reset(&websocket_retry);
    } else if (!wifi_connected && prior_wifi_connected) {
      /*
       * Defer after loss instead of reconnecting from the callback. Doubling is
       * saturating so a prolonged outage cannot overflow into a retry storm.
       */
      wifi_retry_at_us =
          now_us + (int64_t)wifi_retry_ms * 1000;
      if (wifi_retry_ms < WIFI_RETRY_MAX_MS / 2U) {
        wifi_retry_ms *= 2U;
      } else {
        wifi_retry_ms = WIFI_RETRY_MAX_MS;
      }
    }
    prior_wifi_connected = wifi_connected;

    if (atomic_exchange_u32(&transport->wifi_retry_now, 0U)) {
      wifi_retry_at_us = now_us;
    }
    if (atomic_exchange_u32(
            &transport->wifi_retry_later, 0U)) {
      wifi_retry_at_us =
          now_us + (int64_t)wifi_retry_ms * 1000;
      if (wifi_retry_ms < WIFI_RETRY_MAX_MS / 2U) {
        wifi_retry_ms *= 2U;
      } else {
        wifi_retry_ms = WIFI_RETRY_MAX_MS;
      }
    }
    if (!wifi_connected &&
        wifi_retry_at_us != 0 &&
        now_us >= wifi_retry_at_us) {
      const esp_err_t error = esp_wifi_connect();
      atomic_saturating_increment(
          &transport->wifi_connect_attempts);
      if (error != ESP_OK) {
        remember_platform_error(transport, error);
      }
      wifi_retry_at_us =
          now_us + (int64_t)WIFI_CONNECT_WATCHDOG_MS * 1000;
    }

    if (!wifi_connected && websocket_started) {
      /*
       * A WebSocket cannot remain a valid Cap'n Web generation without its
       * station lease. Close it eagerly so no opaque TCP/TLS suffix can look
       * fresh after Wi-Fi returns.
       */
      stop_websocket(transport, &websocket_started);
    }

    if (atomic_exchange_u32(
            &transport->restart_requested, 0U) &&
        websocket_started) {
      stop_websocket(transport, &websocket_started);
      iterate_kit_retry_gate_defer(
          &websocket_retry, now_us);
    }

    if (wifi_connected &&
        !atomic_load_u32(
            &transport->fatal_failure_latched) &&
        !websocket_started &&
        iterate_kit_retry_gate_ready(
            &websocket_retry, now_us)) {
      enum iterate_kit_status status;
      if (task_stack_headroom_bytes(NULL) <
          ITERATE_KIT_ESP_IDF_NETWORK_TASK_MINIMUM_HEADROOM_BYTES) {
        /*
         * TLS/WebSocket startup has the deepest stack demand. Starting below
         * the measured floor risks silent stack corruption, so fail closed and
         * retain a dedicated diagnostic instead of repeatedly reconnecting.
         */
        atomic_saturating_increment(
            &transport->network_task_stack_exhaustions);
        remember_platform_error(transport, ESP_ERR_NO_MEM);
        latch_fatal_failure(
            transport,
            ITERATE_KIT_ESP_IDF_ITX_FATAL_NETWORK_STACK_HEADROOM);
        continue;
      }
      atomic_saturating_increment(
          &transport->websocket_start_attempts);
      refresh_handshake_headers(transport);
      status =
          iterate_kit_esp_idf_websocket_connection_open(
              &transport->websocket,
              WEBSOCKET_CONNECT_TIMEOUT_MS);
      /*
       * DNS/TCP/TLS/upgrade may consume the entire setup bound. Retry policy
       * must use the clock after that operation, not a stale pre-handshake
       * sample that can make the next deadline immediately eligible.
       */
      now_us = esp_timer_get_time();
      if (status == ITERATE_KIT_OK &&
          mark_socket_connected(transport)) {
        websocket_started = true;
        atomic_store_u32(&transport->websocket_started, 1U);
      } else {
        if (status == ITERATE_KIT_OK) {
          remember_platform_error(
              transport, ESP_ERR_INVALID_STATE);
          latch_fatal_failure(
              transport,
              ITERATE_KIT_ESP_IDF_ITX_FATAL_WEBSOCKET_OPEN_INVARIANT);
        } else {
          remember_websocket_error(
              transport, transport->websocket.last_error);
          iterate_kit_retry_gate_defer(
              &websocket_retry, now_us);
        }
        iterate_kit_esp_idf_websocket_connection_close(
            &transport->websocket);
      }
    }

    if (!atomic_load_u32(&transport->socket_connected)) {
      discard_control_outbox(transport);
    } else {
      receive_control_messages(transport);
      if (atomic_load_u32(&transport->socket_connected)) {
        (void)service_websocket_control(transport);
      }
    }
    if (atomic_load_u32(&transport->socket_connected)) {
      send_control_messages(transport);
      if (atomic_load_u32(&transport->socket_connected)) {
        (void)service_websocket_control(transport);
      }
    }
    const uint32_t work_cycles =
        esp_cpu_get_cycle_count() - work_started_at;
    /*
     * Cycle subtraction is intentionally unsigned so one hardware counter wrap
     * within a short pass still yields the correct duration. The cumulative
     * 32-bit value is sampled as a modulo counter; max-work remains the
     * per-pass tail-latency guardrail.
     */
    (void)__atomic_fetch_add(
        &transport->network_task_work_cycles,
        work_cycles,
        __ATOMIC_RELAXED);
    atomic_max_u32(
        &transport->network_task_max_work_cycles,
        work_cycles);
  }

  stop_websocket(transport, &websocket_started);
  discard_control_outbox(transport);
  (void)esp_task_wdt_delete(NULL);
  /*
   * Publish exited only after the task has stopped socket I/O and released its
   * final ring ownership. stop() may then destroy shared ESP-IDF resources
   * without racing this task.
   */
  atomic_store_u32(&transport->network_task_exited, 1U);
  vTaskDelete(NULL);
}

enum iterate_kit_status iterate_kit_esp_idf_itx_transport_prepare(
    struct iterate_kit_esp_idf_itx_transport *transport,
    const struct iterate_kit_esp_idf_itx_transport_options *options) {
  enum iterate_kit_configuration_error configuration_error;
  enum iterate_kit_status status;
  struct iterate_kit_esp_idf_websocket_connection_options
      websocket_options;
  if (transport == NULL ||
      options == NULL ||
      options->configuration == NULL ||
      options->connection == NULL ||
      options->control_inbox == NULL ||
      !options->control_inbox->initialized ||
      options->control_outbox == NULL ||
      !options->control_outbox->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(transport, 0, sizeof(*transport));
  if (!valid_wifi_password(
          options->configuration->wifi_password)) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  configuration_error =
      iterate_kit_configuration_build_itx_websocket_url(
          options->configuration->os_base_url,
          transport->websocket_url,
          sizeof(transport->websocket_url));
  if (configuration_error != ITERATE_KIT_CONFIGURATION_OK) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  transport->options = *options;
  /*
   * The fragment adapters wrap caller-owned SPSC rings; they allocate nothing.
   * Initializing both before publishing `initialized` prevents callbacks or a
   * premature start from observing only half of the task handoff.
   */
  if (iterate_kit_websocket_text_inbox_init(
          &transport->control_inbox,
          options->control_inbox) != CAPNWEB_OK ||
      iterate_kit_websocket_text_outbox_init(
          &transport->control_outbox,
          options->control_outbox) != CAPNWEB_OK ||
      iterate_kit_itx_outbox_sender_init(
          &transport->control_sender,
          options->control_outbox) != ITERATE_KIT_OK) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  websocket_options =
      (struct
       iterate_kit_esp_idf_websocket_connection_options){
        .url = transport->websocket_url,
        /*
         * Authentication and mounting are Cap'n Web messages on this endpoint,
         * not HTTP upgrade credentials. NULL avoids inventing an empty
         * Sec-WebSocket-Protocol header or allocating empty header strings in
         * the ESP lower transport.
         */
        .subprotocol = NULL,
        .headers = transport->websocket_headers,
        .receive_storage =
            transport->websocket_receive_storage,
        .receive_storage_capacity =
            sizeof(transport->websocket_receive_storage),
        .transmit_storage =
            transport->websocket_transmit_storage,
        .transmit_storage_capacity =
            sizeof(transport->websocket_transmit_storage),
      };
  status =
      iterate_kit_esp_idf_websocket_connection_prepare(
          &transport->websocket, &websocket_options);
  if (status != ITERATE_KIT_OK) {
    memset(transport, 0, sizeof(*transport));
    return status;
  }
  transport->state = ITERATE_KIT_ESP_IDF_ITX_IDLE;
  transport->last_capnweb_status = CAPNWEB_OK;
  transport->initialized = true;
  return ITERATE_KIT_OK;
}

enum capnweb_status iterate_kit_esp_idf_itx_transport_send_text(
    void *context,
    enum capnweb_text_fragment_kind kind,
    const char *data,
    size_t length) {
  struct iterate_kit_esp_idf_itx_transport *transport = context;
  enum capnweb_status status;
  if (transport == NULL || !transport->initialized) {
    return CAPNWEB_E_INVALID_ARGUMENT;
  }
  status = iterate_kit_websocket_text_outbox_send(
      &transport->control_outbox, kind, data, length);
  if (status == CAPNWEB_OK && kind == CAPNWEB_TEXT_END) {
    /*
     * Fragments are assembled in caller-owned storage. Only END publishes a
     * complete ring slot, so earlier wakes cannot expose a partial JSON message
     * and would waste scheduler cycles.
     */
    wake_network_task(transport);
  }
  return status;
}

enum iterate_kit_status iterate_kit_esp_idf_itx_transport_start(
    struct iterate_kit_esp_idf_itx_transport *transport) {
  wifi_init_config_t wifi_initialization =
      WIFI_INIT_CONFIG_DEFAULT();
  wifi_config_t wifi_configuration = {0};
  wifi_bandwidth_t actual_bandwidth;
  wifi_ps_type_t actual_power_save;
  esp_err_t error;
  size_t ssid_length;
  size_t password_length;
  if (transport == NULL ||
      !transport->initialized ||
      transport->started) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  error = nvs_flash_init();
  if (error == ESP_ERR_NVS_NO_FREE_PAGES ||
      error == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    /*
     * ESP-IDF Wi-Fi requires NVS even though credentials themselves are held in
     * RAM. These two statuses mean NVS cannot be used in its current format;
     * erase is the documented recovery. Other errors remain explicit because a
     * blanket erase would destroy unrelated durable device state.
     */
    error = nvs_flash_erase();
    if (error == ESP_OK) {
      error = nvs_flash_init();
    }
  }
  if (error != ESP_OK) {
    remember_platform_error(transport, error);
    return ITERATE_KIT_IO_ERROR;
  }
  error = esp_netif_init();
  if (error != ESP_OK && error != ESP_ERR_INVALID_STATE) {
    remember_platform_error(transport, error);
    return ITERATE_KIT_IO_ERROR;
  }
  error = esp_event_loop_create_default();
  if (error == ESP_OK) {
    transport->owns_default_event_loop = true;
  } else if (error != ESP_ERR_INVALID_STATE) {
    remember_platform_error(transport, error);
    return ITERATE_KIT_IO_ERROR;
  }
  transport->station = esp_netif_create_default_wifi_sta();
  if (transport->station == NULL) {
    remember_platform_error(transport, ESP_ERR_NO_MEM);
    return ITERATE_KIT_IO_ERROR;
  }
  error = esp_wifi_init(&wifi_initialization);
  if (error != ESP_OK) {
    remember_platform_error(transport, error);
    return ITERATE_KIT_IO_ERROR;
  }
  error = esp_event_handler_instance_register(
      WIFI_EVENT,
      ESP_EVENT_ANY_ID,
      wifi_event,
      transport,
      &transport->wifi_event_handler);
  if (error != ESP_OK) {
    remember_platform_error(transport, error);
    return ITERATE_KIT_IO_ERROR;
  }
  error = esp_event_handler_instance_register(
      IP_EVENT,
      IP_EVENT_STA_GOT_IP,
      ip_event,
      transport,
      &transport->ip_event_handler);
  if (error != ESP_OK) {
    remember_platform_error(transport, error);
    return ITERATE_KIT_IO_ERROR;
  }

  ssid_length =
      strlen(transport->options.configuration->wifi_ssid);
  password_length =
      strlen(transport->options.configuration->wifi_password);
  memcpy(
      wifi_configuration.sta.ssid,
      transport->options.configuration->wifi_ssid,
      ssid_length);
  memcpy(
      wifi_configuration.sta.password,
      transport->options.configuration->wifi_password,
      password_length);
  wifi_configuration.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
  wifi_configuration.sta.sort_method =
      WIFI_CONNECT_AP_BY_SIGNAL;
  /*
   * Scan all channels and select by signal so a provisioned SSID can roam
   * without a baked-in BSSID/channel. Credentials stay in RAM: persisting the
   * project-installed secret again through Wi-Fi storage would create a second
   * lifecycle/revocation surface.
   */
  wifi_configuration.sta.threshold.authmode =
      password_length == 0U
      ? WIFI_AUTH_OPEN
      : WIFI_AUTH_WPA2_PSK;
  wifi_configuration.sta.pmf_cfg.capable = true;
  wifi_configuration.sta.pmf_cfg.required = false;
  wifi_configuration.sta.sae_pwe_h2e = WPA3_SAE_PWE_BOTH;
  error = esp_wifi_set_storage(WIFI_STORAGE_RAM);
  if (error == ESP_OK) {
    error = esp_wifi_set_mode(WIFI_MODE_STA);
  }
  if (error == ESP_OK) {
    error = esp_wifi_set_config(
        WIFI_IF_STA, &wifi_configuration);
  }
  if (error != ESP_OK) {
    remember_platform_error(transport, error);
    return ITERATE_KIT_IO_ERROR;
  }

  atomic_store_u32(&transport->network_task_running, 1U);
  transport->network_task = xTaskCreateStaticPinnedToCore(
      network_task,
      "iterate-net",
      ITERATE_KIT_ESP_IDF_NETWORK_TASK_STACK_BYTES,
      transport,
      NETWORK_TASK_PRIORITY,
      transport->network_task_stack,
      &transport->network_task_storage,
      NETWORK_TASK_CORE);
  /*
   * Static creation makes the task's stack/control block part of sizeof the
   * transport, so compiled/runtime memory reports include it and reconnects
   * cannot fail from allocator fragmentation.
   */
  if (transport->network_task == NULL) {
    atomic_store_u32(&transport->network_task_running, 0U);
    remember_platform_error(transport, ESP_ERR_NO_MEM);
    return ITERATE_KIT_IO_ERROR;
  }
  error = esp_wifi_start();
  /*
   * Voice stream events are latency-sensitive but tiny relative to even HT20
   * capacity.
   * A physical M5StickS3 associated to this 2.4 GHz AP at HT40 while the Mac
   * and otherwise healthy HAVPE used 20 MHz; only the Stick then showed
   * repeatable 2--3 second reachability holes. ESP32-S3 does not implement
   * HT20/40 coexistence, so accepting the wider SDK/AP default also occupies a
   * secondary channel with no useful throughput benefit to this application.
   * Pin all voice stations to HT20 after the interface is enabled, as required
   * by ESP-IDF. Readback makes a silently ignored policy a startup error rather
   * than allowing network-invalid audio evidence.
   */
  if (error == ESP_OK) {
    error = esp_wifi_set_bandwidth(
        WIFI_IF_STA, WIFI_BW_HT20);
  }
  if (error == ESP_OK) {
    error = esp_wifi_get_bandwidth(
        WIFI_IF_STA, &actual_bandwidth);
  }
  if (error == ESP_OK && actual_bandwidth != WIFI_BW_HT20) {
    error = ESP_ERR_INVALID_STATE;
  }
  /*
   * Disable modem sleep only after the Wi-Fi driver is started. This follows
   * ESP-IDF's own low-latency/throughput examples. Calling set_ps before start
   * returned ESP_OK on the physical Stick, but the board then showed periodic
   * ICMP loss and a one-second Cap'n Web stall despite strong RSSI. Read the
   * policy back instead of assuming a successful setter means the live driver
   * retained it. A voice device with unknown power policy is not allowed to
   * continue into a timing proof.
   */
  if (error == ESP_OK) {
    error = esp_wifi_set_ps(WIFI_PS_NONE);
  }
  if (error == ESP_OK) {
    error = esp_wifi_get_ps(&actual_power_save);
  }
  if (error == ESP_OK && actual_power_save != WIFI_PS_NONE) {
    error = ESP_ERR_INVALID_STATE;
  }
  if (error != ESP_OK) {
    atomic_store_u32(&transport->network_task_running, 0U);
    wake_network_task(transport);
    (void)esp_wifi_stop();
    remember_platform_error(transport, error);
    return ITERATE_KIT_IO_ERROR;
  }
  transport->started = true;
  transport->state =
      ITERATE_KIT_ESP_IDF_ITX_WIFI_CONNECTING;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_esp_idf_itx_transport_poll(
    struct iterate_kit_esp_idf_itx_transport *transport,
    size_t max_control_messages) {
  uint32_t protocol_failure_generation;
  uint32_t socket_generation;
  bool socket_connected;
  size_t processed = 0U;
  if (transport == NULL ||
      !transport->initialized ||
      !transport->started ||
      max_control_messages == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  socket_connected =
      atomic_load_u32(&transport->socket_connected) != 0U;
  socket_generation =
      atomic_load_u32(&transport->socket_generation);
  protocol_failure_generation = atomic_load_u32(
      &transport->protocol_failure_generation);
  if (atomic_load_u32(
          &transport->fatal_failure_latched)) {
    transport->mount_deadline_us = 0;
    transport->mount_deadline_generation = 0U;
    iterate_kit_itx_connection_lost(
        transport->options.connection);
    discard_control_inbox(transport);
    /*
     * Fatal is reserved for local ownership/resource invariants that a clean
     * peer cannot repair. The network task remains the outbox's sole consumer;
     * asking this application task to drain it would violate the SPSC contract
     * precisely while the network owner may be releasing an acquired slot.
     */
    transport->state = ITERATE_KIT_ESP_IDF_ITX_FAILED;
    return ITERATE_KIT_STATE_ERROR;
  }
  if (protocol_failure_generation != 0U &&
      socket_generation <= protocol_failure_generation) {
    transport->mount_deadline_us = 0;
    transport->mount_deadline_generation = 0U;
    /*
     * Mark the protocol object disconnected even when the rejection already
     * closed its session. Gating this on session_open strands mount rejection
     * in FAILED, making connection_open() reject the replacement generation as
     * a false local invariant.
     */
    iterate_kit_itx_connection_lost(
        transport->options.connection);
    discard_control_inbox(transport);
    /*
     * The current Cap'n Web epoch is unusable, but the physical device is not.
     * FAILED remains visible until the network owner establishes a strictly
     * newer socket generation. The failure generation is never cleared: a
     * delayed callback for this epoch then remains an idempotent observation
     * instead of racing a boolean clear for the replacement socket.
     */
    transport->state = ITERATE_KIT_ESP_IDF_ITX_FAILED;
    return ITERATE_KIT_STATE_ERROR;
  }
  if (!socket_connected) {
    transport->mount_deadline_us = 0;
    transport->mount_deadline_generation = 0U;
    iterate_kit_itx_connection_lost(
        transport->options.connection);
    discard_control_inbox(transport);
    /*
     * Any partial inbound message is tied to the lost TLS/WebSocket stream.
     * Discard immediately so recovery starts from a clean text-frame boundary;
     * the outbox is drained by its network-task owner.
     */
    if (!atomic_load_u32(&transport->wifi_connected)) {
      transport->state =
          ITERATE_KIT_ESP_IDF_ITX_WIFI_CONNECTING;
    } else {
      transport->state =
          ITERATE_KIT_ESP_IDF_ITX_WEBSOCKET_CONNECTING;
    }
    return ITERATE_KIT_OK;
  }

  if (socket_generation !=
      transport->handled_socket_generation) {
    enum capnweb_status status;
    iterate_kit_itx_connection_lost(
        transport->options.connection);
    discard_control_inbox(transport);
    if (!control_ring_empty(
            transport->options.control_outbox)) {
      /*
       * The application cannot reset the outbox while the network task may
       * still own its head. Wait until that sole consumer has discarded it,
       * then reset both fragment assemblers and accept the new generation.
       */
      transport->state =
          ITERATE_KIT_ESP_IDF_ITX_WEBSOCKET_CONNECTING;
      wake_network_task(transport);
      return ITERATE_KIT_OK;
    }
    status = iterate_kit_websocket_text_inbox_reset(
        &transport->control_inbox);
    if (status == CAPNWEB_OK) {
      status = iterate_kit_websocket_text_outbox_reset(
          &transport->control_outbox);
    }
    if (status != CAPNWEB_OK) {
      transport->last_capnweb_status = status;
      remember_application_capnweb_failure(
          transport, socket_generation, status);
      transport->state =
          ITERATE_KIT_ESP_IDF_ITX_FAILED;
      /*
       * Reset can fail only when the documented ring/parser ownership contract
       * was violated. A peer reconnect cannot release a slot held by the wrong
       * local task, so retrying would hide corruption behind a reconnect loop.
       */
      latch_fatal_failure(
          transport,
          ITERATE_KIT_ESP_IDF_ITX_FATAL_CONTROL_RING_RESET);
      return ITERATE_KIT_STATE_ERROR;
    }
    atomic_store_u32(
        &transport->accepted_socket_generation,
        socket_generation);
    /*
     * Publish acceptance before connection_open emits authentication/mount
     * traffic. The network task will now send only messages constructed for
     * this exact generation.
     */
    status = iterate_kit_itx_connection_open(
        transport->options.connection);
    if (status != CAPNWEB_OK) {
      transport->last_capnweb_status = status;
      remember_application_capnweb_failure(
          transport, socket_generation, status);
      transport->state =
          ITERATE_KIT_ESP_IDF_ITX_FAILED;
      /*
       * Opening a clean generation consumes only caller-owned, prevalidated
       * storage. Failure here is a local profile/ownership invariant, not bad
       * bytes from this peer, so repeated socket handshakes cannot repair it.
       */
      latch_fatal_failure(
          transport,
          ITERATE_KIT_ESP_IDF_ITX_FATAL_CONNECTION_OPEN);
      return ITERATE_KIT_STATE_ERROR;
    }
    /*
     * Start the deadline only after open() has emitted this generation's
     * authentication/mount request. Starting at TCP connect would charge TLS
     * or an outbox handoff to the peer; starting on first reply would permit a
     * silent peer to strand MOUNTING forever.
     */
    transport->mount_deadline_generation = socket_generation;
    transport->mount_deadline_us =
        esp_timer_get_time() +
        (int64_t)ITERATE_KIT_ESP_IDF_ITX_MOUNT_TIMEOUT_MS * 1000;
    transport->handled_socket_generation =
        socket_generation;
    transport->last_capnweb_status = CAPNWEB_OK;
  }

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
    /*
     * Release each ring slot before advancing the Cap'n Web state further.
     * The caller's max bound limits CPU per main-loop pass, while FIFO order
     * preserves RPC/session semantics within one accepted generation.
     */
    if (status != CAPNWEB_OK) {
      transport->last_capnweb_status = status;
      remember_application_capnweb_failure(
          transport,
          transport->handled_socket_generation,
          status);
      transport->state =
          ITERATE_KIT_ESP_IDF_ITX_FAILED;
      record_protocol_failure(
          transport,
          /*
           * Unlike callback-side failures, parser/mount failure is observed by
           * the application owner after it accepted a specific generation.
           * Stamp that immutable handled epoch, not a possibly newer callback
           * generation already published concurrently.
           */
          transport->handled_socket_generation);
      return ITERATE_KIT_STATE_ERROR;
    }
  }

  switch (iterate_kit_itx_connection_refresh(
      transport->options.connection)) {
    case ITERATE_KIT_ITX_CONNECTION_MOUNTING:
      if (transport->mount_deadline_generation ==
              transport->handled_socket_generation &&
          transport->handled_socket_generation == socket_generation &&
          transport->mount_deadline_us > 0 &&
          esp_timer_get_time() >= transport->mount_deadline_us) {
        const uint32_t timed_out_generation =
            transport->handled_socket_generation;
        /*
         * Clear before requesting replacement so a second application poll
         * cannot count the same generation twice. The monotonic generation
         * publication also makes a stale deadline harmless if ownership code
         * is later rearranged around this branch.
         */
        transport->mount_deadline_us = 0;
        transport->mount_deadline_generation = 0U;
        if (atomic_publish_newer_generation(
                &transport->mount_timeout_generation,
                timed_out_generation)) {
          atomic_saturating_increment(
              &transport->mount_timeouts);
        }
        remember_platform_error(transport, ESP_ERR_TIMEOUT);
        transport->state = ITERATE_KIT_ESP_IDF_ITX_FAILED;
        record_protocol_failure(
            transport, timed_out_generation);
        return ITERATE_KIT_STATE_ERROR;
      }
      transport->state =
          ITERATE_KIT_ESP_IDF_ITX_MOUNTING;
      return ITERATE_KIT_OK;
    case ITERATE_KIT_ITX_CONNECTION_READY:
      if (!atomic_load_u32(&transport->socket_connected) ||
          atomic_load_u32(&transport->socket_generation) !=
              socket_generation ||
          atomic_load_u32(
              &transport->protocol_failure_generation) >=
              socket_generation) {
        /*
         * READY is the retry-reset proof, so publish it only for a socket still
         * current and not concurrently rejected by the callback task. A stale
         * READY would collapse backoff for the very failure replacing it.
         */
        transport->state =
            ITERATE_KIT_ESP_IDF_ITX_WEBSOCKET_CONNECTING;
        return ITERATE_KIT_OK;
      }
      transport->mount_deadline_us = 0;
      transport->mount_deadline_generation = 0U;
      atomic_store_u32(
          &transport->ready_socket_generation,
          socket_generation);
      transport->state = ITERATE_KIT_ESP_IDF_ITX_READY;
      return ITERATE_KIT_OK;
    case ITERATE_KIT_ITX_CONNECTION_FAILED:
      transport->mount_deadline_us = 0;
      transport->mount_deadline_generation = 0U;
      transport->last_capnweb_status =
          transport->options.connection->capnweb_status;
      remember_application_capnweb_failure(
          transport,
          transport->handled_socket_generation,
          transport->last_capnweb_status);
      transport->state =
          ITERATE_KIT_ESP_IDF_ITX_FAILED;
      record_protocol_failure(
          transport,
          transport->handled_socket_generation);
      return ITERATE_KIT_STATE_ERROR;
    case ITERATE_KIT_ITX_CONNECTION_DISCONNECTED:
    case ITERATE_KIT_ITX_CONNECTION_CLOSED:
      transport->mount_deadline_us = 0;
      transport->mount_deadline_generation = 0U;
      transport->state =
          ITERATE_KIT_ESP_IDF_ITX_WEBSOCKET_CONNECTING;
      return ITERATE_KIT_STATE_ERROR;
  }
  /*
   * Every public connection state is handled above. Reaching this point means
   * local enum/state corruption; treating it as a reconnectable peer failure
   * would spin forever while concealing the impossible transition.
   */
  transport->last_capnweb_status = CAPNWEB_E_STATE;
  remember_application_capnweb_failure(
      transport,
      transport->handled_socket_generation,
      transport->last_capnweb_status);
  transport->state = ITERATE_KIT_ESP_IDF_ITX_FAILED;
  latch_fatal_failure(
      transport,
      ITERATE_KIT_ESP_IDF_ITX_FATAL_CONNECTION_STATE);
  return ITERATE_KIT_STATE_ERROR;
}

void iterate_kit_esp_idf_itx_transport_request_restart(
    struct iterate_kit_esp_idf_itx_transport *transport) {
  if (transport == NULL || !transport->initialized) {
    return;
  }
  request_restart(transport);
}

void iterate_kit_esp_idf_itx_transport_request_probe(
    struct iterate_kit_esp_idf_itx_transport *transport) {
  if (transport == NULL || !transport->initialized) {
    return;
  }
  atomic_store_u32(&transport->probe_requested, 1U);
  wake_network_task(transport);
}

enum iterate_kit_status iterate_kit_esp_idf_itx_transport_stop(
    struct iterate_kit_esp_idf_itx_transport *transport) {
  TickType_t waited = 0U;
  TickType_t delay = pdMS_TO_TICKS(10U);
  TickType_t timeout = pdMS_TO_TICKS(STOP_TIMEOUT_MS);
  if (transport == NULL || !transport->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (!transport->started) {
    transport->state = ITERATE_KIT_ESP_IDF_ITX_STOPPED;
    return ITERATE_KIT_OK;
  }
  if (delay == 0U) {
    delay = 1U;
  }
  atomic_store_u32(&transport->network_task_running, 0U);
  mark_socket_disconnected(transport);
  wake_network_task(transport);
  while (!atomic_load_u32(&transport->network_task_exited) &&
         waited < timeout) {
    /*
     * There is no safe forced task deletion: it could hold an ESP-IDF client
     * lock or an SPSC slot. Bounded cooperative exit either proves ownership
     * was released or returns a visible error with resources still intact.
     */
    vTaskDelay(delay);
    waited += delay;
  }
  if (!atomic_load_u32(&transport->network_task_exited)) {
    return ITERATE_KIT_IO_ERROR;
  }
  /*
   * The network owner has exited, so the transport is no longer writable even
   * though this is a deliberate local shutdown. Mark it lost before closing:
   * a direct graceful close would serialize import/export releases into the
   * outbox after its sole consumer is gone, leaving an invisible permanent
   * backlog. `connection_lost()` performs local-only session disposal; the
   * following close records the final public lifecycle state without egress.
   */
  iterate_kit_itx_connection_lost(
      transport->options.connection);
  (void)iterate_kit_itx_connection_close(
      transport->options.connection);
  /*
   * The network owner already destroyed the taskless lower connection before
   * publishing exited. Delete the remaining shared platform resources only
   * after that publication; another component may legitimately own an
   * already-existing default event loop.
   */
  (void)esp_event_handler_instance_unregister(
      IP_EVENT,
      IP_EVENT_STA_GOT_IP,
      transport->ip_event_handler);
  (void)esp_event_handler_instance_unregister(
      WIFI_EVENT,
      ESP_EVENT_ANY_ID,
      transport->wifi_event_handler);
  (void)esp_wifi_stop();
  (void)esp_wifi_deinit();
  if (transport->station != NULL) {
    esp_netif_destroy_default_wifi(transport->station);
    transport->station = NULL;
  }
  if (transport->owns_default_event_loop) {
    (void)esp_event_loop_delete_default();
  }
  transport->started = false;
  transport->state = ITERATE_KIT_ESP_IDF_ITX_STOPPED;
  return ITERATE_KIT_OK;
}

void iterate_kit_esp_idf_itx_transport_metrics(
    const struct iterate_kit_esp_idf_itx_transport *transport,
    struct iterate_kit_esp_idf_itx_transport_metrics *metrics) {
  if (metrics == NULL) {
    return;
  }
  memset(metrics, 0, sizeof(*metrics));
  if (transport == NULL || !transport->initialized) {
    return;
  }
  /*
   * These acquire loads make snapshots race-free with event/network writers.
   * Fields are intentionally not read under a global lock: diagnostics must
   * never delay audio or reconnect work, and per-counter monotonic evidence is
   * sufficient even when adjacent values come from slightly different moments.
   */
  metrics->wifi_connected =
      atomic_load_u32(&transport->wifi_connected) != 0U;
  metrics->wifi_connect_attempts =
      atomic_load_u32(&transport->wifi_connect_attempts);
  metrics->wifi_disconnects =
      atomic_load_u32(&transport->wifi_disconnects);
  metrics->websocket_connections =
      atomic_load_u32(&transport->websocket_connections);
  metrics->websocket_start_attempts =
      atomic_load_u32(
          &transport->websocket_start_attempts);
  metrics->websocket_disconnects =
      atomic_load_u32(&transport->websocket_disconnects);
  metrics->websocket_errors =
      atomic_load_u32(&transport->websocket_errors);
  metrics->fatal_failure_latched =
      atomic_load_u32(
          &transport->fatal_failure_latched) != 0U;
  metrics->fatal_failure_reason =
      (enum iterate_kit_esp_idf_itx_fatal_failure_reason)
          atomic_load_u32(
              &transport->fatal_failure_reason);
  metrics->ready_socket_generation =
      atomic_load_u32(
          &transport->ready_socket_generation);
  metrics->mount_timeouts =
      atomic_load_u32(&transport->mount_timeouts);
  metrics->mount_timeout_generation =
      atomic_load_u32(
          &transport->mount_timeout_generation);
  metrics->protocol_failures =
      atomic_load_u32(&transport->protocol_failures);
  metrics->protocol_failure_generation =
      atomic_load_u32(
          &transport->protocol_failure_generation);
  {
    struct iterate_kit_itx_outbox_sender_metrics sender_metrics;
    iterate_kit_itx_outbox_sender_metrics(
        &transport->control_sender, &sender_metrics);
    metrics->control_messages_sent = sender_metrics.messages_sent;
    metrics->control_messages_discarded =
        atomic_load_u32(&transport->control_messages_discarded);
    if (sender_metrics.messages_discarded >
        UINT32_MAX - metrics->control_messages_discarded) {
      metrics->control_messages_discarded = UINT32_MAX;
    } else {
      metrics->control_messages_discarded +=
          sender_metrics.messages_discarded;
    }
    metrics->control_outbox_discarded =
        sender_metrics.messages_discarded;
    metrics->control_send_failures = sender_metrics.send_failures;
  }
  metrics->control_inbox_discarded =
      atomic_load_u32(&transport->control_inbox_discarded);
  metrics->control_inbox_deferrals =
      atomic_load_u32(&transport->control_inbox_deferrals);
  metrics->control_receive_failures =
      atomic_load_u32(&transport->control_receive_failures);
  metrics->network_task_stack_exhaustions =
      atomic_load_u32(
          &transport->network_task_stack_exhaustions);
  metrics->network_task_work_cycles =
      atomic_load_u32(&transport->network_task_work_cycles);
  metrics->network_task_max_work_cycles =
      atomic_load_u32(
          &transport->network_task_max_work_cycles);
  if (transport->network_task != NULL &&
      !atomic_load_u32(&transport->network_task_exited)) {
    metrics->network_task_stack_high_water_bytes =
        task_stack_headroom_bytes(transport->network_task);
  }
  metrics->last_platform_error = __atomic_load_n(
      &transport->last_platform_error, __ATOMIC_ACQUIRE);
  metrics->last_control_receive_status = __atomic_load_n(
      &transport->last_control_receive_status,
      __ATOMIC_ACQUIRE);
  metrics->last_application_capnweb_generation =
      atomic_load_u32(
          &transport->last_application_capnweb_generation);
  metrics->last_application_capnweb_status =
      __atomic_load_n(
          &transport->last_application_capnweb_status,
          __ATOMIC_ACQUIRE);
  metrics->last_wifi_disconnect_reason = __atomic_load_n(
      &transport->last_wifi_disconnect_reason,
      __ATOMIC_ACQUIRE);
  metrics->last_websocket_error_generation =
      atomic_load_u32(
          &transport->last_websocket_error_generation);
  metrics->last_websocket_error_type = __atomic_load_n(
      &transport->last_websocket_error_type,
      __ATOMIC_ACQUIRE);
  metrics->last_websocket_tls_error = __atomic_load_n(
      &transport->last_websocket_tls_error,
      __ATOMIC_ACQUIRE);
  metrics->last_websocket_tls_stack_error = __atomic_load_n(
      &transport->last_websocket_tls_stack_error,
      __ATOMIC_ACQUIRE);
  metrics->last_websocket_transport_errno = __atomic_load_n(
      &transport->last_websocket_transport_errno,
      __ATOMIC_ACQUIRE);
  metrics->last_websocket_handshake_status_code =
      __atomic_load_n(
          &transport->last_websocket_handshake_status_code,
          __ATOMIC_ACQUIRE);
  metrics->last_websocket_close_status_code =
      __atomic_load_n(
          &transport->last_websocket_close_status_code,
          __ATOMIC_ACQUIRE);
  {
    struct iterate_kit_esp_idf_websocket_connection_metrics websocket;
    iterate_kit_esp_idf_websocket_connection_metrics(
        &transport->websocket, &websocket);
    metrics->websocket_pongs_received = websocket.pongs_received;
  }
  /*
   * spsc_ring_init() already constrains slot_count below UINT32_MAX / 2. The
   * capacities are immutable after prepare(), so these casts are exact and add
   * no queue traversal or lock to diagnostics.
   */
  metrics->control_inbox_capacity_slots =
      (uint32_t)transport->options.control_inbox->slot_count;
  metrics->control_outbox_capacity_slots =
      (uint32_t)transport->options.control_outbox->slot_count;
  iterate_kit_spsc_ring_metrics(
      transport->options.control_inbox,
      &metrics->control_inbox);
  iterate_kit_spsc_ring_metrics(
      transport->options.control_outbox,
      &metrics->control_outbox);
}

void iterate_kit_esp_idf_itx_transport_lifecycle(
    const struct iterate_kit_esp_idf_itx_transport *transport,
    struct iterate_kit_esp_idf_itx_transport_lifecycle *lifecycle) {
  if (lifecycle == NULL) {
    return;
  }
  memset(lifecycle, 0, sizeof(*lifecycle));
  if (transport == NULL || !transport->initialized) {
    return;
  }
  lifecycle->fatal_failure_latched =
      atomic_load_u32(
          &transport->fatal_failure_latched) != 0U;
  lifecycle->fatal_failure_reason =
      (enum iterate_kit_esp_idf_itx_fatal_failure_reason)
          atomic_load_u32(
              &transport->fatal_failure_reason);
  lifecycle->ready_socket_generation =
      atomic_load_u32(
          &transport->ready_socket_generation);
}

const char *iterate_kit_esp_idf_itx_transport_state_name(
    enum iterate_kit_esp_idf_itx_transport_state state) {
  switch (state) {
    case ITERATE_KIT_ESP_IDF_ITX_IDLE:
      return "idle";
    case ITERATE_KIT_ESP_IDF_ITX_WIFI_CONNECTING:
      return "wifi_connecting";
    case ITERATE_KIT_ESP_IDF_ITX_WEBSOCKET_CONNECTING:
      return "websocket_connecting";
    case ITERATE_KIT_ESP_IDF_ITX_MOUNTING:
      return "mounting";
    case ITERATE_KIT_ESP_IDF_ITX_READY:
      return "ready";
    case ITERATE_KIT_ESP_IDF_ITX_FAILED:
      return "failed";
    case ITERATE_KIT_ESP_IDF_ITX_STOPPED:
      return "stopped";
  }
  return "unknown";
}
