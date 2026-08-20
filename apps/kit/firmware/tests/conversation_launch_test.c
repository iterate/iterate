#include "iterate/kit/conversation_launch.h"

#include <assert.h>
#include <stddef.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

/*
 * A STREAM IS NO LONGER A CONVERSATION.
 *
 * This seam used to decide between "mint a fresh stream first" and "place the
 * call", because a stream's identity WAS the call's identity. The server now
 * mints the call and says so with `call-started`, so one stream carries as
 * many conversations as the device has button presses, and the only question
 * left is whether to place one. The preparation half of the ladder, and the
 * `stream_used` / `preparing` inputs that drove it, are gone — see the header
 * for why keeping them was fatal rather than merely redundant.
 */

static struct iterate_kit_launch_inputs pressed(uint64_t now) {
  struct iterate_kit_launch_inputs inputs = {0};
  inputs.link_ready = true;
  inputs.wants_call = true;
  inputs.now_ms = now;
  return inputs;
}

/* The press is the whole trigger: no preparation stands between it and a call. */
static void a_press_places_a_call(void) {
  struct iterate_kit_launch launch = {0};
  struct iterate_kit_launch_inputs inputs = pressed(1000U);
  assert(iterate_kit_launch_next_step(&launch, &inputs) == ITERATE_KIT_LAUNCH_PLACE_CALL);
}

/* Nothing happens unasked. Idling must never dial on its own. */
static void idling_does_nothing(void) {
  struct iterate_kit_launch launch = {0};
  struct iterate_kit_launch_inputs inputs = pressed(1000U);
  inputs.wants_call = false;
  assert(iterate_kit_launch_next_step(&launch, &inputs) == ITERATE_KIT_LAUNCH_NOTHING);
}

/*
 * ONE THING AT A TIME. A second attempt while a call is live or pending races
 * the first, and two calls on one device is worse than none.
 */
static void one_thing_at_a_time(void) {
  struct iterate_kit_launch launch = {0};
  struct iterate_kit_launch_inputs inputs = pressed(1000U);

  inputs.call_active = true;
  assert(iterate_kit_launch_next_step(&launch, &inputs) == ITERATE_KIT_LAUNCH_NOTHING);
  inputs.call_active = false;

  inputs.call_pending = true;
  assert(iterate_kit_launch_next_step(&launch, &inputs) == ITERATE_KIT_LAUNCH_NOTHING);
}

/*
 * A link that cannot carry the request costs nothing to refuse — and must not
 * consume the deadline, or the press that arrives once the link is back gets
 * told to wait for a backoff it never earned.
 */
static void a_link_that_cannot_carry_it_costs_nothing(void) {
  struct iterate_kit_launch launch = {0};
  struct iterate_kit_launch_inputs inputs = pressed(1000U);
  inputs.link_ready = false;
  assert(iterate_kit_launch_next_step(&launch, &inputs) == ITERATE_KIT_LAUNCH_NOTHING);

  inputs.link_ready = true;
  assert(iterate_kit_launch_next_step(&launch, &inputs) == ITERATE_KIT_LAUNCH_PLACE_CALL);
}

/*
 * Placing has its own deadline, so a held button does not become a storm of
 * call requests while the first is still travelling.
 */
static void placing_has_its_own_deadline(void) {
  struct iterate_kit_launch launch = {0};
  struct iterate_kit_launch_inputs inputs = pressed(1000U);
  assert(iterate_kit_launch_next_step(&launch, &inputs) == ITERATE_KIT_LAUNCH_PLACE_CALL);

  inputs.now_ms = 1000U + ITERATE_KIT_LAUNCH_PLACE_RETRY_MS - 1U;
  assert(iterate_kit_launch_next_step(&launch, &inputs) == ITERATE_KIT_LAUNCH_NOTHING);

  inputs.now_ms = 1000U + ITERATE_KIT_LAUNCH_PLACE_RETRY_MS;
  assert(iterate_kit_launch_next_step(&launch, &inputs) == ITERATE_KIT_LAUNCH_PLACE_CALL);
}

/*
 * `retry_now` is what a fresh press means: whatever the device was waiting
 * out, the person in front of it has asked again and is owed an attempt.
 */
static void retry_now_clears_the_deadline(void) {
  struct iterate_kit_launch launch = {0};
  struct iterate_kit_launch_inputs inputs = pressed(1000U);
  assert(iterate_kit_launch_next_step(&launch, &inputs) == ITERATE_KIT_LAUNCH_PLACE_CALL);

  inputs.now_ms = 1500U;
  assert(iterate_kit_launch_next_step(&launch, &inputs) == ITERATE_KIT_LAUNCH_NOTHING);

  iterate_kit_launch_retry_now(&launch);
  assert(iterate_kit_launch_next_step(&launch, &inputs) == ITERATE_KIT_LAUNCH_PLACE_CALL);
}

/*
 * A DEADLINE FROM ANOTHER CLOCK MUST NOT SILENCE THE BUTTON.
 *
 * `next_place_ms` is only ever `now + PLACE_RETRY_MS`, so anything further out
 * came from a clock that moved. Measured on a Waveshare: 2018 consecutive
 * polls with the press held, every input green as the seam itself saw them,
 * and NOTHING returned every time — a board that never calls again.
 */
static void a_deadline_from_another_clock_is_ignored(void) {
  struct iterate_kit_launch launch = {0};
  struct iterate_kit_launch_inputs inputs = pressed(1000U);
  launch.next_place_ms = 5U * 60U * 1000U; /* minutes away; unreachable */
  assert(iterate_kit_launch_next_step(&launch, &inputs) == ITERATE_KIT_LAUNCH_PLACE_CALL);
}

/* An ordinary deadline, one interval out, is still honoured. */
static void an_ordinary_deadline_still_holds(void) {
  struct iterate_kit_launch launch = {0};
  struct iterate_kit_launch_inputs inputs = pressed(1000U);
  launch.next_place_ms = 1000U + ITERATE_KIT_LAUNCH_PLACE_RETRY_MS;
  assert(iterate_kit_launch_next_step(&launch, &inputs) == ITERATE_KIT_LAUNCH_NOTHING);
}

/* Never dereferenced blind: a null seam refuses rather than crashing a board. */
static void nothing_is_dereferenced_blind(void) {
  struct iterate_kit_launch launch = {0};
  struct iterate_kit_launch_inputs inputs = pressed(1000U);
  assert(iterate_kit_launch_next_step(NULL, &inputs) == ITERATE_KIT_LAUNCH_NOTHING);
  assert(iterate_kit_launch_next_step(&launch, NULL) == ITERATE_KIT_LAUNCH_NOTHING);
  iterate_kit_launch_retry_now(NULL);
}

int main(void) {
  a_press_places_a_call();
  idling_does_nothing();
  one_thing_at_a_time();
  a_link_that_cannot_carry_it_costs_nothing();
  placing_has_its_own_deadline();
  retry_now_clears_the_deadline();
  a_deadline_from_another_clock_is_ignored();
  an_ordinary_deadline_still_holds();
  nothing_is_dereferenced_blind();
  return 0;
}
