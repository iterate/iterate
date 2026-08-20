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

/* What the centre button MEANS in which state is the shared session
 * grammar's — tests/session_grammar_test.c, `open_mic` and `held_call_ptt`
 * postures. This file keeps the parts that are this board's alone. */

int main(void) {
  the_mode_table_matches_the_provisioned_streams();
  a_full_cycle_is_two_counts();
  bounce_and_stalls_count_nothing();
  an_ambiguous_jump_is_dropped();
  a_spin_settles_once_on_the_final_mode();
  backward_detents_wrap();
  a_call_cancels_an_unsettled_spin();
  settling_in_place_still_answers();
  return 0;
}
