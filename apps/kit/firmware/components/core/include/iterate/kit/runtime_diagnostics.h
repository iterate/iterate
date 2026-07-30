#ifndef ITERATE_KIT_RUNTIME_DIAGNOSTICS_H
#define ITERATE_KIT_RUNTIME_DIAGNOSTICS_H

#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  /*
   * The current maximum-width PCM family is 851 bytes including its newline.
   * Capacity minus that line is 45 bytes; snprintf reserves one for its NUL,
   * leaving 44 bytes of usable schema headroom. A host maximum-width test pins
   * all three exact lengths so adding a key cannot spend that budget silently.
   * Avoiding a round 1 KiB allocation saves RAM merely otherwise spent for
   * aesthetic convenience.
   */
  ITERATE_KIT_RUNTIME_DIAGNOSTICS_LINE_CAPACITY = 896,
};

/**
 * Transport lifecycle normalized across control and PCM implementations.
 *
 * Diagnostics consumers need stable values such as `ready`, not platform
 * enum ordinals that can change independently. Connecting deliberately folds
 * Wi-Fi, TLS, and WebSocket setup into one state; detailed failure counters
 * retain the causal layer without making the physical proof depend on an
 * ESP-IDF-specific state machine.
 */
enum iterate_kit_runtime_transport_state {
  ITERATE_KIT_RUNTIME_TRANSPORT_IDLE = 0,
  ITERATE_KIT_RUNTIME_TRANSPORT_CONNECTING,
  ITERATE_KIT_RUNTIME_TRANSPORT_READY,
  ITERATE_KIT_RUNTIME_TRANSPORT_FAILED,
  ITERATE_KIT_RUNTIME_TRANSPORT_STOPPED,
};

/**
 * One owner-task-built, allocation-free runtime observation.
 *
 * The snapshot is a normalized wire model, not shared mutable state. The
 * device owner samples existing atomic transport metrics and its own plain
 * fields, then offers this value synchronously to the exporter. This first
 * slice intentionally does not add a seqlock or exporter task: physical
 * console-stall tests decide whether that extra ~7 KiB topology is justified.
 *
 * Work-cycle fields are modulo-2^32 cumulative hardware counters. offer()
 * converts them to interval deltas before retaining a report. All lifetime
 * incident counters must saturate at their producer; zero after wrap would
 * misrepresent an endurance failure as recovery.
 */
struct iterate_kit_runtime_diagnostics_snapshot {
  uint64_t sampled_at_ms;
  enum iterate_kit_runtime_transport_state control_transport;
  enum iterate_kit_runtime_transport_state pcm_transport;
  int32_t capnweb_status;
  struct {
    uint32_t free_heap_bytes;
    uint32_t minimum_free_heap_bytes;
    uint32_t free_internal_heap_bytes;
    uint32_t minimum_free_internal_heap_bytes;
    uint32_t free_psram_bytes;
    uint32_t main_stack_headroom_bytes;
    uint32_t control_network_stack_headroom_bytes;
    uint32_t pcm_network_stack_headroom_bytes;
    int16_t cpu_permille;
    uint32_t main_work_cycles;
    uint32_t main_max_work_cycles;
    uint32_t control_network_work_cycles;
    uint32_t control_network_max_work_cycles;
    uint32_t pcm_network_work_cycles;
    uint32_t pcm_network_max_work_cycles;
    uint32_t control_network_stack_exhaustions;
    uint32_t pcm_network_stack_exhaustions;
  } system;
  struct {
    uint32_t websocket_start_attempts;
    uint32_t websocket_connections;
    uint32_t websocket_disconnects;
    uint32_t websocket_errors;
    uint32_t protocol_failures;
    uint32_t messages_sent;
    uint32_t messages_discarded;
    uint32_t inbox_current;
    uint32_t inbox_high_water;
    uint32_t inbox_backpressure;
    uint32_t outbox_current;
    uint32_t outbox_high_water;
    uint32_t outbox_backpressure;
    uint32_t events_published;
    uint32_t events_processed;
    uint32_t event_backpressure;
    uint32_t event_failures;
    uint32_t event_high_water;
    uint32_t event_current;
  } control;
  struct {
    uint32_t websocket_start_attempts;
    uint32_t websocket_connections;
    uint32_t websocket_disconnects;
    uint32_t websocket_errors;
    uint32_t protocol_failures;
    uint32_t audio_frames_sent;
    uint32_t audio_frames_dropped;
    uint32_t audio_send_failures;
    uint32_t completion_errors;
    uint32_t uplink_frames_sent;
    uint32_t uplink_frames_discarded;
    uint32_t uplink_send_failures;
    uint32_t uplink_current;
    uint32_t uplink_high_water;
    uint32_t uplink_backpressure;
    uint32_t downlink_frames_accepted;
    uint32_t downlink_frames_dropped;
    uint32_t downlink_receive_failures;
    uint32_t downlink_current;
    uint32_t downlink_high_water;
    uint32_t downlink_backpressure;
    uint32_t playback_submitted;
    uint32_t playback_completed;
    uint32_t playback_flushed;
    uint32_t playback_current;
    uint32_t playback_high_water;
    uint32_t playback_failures;
  } pcm;
};

