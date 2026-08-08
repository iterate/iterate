#ifndef ITERATE_KIT_PLATFORMS_ESP_IDF_ITX_TRANSPORT_H
#define ITERATE_KIT_PLATFORMS_ESP_IDF_ITX_TRANSPORT_H

/*
 * ESP-IDF's public WebSocket/lwIP headers intentionally use GCC extensions
 * such as include_next. Treat this platform boundary as a system header so
 * strict consumers can retain -Wpedantic for their own code.
 */
#if defined(__GNUC__)
#pragma GCC system_header
#endif

#include "iterate/kit/configuration.h"
#include "iterate/kit/itx_connection.h"
#include "iterate/kit/itx_outbox_sender.h"
#include "iterate/kit/platforms/esp_idf_websocket_connection.h"
#include "iterate/kit/spsc_ring.h"
#include "iterate/kit/status.h"
#include "iterate/kit/voice_device_profile.h"
#include "iterate/kit/websocket_frame_writer.h"
#include "iterate/kit/websocket_text.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_event.h"
#include "esp_netif.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Single-lane A1 transport for Cap'n Web calls and ephemeral media events.
 *
 * Audio is mu-law encoded, base64 wrapped, and sent through the same bounded
 * Cap'n Web /api session as every other stream event. The retired /pcm socket
 * is deliberately absent. Generation replacement therefore discards all old
 * session traffic together instead of attempting cross-generation replay.
 */
enum {
  /*
   * ESP-IDF defines StackType_t as uint8_t on its supported embedded ports,
   * so its FreeRTOS stack-depth APIs and this buffer are byte-sized. The task
   * stack is statically reserved to make the connection's RAM cost visible.
   * Its size is shared with the lower WebSocket/TLS boundary because the
   * synchronous handshake, not control-message processing, sets the peak.
   * 512 bytes of retained headroom is the fail-closed floor below which another
   * TLS/WebSocket start is unsafe. Control messages are capped at 2 KiB so one
   * fragmented RPC cannot create an unbounded reassembly allocation.
   */
  ITERATE_KIT_ESP_IDF_NETWORK_TASK_STACK_BYTES =
      ITERATE_KIT_ESP_IDF_WEBSOCKET_TLS_OWNER_STACK_BYTES,
  ITERATE_KIT_ESP_IDF_NETWORK_TASK_MINIMUM_HEADROOM_BYTES = 512,
  /*
   * One four-frame microphone append and the largest bounded delivery batch
   * must each fit a single message. The value is the global outbox slot bound,
   * not a second platform tuning knob; a compile-time check below pins it to
   * the shared measurement profile. A message larger than this cap is rejected
   * before it can silently overrun the embedded transmit scratch.
   */
  ITERATE_KIT_ESP_IDF_CONTROL_MESSAGE_CAPACITY =
      ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOT_CAPACITY,
  /*
   * A live WebSocket is not a mounted capability. Authentication or mount can
   * disappear into a healthy-looking peer without ever closing TCP, so each
   * accepted generation gets a deadline. Ten seconds is deliberately longer
   * than ordinary production mounting while still making an unattended outage
   * bounded; the replacement generation follows the normal reconnect policy.
   */
  ITERATE_KIT_ESP_IDF_ITX_MOUNT_TIMEOUT_MS = 10000,
};

/**
 * Application-visible lifecycle, not a mirror of ESP-IDF callback events.
 *
 * READY means the current socket generation has authenticated and mounted the
 * device capability. FAILED means the current generation was rejected, or a
 * local invariant made all later generations unsafe. Peer input failures are
 * generation-local: a bounded reconnect may move FAILED back through mounting
 * to READY. Only fatal_failure_latched requires explicit intervention.
 */
enum iterate_kit_esp_idf_itx_transport_state {
  ITERATE_KIT_ESP_IDF_ITX_IDLE = 0,
  ITERATE_KIT_ESP_IDF_ITX_WIFI_CONNECTING,
  ITERATE_KIT_ESP_IDF_ITX_WEBSOCKET_CONNECTING,
  ITERATE_KIT_ESP_IDF_ITX_MOUNTING,
  ITERATE_KIT_ESP_IDF_ITX_READY,
  ITERATE_KIT_ESP_IDF_ITX_FAILED,
  ITERATE_KIT_ESP_IDF_ITX_STOPPED,
};

