/*
 * The shared session grammar, driven the way each board drives it.
 *
 * One machine, four boards, and the boards differ only by the posture flags
 * in the poll — so the postures here are named after the boards that wear
 * them, and a scenario that fails is a board whose button means the wrong
 * thing, not a style disagreement.
 */
#include "iterate/kit/session_grammar.h"

#include <assert.h>

/*
 * The posture flags as each board sets them. `open_mic` is the HAVPE's
 * open-mic dial modes AND the StackChan's side button; `held_call_ptt` is
 * the HAVPE's push-to-talk modes (one button that is also the talk hold, so
 * a bare tap must not wake); `side_call_ptt` is the M5Stick (the call is its
 * own side button, taps wake and end); `held_wake_ptt` is the Waveshare
 * (the upper button's press edge wakes but must never end — every talk hold
 * begins with that edge — and the lower button is the dedicated end).
 */
struct posture {
  bool push_to_talk;
  bool tap_wakes;
  bool tap_ends;
};

static const struct posture open_mic = {false, false, true};
static const struct posture held_call_ptt = {true, false, true};
static const struct posture side_call_ptt = {true, true, true};
static const struct posture held_wake_ptt = {true, true, false};

/* One poll of the machine, spelled as the facts a pass carries. */
static struct iterate_kit_session_actions drive_at(
    struct iterate_kit_session *session,
    uint64_t now_ms,
    bool tap, bool held, bool wants_call, bool call_active,
    const struct posture *posture) {
  struct iterate_kit_session_actions actions;
  const struct iterate_kit_session_poll poll = {
    .tap = tap,
    .held = held,
    .wants_call = wants_call,
    .call_active = call_active,
    .push_to_talk = posture->push_to_talk,
    .tap_wakes = posture->tap_wakes,
    .tap_ends = posture->tap_ends,
    .now_ms = now_ms,
  };
  iterate_kit_session_step(session, &poll, &actions);
  return actions;
}

static struct iterate_kit_session_actions drive(
    struct iterate_kit_session *session,
    bool tap, bool held, bool wants_call, bool call_active,
    const struct posture *posture) {
  return drive_at(session, 0U, tap, held, wants_call, call_active, posture);
}

static bool quiet(const struct iterate_kit_session_actions *actions) {
  return !actions->start_call && !actions->end_call && !actions->wake_chime &&
      !actions->end_chime && !actions->mode_flash && !actions->talk_held;
}

/* The four rows come straight from the loop's two published facts. */
static void the_state_is_the_loops_two_facts(void) {
  assert(iterate_kit_session_classify(false, false) ==
      ITERATE_KIT_SESSION_IDLE);
  assert(iterate_kit_session_classify(true, false) ==
      ITERATE_KIT_SESSION_WAKING);
  assert(iterate_kit_session_classify(true, true) ==
      ITERATE_KIT_SESSION_IN_CALL);
  assert(iterate_kit_session_classify(false, true) ==
      ITERATE_KIT_SESSION_ENDING);
}

/* Open-mic: the tap is the wake (chime, session opens), the next tap the
 * end — after the grace — and a hold is never anything: leaning cannot wake
 * or hang up. */
