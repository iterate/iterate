#ifndef ITERATE_KIT_CLI_REPORT_H
#define ITERATE_KIT_CLI_REPORT_H

/*
 * cli_report: what happened, turn by turn, and as distributions.
 *
 * An unattended run is only worth having if a bad one is impossible to
 * mistake for a good one. So a turn that played no audio is a FAILURE with a
 * name, not a low number in an average, and every quantity that could hide a
 * defect is reported as a spread rather than a mean: one turn in forty that
 * inserted two seconds of silence is inaudible in a mean and obvious at p90.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum {
  /*
   * An hour of conversation is a few hundred turns; this is generous. Past
   * it, turns are COUNTED AND DROPPED rather than silently overwriting the
   * record, because a report that quietly stops recording reads as a run
   * that quietly stopped failing.
   */
  CLI_REPORT_MAX_TURNS = 4096,
  /*
   * Buffer occupancy, bucketed. The speaker ring now holds a whole answer,
   * so occupancy legitimately ranges over the entire ring and the useful
   * question is which half of a second it sat in, not which millisecond.
   *
   * The predecessor allocated one bucket per millisecond of a 30-second
   * ring: 30001 buckets, 120 KiB per turn, half a gigabyte for a run this
   * size — a memory profile nobody chose, for a resolution nobody wanted.
   */
  CLI_REPORT_OCCUPANCY_BUCKETS = 64,
  CLI_REPORT_OCCUPANCY_BUCKET_MS = 500,
  CLI_REPORT_UTTERANCE_MAX = 128,
};

/** One status per way writing a report can fail. */
enum cli_report_status {
  CLI_REPORT_OK = 0,
  CLI_REPORT_ERR_ARG,
  CLI_REPORT_ERR_OPEN,
  CLI_REPORT_ERR_IO,
};

/**
 * One turn: what was said, what came back, and how the buffer behaved.
 *
 * Times are milliseconds on the caller's monotonic clock. `committed_ms` of
 * zero means the turn never committed, and both derived durations then report
 * zero rather than a clock reading dressed up as a duration.
 */
struct cli_report_turn {
  char utterance[CLI_REPORT_UTTERANCE_MAX];
  bool back_office;
  bool failed;
  uint64_t started_ms;
  uint64_t committed_ms;
  uint64_t first_audio_ms;
  uint64_t completed_ms;
  uint32_t frames_sent;
  uint32_t frames_received;
  uint32_t frames_played;
  uint32_t frames_concealed;
  uint32_t sequence_gaps;
  uint32_t underruns;
  uint32_t occupancy_min_ms;
  uint32_t occupancy_max_ms;
  uint32_t occupancy_samples;
  uint32_t occupancy_histogram[CLI_REPORT_OCCUPANCY_BUCKETS];
};

/** Run-wide facts that are not per-turn. */
struct cli_report_summary {
  uint32_t session_restarts;
  uint32_t transport_restarts;
  uint32_t connection_recycles;
  uint32_t calls_lost;
  uint32_t back_office_sent;
  uint32_t back_office_heard;
  /** In-progress turns intentionally stopped by the configured run deadline. */
  uint32_t deadline_cancelled_turns;
  /** Payload that completed at the CoreAudio callback/file boundary. */
  uint32_t room_completed_bytes;
  /** Payload refused because the hardware-facing ring was full. */
  uint32_t room_dropped_bytes;
  /** Hardware dry pulls followed by later answer payload: audible holes. */
  uint32_t room_starved_buffers;
  /** First output/input platform status; zero means the boundary stayed healthy. */
  int32_t speaker_platform_error;
  int32_t microphone_platform_error;
};

/** Every turn of one run, bounded, with an honest count of what did not fit. */
struct cli_report {
  struct cli_report_turn turns[CLI_REPORT_MAX_TURNS];
  size_t count;
  /** Turns that happened after the array filled. Never silently zero. */
  size_t dropped;
};

/** Human-readable status name, for logs and test failure messages. */
const char *cli_report_status_name(enum cli_report_status status);

/** Forget every turn. */
void cli_report_reset(struct cli_report *report);

/**
 * Start recording a turn and return it, or NULL once the run is full.
 * The returned pointer stays valid until the next reset; a NULL result means
 * the turn still happened and has been counted in `dropped`.
 */
struct cli_report_turn *cli_report_begin_turn(
    struct cli_report *report,
    const char *utterance,
    bool back_office,
    uint64_t now);

/** Record one observation of how much audio was queued behind a write. */
void cli_report_observe_occupancy(
    struct cli_report_turn *turn, uint32_t margin_ms);

/** The `percentile`-th occupancy this turn saw, from its histogram. */
uint32_t cli_report_occupancy_percentile(
    const struct cli_report_turn *turn, uint32_t percentile);

/** Milliseconds from the commit to the first audio; 0 if there was none. */
uint64_t cli_report_time_to_first_audio_ms(const struct cli_report_turn *turn);

/** Milliseconds from the commit to the answer finishing; 0 if it never did. */
uint64_t cli_report_time_to_answer_ms(const struct cli_report_turn *turn);

/** Write the whole run as JSON. */
enum cli_report_status cli_report_write(
    const struct cli_report *report,
    const struct cli_report_summary *summary,
    const char *path);

#endif /* ITERATE_KIT_CLI_REPORT_H */
