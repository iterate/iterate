#ifndef ITERATE_KIT_PLATFORMS_STACKCHAN_AVATAR_H
#define ITERATE_KIT_PLATFORMS_STACKCHAN_AVATAR_H

#include "iterate/kit/conversation_lights.h"

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
  uint32_t input_stack_minimum_free_bytes;
  uint32_t physical_playout_sample_clock;
  uint32_t current_avatar_index;
  uint32_t status_updates;
  uint32_t status_overwrites;
  uint32_t touch_samples;
  uint32_t touch_read_failures;
  uint32_t touch_taps;
  uint32_t face_button_samples;
  uint32_t face_button_read_failures;
  uint32_t face_button_boot_events_discarded;
  uint32_t face_button_short_clicks;
  uint32_t face_button_long_or_ambiguous_events;
  uint32_t last_input_sample_interval_us;
  uint32_t maximum_input_sample_interval_us;
};

/**
 * Starts StackChan's single physical display owner and visual analyzer.
 *
 * Startup allocates one 160x120 RGB565 source surface and one bounded 320x16
 * scale/DMA strip in internal memory. ESP32-S3 SPI cannot DMA from PSRAM, so
 * this permanent cost avoids a hidden per-transfer bounce allocation without
 * paying for a 153.6 KiB full-screen buffer. Steady-state input polling,
 * playout observation, analysis, rendering, and direct LCD transfer allocate
 * nothing. This is a physical-board singleton because the CoreS3 panel and
 * PMIC bus are singletons; presenting it as an instantiable object would
 * promise hardware concurrency the board cannot provide.
 */
esp_err_t iterate_kit_stackchan_avatar_start(void);

/**
 * Requests an exact compiled sprite-set slug from the control-plane owner.
 *
 * The Cap'n Web task must not mutate the registry while the low-priority
 * display task is rendering it. This call therefore validates the immutable
 * catalogue and publishes one latest-only selection; it never allocates,
 * waits for SPI, or touches the framebuffer. Success means the request was
 * admitted, and the display owner applies it within one 66 ms visual tick.
 * Several requests in that interval deliberately coalesce to the newest one.
 */
esp_err_t iterate_kit_stackchan_avatar_request_sprite_set(
    const char *slug, size_t slug_length);

/**
 * Publishes the newest semantic conversation state to the display owner.
 *
 * This is a latest-state handoff rather than an event FIFO.  A transport can
 * move through CONNECTING and READY faster than the 15 Hz panel budget; only
 * the current truth is useful on screen.  The call never waits for rendering,
 * SPI, or LCD DMA and therefore remains safe in the cooperative
 * control-plane loop beside the WebSocket owners.
 */
esp_err_t iterate_kit_stackchan_avatar_request_status(
    const struct iterate_kit_conversation_visual_state *status);

/**
 * Reports whether physical speaker DMA has carried audible PCM recently.
 *
 * The body LEDs and LCD headline must use the same hardware-owned fact. A
 * provider event or received WebSocket frame is too early and would present
 * speaking while audio still waits downstream. The returned peak is coarse
 * presentation state only and never feeds AEC, VAD, or flow control.
 */
uint32_t iterate_kit_stackchan_avatar_speaker_status_peak(void);

/**
 * Consumes one whole-screen tap, if one is pending.
 *
 * Coordinates are deliberately absent: every coherent press/release anywhere
 * on the panel means start/end call. The dedicated input owner counts taps so
 * a quick start/end pair cannot collapse into one latest-state update. This
 * consumer is constant-time and never touches the shared I2C bus.
 */
bool iterate_kit_stackchan_avatar_take_call_touch_tap(void);

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

/**
 * Whether the panel is still being driven.
 *
 * A BLACK SCREEN IS A LATCH, NOT A CRASH. Four paths switch the visual sidecar
 * off — a failed transfer, a transfer that timed out, and two more — and that
 * is the correct bounded policy, because after a DMA timeout the buffer's
 * ownership is unknowable and audio must keep running. What was missing is any
 * way to ASK: the board went dark, its LEDs stayed green, its face frames kept
 * counting up, and nothing it published said the display had been switched off.
 */
bool iterate_kit_stackchan_avatar_display_active(void);

#ifdef __cplusplus
}
#endif

#endif
