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

static void the_state_is_the_loops_two_facts(void) {
  assert(stackchan_session_classify(false, false) == STACKCHAN_SESSION_IDLE);
  assert(stackchan_session_classify(true, false) == STACKCHAN_SESSION_WAKING);
  assert(stackchan_session_classify(true, true) == STACKCHAN_SESSION_IN_CALL);
  assert(stackchan_session_classify(false, true) == STACKCHAN_SESSION_ENDING);
}

/* One poll: build the facts, step the machine, hand back the actions. */
static struct stackchan_session_actions drive(
    struct stackchan_session *session,
    bool tap,
    bool wants_call,
    bool call_active) {
  const struct stackchan_session_poll poll = {
    .tap = tap,
    .wants_call = wants_call,
    .call_active = call_active,
  };
  struct stackchan_session_actions actions;
  stackchan_session_step(session, &poll, &actions);
  return actions;
}

static void quiet(const struct stackchan_session_actions *actions) {
  assert(!actions->start_call);
  assert(!actions->end_call);
  assert(!actions->wake_chime);
  assert(!actions->end_chime);
}

static void a_tap_wakes_idle_and_a_tap_ends_the_session(void) {
  struct stackchan_session session = {0};
  /* Idle, no press: nothing. */
  struct stackchan_session_actions actions = drive(&session, false, false, false);
  quiet(&actions);
  /* The wake press: start and chime together. */
  actions = drive(&session, true, false, false);
  assert(actions.start_call);
  assert(actions.wake_chime);
  assert(!actions.end_call);
  assert(!actions.end_chime);
  /* Waking, tap ends. */
  actions = drive(&session, true, true, false);
  assert(actions.end_call);
  assert(!actions.start_call);
  /* In-call, tap ends too. */
  session.was_in_session = false;
  actions = drive(&session, false, true, true);
  quiet(&actions);
  actions = drive(&session, true, true, true);
  assert(actions.end_call);
  assert(!actions.wake_chime);
}

/*
 * Every end path arrives at IDLE, and the chime rides that one edge — so a
 * tap end, a model hang-up and a dead session all sound identical and none
 * of them can forget the sound. Exactly once per session.
 */
static void every_end_says_call_ended_once(void) {
  struct stackchan_session session = {0};
  (void)drive(&session, true, false, false);       /* wake */
  (void)drive(&session, false, true, true);        /* in call */
  /* The loop's facts collapse — however that happened. */
  struct stackchan_session_actions actions = drive(&session, false, false, false);
  assert(actions.end_chime);
  assert(!actions.start_call);
  /* Idle again: the chime does not repeat. */
  actions = drive(&session, false, false, false);
  quiet(&actions);
}

static void an_end_tap_and_the_next_wake_are_separate_presses(void) {
  struct stackchan_session session = {0};
  (void)drive(&session, true, false, false);       /* wake */
  (void)drive(&session, false, true, true);        /* in call */
  struct stackchan_session_actions actions = drive(&session, true, true, true);
  assert(actions.end_call);
  /* Teardown in flight: presses are inert. */
  actions = drive(&session, true, false, true);
  quiet(&actions);
  /* Arrived at idle: the end chime, then the next tap is a fresh wake. */
  actions = drive(&session, false, false, false);
  assert(actions.end_chime);
  actions = drive(&session, true, false, false);
  assert(actions.start_call);
  assert(actions.wake_chime);
}

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
  the_state_is_the_loops_two_facts();
  a_tap_wakes_idle_and_a_tap_ends_the_session();
  every_end_says_call_ended_once();
  an_end_tap_and_the_next_wake_are_separate_presses();
  a_tap_opens_and_the_next_tap_picks_the_half();
  an_ignored_menu_dismisses_itself();
  a_call_closes_the_menu_and_eats_the_tap();
  picking_in_place_still_answers();
  return 0;
}
