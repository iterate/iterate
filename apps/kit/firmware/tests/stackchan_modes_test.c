#include "stackchan_modes.h"

#include <assert.h>
#include <stddef.h>
#include <string.h>

/*
 * THE MODE TABLE IS HALF OF A SERVER-SIDE CONTRACT, same rule as the
 * HAVPE's: each path names a stream already configured for exactly that
 * provider, and a drifted path presents as a deaf robot, not as a test
 * failure, unless this test exists. The OpenAI row is also the board's
 * factory default (`facts.stream_path`), so the literal here is the tie
 * between the two spellings.
 */
static void the_mode_table_matches_the_provisioned_streams(void) {
  assert(STACKCHAN_MODE_COUNT == 2);
  assert(
      strcmp(
          stackchan_mode_stream_path(STACKCHAN_MODE_GROK),
          "/agents/voice/stackchan-grok") == 0);
  assert(
      strcmp(
          stackchan_mode_stream_path(STACKCHAN_MODE_OPENAI),
          "/agents/voice/stackchan") == 0);
  assert(stackchan_mode_stream_path(STACKCHAN_MODE_COUNT) == NULL);
}

/* What the side button MEANS in which state is the shared session
 * grammar's — tests/session_grammar_test.c, `open_mic` posture. This file
 * keeps the parts that are this board's alone. */

/* One menu poll. */
static bool menu_drive(
    struct stackchan_menu *menu,
    bool tap,
    bool tap_left_half,
    bool call_in_play,
    uint64_t now_ms,
    uint8_t *pick) {
  const struct stackchan_menu_poll poll = {
    .tap = tap,
    .tap_left_half = tap_left_half,
    .call_in_play = call_in_play,
    .now_ms = now_ms,
  };
  return stackchan_menu_step(menu, &poll, pick);
}

static void a_tap_opens_and_the_next_tap_picks_the_half(void) {
  struct stackchan_menu menu = {0};
  uint8_t pick;
  /* First tap opens; it is not itself a pick. */
  assert(menu_drive(&menu, true, true, false, 1000U, &pick));
  assert(pick == STACKCHAN_MENU_NO_PICK);
  /* Quiet polls keep it up. */
  assert(menu_drive(&menu, false, false, false, 2000U, &pick));
  assert(pick == STACKCHAN_MENU_NO_PICK);
  /* Left half picks Grok and the menu closes. */
  assert(!menu_drive(&menu, true, true, false, 3000U, &pick));
  assert(pick == STACKCHAN_MODE_GROK);
  /* Open again; right half picks OpenAI. */
  assert(menu_drive(&menu, true, false, false, 4000U, &pick));
  assert(!menu_drive(&menu, true, false, false, 5000U, &pick));
  assert(pick == STACKCHAN_MODE_OPENAI);
}

static void an_ignored_menu_dismisses_itself(void) {
  struct stackchan_menu menu = {0};
  uint8_t pick;
  assert(menu_drive(&menu, true, true, false, 1000U, &pick));
  /* One millisecond short of the timeout: still up. */
  assert(menu_drive(
      &menu, false, false, false, 1000U + STACKCHAN_MENU_TIMEOUT_MS - 1U,
      &pick));
  /* At the timeout: gone, and nothing was picked. */
  assert(!menu_drive(
      &menu, false, false, false, 1000U + STACKCHAN_MENU_TIMEOUT_MS, &pick));
  assert(pick == STACKCHAN_MENU_NO_PICK);
  /* The tap after an expiry OPENS, it does not pick blind. */
  assert(menu_drive(
      &menu, true, true, false, 2000U + STACKCHAN_MENU_TIMEOUT_MS, &pick));
  assert(pick == STACKCHAN_MENU_NO_PICK);
}

/*
 * The wheel-cancel rule, worn by a menu: a call in play closes it and eats
 * the tap, because re-pointing the stream underneath a call being placed
 * would strand the call.
 */
static void a_call_closes_the_menu_and_eats_the_tap(void) {
  struct stackchan_menu menu = {0};
  uint8_t pick;
  assert(menu_drive(&menu, true, true, false, 1000U, &pick));
  assert(!menu_drive(&menu, true, true, true, 1100U, &pick));
  assert(pick == STACKCHAN_MENU_NO_PICK);
  /* Mid-call face taps stay nothing, however many. */
  assert(!menu_drive(&menu, true, false, true, 1200U, &pick));
  assert(pick == STACKCHAN_MENU_NO_PICK);
}

/* Picking the provider already adopted still answers — the person asked
 * which provider this is, and the announcement is the answer. The CALLER
 * skips the persistence, not the reply, so the machine must still report
 * the pick. */
static void picking_in_place_still_answers(void) {
  struct stackchan_menu menu = {0};
  uint8_t pick;
  assert(menu_drive(&menu, true, false, false, 1000U, &pick));
  assert(!menu_drive(&menu, true, false, false, 1500U, &pick));
  assert(pick == STACKCHAN_MODE_OPENAI);
}

int main(void) {
  the_mode_table_matches_the_provisioned_streams();
  a_tap_opens_and_the_next_tap_picks_the_half();
  an_ignored_menu_dismisses_itself();
  a_call_closes_the_menu_and_eats_the_tap();
  picking_in_place_still_answers();
  return 0;
}
