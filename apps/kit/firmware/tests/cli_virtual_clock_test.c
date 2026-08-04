#include "cli_virtual_clock.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

/*
 * This module exists because of one defect: a healthy call torn down and
 * rebuilt 42 times in three minutes, because `now - since` ran on unsigned
 * stamps and one stamp arrived a millisecond behind another. The subtraction
 * underflowed to 18446744073709551615 and every supervision deadline in the
 * process compared true at once.
 *
 * No host run could reach that branch: CLOCK_MONOTONIC does not go backwards.
 * So the test that matters is the one proving this clock CAN, on purpose,
 * bounded, and counted.
 */

static struct cli_fault_schedule skew_schedule(
    struct cli_fault_schedule *schedule, uint32_t per_minute)
{
  struct cli_fault_recipe recipe;
  memset(&recipe, 0, sizeof(recipe));
  recipe.session_ms = 600000U;
  recipe.clock_skews_per_minute = per_minute;
  recipe.clock_skew_max_ms = 40U;
  assert(cli_fault_schedule_generate(schedule, 0x5EEDULL, &recipe) ==
         CLI_FAULT_SCHEDULE_OK);
  return *schedule;
}

/* Turning the knob off must leave the rig byte-identical to what it was. */
static void an_undistorted_clock_returns_the_host_unchanged(void)
{
  struct cli_virtual_clock clock;
  assert(cli_virtual_clock_anchor(
             &clock, 1000U, CLI_VIRTUAL_CLOCK_RATE_UNIT, NULL) ==
         CLI_VIRTUAL_CLOCK_OK);
  assert(cli_virtual_clock_sample(&clock, 1000U) == 0U);
  assert(cli_virtual_clock_sample(&clock, 1500U) == 500U);
  assert(cli_virtual_clock_sample(&clock, 61000U) == 60000U);
  assert(clock.skew_stamps == 0U);
  assert(clock.jitter_stamps == 0U);
}

/*
 * A sealed run reads no clock at all, so the same seed replays bit for bit.
 * This is where regressions are gated and where a failure is a fact rather
 * than a report.
 */
static void a_sealed_clock_replays_bit_for_bit(void)
{
  struct cli_fault_schedule schedule;
  struct cli_virtual_clock first;
  struct cli_virtual_clock second;
  uint64_t first_stamps[64];
  uint64_t second_stamps[64];
  size_t step;

  (void)skew_schedule(&schedule, 2U);
  assert(cli_virtual_clock_seal(&first, &schedule) == CLI_VIRTUAL_CLOCK_OK);
  assert(cli_virtual_clock_seal(&second, &schedule) == CLI_VIRTUAL_CLOCK_OK);
  for (step = 0U; step < 64U; step++) {
    /* The host stamp is deliberately different between the two runs; a
     * sealed clock must not be able to tell. */
    assert(cli_virtual_clock_advance(&first, 5000U) == CLI_VIRTUAL_CLOCK_OK);
    assert(cli_virtual_clock_advance(&second, 5000U) == CLI_VIRTUAL_CLOCK_OK);
    first_stamps[step] = cli_virtual_clock_sample(&first, 111U);
    second_stamps[step] = cli_virtual_clock_sample(&second, 999999U);
  }
  assert(memcmp(first_stamps, second_stamps, sizeof(first_stamps)) == 0);
  assert(first.skew_stamps == second.skew_stamps);
}

/* THE defect. A stamp behind one already issued, bounded and counted. */
static void a_skew_hands_back_a_stamp_that_went_backwards(void)
{
  struct cli_fault_schedule schedule;
  struct cli_virtual_clock clock;
  uint64_t previous = 0U;
  uint64_t step;
  bool saw_backwards = false;

  (void)skew_schedule(&schedule, 6U);
  assert(cli_virtual_clock_seal(&clock, &schedule) == CLI_VIRTUAL_CLOCK_OK);
  for (step = 0U; step < 2000U; step++) {
    uint64_t stamp;
    assert(cli_virtual_clock_advance(&clock, 300U) == CLI_VIRTUAL_CLOCK_OK);
    stamp = cli_virtual_clock_sample(&clock, 0U);
    if (stamp < previous) saw_backwards = true;
    previous = stamp;
  }
  assert(saw_backwards);
  assert(clock.skew_stamps > 0U);
  /*
   * And more than one, because a recipe asking for several skews must get
   * several. An earlier version spent a single latch for the whole run, so a
   * six-per-minute recipe produced exactly one backwards stamp in ten
   * minutes and the knob looked far weaker than it was.
   */
  assert(clock.skews_spent > 1U);
}

