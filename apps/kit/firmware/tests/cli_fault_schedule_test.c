#include "cli_fault_schedule.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

/*
 * The property this module exists for is that a failure can be run again.
 * Everything below is that property from a different angle: the same seed
 * draws the same adversity, a different seed draws different adversity, and a
 * schedule survives the trip through a file — because a seed only reproduces
 * a run against the generator that drew it, and generators get edited.
 */

static struct cli_fault_recipe busy_recipe(void)
{
  struct cli_fault_recipe recipe;
  memset(&recipe, 0, sizeof(recipe));
  recipe.session_ms = 600000U;
  recipe.cpu_stalls_per_minute = 4U;
  recipe.cpu_stall_max_ms = 250U;
  recipe.clock_skews_per_minute = 1U;
  recipe.clock_skew_max_ms = 50U;
  recipe.clock_jitter_ms = 3U;
  recipe.wire_stalls_per_minute = 2U;
  recipe.wire_stall_max_ms = 4000U;
  recipe.wire_resets_per_session = 2U;
  recipe.wire_throttle_fps = 9U;
  recipe.frame_loss_one_in = 50U;
  recipe.frame_duplicate_one_in = 200U;
  recipe.frame_reorder_one_in = 100U;
  recipe.mic_short_one_in = 40U;
  recipe.mic_clip = true;
  return recipe;
}

/* The whole promise: one seed, one schedule, every time. */
static void a_seed_draws_the_same_adversity_every_time(void)
{
  struct cli_fault_schedule first;
  struct cli_fault_schedule second;
  struct cli_fault_recipe recipe = busy_recipe();

  assert(cli_fault_schedule_generate(&first, 0x8f31a44cULL, &recipe) ==
         CLI_FAULT_SCHEDULE_OK);
  assert(cli_fault_schedule_generate(&second, 0x8f31a44cULL, &recipe) ==
         CLI_FAULT_SCHEDULE_OK);
  assert(first.episode_count == second.episode_count);
  assert(memcmp(first.episodes, second.episodes,
                first.episode_count * sizeof(first.episodes[0])) == 0);
  assert(memcmp(first.fates, second.fates, sizeof(first.fates)) == 0);
  assert(memcmp(first.reorder_hold, second.reorder_hold,
                sizeof(first.reorder_hold)) == 0);
}

/*
 * And that it is a search rather than a ritual: two seeds must actually
 * explore different combinations, or the overnight run is one experiment
 * repeated until morning.
 */
static void a_different_seed_draws_different_adversity(void)
{
  struct cli_fault_schedule first;
  struct cli_fault_schedule second;
  struct cli_fault_recipe recipe = busy_recipe();

  assert(cli_fault_schedule_generate(&first, 1U, &recipe) ==
         CLI_FAULT_SCHEDULE_OK);
  assert(cli_fault_schedule_generate(&second, 2U, &recipe) ==
         CLI_FAULT_SCHEDULE_OK);
  assert(memcmp(first.fates, second.fates, sizeof(first.fates)) != 0);
}

/*
 * A knob nobody turned must leave the rig exactly as it was. If turning the
 * harness off is not free, nobody leaves it in.
 */
static void an_empty_recipe_leaves_the_rig_alone(void)
{
  struct cli_fault_schedule schedule;
  struct cli_fault_recipe recipe;
  uint32_t sequence;
  memset(&recipe, 0, sizeof(recipe));
  recipe.session_ms = 60000U;

  assert(cli_fault_schedule_generate(&schedule, 7U, &recipe) ==
         CLI_FAULT_SCHEDULE_OK);
  assert(schedule.empty);
  assert(schedule.episode_count == 0U);
  for (sequence = 0U; sequence < 4096U; sequence++) {
    uint32_t hold = 0U;
    assert(cli_fault_schedule_fate(&schedule, sequence, &hold) ==
           CLI_FRAME_FATE_DELIVER);
  }
  assert(!cli_fault_schedule_active(
      &schedule, CLI_FAULT_KIND_CPU_STALL, 30000U, NULL));
}

/* A cleared schedule is valid, so no consumer needs a NULL check. */
static void a_cleared_schedule_is_usable(void)
{
  struct cli_fault_schedule schedule;
  cli_fault_schedule_clear(&schedule);
  assert(schedule.empty);
  assert(cli_fault_schedule_fate(&schedule, 99U, NULL) ==
         CLI_FRAME_FATE_DELIVER);
  /* And a NULL one degrades to "nothing happens" rather than crashing. */
  assert(cli_fault_schedule_fate(NULL, 99U, NULL) == CLI_FRAME_FATE_DELIVER);
  assert(!cli_fault_schedule_active(NULL, CLI_FAULT_KIND_MIC_CLIP, 0U, NULL));
}