static void a_tap_wakes_an_open_mic_idle_and_a_later_tap_ends_it(void) {
  struct iterate_kit_session session = {0};
  struct iterate_kit_session_actions actions =
      drive(&session, true, false, false, false, &open_mic);
  assert(actions.start_call && actions.wake_chime);
  assert(!actions.end_call && !actions.mode_flash && !actions.talk_held);
  /*
   * THE REFLEXIVE TAP IS STILL NOTHING: a press inside the grace window —
   * the instant the call opened — used to say "call ended" to a person who
   * meant nothing by it.
   */
  actions = drive_at(&session, 500U, true, false, true, false, &open_mic);
  assert(!actions.end_call && !actions.start_call && !actions.wake_chime);
  actions = drive_at(&session, 900U, true, false, true, true, &open_mic);
  assert(!actions.end_call && !actions.start_call && !actions.wake_chime);
  /* An ordinary press crossing the 250 ms talk threshold is still nothing:
   * the hold level alone must not hang up. */
  actions = drive_at(&session, 1200U, false, true, true, true, &open_mic);
  assert(!actions.end_call && !actions.talk_held && !actions.start_call);
  /*
   * PAST THE GRACE, THE TAP IS THE END — the gesture a person actually
   * tries on a one-button device. (The 800 ms hold still works too; a
   * fresh session below proves it ends even inside the grace.)
   */
  /* The grace runs from the poll that first showed the session (t=500). */
  actions = drive_at(
      &session, 500U + (uint64_t)ITERATE_KIT_SESSION_TAP_END_GRACE_MS + 100U,
      true, false, true, true, &open_mic);
  assert(actions.end_call && !actions.start_call && !actions.wake_chime);
  /* The deliberate 800 ms hold still ends a session, even inside the
   * grace: a fresh wake, then the latch. */
  {
    struct iterate_kit_session fresh = {0};
    struct iterate_kit_session_actions a2 =
        drive_at(&fresh, 10U, true, false, false, false, &open_mic);
    assert(a2.start_call);
    const struct iterate_kit_session_poll poll = {
      .tap = false,
      .held = true,
      .end_hold = true,
      .wants_call = true,
      .call_active = true,
      .push_to_talk = false,
      .tap_ends = true,
      .now_ms = 900U,
    };
    iterate_kit_session_step(&fresh, &poll, &a2);
    assert(a2.end_call && !a2.start_call);
  }
  /* ...and the return to idle says "call ended", exactly once. */
  actions = drive(&session, false, false, false, false, &open_mic);
  assert(actions.end_chime && !actions.start_call && !actions.wake_chime);
  actions = drive(&session, false, false, false, false, &open_mic);
  assert(quiet(&actions));
}

/*
 * In a push-to-talk posture THE HOLD IS THE WAKE — chime, session and first
 * turn in one gesture, on the rising edge only — whatever the board's tap
 * flags say, because the hold is the talk on every push-to-talk board.
 */
static void the_hold_is_the_wake_in_push_to_talk(void) {
  static const struct posture *ptt[] = {
    &held_call_ptt, &side_call_ptt, &held_wake_ptt,
  };
  for (unsigned index = 0U; index < 3U; ++index) {
    struct iterate_kit_session session = {0};
    struct iterate_kit_session_actions actions =
        drive(&session, false, true, false, false, ptt[index]);
    assert(actions.start_call && actions.wake_chime && actions.talk_held);
    /* The level persists; the edge is spent. */
    actions = drive(&session, false, true, true, true, ptt[index]);
    assert(actions.talk_held && !actions.start_call && !actions.wake_chime);
    /* Release, and a later in-call hold is a plain turn, not a wake. */
    actions = drive(&session, false, false, true, true, ptt[index]);
    assert(quiet(&actions));
    actions = drive(&session, false, true, true, true, ptt[index]);
    assert(actions.talk_held && !actions.start_call && !actions.wake_chime);
  }
}

/* Where the one button is also the talk hold (the HAVPE), a bare tap opens
 * nothing — a session a tap cannot talk to is the two-press jank — and
 * answers with the mode reminder instead. */
static void a_bare_tap_only_flashes_where_taps_do_not_wake(void) {
  struct iterate_kit_session session = {0};
  const struct iterate_kit_session_actions actions =
      drive(&session, true, false, false, false, &held_call_ptt);
  assert(actions.mode_flash);
  assert(!actions.start_call && !actions.wake_chime && !actions.end_call);
  assert(!actions.talk_held && !actions.end_chime);
}

/* Where the call control is its own button (the M5Stick side button), the
 * bare tap wakes — and the next tap ends, immediately: push-to-talk needs
 * no grace, because a hold there is a turn and the tap is unambiguous. */
static void a_tap_wakes_and_ends_where_the_call_is_its_own_button(void) {
  struct iterate_kit_session session = {0};
  struct iterate_kit_session_actions actions =
      drive(&session, true, false, false, false, &side_call_ptt);
  assert(actions.start_call && actions.wake_chime);
  assert(!actions.mode_flash && !actions.talk_held);
  /* Still waking: the tap already ends it. */
  actions = drive_at(&session, 100U, true, false, true, false, &side_call_ptt);
  assert(actions.end_call && !actions.start_call);
  actions = drive(&session, false, false, false, false, &side_call_ptt);
  assert(actions.end_chime);
}

/*
 * The Waveshare's posture: the upper button's press edge rides its own talk
 * hold, so the tap must wake (that is also what keeps the injected
 * button.press() a wake — injection raises only the edge, never the level)
 * but must NEVER end, or every turn would begin by hanging up. The lower
 * button is the dedicated end (`end_press`): it ends in any in-session
 * state, at once, and IDLE ignores it rather than minting a phantom end.
 */