/**
 * First local invariant that permanently disabled control reconnects.
 *
 * Ordinary peer, Wi-Fi, TLS, parser-limit, and mount failures replace only the
 * current socket generation and never appear here. A nonzero value means this
 * boot cannot recover the capability transport in place; a target supervisor
 * may therefore restart the process after preserving this exact reason.
 */
enum iterate_kit_esp_idf_itx_fatal_failure_reason {
  ITERATE_KIT_ESP_IDF_ITX_FATAL_NONE = 0,
  ITERATE_KIT_ESP_IDF_ITX_FATAL_PROTOCOL_WITHOUT_GENERATION,
  ITERATE_KIT_ESP_IDF_ITX_FATAL_SOCKET_GENERATION_EXHAUSTED,
  ITERATE_KIT_ESP_IDF_ITX_FATAL_NETWORK_STACK_HEADROOM,
  ITERATE_KIT_ESP_IDF_ITX_FATAL_WEBSOCKET_OPEN_INVARIANT,
  ITERATE_KIT_ESP_IDF_ITX_FATAL_CONTROL_RING_RESET,
  ITERATE_KIT_ESP_IDF_ITX_FATAL_CONNECTION_OPEN,
  ITERATE_KIT_ESP_IDF_ITX_FATAL_CONNECTION_STATE,
};

/**
 * Caller-owned dependencies and the two explicit task handoff queues.
 *
 * The explicit network task is the sole inbox producer and outbox consumer;
 * the application task owns the opposite sides. No hidden WebSocket callback
 * task exists. The network owner performs bounded nonblocking receive/write
 * steps and may only validate/copy messages—it never invokes device code or
 * Cap'n Web.
 *
 * All pointers must outlive stop(). The rings must already be initialized, and
 * each is permanently dedicated to this transport's stated SPSC ownership.
 */
struct iterate_kit_esp_idf_itx_transport_options {
  const struct iterate_kit_configuration *configuration;
  struct iterate_kit_itx_connection *connection;
  struct iterate_kit_spsc_ring *control_inbox;
  struct iterate_kit_spsc_ring *control_outbox;
};

/**
 * Saturating diagnostics sampled without stopping any owner task.
 *
 * Ring depths/high-water marks are exact observations from the portable SPSC
 * queues. Stack high-water is ESP-IDF's minimum-ever free stack estimate.
 * Incident counters saturate; network_task_work_cycles is explicitly a modulo
 * 2^32 hardware-cycle accumulator intended for bounded-interval deltas, while
 * network_task_max_work_cycles retains the worst single pass. No field claims
 * visibility into opaque TLS, lwIP, or Wi-Fi buffering.
 */
