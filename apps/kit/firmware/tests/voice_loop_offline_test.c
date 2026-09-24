/*
 * A BOARD THAT CAN'T GET ONLINE SAYS SO, INSTEAD OF STARTING A CALL.
 *
 * A Home Assistant Voice PE flashed with the wrong Wi-Fi password said
 * "connecting to iterate", started a call on "Jarvis", recorded into nothing
 * and said "Call ended." twenty seconds later. These scenarios run the shared
 * loop on a laptop against a transport that never gets online, in order, on
 * one boot: the loop is a program with one of everything, like the board.
 *
 * `after-own-restart` (a second CTest entry) boots as if the loop had
 * restarted itself, which it does every few minutes while offline for good.
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

static void test_assert(bool condition, const char *expression, const char *file, int line);
#define assert(expression) test_assert((expression), #expression, __FILE__, __LINE__)

struct board {
  struct iterate_kit_voice_view last_view;
  bool press_pending;
  bool end_pending;
};
static struct board board;

static void boot(void);
static void step(void);
static void run_ms(uint32_t milliseconds);
static void press(void);
static void end_call(void);
static void connect_and_mount(void);
static const char *status(void);

static void a_board_that_never_joins_wifi_says_so_once_at_boot(void) {
  boot();
  step();
  assert(board.last_view.connectivity == ITERATE_KIT_CONNECTIVITY_CONNECTING);
  assert(strcmp(status(), "joining Wi-Fi") == 0);

  run_ms(14000U);
  assert(board.last_view.connectivity == ITERATE_KIT_CONNECTIVITY_CONNECTING);
  assert(board.last_view.offline_notices == 0U);

  run_ms(1000U);
  assert(board.last_view.connectivity == ITERATE_KIT_CONNECTIVITY_NO_WIFI);
  assert(board.last_view.offline_notices == 1U);
  assert(board.last_view.screen == ITERATE_KIT_VOICE_SCREEN_CONNECTING);
  assert(strcmp(status(), "couldn't join the Wi-Fi network") == 0);
  struct iterate_kit_conversation_visual_state lights;
  iterate_kit_voice_view_lights(&board.last_view, &lights);
  assert(lights.network == ITERATE_KIT_NETWORK_OFFLINE);

  /* Said once; a board left offline does not keep talking to the room. */
  run_ms(60000U);
  assert(board.last_view.offline_notices == 1U);
}

static void a_press_while_offline_starts_no_call_and_says_why(void) {
  const size_t sent = iterate_kit_fake_platform_sent_count();
  press();
  assert(!board.last_view.wants_call);
  assert(!board.last_view.listening);
  assert(board.last_view.offline_notices == 2U);
  assert(iterate_kit_fake_platform_sent_count() == sent);
  assert(strcmp(status(), "couldn't join the Wi-Fi network") == 0);
}

static void the_reason_follows_the_newest_attempt(void) {
  iterate_kit_fake_platform_set_network_stage(ITERATE_KIT_NETWORK_STAGE_REACHING_HOST);
  step();
  assert(board.last_view.connectivity == ITERATE_KIT_CONNECTIVITY_NO_INTERNET);
  assert(strcmp(status(), "couldn't connect to the internet") == 0);
  /* A new reason is shown, not announced: nobody pressed anything. */
  assert(board.last_view.offline_notices == 2U);
}

static void once_online_a_press_starts_a_call(void) {
  connect_and_mount();
  assert(board.last_view.connectivity == ITERATE_KIT_CONNECTIVITY_ONLINE);
  assert(board.last_view.screen == ITERATE_KIT_VOICE_SCREEN_IDLE);
  assert(strcmp(status(), "") == 0);

  press();
  assert(board.last_view.wants_call);
  assert(board.last_view.listening);
  end_call();
  assert(!board.last_view.wants_call);
}

/* Capture starts on a press made while reconnecting, so opening words are kept;
 * if the connection doesn't come back, the reason replaces "Call ended." */
static void a_call_opened_while_reconnecting_ends_with_the_reason(void) {
  const uint32_t notices = board.last_view.offline_notices;
  iterate_kit_fake_platform_set_state(ITERATE_KIT_ITX_WEBSOCKET_CONNECTING);
  iterate_kit_fake_platform_set_network_stage(ITERATE_KIT_NETWORK_STAGE_REACHING_ITERATE);
  step();
  assert(board.last_view.connectivity == ITERATE_KIT_CONNECTIVITY_CONNECTING);

  press();
  assert(board.last_view.wants_call);
  assert(board.last_view.listening);

  run_ms(15000U);
  assert(board.last_view.connectivity == ITERATE_KIT_CONNECTIVITY_NO_ITERATE);
  assert(!board.last_view.wants_call);
  assert(!board.last_view.listening);
  assert(strcmp(status(), "couldn't reach iterate") == 0);
  /* One notice for the ended call; going offline after being online is not boot news. */
  assert(board.last_view.offline_notices == notices + 1U);
}

