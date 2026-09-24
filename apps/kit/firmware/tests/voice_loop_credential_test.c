/*
 * A BOARD WHOSE KEY THE SERVER REFUSES SAYS SO.
 *
 * The transport marks a 401 or 403 upgrade as a refused key and backs off; the
 * screen is the loop's. A board still saying "connecting" would promise a
 * connection no retry delivers, so while the refusal stands the status asks
 * for the one thing that mends it. A separate executable because the loop is
 * a program: this board never connects, which the other loop tests' boot does.
 */

#include "esp_idf.h"
#include "fake_esp_idf_platform.h"

#include "iterate/kit/voice/loop.h"

#include "iterate/kit/audio_processor.h"
#include "iterate/kit/voice_device_profile.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void test_assert(
    bool condition, const char *expression, const char *file, int line) {
  if (condition) return;
  (void)fprintf(
      stderr, "%s:%d: assertion failed: %s\n", file, line, expression);
  abort();
}

#define assert(expression) \
  test_assert((expression), #expression, __FILE__, __LINE__)

static const struct iterate_kit_audio_codec_properties codec_properties = {
  .capture_sample_rate_hz = ITERATE_KIT_VOICE_SAMPLE_RATE_HZ,
  .playback_sample_rate_hz = ITERATE_KIT_VOICE_SAMPLE_RATE_HZ,
  .capture_channels = 1U,
  .playback_channels = 1U,
  .has_reference_channel = false,
  .has_output_gain_control = false,
  .output_gain_ceiling_centi_db = 0,
};

static enum iterate_kit_status codec_read(
    void *context,
    int16_t *capture,
    int16_t *reference,
    size_t capacity_samples,
    size_t *sample_count) {
  (void)context;
  (void)capture;
  (void)reference;
  (void)capacity_samples;
  (void)sample_count;
  return ITERATE_KIT_UNAVAILABLE;
}

static enum iterate_kit_status codec_write(
    void *context, const int16_t *playback, size_t sample_count) {
  (void)context;
  (void)playback;
  (void)sample_count;
  return ITERATE_KIT_OK;
}

static const struct iterate_kit_audio_codec_ops codec_ops = {
  .read = codec_read,
  .write = codec_write,
};

struct board {
  struct iterate_kit_voice_view last_view;
  bool started;
};

static bool board_start(void *context, struct iterate_kit_board_audio *out) {
  struct board *board = context;
  board->started = true;
  out->codec.ops = &codec_ops;
  out->codec.properties = &codec_properties;
  out->codec.context = NULL;
  out->processor = iterate_kit_audio_processor_passthrough();
  return true;
}

static void board_present(
    void *context, const struct iterate_kit_voice_view *view) {
  struct board *board = context;
  board->last_view = *view;
}

static void board_poll(void *context, struct iterate_kit_voice_intent *out) {
  (void)context;
  (void)out;
}

static const struct iterate_kit_board_ops board_ops = {
  .start = board_start,
  .present = board_present,
  .poll = board_poll,
};

static const struct iterate_kit_board_facts voice_facts = {
  .device_name = "host-test",
  .speaker = {0},
  .speaker_dry_wait_ms = 40U,
  .processing_frame_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  .capture_chunk_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  .capture_stack_bytes = 4096U,
};

static struct board board;

static void step(void) {
  iterate_kit_host_esp_idf_advance_ms(50U);
  iterate_kit_voice_loop_step();
}

static bool status_is(const char *expected) {
  return board.last_view.status != NULL &&
      strcmp(board.last_view.status, expected) == 0;
}

int main(void) {
  iterate_kit_host_esp_idf_reset();
  iterate_kit_fake_platform_reset();
  memset(&board, 0, sizeof(board));
  iterate_kit_host_esp_idf_set_now_us(1000000);
  assert(iterate_kit_voice_loop_init(&board_ops, &voice_facts, &board));
  assert(board.started);
  iterate_kit_fake_platform_set_state(ITERATE_KIT_ITX_WEBSOCKET_CONNECTING);

  step();
  assert(board.last_view.screen == ITERATE_KIT_VOICE_SCREEN_CONNECTING);
  assert(status_is("connecting to iterate"));

  iterate_kit_fake_platform_set_credential_refused(true);
  step();
  assert(board.last_view.screen == ITERATE_KIT_VOICE_SCREEN_CONNECTING);
  assert(status_is("key refused — set up again"));
  /* It stays said between attempts; nothing else on this path rewrites it. */
  step();
  assert(status_is("key refused — set up again"));

  /* An upgrade the server accepted clears it, before any mount. */
  iterate_kit_fake_platform_set_credential_refused(false);
  step();
  assert(status_is("connecting to iterate"));
  assert(!iterate_kit_host_esp_idf_restart_requested());
  return 0;
}
