#include "iterate/kit/platforms/esp_idf_pcm_transport.h"

#include "iterate/kit/pcm_websocket.h"
#include "iterate/kit/platforms/esp_idf_websocket_policy.h"
#include "iterate/kit/retry_gate.h"

#include <limits.h>
#include <stdio.h>
#include <string.h>

#include "esp_cpu.h"
#include "esp_log.h"
#include "esp_timer.h"

/*
 * This is the ESP-IDF ownership shell around the portable PCM state machines.
 * It owns exactly one network task and one socket generation at a time. The
 * microphone producer only publishes into the SPSC lane and notifies this
 * owner; the playback consumer only drains the downlink lane. No audio callback
 * performs DNS, TLS, WebSocket framing, logging, allocation, or retry.
 *
 * The socket is deliberately separate from Cap'n Web. Binary messages contain
 * only provider-friendly PCM; device events, transcripts, status, and
 * capabilities use the control connection. Sharing one connection was
 * rejected because capability traffic and JSON parsing could then head-of-line
 * block high-volume audio in either direction.
 *
 * The outer schedule is receive -> bounded uplink -> receive. This gives
 * speaker data and mandatory PONG replies two opportunities around each send
 * quantum without allowing a permanently writable uplink to monopolize the core. A
 * producer notification bypasses the idle tick; a PROGRESS result takes a
 * zero-timeout follow-up pass. Every raw socket operation below is nonblocking
 * once the initial DNS/TCP/TLS/upgrade completes.
 *
 * Reconnect is a freshness boundary, not a retransmission mechanism. The
 * portable conductor first purges application and WebSocket-owned audio; this
 * layer then closes the socket to destroy opaque TLS/lwIP/Wi-Fi bytes. Any
 * speech captured while disconnected is discarded rather than replayed when
 * radio service returns. Expected remote/network faults request bounded retry;
 * impossible local ownership or clock states latch fatal and remain visible.
 */

enum {
  /*
   * Receive and transmit bursts are fairness budgets, not queue capacities.
   * Eight inbound chunks can consume one fragmented 640-byte frame efficiently;
   * four raw uplink writes then cap how long a writable TLS stream can delay
   * the second receive pass. Host tests exercise state-machine behavior; device
   * cycle metrics tell us whether these quanta need target-specific tuning.
   */
  NETWORK_RECEIVE_BURST = 8,
  NETWORK_UPLINK_WORK_STEPS = 4,
  /*
   * Connection setup is the sole intentionally blocking network operation and
   * can span DNS, TCP, TLS, and HTTP upgrade. Ten seconds bounds shutdown and
   * failure detection without adding a separate heap-owning client task.
   */
  WEBSOCKET_CONNECT_TIMEOUT_MS = 10000,
  /*
   * Stop must outlast an in-progress connect so callers can obtain a clean
   * task/socket handoff. Exceeding this bound is returned as an I/O incident;
   * the task is never force-deleted while it may own TLS state.
   */
  STOP_TIMEOUT_MS = 12000,
  /*
   * Direct audio owns Core 1 at priority 19 on the first dual-core target.
   * Pinning socket/TLS work to Core 0 keeps radio and network bursts from
   * consuming the audio owner's deadline reserve. Core zero is also the only
   * valid choice on a single-core target.
   */
  NETWORK_TASK_CORE = 0,
};

static const char *const log_tag = "iterate-kit";

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