/**
 * Nonblocking byte sink used by USB/JTAG now and other outer policies later.
 *
 * The function may accept any prefix from zero through `length`; zero means
 * temporary backpressure. Returning more than `length` is a contract failure.
 * It must not allocate or wait. The portable pump retains the exact unwritten
 * suffix, but cannot make a blocking platform implementation nonblocking.
 */
typedef size_t (*iterate_kit_runtime_diagnostics_write_fn)(
    void *context, const char *bytes, size_t length);

struct iterate_kit_runtime_diagnostics_options {
  iterate_kit_runtime_diagnostics_write_fn write;
  void *write_context;
};

struct iterate_kit_runtime_diagnostics_metrics {
  uint32_t reports_offered;
  uint32_t reports_emitted;
  uint32_t reports_skipped;
  uint32_t sink_stall_events;
  uint32_t format_failures;
  uint32_t sink_contract_failures;
  uint64_t maximum_sink_stall_ms;
  bool report_pending;
};

struct iterate_kit_runtime_diagnostics_pump_result {
  size_t bytes_written;
  bool report_completed;
  bool sink_stalled;
};

/**
 * Caller-owned exporter state. Its fixed RAM cost is visible in sizeof().
 *
 * One report and one formatted family line are the complete backlog. A new
 * cadence offered while that report is pending is counted and discarded; it
 * is never queued. Cycle baselines still advance on the skipped observation so
 * recovery reports current one-interval work rather than draining or
 * aggregating minutes of stale realtime telemetry. Wire integrity outranks
 * freshness for the one retained report: after a stall it drains completely
 * before a fresh report can be accepted, so consumers must use `sample_ms`,
 * `report_seq`, and the explicit skip counter rather than treating arrival
 * time as sample time.
 *
 * The owner task exclusively calls every function. No operation allocates.
 * pump() invokes the sink at most once and never offers more than its caller's
 * byte budget, making scheduler work bounded even when a sink accepts one byte
 * at a time. The sink's own blocking behavior remains an outer-layer
 * obligation measured by the physical wedged-console tripwire.
 */
struct iterate_kit_runtime_diagnostics {
  struct iterate_kit_runtime_diagnostics_options options;
  struct iterate_kit_runtime_diagnostics_snapshot report;
  struct iterate_kit_runtime_diagnostics_metrics report_metrics;
  char line[ITERATE_KIT_RUNTIME_DIAGNOSTICS_LINE_CAPACITY];
  size_t line_length;
  size_t line_offset;
  uint64_t stall_started_at_ms;
  uint64_t maximum_sink_stall_ms;
  uint32_t previous_main_work_cycles;
  uint32_t previous_control_network_work_cycles;
  uint32_t previous_pcm_network_work_cycles;
  uint32_t active_report_sequence;
  uint32_t reports_offered;
  uint32_t reports_emitted;
  uint32_t reports_skipped;
  uint32_t sink_stall_events;
  uint32_t format_failures;
  uint32_t sink_contract_failures;
  uint8_t next_family;
  bool has_cycle_baseline;
  bool report_pending;
  bool sink_stalled;
  bool initialized;
};

enum iterate_kit_status iterate_kit_runtime_diagnostics_init(
    struct iterate_kit_runtime_diagnostics *diagnostics,
    const struct iterate_kit_runtime_diagnostics_options *options);

/**
 * Retains the newest report only when the prior one is fully emitted.
 *
 * ITERATE_KIT_BACKPRESSURE is an expected, exactly counted skip, not a request
 * for the caller to retry the stale snapshot. All cycle baselines advance even
 * on that result.
 */
enum iterate_kit_status iterate_kit_runtime_diagnostics_offer(
    struct iterate_kit_runtime_diagnostics *diagnostics,
    const struct iterate_kit_runtime_diagnostics_snapshot *snapshot);

/**
 * Formats when necessary and makes at most one bounded sink call.
 *
 * `now_ms` is monotonic and used only to measure sink stalls. Stall duration
 * advances only while pump() is called; pausing the owner task cannot be
 * measured from inside this single-owner module. A zero-byte sink result is
 * reported as healthy backpressure in `result`, not spun or retried inside
 * this call. A malformed sink result or impossible formatted line is a
 * classified local error.
 */
enum iterate_kit_status iterate_kit_runtime_diagnostics_pump(
    struct iterate_kit_runtime_diagnostics *diagnostics,
    uint64_t now_ms,
    size_t byte_budget,
    struct iterate_kit_runtime_diagnostics_pump_result *result);

void iterate_kit_runtime_diagnostics_metrics(
    const struct iterate_kit_runtime_diagnostics *diagnostics,
    struct iterate_kit_runtime_diagnostics_metrics *metrics);

#ifdef __cplusplus
}
#endif

#endif
