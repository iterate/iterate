#ifndef ITERATE_KIT_PCM_WEBSOCKET_H
#define ITERATE_KIT_PCM_WEBSOCKET_H

#include "iterate/kit/status.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define ITERATE_KIT_PCM_WEBSOCKET_SUBPROTOCOL \
  "iterate.kit.pcm.v1"

enum {
  /*
   * Protocol v1 chooses the M5Stick's native voice shape: one mono PCM16LE
   * 20 ms frame per binary WebSocket message. Keeping this fixed avoids
   * device-side resampling and makes every queue slot and latency budget exact.
   *
   * A final zero-length binary message is an ordered boundary in each
   * direction: device-to-server ends one manual capture turn, while
   * server-to-device ends one response. It is deliberately not a PCM frame
   * and therefore remains invalid input to
   * iterate_kit_pcm_websocket_validate_frame().
   */
  ITERATE_KIT_PCM_V1_SAMPLE_RATE_HZ = 16000,
  ITERATE_KIT_PCM_V1_CHANNEL_COUNT = 1,
  ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME = 320,
  ITERATE_KIT_PCM_V1_FRAME_BYTES =
      ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME * 2,
  /*
   * Device-to-server receipts are transport control, not audio. Their fixed
   * size is deliberately neither zero nor 640 bytes, so a peer can classify
   * them before touching the microphone path without an envelope on PCM.
   */
  ITERATE_KIT_PCM_V1_DOWNLINK_RECEIPT_BYTES = 8,
};

enum iterate_kit_pcm_encoding {
  ITERATE_KIT_PCM_S16_LE = 0,
};

/**
 * Low-level frame shape used by validation helpers. Protocol v1 itself is
 * fixed to the constants above: mono signed PCM16LE at 16 kHz in 20 ms
 * frames. A later protocol version may negotiate other shapes.
 */
struct iterate_kit_pcm_websocket_format {
  enum iterate_kit_pcm_encoding encoding;
  uint32_t sample_rate_hz;
  uint16_t channel_count;
  uint32_t samples_per_channel;
};

/**
 * Calculates the exact binary WebSocket message size without allocating.
 * Only signed 16-bit little-endian PCM is part of protocol version 1.
 */
enum iterate_kit_status iterate_kit_pcm_websocket_frame_bytes(
    const struct iterate_kit_pcm_websocket_format *format,
    size_t *frame_bytes);

/**
 * Validates one complete binary WebSocket message. The function does not copy
 * or retain the frame.
 */
enum iterate_kit_status iterate_kit_pcm_websocket_validate_frame(
    const struct iterate_kit_pcm_websocket_format *format,
    const void *frame,
    size_t frame_bytes);

/**
 * Encodes the cumulative count of complete downlink items accepted by the
 * device in this WebSocket generation.
 *
 * Server-side workerd WebSockets do not expose their egress buffer depth, so a
 * successful send cannot bound audio hidden below userspace. This receipt is
 * the peer-parse boundary used for an explicit finite in-flight window. It is
 * cumulative so several 20 ms arrivals can coalesce into one tiny write, and
 * it acknowledges the zero-length response marker as an ordered item too.
 */
enum iterate_kit_status
iterate_kit_pcm_websocket_encode_downlink_receipt(
    uint32_t accepted_items,
    uint8_t *destination,
    size_t destination_bytes);

/** Validates and decodes the exact v1 receipt shape. */
enum iterate_kit_status
iterate_kit_pcm_websocket_decode_downlink_receipt(
    const void *message,
    size_t message_bytes,
    uint32_t *accepted_items);

#ifdef __cplusplus
}
#endif

#endif
