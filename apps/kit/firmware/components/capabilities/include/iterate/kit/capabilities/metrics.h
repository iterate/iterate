#ifndef ITERATE_KIT_CAPABILITIES_METRICS_H
#define ITERATE_KIT_CAPABILITIES_METRICS_H

#include "iterate/kit/capabilities/callback_budget.h"
#include "iterate/kit/buffer_metrics.h"
#include "iterate/kit/peer.h"
#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Raw latest-state evidence for direct speaker playback.
 *
 * This is deliberately a second serialization view over the same once-per-
 * interval sample used by subscribeToMetrics(). The general callback is
 * already close to the fixed 2 KiB Cap'n Web control-slot limit; silently
 * growing that object would make diagnostics disappear precisely after its
 * counters become wide during an endurance run. Keeping the detailed view
 * separate buys wire headroom without adding another sampler, task, queue, or
 * history buffer.
 *
 * Names mirror the owner-local realtime policy rather than collapsing distinct
 * loss causes into one "failure" total. Acceptance can therefore require every
 * destructive path to remain unchanged and can distinguish a slow owner task,
 * a slow I2S copy, and an exhausted physical descriptor-reuse deadline.
 */
struct iterate_kit_playback_metrics_sample {
  uint32_t schema_version;
  uint32_t sequence;
  int64_t produced_at_ms;
  uint32_t downlink_accepted;
  struct {
    uint32_t frames_dequeued;
    uint32_t submitted;
    uint32_t completed;
    uint32_t generation_frames_flushed;
    uint32_t freshness_frames_dropped;
    uint32_t partial_prebuffer_frames_dropped;
    uint32_t underrun_frames_flushed;
    uint32_t underrun_incidents;
    uint32_t underrun_silence_frames_submitted;
    uint32_t underrun_silence_frames_completed;
    uint32_t underrun_silence_frames_retired;
    uint32_t underrun_late_frames_dropped;
    uint32_t dma_deadline_miss_incidents;
    uint32_t freshness_incidents;
    uint32_t partial_prebuffer_incidents;
    uint32_t end_of_stream_markers_consumed;
    uint32_t end_of_stream_responses;
    uint32_t end_of_stream_silence_descriptors;
    uint32_t end_of_stream_padding_descriptors_completed;
    uint32_t driver_queue_overflow_incidents;
    uint32_t driver_failures;
    uint32_t driver_stop_failures;
    uint32_t fatal_frames_flushed;
    uint32_t write_backpressure_incidents;
    uint32_t write_backpressure_destructive_resets;
    uint32_t write_backpressure_frames_dropped;
    uint32_t invalid_frames;
    uint32_t state_errors;
    uint32_t owner_clock_regressions;
    uint32_t current_content_frames;
    uint32_t high_water_content_frames;
    uint32_t last_receive_to_dma_ms;
    uint32_t maximum_receive_to_dma_ms;
    uint32_t receive_to_dma_start_samples;
    uint32_t last_receive_to_dma_start_ms;
    uint32_t maximum_receive_to_dma_start_ms;
    uint32_t downlink_interarrival_samples;
    uint32_t maximum_downlink_interarrival_ms;
    uint32_t completion_timing_samples;
    uint32_t last_eof_to_owner_us;
    uint32_t maximum_eof_to_owner_us;
    uint32_t last_earliest_reuse_lead_us;
    uint32_t minimum_earliest_reuse_lead_us;
    uint32_t successful_refill_timing_samples;
    uint32_t last_eof_to_successful_refill_us;
    uint32_t maximum_eof_to_successful_refill_us;
    uint32_t last_write_call_duration_us;
    uint32_t maximum_write_call_duration_us;
    uint32_t last_reuse_lead_at_successful_refill_us;
    uint32_t minimum_reuse_lead_at_successful_refill_us;
    uint32_t state;
  } playback;
  struct {
    uint32_t audio_owner_stack_headroom_bytes;
    uint32_t main_stack_headroom_bytes;
    uint32_t control_network_stack_headroom_bytes;
    uint32_t pcm_network_stack_headroom_bytes;
    uint32_t free_internal_heap_bytes;
    uint32_t minimum_free_internal_heap_bytes;
    uint32_t free_dma_heap_bytes;
    uint32_t minimum_free_dma_heap_bytes;
    uint32_t largest_free_internal_heap_block_bytes;
    uint32_t largest_free_dma_block_bytes;
    int64_t cpu_permille;
    uint32_t generation_fence_acknowledgement_timeouts;
    uint32_t lifecycle_acknowledgement_timeouts;
    uint32_t control_network_stack_exhaustions;
    uint32_t pcm_network_stack_exhaustions;
    /*
     * These are cumulative stages of the one PCM socket receive path, not
     * sampled queue depths. `pcm_receive_calls` advances immediately before a
     * nonblocking lower-transport read; `pcm_receive_chunks` advances only
     * when that read yields bytes. Comparing both with `downlink_accepted`
     * distinguishes task starvation, socket starvation, and a partial
     * WebSocket message without adding clocks, buffers, or work to the
     * realtime path.
     */
    uint32_t pcm_receive_calls;
    uint32_t pcm_receive_chunks;
    uint32_t control_network_max_work_cycles;
    uint32_t pcm_network_max_work_cycles;
  } runtime;
};