/* Without a skew episode the clock never goes backwards, whatever else it does. */
static void jitter_alone_never_moves_a_stamp_backwards(void)
{
  struct cli_fault_schedule schedule;
  struct cli_fault_recipe recipe;
  struct cli_virtual_clock clock;
  uint64_t previous = 0U;
  uint64_t step;

  memset(&recipe, 0, sizeof(recipe));
  recipe.session_ms = 60000U;
  recipe.clock_jitter_ms = 25U;
  assert(cli_fault_schedule_generate(&schedule, 99U, &recipe) ==
         CLI_FAULT_SCHEDULE_OK);
  assert(cli_virtual_clock_seal(&clock, &schedule) == CLI_VIRTUAL_CLOCK_OK);
  for (step = 0U; step < 500U; step++) {
    uint64_t stamp;
    assert(cli_virtual_clock_advance(&clock, 100U) == CLI_VIRTUAL_CLOCK_OK);
    stamp = cli_virtual_clock_sample(&clock, 0U);
    assert(stamp >= previous);
    previous = stamp;
  }
  assert(clock.jitter_stamps > 0U);
  assert(clock.skew_stamps == 0U);
}

/* A rate multiplier makes an hour of session take as long as the arithmetic. */
static void a_rate_multiplier_scales_the_session(void)
{
  struct cli_virtual_clock clock;
  assert(cli_virtual_clock_anchor(
             &clock, 0U, 10U * CLI_VIRTUAL_CLOCK_RATE_UNIT, NULL) ==
         CLI_VIRTUAL_CLOCK_OK);
  assert(cli_virtual_clock_sample(&clock, 1000U) == 10000U);
  assert(cli_virtual_clock_anchor(&clock, 0U, 0U, NULL) ==
         CLI_VIRTUAL_CLOCK_ERR_RANGE);
  assert(cli_virtual_clock_anchor(
             &clock, 0U, CLI_VIRTUAL_CLOCK_MAX_RATE + 1U, NULL) ==
         CLI_VIRTUAL_CLOCK_ERR_RANGE);
}

/*
 * Two sources of truth would leave no way to say which produced a stamp, so
 * pushing time into an anchored clock is refused rather than blended.
 */
static void only_a_sealed_clock_can_be_pushed(void)
{
  struct cli_virtual_clock clock;
  assert(cli_virtual_clock_anchor(
             &clock, 0U, CLI_VIRTUAL_CLOCK_RATE_UNIT, NULL) ==
         CLI_VIRTUAL_CLOCK_OK);
  assert(cli_virtual_clock_advance(&clock, 10U) == CLI_VIRTUAL_CLOCK_ERR_ARG);
  assert(cli_virtual_clock_seal(&clock, NULL) == CLI_VIRTUAL_CLOCK_OK);
  assert(cli_virtual_clock_advance(&clock, 10U) == CLI_VIRTUAL_CLOCK_OK);
  assert(cli_virtual_clock_sample(&clock, 0U) == 10U);
  assert(cli_virtual_clock_advance(NULL, 1U) == CLI_VIRTUAL_CLOCK_ERR_ARG);
}

/*
 * A host clock that appears to run backwards — which is what a re-anchor or a
 * suspended laptop looks like — must not underflow into a stamp near 2^64.
 * That is the very arithmetic this module exists to make reachable, and it
 * must not be reachable by ACCIDENT inside the clock itself.
 */
static void a_host_stamp_behind_the_anchor_does_not_underflow(void)
{
  struct cli_virtual_clock clock;
  assert(cli_virtual_clock_anchor(
             &clock, 10000U, CLI_VIRTUAL_CLOCK_RATE_UNIT, NULL) ==
         CLI_VIRTUAL_CLOCK_OK);
  assert(cli_virtual_clock_sample(&clock, 9000U) == 0U);
}

/* The callback form the voicelab options want, with the clock as context. */
static void the_callback_form_works_and_needs_no_clock_when_sealed(void)
{
  struct cli_virtual_clock clock;
  assert(cli_virtual_clock_seal(&clock, NULL) == CLI_VIRTUAL_CLOCK_OK);
  assert(cli_virtual_clock_advance(&clock, 40U) == CLI_VIRTUAL_CLOCK_OK);
  assert(cli_virtual_clock_now_ms(&clock) == 40U);
  assert(cli_virtual_clock_now_us(&clock) == 40000U);
  /* A NULL context is answered rather than dereferenced. */
  assert(cli_virtual_clock_now_ms(NULL) == 0U);
  assert(strcmp(cli_virtual_clock_status_name(CLI_VIRTUAL_CLOCK_ERR_RANGE),
                "range") == 0);
}

int main(void)
{
  an_undistorted_clock_returns_the_host_unchanged();
  a_sealed_clock_replays_bit_for_bit();
  a_skew_hands_back_a_stamp_that_went_backwards();
  jitter_alone_never_moves_a_stamp_backwards();
  a_rate_multiplier_scales_the_session();
  only_a_sealed_clock_can_be_pushed();
  a_host_stamp_behind_the_anchor_does_not_underflow();
  the_callback_form_works_and_needs_no_clock_when_sealed();
  printf("cli_virtual_clock_test ok\n");
  return 0;
}
