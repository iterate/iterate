/* cli_report.c: owns the per-turn record, its distributions, and the JSON. */

#include <assert.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cli_report.h"

enum {
  CLI_REPORT_PERCENT = 100,
  /* Reported spread. A mean hides the one turn in forty that stuttered. */
  CLI_REPORT_P10 = 10,
  CLI_REPORT_P50 = 50,
  CLI_REPORT_P90 = 90,
};

/** Reads one comparable quantity out of a turn. */
typedef uint64_t (*cli_report_metric_fn)(const struct cli_report_turn *turn);

static uint64_t cli_report_metric_first_audio(const struct cli_report_turn *t);
static uint64_t cli_report_metric_answer(const struct cli_report_turn *t);
static uint64_t cli_report_metric_sent(const struct cli_report_turn *t);
static uint64_t cli_report_metric_received(const struct cli_report_turn *t);
static uint64_t cli_report_metric_played(const struct cli_report_turn *t);
static uint64_t cli_report_metric_concealed(const struct cli_report_turn *t);
static uint64_t cli_report_metric_gaps(const struct cli_report_turn *t);
static uint64_t cli_report_metric_underruns(const struct cli_report_turn *t);
static uint64_t cli_report_metric_occupancy_min(
    const struct cli_report_turn *t);
static uint64_t cli_report_metric_occupancy_max(
    const struct cli_report_turn *t);

/**
 * Every quantity reported as a distribution, named once.
 *
 * A table rather than a call per metric, because the JSON key and the reader
 * then cannot drift apart, and adding a measurement is one line rather than
 * three places to remember.
 */
static const struct {
  const char *name;
  cli_report_metric_fn read;
} CLI_REPORT_METRICS[] = {
  {"timeToFirstAudioMs", cli_report_metric_first_audio},
  {"timeToAnswerCompleteMs", cli_report_metric_answer},
  {"framesSent", cli_report_metric_sent},
  {"framesReceived", cli_report_metric_received},
  {"framesPlayed", cli_report_metric_played},
  {"framesConcealed", cli_report_metric_concealed},
  {"sequenceGaps", cli_report_metric_gaps},
  {"underruns", cli_report_metric_underruns},
  {"ringOccupancyMinMs", cli_report_metric_occupancy_min},
  {"ringOccupancyMaxMs", cli_report_metric_occupancy_max},
};

enum {
  CLI_REPORT_METRIC_COUNT =
      (int)(sizeof(CLI_REPORT_METRICS) / sizeof(CLI_REPORT_METRICS[0])),
};

/* Writes `text` as a JSON string, escaping what must be escaped. */
static enum cli_report_status cli_report_write_string(
    FILE *file, const char *text);

/* Writes one turn object. `last` suppresses the trailing comma. */
static enum cli_report_status cli_report_write_turn(
    FILE *file, const struct cli_report_turn *turn, size_t index, bool last);

/* Writes one metric's min/p10/p50/p90/max across every turn. */
static enum cli_report_status cli_report_write_distribution(
    FILE *file,
    const struct cli_report *report,
    cli_report_metric_fn read);

/* The `percentile`-th value of `read` across every turn. */
static uint64_t cli_report_percentile(
    const struct cli_report *report,
    cli_report_metric_fn read,
    uint32_t percentile);

const char *cli_report_status_name(enum cli_report_status status)
{
  switch (status) {
    case CLI_REPORT_OK: return "ok";
    case CLI_REPORT_ERR_ARG: return "bad-argument";
    case CLI_REPORT_ERR_OPEN: return "cannot-open";
    case CLI_REPORT_ERR_IO: return "io";
    default: return "unknown";
  }
}

void cli_report_reset(struct cli_report *report)
{
  if (report == NULL) return;
  report->count = 0U;
  report->dropped = 0U;
}

struct cli_report_turn *cli_report_begin_turn(
    struct cli_report *report,
    const char *utterance,
    bool back_office,
    uint64_t now)
{
  if (report == NULL) return NULL;
  if (report->count >= CLI_REPORT_MAX_TURNS) {
    ++report->dropped;
    return NULL;
  }
  struct cli_report_turn *turn = &report->turns[report->count++];
  memset(turn, 0, sizeof(*turn));
  turn->started_ms = now;
  turn->back_office = back_office;
  /* UINT32_MAX is "no observation yet", so the first one always wins. */
  turn->occupancy_min_ms = UINT32_MAX;
  if (utterance != NULL) {
    size_t length = 0U;
    while (utterance[length] != '\0' &&
           length < sizeof(turn->utterance) - 1U) {
      ++length;
    }
    memcpy(turn->utterance, utterance, length);
    turn->utterance[length] = '\0';
  }
  return turn;
}

