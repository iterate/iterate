#include "iterate/kit/runtime_diagnostics.h"

#include <inttypes.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>

enum runtime_diagnostics_family {
  RUNTIME_DIAGNOSTICS_SYSTEM = 0,
  RUNTIME_DIAGNOSTICS_CONTROL,
  RUNTIME_DIAGNOSTICS_PCM,
  RUNTIME_DIAGNOSTICS_FAMILY_COUNT,
};

static void saturating_increment(uint32_t *value) {
  if (*value != UINT32_MAX) {
    ++*value;
  }
}

static const char *transport_state_name(
    enum iterate_kit_runtime_transport_state state) {
  switch (state) {
    case ITERATE_KIT_RUNTIME_TRANSPORT_IDLE:
      return "idle";
    case ITERATE_KIT_RUNTIME_TRANSPORT_CONNECTING:
      return "connecting";
    case ITERATE_KIT_RUNTIME_TRANSPORT_READY:
      return "ready";
    case ITERATE_KIT_RUNTIME_TRANSPORT_FAILED:
      return "failed";
    case ITERATE_KIT_RUNTIME_TRANSPORT_STOPPED:
      return "stopped";
  }
  return NULL;
}

static uint32_t cycle_delta(
    bool has_baseline, uint32_t current, uint32_t previous) {
  if (!has_baseline) {
    return 0U;
  }
  /*
   * Unsigned subtraction is the intended modulo-2^32 operation. Hardware
   * cycle accumulators wrap in roughly seconds to minutes depending on clock
   * rate; treating current < previous as an error would create routine false
   * failures on an otherwise healthy long run.
   */
  return current - previous;
}

