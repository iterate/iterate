#include "cli_keyboard.h"

#include <assert.h>
#include <string.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

/*
 * A terminal has no key-up event, so "hold to talk" is an inference from an
 * absence and every case below is a way that inference can be wrong. The
 * scenarios are driven through cli_keyboard_feed, which is the whole policy
 * with no terminal and no clock in it; if these had to press a real key there
 * would be no test at all.
 */

enum {
  /* macOS auto-repeat: first repeat after InitialKeyRepeat, then ~90 ms. */
  TEST_FIRST_REPEAT_MS = 375,
  TEST_REPEAT_MS = 90,
  TEST_SPACE = 0x20,
};

static struct cli_keyboard keyboard;

/* Feeds one byte and returns what the policy made of it. */
static enum cli_keyboard_event press(uint8_t key, uint64_t now_ms);

/* Feeds nothing, which is how a release is eventually noticed. */
static enum cli_keyboard_event wait_until(uint64_t now_ms);

/*
 * The failure this exists to prevent: a held SPACE arrives as one byte, a
 * long pause, and then a stream of repeats. If the release timeout is shorter
 * than that first pause, one held sentence becomes a series of quarter-second
 * turns — the provider hears five fragments, answers the first, and the
 * person concludes push-to-talk is broken.
 */
static void a_held_key_is_one_turn_however_it_repeats(void)
{
  memset(&keyboard, 0, sizeof(keyboard));
  assert(press(TEST_SPACE, 0U) == CLI_KEYBOARD_TALK_START);
  /* The gap before the first repeat is the dangerous one. */
  assert(wait_until(TEST_FIRST_REPEAT_MS - 1U) == CLI_KEYBOARD_NONE);
  uint64_t last_press_ms = TEST_FIRST_REPEAT_MS;
  for (uint32_t repeat = 0U; repeat < 20U; ++repeat) {
    assert(press(TEST_SPACE, last_press_ms) == CLI_KEYBOARD_NONE);
    assert(wait_until(last_press_ms + TEST_REPEAT_MS - 1U) ==
           CLI_KEYBOARD_NONE);
    last_press_ms += TEST_REPEAT_MS;
  }
  last_press_ms -= TEST_REPEAT_MS;
  assert(keyboard.turns_started == 1U);
  /*
   * The key comes up. Release is timed from the last SPACE, not from the last
   * poll — a loop that happened to be busy must not shorten somebody's turn.
   */
  assert(wait_until(last_press_ms + CLI_KEYBOARD_HOLD_TIMEOUT_MS - 1U) ==
         CLI_KEYBOARD_NONE);
  assert(wait_until(last_press_ms + CLI_KEYBOARD_HOLD_TIMEOUT_MS) ==
         CLI_KEYBOARD_TALK_STOP);
  /* And it is over exactly once, not once per poll for the rest of the run. */
  assert(wait_until(last_press_ms + CLI_KEYBOARD_HOLD_TIMEOUT_MS + 1000U) ==
         CLI_KEYBOARD_NONE);
}

/*
 * The constant, asserted rather than merely commented. macOS defaults
 * InitialKeyRepeat to 25 ticks of 15 ms; anything at or below that turns the
 * scenario above from a passing test into a broken feature, and the
 * relationship is not obvious from either number on its own.
 */
static void the_release_timeout_outlasts_the_first_auto_repeat(void)
{
  assert(CLI_KEYBOARD_HOLD_TIMEOUT_MS > TEST_FIRST_REPEAT_MS);
}

/* A tap is a short turn, not no turn: half a second of speech is a sentence. */
static void a_tap_is_still_a_turn(void)
{
  memset(&keyboard, 0, sizeof(keyboard));
  assert(press(TEST_SPACE, 1000U) == CLI_KEYBOARD_TALK_START);
  assert(wait_until(1000U + CLI_KEYBOARD_HOLD_TIMEOUT_MS) ==
         CLI_KEYBOARD_TALK_STOP);
  assert(keyboard.turns_started == 1U);
}

