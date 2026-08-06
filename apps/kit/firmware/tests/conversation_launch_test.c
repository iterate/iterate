#include "iterate/kit/conversation_launch.h"

#include <assert.h>
#include <stddef.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

/** An idle device holding a used stream, which is where every case starts. */
static struct iterate_kit_launch_inputs idle_at(uint64_t now_ms) {
  struct iterate_kit_launch_inputs inputs = {0};
  inputs.link_ready = true;
  inputs.stream_used = true;
  inputs.now_ms = now_ms;
  return inputs;
}

/*
 * THE MEASURED DEFECT. An idle prepare arms a 30s retry; a person presses the
 * button two seconds later. Before the deadlines were split, the press read the
 * idle backoff and stood there for the rest of it — 21.5s to reach the server
 * against 2.6s for the press before it, on the HA Voice PE.
 */
static void a_press_never_waits_on_the_idle_backoff(void) {
  struct iterate_kit_launch launch = {0};
  struct iterate_kit_launch_inputs inputs = idle_at(1000U);

  assert(
      iterate_kit_launch_next_step(&launch, &inputs) ==
      ITERATE_KIT_LAUNCH_PREPARE_AHEAD);

  /* Two seconds later somebody presses, and the stream is still the old one. */
  inputs.now_ms = 3000U;
  inputs.wants_call = true;
  assert(
      iterate_kit_launch_next_step(&launch, &inputs) ==
      ITERATE_KIT_LAUNCH_PREPARE_NOW);
}

/* …and the idle prepare's own retry really is slow, so an idle device is not
 * minting a conversation stream every tick. */
static void an_idle_prepare_retries_slowly(void) {
  struct iterate_kit_launch launch = {0};
  struct iterate_kit_launch_inputs inputs = idle_at(0U);

  assert(
      iterate_kit_launch_next_step(&launch, &inputs) ==
      ITERATE_KIT_LAUNCH_PREPARE_AHEAD);
  inputs.now_ms = ITERATE_KIT_LAUNCH_PREPARE_AHEAD_RETRY_MS - 1U;
  assert(
      iterate_kit_launch_next_step(&launch, &inputs) ==
      ITERATE_KIT_LAUNCH_NOTHING);
  inputs.now_ms = ITERATE_KIT_LAUNCH_PREPARE_AHEAD_RETRY_MS;
  assert(
      iterate_kit_launch_next_step(&launch, &inputs) ==
      ITERATE_KIT_LAUNCH_PREPARE_AHEAD);
}

/* The payoff: a press onto an already-prepared stream places the call at once. */
static void a_prepared_stream_makes_a_press_immediate(void) {
  struct iterate_kit_launch launch = {0};
  struct iterate_kit_launch_inputs inputs = idle_at(5000U);
  inputs.stream_used = false;
  inputs.wants_call = true;

  assert(
      iterate_kit_launch_next_step(&launch, &inputs) ==
      ITERATE_KIT_LAUNCH_PLACE_CALL);
}

/* Nothing is prepared ahead while a fresh stream is already in hand. */
static void nothing_is_prepared_when_one_is_ready(void) {
  struct iterate_kit_launch launch = {0};
  struct iterate_kit_launch_inputs inputs = idle_at(0U);
  inputs.stream_used = false;

  assert(
      iterate_kit_launch_next_step(&launch, &inputs) ==
      ITERATE_KIT_LAUNCH_NOTHING);
}

/* A call in flight, a call up, or a prepare in flight: never a second attempt. */
static void one_thing_at_a_time(void) {
  struct iterate_kit_launch launch = {0};
  struct iterate_kit_launch_inputs inputs = idle_at(0U);
  inputs.wants_call = true;
  inputs.stream_used = false;

  inputs.call_active = true;
  assert(
      iterate_kit_launch_next_step(&launch, &inputs) ==
      ITERATE_KIT_LAUNCH_NOTHING);
  inputs.call_active = false;
  inputs.call_pending = true;
  assert(
      iterate_kit_launch_next_step(&launch, &inputs) ==
      ITERATE_KIT_LAUNCH_NOTHING);
  inputs.call_pending = false;
  inputs.preparing = true;
  assert(
      iterate_kit_launch_next_step(&launch, &inputs) ==
      ITERATE_KIT_LAUNCH_NOTHING);
  /* …and with all three clear it goes, proving the guards did the refusing. */
  inputs.preparing = false;
  assert(
      iterate_kit_launch_next_step(&launch, &inputs) ==
      ITERATE_KIT_LAUNCH_PLACE_CALL);
}

