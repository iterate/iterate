#ifndef ITERATE_KIT_CLI_CONVERSATION_H
#define ITERATE_KIT_CLI_CONVERSATION_H

/*
 * cli_conversation: a bounded unattended sequence of recorded utterances.
 *
 * Directory discovery happens once at startup. Paths and reports live in
 * fixed arrays because a host-only heap would let a long run prove bounds the
 * device does not have. Overflow is counted and stops initialization rather
 * than silently selecting a subset that could make the run look healthier.
 */

#include <stddef.h>
#include <stdint.h>

#include "cli_report.h"

enum {
  CLI_CONVERSATION_MAX_UTTERANCES = 128,
  CLI_CONVERSATION_PATH_BYTES = 1024,
  CLI_CONVERSATION_GAP_MS = 1500,
  CLI_CONVERSATION_MAX_DIRECTORY_ENTRIES = 4096,
};

enum cli_conversation_status {
  CLI_CONVERSATION_OK = 0,
  CLI_CONVERSATION_ERR_ARG,
  CLI_CONVERSATION_ERR_OPEN,
  CLI_CONVERSATION_ERR_EMPTY,
  CLI_CONVERSATION_ERR_FULL,
  CLI_CONVERSATION_ERR_PATH,
  CLI_CONVERSATION_ERR_WAV,
  CLI_CONVERSATION_ERR_REPORT,
};

enum cli_conversation_state {
  CLI_CONVERSATION_DISABLED = 0,
  CLI_CONVERSATION_WAIT_READY,
  CLI_CONVERSATION_START_TURN,
  CLI_CONVERSATION_SENDING,
  CLI_CONVERSATION_WAIT_ANSWER,
  CLI_CONVERSATION_GAP,
  CLI_CONVERSATION_FINISHED,
};

struct cli_runtime;

/** Borrowed startup request; directory must outlive initialization only. */
struct cli_conversation_options {
  const char *directory;
  double minutes;
  uint32_t back_office_every;
  uint64_t now_ms;
};

/** Caller-owned conversation schedule and report; no allocation after init. */
struct cli_conversation {
  enum cli_conversation_state state;
  char utterances[CLI_CONVERSATION_MAX_UTTERANCES]
                 [CLI_CONVERSATION_PATH_BYTES];
  size_t utterance_count;
  size_t utterances_dropped;
  size_t ordinary_index;
  uint32_t back_office_every;
  uint32_t back_office_sent;
  uint32_t back_office_heard;
  uint32_t deadline_cancelled_turns;
  uint64_t finish_at_ms;
  uint64_t next_action_at_ms;
  struct cli_report report;
  struct cli_report_turn *current_turn;
};

/** Human-readable status name, for startup and shutdown logs. */
const char *cli_conversation_status_name(enum cli_conversation_status status);

/** Discover and sort WAV paths, then arm the run deadline. */
enum cli_conversation_status cli_conversation_init(
    struct cli_conversation *conversation,
    const struct cli_conversation_options *options);

/** Advance the unattended state machine once without blocking. */
void cli_conversation_poll(struct cli_runtime *runtime, uint64_t now_ms);

/** Close the active turn from its observed playback facts. */
void cli_conversation_finish_turn(struct cli_runtime *runtime, uint64_t now_ms);

/** Write the final bounded report. */
enum cli_conversation_status cli_conversation_write_report(
    const struct cli_runtime *runtime);

#endif /* ITERATE_KIT_CLI_CONVERSATION_H */
