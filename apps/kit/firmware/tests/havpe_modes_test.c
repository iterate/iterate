#include "havpe_modes.h"

#include <assert.h>
#include <stddef.h>
#include <string.h>

/*
 * THE MODE TABLE IS HALF OF A SERVER-SIDE CONTRACT, so its four paths are
 * pinned as literals: each names a stream already configured for exactly
 * that provider and turn policy, and a drifted path is a board that dials a
 * provider expecting turns nobody marks — which presents as a deaf
 * assistant, not as a test failure, unless this test exists. Mode 4's path
 * is also the board's factory default (`facts.stream_path`), so the literal
 * here is the tie between the two spellings.
 */
static void the_mode_table_matches_the_provisioned_streams(void) {
  assert(HAVPE_MODE_COUNT == 4);
  assert(
      strcmp(
          havpe_mode_stream_path(HAVPE_MODE_GROK_PUSH_TO_TALK),
          "/agents/voice/havpe-grok-ptt") == 0);
  assert(
      strcmp(
          havpe_mode_stream_path(HAVPE_MODE_GROK_OPEN_MIC),
          "/agents/voice/havpe-grok-vad") == 0);
  assert(
      strcmp(
          havpe_mode_stream_path(HAVPE_MODE_OPENAI_PUSH_TO_TALK),
          "/agents/voice/havpe-openai-ptt") == 0);
  assert(
      strcmp(
          havpe_mode_stream_path(HAVPE_MODE_OPENAI_OPEN_MIC),
          "/agents/voice/home-assistant-voice-preview-edition") == 0);
  assert(havpe_mode_push_to_talk(HAVPE_MODE_GROK_PUSH_TO_TALK));
  assert(!havpe_mode_push_to_talk(HAVPE_MODE_GROK_OPEN_MIC));
  assert(havpe_mode_push_to_talk(HAVPE_MODE_OPENAI_PUSH_TO_TALK));
  assert(!havpe_mode_push_to_talk(HAVPE_MODE_OPENAI_OPEN_MIC));
  /* Out of range fails soft: no path, no push-to-talk. */
  assert(havpe_mode_stream_path(HAVPE_MODE_COUNT) == NULL);
  assert(!havpe_mode_push_to_talk(HAVPE_MODE_COUNT));
}

/* Walk the decoder through quadrature samples; returns net counts. */
static int feed(
    struct havpe_dial_decoder *decoder, const uint8_t *levels, size_t count) {
  int net = 0;
  for (size_t index = 0U; index < count; ++index) {
    net += havpe_dial_decoder_step(
        decoder, (levels[index] & 2U) != 0U, (levels[index] & 1U) != 0U);
  }
  return net;
}

/*
 * One full A/B cycle is TWO counts in either direction — the official
 * firmware's `resolution: 2`, which is what makes one detent of this
 * hardware one volume step under either firmware.
 */
static void a_full_cycle_is_two_counts(void) {
  struct havpe_dial_decoder decoder;
  /* levels encode (A << 1) | B; one Gray cycle each way. */
  static const uint8_t forward[] = {1U, 3U, 2U, 0U};
  static const uint8_t backward[] = {2U, 3U, 1U, 0U};
  havpe_dial_decoder_init(&decoder, false, false);
  assert(feed(&decoder, forward, sizeof(forward)) == 2);
  assert(feed(&decoder, backward, sizeof(backward)) == -2);
}

/*
 * Contact bounce is a repeated sample or a step retraced, never a count:
 * jitter on one edge must not creep the volume.
 */
static void bounce_and_stalls_count_nothing(void) {
  struct havpe_dial_decoder decoder;
  static const uint8_t jitter[] = {1U, 1U, 0U, 1U, 0U, 1U, 0U};
  havpe_dial_decoder_init(&decoder, false, false);
  assert(feed(&decoder, jitter, sizeof(jitter)) == 0);
}

/*
 * A double-jump (both pins changed inside one sample period) is ambiguous —
 * the sampler cannot know which way the wheel went — so it contributes
 * nothing rather than guessing.
 */
static void an_ambiguous_jump_is_dropped(void) {
  struct havpe_dial_decoder decoder;
  static const uint8_t jump[] = {3U, 0U, 3U, 0U};
  havpe_dial_decoder_init(&decoder, false, false);
  assert(feed(&decoder, jump, sizeof(jump)) == 0);
}

/*
 * THE SETTLE POLICY: a fast spin lands on ONE final mode with ONE
 * announcement. Detents move the shown mode immediately; nothing settles
 * until the dial has been quiet for HAVPE_MODE_SETTLE_MS, and then exactly
 * once.
 */
