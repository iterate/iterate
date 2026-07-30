#include "iterate/kit/pcm_websocket.h"

#include <stdint.h>

/*
 * Protocol v1 intentionally has almost no device-side negotiation: one binary
 * WebSocket message is exactly 20 ms of mono 16 kHz signed PCM16LE. Matching a
 * provider-friendly format avoids resampling, clipping, packet headers, and
 * variable allocation on the ESP32 hot path. Timing, interruption, and
 * diagnostics travel outside the PCM payload.
 *
 * These helpers still calculate from an explicit shape so host tests can
 * reject overflow and so a future version can add a separately negotiated
 * format without quietly changing v1. They never allocate, copy, resample, or
 * retain a frame. A failed size calculation clears the caller's output before
 * validation so stale lengths cannot drive a later allocation or memcpy.
 */

enum iterate_kit_status iterate_kit_pcm_websocket_frame_bytes(
    const struct iterate_kit_pcm_websocket_format *format,
    size_t *frame_bytes) {
  size_t samples;
  if (frame_bytes == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  *frame_bytes = 0U;
  if (format == NULL ||
      format->encoding != ITERATE_KIT_PCM_S16_LE ||
      format->sample_rate_hz == 0U ||
      format->channel_count == 0U ||
      format->samples_per_channel == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if ((size_t)format->samples_per_channel >
      SIZE_MAX / (size_t)format->channel_count) {
    return ITERATE_KIT_LIMIT;
  }
  samples =
      (size_t)format->samples_per_channel *
      (size_t)format->channel_count;
  if (samples > SIZE_MAX / sizeof(int16_t)) {
    return ITERATE_KIT_LIMIT;
  }
  *frame_bytes = samples * sizeof(int16_t);
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_pcm_websocket_validate_frame(
    const struct iterate_kit_pcm_websocket_format *format,
    const void *frame,
    size_t frame_bytes) {
  size_t expected_bytes;
  const enum iterate_kit_status status =
      iterate_kit_pcm_websocket_frame_bytes(
          format, &expected_bytes);
  if (status != ITERATE_KIT_OK) {
    return status;
  }
  if (frame == NULL || frame_bytes != expected_bytes) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  return ITERATE_KIT_OK;
}