/* A request that cannot be sent is not an attempt, and must not arm a backoff. */
static void a_link_that_cannot_carry_it_costs_nothing(void) {
  struct iterate_kit_launch launch = {0};
  struct iterate_kit_launch_inputs inputs = idle_at(0U);
  inputs.wants_call = true;
  inputs.stream_used = false;
  inputs.link_ready = false;

  assert(
      iterate_kit_launch_next_step(&launch, &inputs) ==
      ITERATE_KIT_LAUNCH_NOTHING);
  inputs.link_ready = true;
  assert(
      iterate_kit_launch_next_step(&launch, &inputs) ==
      ITERATE_KIT_LAUNCH_PLACE_CALL);
}

/* Placing retries on its own clock, not the prepare's. */
static void placing_has_its_own_deadline(void) {
  struct iterate_kit_launch launch = {0};
  struct iterate_kit_launch_inputs inputs = idle_at(0U);
  inputs.wants_call = true;
  inputs.stream_used = false;

  assert(
      iterate_kit_launch_next_step(&launch, &inputs) ==
      ITERATE_KIT_LAUNCH_PLACE_CALL);
  inputs.now_ms = ITERATE_KIT_LAUNCH_PLACE_RETRY_MS - 1U;
  assert(
      iterate_kit_launch_next_step(&launch, &inputs) ==
      ITERATE_KIT_LAUNCH_NOTHING);
  inputs.now_ms = ITERATE_KIT_LAUNCH_PLACE_RETRY_MS;
  assert(
      iterate_kit_launch_next_step(&launch, &inputs) ==
      ITERATE_KIT_LAUNCH_PLACE_CALL);
}

/* A detected failure must not then be made to wait out the old deadline. */
static void retry_now_clears_every_deadline(void) {
  struct iterate_kit_launch launch = {0};
  struct iterate_kit_launch_inputs inputs = idle_at(0U);
  inputs.wants_call = true;
  inputs.stream_used = false;

  assert(
      iterate_kit_launch_next_step(&launch, &inputs) ==
      ITERATE_KIT_LAUNCH_PLACE_CALL);
  inputs.now_ms = 100U;
  assert(
      iterate_kit_launch_next_step(&launch, &inputs) ==
      ITERATE_KIT_LAUNCH_NOTHING);
  iterate_kit_launch_retry_now(&launch);
  assert(
      iterate_kit_launch_next_step(&launch, &inputs) ==
      ITERATE_KIT_LAUNCH_PLACE_CALL);
}

/* Null arguments answer "do nothing" rather than dereferencing. */
static void nothing_is_dereferenced_blind(void) {
  struct iterate_kit_launch launch = {0};
  struct iterate_kit_launch_inputs inputs = idle_at(0U);

  assert(
      iterate_kit_launch_next_step(NULL, &inputs) ==
      ITERATE_KIT_LAUNCH_NOTHING);
  assert(
      iterate_kit_launch_next_step(&launch, NULL) ==
      ITERATE_KIT_LAUNCH_NOTHING);
  iterate_kit_launch_retry_now(NULL);
}

int main(void) {
  a_press_never_waits_on_the_idle_backoff();
  an_idle_prepare_retries_slowly();
  a_prepared_stream_makes_a_press_immediate();
  nothing_is_prepared_when_one_is_ready();
  one_thing_at_a_time();
  a_link_that_cannot_carry_it_costs_nothing();
  placing_has_its_own_deadline();
  retry_now_clears_every_deadline();
  nothing_is_dereferenced_blind();
  return 0;
}