/* The loop restarts a board that has been offline for minutes; that boot keeps quiet
 * until someone presses. */
static void after_its_own_restart_a_board_waits_for_a_press(void) {
  iterate_kit_fake_platform_set_last_restart_note("transport never became ready");
  run_ms(16000U);
  assert(board.last_view.connectivity == ITERATE_KIT_CONNECTIVITY_NO_WIFI);
  assert(board.last_view.offline_notices == 0U);

  press();
  assert(!board.last_view.wants_call);
  assert(board.last_view.offline_notices == 1U);
}

int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "after-own-restart") == 0) {
    boot();
    after_its_own_restart_a_board_waits_for_a_press();
    return 0;
  }
  a_board_that_never_joins_wifi_says_so_once_at_boot();
  a_press_while_offline_starts_no_call_and_says_why();
  the_reason_follows_the_newest_attempt();
  once_online_a_press_starts_a_call();
  a_call_opened_while_reconnecting_ends_with_the_reason();
  return 0;
}

/* --- a silent board with one button ---------------------------------------- */

static const struct iterate_kit_audio_codec_properties codec_properties = {
  .capture_sample_rate_hz = ITERATE_KIT_VOICE_SAMPLE_RATE_HZ,
  .playback_sample_rate_hz = ITERATE_KIT_VOICE_SAMPLE_RATE_HZ,
  .capture_channels = 1U,
  .playback_channels = 1U,
};

static enum iterate_kit_status codec_read(
    void *context, int16_t *capture, int16_t *reference,
    size_t capacity_samples, size_t *sample_count) {
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

/* What the shared session grammar hands the loop for a press, as board.c does. */
static void board_poll(void *context, struct iterate_kit_voice_intent *out) {
  (void)context;
  out->start_call = board.press_pending;
  out->end_call = board.end_pending;
  board.press_pending = false;
  board.end_pending = false;
}

static const struct iterate_kit_board_ops board_ops = {
  .start = board_start,
  .present = board_present,
  .poll = board_poll,
};

static const struct iterate_kit_board_facts voice_facts = {
  .device_name = "host-offline-test",
  .speaker_dry_wait_ms = 40U,
  .processing_frame_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  .capture_chunk_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  .capture_stack_bytes = 4096U,
};

/* --- driving the loop -------------------------------------------------------- */

/* Power on with the transport started and nowhere to go: no Wi-Fi yet. */
static void boot(void) {
  iterate_kit_host_esp_idf_reset();
  iterate_kit_fake_platform_reset();
  memset(&board, 0, sizeof(board));
  iterate_kit_host_esp_idf_set_now_us(1000000);
  assert(iterate_kit_voice_loop_init(&board_ops, &voice_facts, NULL));
}

static void step(void) {
  iterate_kit_host_esp_idf_advance_ms(50U);
  iterate_kit_voice_loop_step();
}

static void run_ms(uint32_t milliseconds) {
  for (uint32_t elapsed = 0U; elapsed < milliseconds; elapsed += 50U) step();
}

static void press(void) {
  board.press_pending = true;
  step();
}

static void end_call(void) {
  board.end_pending = true;
  step();
}

static const char *status(void) {
  return board.last_view.status == NULL ? "" : board.last_view.status;
}

/*
 * Bring the pretend socket up and answer the mount the way /api would: every
 * call in the chain (authenticate, projects.get, provide, cd, subscribe)
 * resolves to a capability.
 */
static void connect_and_mount(void) {
  size_t answered = iterate_kit_fake_platform_sent_count();
  iterate_kit_fake_platform_connect();
  for (int round = 0; round < 40 && !board.last_view.api_ready; ++round) {
    step();
    while (answered < iterate_kit_fake_platform_sent_count()) {
      const char *pull = strstr(iterate_kit_fake_platform_sent(answered++), "[\"pull\",");
      if (pull == NULL) continue;
      const long id = strtol(pull + strlen("[\"pull\","), NULL, 10);
      char reply[96];
      (void)snprintf(reply, sizeof(reply), "[\"resolve\",%ld,[\"export\",%ld]]", id, -(id + 10));
      assert(iterate_kit_itx_connection_receive_text(
                 iterate_kit_fake_platform_connection(), reply, strlen(reply)) == CAPNWEB_OK);
    }
  }
  step();
  assert(board.last_view.api_ready);
}

static void test_assert(bool condition, const char *expression, const char *file, int line) {
  if (condition) return;
  (void)fprintf(stderr, "%s:%d: assertion failed: %s\n", file, line, expression);
  abort();
}