/**
 * One bounded AEC signal window from a full-duplex audio owner.
 *
 * Peaks and mean absolute amplitudes describe the same sampled positions in
 * the pre-AEC near/reference streams and the post-AEC clean stream. That
 * alignment matters: three unrelated lifetime peaks cannot tell whether a
 * physical utterance reached the microphone or whether AEC removed it. The
 * device intentionally publishes integer mean absolute amplitude rather than
 * RMS. It avoids square-root/floating-point work on the audio target while the
 * host can still derive suppression ratios for speaker-only intervals.
 *
 * This remains separate from the general metrics callback because that wire
 * object has less than one hundred and twenty bytes of measured headroom. A
 * dedicated serialization view reuses the same sampler and subscriber slots;
 * it does not add a task, queue, sample history, or per-frame allocation.
 */
struct iterate_kit_aec_metrics_sample {
  uint32_t schema_version;
  uint32_t sequence;
  int64_t window_started_at_ms;
  int64_t produced_at_ms;
  uint32_t sample_stride;
  uint32_t sampled_samples;
  uint32_t near_peak;
  uint32_t reference_peak;
  uint32_t clean_peak;
  uint32_t near_mean_absolute;
  uint32_t reference_mean_absolute;
  uint32_t clean_mean_absolute;
  uint32_t lifetime_frames_processed;
  uint32_t lifetime_recreates;
  uint32_t lifetime_recreate_failures;
  uint32_t last_linear_us;
  uint32_t maximum_linear_us;
  uint32_t last_nlp_us;
  uint32_t maximum_nlp_us;
  uint32_t last_capture_to_uplink_us;
  uint32_t maximum_capture_to_uplink_us;
  uint32_t lifetime_capture_reserve_dropped_chunks;
  uint32_t lifetime_capture_bridge_errors;
  uint32_t lifetime_signal_measurement_failures;
};

/**
 * Latest classified control-transport incident retained across reconnect.
 *
 * A metrics callback belongs to the Cap'n Web session that carried it, so the
 * callback itself disappears at exactly the moment these fields matter. The
 * replacement session can request this fixed latest-state snapshot without a
 * log queue or retained history. `last_websocket_error_generation` tells the
 * host whether the incident belongs to the socket epoch that just disappeared;
 * the remaining integer domains deliberately mirror ESP-IDF rather than
 * inventing a lossy common error code in the capability layer.
 */
struct iterate_kit_control_diagnostics_sample {
  uint32_t schema_version;
  int64_t produced_at_ms;
  uint32_t websocket_start_attempts;
  uint32_t websocket_connections;
  uint32_t websocket_disconnects;
  uint32_t websocket_errors;
  uint32_t wifi_disconnects;
  uint32_t protocol_failures;
  uint32_t control_receive_failures;
  uint32_t control_send_failures;
  int32_t last_wifi_disconnect_reason;
  uint32_t last_websocket_error_generation;
  int32_t last_websocket_error_type;
  int32_t last_websocket_tls_error;
  int32_t last_websocket_tls_stack_error;
  int32_t last_websocket_transport_errno;
  int32_t last_websocket_handshake_status_code;
  int32_t last_websocket_close_status_code;
  /*
   * `protocol_failure_generation` is the newest rejected socket epoch from
   * either callback ingress or the application owner. The application pair
   * retains the exact Cap'n Web result from owner-side parsing/serialization;
   * callback-side frame assembly keeps its independent receive status.
   */
  uint32_t protocol_failure_generation;
  uint32_t last_application_capnweb_generation;
  int32_t last_application_capnweb_status;
  int32_t last_control_receive_status;
  uint32_t control_messages_sent;
  uint32_t control_messages_discarded;
  uint32_t control_inbox_discarded;
  uint32_t control_outbox_discarded;
  struct {
    uint32_t capacity_slots;
    uint32_t messages_published;
    uint32_t messages_consumed;
    uint32_t producer_backpressure;
    uint32_t high_water_slots;
    uint32_t current_slots;
  } control_inbox, control_outbox;
  /*
   * This is deliberately a sibling of the control object on the wire. Control
   * reconnect evidence has an established schema and meaning; adding audio or
   * radio state inside it would make every consumer reinterpret that object.
   *
   * `wifi_connected` comes from the transport's current association state.
   * RSSI is a separate optional observation because querying AP info can fail
   * during a roam even while the transport has not yet observed a disconnect.
   * Never use wifi_rssi_dbm unless has_wifi_rssi_dbm is true.
   */
  struct {
    bool wifi_connected;
    bool has_wifi_rssi_dbm;
    int32_t wifi_rssi_dbm;
    uint32_t pcm_websocket_connections;
    uint32_t pcm_websocket_disconnects;
    uint32_t pcm_websocket_errors;
    /*
     * The PCM WebSocket wrapper collapses every terminal lower-layer result
     * into a reconnect, but the physical rig must still distinguish peer FIN,
     * socket errno, ESP-TLS, TLS-stack, and wrapper-only failures. This is one
     * retained latest-incident tuple, not a log or queue. Operation values are
     * 0 none, 1 connect, 2 read, and 3 write; the integer error domains remain
     * verbatim ESP-IDF values so the host can classify them without guessing.
     */
    uint32_t pcm_websocket_raw_write_failures;
    uint32_t pcm_transport_failure_incidents;
    uint32_t pcm_last_failure_operation;
    int32_t pcm_last_raw_result;
    int32_t pcm_last_socket_errno;
    int32_t pcm_last_esp_tls_error;
    int32_t pcm_last_tls_stack_error;
    int32_t pcm_last_tls_cert_flags;
  } network;
};