struct iterate_kit_esp_idf_itx_transport_metrics {
  /*
   * Association is a current lifecycle fact, not derivable from cumulative
   * connect/disconnect counters or WebSocket state. Expose the transport's
   * existing atomic flag so a diagnostics sample does not race or guess.
   */
  bool wifi_connected;
  uint32_t wifi_connect_attempts;
  uint32_t wifi_disconnects;
  uint32_t websocket_connections;
  uint32_t websocket_start_attempts;
  uint32_t websocket_disconnects;
  uint32_t websocket_errors;
  /** True only when this boot has no in-place control recovery path. */
  bool fatal_failure_latched;
  enum iterate_kit_esp_idf_itx_fatal_failure_reason fatal_failure_reason;
  /** Newest socket generation that completed authentication and mounting. */
  uint32_t ready_socket_generation;
  /** Generations replaced because authentication/mount never completed. */
  uint32_t mount_timeouts;
  /** Newest socket generation counted by mount_timeouts. */
  uint32_t mount_timeout_generation;
  uint32_t protocol_failures;
  uint32_t protocol_failure_generation;
  uint32_t control_messages_sent;
  uint32_t control_messages_discarded;
  uint32_t control_inbox_discarded;
  /** Reads deliberately skipped because the inbox was full (backpressure). */
  uint32_t control_inbox_deferrals;
  uint32_t control_outbox_discarded;
  uint32_t control_receive_failures;
  uint32_t control_send_failures;
  uint32_t network_task_stack_high_water_bytes;
  uint32_t network_task_stack_exhaustions;
  uint32_t network_task_work_cycles;
  uint32_t network_task_max_work_cycles;
  int32_t last_platform_error;
  int32_t last_control_receive_status;
  /*
   * Retained application-owner Cap'n Web failure. `last_capnweb_status` on the
   * transport describes the current generation and correctly returns to OK
   * after a remount; this pair instead survives that remount so a replacement
   * capability can explain why its predecessor was abandoned.
   */
  uint32_t last_application_capnweb_generation;
  int32_t last_application_capnweb_status;
  int32_t last_wifi_disconnect_reason;
  /*
   * Historical managed-client detail retained in the public diagnostics shape
   * while device/proxy schemas migrate. The taskless lower transport cannot
   * obtain the managed client's event-only TLS/HTTP tuple, so those fields
   * remain zero. `last_websocket_transport_errno` and `last_platform_error`
   * retain the lower adapter's actual causal code instead of manufacturing a
   * value for an unavailable domain.
   */
  uint32_t last_websocket_error_generation;
  int32_t last_websocket_error_type;
  int32_t last_websocket_tls_error;
  int32_t last_websocket_tls_stack_error;
  int32_t last_websocket_transport_errno;
  int32_t last_websocket_handshake_status_code;
  int32_t last_websocket_close_status_code;
  uint32_t control_inbox_capacity_slots;
  uint32_t control_outbox_capacity_slots;
  struct iterate_kit_spsc_ring_metrics control_inbox;
  struct iterate_kit_spsc_ring_metrics control_outbox;
};

/**
 * Three-word lifecycle sample for a high-frequency target supervisor.
 *
 * The full metrics snapshot also scans FreeRTOS stack high-water state and all
 * ring counters. Polling that at a 10 ms application cadence would spend CPU
 * on diagnostics while audio is live. This narrow snapshot performs only the
 * atomics needed to realign media after a remount or escalate a permanent
 * latch.
 */
struct iterate_kit_esp_idf_itx_transport_lifecycle {
  bool fatal_failure_latched;
  enum iterate_kit_esp_idf_itx_fatal_failure_reason fatal_failure_reason;
  uint32_t ready_socket_generation;
};

/**
 * ESP-IDF transport state. The network task alone owns the taskless WebSocket,
 * copies complete bounded messages into the SPSC inbox, and consumes the SPSC
 * outbox. The application task alone owns the Cap'n Web session.
 *
 * socket_generation is the connection epoch. The application publishes
 * accepted_socket_generation only after discarding old fragments and opening
 * the new Cap'n Web session; the network task refuses to send an outbox from
 * any other epoch. It publishes ready_socket_generation only after the mount
 * succeeds, so a TCP/WebSocket handshake alone cannot reset reconnect backoff.
 * This handshake prevents authentication/mount messages from a dead socket
 * being replayed into a new session or a bad peer causing a tight retry loop.
 *
 * protocol_failure_generation monotonically identifies the newest generation
 * rejected for malformed input, bounded inbox pressure, or remote protocol
 * failure. It is deliberately never cleared. Recovery is the simple relation
 * socket_generation > protocol_failure_generation; retaining the old value
 * also prevents a delayed old callback from erasing a newer incident.
 *
 * Flags and diagnostics below cross task boundaries through explicit atomics
 * in the implementation. `state`, `last_capnweb_status`, and
 * handled_socket_generation remain application-task-only. The statically
 * embedded network task storage avoids a runtime allocation and makes stop()
 * able to wait on an explicit exited flag rather than deleting another task.
 */