static void a_spin_settles_once_on_the_final_mode(void) {
  struct havpe_mode_wheel wheel;
  uint8_t mode = 0xffU;
  havpe_mode_wheel_init(&wheel, HAVPE_MODE_OPENAI_OPEN_MIC);
  /* Seven detents from mode 4: wraps twice around, lands on mode 3. */
  havpe_mode_wheel_turn(&wheel, 1, 1000U);
  assert(wheel.shown == HAVPE_MODE_GROK_PUSH_TO_TALK);
  havpe_mode_wheel_turn(&wheel, 3, 1100U);
  havpe_mode_wheel_turn(&wheel, 3, 1200U);
  assert(wheel.shown == HAVPE_MODE_OPENAI_PUSH_TO_TALK);
  /* Still spinning: quiet has not lasted the settle window. */
  assert(!havpe_mode_wheel_take_settled(&wheel, 1200U + HAVPE_MODE_SETTLE_MS - 1U, &mode));
  assert(havpe_mode_wheel_take_settled(&wheel, 1200U + HAVPE_MODE_SETTLE_MS, &mode));
  assert(mode == HAVPE_MODE_OPENAI_PUSH_TO_TALK);
  /* Exactly once. */
  assert(!havpe_mode_wheel_take_settled(&wheel, 5000U, &mode));
}

/* Negative detents wrap the other way. */
static void backward_detents_wrap(void) {
  struct havpe_mode_wheel wheel;
  havpe_mode_wheel_init(&wheel, HAVPE_MODE_GROK_PUSH_TO_TALK);
  havpe_mode_wheel_turn(&wheel, -1, 100U);
  assert(wheel.shown == HAVPE_MODE_OPENAI_OPEN_MIC);
  havpe_mode_wheel_turn(&wheel, -6, 200U);
  assert(wheel.shown == HAVPE_MODE_GROK_OPEN_MIC);
}

/*
 * A spin that a call interrupts never settles: the shown mode snaps back and
 * the quiet timer is disarmed, so the mode cannot change as a surprise when
 * the call ends minutes later.
 */
static void a_call_cancels_an_unsettled_spin(void) {
  struct havpe_mode_wheel wheel;
  uint8_t mode = 0xffU;
  havpe_mode_wheel_init(&wheel, HAVPE_MODE_OPENAI_OPEN_MIC);
  havpe_mode_wheel_turn(&wheel, 2, 100U);
  assert(wheel.shown == HAVPE_MODE_GROK_OPEN_MIC);
  havpe_mode_wheel_cancel(&wheel);
  assert(wheel.shown == HAVPE_MODE_OPENAI_OPEN_MIC);
  assert(!havpe_mode_wheel_take_settled(&wheel, 100000U, &mode));
}

/* Settling on the mode already adopted still fires: the announcement is the
 * answer to "where is the dial", not a change notification. */
static void settling_in_place_still_answers(void) {
  struct havpe_mode_wheel wheel;
  uint8_t mode = 0xffU;
  havpe_mode_wheel_init(&wheel, HAVPE_MODE_GROK_OPEN_MIC);
  havpe_mode_wheel_turn(&wheel, 4, 100U);
  assert(wheel.shown == HAVPE_MODE_GROK_OPEN_MIC);
  assert(havpe_mode_wheel_take_settled(&wheel, 100U + HAVPE_MODE_SETTLE_MS, &mode));
  assert(mode == HAVPE_MODE_GROK_OPEN_MIC);
}

/* --- the session grammar --------------------------------------------------- */

/* One poll of the machine, spelled as the facts a pass carries. */
static struct havpe_session_actions drive(
    struct havpe_session *session,
    bool tap, bool held, bool wants_call, bool call_active, bool ptt) {
  struct havpe_session_actions actions;
  const struct havpe_session_poll poll = {
    .tap = tap,
    .held = held,
    .wants_call = wants_call,
    .call_active = call_active,
    .push_to_talk = ptt,
  };
  havpe_session_step(session, &poll, &actions);
  return actions;
}

static bool quiet(const struct havpe_session_actions *actions) {
  return !actions->start_call && !actions->end_call && !actions->wake_chime &&
      !actions->end_chime && !actions->mode_flash && !actions->talk_held;
}

/* The four rows come straight from the loop's two published facts. */
static void the_state_is_the_loops_two_facts(void) {
  assert(havpe_session_classify(false, false) == HAVPE_SESSION_IDLE);
  assert(havpe_session_classify(true, false) == HAVPE_SESSION_WAKING);
  assert(havpe_session_classify(true, true) == HAVPE_SESSION_IN_CALL);
  assert(havpe_session_classify(false, true) == HAVPE_SESSION_ENDING);
}

/* Open-mic: the tap is the wake (chime, session opens), the next tap the
 * end, and a hold is never anything — leaning cannot wake or hang up. */
