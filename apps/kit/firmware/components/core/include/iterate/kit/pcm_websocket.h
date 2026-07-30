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
   * Server-to-device only, a final zero-length binary message is the ordered
   * end-of-response marker. It is deliberately not a PCM frame and therefore
   * remains invalid input to iterate_kit_pcm_websocket_validate_frame().
   */
  ITERATE_KIT_PCM_V1_SAMPLE_RATE_HZ = 16000,
  ITERATE_KIT_PCM_V1_CHANNEL_COUNT = 1,
  ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME = 320,
  ITERATE_KIT_PCM_V1_FRAME_BYTES =
      ITERATE_KIT_PCM_V1_SAMPLES_PER_FRAME * 2,
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

#ifdef __cplusplus
}
#endif

#endif