static void atomic_saturating_increment(uint32_t *value) {
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

static uint32_t task_stack_headroom_bytes(TaskHandle_t task) {
  /*
   * ESP-IDF defines StackType_t as one byte and reports the high-water mark in
   * StackType_t units (unlike several vanilla FreeRTOS ports where it is a
   * word). Retain the multiplication so the unit stays correct and explicit if
   * a future supported port changes that typedef.
   */
  return (uint32_t)(
      uxTaskGetStackHighWaterMark(task) * sizeof(StackType_t));
}

static uint32_t saturating_bytes(
    uint32_t count, size_t bytes_per_item) {
  const uint64_t bytes =
      (uint64_t)count * (uint64_t)bytes_per_item;
  return bytes > UINT32_MAX ? UINT32_MAX : (uint32_t)bytes;
}

static void remember_platform_error(
    struct iterate_kit_esp_idf_pcm_transport *transport,
    int error) {
  __atomic_store_n(
      &transport->last_platform_error,
      (int32_t)error,
      __ATOMIC_RELEASE);
}

static void wake_network_task(
    struct iterate_kit_esp_idf_pcm_transport *transport) {
  TaskHandle_t task = transport->network_task;
  if (task != NULL) {
    xTaskNotifyGive(task);
  }
}

static void request_restart(
    struct iterate_kit_esp_idf_pcm_transport *transport) {
  /*
   * Requests may originate outside the owner task. Release-publish the flag
   * before notifying so the owner cannot wake and miss the reason. Multiple
   * requests deliberately coalesce: replacing one generation satisfies all of
   * them, while a counter would create a reconnect storm after recovery.
   */
  atomic_store_u32(&transport->restart_requested, 1U);
  wake_network_task(transport);
}

static void mark_socket_disconnected(
    struct iterate_kit_esp_idf_pcm_transport *transport) {
  /*
   * Revoke receive admission before publishing disconnected. This is mostly a
   * belt-and-braces ordering because the network task owns steady-state socket
   * work, but stop/restart requests can come from another task. Generation zero
   * is never a live session, so it is an unambiguous closed gate.
   */
  atomic_store_u32(
      &transport->accepted_socket_generation, 0U);
  if (atomic_exchange_u32(
          &transport->socket_connected, 0U) != 0U) {
    atomic_saturating_increment(
        &transport->websocket_disconnects);
  }
}

static bool mark_socket_connected(
    struct iterate_kit_esp_idf_pcm_transport *transport) {
  uint32_t generation;
  uint32_t discarded_frames;
  enum iterate_kit_status status;
  if (atomic_load_u32(&transport->socket_connected)) {
    return true;
  }
  generation = atomic_load_u32(&transport->socket_generation);
  if (generation == UINT32_MAX) {
    remember_platform_error(transport, ESP_ERR_INVALID_STATE);
    return false;
  }
  /*
   * A prior socket may have ended between transport chunks of one 640-byte
   * message. That unpublished ring reservation belongs to this network
   * producer, not the application consumer that purges completed frames. Reset
   * it before publishing a new generation; doing it after acceptance would let
   * the first fresh offset-zero frame race the stale assembler state.
   */
  status = iterate_kit_pcm_lane_reset_downlink_producer(
      transport->options.lane);
  if (status != ITERATE_KIT_OK) {
    remember_platform_error(transport, ESP_ERR_INVALID_STATE);
    return false;
  }
  /*
   * Begin the portable generation before publishing `socket_connected`. This
   * purges speech captured during reconnect and resets every locally-owned old
   * socket byte as one tested operation. Publishing first would let
   * diagnostics—or a later refactor of this owner—observe a ready socket whose
   * sender state still belongs to its predecessor.
   */
  status =
      iterate_kit_pcm_uplink_conductor_begin_generation(
          &transport->uplink,
          generation + 1U,
          &discarded_frames);
  (void)discarded_frames;
  if (status != ITERATE_KIT_OK) {
    remember_platform_error(transport, ESP_ERR_INVALID_STATE);
    return false;
  }
  atomic_store_u32(
      &transport->socket_generation, generation + 1U);
  atomic_store_u32(&transport->socket_connected, 1U);
  atomic_saturating_increment(&transport->websocket_connections);
  return true;
}

static bool downlink_generation_accepted(
    const struct iterate_kit_esp_idf_pcm_transport *transport) {
  const uint32_t generation =
      atomic_load_u32(&transport->socket_generation);
  return atomic_load_u32(&transport->socket_connected) != 0U &&
      generation != 0U &&
      generation ==
          atomic_load_u32(
              &transport->accepted_socket_generation);
}

/**
 * A malformed remote session is observable and reconnectable. Only local
 * invariants latch fatal; protocol input must never brick a shelf device
 * until power cycle.
 */
static void protocol_failure(
    struct iterate_kit_esp_idf_pcm_transport *transport) {
  atomic_saturating_increment(&transport->protocol_failures);
  mark_socket_disconnected(transport);
  request_restart(transport);
}

static void latch_fatal_failure(
    struct iterate_kit_esp_idf_pcm_transport *transport) {
  atomic_store_u32(&transport->fatal_failure_latched, 1U);
  mark_socket_disconnected(transport);
  request_restart(transport);
}

static bool valid_header_token(const char *value) {
  const unsigned char *cursor =
      (const unsigned char *)value;
  if (value == NULL || *value == '\0') {
    return false;
  }
  for (; *cursor != '\0'; ++cursor) {
    if (*cursor <= 0x20U || *cursor >= 0x7fU) {
      return false;
    }
  }
  return true;
}

static bool valid_device_id(const char *value) {
  const unsigned char *cursor =
      (const unsigned char *)value;
  size_t length = 0U;
  if (value == NULL || *value == '\0' || *value == '-') {
    return false;
  }
  for (; *cursor != '\0'; ++cursor) {
    if (!((*cursor >= 'a' && *cursor <= 'z') ||
          (*cursor >= '0' && *cursor <= '9') ||
          *cursor == '-')) {
      return false;
    }
    ++length;
    if (length >= ITERATE_KIT_ESP_IDF_PCM_DEVICE_ID_CAPACITY) {
      return false;
    }
  }
  return cursor[-1] != '-';
}

static const char *audio_mode_header_value(
    enum iterate_kit_audio_mode mode) {
  switch (mode) {
    case ITERATE_KIT_AUDIO_PUSH_TO_TALK:
      return "push-to-talk";
    case ITERATE_KIT_AUDIO_FULL_DUPLEX_AEC:
      return "full-duplex-aec";
    case ITERATE_KIT_AUDIO_NONE:
    default:
      return NULL;
  }
}

static bool build_auth_headers(
    struct iterate_kit_esp_idf_pcm_transport *transport) {
  const struct iterate_kit_configuration *configuration =
      transport->options.configuration;
  const char *audio_mode = audio_mode_header_value(
      transport->options.audio_mode);
  int written;
  if (!valid_header_token(configuration->project_id) ||
      !valid_header_token(configuration->project_api_key) ||
      !valid_device_id(transport->options.device_id) ||
      audio_mode == NULL) {
    return false;
  }
  written = snprintf(
      transport->auth_headers,
      sizeof(transport->auth_headers),
      "Authorization: Bearer %s\r\n"
      "X-Iterate-Project-ID: %s\r\n"
      "X-Iterate-Kit-Device-ID: %s\r\n"
      "X-Iterate-Kit-Audio-Mode: %s\r\n",
      configuration->project_api_key,
      configuration->project_id,
      transport->options.device_id,
      audio_mode);
  return written > 0 &&
      (size_t)written < sizeof(transport->auth_headers);
}

static enum iterate_kit_pcm_message_type message_type(
    uint8_t opcode) {
  if (opcode == (uint8_t)ITERATE_KIT_WEBSOCKET_BINARY) {
    return ITERATE_KIT_PCM_MESSAGE_BINARY;
  }
  if (opcode == (uint8_t)ITERATE_KIT_WEBSOCKET_TEXT) {
    return ITERATE_KIT_PCM_MESSAGE_TEXT;
  }
  return ITERATE_KIT_PCM_MESSAGE_OTHER;
}

static bool receive_websocket_data(
    struct iterate_kit_esp_idf_pcm_transport *transport,
    const struct iterate_kit_esp_idf_websocket_chunk *chunk,
    uint64_t now_ms) {
  enum iterate_kit_status status =
      iterate_kit_pcm_lane_receive_downlink_at(
          transport->options.lane,
          message_type(chunk->opcode),
          chunk->final,
          chunk->payload_size,
          chunk->payload_offset,
          chunk->bytes,
          chunk->byte_count,
          now_ms);
  if (status == ITERATE_KIT_UNAVAILABLE) {
    return true;
  }
  if (status == ITERATE_KIT_BACKPRESSURE) {
    atomic_saturating_increment(
        &transport->downlink_receive_failures);
    atomic_saturating_increment(
        &transport->downlink_ordered_item_losses);
    /*
     * The socket item has already been consumed and WebSocket provides no
     * replay cursor. Continuing would silently remove content from the middle
     * of speech or remove EOS, leaving the peer and speaker in irreconcilable
     * states. Treat the whole generation as stale: closing also destroys
     * unknown TLS/lwIP bytes, and the application-side generation fence purges
     * every older lane/DMA item before fresh traffic is admitted.
     *
     * This is local bounded-capacity exhaustion, not malformed remote input,
     * so it has its own exact counter instead of inflating protocol_failures.
     */
    remember_platform_error(transport, ESP_ERR_NO_MEM);
    mark_socket_disconnected(transport);
    request_restart(transport);
    return false;
  }
  if (status != ITERATE_KIT_OK) {
    atomic_saturating_increment(
        &transport->downlink_receive_failures);
    remember_platform_error(
        transport, ESP_ERR_INVALID_RESPONSE);
    protocol_failure(transport);
    return false;
  }
  if (transport->options.downlink_ready != NULL) {
    transport->options.downlink_ready(
        transport->options.downlink_ready_context);
  }
  return true;
}

static void service_peer_close_reply(
    struct iterate_kit_esp_idf_pcm_transport *transport) {
  enum iterate_kit_websocket_tx_result result =
      iterate_kit_esp_idf_websocket_connection_service_control(
          &transport->websocket);
  if (result == ITERATE_KIT_WEBSOCKET_TX_IDLE ||
      result == ITERATE_KIT_WEBSOCKET_TX_SENT ||
      result == ITERATE_KIT_WEBSOCKET_TX_PROGRESS ||
      result == ITERATE_KIT_WEBSOCKET_TX_DEFERRED) {
    return;
  }
  if (result == ITERATE_KIT_WEBSOCKET_TX_DISCONNECTED) {
    atomic_saturating_increment(&transport->websocket_errors);
    remember_platform_error(
        transport, transport->websocket.last_error);
    mark_socket_disconnected(transport);
    request_restart(transport);
    return;
  }
  remember_platform_error(transport, ESP_ERR_INVALID_STATE);
  latch_fatal_failure(transport);
}

static void receive_downlink(
    struct iterate_kit_esp_idf_pcm_transport *transport,
    uint64_t now_ms) {
  unsigned int received;
  for (received = 0U;
       received < NETWORK_RECEIVE_BURST;
       ++received) {
    struct iterate_kit_esp_idf_websocket_chunk chunk;
    enum iterate_kit_esp_idf_websocket_receive_result result =
        iterate_kit_esp_idf_websocket_connection_receive(
            &transport->websocket, 0, &chunk);
    if (result ==
        ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_IDLE) {
      return;
    }
    if (result ==
        ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_DATA) {
      if (!receive_websocket_data(
              transport, &chunk, now_ms)) {
        return;
      }
      continue;
    }
    if (result ==
        ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_CONTROL) {
      /*
       * Receiving PING has queued a mandatory PONG. Return to the outer
       * scheduler so the conductor services that RFC obligation before another
       * receive burst. A received PONG is counted by the connection as an
       * honest hop-level diagnostic but changes no PCM state: it cannot prove
       * userspace-proxy or provider delivery.
       */
      return;
    }
    if (result ==
        ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_DROPPED) {
      continue;
    }
    if (result ==
        ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_PEER_CLOSE) {
      /*
       * Once the peer has requested close, the conductor must not resume PCM.
       * Make one best-effort nonblocking close-reply write, then replace the
       * socket even if a partial data frame prevented the reply from owning the
       * wire. Retaining the connection to finish shutdown is less important
       * than guaranteeing no post-close audio admission.
       */
      service_peer_close_reply(transport);
      mark_socket_disconnected(transport);
      request_restart(transport);
      return;
    }
    if (result ==
        ITERATE_KIT_ESP_IDF_WEBSOCKET_RECEIVE_DISCONNECTED) {
      atomic_saturating_increment(&transport->websocket_errors);
      remember_platform_error(
          transport, transport->websocket.last_error);
      mark_socket_disconnected(transport);
      request_restart(transport);
      return;
    }
    atomic_saturating_increment(
        &transport->downlink_receive_failures);
    remember_platform_error(
        transport, ESP_ERR_INVALID_RESPONSE);
    protocol_failure(transport);
    return;
  }
}

static bool discard_uplink(
    struct iterate_kit_esp_idf_pcm_transport *transport) {
  uint32_t discarded;
  const enum iterate_kit_status status =
      iterate_kit_pcm_uplink_conductor_discard_pending(
          &transport->uplink, &discarded);
  (void)discarded;
  if (status != ITERATE_KIT_OK) {
    remember_platform_error(
        transport, ESP_ERR_INVALID_STATE);
    latch_fatal_failure(transport);
    return false;
  }
  return true;
}

static void report_uplink_recovery(
    struct iterate_kit_esp_idf_pcm_transport *transport) {
  struct iterate_kit_pcm_uplink_conductor_metrics uplink;
  struct iterate_kit_pcm_lane_metrics lane;
  const uint32_t incidents =
      atomic_load_u32(
          &transport->uplink.sender.restart_incidents);
  if (incidents ==
      transport->reported_uplink_restart_incidents) {
    return;
  }
  iterate_kit_pcm_uplink_conductor_metrics(
      &transport->uplink, &uplink);
  iterate_kit_pcm_lane_metrics(transport->options.lane, &lane);
  ESP_LOGW(
      log_tag,
      "pcm_uplink_recovery incidents=%u reason=%s discarded=%u "
      "queue_depth=%u queue_high_water=%u reset_requests=%u "
      "oldest_capture_age_ms=%u in_place_recoveries=%u "
      "socket_restarts=%u",
      (unsigned int)uplink.sender.restart_incidents,
      iterate_kit_pcm_uplink_restart_reason_name(
          uplink.sender.last_restart_reason),
      (unsigned int)
          uplink.sender.last_restart_frames_discarded,
      (unsigned int)lane.uplink.current_slots,
      (unsigned int)lane.uplink.high_water_slots,
      (unsigned int)lane.uplink_epoch_reset_requests,
      (unsigned int)
          uplink.sender.last_restart_oldest_capture_age_ms,
      (unsigned int)uplink.in_place_freshness_recoveries,
      (unsigned int)uplink.socket_restarts);
  transport->reported_uplink_restart_incidents =
      uplink.sender.restart_incidents;
}

static enum iterate_kit_pcm_uplink_conductor_poll_result
send_uplink(
    struct iterate_kit_esp_idf_pcm_transport *transport,
    uint64_t now_ms) {
  const enum iterate_kit_pcm_uplink_conductor_poll_result result =
      iterate_kit_pcm_uplink_conductor_poll(
          &transport->uplink, now_ms);
  if (result == ITERATE_KIT_PCM_UPLINK_CONDUCTOR_IDLE ||
      result ==
          ITERATE_KIT_PCM_UPLINK_CONDUCTOR_PROGRESS ||
      result ==
          ITERATE_KIT_PCM_UPLINK_CONDUCTOR_DEFERRED) {
    return result;
  }
  if (result == ITERATE_KIT_PCM_UPLINK_CONDUCTOR_RESTART) {
    /*
     * The conductor has already purged locally-owned stale audio. Closing the
     * socket in the requested restart destroys the remaining opaque
     * TLS/lwIP/Wi-Fi suffix. This is classified recovery, not a generic local
     * error; exact sender/confirmation causes remain in their own metrics.
     */
    mark_socket_disconnected(transport);
    request_restart(transport);
    return result;
  }
  remember_platform_error(transport, ESP_ERR_INVALID_STATE);
  latch_fatal_failure(transport);
  return result;
}

static void stop_websocket(
    struct iterate_kit_esp_idf_pcm_transport *transport,
    bool *websocket_open) {
  if (!*websocket_open &&
      transport->websocket.parent == NULL &&
      transport->websocket.websocket == NULL) {
    uint32_t discarded_frames;
    (void)iterate_kit_pcm_uplink_conductor_abandon_generation(
        &transport->uplink, &discarded_frames);
    return;
  }
  mark_socket_disconnected(transport);
  /*
   * First revoke all local admission and retained-frame ownership, then close
   * the platform socket to destroy opaque transport bytes. The two operations
   * are deliberately adjacent: doing only either half leaves a path for an old
   * utterance to escape after recovery.
   */
  {
    uint32_t discarded_frames;
    if (iterate_kit_pcm_uplink_conductor_abandon_generation(
            &transport->uplink,
            &discarded_frames) != ITERATE_KIT_OK) {
      remember_platform_error(
          transport, ESP_ERR_INVALID_STATE);
      atomic_store_u32(
          &transport->fatal_failure_latched, 1U);
    }
  }
  iterate_kit_esp_idf_websocket_connection_close(
      &transport->websocket);
  *websocket_open = false;
}

static void network_task(void *context) {
  struct iterate_kit_esp_idf_pcm_transport *transport = context;
  struct iterate_kit_retry_gate websocket_retry;
  TickType_t wait_ticks = 1U;
  bool websocket_open = false;
  (void)iterate_kit_retry_gate_init(
      &websocket_retry,
      ITERATE_KIT_ESP_IDF_WEBSOCKET_RETRY_INITIAL_MS,
      ITERATE_KIT_ESP_IDF_WEBSOCKET_RETRY_MAX_MS);

  while (atomic_load_u32(&transport->network_task_running)) {
    /*
     * Microphone publication notifies this task immediately. The one-tick
     * timeout is only the maximum idle wait needed to discover downlink bytes
     * on ESP-IDF's nonblocking transport; expressing it as "2 ms" was false at
     * this target's 100 Hz FreeRTOS tick rate. Keep the real scheduler unit
     * visible until receive readiness is moved to a socket-driven wakeup.
     */
    enum iterate_kit_pcm_uplink_conductor_poll_result
        uplink_result =
            ITERATE_KIT_PCM_UPLINK_CONDUCTOR_IDLE;
    int64_t now_us;
    uint32_t work_started_at;
    uint32_t work_cycles;
    (void)ulTaskNotifyTake(pdTRUE, wait_ticks);
    wait_ticks = 1U;
    work_started_at = esp_cpu_get_cycle_count();
    now_us = esp_timer_get_time();
    if (atomic_load_u32(&transport->socket_connected)) {
      iterate_kit_retry_gate_reset(&websocket_retry);
    }

    if (atomic_exchange_u32(
            &transport->restart_requested, 0U)) {
      stop_websocket(transport, &websocket_open);
      iterate_kit_retry_gate_defer(&websocket_retry, now_us);
    }
    if (!atomic_load_u32(&transport->fatal_failure_latched) &&
        !websocket_open &&
        iterate_kit_retry_gate_ready(
            &websocket_retry, now_us)) {
      enum iterate_kit_status status;
      if (task_stack_headroom_bytes(NULL) <
          ITERATE_KIT_ESP_IDF_PCM_NETWORK_TASK_MINIMUM_HEADROOM_BYTES) {
        atomic_saturating_increment(
            &transport->network_task_stack_exhaustions);
        remember_platform_error(transport, ESP_ERR_NO_MEM);
        latch_fatal_failure(transport);
      } else {
        atomic_saturating_increment(
            &transport->websocket_start_attempts);
        status =
            iterate_kit_esp_idf_websocket_connection_open(
                &transport->websocket,
                WEBSOCKET_CONNECT_TIMEOUT_MS);
        /*
         * DNS/TCP/TLS/upgrade may consume the full ten-second timeout. Never
         * reuse the sample from before that blocking operation for retry or
         * audio freshness policy; doing so can make a freshly accepted
         * microphone timestamp appear to move the clock backwards.
         */
        now_us = esp_timer_get_time();
        if (status == ITERATE_KIT_OK &&
            mark_socket_connected(transport)) {
          websocket_open = true;
          iterate_kit_retry_gate_reset(&websocket_retry);
        } else {
          if (status == ITERATE_KIT_OK) {
            remember_platform_error(
                transport, ESP_ERR_INVALID_STATE);
            latch_fatal_failure(transport);
          } else {
            atomic_saturating_increment(
                &transport->websocket_errors);
            remember_platform_error(
                transport, transport->websocket.last_error);
            iterate_kit_retry_gate_defer(
                &websocket_retry, now_us);
          }
          iterate_kit_esp_idf_websocket_connection_close(
              &transport->websocket);
        }
      }
    }

    /*
     * A stop/restart/connection branch above can also perform platform work.
     * One final owner-clock sample gives receive and uplink a coherent,
     * post-operation timestamp without asking every portable state machine to
     * know which ESP call may block.
     */
    now_us = esp_timer_get_time();
    if (downlink_generation_accepted(transport)) {
      receive_downlink(
          transport, (uint64_t)now_us / 1000U);
    }
    if (atomic_load_u32(&transport->socket_connected)) {
      uplink_result =
          send_uplink(
              transport, (uint64_t)now_us / 1000U);
      if (downlink_generation_accepted(transport)) {
        receive_downlink(
            transport, (uint64_t)now_us / 1000U);
      }
    } else {
      (void)discard_uplink(transport);
    }
    /*
     * The conductor already bounded this pass to four raw writes. PROGRESS may
     * still mean a short-write suffix or another fresh PCM frame is immediately
     * ready, so paying the target's 10 ms tick here would turn cooperative
     * fairness into audio latency. A zero timeout still returns through the
     * complete receive/send/receive loop, preserving control and downlink
     * priority; IDLE/EAGAIN can sleep until the next one-tick poll or producer
     * notification.
     */
    wait_ticks = (TickType_t)
        iterate_kit_esp_idf_pcm_network_wait_ticks(
            uplink_result);
    work_cycles =
        esp_cpu_get_cycle_count() - work_started_at;
    (void)__atomic_fetch_add(
        &transport->network_task_work_cycles,
        work_cycles,
        __ATOMIC_RELAXED);
    atomic_max_u32(
        &transport->network_task_max_work_cycles,
        work_cycles);
  }

  stop_websocket(transport, &websocket_open);
  (void)discard_uplink(transport);
  atomic_store_u32(&transport->network_task_exited, 1U);
  vTaskDelete(NULL);
}

enum iterate_kit_status iterate_kit_esp_idf_pcm_transport_prepare(
    struct iterate_kit_esp_idf_pcm_transport *transport,
    const struct iterate_kit_esp_idf_pcm_transport_options *options) {
  enum iterate_kit_configuration_error configuration_error;
  enum iterate_kit_status status;
  struct iterate_kit_pcm_uplink_conductor_options
      uplink_options;
  struct iterate_kit_esp_idf_websocket_connection_options
      websocket_options;
  if (transport == NULL ||
      options == NULL ||
      options->configuration == NULL ||
      !valid_device_id(options->device_id) ||
      audio_mode_header_value(options->audio_mode) == NULL ||
      options->lane == NULL ||
      options->downlink_generation_barrier == NULL ||
      !options->lane->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(transport, 0, sizeof(*transport));
  transport->options = *options;
  configuration_error =
      iterate_kit_configuration_build_pcm_websocket_url(
          options->configuration->pcm_base_url,
          transport->websocket_url,
          sizeof(transport->websocket_url));
  if (configuration_error != ITERATE_KIT_CONFIGURATION_OK ||
      !build_auth_headers(transport)) {
    memset(transport, 0, sizeof(*transport));
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  websocket_options =
      (struct
       iterate_kit_esp_idf_websocket_connection_options){
        .url = transport->websocket_url,
        .subprotocol = ITERATE_KIT_PCM_WEBSOCKET_SUBPROTOCOL,
        .headers = transport->auth_headers,
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
  /*
   * The ESP layer supplies only fixed buffers, freshness tuning, and the raw
   * WebSocket byte stream. All ordering between sender, mandatory control
   * replies, and epoch purge lives in the portable conductor exercised by the
   * deterministic host fault harness.
   */
  uplink_options =
      (struct iterate_kit_pcm_uplink_conductor_options){
        .lane = options->lane,
        .tx = &transport->websocket.tx,
        .restart_after_no_progress_ms =
            ITERATE_KIT_ESP_IDF_PCM_SEND_NO_PROGRESS_TIMEOUT_MS,
        .maximum_frame_send_duration_ms =
            ITERATE_KIT_ESP_IDF_PCM_FRAME_MAX_SEND_DURATION_MS,
        .maximum_capture_age_ms =
            ITERATE_KIT_ESP_IDF_PCM_CAPTURE_MAX_AGE_MS,
        .maximum_work_steps = NETWORK_UPLINK_WORK_STEPS,
      };
  status = iterate_kit_pcm_uplink_conductor_init(
      &transport->uplink, &uplink_options);
  if (status != ITERATE_KIT_OK) {
    memset(transport, 0, sizeof(*transport));
    return status;
  }
  transport->state = ITERATE_KIT_ESP_IDF_PCM_IDLE;
  transport->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_esp_idf_pcm_transport_start(
    struct iterate_kit_esp_idf_pcm_transport *transport) {
  if (transport == NULL ||
      !transport->initialized ||
      transport->started) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  atomic_store_u32(&transport->network_task_exited, 0U);
  atomic_store_u32(&transport->network_task_running, 1U);
  transport->network_task = xTaskCreateStaticPinnedToCore(
      network_task,
      "iterate-pcm-net",
      ITERATE_KIT_ESP_IDF_PCM_NETWORK_TASK_STACK_BYTES,
      transport,
      ITERATE_KIT_ESP_IDF_PCM_NETWORK_TASK_PRIORITY,
      transport->network_task_stack,
      &transport->network_task_storage,
      NETWORK_TASK_CORE);
  if (transport->network_task == NULL) {
    atomic_store_u32(&transport->network_task_running, 0U);
    remember_platform_error(transport, ESP_ERR_NO_MEM);
    return ITERATE_KIT_IO_ERROR;
  }
  transport->started = true;
  transport->state = ITERATE_KIT_ESP_IDF_PCM_CONNECTING;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_esp_idf_pcm_transport_poll(
    struct iterate_kit_esp_idf_pcm_transport *transport) {
  bool connected;
  uint32_t generation;
  uint32_t discarded = 0U;
  if (transport == NULL ||
      !transport->initialized ||
      !transport->started) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  report_uplink_recovery(transport);
  if (atomic_load_u32(&transport->fatal_failure_latched)) {
    transport->state = ITERATE_KIT_ESP_IDF_PCM_FAILED;
    return ITERATE_KIT_STATE_ERROR;
  }

  generation = atomic_load_u32(&transport->socket_generation);
  connected =
      atomic_load_u32(&transport->socket_connected) != 0U;
  if (connected != transport->handled_socket_connected ||
      generation != transport->handled_socket_generation) {
    const enum iterate_kit_status barrier_status =
        transport->options.downlink_generation_barrier(
            transport->options
                .downlink_generation_barrier_context,
            generation,
            connected);
    if (barrier_status == ITERATE_KIT_UNAVAILABLE) {
      /*
       * The audio task has not yet acknowledged that cyclic DMA can no longer
       * select the prior generation. Keep receive admission closed and return
       * to the bounded application loop; waiting here would invert priorities
       * and let a socket transition block audio service.
       */
      transport->state =
          ITERATE_KIT_ESP_IDF_PCM_CONNECTING;
      return ITERATE_KIT_OK;
    }
    if (barrier_status != ITERATE_KIT_OK) {
      remember_platform_error(
          transport, ESP_ERR_INVALID_STATE);
      atomic_store_u32(
          &transport->fatal_failure_latched, 1U);
      transport->state = ITERATE_KIT_ESP_IDF_PCM_FAILED;
      return barrier_status;
    }
    const enum iterate_kit_status discard_status =
        iterate_kit_pcm_lane_discard_downlink(
            transport->options.lane, &discarded);
    if (discard_status != ITERATE_KIT_OK) {
      transport->state = ITERATE_KIT_ESP_IDF_PCM_FAILED;
      return discard_status;
    }
    transport->handled_socket_generation = generation;
    transport->handled_socket_connected = connected;
    /*
     * Discard is the application consumer's generation barrier. Re-check the
     * atomically published socket state before opening the gate: a disconnect
     * or a second successful upgrade during the purge leaves the gate closed
     * for the newer generation, which a later poll will handle explicitly.
     */
    if (connected &&
        atomic_load_u32(&transport->socket_connected) &&
        generation != 0U &&
        generation ==
            atomic_load_u32(&transport->socket_generation)) {
      atomic_store_u32(
          &transport->accepted_socket_generation,
          generation);
      /*
       * The owner may be sleeping at its one-tick idle boundary because it was
       * correctly forbidden to receive. Wake it so the first audible frame is
       * not charged an avoidable scheduler tick after acceptance.
       */
      wake_network_task(transport);
    }
  }
  transport->state =
      downlink_generation_accepted(transport)
      ? ITERATE_KIT_ESP_IDF_PCM_READY
      : ITERATE_KIT_ESP_IDF_PCM_CONNECTING;
  return ITERATE_KIT_OK;
}

void iterate_kit_esp_idf_pcm_transport_notify_uplink(
    struct iterate_kit_esp_idf_pcm_transport *transport) {
  if (transport == NULL || !transport->initialized) {
    return;
  }
  wake_network_task(transport);
}

void iterate_kit_esp_idf_pcm_transport_request_restart(
    struct iterate_kit_esp_idf_pcm_transport *transport) {
  if (transport == NULL || !transport->initialized) {
    return;
  }
  request_restart(transport);
}

enum iterate_kit_status iterate_kit_esp_idf_pcm_transport_stop(
    struct iterate_kit_esp_idf_pcm_transport *transport) {
  TickType_t waited = 0U;
  TickType_t delay = pdMS_TO_TICKS(10U);
  TickType_t timeout = pdMS_TO_TICKS(STOP_TIMEOUT_MS);
  enum iterate_kit_status status;
  status = iterate_kit_esp_idf_pcm_transport_request_stop(
      transport);
  if (status != ITERATE_KIT_OK) {
    return status;
  }
  if (transport->state == ITERATE_KIT_ESP_IDF_PCM_STOPPED) {
    return ITERATE_KIT_OK;
  }
  if (delay == 0U) {
    delay = 1U;
  }
  while ((status =
              iterate_kit_esp_idf_pcm_transport_finish_stop(
                  transport)) == ITERATE_KIT_UNAVAILABLE &&
         waited < timeout) {
    vTaskDelay(delay);
    waited += delay;
  }
  return status == ITERATE_KIT_UNAVAILABLE
      ? ITERATE_KIT_IO_ERROR
      : status;
}

enum iterate_kit_status iterate_kit_esp_idf_pcm_transport_request_stop(
    struct iterate_kit_esp_idf_pcm_transport *transport) {
  if (transport == NULL || !transport->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (!transport->started) {
    transport->state = ITERATE_KIT_ESP_IDF_PCM_STOPPED;
    return ITERATE_KIT_OK;
  }
  if (transport->state == ITERATE_KIT_ESP_IDF_PCM_STOPPING) {
    return ITERATE_KIT_OK;
  }
  atomic_store_u32(&transport->network_task_running, 0U);
  mark_socket_disconnected(transport);
  wake_network_task(transport);
  transport->state = ITERATE_KIT_ESP_IDF_PCM_STOPPING;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_esp_idf_pcm_transport_finish_stop(
    struct iterate_kit_esp_idf_pcm_transport *transport) {
  if (transport == NULL || !transport->initialized) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (!transport->started) {
    transport->state = ITERATE_KIT_ESP_IDF_PCM_STOPPED;
    return ITERATE_KIT_OK;
  }
  if (transport->state != ITERATE_KIT_ESP_IDF_PCM_STOPPING) {
    return ITERATE_KIT_STATE_ERROR;
  }
  if (!atomic_load_u32(&transport->network_task_exited)) {
    return ITERATE_KIT_UNAVAILABLE;
  }
  transport->network_task = NULL;
  transport->started = false;
  transport->state = ITERATE_KIT_ESP_IDF_PCM_STOPPED;
  return ITERATE_KIT_OK;
}

void iterate_kit_esp_idf_pcm_transport_metrics(
    const struct iterate_kit_esp_idf_pcm_transport *transport,
    struct iterate_kit_esp_idf_pcm_transport_metrics *metrics) {
  struct iterate_kit_pcm_uplink_conductor_metrics uplink;
  struct iterate_kit_esp_idf_websocket_connection_metrics
      websocket;
  if (metrics == NULL) {
    return;
  }
  memset(metrics, 0, sizeof(*metrics));
  if (transport == NULL || !transport->initialized) {
    return;
  }
  metrics->websocket_start_attempts =
      atomic_load_u32(&transport->websocket_start_attempts);
  metrics->websocket_connections =
      atomic_load_u32(&transport->websocket_connections);
  metrics->websocket_disconnects =
      atomic_load_u32(&transport->websocket_disconnects);
  metrics->websocket_errors =
      atomic_load_u32(&transport->websocket_errors);
  iterate_kit_esp_idf_websocket_connection_metrics(
      &transport->websocket, &websocket);
  metrics->websocket_raw_write_calls =
      websocket.raw_write_calls;
  metrics->websocket_raw_write_partial =
      websocket.raw_write_partial;
  metrics->websocket_raw_write_deferrals =
      websocket.raw_write_deferrals;
  metrics->websocket_receive_calls = websocket.receive_calls;
  metrics->websocket_receive_chunks =
      websocket.receive_chunks;
  metrics->websocket_pings_received =
      websocket.pings_received;
  metrics->websocket_pongs_received =
      websocket.pongs_received;
  metrics->websocket_control_backpressure =
      websocket.control_backpressure;
  metrics->protocol_failures =
      atomic_load_u32(&transport->protocol_failures);
  iterate_kit_pcm_uplink_conductor_metrics(
      &transport->uplink, &uplink);
  metrics->uplink_frames_sent = uplink.sender.frames_sent;
  metrics->uplink_frames_discarded =
      uplink.sender.frames_discarded;
  metrics->uplink_send_deferrals =
      uplink.sender.send_deferrals;
  metrics->uplink_send_failures =
      uplink.sender.send_failures;
  metrics->uplink_consecutive_send_deferrals =
      uplink.sender.consecutive_send_deferrals;
  metrics->uplink_maximum_consecutive_send_deferrals =
      uplink.sender.maximum_consecutive_send_deferrals;
  metrics->uplink_restart_incidents =
      uplink.sender.restart_incidents;
  metrics->uplink_in_place_freshness_recoveries =
      uplink.in_place_freshness_recoveries;
  metrics->uplink_socket_restarts = uplink.socket_restarts;
  metrics->uplink_producer_backpressure_restarts =
      uplink.sender.producer_backpressure_restarts;
  metrics->uplink_transport_disconnect_restarts =
      uplink.sender.transport_disconnect_restarts;
  metrics->uplink_no_progress_timeout_restarts =
      uplink.sender.no_progress_timeout_restarts;
  metrics->uplink_frame_send_timeout_restarts =
      uplink.sender.frame_send_timeout_restarts;
  metrics->uplink_capture_stale_restarts =
      uplink.sender.capture_stale_restarts;
  metrics->uplink_last_transport_accept_age_ms =
      uplink.sender.last_transport_accept_age_ms;
  metrics->uplink_maximum_transport_accept_age_ms =
      uplink.sender.maximum_transport_accept_age_ms;
  metrics->uplink_last_restart_oldest_capture_age_ms =
      uplink.sender.last_restart_oldest_capture_age_ms;
  metrics->uplink_last_restart_frames_discarded =
      uplink.sender.last_restart_frames_discarded;
  metrics->uplink_last_restart_reason =
      uplink.sender.last_restart_reason;
  metrics->uplink_policy_time_normalizations =
      uplink.policy_time_normalizations;
  metrics->uplink_maximum_policy_time_adjustment_ms =
      uplink.maximum_policy_time_adjustment_ms;
  metrics->uplink_owner_clock_regressions =
      uplink.owner_clock_regressions;
  metrics->downlink_receive_failures =
      atomic_load_u32(&transport->downlink_receive_failures);
  metrics->downlink_ordered_item_losses =
      atomic_load_u32(
          &transport->downlink_ordered_item_losses);
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
  iterate_kit_pcm_lane_metrics(
      transport->options.lane, &metrics->lane);

  /*
   * Exact owned queues and opaque platform queues must share one explicit
   * vocabulary. The application ring counts logical PCM payload bytes; its
   * timestamp metadata remains part of the separate static-RAM budget. The
   * WebSocket metric includes headers/masks because those are real queued wire
   * bytes.
   *
   * These layers are diagnostic views, not additive buckets. During a partial
   * write, the sender deliberately retains the ring slot while the transmitter
   * owns a masked copy, so summing them double-counts at most one PCM frame.
   * ESP-IDF does not expose exact live occupancy for TLS/lwIP/Wi-Fi, so those
   * layers remain explicitly capacity-only or unavailable below. We rejected
   * deriving a lower-layer PCM depth from PONG: it proves ordered parsing only
   * at this WebSocket hop and says nothing about proxy/provider queues.
   */
  metrics->buffers.uplink_application =
      (struct iterate_kit_buffer_metrics){
        .evidence = ITERATE_KIT_BUFFER_OBSERVED,
        .current_bytes = saturating_bytes(
            metrics->lane.uplink.current_slots,
            ITERATE_KIT_PCM_V1_FRAME_BYTES),
        .high_water_bytes = saturating_bytes(
            metrics->lane.uplink.high_water_slots,
            ITERATE_KIT_PCM_V1_FRAME_BYTES),
        .capacity_bytes = saturating_bytes(
            (uint32_t)transport->options.lane->
                uplink->slot_count,
            ITERATE_KIT_PCM_V1_FRAME_BYTES),
      };
  metrics->buffers.websocket_transmitter =
      (struct iterate_kit_buffer_metrics){
        .evidence = ITERATE_KIT_BUFFER_OBSERVED,
        .current_bytes = websocket.tx.pending_wire_bytes,
        .high_water_bytes =
            websocket.tx.maximum_pending_wire_bytes,
        .capacity_bytes = websocket.tx.capacity_wire_bytes,
      };
  /*
   * `SO_SNDBUF` is not implemented by this ESP-IDF/lwIP configuration, and
   * esp_transport does not expose its tcp_pcb. We can truthfully report the
   * configured initial send capacity, not live snd_buf/snd_queuelen. mbedTLS
   * and the Wi-Fi driver expose neither a stable live depth nor a comparable
   * public capacity, so their entries stay explicitly unavailable.
   */
  metrics->buffers.lwip_send =
      (struct iterate_kit_buffer_metrics){
        .evidence = ITERATE_KIT_BUFFER_CAPACITY_ONLY,
        .capacity_bytes = CONFIG_LWIP_TCP_SND_BUF_DEFAULT,
      };
  metrics->buffers.tls_egress =
      (struct iterate_kit_buffer_metrics){
        .evidence = ITERATE_KIT_BUFFER_UNAVAILABLE,
      };
  metrics->buffers.wifi_egress =
      (struct iterate_kit_buffer_metrics){
        .evidence = ITERATE_KIT_BUFFER_UNAVAILABLE,
      };
}

const char *iterate_kit_esp_idf_pcm_transport_state_name(
    enum iterate_kit_esp_idf_pcm_transport_state state) {
  switch (state) {
    case ITERATE_KIT_ESP_IDF_PCM_IDLE:
      return "idle";
    case ITERATE_KIT_ESP_IDF_PCM_CONNECTING:
      return "connecting";
    case ITERATE_KIT_ESP_IDF_PCM_READY:
      return "ready";
    case ITERATE_KIT_ESP_IDF_PCM_FAILED:
      return "failed";
    case ITERATE_KIT_ESP_IDF_PCM_STOPPING:
      return "stopping";
    case ITERATE_KIT_ESP_IDF_PCM_STOPPED:
      return "stopped";
  }
  return "unknown";
}
