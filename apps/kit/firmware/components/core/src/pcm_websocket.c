#include "iterate/kit/pcm_websocket.h"

#include <stdint.h>
#include <string.h>

static const uint8_t downlink_receipt_prefix[4] = {
  (uint8_t)'I', (uint8_t)'K', (uint8_t)'A', 1U,
};

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

enum iterate_kit_status
iterate_kit_pcm_websocket_encode_downlink_receipt(
    uint32_t accepted_items,
    uint8_t *destination,
    size_t destination_bytes) {
  if (destination == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (destination_bytes <
      ITERATE_KIT_PCM_V1_DOWNLINK_RECEIPT_BYTES) {
    return ITERATE_KIT_LIMIT;
  }
  memcpy(
      destination,
      downlink_receipt_prefix,
      sizeof(downlink_receipt_prefix));
  destination[4] = (uint8_t)(accepted_items & 0xffU);
  destination[5] = (uint8_t)((accepted_items >> 8U) & 0xffU);
  destination[6] = (uint8_t)((accepted_items >> 16U) & 0xffU);
  destination[7] = (uint8_t)((accepted_items >> 24U) & 0xffU);
  return ITERATE_KIT_OK;
}

enum iterate_kit_status
iterate_kit_pcm_websocket_decode_downlink_receipt(
    const void *message,
    size_t message_bytes,
    uint32_t *accepted_items) {
  const uint8_t *bytes = message;
  if (accepted_items == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  *accepted_items = 0U;
  if (bytes == NULL ||
      message_bytes !=
          ITERATE_KIT_PCM_V1_DOWNLINK_RECEIPT_BYTES ||
      memcmp(
          bytes,
          downlink_receipt_prefix,
          sizeof(downlink_receipt_prefix)) != 0) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  *accepted_items =
      (uint32_t)bytes[4] |
      ((uint32_t)bytes[5] << 8U) |
      ((uint32_t)bytes[6] << 16U) |
      ((uint32_t)bytes[7] << 24U);
  return ITERATE_KIT_OK;
}