static void a_tap_wakes_an_open_mic_idle_and_a_hold_ends_it(void) {
  struct havpe_session session = {0};
  struct havpe_session_actions actions =
      drive(&session, true, false, false, false, false);
  assert(actions.start_call && actions.wake_chime);
  assert(!actions.end_call && !actions.mode_flash && !actions.talk_held);
  /*
   * THE MID-CALL TAP IS NOTHING: any reflexive press the instant a call
   * opened used to say "call ended" to a person who meant nothing by it.
   */
  actions = drive(&session, true, false, true, false, false);
  assert(!actions.end_call && !actions.start_call && !actions.wake_chime);
  actions = drive(&session, true, false, true, true, false);
  assert(!actions.end_call && !actions.start_call && !actions.wake_chime);
  /* An ordinary press crossing the 250 ms talk threshold is still nothing:
   * the hold level alone must not hang up. */
  actions = drive(&session, false, true, true, true, false);
  assert(!actions.end_call && !actions.talk_held && !actions.start_call);
  /* Ending is deliberate: the 800 ms latch, fired while still pressed. */
  {
    const struct havpe_session_poll poll = {
      .tap = false,
      .held = true,
      .end_hold = true,
      .wants_call = true,
      .call_active = true,
      .push_to_talk = false,
    };
    havpe_session_step(&session, &poll, &actions);
  }
  assert(actions.end_call && !actions.start_call && !actions.wake_chime);
  /* ...and the return to idle says "call ended", exactly once. */
  actions = drive(&session, false, false, false, false, false);
  assert(actions.end_chime && !actions.start_call && !actions.wake_chime);
  actions = drive(&session, false, false, false, false, false);
  assert(quiet(&actions));
}

/*
 * DEFECT 2'S FIX: in a push-to-talk mode THE HOLD IS THE WAKE — chime, session
 * and first turn in one gesture, on the rising edge only — and the bare tap
 * that used to open a call nobody could talk to now only flashes the mode.
 */
static void the_hold_is_the_wake_in_push_to_talk(void) {
  struct havpe_session session = {0};
  struct havpe_session_actions actions =
      drive(&session, false, true, false, false, true);
  assert(actions.start_call && actions.wake_chime && actions.talk_held);
  /* The level persists; the edge is spent. */
  actions = drive(&session, false, true, true, true, true);
  assert(actions.talk_held && !actions.start_call && !actions.wake_chime);
  /* Release, and a later in-call hold is a plain turn, not a wake. */
  actions = drive(&session, false, false, true, true, true);
  assert(quiet(&actions));
  actions = drive(&session, false, true, true, true, true);
  assert(actions.talk_held && !actions.start_call && !actions.wake_chime);
}

static void a_bare_tap_in_push_to_talk_only_flashes_the_mode(void) {
  struct havpe_session session = {0};
  const struct havpe_session_actions actions =
      drive(&session, true, false, false, false, true);
  assert(actions.mode_flash);
  assert(!actions.start_call && !actions.wake_chime && !actions.end_call);
  assert(!actions.talk_held && !actions.end_chime);
}

/*
 * DEFECT 1'S FIX, board half: when the far end ends the session (hang_up,
 * idle timeout) the loop clears both facts, and NOTHING here re-arms — not
 * room noise (there is no such input), not a button still held across the
 * end. The end is announced once, and only the next wake press opens the
 * next session.
 */
static void an_ended_session_stays_ended_until_the_next_wake(void) {
  struct havpe_session session = {0};
  /* A push-to-talk hold spans the model's hang-up... */
  struct havpe_session_actions actions =
      drive(&session, false, true, false, false, true);
  assert(actions.start_call);
  actions = drive(&session, false, true, true, true, true);
  assert(actions.talk_held);
  /* ...the loop clears wants_call and call_active; the end says so once,
   * and the held level must not mint anything however long it is leaned
   * on. */
  actions = drive(&session, false, true, false, false, true);
  assert(actions.end_chime && !actions.start_call && !actions.talk_held);
  actions = drive(&session, false, true, false, false, true);
  assert(quiet(&actions));
  /* Release-and-hold is the next wake. */
  actions = drive(&session, false, false, false, false, true);
  assert(quiet(&actions));
  actions = drive(&session, false, true, false, false, true);
  assert(actions.start_call && actions.wake_chime && !actions.end_chime);
}

/* While the teardown is on the wire the button waits for idle — including
 * the hold level, whose rising edge would otherwise reopen the session this
 * grammar just closed through the loop's own talk-edge handler. The
 * announcement rides the eventual arrival at idle. */
static void ending_ignores_the_button(void) {
  struct havpe_session session = {0};
  struct havpe_session_actions actions =
      drive(&session, true, false, false, true, false);
  assert(quiet(&actions));
  actions = drive(&session, false, true, false, true, true);
  assert(quiet(&actions));
  actions = drive(&session, false, false, false, false, true);
  assert(actions.end_chime);
}

int main(void) {
  the_mode_table_matches_the_provisioned_streams();
  a_full_cycle_is_two_counts();
  bounce_and_stalls_count_nothing();
  an_ambiguous_jump_is_dropped();
  a_spin_settles_once_on_the_final_mode();
  backward_detents_wrap();
  a_call_cancels_an_unsettled_spin();
  settling_in_place_still_answers();
  the_state_is_the_loops_two_facts();
  a_tap_wakes_an_open_mic_idle_and_a_hold_ends_it();
  the_hold_is_the_wake_in_push_to_talk();
  a_bare_tap_in_push_to_talk_only_flashes_the_mode();
  an_ended_session_stays_ended_until_the_next_wake();
  ending_ignores_the_button();
  return 0;
}