struct iterate_kit_esp_idf_itx_transport {
  /* Immutable after prepare(); borrowed dependencies must outlive stop(). */
  struct iterate_kit_esp_idf_itx_transport_options options;
  /* Fragment assemblers are each accessed only by their ring's SPSC owners. */
  struct iterate_kit_websocket_text_inbox control_inbox;
  struct iterate_kit_websocket_text_outbox control_outbox;
  /*
   * The taskless connection embeds exactly one receive chunk and one masked
   * transmit frame. Keeping these buffers visible in sizeof(transport) makes
   * the control plane's permanent RAM cost auditable and prevents reconnect
   * pressure from growing a heap queue.
   */
  char websocket_url[ITERATE_KIT_ITX_WEBSOCKET_URL_CAPACITY];
  uint8_t websocket_receive_storage[
      ITERATE_KIT_ESP_IDF_CONTROL_MESSAGE_CAPACITY];
  uint8_t websocket_transmit_storage[
      ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(
          ITERATE_KIT_ESP_IDF_CONTROL_MESSAGE_CAPACITY)];
  struct iterate_kit_esp_idf_websocket_connection websocket;
  /*
   * A resumable write borrows the outbox head until the complete RFC 6455 frame
   * has reached the lower transport. Retaining the acquisition prevents the
   * producer from reusing that slot while a short write still references it.
   */
  struct iterate_kit_itx_outbox_sender control_sender;
  /* Platform resources are created by start() and destroyed only after exit. */
  esp_netif_t *station;
  esp_event_handler_instance_t wifi_event_handler;
  esp_event_handler_instance_t ip_event_handler;
  StaticTask_t network_task_storage;
  StackType_t
      network_task_stack[ITERATE_KIT_ESP_IDF_NETWORK_TASK_STACK_BYTES];
  TaskHandle_t network_task;
  enum iterate_kit_esp_idf_itx_transport_state state;
  /*
   * Most recent application-side protocol outcome. A recoverable generation
   * failure is replaced and this returns to CAPNWEB_OK after the new session
   * opens, so "terminal" would falsely imply a device-lifetime latch.
   */
  enum capnweb_status last_capnweb_status;
  /*
   * Unlike `last_capnweb_status`, these application-task-owned fields are not
   * cleared when a new generation opens. The metrics sampler runs on that same
   * owner, while the public metrics accessor uses atomic scalar loads so
   * off-task diagnostic snapshots remain race-free after the incident settles.
   */
  uint32_t last_application_capnweb_generation;
  int32_t last_application_capnweb_status;
  /*
   * Application-owner deadline for the generation currently authenticating.
   * The generation tag is as important as the timestamp: a delayed poll from
   * an abandoned mount must never condemn its healthy replacement.
   */
  int64_t mount_deadline_us;
  uint32_t mount_deadline_generation;
  /*
   * Cross-task state. Acquire/release ordering publishes lifecycle flags; the
   * diagnostic counters need atomicity but do not publish other memory.
   */
  uint32_t socket_connected;
  uint32_t socket_generation;
  uint32_t accepted_socket_generation;
  /* Latest generation whose authentication and live provision reached READY. */
  uint32_t ready_socket_generation;
  uint32_t wifi_connected;
  uint32_t wifi_retry_now;
  uint32_t wifi_retry_later;
  uint32_t restart_requested;
  uint32_t protocol_failure_generation;
  uint32_t fatal_failure_latched;
  uint32_t fatal_failure_reason;
  uint32_t network_task_running;
  uint32_t network_task_exited;
  uint32_t websocket_started;
  uint32_t wifi_connect_attempts;
  uint32_t wifi_disconnects;
  uint32_t websocket_connections;
  uint32_t websocket_start_attempts;
  uint32_t websocket_disconnects;
  uint32_t websocket_errors;
  uint32_t mount_timeouts;
  uint32_t mount_timeout_generation;
  uint32_t protocol_failures;
  uint32_t control_messages_discarded;
  uint32_t control_inbox_discarded;
  uint32_t control_inbox_deferrals;
  uint32_t control_receive_failures;
  uint32_t network_task_stack_exhaustions;
  uint32_t network_task_work_cycles;
  uint32_t network_task_max_work_cycles;
  int32_t last_platform_error;
  /*
   * Last Cap'n Web status emitted by callback-side fragment validation. Keep
   * this separate from esp_err_t: the numeric domains overlap but describe
   * different causal layers and must remain independently diagnosable.
   */
  int32_t last_control_receive_status;
  int32_t last_wifi_disconnect_reason;
  /*
   * These latest-incident fields deliberately survive a successful reconnect.
   * The event-only managed-client subfields remain for schema compatibility as
   * described above; the direct adapter publishes its actual errno through
   * last_websocket_transport_errno.
   */
  uint32_t last_websocket_error_generation;
  int32_t last_websocket_error_type;
  int32_t last_websocket_tls_error;
  int32_t last_websocket_tls_stack_error;
  int32_t last_websocket_transport_errno;
  int32_t last_websocket_handshake_status_code;
  int32_t last_websocket_close_status_code;
  /* Application-task-only generation and lifecycle bookkeeping. */
  uint32_t handled_socket_generation;
  bool owns_default_event_loop;
  bool initialized;
  bool started;
};

