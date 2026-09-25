/*
 * What a board says out loud, and when (iterate/kit/announcer.h). Each test is
 * one boot: the facts the loop would see, step by step, and the phrase it
 * would get the next time its speaker was free.
 */

#include "iterate/kit/announcer.h"
#include "iterate/kit/tinyvoice.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>

static void test_assert(bool condition, const char *expression, const char *file, int line) {
  if (condition) return;
  (void)fprintf(stderr, "%s:%d: assertion failed: %s\n", file, line, expression);
  abort();
}

#define assert(expression) test_assert((expression), #expression, __FILE__, __LINE__)
#define STEP(announcer, ...) \
  iterate_kit_announcer_step((announcer), &(const struct iterate_kit_announcer_input){__VA_ARGS__})

static void a_plugged_in_board_narrates_its_way_to_ready(void) {
  struct iterate_kit_announcer a;
  iterate_kit_announcer_init(&a, true, 0);

  STEP(&a, .now_ms = 0, .wifi = ITERATE_KIT_WIFI_JOINING);
  STEP(&a, .now_ms = 900, .wifi = ITERATE_KIT_WIFI_JOINING);
  assert(iterate_kit_announcer_take(&a) == ITERATE_KIT_ANNOUNCEMENT_NONE);
  STEP(&a, .now_ms = 1000, .wifi = ITERATE_KIT_WIFI_JOINING);
  assert(iterate_kit_announcer_take(&a) == ITERATE_KIT_ANNOUNCEMENT_CONNECTING_TO_WIFI);

  /* iterate answers within the second, so "Connecting to iterate." is skipped. */
  STEP(&a, .now_ms = 2000, .wifi = ITERATE_KIT_WIFI_JOINED);
  STEP(&a, .now_ms = 2600, .wifi = ITERATE_KIT_WIFI_JOINED, .connected = true);
  assert(iterate_kit_announcer_take(&a) == ITERATE_KIT_ANNOUNCEMENT_READY);

  /* Connected, the story is over: a drop an hour later is silent. */
  STEP(&a, .now_ms = 3600000, .wifi = ITERATE_KIT_WIFI_JOINING);
  STEP(&a, .now_ms = 3700000, .wifi = ITERATE_KIT_WIFI_JOINING);
  assert(iterate_kit_announcer_take(&a) == ITERATE_KIT_ANNOUNCEMENT_NONE);
}

static void a_state_that_went_stale_while_the_speaker_was_busy_is_never_said(void) {
  struct iterate_kit_announcer a;
  iterate_kit_announcer_init(&a, true, 0);
  STEP(&a, .now_ms = 0, .wifi = ITERATE_KIT_WIFI_JOINING);
  STEP(&a, .now_ms = 1000, .wifi = ITERATE_KIT_WIFI_JOINING);
  assert(iterate_kit_announcer_take(&a) == ITERATE_KIT_ANNOUNCEMENT_CONNECTING_TO_WIFI);
  /* While that is sung, the network goes missing long enough to be queued... */
  STEP(&a, .now_ms = 1500, .wifi = ITERATE_KIT_WIFI_NOT_FOUND);
  STEP(&a, .now_ms = 2500, .wifi = ITERATE_KIT_WIFI_NOT_FOUND);
  /* ...and comes back before the speaker is free: that phrase is no longer true. */
  STEP(&a, .now_ms = 4900, .wifi = ITERATE_KIT_WIFI_JOINED);
  STEP(&a, .now_ms = 5300, .wifi = ITERATE_KIT_WIFI_JOINED);
  assert(iterate_kit_announcer_take(&a) == ITERATE_KIT_ANNOUNCEMENT_NONE);
  STEP(&a, .now_ms = 5900, .wifi = ITERATE_KIT_WIFI_JOINED);
  assert(iterate_kit_announcer_take(&a) == ITERATE_KIT_ANNOUNCEMENT_CONNECTING_TO_ITERATE);
}

static void an_answer_waiting_for_the_speaker_says_the_state_it_finds(void) {
  struct iterate_kit_announcer a;
  iterate_kit_announcer_init(&a, false, 0);
  STEP(&a, .now_ms = 0, .wifi = ITERATE_KIT_WIFI_JOINED);
  STEP(&a, .now_ms = 5000, .wifi = ITERATE_KIT_WIFI_JOINED, .pressed = true);
  /* iterate answers first: the press hears "Ready.", not "Connecting to iterate." */
  STEP(&a, .now_ms = 5050, .wifi = ITERATE_KIT_WIFI_JOINED, .connected = true);
  assert(iterate_kit_announcer_take(&a) == ITERATE_KIT_ANNOUNCEMENT_READY);
}

