#ifndef ITERATE_KIT_PLATFORMS_ESP_IDF_PCM_TRANSPORT_H
#define ITERATE_KIT_PLATFORMS_ESP_IDF_PCM_TRANSPORT_H

#if defined(__GNUC__)
#pragma GCC system_header
#endif

#include "iterate/kit/buffer_metrics.h"
#include "iterate/kit/audio.h"
#include "iterate/kit/configuration.h"
#include "iterate/kit/pcm_lane.h"
#include "iterate/kit/pcm_uplink_conductor.h"
#include "iterate/kit/platforms/esp_idf_websocket_connection.h"
#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stdint.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#ifdef __cplusplus
extern "C" {
#endif

enum {
  /*
   * ESP-IDF task depths and StackType_t are byte-based on supported ESP32
   * targets. The stack is static so failure is known at prepare/start and
   * runtime heap fragmentation cannot take audio offline. Synchronous TLS
   * verification defines the shared owner size; steady-state PCM work does not
   * get a smaller stack because the same task must first survive open(). The
   * 512-byte floor is a fatal pre-connect guard, not proof that the shared size
   * is optimal; device endurance metrics must justify tightening it.
   */
  ITERATE_KIT_ESP_IDF_PCM_NETWORK_TASK_STACK_BYTES =
      ITERATE_KIT_ESP_IDF_WEBSOCKET_TLS_OWNER_STACK_BYTES,
  ITERATE_KIT_ESP_IDF_PCM_NETWORK_TASK_MINIMUM_HEADROOM_BYTES = 512,
  /*
   * Device ids are capability/stream path segments, not display names. The
   * bound includes NUL and matches the userspace validator; keeping it here
   * prevents a target from smuggling an arbitrary header-sized path into a
   * transport object whose RAM is otherwise fixed at compile time.
   */
  ITERATE_KIT_ESP_IDF_PCM_DEVICE_ID_CAPACITY = 64,
  ITERATE_KIT_ESP_IDF_PCM_AUTH_HEADERS_CAPACITY =
      ITERATE_KIT_PROJECT_API_KEY_CAPACITY +
      ITERATE_KIT_PROJECT_ID_CAPACITY +
      ITERATE_KIT_ESP_IDF_PCM_DEVICE_ID_CAPACITY + 144,
};

enum iterate_kit_esp_idf_pcm_transport_state {
  ITERATE_KIT_ESP_IDF_PCM_IDLE = 0,
  ITERATE_KIT_ESP_IDF_PCM_CONNECTING,
  ITERATE_KIT_ESP_IDF_PCM_READY,
  ITERATE_KIT_ESP_IDF_PCM_FAILED,
  ITERATE_KIT_ESP_IDF_PCM_STOPPING,
  ITERATE_KIT_ESP_IDF_PCM_STOPPED,
};

struct iterate_kit_esp_idf_pcm_transport_options {
  /*
   * Both objects are borrowed for the complete transport lifetime. The caller
   * must not rewrite provisioned credentials or destroy the lane while the
   * network task can run.
   */
  const struct iterate_kit_configuration *configuration;
  /*
   * Firmware-owned slug advertised only after project authentication. The
   * userspace owner derives `kit.<slug>` and `/devices/<slug>` from it so one
   * shared PCM implementation cannot accidentally subscribe to or label a
   * different board's capability. Borrowed for prepare() only; the resulting
   * header is copied into transport-owned storage.
   */
  const char *device_id;
  /*
   * Authenticated socket-generation policy, not a device-name heuristic.
   * Userspace uses this to choose manual commits versus provider server VAD;
   * the firmware must keep it identical to its local capture-gate policy.
   */
  enum iterate_kit_audio_mode audio_mode;
  struct iterate_kit_pcm_lane *lane;
  /*
   * A socket generation is not safe merely because the application ring was
   * emptied: prior speech can still be selected by cyclic DMA. poll() calls
   * this nonblocking fence on its application-side owner before it admits any
   * frame from a newly connected socket, and again on disconnect. ITERATE_KIT_
   * UNAVAILABLE means an audio-owner command is still pending; ITERATE_KIT_OK
   * promises old hardware playback can no longer occur. Every other result is
   * a local invariant/hardware failure and latches the transport failed.
   *
   * `generation` names the observed socket epoch. `connected` distinguishes
   * its admission fence from the teardown fence for the same epoch.
   */
  enum iterate_kit_status (*downlink_generation_barrier)(
      void *context,
      uint32_t generation,
      bool connected);
  void *downlink_generation_barrier_context;
  /*
   * Called synchronously on the network task after one complete playback frame
   * is published. It must only wake/defer the playback owner; blocking or
   * touching speaker hardware here would delay socket receive and microphone
   * send.
   */
  void (*downlink_ready)(void *context);
  void *downlink_ready_context;
};

struct iterate_kit_esp_idf_pcm_transport_metrics {
  uint32_t websocket_start_attempts;
  uint32_t websocket_connections;
  uint32_t websocket_disconnects;
  uint32_t websocket_errors;
  uint32_t websocket_raw_write_calls;
  uint32_t websocket_raw_write_partial;
  uint32_t websocket_raw_write_deferrals;
  uint32_t websocket_raw_write_failures;
  uint32_t websocket_receive_calls;
  uint32_t websocket_receive_chunks;
  /*
   * Exact RFC control frames parsed on this WebSocket hop. They are useful
   * protocol/liveness observations only: neither counter proves that the
   * userspace proxy or voice provider received a PCM frame.
   */
  uint32_t websocket_pings_received;
  uint32_t websocket_pongs_received;
  uint32_t websocket_control_backpressure;
  uint32_t websocket_transport_failure_incidents;
  enum iterate_kit_esp_idf_websocket_failure_operation
      websocket_last_failure_operation;
  int32_t websocket_last_raw_result;
  int32_t websocket_last_socket_errno;
  int32_t websocket_last_esp_tls_error;
  int32_t websocket_last_tls_stack_error;
  int32_t websocket_last_tls_cert_flags;
  uint32_t protocol_failures;
  uint32_t uplink_frames_sent;
  uint32_t uplink_frames_discarded;
  uint32_t uplink_send_deferrals;
  uint32_t uplink_send_failures;
  uint32_t uplink_consecutive_send_deferrals;
  uint32_t uplink_maximum_consecutive_send_deferrals;
  /*
   * A freshness incident may either cancel a wholly-local WebSocket frame or
   * replace the connection after a partial write/disconnect. Publishing both
   * outcomes prevents a dashboard from calling every stale-audio purge a TLS
   * reconnect merely because the lower sender historically used "restart"
   * for its request name.
   */
  uint32_t uplink_restart_incidents;
  uint32_t uplink_in_place_freshness_recoveries;
  uint32_t uplink_socket_restarts;
  uint32_t uplink_producer_backpressure_restarts;
  uint32_t uplink_transport_disconnect_restarts;
  uint32_t uplink_no_progress_timeout_restarts;
  uint32_t uplink_frame_send_timeout_restarts;
  uint32_t uplink_capture_stale_restarts;
  uint32_t uplink_last_transport_accept_age_ms;
  uint32_t uplink_maximum_transport_accept_age_ms;
  uint32_t uplink_last_restart_oldest_capture_age_ms;
  uint32_t uplink_last_restart_frames_discarded;
  enum iterate_kit_pcm_uplink_restart_reason
      uplink_last_restart_reason;
  uint32_t uplink_policy_time_normalizations;
  uint32_t uplink_maximum_policy_time_adjustment_ms;
  uint32_t uplink_owner_clock_regressions;
  uint32_t downlink_receive_failures;
  uint32_t downlink_ordered_item_losses;
  /*
   * Receipt counts describe the capacity boundary on this exact PCM hop.
   * `released` means the hardware-clocked consumer freed one ordered lane item;
   * `acknowledged` means its cumulative receipt finished the socket write. A
   * receipt is not an audible-playback acknowledgement, but it gives workerd
   * the finite credit boundary that its server-side WebSocket API lacks.
   */
  uint32_t downlink_receipt_failures;
  uint32_t downlink_items_released;
  uint32_t downlink_items_acknowledged;
  uint32_t downlink_receipts_sent;
  uint32_t downlink_receipt_send_deferrals;
  uint32_t network_task_stack_high_water_bytes;
  uint32_t network_task_stack_exhaustions;
  uint32_t network_task_work_cycles;
  uint32_t network_task_max_work_cycles;
  int32_t last_platform_error;
  /*
   * The egress chain is intentionally complete, including explicit
   * UNAVAILABLE entries. Omitting an opaque layer would let dashboards mistake
   * "not measured" for "empty".
   */
  struct {
    struct iterate_kit_buffer_metrics uplink_application;
    struct iterate_kit_buffer_metrics websocket_transmitter;
    struct iterate_kit_buffer_metrics lwip_send;
    struct iterate_kit_buffer_metrics tls_egress;
    struct iterate_kit_buffer_metrics wifi_egress;
  } buffers;
  struct iterate_kit_pcm_lane_metrics lane;
};

/**
 * Independent binary PCM WebSocket. It assumes another platform component
 * owns station-mode Wi-Fi; this transport never initializes, starts, stops, or
 * reconnects Wi-Fi.
 *
 * The network task is the sole owner of the WebSocket and portable uplink
 * conductor. The main task only reads atomic metrics and reconciles public
 * state. The conductor contains sender/control ordering so the exact
 * partial-write and mandatory PONG behavior is host-testable rather than an
 * ESP-specific convention. PONG never gates PCM admission. One owner still
 * means no transmit mutex is needed.
 *
 * The object is intentionally large and caller-owned: it contains one exact
 * receive frame, one masked transmit frame, and a static task stack. There is
 * no runtime audio/network heap allocation. Do not copy or move it after
 * prepare—the conductor and WebSocket callbacks retain self-relative context,
 * and the running FreeRTOS task borrows the address.
 */
struct iterate_kit_esp_idf_pcm_transport {
  struct iterate_kit_esp_idf_pcm_transport_options options;
  char websocket_url[ITERATE_KIT_PCM_WEBSOCKET_URL_CAPACITY];
  char auth_headers[ITERATE_KIT_ESP_IDF_PCM_AUTH_HEADERS_CAPACITY];
  uint8_t websocket_receive_storage[
      ITERATE_KIT_PCM_V1_FRAME_BYTES];
  uint8_t websocket_transmit_storage[
      ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(
          ITERATE_KIT_PCM_V1_FRAME_BYTES)];
  struct iterate_kit_esp_idf_websocket_connection websocket;
  struct iterate_kit_pcm_uplink_conductor uplink;
  StaticTask_t network_task_storage;
  /*
   * The array length is bytes on ESP-IDF because StackType_t is uint8_t. Keep
   * the named unit and device high-water telemetry together; an accidental
   * vanilla-FreeRTOS “words” conversion would quadruple permanent RAM.
   */
  StackType_t network_task_stack[
      ITERATE_KIT_ESP_IDF_PCM_NETWORK_TASK_STACK_BYTES];
  TaskHandle_t network_task;
  enum iterate_kit_esp_idf_pcm_transport_state state;
  uint32_t socket_connected;
  uint32_t socket_generation;
  uint32_t restart_requested;
  uint32_t fatal_failure_latched;
  uint32_t network_task_running;
  uint32_t network_task_exited;
  uint32_t websocket_start_attempts;
  uint32_t websocket_connections;
  uint32_t websocket_disconnects;
  uint32_t websocket_errors;
  uint32_t protocol_failures;
  uint32_t downlink_receive_failures;
  uint32_t downlink_ordered_item_losses;
  uint32_t downlink_receipt_failures;
  /*
   * The priority playback owner is the sole producer and the network task is
   * the sole consumer. This atomic handoff carries counts, never audio; its
   * maximum live value is bounded by the finite downlink lane.
   */
  uint32_t downlink_items_released_pending;
  uint32_t network_task_stack_exhaustions;
  uint32_t network_task_work_cycles;
  uint32_t network_task_max_work_cycles;
  int32_t last_platform_error;
  /*
   * A successful WebSocket upgrade publishes socket_generation from the
   * network owner. The application consumer publishes acceptance only after
   * purging the prior generation's speaker queue. Until the two values match,
   * the owner must not read from the new socket: otherwise the consumer cannot
   * distinguish the first fresh frame from stale audio and may delete it.
   *
   * accepted_socket_generation is cross-task atomic storage.
   * handled_socket_generation remains application-task-only.
   */
  uint32_t accepted_socket_generation;
  uint32_t handled_socket_generation;
  bool handled_socket_connected;
  uint32_t reported_uplink_restart_incidents;
  bool initialized;
  bool started;
};

enum iterate_kit_status iterate_kit_esp_idf_pcm_transport_prepare(
    struct iterate_kit_esp_idf_pcm_transport *transport,
    const struct iterate_kit_esp_idf_pcm_transport_options *options);

/**
 * Publishes hardware-clocked downlink slot releases to the network owner.
 *
 * This callback is safe from the priority audio task: it performs one bounded
 * atomic increment and task notification, with no allocation, logging, locks,
 * or socket work. The network task coalesces the count into a cumulative
 * application receipt. Calling it at socket ingress is incorrect because that
 * would grant new supply before the device clock freed capacity.
 */
void iterate_kit_esp_idf_pcm_transport_note_downlink_item_released(
    void *context,
    uint32_t released_items);

/**
 * Wakes the socket owner after its producer publishes an uplink frame.
 * Safe before start and from a task other than the socket owner.
 */
void iterate_kit_esp_idf_pcm_transport_notify_uplink(
    struct iterate_kit_esp_idf_pcm_transport *transport);

void iterate_kit_esp_idf_pcm_transport_metrics(
    const struct iterate_kit_esp_idf_pcm_transport *transport,
    struct iterate_kit_esp_idf_pcm_transport_metrics *metrics);

#ifdef __cplusplus
}
#endif

#endif