void cli_report_observe_occupancy(
    struct cli_report_turn *turn, uint32_t margin_ms)
{
  if (turn == NULL) return;
  uint32_t bucket = margin_ms / CLI_REPORT_OCCUPANCY_BUCKET_MS;
  /* Everything past the last bucket lands in it; occupancy is bounded by the
   * ring, so this only fires if the ring itself grew. */
  if (bucket >= CLI_REPORT_OCCUPANCY_BUCKETS) {
    bucket = CLI_REPORT_OCCUPANCY_BUCKETS - 1U;
  }
  ++turn->occupancy_histogram[bucket];
  ++turn->occupancy_samples;
  if (margin_ms < turn->occupancy_min_ms) turn->occupancy_min_ms = margin_ms;
  if (margin_ms > turn->occupancy_max_ms) turn->occupancy_max_ms = margin_ms;
  assert(turn->occupancy_samples > 0U);
}

uint32_t cli_report_occupancy_percentile(
    const struct cli_report_turn *turn, uint32_t percentile)
{
  if (turn == NULL || turn->occupancy_samples == 0U) return 0U;
  /*
   * Nearest-rank, rounding UP. Rounding down answers the p10 of "ten writes
   * in a hundred found the buffer empty" with the value nine tenths of them
   * saw, which is the reading that says everything is fine.
   */
  const uint32_t rank =
      (turn->occupancy_samples * percentile + CLI_REPORT_PERCENT - 1U) /
      CLI_REPORT_PERCENT;
  uint32_t seen = 0U;
  for (uint32_t bucket = 0U; bucket < CLI_REPORT_OCCUPANCY_BUCKETS; ++bucket) {
    seen += turn->occupancy_histogram[bucket];
    if (seen >= rank && rank > 0U) {
      return bucket * CLI_REPORT_OCCUPANCY_BUCKET_MS;
    }
  }
  return turn->occupancy_max_ms;
}

uint64_t cli_report_time_to_first_audio_ms(const struct cli_report_turn *turn)
{
  if (turn == NULL) return 0U;
  if (turn->committed_ms == 0U || turn->first_audio_ms <= turn->committed_ms) {
    return 0U;
  }
  return turn->first_audio_ms - turn->committed_ms;
}

uint64_t cli_report_time_to_answer_ms(const struct cli_report_turn *turn)
{
  if (turn == NULL) return 0U;
  if (turn->committed_ms == 0U || turn->completed_ms <= turn->committed_ms) {
    return 0U;
  }
  return turn->completed_ms - turn->committed_ms;
}

enum cli_report_status cli_report_write(
    const struct cli_report *report,
    const struct cli_report_summary *summary,
    const char *path)
{
  if (report == NULL || summary == NULL || path == NULL) {
    return CLI_REPORT_ERR_ARG;
  }
  FILE *file = fopen(path, "w");
  if (file == NULL) return CLI_REPORT_ERR_OPEN;

  enum cli_report_status status = CLI_REPORT_OK;
  size_t failures = 0U;
  (void)fprintf(file, "{\n  \"turns\":[\n");
  for (size_t index = 0U; index < report->count && status == CLI_REPORT_OK;
       ++index) {
    if (report->turns[index].failed) ++failures;
    status = cli_report_write_turn(
        file, &report->turns[index], index, index + 1U == report->count);
  }
  if (status == CLI_REPORT_OK) {
    (void)fprintf(file, "  ],\n  \"distributions\":{");
    for (int metric = 0; metric < CLI_REPORT_METRIC_COUNT; ++metric) {
      (void)fprintf(file, "%s\"%s\":", metric == 0 ? "" : ",",
                    CLI_REPORT_METRICS[metric].name);
      status = cli_report_write_distribution(
          file, report, CLI_REPORT_METRICS[metric].read);
      if (status != CLI_REPORT_OK) break;
    }
  }
  if (status == CLI_REPORT_OK) {
    (void)fprintf(
        file,
        "},\n  \"summary\":{\"turns\":%zu,\"failedTurns\":%zu,"
        "\"turnsDropped\":%zu,\"sessionRestarts\":%u,\"transportRestarts\":%u,"
        "\"connectionRecycles\":%u,\"callsLost\":%u,\"backOfficeSent\":%u,"
        "\"backOfficeHeard\":%u}\n}\n",
        report->count, failures, report->dropped, summary->session_restarts,
        summary->transport_restarts, summary->connection_recycles,
        summary->calls_lost, summary->back_office_sent,
        summary->back_office_heard);
  }
  if (ferror(file) != 0) status = CLI_REPORT_ERR_IO;
  if (fclose(file) != 0 && status == CLI_REPORT_OK) {
    status = CLI_REPORT_ERR_IO;
  }
  return status;
}

static enum cli_report_status cli_report_write_string(
    FILE *file, const char *text)
{
  assert(file != NULL);
  (void)fputc('"', file);
  for (size_t index = 0U; text != NULL && text[index] != '\0'; ++index) {
    const char character = text[index];
    if (character == '"' || character == '\\') {
      (void)fputc('\\', file);
      (void)fputc(character, file);
    } else if ((unsigned char)character < 0x20U) {
      (void)fprintf(file, "\\u%04x", (unsigned)(unsigned char)character);
    } else {
      (void)fputc(character, file);
    }
  }
  (void)fputc('"', file);
  return ferror(file) == 0 ? CLI_REPORT_OK : CLI_REPORT_ERR_IO;
}