/**
 * One allocation-free snapshot supplied by the platform metrics driver.
 *
 * Uptime remains signed 64-bit because an ESP32 can remain online for longer
 * than UINT32_MAX milliseconds. CPU is signed because -1 means that the first
 * sample has no preceding interval. Every byte count, queue depth, and event
 * counter is uint32_t by design: the ESP-IDF sources are 32-bit, and producers
 * must saturate rather than wrap when combining wider device-local counters.
 * That finite domain makes the wire-size limit testable; the serialization
 * regression then exercises every maximum-width value and preserves explicit
 * headroom in the fixed 2 KiB control slot. Neither half is sufficient alone:
 * saturation prevents growth over time, while the regression catches schema
 * growth that would make even a correctly saturated sample too large.
 */
struct iterate_kit_metrics_sample {
  int64_t uptime_ms;
  uint32_t free_heap_bytes;
  uint32_t minimum_free_heap_bytes;
  uint32_t free_internal_heap_bytes;
  uint32_t minimum_free_internal_heap_bytes;
  uint32_t free_psram_bytes;
  uint32_t task_stack_high_water_bytes;
  int64_t cpu_permille;
  bool has_audio;
  struct {
    struct {
      uint32_t sent;
      uint32_t dropped;
      uint32_t failures;
    } capture;
    struct {
      uint32_t sent;
      uint32_t dropped;
      uint32_t depth;
      uint32_t high_water;
      uint32_t failures;
      uint32_t send_deferrals;
      uint32_t consecutive_send_deferrals;
      uint32_t maximum_consecutive_send_deferrals;
      uint32_t restart_incidents;
      uint32_t in_place_freshness_recoveries;
      uint32_t socket_restarts;
      uint32_t producer_backpressure_restarts;
      uint32_t transport_disconnect_restarts;
      uint32_t no_progress_timeout_restarts;
      uint32_t frame_send_timeout_restarts;
      uint32_t capture_stale_restarts;
      uint32_t last_transport_accept_age_ms;
      uint32_t maximum_transport_accept_age_ms;
      uint32_t last_restart_oldest_capture_age_ms;
      const char *last_restart_reason;
      uint32_t last_restart_frames_discarded;
    } uplink;
    struct {
      uint32_t received;
      uint32_t dropped;
      uint32_t depth;
      uint32_t high_water;
      uint32_t failures;
    } downlink;
    struct {
      uint32_t submitted;
      uint32_t completed;
      uint32_t flushed;
      uint32_t depth;
      uint32_t high_water;
      uint32_t failures;
    } playback;
    uint32_t protocol_failures;
    /*
     * Buffer depth without evidence strength is actively misleading: zero can
     * mean empty, not exposed, or merely not sampled. Drivers opt in only after
     * populating every egress layer, so an older device cannot accidentally
     * publish zero-initialized fields as exact observations.
     */
    bool has_buffers;
    struct {
      struct iterate_kit_buffer_metrics uplink_application;
      struct iterate_kit_buffer_metrics websocket_transmitter;
      struct iterate_kit_buffer_metrics lwip_send;
      struct iterate_kit_buffer_metrics tls_egress;
      struct iterate_kit_buffer_metrics wifi_egress;
    } buffers;
    /*
     * Some codec owners can observe transport/capture queues but cannot prove
     * discrete 20 ms content-frame submission and physical completion. Such a
     * target must leave this false so the wire object omits `playback`; zeros
     * would otherwise claim six healthy measurements that were never made.
     */
    bool has_playback;
  } audio;
  bool has_playback_detail;
  struct iterate_kit_playback_metrics_sample playback_detail;
  bool has_aec_detail;
  struct iterate_kit_aec_metrics_sample aec_detail;
  bool has_control_diagnostics;
  struct iterate_kit_control_diagnostics_sample control_diagnostics;
};

