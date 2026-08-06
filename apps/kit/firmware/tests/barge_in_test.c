#include "iterate/kit/barge_in.h"

#include <assert.h>
#include <stddef.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

/* The failure this exists for: an answer thrown away because the room was
 * not silent enough for the provider's taste. */
static void a_quiet_room_cannot_interrupt(void) {
  struct iterate_kit_barge_in gate = {0};
  iterate_kit_barge_in_observe(&gate, 40U, 1000U);   /* echo residual */
  iterate_kit_barge_in_observe(&gate, 250U, 1020U);  /* worst residual seen */
  assert(!iterate_kit_barge_in_admit(&gate, 1030U));
  assert(gate.rejected == 1U && gate.admitted == 0U);
}

static void a_person_speaking_can(void) {
  struct iterate_kit_barge_in gate = {0};
  iterate_kit_barge_in_observe(&gate, 900U, 5000U);
  assert(iterate_kit_barge_in_admit(&gate, 5100U));
  assert(gate.admitted == 1U);
}

/* Loud once, a minute ago, is not permission now. */
static void the_evidence_expires(void) {
  struct iterate_kit_barge_in gate = {0};
  iterate_kit_barge_in_observe(&gate, 4000U, 1000U);
  assert(iterate_kit_barge_in_admit(
      &gate, 1000U + (uint64_t)ITERATE_KIT_BARGE_IN_WINDOW_MS));
  assert(!iterate_kit_barge_in_admit(
      &gate, 1001U + (uint64_t)ITERATE_KIT_BARGE_IN_WINDOW_MS));
}

/* A device that has never heard anything must not flush on hearsay. */
static void silence_since_boot_never_admits(void) {
  struct iterate_kit_barge_in gate = {0};
  assert(!iterate_kit_barge_in_admit(&gate, 0U));
  assert(!iterate_kit_barge_in_admit(&gate, 100000U));
}

/* A stamp from the future reads as "just now", never as an eternity ago. */
static void a_clock_that_ran_ahead_does_not_latch_it_shut(void) {
  struct iterate_kit_barge_in gate = {0};
  iterate_kit_barge_in_observe(&gate, 1200U, 9000U);
  assert(iterate_kit_barge_in_admit(&gate, 8999U));
}

/* No gate at all is the old behaviour, and it must stay permissive. */
static void an_absent_gate_admits(void) {
  assert(iterate_kit_barge_in_admit(NULL, 0U));
}

/* The uplink and the barge-in gate must never disagree about the room. */
static void the_uplink_and_the_flush_share_one_answer(void) {
  struct iterate_kit_barge_in gate = {0};
  iterate_kit_barge_in_observe(&gate, 60U, 1000U);
  assert(!iterate_kit_barge_in_person_present(&gate, 1010U));
  iterate_kit_barge_in_observe(&gate, 1500U, 1020U);
  assert(iterate_kit_barge_in_person_present(&gate, 1030U));
  /* ...and asking does not consume the evidence. */
  assert(iterate_kit_barge_in_person_present(&gate, 1030U));
  assert(gate.admitted == 0U && gate.rejected == 0U);
}

/* The prompt that caused an answer is not permission to talk over it. */
static void starting_to_speak_forgets_the_prompt(void) {
  struct iterate_kit_barge_in gate = {0};
  iterate_kit_barge_in_observe(&gate, 2000U, 1000U);
  assert(iterate_kit_barge_in_person_present(&gate, 1100U));
  iterate_kit_barge_in_forget(&gate);
  assert(!iterate_kit_barge_in_person_present(&gate, 1100U));
  /* ...and a genuine interruption still opens it immediately. */
  iterate_kit_barge_in_observe(&gate, 2000U, 1200U);
  assert(iterate_kit_barge_in_person_present(&gate, 1210U));
}

int main(void) {
  starting_to_speak_forgets_the_prompt();
  the_uplink_and_the_flush_share_one_answer();
  a_quiet_room_cannot_interrupt();
  a_person_speaking_can();
  the_evidence_expires();
  silence_since_boot_never_admits();
  a_clock_that_ran_ahead_does_not_latch_it_shut();
  an_absent_gate_admits();
  return 0;
}