static enum iterate_kit_status format_system(
    struct iterate_kit_runtime_diagnostics *diagnostics) {
  const struct iterate_kit_runtime_diagnostics_snapshot *report =
      &diagnostics->report;
  const char *control =
      transport_state_name(report->control_transport);
  const char *pcm = transport_state_name(report->pcm_transport);
  int length;
  if (control == NULL || pcm == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  length = snprintf(
      diagnostics->line,
      sizeof(diagnostics->line),
      "iterate-kit: metrics.system report_seq=%" PRIu32
      " sample_ms=%" PRIu64
      " control_transport=%s pcm_transport=%s capnweb=%" PRId32
      " heap=%" PRIu32 " min_heap=%" PRIu32
      " internal=%" PRIu32 " min_internal=%" PRIu32
      " psram=%" PRIu32
      " main_stack_headroom=%" PRIu32
      " net_stack_headroom=%" PRIu32
      " pcm_net_stack_headroom=%" PRIu32
      " cpu_permille=%" PRId32
      " main_cycles=%" PRIu32
      " main_max_cycles=%" PRIu32
      " net_cycles=%" PRIu32
      " net_max_cycles=%" PRIu32
      " pcm_net_cycles=%" PRIu32
      " pcm_net_max_cycles=%" PRIu32
      " net_stack_exhaustions=%" PRIu32
      " pcm_net_stack_exhaustions=%" PRIu32
      " diag_reports_offered=%" PRIu32
      " diag_reports_emitted=%" PRIu32
      " diag_reports_skipped=%" PRIu32
      " diag_sink_stalls=%" PRIu32
      " diag_max_sink_stall_ms=%" PRIu64
      " diag_format_failures=%" PRIu32
      " diag_sink_contract_failures=%" PRIu32 "\n",
      diagnostics->active_report_sequence,
      report->sampled_at_ms,
      control,
      pcm,
      report->capnweb_status,
      report->system.free_heap_bytes,
      report->system.minimum_free_heap_bytes,
      report->system.free_internal_heap_bytes,
      report->system.minimum_free_internal_heap_bytes,
      report->system.free_psram_bytes,
      report->system.main_stack_headroom_bytes,
      report->system.control_network_stack_headroom_bytes,
      report->system.pcm_network_stack_headroom_bytes,
      (int32_t)report->system.cpu_permille,
      report->system.main_work_cycles,
      report->system.main_max_work_cycles,
      report->system.control_network_work_cycles,
      report->system.control_network_max_work_cycles,
      report->system.pcm_network_work_cycles,
      report->system.pcm_network_max_work_cycles,
      report->system.control_network_stack_exhaustions,
      report->system.pcm_network_stack_exhaustions,
      diagnostics->report_metrics.reports_offered,
      diagnostics->report_metrics.reports_emitted,
      diagnostics->report_metrics.reports_skipped,
      diagnostics->report_metrics.sink_stall_events,
      diagnostics->report_metrics.maximum_sink_stall_ms,
      diagnostics->report_metrics.format_failures,
      diagnostics->report_metrics.sink_contract_failures);
  if (length < 0 ||
      (size_t)length >= sizeof(diagnostics->line)) {
    return ITERATE_KIT_LIMIT;
  }
  diagnostics->line_length = (size_t)length;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status format_control(
    struct iterate_kit_runtime_diagnostics *diagnostics) {
  const struct iterate_kit_runtime_diagnostics_snapshot *report =
      &diagnostics->report;
  int length = snprintf(
      diagnostics->line,
      sizeof(diagnostics->line),
      "iterate-kit: metrics.control report_seq=%" PRIu32
      " sample_ms=%" PRIu64
      " ws_attempts=%" PRIu32
      " ws_connections=%" PRIu32
      " ws_disconnects=%" PRIu32
      " ws_errors=%" PRIu32
      " protocol_failures=%" PRIu32
      " control_sent=%" PRIu32
      " control_discarded=%" PRIu32
      " inbox_current=%" PRIu32
      " inbox_high_water=%" PRIu32
      " inbox_backpressure=%" PRIu32
      " outbox_current=%" PRIu32
      " outbox_high_water=%" PRIu32
      " outbox_backpressure=%" PRIu32
      " events_published=%" PRIu32
      " events_processed=%" PRIu32
      " event_backpressure=%" PRIu32
      " event_failures=%" PRIu32
      " event_high_water=%" PRIu32
      " event_current=%" PRIu32 "\n",
      diagnostics->active_report_sequence,
      report->sampled_at_ms,
      report->control.websocket_start_attempts,
      report->control.websocket_connections,
      report->control.websocket_disconnects,
      report->control.websocket_errors,
      report->control.protocol_failures,
      report->control.messages_sent,
      report->control.messages_discarded,
      report->control.inbox_current,
      report->control.inbox_high_water,
      report->control.inbox_backpressure,
      report->control.outbox_current,
      report->control.outbox_high_water,
      report->control.outbox_backpressure,
      report->control.events_published,
      report->control.events_processed,
      report->control.event_backpressure,
      report->control.event_failures,
      report->control.event_high_water,
      report->control.event_current);
  if (length < 0 ||
      (size_t)length >= sizeof(diagnostics->line)) {
    return ITERATE_KIT_LIMIT;
  }
  diagnostics->line_length = (size_t)length;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status format_pcm(
    struct iterate_kit_runtime_diagnostics *diagnostics) {
  const struct iterate_kit_runtime_diagnostics_snapshot *report =
      &diagnostics->report;
  int length = snprintf(
      diagnostics->line,
      sizeof(diagnostics->line),
      "iterate-kit: metrics.pcm report_seq=%" PRIu32
      " sample_ms=%" PRIu64
      " ws_attempts=%" PRIu32
      " ws_connections=%" PRIu32
      " ws_disconnects=%" PRIu32
      " ws_errors=%" PRIu32
      " protocol_failures=%" PRIu32
      " audio_sent=%" PRIu32
      " audio_dropped=%" PRIu32
      " audio_send_failures=%" PRIu32
      " completion_errors=%" PRIu32
      " uplink_sent=%" PRIu32
      " uplink_transport_discarded=%" PRIu32
      " uplink_send_failures=%" PRIu32
      " uplink_current=%" PRIu32
      " uplink_high_water=%" PRIu32
      " uplink_backpressure=%" PRIu32
      " downlink_accepted=%" PRIu32
      " downlink_dropped=%" PRIu32
      " downlink_receive_failures=%" PRIu32
      " downlink_current=%" PRIu32
      " downlink_high_water=%" PRIu32
      " downlink_backpressure=%" PRIu32
      " playback_submitted=%" PRIu32
      " playback_completed=%" PRIu32
      " playback_flushed=%" PRIu32
      " playback_current=%" PRIu32
      " playback_high_water=%" PRIu32
      " playback_failures=%" PRIu32 "\n",
      diagnostics->active_report_sequence,
      report->sampled_at_ms,
      report->pcm.websocket_start_attempts,
      report->pcm.websocket_connections,
      report->pcm.websocket_disconnects,
      report->pcm.websocket_errors,
      report->pcm.protocol_failures,
      report->pcm.audio_frames_sent,
      report->pcm.audio_frames_dropped,
      report->pcm.audio_send_failures,
      report->pcm.completion_errors,
      report->pcm.uplink_frames_sent,
      report->pcm.uplink_frames_discarded,
      report->pcm.uplink_send_failures,
      report->pcm.uplink_current,
      report->pcm.uplink_high_water,
      report->pcm.uplink_backpressure,
      report->pcm.downlink_frames_accepted,
      report->pcm.downlink_frames_dropped,
      report->pcm.downlink_receive_failures,
      report->pcm.downlink_current,
      report->pcm.downlink_high_water,
      report->pcm.downlink_backpressure,
      report->pcm.playback_submitted,
      report->pcm.playback_completed,
      report->pcm.playback_flushed,
      report->pcm.playback_current,
      report->pcm.playback_high_water,
      report->pcm.playback_failures);
  if (length < 0 ||
      (size_t)length >= sizeof(diagnostics->line)) {
    return ITERATE_KIT_LIMIT;
  }
  diagnostics->line_length = (size_t)length;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status format_next_line(
    struct iterate_kit_runtime_diagnostics *diagnostics) {
  enum iterate_kit_status status;
  switch ((enum runtime_diagnostics_family)
              diagnostics->next_family) {
    case RUNTIME_DIAGNOSTICS_SYSTEM:
      status = format_system(diagnostics);
      break;
    case RUNTIME_DIAGNOSTICS_CONTROL:
      status = format_control(diagnostics);
      break;
    case RUNTIME_DIAGNOSTICS_PCM:
      status = format_pcm(diagnostics);
      break;
    case RUNTIME_DIAGNOSTICS_FAMILY_COUNT:
      return ITERATE_KIT_STATE_ERROR;
    default:
      /*
       * `next_family` is stored as an integer in public runtime state, so C
       * cannot prove that it still names an enum member. Treat corruption as a
       * classified state failure; guessing a formatter here could read the
       * wrong snapshot fields and make the diagnostic itself misleading.
       */
      return ITERATE_KIT_STATE_ERROR;
  }
  if (status != ITERATE_KIT_OK) {
    /*
     * A fixed schema exceeding fixed storage is a local release defect, not
     * transient backpressure. Abandon the report once and expose the exact
     * failure instead of retrying the same impossible format every 10 ms.
     */
    saturating_increment(&diagnostics->format_failures);
    saturating_increment(&diagnostics->reports_skipped);
    diagnostics->report_pending = false;
    diagnostics->line_length = 0U;
    diagnostics->line_offset = 0U;
  }
  return status;
}

static void note_stall_duration(
    struct iterate_kit_runtime_diagnostics *diagnostics,
    uint64_t now_ms) {
  uint64_t duration;
  if (!diagnostics->sink_stalled ||
      now_ms < diagnostics->stall_started_at_ms) {
    return;
  }
  duration = now_ms - diagnostics->stall_started_at_ms;
  if (duration > diagnostics->maximum_sink_stall_ms) {
    diagnostics->maximum_sink_stall_ms = duration;
  }
}

enum iterate_kit_status iterate_kit_runtime_diagnostics_init(
    struct iterate_kit_runtime_diagnostics *diagnostics,
    const struct iterate_kit_runtime_diagnostics_options *options) {
  if (diagnostics == NULL ||
      options == NULL ||
      options->write == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(diagnostics, 0, sizeof(*diagnostics));
  diagnostics->options = *options;
  diagnostics->initialized = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_runtime_diagnostics_offer(
    struct iterate_kit_runtime_diagnostics *diagnostics,
    const struct iterate_kit_runtime_diagnostics_snapshot *snapshot) {
  uint32_t main_delta;
  uint32_t control_delta;
  uint32_t pcm_delta;
  if (diagnostics == NULL ||
      !diagnostics->initialized ||
      snapshot == NULL ||
      transport_state_name(snapshot->control_transport) == NULL ||
      transport_state_name(snapshot->pcm_transport) == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }

  main_delta = cycle_delta(
      diagnostics->has_cycle_baseline,
      snapshot->system.main_work_cycles,
      diagnostics->previous_main_work_cycles);
  control_delta = cycle_delta(
      diagnostics->has_cycle_baseline,
      snapshot->system.control_network_work_cycles,
      diagnostics->previous_control_network_work_cycles);
  pcm_delta = cycle_delta(
      diagnostics->has_cycle_baseline,
      snapshot->system.pcm_network_work_cycles,
      diagnostics->previous_pcm_network_work_cycles);
  diagnostics->previous_main_work_cycles =
      snapshot->system.main_work_cycles;
  diagnostics->previous_control_network_work_cycles =
      snapshot->system.control_network_work_cycles;
  diagnostics->previous_pcm_network_work_cycles =
      snapshot->system.pcm_network_work_cycles;
  diagnostics->has_cycle_baseline = true;
  saturating_increment(&diagnostics->reports_offered);

  if (diagnostics->report_pending) {
    /*
     * Realtime diagnostics describe now, not a FIFO history. Retrying this
     * skipped observation after the sink recovers would manufacture a stale
     * backlog and compete with current PCM work. Advancing the baselines above
     * means the next accepted report still covers only its recent cadence.
     */
    saturating_increment(&diagnostics->reports_skipped);
    return ITERATE_KIT_BACKPRESSURE;
  }

  diagnostics->report = *snapshot;
  diagnostics->report.system.main_work_cycles = main_delta;
  diagnostics->report.system.control_network_work_cycles =
      control_delta;
  diagnostics->report.system.pcm_network_work_cycles = pcm_delta;
  diagnostics->active_report_sequence =
      diagnostics->reports_offered;
  /*
   * Exporter health is captured at the same boundary as device health. Reading
   * live counters while a line is written across several passes could combine
   * different cadences in one record and make exact skip accounting
   * unreplayable.
   */
  diagnostics->report_metrics =
      (struct iterate_kit_runtime_diagnostics_metrics){
          .reports_offered = diagnostics->reports_offered,
          .reports_emitted = diagnostics->reports_emitted,
          .reports_skipped = diagnostics->reports_skipped,
          .sink_stall_events = diagnostics->sink_stall_events,
          .format_failures = diagnostics->format_failures,
          .sink_contract_failures =
              diagnostics->sink_contract_failures,
          .maximum_sink_stall_ms =
              diagnostics->maximum_sink_stall_ms,
          .report_pending = true,
      };
  diagnostics->next_family = RUNTIME_DIAGNOSTICS_SYSTEM;
  diagnostics->line_length = 0U;
  diagnostics->line_offset = 0U;
  diagnostics->report_pending = true;
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_runtime_diagnostics_pump(
    struct iterate_kit_runtime_diagnostics *diagnostics,
    uint64_t now_ms,
    size_t byte_budget,
    struct iterate_kit_runtime_diagnostics_pump_result *result) {
  size_t remaining;
  size_t requested;
  size_t accepted;
  enum iterate_kit_status status;
  if (diagnostics == NULL ||
      !diagnostics->initialized ||
      byte_budget == 0U ||
      result == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(result, 0, sizeof(*result));
  if (!diagnostics->report_pending) {
    return ITERATE_KIT_OK;
  }
  if (diagnostics->line_length == 0U) {
    status = format_next_line(diagnostics);
    if (status != ITERATE_KIT_OK) {
      return status;
    }
  }

  remaining =
      diagnostics->line_length - diagnostics->line_offset;
  requested = remaining < byte_budget ? remaining : byte_budget;
  accepted = diagnostics->options.write(
      diagnostics->options.write_context,
      diagnostics->line + diagnostics->line_offset,
      requested);
  if (accepted > requested) {
    /*
     * Trusting an impossible sink count would advance beyond the line buffer
     * and turn one adapter defect into memory corruption. Drop the bounded
     * report and require the outer layer to surface the classified failure.
     */
    saturating_increment(
        &diagnostics->sink_contract_failures);
    saturating_increment(&diagnostics->reports_skipped);
    diagnostics->report_pending = false;
    diagnostics->line_length = 0U;
    diagnostics->line_offset = 0U;
    return ITERATE_KIT_STATE_ERROR;
  }
  if (accepted == 0U) {
    if (!diagnostics->sink_stalled) {
      diagnostics->sink_stalled = true;
      diagnostics->stall_started_at_ms = now_ms;
      saturating_increment(&diagnostics->sink_stall_events);
    }
    note_stall_duration(diagnostics, now_ms);
    result->sink_stalled = true;
    return ITERATE_KIT_OK;
  }

  note_stall_duration(diagnostics, now_ms);
  diagnostics->sink_stalled = false;
  diagnostics->line_offset += accepted;
  result->bytes_written = accepted;
  if (diagnostics->line_offset != diagnostics->line_length) {
    return ITERATE_KIT_OK;
  }

  diagnostics->line_offset = 0U;
  diagnostics->line_length = 0U;
  ++diagnostics->next_family;
  if (diagnostics->next_family !=
      RUNTIME_DIAGNOSTICS_FAMILY_COUNT) {
    return ITERATE_KIT_OK;
  }

  diagnostics->report_pending = false;
  saturating_increment(&diagnostics->reports_emitted);
  result->report_completed = true;
  return ITERATE_KIT_OK;
}

void iterate_kit_runtime_diagnostics_metrics(
    const struct iterate_kit_runtime_diagnostics *diagnostics,
    struct iterate_kit_runtime_diagnostics_metrics *metrics) {
  if (metrics == NULL) {
    return;
  }
  memset(metrics, 0, sizeof(*metrics));
  if (diagnostics == NULL || !diagnostics->initialized) {
    return;
  }
  metrics->reports_offered = diagnostics->reports_offered;
  metrics->reports_emitted = diagnostics->reports_emitted;
  metrics->reports_skipped = diagnostics->reports_skipped;
  metrics->sink_stall_events = diagnostics->sink_stall_events;
  metrics->format_failures = diagnostics->format_failures;
  metrics->sink_contract_failures =
      diagnostics->sink_contract_failures;
  metrics->maximum_sink_stall_ms =
      diagnostics->maximum_sink_stall_ms;
  metrics->report_pending = diagnostics->report_pending;
}