/*
 * The artifact has to survive a file, because a seed is only reproducible
 * against the generator that drew it. Holds ride along with fates: a replay
 * missing them would hold every frame for one frame and quietly be a
 * different experiment wearing the same seed.
 */
static void a_schedule_survives_the_trip_through_a_file(void)
{
  struct cli_fault_schedule written;
  struct cli_fault_schedule read;
  struct cli_fault_recipe recipe = busy_recipe();
  FILE *file;

  assert(cli_fault_schedule_generate(&written, 0xC0FFEEULL, &recipe) ==
         CLI_FAULT_SCHEDULE_OK);
  file = tmpfile();
  assert(file != NULL);
  assert(cli_fault_schedule_write_json(&written, file) ==
         CLI_FAULT_SCHEDULE_OK);
  rewind(file);
  assert(cli_fault_schedule_read_json(&read, file) == CLI_FAULT_SCHEDULE_OK);
  fclose(file);

  assert(read.seed == written.seed);
  assert(read.session_ms == written.session_ms);
  assert(read.episode_count == written.episode_count);
  assert(memcmp(read.episodes, written.episodes,
                read.episode_count * sizeof(read.episodes[0])) == 0);
  assert(memcmp(read.fates, written.fates, sizeof(read.fates)) == 0);
  assert(memcmp(read.reorder_hold, written.reorder_hold,
                sizeof(read.reorder_hold)) == 0);
}

/* Input this build cannot represent is refused, not partly believed. */
static void a_schedule_it_cannot_read_is_refused(void)
{
  struct cli_fault_schedule schedule;
  FILE *file = tmpfile();
  assert(file != NULL);
  assert(fputs("{\"seed\":1,\"sessionMs\":10,\"episodes\":[{\"kind\":"
               "\"warp-core-breach\",\"atMs\":0,\"durationMs\":1,"
               "\"magnitude\":0}]}",
               file) != EOF);
  rewind(file);
  assert(cli_fault_schedule_read_json(&schedule, file) ==
         CLI_FAULT_SCHEDULE_ERR_MALFORMED);
  fclose(file);
}

/*
 * Refusing beats truncating. A schedule quietly missing its last hour of
 * faults would make a clean run look like proof.
 */
static void too_much_adversity_is_refused_rather_than_trimmed(void)
{
  struct cli_fault_schedule schedule;
  struct cli_fault_recipe recipe;
  memset(&recipe, 0, sizeof(recipe));
  /* Long session, high rates: more episodes than the schedule can hold. */
  recipe.session_ms = 3600000U;
  recipe.cpu_stalls_per_minute = 60U;
  recipe.cpu_stall_max_ms = 10U;
  recipe.clock_skews_per_minute = 60U;
  recipe.clock_skew_max_ms = 10U;
  recipe.wire_stalls_per_minute = 60U;
  recipe.wire_stall_max_ms = 10U;

  assert(cli_fault_schedule_generate(&schedule, 3U, &recipe) ==
         CLI_FAULT_SCHEDULE_ERR_FULL);
}

/* A session with no duration is a typo, not a request. */
static void a_session_needs_a_length(void)
{
  struct cli_fault_schedule schedule;
  struct cli_fault_recipe recipe;
  memset(&recipe, 0, sizeof(recipe));
  assert(cli_fault_schedule_generate(&schedule, 1U, &recipe) ==
         CLI_FAULT_SCHEDULE_ERR_RANGE);
  assert(cli_fault_schedule_generate(NULL, 1U, &recipe) ==
         CLI_FAULT_SCHEDULE_ERR_ARG);
}

/* Sorted at generation, so a consumer walks with a cursor and never searches. */
static void episodes_come_back_in_the_order_they_happen(void)
{
  struct cli_fault_schedule schedule;
  struct cli_fault_recipe recipe = busy_recipe();
  size_t index;

  assert(cli_fault_schedule_generate(&schedule, 11U, &recipe) ==
         CLI_FAULT_SCHEDULE_OK);
  assert(schedule.episode_count > 1U);
  for (index = 1U; index < schedule.episode_count; index++) {
    assert(schedule.episodes[index - 1U].at_ms <=
           schedule.episodes[index].at_ms);
  }
}