static enum cli_report_status cli_report_write_turn(
    FILE *file, const struct cli_report_turn *turn, size_t index, bool last)
{
  assert(file != NULL && turn != NULL);
  (void)fprintf(file, "    {\"index\":%zu,\"utterance\":", index + 1U);
  const enum cli_report_status status = cli_report_write_string(
      file, turn->utterance);
  if (status != CLI_REPORT_OK) return status;
  (void)fprintf(
      file,
      ",\"backOffice\":%s,\"failure\":%s,\"timeToFirstAudioMs\":%" PRIu64
      ",\"timeToAnswerCompleteMs\":%" PRIu64
      ",\"framesSent\":%u,\"framesReceived\":%u,\"framesPlayed\":%u,"
      "\"framesConcealed\":%u,\"sequenceGaps\":%u,\"underruns\":%u,"
      "\"ringOccupancyMs\":{\"min\":%u,\"p10\":%u,\"max\":%u}}%s\n",
      turn->back_office ? "true" : "false", turn->failed ? "true" : "false",
      cli_report_time_to_first_audio_ms(turn),
      cli_report_time_to_answer_ms(turn), turn->frames_sent,
      turn->frames_received, turn->frames_played, turn->frames_concealed,
      turn->sequence_gaps, turn->underruns,
      turn->occupancy_samples == 0U ? 0U : turn->occupancy_min_ms,
      cli_report_occupancy_percentile(turn, CLI_REPORT_P10),
      turn->occupancy_max_ms, last ? "" : ",");
  return ferror(file) == 0 ? CLI_REPORT_OK : CLI_REPORT_ERR_IO;
}

static enum cli_report_status cli_report_write_distribution(
    FILE *file, const struct cli_report *report, cli_report_metric_fn read)
{
  assert(file != NULL && report != NULL && read != NULL);
  (void)fprintf(
      file,
      "{\"min\":%" PRIu64 ",\"p10\":%" PRIu64 ",\"p50\":%" PRIu64
      ",\"p90\":%" PRIu64 ",\"max\":%" PRIu64 "}",
      cli_report_percentile(report, read, 0U),
      cli_report_percentile(report, read, CLI_REPORT_P10),
      cli_report_percentile(report, read, CLI_REPORT_P50),
      cli_report_percentile(report, read, CLI_REPORT_P90),
      cli_report_percentile(report, read, CLI_REPORT_PERCENT));
  return ferror(file) == 0 ? CLI_REPORT_OK : CLI_REPORT_ERR_IO;
}

/** Adapter for qsort over uint64_t. The one foreign calling convention here. */
static int cli_report_compare(const void *left, const void *right)
{
  const uint64_t a = *(const uint64_t *)left;
  const uint64_t b = *(const uint64_t *)right;
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

static uint64_t cli_report_percentile(
    const struct cli_report *report,
    cli_report_metric_fn read,
    uint32_t percentile)
{
  assert(report != NULL && read != NULL);
  if (report->count == 0U) return 0U;
  /*
   * Static, because the alternative is 32 KiB of stack in a function called
   * fifty times at the end of a long run, and this module is written to the
   * same discipline as the device even though only the host builds it.
   */
  static uint64_t sorted[CLI_REPORT_MAX_TURNS];
  for (size_t index = 0U; index < report->count; ++index) {
    sorted[index] = read(&report->turns[index]);
  }
  qsort(sorted, report->count, sizeof(sorted[0]), cli_report_compare);
  /* Nearest-rank, rounding up, so a single bad turn owns the p90 it earned. */
  size_t rank =
      (report->count * percentile + CLI_REPORT_PERCENT - 1U) /
      CLI_REPORT_PERCENT;
  if (rank > 0U) --rank;
  return sorted[rank];
}

static uint64_t cli_report_metric_first_audio(const struct cli_report_turn *t)
{
  return cli_report_time_to_first_audio_ms(t);
}

static uint64_t cli_report_metric_answer(const struct cli_report_turn *t)
{
  return cli_report_time_to_answer_ms(t);
}

static uint64_t cli_report_metric_sent(const struct cli_report_turn *t)
{
  return t->frames_sent;
}

static uint64_t cli_report_metric_received(const struct cli_report_turn *t)
{
  return t->frames_received;
}

static uint64_t cli_report_metric_played(const struct cli_report_turn *t)
{
  return t->frames_played;
}

static uint64_t cli_report_metric_concealed(const struct cli_report_turn *t)
{
  return t->frames_concealed;
}

static uint64_t cli_report_metric_gaps(const struct cli_report_turn *t)
{
  return t->sequence_gaps;
}

static uint64_t cli_report_metric_underruns(const struct cli_report_turn *t)
{
  return t->underruns;
}

static uint64_t cli_report_metric_occupancy_min(const struct cli_report_turn *t)
{
  return t->occupancy_samples == 0U ? 0U : t->occupancy_min_ms;
}

static uint64_t cli_report_metric_occupancy_max(const struct cli_report_turn *t)
{
  return t->occupancy_max_ms;
}
