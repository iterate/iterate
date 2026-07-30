#include "iterate/kit/websocket_frame_writer.h"

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CHECK(condition)                                                     \
  do {                                                                       \
    if (!(condition)) {                                                      \
      fprintf(stderr, "%s:%d: check failed: %s\n",                         \
          __FILE__, __LINE__, #condition);                                   \
      abort();                                                               \
    }                                                                        \
  } while (0)

/*
 * ESP-IDF and TLS are allowed to accept arbitrary byte prefixes. Rebuilding a
 * client frame after each short write would choose a new mask or duplicate its
 * header, so the writer must expose one stable encoded frame and advance an
 * exact cursor. The uneven write sizes model several real socket completions
 * and compare the final peer-visible bytes with the RFC 6455 example.
 */
static void partial_writes_resume_one_rfc6455_frame(void) {
  static const uint8_t expected[] = {
    0x81U, 0x85U, 0x37U, 0xfaU, 0x21U, 0x3dU,
    0x7fU, 0x9fU, 0x4dU, 0x51U, 0x58U,
  };
  static const uint8_t mask[4] = {
    0x37U, 0xfaU, 0x21U, 0x3dU,
  };
  static const char payload[] = "Hello";
  static const size_t write_sizes[] = {1U, 2U, 3U, 5U};
  uint8_t storage[sizeof(expected)];
  uint8_t observed[sizeof(expected)] = {0U};
  struct iterate_kit_websocket_frame_writer writer;
  size_t observed_size = 0U;
  size_t write_index;

  CHECK(iterate_kit_websocket_frame_writer_init(
      &writer, storage, sizeof(storage)) == ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_frame_writer_begin(
      &writer,
      ITERATE_KIT_WEBSOCKET_TEXT,
      payload,
      sizeof(payload) - 1U,
      mask) == ITERATE_KIT_OK);

  for (write_index = 0U;
       write_index < sizeof(write_sizes) / sizeof(write_sizes[0]);
       ++write_index) {
    const uint8_t *pending = NULL;
    size_t pending_size = 0U;
    const size_t write_size = write_sizes[write_index];
    CHECK(iterate_kit_websocket_frame_writer_pending(
        &writer, &pending, &pending_size) == ITERATE_KIT_OK);
    CHECK(pending_size == sizeof(expected) - observed_size);
    CHECK(write_size <= pending_size);
    memcpy(observed + observed_size, pending, write_size);
    observed_size += write_size;
    CHECK(iterate_kit_websocket_frame_writer_advance(
        &writer, write_size) == ITERATE_KIT_OK);
  }

  CHECK(observed_size == sizeof(expected));
  CHECK(memcmp(observed, expected, sizeof(expected)) == 0);
  CHECK(!iterate_kit_websocket_frame_writer_busy(&writer));
}

/*
 * A server PING may demand a PONG while a PCM frame is partially written, but
 * a WebSocket control header cannot be spliced into the middle of that frame.
 * Refuse the second begin until the existing boundary is complete. An internal
 * control queue was deliberately left to the higher transmitter layer, which
 * knows CLOSE/PING/PONG priority; this primitive owns only one fixed buffer.
 */
static void control_frames_wait_for_the_current_frame_boundary(
    void) {
  static const uint8_t data_mask[4] = {
    0x01U, 0x02U, 0x03U, 0x04U,
  };
  static const uint8_t pong_mask[4] = {
    0x05U, 0x06U, 0x07U, 0x08U,
  };
  static const uint8_t payload[] = {0x10U, 0x20U};
  uint8_t storage[
      ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(sizeof(payload))];
  struct iterate_kit_websocket_frame_writer writer;
  const uint8_t *pending = NULL;
  size_t pending_size = 0U;

  CHECK(iterate_kit_websocket_frame_writer_init(
      &writer, storage, sizeof(storage)) == ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_frame_writer_begin(
      &writer,
      ITERATE_KIT_WEBSOCKET_BINARY,
      payload,
      sizeof(payload),
      data_mask) == ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_frame_writer_pending(
      &writer, &pending, &pending_size) == ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_frame_writer_advance(
      &writer, 1U) == ITERATE_KIT_OK);

  CHECK(iterate_kit_websocket_frame_writer_begin(
      &writer,
      ITERATE_KIT_WEBSOCKET_PONG,
      payload,
      sizeof(payload),
      pong_mask) == ITERATE_KIT_BACKPRESSURE);
  CHECK(iterate_kit_websocket_frame_writer_pending(
      &writer, &pending, &pending_size) == ITERATE_KIT_OK);
  CHECK(pending[0] != 0x8aU);
  CHECK(iterate_kit_websocket_frame_writer_advance(
      &writer, pending_size) == ITERATE_KIT_OK);

  CHECK(iterate_kit_websocket_frame_writer_begin(
      &writer,
      ITERATE_KIT_WEBSOCKET_PONG,
      payload,
      sizeof(payload),
      pong_mask) == ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_frame_writer_pending(
      &writer, &pending, &pending_size) == ITERATE_KIT_OK);
  CHECK(pending[0] == 0x8aU);
}

/*
 * One 20 ms, 16 kHz mono PCM frame is 640 bytes. The realtime path budgets one
 * encoded copy—not a convenience-sized maximum—because every extra buffer
 * consumes permanent internal RAM and adds another place stale speech could
 * wait. Pin the eight bytes of RFC 6455 overhead as well as the extended-length
 * header so a framing change cannot silently increase the device memory model.
 */
static void pcm_frames_use_the_exact_bounded_storage(void) {
  uint8_t payload[640];
  uint8_t storage[
      ITERATE_KIT_WEBSOCKET_CLIENT_FRAME_BYTES(sizeof(payload))];
  const uint8_t mask[4] = {0xaaU, 0xbbU, 0xccU, 0xddU};
  struct iterate_kit_websocket_frame_writer writer;
  const uint8_t *pending = NULL;
  size_t pending_size = 0U;

  memset(payload, 0x5a, sizeof(payload));
  CHECK(sizeof(storage) == 648U);
  CHECK(iterate_kit_websocket_frame_writer_init(
      &writer, storage, sizeof(storage)) == ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_frame_writer_begin(
      &writer,
      ITERATE_KIT_WEBSOCKET_BINARY,
      payload,
      sizeof(payload),
      mask) == ITERATE_KIT_OK);
  CHECK(iterate_kit_websocket_frame_writer_pending(
      &writer, &pending, &pending_size) == ITERATE_KIT_OK);
  CHECK(pending_size == sizeof(storage));
  CHECK(pending[0] == 0x82U);
  CHECK(pending[1] == 0xfeU);
  CHECK(pending[2] == 0x02U);
  CHECK(pending[3] == 0x80U);
  CHECK(memcmp(pending + 4U, mask, sizeof(mask)) == 0);
}

int main(void) {
  partial_writes_resume_one_rfc6455_frame();
  control_frames_wait_for_the_current_frame_boundary();
  pcm_frames_use_the_exact_bounded_storage();
  return 0;
}
