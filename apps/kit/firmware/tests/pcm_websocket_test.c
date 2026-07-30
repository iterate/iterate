#include "iterate/kit/pcm_websocket.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

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

/*
 * The device audio socket is deliberately a minimal hot path: one binary
 * WebSocket message maps to one PCM frame with no per-frame envelope to parse
 * or allocate. Adding a length/type header would duplicate information already
 * fixed by negotiation and spend CPU on every 20 ms chunk. This test pins the
 * byte count and accepts the native frame representation directly.
 */
static void one_binary_message_is_one_headerless_pcm_frame(void) {
  const struct iterate_kit_pcm_websocket_format format = {
    ITERATE_KIT_PCM_S16_LE,
    16000U,
    1U,
    320U,
  };
  size_t frame_bytes = 0U;
  int16_t frame[320] = {0};

  assert(
      iterate_kit_pcm_websocket_frame_bytes(
          &format, &frame_bytes) == ITERATE_KIT_OK);
  assert(frame_bytes == sizeof(frame));
  assert(
      iterate_kit_pcm_websocket_validate_frame(
          &format, frame, sizeof(frame)) == ITERATE_KIT_OK);
}

/*
 * A server/device format mismatch must fail before playback, because even a
 * sample-aligned short frame changes timing and can underrun the speaker. It is
 * tempting to accept “close enough” lengths and pad them, but that hides
 * transport faults and changes latency. This scenario proves validation uses
 * the exact negotiated channel/sample shape, not only integer sample alignment.
 */
static void the_negotiated_frame_shape_is_exact(void) {
  const struct iterate_kit_pcm_websocket_format format = {
    ITERATE_KIT_PCM_S16_LE,
    24000U,
    2U,
    480U,
  };
  uint8_t frame[1920] = {0};

  assert(
      iterate_kit_pcm_websocket_validate_frame(
          &format, frame, sizeof(frame)) == ITERATE_KIT_OK);
  assert(
      iterate_kit_pcm_websocket_validate_frame(
          &format, frame, sizeof(frame) - 1U) ==
      ITERATE_KIT_INVALID_ARGUMENT);
  assert(
      iterate_kit_pcm_websocket_validate_frame(
          &format, frame, sizeof(frame) - 2U) ==
      ITERATE_KIT_INVALID_ARGUMENT);
}

/*
 * Negotiation values may originate outside the firmware trust boundary.
 * Defaulting an unknown encoding or zero dimension could produce zero-byte
 * loops, overflow later size calculations, or silently play the wrong format.
 * This test requires invalid contracts to be rejected deterministically and
 * clears the output size so callers cannot accidentally reuse a stale value.
 */
static void invalid_or_unrepresentable_formats_are_rejected(void) {
  const struct iterate_kit_pcm_websocket_format unknown_encoding = {
    (enum iterate_kit_pcm_encoding)99,
    16000U,
    1U,
    320U,
  };
  const struct iterate_kit_pcm_websocket_format no_rate = {
    ITERATE_KIT_PCM_S16_LE,
    0U,
    1U,
    320U,
  };
  const struct iterate_kit_pcm_websocket_format no_channels = {
    ITERATE_KIT_PCM_S16_LE,
    16000U,
    0U,
    320U,
  };
  const struct iterate_kit_pcm_websocket_format no_samples = {
    ITERATE_KIT_PCM_S16_LE,
    16000U,
    1U,
    0U,
  };
  size_t frame_bytes = 123U;

  assert(
      iterate_kit_pcm_websocket_frame_bytes(
          &unknown_encoding, &frame_bytes) ==
      ITERATE_KIT_INVALID_ARGUMENT);
  assert(frame_bytes == 0U);
  assert(
      iterate_kit_pcm_websocket_frame_bytes(
          &no_rate, &frame_bytes) == ITERATE_KIT_INVALID_ARGUMENT);
  assert(
      iterate_kit_pcm_websocket_frame_bytes(
          &no_channels, &frame_bytes) ==
      ITERATE_KIT_INVALID_ARGUMENT);
  assert(
      iterate_kit_pcm_websocket_frame_bytes(
          &no_samples, &frame_bytes) ==
      ITERATE_KIT_INVALID_ARGUMENT);
}

int main(void) {
  one_binary_message_is_one_headerless_pcm_frame();
  the_negotiated_frame_shape_is_exact();
  invalid_or_unrepresentable_formats_are_rejected();
  return 0;
}