struct iterate_kit_metrics_driver {
  void *context;
  /*
   * Sampling is synchronous and must not allocate or wait for slow peripheral
   * I/O. It runs only when at least one subscriber is ready, so expensive
   * collection would otherwise steal time from the device/audio owner loop.
   */
  enum iterate_kit_status (*sample)(
      void *context, struct iterate_kit_metrics_sample *sample);
};

struct iterate_kit_metrics;

enum iterate_kit_metrics_view {
  ITERATE_KIT_METRICS_GENERAL = 0,
  ITERATE_KIT_METRICS_PLAYBACK,
  ITERATE_KIT_METRICS_AEC,
};

/**
 * Caller-owned subscriber slot. A callback is never invoked again while its
 * prior delivery is in flight. Slots, callbacks, and completion state are
 * owned by the one Cap'n Web polling task; this is not a cross-task queue.
 *
 * A rejected or failed callback is removed instead of retried forever. That
 * keeps dead subscribers from generating an unbounded RPC backlog, while
 * `release_pending` preserves the remote-capability ownership obligation until
 * the session can emit the release.
 */
struct iterate_kit_metrics_subscription {
  struct iterate_kit_metrics *owner;
  struct capnweb_remote_capability callback;
  bool occupied;
  bool call_in_flight;
  bool callback_budget_reserved;
  bool release_pending;
  enum iterate_kit_metrics_view view;
};

struct iterate_kit_metrics_options {
  /*
   * Every pointer is borrowed and must outlive the metrics module. Fixed
   * caller-provided slots make the RAM cost visible in the device profile and
   * let subscription exhaustion become an explicit RPC error.
   */
  struct capnweb_session *session;
  struct iterate_kit_metrics_driver driver;
  struct iterate_kit_metrics_subscription *subscriptions;
  size_t subscription_count;
  /* Monotonic milliseconds; zero is rejected to prevent a busy poll loop. */
  uint64_t interval_ms;
  /*
   * Detailed views are mounted only when the target can populate their exact
   * contracts. A method which always fails is not a capability: advertising
   * CoreS3 AEC on a no-AEC Stick (or direct-DMA playback on CoreS3) would make
   * discovery lie and push platform branching into every caller.
   */
  bool enable_playback_view;
  bool enable_aec_view;
  /*
   * getDiagnostics() returns a dynamic object through Cap'n Web's borrowed
   * expression reply. The protocol may retain that reply until a later pull,
   * so stack storage is invalid and heap allocation would make failure
   * diagnosis depend on the resource under investigation. The device profile
   * therefore owns one explicit fixed buffer. Supplying NULL/zero leaves the
   * optional one-shot endpoint unavailable.
   */
  char *diagnostics_expression_buffer;
  size_t diagnostics_expression_capacity;
  /*
   * Optional shared device-level callback admission. NULL preserves the
   * standalone module's subscriber-local bounds; constrained device profiles
   * should share one budget with every other callback-producing module.
   */
  struct iterate_kit_callback_budget *callback_budget;
};

/*
 * This includes the longest legal decimal rendering of every field plus
 * deliberate schema headroom. Keeping the requirement public lets resource
 * profiles account for the exact static RAM cost at compile time.
 */
/*
 * Schema v4's worst-width control and network objects occupy less than 1728
 * bytes. A 1792-byte fixed tier preserves 64 bytes of deliberate schema
 * headroom while costing one retained buffer per mounted device—not one slot
 * in every control ring. The maximum-width serializer regression is the
 * authority for changing this value.
 */
#define ITERATE_KIT_METRICS_DIAGNOSTICS_EXPRESSION_CAPACITY 1792U

/**
 * Allocation-free subscription scheduler. Polling samples once per interval
 * and fans that one stack-built value out to all ready subscribers. It does
 * not overlap calls to an individual callback, buffer missed samples, or
 * promise wall-clock scheduling accuracy; a busy callback simply misses
 * intervals and receives the newest future sample.
 */
struct iterate_kit_metrics {
  struct iterate_kit_metrics_options options;
  uint64_t next_sample_at_ms;
  struct iterate_kit_poll_result pending_result;
  bool diagnostics_reply_in_flight;
  bool initialized;
};

enum iterate_kit_status iterate_kit_metrics_init(
    struct iterate_kit_metrics *metrics,
    const struct iterate_kit_metrics_options *options);
struct iterate_kit_module iterate_kit_metrics_module(
    struct iterate_kit_metrics *metrics);

#ifdef __cplusplus
}
#endif

#endif