static void narration_waits_while_the_microphone_is_open(void) {
  struct iterate_kit_announcer a;
  iterate_kit_announcer_init(&a, true, 0);
  STEP(&a, .now_ms = 0, .wifi = ITERATE_KIT_WIFI_JOINED, .connected = true, .in_session = true);
  STEP(&a, .now_ms = 1000, .wifi = ITERATE_KIT_WIFI_JOINED, .connected = true, .in_session = true);
  assert(iterate_kit_announcer_take(&a) == ITERATE_KIT_ANNOUNCEMENT_NONE);
  STEP(&a, .now_ms = 9000, .wifi = ITERATE_KIT_WIFI_JOINED, .connected = true);
  assert(iterate_kit_announcer_take(&a) == ITERATE_KIT_ANNOUNCEMENT_READY);
}

static void a_wrong_password_is_said_once_however_often_the_board_retries(void) {
  struct iterate_kit_announcer a;
  iterate_kit_announcer_init(&a, true, 0);
  STEP(&a, .now_ms = 0, .wifi = ITERATE_KIT_WIFI_JOINING);
  STEP(&a, .now_ms = 400, .wifi = ITERATE_KIT_WIFI_WRONG_PASSWORD);
  STEP(&a, .now_ms = 1400, .wifi = ITERATE_KIT_WIFI_WRONG_PASSWORD);
  assert(iterate_kit_announcer_take(&a) == ITERATE_KIT_ANNOUNCEMENT_WIFI_PASSWORD_REJECTED);
  for (uint64_t now = 2000; now < 60000; now += 1000) {
    STEP(&a, .now_ms = now, .wifi = now % 3000 == 0 ? ITERATE_KIT_WIFI_JOINING : ITERATE_KIT_WIFI_WRONG_PASSWORD);
    assert(iterate_kit_announcer_take(&a) != ITERATE_KIT_ANNOUNCEMENT_WIFI_PASSWORD_REJECTED);
  }
}

static void wifi_that_never_reaches_iterate_says_so_after_twenty_seconds(void) {
  struct iterate_kit_announcer a;
  iterate_kit_announcer_init(&a, true, 0);
  STEP(&a, .now_ms = 0, .wifi = ITERATE_KIT_WIFI_JOINED);
  STEP(&a, .now_ms = 1000, .wifi = ITERATE_KIT_WIFI_JOINED);
  assert(iterate_kit_announcer_take(&a) == ITERATE_KIT_ANNOUNCEMENT_CONNECTING_TO_ITERATE);
  STEP(&a, .now_ms = 20000, .wifi = ITERATE_KIT_WIFI_JOINED);
  assert(iterate_kit_announcer_take(&a) == ITERATE_KIT_ANNOUNCEMENT_NONE);
  STEP(&a, .now_ms = 21000, .wifi = ITERATE_KIT_WIFI_JOINED);
  assert(iterate_kit_announcer_take(&a) == ITERATE_KIT_ANNOUNCEMENT_ITERATE_UNREACHABLE);
}

static void a_refused_key_outranks_everything_else(void) {
  struct iterate_kit_announcer a;
  iterate_kit_announcer_init(&a, true, 0);
  STEP(&a, .now_ms = 0, .wifi = ITERATE_KIT_WIFI_JOINED, .key_refused = true);
  STEP(&a, .now_ms = 1000, .wifi = ITERATE_KIT_WIFI_JOINED, .key_refused = true);
  assert(iterate_kit_announcer_take(&a) == ITERATE_KIT_ANNOUNCEMENT_KEY_REFUSED);
}

static void narration_gives_up_after_three_minutes(void) {
  struct iterate_kit_announcer a;
  iterate_kit_announcer_init(&a, true, 0);
  STEP(&a, .now_ms = 0, .wifi = ITERATE_KIT_WIFI_JOINING);
  STEP(&a, .now_ms = 1000, .wifi = ITERATE_KIT_WIFI_JOINING);
  (void)iterate_kit_announcer_take(&a);
  STEP(&a, .now_ms = 200000, .wifi = ITERATE_KIT_WIFI_NOT_FOUND);
  STEP(&a, .now_ms = 202000, .wifi = ITERATE_KIT_WIFI_NOT_FOUND);
  assert(iterate_kit_announcer_take(&a) == ITERATE_KIT_ANNOUNCEMENT_NONE);
}