/*
 * Hanging up while still holding the key must not need the key released
 * first. A person pressing q wants out now, and a second press to confirm it
 * is the kind of thing that gets a tool abandoned.
 */
static void hanging_up_wins_over_anything_in_the_same_read(void)
{
  memset(&keyboard, 0, sizeof(keyboard));
  assert(press(TEST_SPACE, 0U) == CLI_KEYBOARD_TALK_START);
  const uint8_t both[2] = {TEST_SPACE, (uint8_t)'q'};
  enum cli_keyboard_event event = CLI_KEYBOARD_NONE;
  assert(cli_keyboard_feed(&keyboard, both, sizeof(both), 100U, &event) ==
         CLI_KEYBOARD_OK);
  assert(event == CLI_KEYBOARD_HANG_UP);
  assert(!keyboard.holding);
  assert(keyboard.hang_ups == 1U);
  /* Upper case is the same key with a shift held; refusing it would baffle. */
  assert(press((uint8_t)'Q', 200U) == CLI_KEYBOARD_HANG_UP);
}

/*
 * Anything unbound must be inert. Treating a stray key as evidence the talk
 * button is still down would let a person's typing hold a turn open, and
 * treating it as a release would cut them off mid-sentence.
 */
static void unbound_keys_neither_hold_nor_release(void)
{
  memset(&keyboard, 0, sizeof(keyboard));
  assert(press(TEST_SPACE, 0U) == CLI_KEYBOARD_TALK_START);
  assert(press((uint8_t)'x', 100U) == CLI_KEYBOARD_NONE);
  assert(keyboard.holding);
  assert(wait_until(CLI_KEYBOARD_HOLD_TIMEOUT_MS) == CLI_KEYBOARD_TALK_STOP);
}

static void unusable_arguments_are_refused(void)
{
  enum cli_keyboard_event event = CLI_KEYBOARD_NONE;
  const uint8_t key = TEST_SPACE;
  assert(cli_keyboard_feed(NULL, &key, 1U, 0U, &event) ==
         CLI_KEYBOARD_ERR_ARG);
  assert(cli_keyboard_feed(&keyboard, &key, 1U, 0U, NULL) ==
         CLI_KEYBOARD_ERR_ARG);
  assert(cli_keyboard_feed(&keyboard, NULL, 1U, 0U, &event) ==
         CLI_KEYBOARD_ERR_ARG);
  /* No bytes is the ordinary case, not an error: most polls read nothing. */
  assert(cli_keyboard_feed(&keyboard, NULL, 0U, 0U, &event) ==
         CLI_KEYBOARD_OK);
  assert(cli_keyboard_open(NULL) == CLI_KEYBOARD_ERR_ARG);
  assert(strcmp(cli_keyboard_status_name(CLI_KEYBOARD_ERR_NOT_A_TERMINAL),
                "not-a-terminal") == 0);
  assert(strcmp(cli_keyboard_event_name(CLI_KEYBOARD_TALK_STOP),
                "talk-stop") == 0);
  /* Closing something never opened must not touch anybody else's terminal. */
  cli_keyboard_close(NULL);
  cli_keyboard_restore_terminal();
}

static enum cli_keyboard_event press(uint8_t key, uint64_t now_ms)
{
  enum cli_keyboard_event event = CLI_KEYBOARD_NONE;
  assert(cli_keyboard_feed(&keyboard, &key, 1U, now_ms, &event) ==
         CLI_KEYBOARD_OK);
  return event;
}

static enum cli_keyboard_event wait_until(uint64_t now_ms)
{
  enum cli_keyboard_event event = CLI_KEYBOARD_NONE;
  assert(cli_keyboard_feed(&keyboard, NULL, 0U, now_ms, &event) ==
         CLI_KEYBOARD_OK);
  return event;
}

int main(void)
{
  a_held_key_is_one_turn_however_it_repeats();
  the_release_timeout_outlasts_the_first_auto_repeat();
  a_tap_is_still_a_turn();
  hanging_up_wins_over_anything_in_the_same_read();
  unbound_keys_neither_hold_nor_release();
  unusable_arguments_are_refused();
  return 0;
}