/**
 * Validates configuration/rings, constructs the bounded WebSocket URL, and
 * binds Cap'n Web fragment adapters. It performs no network I/O, starts no
 * task, and allocates no memory. A successful prepare establishes the lifetime
 * contract; start() performs the platform mutations.
 */
enum iterate_kit_status iterate_kit_esp_idf_itx_transport_prepare(
    struct iterate_kit_esp_idf_itx_transport *transport,
    const struct iterate_kit_esp_idf_itx_transport_options *options);

/**
 * Cap'n Web egress callback; it only copies into the bounded control outbox.
 *
 * It may return Cap'n Web backpressure and never waits for the network task.
 * END wakes that task because only a complete text message is eligible for
 * sending; waking on every fragment would add scheduler churn without making a
 * partial WebSocket message useful.
 */
enum capnweb_status iterate_kit_esp_idf_itx_transport_send_text(
    void *context,
    enum capnweb_text_fragment_kind kind,
    const char *data,
    size_t length);

/**
 * Creates ESP-IDF Wi-Fi/WebSocket resources and the static network task.
 *
 * This setup may allocate and block inside ESP-IDF and belongs on the
 * application boot task, never a realtime audio callback. On a non-OK result,
 * last_platform_error identifies the platform operation that prevented start.
 */
enum iterate_kit_status iterate_kit_esp_idf_itx_transport_start(
    struct iterate_kit_esp_idf_itx_transport *transport);

/**
 * Drains at most max_control_messages on the application task and advances
 * authentication/mount state. It never performs socket I/O or waits. The
 * caller-supplied bound is a CPU fairness contract: a burst of RPC messages
 * cannot monopolize the task that must also service capture and playback.
 */
enum iterate_kit_status iterate_kit_esp_idf_itx_transport_poll(
    struct iterate_kit_esp_idf_itx_transport *transport,
    size_t max_control_messages);

/**
 * Asynchronously replaces the current WebSocket generation.
 *
 * The call only publishes a flag and wakes the network task; it is safe for
 * event/callback paths that cannot block. Unsent control messages are discarded
 * at the generation boundary because replaying Cap'n Web session traffic is
 * less correct than remounting cleanly.
 */
void iterate_kit_esp_idf_itx_transport_request_restart(
    struct iterate_kit_esp_idf_itx_transport *transport);

/**
 * Requests network-task exit and waits for at most the implementation's
 * bounded stop timeout before destroying shared platform resources.
 *
 * A timeout returns IO_ERROR and deliberately leaves resources intact: freeing
 * a socket or event handler still reachable by a wedged task would convert a
 * diagnosable shutdown failure into use-after-free.
 */
enum iterate_kit_status iterate_kit_esp_idf_itx_transport_stop(
    struct iterate_kit_esp_idf_itx_transport *transport);

/**
 * Reads a diagnostic snapshot concurrently with event/network task updates.
 *
 * Individual counters are race-free but the group is not a transaction; it is
 * suitable for trends and incident evidence, not reconstructing exact event
 * ordering.
 */
void iterate_kit_esp_idf_itx_transport_metrics(
    const struct iterate_kit_esp_idf_itx_transport *transport,
    struct iterate_kit_esp_idf_itx_transport_metrics *metrics);

void iterate_kit_esp_idf_itx_transport_lifecycle(
    const struct iterate_kit_esp_idf_itx_transport *transport,
    struct iterate_kit_esp_idf_itx_transport_lifecycle *lifecycle);

const char *iterate_kit_esp_idf_itx_transport_state_name(
    enum iterate_kit_esp_idf_itx_transport_state state);

#ifdef __cplusplus
}
#endif

#endif