static void a_boot_nobody_caused_is_silent_until_someone_asks(void) {
  struct iterate_kit_announcer a;
  iterate_kit_announcer_init(&a, false, 0);
  STEP(&a, .now_ms = 0, .wifi = ITERATE_KIT_WIFI_JOINING);
  STEP(&a, .now_ms = 5000, .wifi = ITERATE_KIT_WIFI_NOT_FOUND);
  STEP(&a, .now_ms = 9000, .wifi = ITERATE_KIT_WIFI_NOT_FOUND);
  assert(iterate_kit_announcer_take(&a) == ITERATE_KIT_ANNOUNCEMENT_NONE);

  /* A press while offline says why, straight away. */
  STEP(&a, .now_ms = 9025, .wifi = ITERATE_KIT_WIFI_NOT_FOUND, .pressed = true);
  assert(iterate_kit_announcer_take(&a) == ITERATE_KIT_ANNOUNCEMENT_WIFI_NOT_FOUND);
  /* ...and so does the wake word. */
  STEP(&a, .now_ms = 20000, .wifi = ITERATE_KIT_WIFI_NOT_FOUND, .woken = true);
  assert(iterate_kit_announcer_take(&a) == ITERATE_KIT_ANNOUNCEMENT_WIFI_NOT_FOUND);
}

static void a_connected_board_says_hello_to_the_wake_word_and_leaves_a_press_to_the_chime(void) {
  struct iterate_kit_announcer a;
  iterate_kit_announcer_init(&a, false, 0);
  STEP(&a, .now_ms = 0, .wifi = ITERATE_KIT_WIFI_JOINED, .connected = true);
  assert(iterate_kit_announcer_answers(true, true, true));
  STEP(&a, .now_ms = 60000, .wifi = ITERATE_KIT_WIFI_JOINED, .connected = true, .woken = true);
  assert(iterate_kit_announcer_take(&a) == ITERATE_KIT_ANNOUNCEMENT_HELLO);
  assert(!iterate_kit_announcer_answers(false, true, true));
  assert(iterate_kit_announcer_answers(false, false, true));
  /* A busy speaker cannot answer at once, so the chime does. */
  assert(!iterate_kit_announcer_answers(true, true, false));
}

static void a_call_ending_is_said_even_while_the_connection_changes(void) {
  struct iterate_kit_announcer a;
  iterate_kit_announcer_init(&a, false, 0);
  STEP(&a, .now_ms = 0, .wifi = ITERATE_KIT_WIFI_JOINED, .connected = true, .call_ended = true);
  /* Not a connection phrase, so a state change while it waits does not touch it. */
  STEP(&a, .now_ms = 100, .wifi = ITERATE_KIT_WIFI_JOINING);
  assert(iterate_kit_announcer_take(&a) == ITERATE_KIT_ANNOUNCEMENT_CALL_ENDED);
}

static void every_phrase_can_be_said_and_sung(void) {
  static struct iterate_kit_tinyvoice voice;
  for (int i = ITERATE_KIT_ANNOUNCEMENT_NONE + 1; i < ITERATE_KIT_ANNOUNCEMENT_COUNT; i++) {
    const enum iterate_kit_announcement announcement = (enum iterate_kit_announcement)i;
    assert(iterate_kit_announcement_text(announcement)[0] != '\0');
    for (int tune = ITERATE_KIT_TINYVOICE_SPOKEN; tune <= ITERATE_KIT_TINYVOICE_LASS_OF_AUGHRIM; tune++) {
      assert(iterate_kit_tinyvoice_prepare(
                 &voice, iterate_kit_announcement_script(announcement),
                 (enum iterate_kit_tinyvoice_tune)tune) > 0U);
    }
  }
}

int main(void) {
  a_plugged_in_board_narrates_its_way_to_ready();
  a_state_that_went_stale_while_the_speaker_was_busy_is_never_said();
  an_answer_waiting_for_the_speaker_says_the_state_it_finds();
  narration_waits_while_the_microphone_is_open();
  a_wrong_password_is_said_once_however_often_the_board_retries();
  wifi_that_never_reaches_iterate_says_so_after_twenty_seconds();
  a_refused_key_outranks_everything_else();
  narration_gives_up_after_three_minutes();
  a_boot_nobody_caused_is_silent_until_someone_asks();
  a_connected_board_says_hello_to_the_wake_word_and_leaves_a_press_to_the_chime();
  a_call_ending_is_said_even_while_the_connection_changes();
  every_phrase_can_be_said_and_sung();
  return 0;
}
