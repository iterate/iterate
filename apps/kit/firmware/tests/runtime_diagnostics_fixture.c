#include "iterate/kit/runtime_diagnostics.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

static size_t write_stdout(
    void *context, const char *bytes, size_t length) {
  (void)context;
  return fwrite(bytes, 1U, length, stdout);
}

static bool emit_report(
    struct iterate_kit_runtime_diagnostics *diagnostics,
    const struct iterate_kit_runtime_diagnostics_snapshot *snapshot) {
  struct iterate_kit_runtime_diagnostics_pump_result result;
  size_t pass = 0U;
  if (iterate_kit_runtime_diagnostics_offer(
          diagnostics, snapshot) != ITERATE_KIT_OK) {
    return false;
  }
  do {
    /*
     * The fixture uses the same bounded cadence as a device owner loop rather
     * than bypassing pump state to print private buffers. That makes the
     * TypeScript test an end-to-end contract over the public C exporter seam.
     */
    if (pass++ >= 32U ||
        iterate_kit_runtime_diagnostics_pump(
            diagnostics,
            snapshot->sampled_at_ms + pass,
            ITERATE_KIT_RUNTIME_DIAGNOSTICS_LINE_CAPACITY,
            &result) != ITERATE_KIT_OK ||
        result.sink_stalled) {
      return false;
    }
  } while (!result.report_completed);
  return true;
}

int main(void) {
  struct iterate_kit_runtime_diagnostics diagnostics;
  const struct iterate_kit_runtime_diagnostics_options options = {
      .write = write_stdout,
      .write_context = NULL,
  };
  struct iterate_kit_runtime_diagnostics_snapshot snapshot = {
      .sampled_at_ms = 1203U,
      .control_transport =
          ITERATE_KIT_RUNTIME_TRANSPORT_CONNECTING,
      .pcm_transport = ITERATE_KIT_RUNTIME_TRANSPORT_IDLE,
      .capnweb_status = 0,
      .system = {
          .free_heap_bytes = 238175U,
          .minimum_free_heap_bytes = 233147U,
          .free_internal_heap_bytes = 220000U,
          .minimum_free_internal_heap_bytes = 210000U,
          .free_psram_bytes = 0U,
          .main_stack_headroom_bytes = 4960U,
          .control_network_stack_headroom_bytes = 864U,
          .pcm_network_stack_headroom_bytes = 0U,
          .cpu_permille = -1,
          .main_work_cycles = 1000U,
          .main_max_work_cycles = 1800U,
          .control_network_work_cycles = 1000U,
          .control_network_max_work_cycles = 22000U,
          .pcm_network_work_cycles = 0U,
          .pcm_network_max_work_cycles = 0U,
      },
  };

  if (iterate_kit_runtime_diagnostics_init(
          &diagnostics, &options) != ITERATE_KIT_OK ||
      !emit_report(&diagnostics, &snapshot)) {
    return 1;
  }

  /*
   * The second observation is deliberately expressed as cumulative hardware
   * counters. The formatter must emit independent one-second deltas so the
   * host health threshold does not reject normal uint32 wrap or long uptime.
   */
  snapshot.sampled_at_ms = 2203U;
  snapshot.control_transport = ITERATE_KIT_RUNTIME_TRANSPORT_READY;
  snapshot.pcm_transport = ITERATE_KIT_RUNTIME_TRANSPORT_READY;
  snapshot.system.cpu_permille = 73;
  snapshot.system.pcm_network_stack_headroom_bytes = 912U;
  snapshot.system.main_work_cycles = 55000U;
  snapshot.system.control_network_work_cycles = 92000U;
  snapshot.system.pcm_network_work_cycles = 81000U;
  snapshot.system.pcm_network_max_work_cycles = 19000U;
  if (!emit_report(&diagnostics, &snapshot) ||
      fflush(stdout) != 0) {
    return 1;
  }
  return 0;
}
