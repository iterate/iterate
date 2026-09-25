/*
 * A BOARD SOMEONE HAS JUST PLUGGED IN SAYS HOW ITS CONNECTION IS GOING.
 *
 * One boot, heard through the board's clip player: "Connecting to Wi-Fi." while
 * it joins, "Ready." once iterate answers (the connect in between was too
 * quick to mention), "Hello!" instead of the chime when the wake word starts a
 * session, and nothing when the connection drops later. A separate executable
 * because the loop is a program that boots once (voice_loop_credential_test.c).
 */

#include "esp_idf.h"
#include "fake_esp_idf_platform.h"

#include "iterate/kit/voice/loop.h"

#include "iterate/kit/announcer.h"
#include "iterate/kit/audio_processor.h"
#include "iterate/kit/tinyvoice.h"
#include "iterate/kit/voice_device_profile.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void test_assert(bool condition, const char *expression, const char *file, int line) {
  if (condition) return;
  (void)fprintf(stderr, "%s:%d: assertion failed: %s\n", file, line, expression);
  abort();
}

#define assert(expression) test_assert((expression), #expression, __FILE__, __LINE__)

enum { CLIP_PEAK = 12000 };

struct clip {
  const int16_t *pcm;
  size_t samples;
};

static struct {
  struct iterate_kit_voice_view last_view;
  struct clip clips[8];
  size_t clip_count;
  bool press_next_poll;
  bool wake_word_next_poll;
  bool end_next_poll;
} board;

static size_t samples_of(enum iterate_kit_announcement phrase);
static int peak_of(const struct clip *clip);
static void boot(void);
static void step(void);
static void mount(void);

int main(void) {
  boot();
  iterate_kit_fake_platform_set_wifi_status(ITERATE_KIT_WIFI_JOINING);
  for (int i = 0; i < 10; i++) step();
  /* Not connected, speaker free: a press or the wake word would get words, not the chime. */
  assert(board.last_view.voice_answers_press);
  assert(board.last_view.voice_answers_wake_word);
  for (int i = 0; i < 12; i++) step();
  assert(board.clip_count == 1U);
  assert(board.clips[0].samples == samples_of(ITERATE_KIT_ANNOUNCEMENT_CONNECTING_TO_WIFI));
  /* As loud as the board's own "call ended". */
  assert(peak_of(&board.clips[0]) == CLIP_PEAK);
  /* Singing: an answer could not start at once, so a start would get the chime. */
  assert(!board.last_view.voice_answers_press);
  assert(!board.last_view.voice_answers_wake_word);

  /* Wi-Fi joins and iterate answers while Greensleeves is still being sung. */
  iterate_kit_fake_platform_set_wifi_status(ITERATE_KIT_WIFI_JOINED);
  iterate_kit_fake_platform_connect();
  mount();
  assert(board.last_view.api_ready);
  assert(board.clip_count == 1U);
  for (int i = 0; i < 60; i++) step();
  assert(board.clip_count == 2U);
  assert(board.clips[1].samples == samples_of(ITERATE_KIT_ANNOUNCEMENT_READY));
  for (int i = 0; i < 30; i++) step();
  /* Connected and quiet: the wake word gets Hello, a press keeps its chime. */
  assert(board.last_view.voice_answers_wake_word);
  assert(!board.last_view.voice_answers_press);

  /* "Jarvis": Hello, and the session starts. */
  board.press_next_poll = true;
  board.wake_word_next_poll = true;
  for (int i = 0; i < 2; i++) step();
  assert(board.last_view.wants_call);
  assert(board.clip_count == 3U);
  assert(board.clips[2].samples == samples_of(ITERATE_KIT_ANNOUNCEMENT_HELLO));

  /* Hang up; the next "Jarvis" reuses the Hello already rendered. */
  board.end_next_poll = true;
  for (int i = 0; i < 40; i++) step();
  assert(!board.last_view.wants_call);
  board.press_next_poll = true;
  board.wake_word_next_poll = true;
  for (int i = 0; i < 2; i++) step();
  assert(board.clip_count == 4U);
  assert(board.clips[3].pcm == board.clips[2].pcm);

  /* A button press while connected is the chime's, not the loop's. */
  board.end_next_poll = true;
  for (int i = 0; i < 40; i++) step();
  board.press_next_poll = true;
  for (int i = 0; i < 40; i++) step();
  assert(board.clip_count == 4U);

  /* Connected once, a drop is silent: no singing at 3 am. */
  board.end_next_poll = true;
  iterate_kit_fake_platform_set_state(ITERATE_KIT_ITX_WIFI_CONNECTING);
  iterate_kit_fake_platform_set_wifi_status(ITERATE_KIT_WIFI_JOINING);
  for (int i = 0; i < 100; i++) step();
  assert(board.clip_count == 4U);
  return 0;
}