static void a_dedicated_end_control_ends_and_the_talk_tap_never_does(void) {
  struct iterate_kit_session session = {0};
  struct iterate_kit_session_actions actions;
  /* An idle lower press is nothing. */
  {
    const struct iterate_kit_session_poll poll = {
      .end_press = true,
      .push_to_talk = true,
      .tap_wakes = true,
    };
    iterate_kit_session_step(&session, &poll, &actions);
    assert(quiet(&actions));
  }
  /* The injected press — the edge without the level — wakes. */
  actions = drive(&session, true, false, false, false, &held_wake_ptt);
  assert(actions.start_call && actions.wake_chime && !actions.talk_held);
  /* In-call, every talk hold begins with the same press edge: nothing. */
  actions = drive(&session, true, true, true, true, &held_wake_ptt);
  assert(actions.talk_held && !actions.end_call && !actions.start_call);
  /* The lower press ends it, mid-hold, no grace. */
  {
    const struct iterate_kit_session_poll poll = {
      .held = true,
      .end_press = true,
      .wants_call = true,
      .call_active = true,
      .push_to_talk = true,
      .tap_wakes = true,
    };
    iterate_kit_session_step(&session, &poll, &actions);
    assert(actions.end_call && actions.talk_held);
  }
  actions = drive(&session, false, false, false, false, &held_wake_ptt);
  assert(actions.end_chime);
}

/*
 * When the far end ends the session (hang_up, idle timeout) the loop clears
 * both facts, and NOTHING here re-arms — not room noise (there is no such
 * input), not a button still held across the end. The end is announced
 * once, and only the next wake press opens the next session.
 */
static void an_ended_session_stays_ended_until_the_next_wake(void) {
  struct iterate_kit_session session = {0};
  /* A push-to-talk hold spans the model's hang-up... */
  struct iterate_kit_session_actions actions =
      drive(&session, false, true, false, false, &held_call_ptt);
  assert(actions.start_call);
  actions = drive(&session, false, true, true, true, &held_call_ptt);
  assert(actions.talk_held);
  /* ...the loop clears wants_call and call_active; the end says so once,
   * and the held level must not mint anything however long it is leaned
   * on. */
  actions = drive(&session, false, true, false, false, &held_call_ptt);
  assert(actions.end_chime && !actions.start_call && !actions.talk_held);
  actions = drive(&session, false, true, false, false, &held_call_ptt);
  assert(quiet(&actions));
  /* Release-and-hold is the next wake. */
  actions = drive(&session, false, false, false, false, &held_call_ptt);
  assert(quiet(&actions));
  actions = drive(&session, false, true, false, false, &held_call_ptt);
  assert(actions.start_call && actions.wake_chime && !actions.end_chime);
}

/* While the teardown is on the wire every control waits for idle — the tap,
 * the hold level (whose rising edge would otherwise reopen the session this
 * grammar just closed through the loop's own talk-edge handler), and the
 * dedicated end control alike. The announcement rides the eventual arrival
 * at idle. */
static void ending_absorbs_every_control(void) {
  struct iterate_kit_session session = {0};
  struct iterate_kit_session_actions actions =
      drive(&session, true, false, false, true, &open_mic);
  assert(quiet(&actions));
  actions = drive(&session, false, true, false, true, &held_call_ptt);
  assert(quiet(&actions));
  actions = drive(&session, true, false, false, true, &side_call_ptt);
  assert(quiet(&actions));
  {
    const struct iterate_kit_session_poll poll = {
      .end_press = true,
      .call_active = true,
      .push_to_talk = true,
      .tap_wakes = true,
    };
    iterate_kit_session_step(&session, &poll, &actions);
    assert(quiet(&actions));
  }
  actions = drive(&session, false, false, false, false, &held_call_ptt);
  assert(actions.end_chime);
}

int main(void) {
  the_state_is_the_loops_two_facts();
  a_tap_wakes_an_open_mic_idle_and_a_later_tap_ends_it();
  the_hold_is_the_wake_in_push_to_talk();
  a_bare_tap_only_flashes_where_taps_do_not_wake();
  a_tap_wakes_and_ends_where_the_call_is_its_own_button();
  a_dedicated_end_control_ends_and_the_talk_tap_never_does();
  an_ended_session_stays_ended_until_the_next_wake();
  ending_absorbs_every_control();
  return 0;
}
