#include "cli_report.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

/*
 * The report is the only thing anybody reads after an unattended run, so its
 * failure mode is not a crash — it is a run that went badly and looks fine.
 * Every case here is a way that has already happened or nearly happened.
 */

static struct cli_report report;

/*
 * A turn that never committed has no duration to report. The predecessor
 * printed the raw clock instead — "answerMs=14088564" on a turn that lasted
 * eight seconds — and it did it on exactly the failed turns whose diagnosis
 * mattered most.
 */
static void a_turn_that_never_committed_reports_no_duration(void)
{
  cli_report_reset(&report);
  struct cli_report_turn *turn =
      cli_report_begin_turn(&report, "hello.wav", false, 1000U);
  assert(turn != NULL);
  turn->completed_ms = 14088564U;
  assert(cli_report_time_to_answer_ms(turn) == 0U);
  assert(cli_report_time_to_first_audio_ms(turn) == 0U);

  turn->committed_ms = 1500U;
  turn->first_audio_ms = 1900U;
  turn->completed_ms = 4500U;
  assert(cli_report_time_to_first_audio_ms(turn) == 400U);
  assert(cli_report_time_to_answer_ms(turn) == 3000U);
}

/*
 * Occupancy is bucketed, and the buckets have to be affordable. One per
 * millisecond of a 30-second ring is 120 KiB a turn and half a gigabyte for
 * an hour — a memory profile nobody chose for a resolution nobody wanted.
 */
static void the_occupancy_histogram_is_small_enough_to_keep(void)
{
  assert(sizeof(struct cli_report_turn) < 1024U);
  assert(CLI_REPORT_OCCUPANCY_BUCKETS * CLI_REPORT_OCCUPANCY_BUCKET_MS >=
         30000);
}

/* Percentiles come from the histogram, and the extremes are exact. */
static void occupancy_percentiles_track_the_observations(void)
{
  cli_report_reset(&report);
  struct cli_report_turn *turn =
      cli_report_begin_turn(&report, "count.wav", false, 0U);
  assert(turn != NULL);
  for (uint32_t index = 0U; index < 90U; ++index) {
    cli_report_observe_occupancy(turn, 2000U);
  }
  for (uint32_t index = 0U; index < 10U; ++index) {
    cli_report_observe_occupancy(turn, 0U);
  }
  assert(turn->occupancy_min_ms == 0U);
  assert(turn->occupancy_max_ms == 2000U);
  /* A tenth of the writes found the buffer empty — the p10 must show it. */
  assert(cli_report_occupancy_percentile(turn, 10U) == 0U);
  assert(cli_report_occupancy_percentile(turn, 50U) == 2000U);
}

/*
 * A run longer than the record must say so. Silently overwriting turns reads
 * as a run that quietly stopped failing.
 */
static void turns_past_the_limit_are_counted_not_forgotten(void)
{
  cli_report_reset(&report);
  for (size_t index = 0U; index < CLI_REPORT_MAX_TURNS; ++index) {
    assert(cli_report_begin_turn(&report, "x.wav", false, 0U) != NULL);
  }
  assert(cli_report_begin_turn(&report, "x.wav", false, 0U) == NULL);
  assert(report.count == CLI_REPORT_MAX_TURNS);
  assert(report.dropped == 1U);
}

/*
 * A failed turn must survive into the summary as a failure. The whole point
 * of the run is that one bad turn in forty is impossible to average away.
 */
static void one_bad_turn_survives_into_the_summary(void)
{
  cli_report_reset(&report);
  for (size_t index = 0U; index < 40U; ++index) {
    struct cli_report_turn *turn =
        cli_report_begin_turn(&report, "x.wav", index % 3U == 0U, 0U);
    assert(turn != NULL);
    turn->committed_ms = 100U;
    turn->first_audio_ms = 300U;
    turn->completed_ms = 2000U;
    turn->frames_played = 100U;
  }
  report.turns[17].failed = true;
  report.turns[17].frames_played = 0U;

  const struct cli_report_summary summary = {1U, 2U, 3U, 0U, 13U, 12U};
  const char *path = "/tmp/iterate-kit-cli-report-test.json";
  assert(cli_report_write(&report, &summary, path) == CLI_REPORT_OK);

  FILE *file = fopen(path, "rb");
  assert(file != NULL);
  static char body[262144];
  const size_t length = fread(body, 1U, sizeof(body) - 1U, file);
  body[length] = '\0';
  (void)fclose(file);
  assert(strstr(body, "\"failedTurns\":1") != NULL);
  assert(strstr(body, "\"turnsDropped\":0") != NULL);
  assert(strstr(body, "\"backOfficeSent\":13") != NULL);
  assert(strstr(body, "\"framesPlayed\":") != NULL);
  /* The minimum across turns is the failed one: a spread cannot hide it. */
  assert(strstr(body, "\"framesPlayed\":{\"min\":0") != NULL);
  (void)remove(path);
}

/* A quote in a filename must not produce JSON nobody can parse. */
static void an_awkward_utterance_name_is_escaped(void)
{
  cli_report_reset(&report);
  assert(cli_report_begin_turn(&report, "he said \"go\"\\now.wav", false, 0U) !=
         NULL);
  const struct cli_report_summary summary = {0U, 0U, 0U, 0U, 0U, 0U};
  const char *path = "/tmp/iterate-kit-cli-report-escape.json";
  assert(cli_report_write(&report, &summary, path) == CLI_REPORT_OK);

  FILE *file = fopen(path, "rb");
  assert(file != NULL);
  static char body[8192];
  const size_t length = fread(body, 1U, sizeof(body) - 1U, file);
  body[length] = '\0';
  (void)fclose(file);
  assert(strstr(body, "\\\"go\\\"") != NULL);
  assert(strstr(body, "\\\\now.wav") != NULL);
  (void)remove(path);
}

static void null_arguments_are_refused(void)
{
  const struct cli_report_summary summary = {0U, 0U, 0U, 0U, 0U, 0U};
  assert(cli_report_write(NULL, &summary, "/tmp/x.json") == CLI_REPORT_ERR_ARG);
  assert(cli_report_write(&report, NULL, "/tmp/x.json") == CLI_REPORT_ERR_ARG);
  assert(cli_report_write(&report, &summary, NULL) == CLI_REPORT_ERR_ARG);
  assert(cli_report_begin_turn(NULL, "x", false, 0U) == NULL);
  cli_report_observe_occupancy(NULL, 10U);
  assert(cli_report_occupancy_percentile(NULL, 50U) == 0U);
  assert(strcmp(cli_report_status_name(CLI_REPORT_ERR_OPEN), "cannot-open") ==
         0);
}

int main(void)
{
  a_turn_that_never_committed_reports_no_duration();
  the_occupancy_histogram_is_small_enough_to_keep();
  occupancy_percentiles_track_the_observations();
  turns_past_the_limit_are_counted_not_forgotten();
  one_bad_turn_survives_into_the_summary();
  an_awkward_utterance_name_is_escaped();
  null_arguments_are_refused();
  return 0;
}
