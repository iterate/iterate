#ifndef ITERATE_KIT_PLATFORMS_STACKCHAN_AVATAR_H
#define ITERATE_KIT_PLATFORMS_STACKCHAN_AVATAR_H

#include "esp_err.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Diagnostics for StackChan's deliberately lossy visual sidecar.
 *
 * Audio is the authoritative realtime workload. The avatar therefore owns a
 * one-item latest-state mailbox rather than a FIFO: `mailbox_overwrites` and
 * `analyzer_sequence_gaps` mean visual detail was discarded so rendering
 * could jump to current physical playout. Neither counter is an audio loss.
 * Any audio loss remains owned by the CoreS3 audio/PCM metrics instead.
 */
struct iterate_kit_stackchan_avatar_metrics {
  bool ready;
  uint32_t static_bytes;
  uint32_t framebuffer_bytes;
  uint32_t playout_observations;
  uint32_t malformed_observations;
  uint32_t mailbox_overwrites;
  uint32_t mailbox_failures;
  uint32_t analyzer_frames;
  uint32_t analyzer_sequence_gaps;
  uint32_t mouth_open_rendered_frames;
  uint32_t snapshot_races;
  uint32_t rendered_frames;
  uint32_t render_failures;
  uint32_t display_transfers;
  uint32_t display_transfer_failures;
  uint32_t display_transfer_timeouts;
  uint32_t last_handoff_delay_us;
  uint32_t maximum_handoff_delay_us;
  uint32_t last_analyzer_us;
  uint32_t maximum_analyzer_us;
  uint32_t last_render_us;
  uint32_t maximum_render_us;
  uint32_t last_display_transfer_us;
  uint32_t maximum_display_transfer_us;
  uint32_t analyzer_stack_minimum_free_bytes;
  uint32_t physical_playout_sample_clock;
  uint32_t current_avatar_index;
};

/**
 * Starts StackChan's single physical display owner and visual analyzer.
 *
 * Startup allocates one 160x120 RGB565 DMA framebuffer in internal memory.
 * ESP32-S3 SPI cannot DMA from PSRAM, so this permanent cost avoids a hidden
 * per-transfer bounce allocation. Steady-state playout observation, PCM
 * analysis, rendering, and direct LCD transfer allocate nothing. This is a
 * physical-board singleton because the CoreS3 panel is a singleton;
 * presenting it as an instantiable object would promise hardware concurrency
 * the board cannot provide.
 */
esp_err_t iterate_kit_stackchan_avatar_start(void);

/**
 * Accepts one 128-sample frame which has completed speaker DMA.
 *
 * This function runs in I2S interrupt context. It performs one fixed-size copy
 * into a statically allocated, length-one FreeRTOS mailbox, never allocates,
 * never logs, and never waits. It returns true only when the ISR should yield
 * to a task it woke. Do not call it with WebSocket-arrival PCM: doing so makes
 * the mouth lead whenever software/network buffering changes.
 */
bool iterate_kit_stackchan_avatar_observe_playout(
    uint32_t sequence,
    uint64_t completed_at_us,
    const int16_t *samples,
    size_t sample_count,
    void *context);

void iterate_kit_stackchan_avatar_metrics_snapshot(
    struct iterate_kit_stackchan_avatar_metrics *snapshot);

#ifdef __cplusplus
}
#endif

#endif