/* An episode covers its own span and nothing either side of it. */
static void an_episode_is_active_only_while_it_runs(void)
{
  struct cli_fault_schedule schedule;
  struct cli_fault_recipe recipe;
  uint32_t magnitude = 0U;
  memset(&recipe, 0, sizeof(recipe));
  recipe.session_ms = 60000U;
  recipe.wire_throttle_fps = 9U;

  assert(cli_fault_schedule_generate(&schedule, 5U, &recipe) ==
         CLI_FAULT_SCHEDULE_OK);
  assert(cli_fault_schedule_active(
      &schedule, CLI_FAULT_KIND_WIRE_THROTTLE, 30000U, &magnitude));
  assert(magnitude == 9U);
  assert(!cli_fault_schedule_active(
      &schedule, CLI_FAULT_KIND_WIRE_THROTTLE, 60001U, NULL));
  /* A kind nobody asked for never fires. */
  assert(!cli_fault_schedule_active(
      &schedule, CLI_FAULT_KIND_CPU_STALL, 30000U, NULL));
}

/*
 * A rig that cannot hold a frame back must not report that it did, or the run
 * claims to have tested something it never ran.
 */
static void reordering_degrades_honestly_where_nothing_can_hold_a_frame(void)
{
  struct cli_fault_schedule schedule;
  struct cli_fault_recipe recipe;
  uint32_t sequence;
  bool saw_reorder = false;
  memset(&recipe, 0, sizeof(recipe));
  recipe.session_ms = 60000U;
  recipe.frame_reorder_one_in = 3U;

  assert(cli_fault_schedule_generate(&schedule, 17U, &recipe) ==
         CLI_FAULT_SCHEDULE_OK);
  for (sequence = 0U; sequence < CLI_FAULT_SCHEDULE_FATE_SLOTS; sequence++) {
    uint32_t hold = 0U;
    if (cli_fault_schedule_fate(&schedule, sequence, &hold) ==
        CLI_FRAME_FATE_REORDER) {
      saw_reorder = true;
      assert(hold >= 1U && hold <= CLI_FAULT_SCHEDULE_MAX_REORDER_HOLD);
      /* The same frame, asked by a caller with nowhere to put it. */
      assert(cli_fault_schedule_fate(&schedule, sequence, NULL) ==
             CLI_FRAME_FATE_DELIVER);
    }
  }
  assert(saw_reorder);
}

/* The fate table repeats, so a run of any length stays bounded. */
static void the_fate_table_wraps_rather_than_running_out(void)
{
  struct cli_fault_schedule schedule;
  struct cli_fault_recipe recipe;
  memset(&recipe, 0, sizeof(recipe));
  recipe.session_ms = 60000U;
  recipe.frame_loss_one_in = 7U;

  assert(cli_fault_schedule_generate(&schedule, 23U, &recipe) ==
         CLI_FAULT_SCHEDULE_OK);
  assert(cli_fault_schedule_fate(&schedule, 5U, NULL) ==
         cli_fault_schedule_fate(
             &schedule, 5U + CLI_FAULT_SCHEDULE_FATE_SLOTS, NULL));
}

static void statuses_and_kinds_have_names(void)
{
  assert(strcmp(cli_fault_schedule_status_name(CLI_FAULT_SCHEDULE_ERR_FULL),
                "full") == 0);
  assert(strcmp(cli_fault_kind_name(CLI_FAULT_KIND_CLOCK_SKEW),
                "clock-skew") == 0);
}

int main(void)
{
  a_seed_draws_the_same_adversity_every_time();
  a_different_seed_draws_different_adversity();
  an_empty_recipe_leaves_the_rig_alone();
  a_cleared_schedule_is_usable();
  a_schedule_survives_the_trip_through_a_file();
  a_schedule_it_cannot_read_is_refused();
  too_much_adversity_is_refused_rather_than_trimmed();
  a_session_needs_a_length();
  episodes_come_back_in_the_order_they_happen();
  an_episode_is_active_only_while_it_runs();
  reordering_degrades_honestly_where_nothing_can_hold_a_frame();
  the_fate_table_wraps_rather_than_running_out();
  statuses_and_kinds_have_names();
  printf("cli_fault_schedule_test ok\n");
  return 0;
}