static struct iterate_kit_tinyvoice voice;

static size_t samples_of(enum iterate_kit_announcement phrase) {
  return iterate_kit_tinyvoice_prepare(
      &voice, iterate_kit_announcement_script(phrase), ITERATE_KIT_TINYVOICE_GREENSLEEVES);
}

static int peak_of(const struct clip *clip) {
  int peak = 0;
  for (size_t i = 0; i < clip->samples; i++) peak = abs(clip->pcm[i]) > peak ? abs(clip->pcm[i]) : peak;
  return peak;
}

static const struct iterate_kit_audio_codec_properties codec_properties = {
    .capture_sample_rate_hz = ITERATE_KIT_VOICE_SAMPLE_RATE_HZ,
    .playback_sample_rate_hz = ITERATE_KIT_VOICE_SAMPLE_RATE_HZ,
    .capture_channels = 1U,
    .playback_channels = 1U,
};

static enum iterate_kit_status codec_read(
    void *context, int16_t *capture, int16_t *reference, size_t capacity_samples, size_t *sample_count) {
  (void)context;
  (void)capture;
  (void)reference;
  (void)capacity_samples;
  (void)sample_count;
  return ITERATE_KIT_UNAVAILABLE;
}

static enum iterate_kit_status codec_write(void *context, const int16_t *playback, size_t sample_count) {
  (void)context;
  (void)playback;
  (void)sample_count;
  return ITERATE_KIT_OK;
}

static const struct iterate_kit_audio_codec_ops codec_ops = {.read = codec_read, .write = codec_write};

static bool board_start(void *context, struct iterate_kit_board_audio *out) {
  (void)context;
  out->codec.ops = &codec_ops;
  out->codec.properties = &codec_properties;
  out->codec.context = NULL;
  out->processor = iterate_kit_audio_processor_passthrough();
  return true;
}

static void board_present(void *context, const struct iterate_kit_voice_view *view) {
  (void)context;
  board.last_view = *view;
}

static void board_poll(void *context, struct iterate_kit_voice_intent *out) {
  (void)context;
  out->start_call = board.press_next_poll;
  out->wake_word = board.wake_word_next_poll;
  out->end_call = board.end_next_poll;
  board.press_next_poll = board.wake_word_next_poll = board.end_next_poll = false;
}

static void board_play_clip(void *context, const int16_t *pcm, size_t samples) {
  (void)context;
  assert(board.clip_count < sizeof(board.clips) / sizeof(board.clips[0]));
  board.clips[board.clip_count++] = (struct clip){pcm, samples};
}

static const struct iterate_kit_board_ops board_ops = {
    .start = board_start,
    .present = board_present,
    .poll = board_poll,
    .play_clip = board_play_clip,
};

static const struct iterate_kit_board_facts voice_facts = {
    .device_name = "host-test",
    .speaker_dry_wait_ms = 40U,
    .processing_frame_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
    .capture_chunk_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
    .capture_stack_bytes = 4096U,
    .clip_peak = CLIP_PEAK,
};

static void boot(void) {
  iterate_kit_host_esp_idf_reset();
  iterate_kit_fake_platform_reset();
  iterate_kit_fake_platform_set_reset_by_person(true);
  iterate_kit_host_esp_idf_set_now_us(1000000);
  assert(iterate_kit_voice_loop_init(&board_ops, &voice_facts, NULL));
  iterate_kit_fake_platform_set_state(ITERATE_KIT_ITX_WIFI_CONNECTING);
}

static void step(void) {
  iterate_kit_host_esp_idf_advance_ms(50U);
  iterate_kit_voice_loop_step();
}

/* Answer every pull the mount makes with a capability, the way a live /api does. */
static void mount(void) {
  size_t answered = 0;
  for (int round = 0; round < 20; round++) {
    struct iterate_kit_itx_connection *connection = iterate_kit_fake_platform_connection();
    while (answered < iterate_kit_fake_platform_sent_count()) {
      const char *pull = strstr(iterate_kit_fake_platform_sent(answered++), "[\"pull\",");
      if (pull == NULL) continue;
      const long id = strtol(pull + strlen("[\"pull\","), NULL, 10);
      char reply[96];
      (void)snprintf(reply, sizeof(reply), "[\"resolve\",%ld,[\"export\",%ld]]", id, -(id + 10));
      assert(iterate_kit_itx_connection_receive_text(connection, reply, strlen(reply)) == CAPNWEB_OK);
    }
    step();
  }
}
