#ifndef ITERATE_KIT_CAPABILITIES_METRICS_H
#define ITERATE_KIT_CAPABILITIES_METRICS_H

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
    uint32_t control_network_max_work_cycles;
    uint32_t pcm_network_max_work_cycles;
  } runtime;
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
     * populating all six egress layers, so an older device cannot accidentally
     * publish zero-initialized fields as exact observations.
     */
    bool has_buffers;
    struct {
      struct iterate_kit_buffer_metrics uplink_application;
      struct iterate_kit_buffer_metrics websocket_transmitter;
      struct iterate_kit_buffer_metrics peer_unconfirmed;
      struct iterate_kit_buffer_metrics lwip_send;
      struct iterate_kit_buffer_metrics tls_egress;
      struct iterate_kit_buffer_metrics wifi_egress;
    } buffers;
  } audio;
  bool has_playback_detail;
  struct iterate_kit_playback_metrics_sample playback_detail;
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
};

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
