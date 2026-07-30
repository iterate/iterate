#include "iterate/kit/runtime_diagnostics.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void test_assert(
    bool condition,
    const char *expression,
    const char *file,
    int line) {
  if (condition) {
    return;
  }
  fprintf(stderr, "%s:%d: assertion failed: %s\n", file, line, expression);
  abort();
}

#define assert(expression) \
  test_assert((expression), #expression, __FILE__, __LINE__)

struct short_write_sink {
  char bytes[4096];
  size_t length;
};

struct controllable_sink {
  char bytes[8192];
  size_t length;
  bool stalled;
};

struct measuring_sink {
  char bytes[4096];
  size_t length;
  size_t calls;
  size_t call_lengths[8];
};

struct budget_sink {
  char bytes[4096];
  size_t length;
  size_t calls;
  size_t maximum_request;
};

struct lying_sink {
  char bytes[4096];
  size_t length;
  bool lie_once;
};

static size_t write_at_most_seven_bytes(
    void *context, const char *bytes, size_t length) {
  struct short_write_sink *sink = context;
  size_t accepted = length < 7U ? length : 7U;
  assert(sink != NULL);
  assert(bytes != NULL);
  assert(sink->length + accepted < sizeof(sink->bytes));
  memcpy(sink->bytes + sink->length, bytes, accepted);
  sink->length += accepted;
  sink->bytes[sink->length] = '\0';
  return accepted;
}

static size_t write_when_unstalled(
    void *context, const char *bytes, size_t length) {
  struct controllable_sink *sink = context;
  assert(sink != NULL);
  assert(bytes != NULL);
  if (sink->stalled) {
    return 0U;
  }
  assert(sink->length + length < sizeof(sink->bytes));
  memcpy(sink->bytes + sink->length, bytes, length);
  sink->length += length;
  sink->bytes[sink->length] = '\0';
  return length;
}

static size_t write_and_measure(
    void *context, const char *bytes, size_t length) {
  struct measuring_sink *sink = context;
  assert(sink != NULL);
  assert(bytes != NULL);
  assert(sink->calls < sizeof(sink->call_lengths) /
                           sizeof(sink->call_lengths[0]));
  assert(sink->length + length < sizeof(sink->bytes));
  sink->call_lengths[sink->calls++] = length;
  memcpy(sink->bytes + sink->length, bytes, length);
  sink->length += length;
  sink->bytes[sink->length] = '\0';
  return length;
}

static size_t write_greedily(
    void *context, const char *bytes, size_t length) {
  struct budget_sink *sink = context;
  assert(sink != NULL);
  assert(bytes != NULL);
  assert(sink->length + length < sizeof(sink->bytes));
  ++sink->calls;
  if (length > sink->maximum_request) {
    sink->maximum_request = length;
  }
  memcpy(sink->bytes + sink->length, bytes, length);
  sink->length += length;
  sink->bytes[sink->length] = '\0';
  return length;
}

static size_t lie_then_write(
    void *context, const char *bytes, size_t length) {
  struct lying_sink *sink = context;
  assert(sink != NULL);
  assert(bytes != NULL);
  if (sink->lie_once) {
    sink->lie_once = false;
    return length + 1U;
  }
  assert(sink->length + length < sizeof(sink->bytes));
  memcpy(sink->bytes + sink->length, bytes, length);
  sink->length += length;
  sink->bytes[sink->length] = '\0';
  return length;
}

/*
 * USB serial, a tunnel recorder, or a future microSD sink may accept only a
 * prefix even when one complete metrics line is ready. Restarting formatting
 * after each short write would duplicate prefixes; advancing to another family
 * would splice two machine-readable records together. Drive every write down
 * to seven bytes and compare the independent wire literal so the public pump
 * contract remains line-preserving without relying on stdio buffering.
 */
static void short_writes_preserve_complete_metric_lines(void) {
  struct short_write_sink sink = {0};
  struct iterate_kit_runtime_diagnostics diagnostics;
  const struct iterate_kit_runtime_diagnostics_options options = {
      .write = write_at_most_seven_bytes,
      .write_context = &sink,
  };
  const struct iterate_kit_runtime_diagnostics_snapshot snapshot = {
      .sampled_at_ms = 1203U,
      .control_transport =
          ITERATE_KIT_RUNTIME_TRANSPORT_READY,
      .pcm_transport = ITERATE_KIT_RUNTIME_TRANSPORT_READY,
      .capnweb_status = 0,
      .system = {
          .free_heap_bytes = 238175U,
          .minimum_free_heap_bytes = 233147U,
          .free_internal_heap_bytes = 220000U,
          .minimum_free_internal_heap_bytes = 210000U,
          .free_psram_bytes = 0U,
          .main_stack_headroom_bytes = 4960U,
          .control_network_stack_headroom_bytes = 864U,
          .pcm_network_stack_headroom_bytes = 912U,
          .cpu_permille = 73,
          .main_work_cycles = 54000U,
          .main_max_work_cycles = 1800U,
          .control_network_work_cycles = 91000U,
          .control_network_max_work_cycles = 22000U,
          .pcm_network_work_cycles = 81000U,
          .pcm_network_max_work_cycles = 19000U,
          .control_network_stack_exhaustions = 0U,
          .pcm_network_stack_exhaustions = 0U,
      },
      .control = {
          .websocket_start_attempts = 1U,
          .websocket_connections = 1U,
          .websocket_disconnects = 0U,
          .websocket_errors = 0U,
          .protocol_failures = 0U,
          .messages_sent = 5U,
          .messages_discarded = 0U,
          .inbox_current = 0U,
          .inbox_high_water = 1U,
          .inbox_backpressure = 0U,
          .outbox_current = 0U,
          .outbox_high_water = 1U,
          .outbox_backpressure = 0U,
          .events_published = 2U,
          .events_processed = 2U,
          .event_backpressure = 0U,
          .event_failures = 0U,
          .event_high_water = 1U,
          .event_current = 0U,
      },
      .pcm = {
          .websocket_start_attempts = 1U,
          .websocket_connections = 1U,
          .websocket_disconnects = 0U,
          .websocket_errors = 0U,
          .protocol_failures = 0U,
          .audio_frames_sent = 12U,
          .audio_frames_dropped = 0U,
          .audio_send_failures = 0U,
          .completion_errors = 0U,
          .uplink_frames_sent = 11U,
          .uplink_frames_discarded = 0U,
          .uplink_send_failures = 0U,
          .uplink_current = 1U,
          .uplink_high_water = 2U,
          .uplink_backpressure = 0U,
          .downlink_frames_accepted = 7U,
          .downlink_frames_dropped = 0U,
          .downlink_receive_failures = 0U,
          .downlink_current = 0U,
          .downlink_high_water = 2U,
          .downlink_backpressure = 0U,
          .playback_submitted = 7U,
          .playback_completed = 6U,
          .playback_flushed = 0U,
          .playback_current = 1U,
          .playback_high_water = 2U,
          .playback_failures = 0U,
      },
  };
  struct iterate_kit_runtime_diagnostics_pump_result result;
  struct iterate_kit_runtime_diagnostics_metrics metrics;
  size_t attempts = 0U;
  const char expected[] =
      "iterate-kit: metrics.system report_seq=1 sample_ms=1203 "
      "control_transport=ready pcm_transport=ready capnweb=0 "
      "heap=238175 min_heap=233147 internal=220000 min_internal=210000 "
      "psram=0 main_stack_headroom=4960 net_stack_headroom=864 "
      "pcm_net_stack_headroom=912 cpu_permille=73 main_cycles=0 "
      "main_max_cycles=1800 net_cycles=0 net_max_cycles=22000 "
      "pcm_net_cycles=0 pcm_net_max_cycles=19000 "
      "net_stack_exhaustions=0 pcm_net_stack_exhaustions=0 "
      "diag_reports_offered=1 diag_reports_emitted=0 "
      "diag_reports_skipped=0 diag_sink_stalls=0 "
      "diag_max_sink_stall_ms=0 diag_format_failures=0 "
      "diag_sink_contract_failures=0\n"
      "iterate-kit: metrics.control report_seq=1 sample_ms=1203 "
      "ws_attempts=1 ws_connections=1 ws_disconnects=0 ws_errors=0 "
      "protocol_failures=0 control_sent=5 control_discarded=0 "
      "inbox_current=0 inbox_high_water=1 inbox_backpressure=0 "
      "outbox_current=0 outbox_high_water=1 outbox_backpressure=0 "
      "events_published=2 events_processed=2 event_backpressure=0 "
      "event_failures=0 event_high_water=1 event_current=0\n"
      "iterate-kit: metrics.pcm report_seq=1 sample_ms=1203 "
      "ws_attempts=1 ws_connections=1 ws_disconnects=0 ws_errors=0 "
      "protocol_failures=0 audio_sent=12 audio_dropped=0 "
      "audio_send_failures=0 completion_errors=0 uplink_sent=11 "
      "uplink_transport_discarded=0 uplink_send_failures=0 "
      "uplink_current=1 uplink_high_water=2 uplink_backpressure=0 "
      "downlink_accepted=7 downlink_dropped=0 "
      "downlink_receive_failures=0 downlink_current=0 "
      "downlink_high_water=2 downlink_backpressure=0 "
      "playback_submitted=7 playback_completed=6 playback_flushed=0 "
      "playback_current=1 playback_high_water=2 playback_failures=0\n";

  assert(
      iterate_kit_runtime_diagnostics_init(
          &diagnostics, &options) == ITERATE_KIT_OK);
  assert(
      iterate_kit_runtime_diagnostics_offer(
          &diagnostics, &snapshot) == ITERATE_KIT_OK);
  do {
    assert(attempts++ < 1000U);
    assert(
        iterate_kit_runtime_diagnostics_pump(
            &diagnostics,
            1203U + attempts,
            512U,
            &result) == ITERATE_KIT_OK);
    assert(result.bytes_written <= 7U);
  } while (!result.report_completed);

  iterate_kit_runtime_diagnostics_metrics(
      &diagnostics, &metrics);
  assert(metrics.reports_offered == 1U);
  assert(metrics.reports_emitted == 1U);
  assert(metrics.reports_skipped == 0U);
  assert(strcmp(sink.bytes, expected) == 0);
}

/*
 * A stalled outer diagnostics sink must not impede audio or network work.
 * Queueing each one-second snapshot would turn observability into minutes of
 * stale FIFO traffic exactly when the sink recovers. Hold the sink at zero
 * progress across nine cadences, then prove that loss is exact and the next
 * emitted cycle delta covers only the newest interval. The recovered report
 * must carry the exporter incident counters itself; a counter available only
 * through a debugger is not remotely observable.
 */
static void stalled_sink_skips_stale_reports_and_recovers_current(void) {
  struct controllable_sink sink = {
      .stalled = true,
  };
  struct iterate_kit_runtime_diagnostics diagnostics;
  const struct iterate_kit_runtime_diagnostics_options options = {
      .write = write_when_unstalled,
      .write_context = &sink,
  };
  struct iterate_kit_runtime_diagnostics_snapshot snapshot = {
      .sampled_at_ms = 1000U,
      .control_transport =
          ITERATE_KIT_RUNTIME_TRANSPORT_READY,
      .pcm_transport = ITERATE_KIT_RUNTIME_TRANSPORT_READY,
      .system = {
          .cpu_permille = 10,
          .main_work_cycles = 100U,
          .control_network_work_cycles = 100U,
          .pcm_network_work_cycles = 100U,
      },
  };
  struct iterate_kit_runtime_diagnostics_pump_result result;
  struct iterate_kit_runtime_diagnostics_metrics metrics;
  uint32_t sequence;

  assert(
      iterate_kit_runtime_diagnostics_init(
          &diagnostics, &options) == ITERATE_KIT_OK);
  assert(
      iterate_kit_runtime_diagnostics_offer(
          &diagnostics, &snapshot) == ITERATE_KIT_OK);
  assert(
      iterate_kit_runtime_diagnostics_pump(
          &diagnostics, 1000U, 512U, &result) ==
      ITERATE_KIT_OK);
  assert(result.sink_stalled);

  for (sequence = 2U; sequence <= 10U; ++sequence) {
    snapshot.sampled_at_ms = sequence * 1000U;
    snapshot.system.main_work_cycles = sequence * 100U;
    snapshot.system.control_network_work_cycles =
        sequence * 100U;
    snapshot.system.pcm_network_work_cycles =
        sequence * 100U;
    assert(
        iterate_kit_runtime_diagnostics_offer(
            &diagnostics, &snapshot) ==
        ITERATE_KIT_BACKPRESSURE);
  }
  iterate_kit_runtime_diagnostics_metrics(
      &diagnostics, &metrics);
  assert(metrics.reports_offered == 10U);
  assert(metrics.reports_emitted == 0U);
  assert(metrics.reports_skipped == 9U);
  assert(metrics.sink_stall_events == 1U);
  assert(metrics.report_pending);

  sink.stalled = false;
  do {
    assert(
        iterate_kit_runtime_diagnostics_pump(
            &diagnostics, 1100U, 2048U, &result) ==
        ITERATE_KIT_OK);
  } while (!result.report_completed);

  snapshot.sampled_at_ms = 11000U;
  snapshot.system.main_work_cycles = 1100U;
  snapshot.system.control_network_work_cycles = 1100U;
  snapshot.system.pcm_network_work_cycles = 1100U;
  assert(
      iterate_kit_runtime_diagnostics_offer(
          &diagnostics, &snapshot) == ITERATE_KIT_OK);
  do {
    assert(
        iterate_kit_runtime_diagnostics_pump(
            &diagnostics, 11001U, 2048U, &result) ==
        ITERATE_KIT_OK);
  } while (!result.report_completed);

  iterate_kit_runtime_diagnostics_metrics(
      &diagnostics, &metrics);
  assert(metrics.reports_offered == 11U);
  assert(metrics.reports_emitted == 2U);
  assert(metrics.reports_skipped == 9U);
  assert(metrics.maximum_sink_stall_ms == 100U);
  assert(
      strstr(
          sink.bytes,
          "metrics.system report_seq=11 sample_ms=11000 "
          "control_transport=ready pcm_transport=ready") !=
      NULL);
  assert(strstr(sink.bytes, "main_cycles=100 ") != NULL);
  assert(
      strstr(
          sink.bytes,
          "diag_reports_offered=11 diag_reports_emitted=1 "
          "diag_reports_skipped=9 diag_sink_stalls=1 "
          "diag_max_sink_stall_ms=100") != NULL);
}

/*
 * ESP32 cycle counters wrap routinely during a useful endurance run. A signed
 * comparison or "current < previous means reset" branch would inject a false
 * zero/huge interval at every wrap and could hide an audio scheduling spike.
 * Seed all three baselines immediately before UINT32_MAX, cross the boundary,
 * and assert the public wire record carries the exact modulo interval.
 */
static void cycle_deltas_survive_u32_wrap(void) {
  struct controllable_sink sink = {0};
  struct iterate_kit_runtime_diagnostics diagnostics;
  const struct iterate_kit_runtime_diagnostics_options options = {
      .write = write_when_unstalled,
      .write_context = &sink,
  };
  struct iterate_kit_runtime_diagnostics_snapshot snapshot = {
      .sampled_at_ms = 1000U,
      .control_transport =
          ITERATE_KIT_RUNTIME_TRANSPORT_READY,
      .pcm_transport = ITERATE_KIT_RUNTIME_TRANSPORT_READY,
      .system = {
          .cpu_permille = 20,
          .main_work_cycles = UINT32_MAX - 500U,
          .control_network_work_cycles = UINT32_MAX - 500U,
          .pcm_network_work_cycles = UINT32_MAX - 500U,
      },
  };
  struct iterate_kit_runtime_diagnostics_pump_result result;

  assert(
      iterate_kit_runtime_diagnostics_init(
          &diagnostics, &options) == ITERATE_KIT_OK);
  assert(
      iterate_kit_runtime_diagnostics_offer(
          &diagnostics, &snapshot) == ITERATE_KIT_OK);
  do {
    assert(
        iterate_kit_runtime_diagnostics_pump(
            &diagnostics, 1000U, 2048U, &result) ==
        ITERATE_KIT_OK);
  } while (!result.report_completed);

  sink.length = 0U;
  sink.bytes[0] = '\0';
  snapshot.sampled_at_ms = 2000U;
  snapshot.system.main_work_cycles = 499U;
  snapshot.system.control_network_work_cycles = 499U;
  snapshot.system.pcm_network_work_cycles = 499U;
  assert(
      iterate_kit_runtime_diagnostics_offer(
          &diagnostics, &snapshot) == ITERATE_KIT_OK);
  do {
    assert(
        iterate_kit_runtime_diagnostics_pump(
            &diagnostics, 2000U, 2048U, &result) ==
        ITERATE_KIT_OK);
  } while (!result.report_completed);

  assert(strstr(sink.bytes, "main_cycles=1000 ") != NULL);
  assert(strstr(sink.bytes, "net_cycles=1000 ") != NULL);
  assert(strstr(sink.bytes, "pcm_net_cycles=1000 ") != NULL);
}

/*
 * A byte budget is the only bound the portable pump can place on target-side
 * console work. A regression that loops internally until a line completes
 * would turn a harmless 16-byte setting into hundreds of bytes on one main
 * pass and delay the next microphone/playback service. Use a greedy sink so
 * the pump—not artificial sink backpressure—is what limits every call, then
 * prove the exact number of passes is the sum of the three line ceilings.
 */
static void byte_budget_binds_each_main_loop_pass(void) {
  enum { byte_budget = 16U };
  struct budget_sink sink = {0};
  struct iterate_kit_runtime_diagnostics diagnostics;
  const struct iterate_kit_runtime_diagnostics_options options = {
      .write = write_greedily,
      .write_context = &sink,
  };
  const struct iterate_kit_runtime_diagnostics_snapshot snapshot = {
      .sampled_at_ms = 1000U,
      .control_transport =
          ITERATE_KIT_RUNTIME_TRANSPORT_CONNECTING,
      .pcm_transport = ITERATE_KIT_RUNTIME_TRANSPORT_IDLE,
      .system = {
          .cpu_permille = -1,
      },
  };
  struct iterate_kit_runtime_diagnostics_pump_result result;
  size_t passes = 0U;
  size_t expected_calls = 0U;
  const char *line = sink.bytes;

  assert(
      iterate_kit_runtime_diagnostics_init(
          &diagnostics, &options) == ITERATE_KIT_OK);
  assert(
      iterate_kit_runtime_diagnostics_offer(
          &diagnostics, &snapshot) == ITERATE_KIT_OK);
  do {
    assert(passes++ < 256U);
    assert(
        iterate_kit_runtime_diagnostics_pump(
            &diagnostics, 1000U, byte_budget, &result) ==
        ITERATE_KIT_OK);
    assert(result.bytes_written > 0U);
    assert(result.bytes_written <= byte_budget);
    assert(sink.calls == passes);
  } while (!result.report_completed);

  for (;;) {
    const char *newline = strchr(line, '\n');
    size_t line_length;
    if (newline == NULL) {
      break;
    }
    line_length = (size_t)(newline - line) + 1U;
    expected_calls +=
        (line_length + byte_budget - 1U) / byte_budget;
    line = newline + 1;
  }
  assert(*line == '\0');
  assert(expected_calls == passes);
  assert(sink.maximum_request == byte_budget);
}

/*
 * Fixed storage is safe only if the proof covers the widest value of every
 * field, including diagnostic self-counters that ordinary tests cannot reach
 * without billions of incidents. Seed one baseline report, then set the
 * caller-owned exporter state to its saturation values solely to exercise the
 * formatting boundary. Exact line lengths make a schema addition fail here
 * before it can become a truncated-but-parseable lie on a device.
 *
 * The sizeof gate is intentionally an upper budget rather than a host ABI
 * equality: pointer/alignment sizes differ from ESP32. The target linker/runtime
 * report supplies the exact device number; this test prevents an unnoticed
 * portable-state jump while remaining valid on both 32- and 64-bit hosts.
 */
static void maximum_width_lines_fit_the_static_ram_budget(void) {
  struct measuring_sink sink = {0};
  struct iterate_kit_runtime_diagnostics diagnostics;
  const struct iterate_kit_runtime_diagnostics_options options = {
      .write = write_and_measure,
      .write_context = &sink,
  };
  struct iterate_kit_runtime_diagnostics_snapshot snapshot = {
      .sampled_at_ms = 0U,
      .control_transport =
          ITERATE_KIT_RUNTIME_TRANSPORT_CONNECTING,
      .pcm_transport =
          ITERATE_KIT_RUNTIME_TRANSPORT_CONNECTING,
      .capnweb_status = INT32_MIN,
  };
  struct iterate_kit_runtime_diagnostics_pump_result result;

  assert(sizeof(diagnostics) <= 1400U);
  assert(
      iterate_kit_runtime_diagnostics_init(
          &diagnostics, &options) == ITERATE_KIT_OK);
  assert(
      iterate_kit_runtime_diagnostics_offer(
          &diagnostics, &snapshot) == ITERATE_KIT_OK);
  do {
    assert(
        iterate_kit_runtime_diagnostics_pump(
            &diagnostics, 0U, sizeof(diagnostics.line), &result) ==
        ITERATE_KIT_OK);
  } while (!result.report_completed);

  sink = (struct measuring_sink){0};
  snapshot.sampled_at_ms = UINT64_MAX;
  memset(&snapshot.system, 0xff, sizeof(snapshot.system));
  memset(&snapshot.control, 0xff, sizeof(snapshot.control));
  memset(&snapshot.pcm, 0xff, sizeof(snapshot.pcm));
  snapshot.system.cpu_permille = INT16_MIN;
  assert(
      iterate_kit_runtime_diagnostics_offer(
          &diagnostics, &snapshot) == ITERATE_KIT_OK);
  diagnostics.active_report_sequence = UINT32_MAX;
  diagnostics.report_metrics =
      (struct iterate_kit_runtime_diagnostics_metrics){
          .reports_offered = UINT32_MAX,
          .reports_emitted = UINT32_MAX,
          .reports_skipped = UINT32_MAX,
          .sink_stall_events = UINT32_MAX,
          .format_failures = UINT32_MAX,
          .sink_contract_failures = UINT32_MAX,
          .maximum_sink_stall_ms = UINT64_MAX,
          .report_pending = true,
      };

  assert(
      iterate_kit_runtime_diagnostics_pump(
          &diagnostics, UINT64_MAX, sizeof(diagnostics.line), &result) ==
      ITERATE_KIT_OK);
  assert(result.bytes_written == 830U);
  assert(
      iterate_kit_runtime_diagnostics_pump(
          &diagnostics, UINT64_MAX, sizeof(diagnostics.line), &result) ==
      ITERATE_KIT_OK);
  assert(result.bytes_written == 594U);
  assert(
      iterate_kit_runtime_diagnostics_pump(
          &diagnostics, UINT64_MAX, sizeof(diagnostics.line), &result) ==
      ITERATE_KIT_OK);
  assert(result.bytes_written == 851U);
  assert(result.report_completed);
  assert(sink.calls == 3U);
  assert(
      sink.call_lengths[2] + 1U <
      ITERATE_KIT_RUNTIME_DIAGNOSTICS_LINE_CAPACITY);
}

/*
 * An impossible transport state represents the same local release-defect path
 * as a schema that no longer fits its fixed line. Inject it only after offer()
 * validation so the formatter must abandon exactly one report, expose the
 * classified incident, and accept a clean next snapshot. Retrying the broken
 * report forever would consume every 10 ms owner pass; silently truncating it
 * could produce a parseable but false health record.
 */
static void format_failure_abandons_once_and_recovers(void) {
  struct controllable_sink sink = {0};
  struct iterate_kit_runtime_diagnostics diagnostics;
  const struct iterate_kit_runtime_diagnostics_options options = {
      .write = write_when_unstalled,
      .write_context = &sink,
  };
  struct iterate_kit_runtime_diagnostics_snapshot snapshot = {
      .sampled_at_ms = 1000U,
      .control_transport =
          ITERATE_KIT_RUNTIME_TRANSPORT_CONNECTING,
      .pcm_transport = ITERATE_KIT_RUNTIME_TRANSPORT_IDLE,
      .system = {
          .cpu_permille = -1,
      },
  };
  struct iterate_kit_runtime_diagnostics_pump_result result;
  struct iterate_kit_runtime_diagnostics_metrics metrics;

  assert(
      iterate_kit_runtime_diagnostics_init(
          &diagnostics, &options) == ITERATE_KIT_OK);
  assert(
      iterate_kit_runtime_diagnostics_offer(
          &diagnostics, &snapshot) == ITERATE_KIT_OK);
  diagnostics.report.control_transport =
      (enum iterate_kit_runtime_transport_state)UINT32_MAX;
  assert(
      iterate_kit_runtime_diagnostics_pump(
          &diagnostics, 1000U, 64U, &result) ==
      ITERATE_KIT_INVALID_ARGUMENT);
  iterate_kit_runtime_diagnostics_metrics(
      &diagnostics, &metrics);
  assert(metrics.format_failures == 1U);
  assert(metrics.reports_skipped == 1U);
  assert(!metrics.report_pending);
  assert(sink.length == 0U);

  snapshot.sampled_at_ms = 2000U;
  assert(
      iterate_kit_runtime_diagnostics_offer(
          &diagnostics, &snapshot) == ITERATE_KIT_OK);
  do {
    assert(
        iterate_kit_runtime_diagnostics_pump(
            &diagnostics, 2000U, 2048U, &result) ==
        ITERATE_KIT_OK);
  } while (!result.report_completed);
  assert(
      strstr(
          sink.bytes,
          "diag_format_failures=1 "
          "diag_sink_contract_failures=0") != NULL);
}

/*
 * A platform adapter returning more bytes than requested is a memory-safety
 * contract breach: trusting it would advance beyond the fixed line. Make the
 * first call lie, verify no suffix is read or retried, then prove a later
 * report is clean and carries the incident. This keeps diagnostics faults
 * bounded and observable instead of letting them corrupt the audio runtime.
 */
static void lying_sink_is_classified_and_next_report_is_clean(void) {
  struct lying_sink sink = {
      .lie_once = true,
  };
  struct iterate_kit_runtime_diagnostics diagnostics;
  const struct iterate_kit_runtime_diagnostics_options options = {
      .write = lie_then_write,
      .write_context = &sink,
  };
  struct iterate_kit_runtime_diagnostics_snapshot snapshot = {
      .sampled_at_ms = 1000U,
      .control_transport =
          ITERATE_KIT_RUNTIME_TRANSPORT_CONNECTING,
      .pcm_transport = ITERATE_KIT_RUNTIME_TRANSPORT_IDLE,
      .system = {
          .cpu_permille = -1,
      },
  };
  struct iterate_kit_runtime_diagnostics_pump_result result;
  struct iterate_kit_runtime_diagnostics_metrics metrics;

  assert(
      iterate_kit_runtime_diagnostics_init(
          &diagnostics, &options) == ITERATE_KIT_OK);
  assert(
      iterate_kit_runtime_diagnostics_offer(
          &diagnostics, &snapshot) == ITERATE_KIT_OK);
  assert(
      iterate_kit_runtime_diagnostics_pump(
          &diagnostics, 1000U, 64U, &result) ==
      ITERATE_KIT_STATE_ERROR);
  iterate_kit_runtime_diagnostics_metrics(
      &diagnostics, &metrics);
  assert(metrics.sink_contract_failures == 1U);
  assert(metrics.reports_skipped == 1U);
  assert(!metrics.report_pending);
  assert(sink.length == 0U);

  snapshot.sampled_at_ms = 2000U;
  assert(
      iterate_kit_runtime_diagnostics_offer(
          &diagnostics, &snapshot) == ITERATE_KIT_OK);
  do {
    assert(
        iterate_kit_runtime_diagnostics_pump(
            &diagnostics, 2000U, 2048U, &result) ==
        ITERATE_KIT_OK);
  } while (!result.report_completed);
  assert(
      strstr(
          sink.bytes,
          "diag_format_failures=0 "
          "diag_sink_contract_failures=1") != NULL);
}

int main(void) {
  short_writes_preserve_complete_metric_lines();
  stalled_sink_skips_stale_reports_and_recovers_current();
  cycle_deltas_survive_u32_wrap();
  byte_budget_binds_each_main_loop_pass();
  maximum_width_lines_fit_the_static_ram_budget();
  format_failure_abandons_once_and_recovers();
  lying_sink_is_classified_and_next_report_is_clean();
  return 0;
}
