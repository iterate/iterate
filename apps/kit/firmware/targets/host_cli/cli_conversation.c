/* cli_conversation.c: owns bounded utterance discovery and run sequencing. */

#include <assert.h>
#include <dirent.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cli_conversation.h"
#include "cli_runtime.h"
#include "iterate/kit/voice_device_profile.h"

enum {
  CLI_CONVERSATION_MS_PER_MINUTE = 60000,
};

#define CLI_CONVERSATION_WAV_SUFFIX ".wav"
#define CLI_CONVERSATION_BACK_OFFICE_WORD_A "weather"
#define CLI_CONVERSATION_BACK_OFFICE_WORD_B "colleague"

/* Adapter for qsort's foreign calling convention over fixed path rows. */
static int cli_conversation_compare_paths(const void *left, const void *right);

/* True when a directory entry is a WAV rather than metadata or a subfolder. */
static bool cli_conversation_is_wav(const char *name);

/* Copies one joined directory path. Fails when the path bound would truncate. */
static enum cli_conversation_status cli_conversation_add_path(
    struct cli_conversation *conversation,
    const char *directory,
    const char *name);

/* Returns the next ordinary or back-office utterance, or NULL if unavailable. */
static const char *cli_conversation_select(
    struct cli_conversation *conversation, bool back_office);

/* Returns the reserved colleague utterance, or NULL when none was supplied. */
static const char *cli_conversation_find_back_office(
    const struct cli_conversation *conversation);

/* Rotates over non-colleague utterances, falling back when all are reserved. */
static const char *cli_conversation_find_ordinary(
    struct cli_conversation *conversation);

/* True when a path is reserved for back-office coverage. */
static bool cli_conversation_is_back_office(const char *path);

/* Starts one turn from its selected bounded WAV. */
static enum cli_conversation_status cli_conversation_start_turn(
    struct cli_runtime *runtime, uint64_t now_ms);

/* Commits the source once capture and queued frames have both ended. */
static void cli_conversation_finish_sending(
    struct cli_runtime *runtime, uint64_t now_ms);

/* Records the turn baselines that completion later converts to deltas. */
static void cli_conversation_begin_report(
    struct cli_runtime *runtime,
    const char *path,
    bool back_office,
    uint64_t now_ms);

/* Ends the complete unattended run at its configured deadline. */
static void cli_conversation_finish_run(
    struct cli_runtime *runtime);

/* Counts failed turns for the human-readable shutdown summary. */
static size_t cli_conversation_failure_count(
    const struct cli_conversation *conversation);

const char *cli_conversation_status_name(enum cli_conversation_status status)
{
  switch (status) {
    case CLI_CONVERSATION_OK: return "ok";
    case CLI_CONVERSATION_ERR_ARG: return "bad-argument";
    case CLI_CONVERSATION_ERR_OPEN: return "cannot-open-directory";
    case CLI_CONVERSATION_ERR_EMPTY: return "no-wavs";
    case CLI_CONVERSATION_ERR_FULL: return "too-many-wavs";
    case CLI_CONVERSATION_ERR_PATH: return "path-too-long";
    case CLI_CONVERSATION_ERR_WAV: return "cannot-open-wav";
    case CLI_CONVERSATION_ERR_REPORT: return "cannot-write-report";
    default: return "unknown";
  }
}

enum cli_conversation_status cli_conversation_init(
    struct cli_conversation *conversation,
    const struct cli_conversation_options *options)
{
  if (conversation == NULL || options == NULL || options->directory == NULL ||
      !(options->minutes > 0.0)) {
    return CLI_CONVERSATION_ERR_ARG;
  }
  memset(conversation, 0, sizeof(*conversation));
  DIR *dir = opendir(options->directory);
  if (dir == NULL) return CLI_CONVERSATION_ERR_OPEN;
  enum cli_conversation_status status = CLI_CONVERSATION_OK;
  size_t entries_seen = 0U;
  for (struct dirent *entry = readdir(dir); entry != NULL;
       entry = readdir(dir)) {
    ++entries_seen;
    if (entries_seen > CLI_CONVERSATION_MAX_DIRECTORY_ENTRIES) {
      ++conversation->utterances_dropped;
      status = CLI_CONVERSATION_ERR_FULL;
      break;
    }
    if (!cli_conversation_is_wav(entry->d_name)) continue;
    status = cli_conversation_add_path(
        conversation, options->directory, entry->d_name);
    if (status != CLI_CONVERSATION_OK) break;
  }
  (void)closedir(dir);
  if (status != CLI_CONVERSATION_OK) return status;
  if (conversation->utterance_count == 0U) return CLI_CONVERSATION_ERR_EMPTY;
  qsort(conversation->utterances, conversation->utterance_count,
        sizeof(conversation->utterances[0]), cli_conversation_compare_paths);
  conversation->state = CLI_CONVERSATION_WAIT_CALL;
  conversation->back_office_every = options->back_office_every;
  conversation->finish_at_ms =
      options->now_ms +
      (uint64_t)(options->minutes * CLI_CONVERSATION_MS_PER_MINUTE);
  cli_report_reset(&conversation->report);
  return CLI_CONVERSATION_OK;
}

void cli_conversation_poll(struct cli_runtime *runtime, uint64_t now_ms)
{
  if (runtime == NULL) return;
  struct cli_conversation *conversation = &runtime->conversation;
  if (conversation->state == CLI_CONVERSATION_DISABLED ||
      conversation->state == CLI_CONVERSATION_FINISHED) return;
  if (now_ms >= conversation->finish_at_ms) {
    cli_conversation_finish_run(runtime);
    return;
  }
  switch (conversation->state) {
    case CLI_CONVERSATION_WAIT_CALL:
      runtime->wants_call = true;
      if (runtime->voicelab.call_active) {
        conversation->state = CLI_CONVERSATION_START_TURN;
      }
      break;
    case CLI_CONVERSATION_START_TURN:
      if (cli_conversation_start_turn(runtime, now_ms) !=
          CLI_CONVERSATION_OK) runtime->stop_requested = true;
      break;
    case CLI_CONVERSATION_SENDING:
      cli_conversation_finish_sending(runtime, now_ms);
      break;
    case CLI_CONVERSATION_WAIT_ANSWER:
      if (!runtime->voicelab.call_active) {
        conversation->state = CLI_CONVERSATION_WAIT_CALL;
      }
      break;
    case CLI_CONVERSATION_GAP:
      if (now_ms >= conversation->next_action_at_ms) {
        conversation->state = CLI_CONVERSATION_START_TURN;
      }
      break;
    case CLI_CONVERSATION_DISABLED:
    case CLI_CONVERSATION_FINISHED:
    default:
      break;
  }
}

void cli_conversation_finish_turn(struct cli_runtime *runtime, uint64_t now_ms)
{
  if (runtime == NULL || runtime->conversation.current_turn == NULL) return;
  struct cli_report_turn *turn = runtime->conversation.current_turn;
  turn->completed_ms = now_ms;
  turn->failed = turn->frames_played == 0U;
  turn->frames_sent = runtime->voicelab.frames_sent - turn->frames_sent;
  turn->sequence_gaps = runtime->playout.gaps - turn->sequence_gaps;
  if (turn->back_office && !turn->failed) {
    ++runtime->conversation.back_office_heard;
  }
  cli_runtime_log(
      turn->failed ? "error" : "info",
      "turn=%zu complete=%s firstAudioMs=%" PRIu64
      " answerMs=%" PRIu64 " sent=%u received=%u played=%u conceal=%u"
      " gaps=%u underruns=%u",
      runtime->conversation.report.count, turn->failed ? "failure" : "ok",
      cli_report_time_to_first_audio_ms(turn),
      cli_report_time_to_answer_ms(turn), turn->frames_sent,
      turn->frames_received, turn->frames_played, turn->frames_concealed,
      turn->sequence_gaps, turn->underruns);
  runtime->conversation.current_turn = NULL;
}

enum cli_conversation_status cli_conversation_write_report(
    const struct cli_runtime *runtime)
{
  if (runtime == NULL || runtime->options.report_json == NULL) {
    return CLI_CONVERSATION_ERR_ARG;
  }
  const struct cli_report_summary summary = {
    .session_restarts = runtime->session_restarts,
    .transport_restarts = runtime->transport_restarts,
    .connection_recycles = runtime->downlink_recycles,
    .calls_lost = runtime->calls_lost,
    .back_office_sent = runtime->conversation.back_office_sent,
    .back_office_heard = runtime->conversation.back_office_heard,
    .deadline_cancelled_turns =
        runtime->conversation.deadline_cancelled_turns,
  };
  const enum cli_report_status status = cli_report_write(
      &runtime->conversation.report, &summary, runtime->options.report_json);
  if (status != CLI_REPORT_OK) return CLI_CONVERSATION_ERR_REPORT;
  const size_t failures = cli_conversation_failure_count(&runtime->conversation);
  (void)fprintf(
      stderr,
      "conversation summary: turns=%zu failures=%zu sessions=%u transports=%u "
      "recycles=%u callsLost=%u cancelled=%u colleague=%u/%u "
      "report=%s playback=%s\n",
      runtime->conversation.report.count, failures, runtime->session_restarts,
      runtime->transport_restarts, runtime->downlink_recycles,
      runtime->calls_lost, runtime->conversation.deadline_cancelled_turns,
      runtime->conversation.back_office_heard,
      runtime->conversation.back_office_sent, runtime->options.report_json,
      runtime->options.speaker_wav);
  return CLI_CONVERSATION_OK;
}

static int cli_conversation_compare_paths(const void *left, const void *right)
{
  assert(left != NULL && right != NULL);
  return strcmp(left, right);
}

static bool cli_conversation_is_wav(const char *name)
{
  assert(name != NULL);
  const size_t name_length = strlen(name);
  const size_t suffix_length = sizeof(CLI_CONVERSATION_WAV_SUFFIX) - 1U;
  if (name_length < suffix_length) return false;
  return strcmp(name + name_length - suffix_length,
                CLI_CONVERSATION_WAV_SUFFIX) == 0;
}

static enum cli_conversation_status cli_conversation_add_path(
    struct cli_conversation *conversation,
    const char *directory,
    const char *name)
{
  assert(conversation != NULL && directory != NULL && name != NULL);
  if (conversation->utterance_count >= CLI_CONVERSATION_MAX_UTTERANCES) {
    ++conversation->utterances_dropped;
    return CLI_CONVERSATION_ERR_FULL;
  }
  char *path = conversation->utterances[conversation->utterance_count];
  const int length = snprintf(
      path, CLI_CONVERSATION_PATH_BYTES, "%s/%s", directory, name);
  if (length < 0 || (size_t)length >= CLI_CONVERSATION_PATH_BYTES) {
    ++conversation->utterances_dropped;
    return CLI_CONVERSATION_ERR_PATH;
  }
  ++conversation->utterance_count;
  return CLI_CONVERSATION_OK;
}

static const char *cli_conversation_select(
    struct cli_conversation *conversation, bool back_office)
{
  assert(conversation != NULL && conversation->utterance_count > 0U);
  return back_office
      ? cli_conversation_find_back_office(conversation)
      : cli_conversation_find_ordinary(conversation);
}

static const char *cli_conversation_find_back_office(
    const struct cli_conversation *conversation)
{
  assert(conversation != NULL);
  for (size_t index = 0U; index < conversation->utterance_count; ++index) {
    if (cli_conversation_is_back_office(conversation->utterances[index])) {
      return conversation->utterances[index];
    }
  }
  return NULL;
}

static const char *cli_conversation_find_ordinary(
    struct cli_conversation *conversation)
{
  assert(conversation != NULL);
  for (size_t attempt = 0U; attempt < conversation->utterance_count;
       ++attempt) {
    const size_t index =
        conversation->ordinary_index++ % conversation->utterance_count;
    if (!cli_conversation_is_back_office(conversation->utterances[index])) {
      return conversation->utterances[index];
    }
  }
  return conversation->utterances[0];
}

static bool cli_conversation_is_back_office(const char *path)
{
  assert(path != NULL);
  return strstr(path, CLI_CONVERSATION_BACK_OFFICE_WORD_A) != NULL ||
      strstr(path, CLI_CONVERSATION_BACK_OFFICE_WORD_B) != NULL;
}

static enum cli_conversation_status cli_conversation_start_turn(
    struct cli_runtime *runtime, uint64_t now_ms)
{
  assert(runtime != NULL);
  struct cli_conversation *conversation = &runtime->conversation;
  if (!runtime->voicelab.call_active) {
    conversation->state = CLI_CONVERSATION_WAIT_CALL;
    return CLI_CONVERSATION_OK;
  }
  const size_t number = conversation->report.count + 1U;
  const bool back_office = conversation->back_office_every != 0U &&
      number % conversation->back_office_every == 0U;
  const char *path = cli_conversation_select(conversation, back_office);
  if (path == NULL) {
    cli_runtime_log(
        "error", "--colleague-every requested but no weather/colleague WAV exists");
    return CLI_CONVERSATION_ERR_WAV;
  }
  if (cli_wav_source_open(&runtime->source, path) != CLI_WAV_OK) {
    cli_runtime_log("error", "cannot open utterance for turn %zu", number);
    return CLI_CONVERSATION_ERR_WAV;
  }
  cli_conversation_begin_report(runtime, path, back_office, now_ms);
  runtime->answer_done = false;
  runtime->source_finished = false;
  runtime->wants_talk = true;
  conversation->state = CLI_CONVERSATION_SENDING;
  cli_runtime_log("info", "turn=%zu colleague=%s utterance=%s", number,
                  back_office ? "true" : "false", path);
  return CLI_CONVERSATION_OK;
}

static void cli_conversation_finish_sending(
    struct cli_runtime *runtime, uint64_t now_ms)
{
  assert(runtime != NULL);
  if (!runtime->source_finished ||
      cli_microphone_queued(&runtime->microphone) != 0U) return;
  runtime->wants_talk = false;
  runtime->conversation.state = CLI_CONVERSATION_WAIT_ANSWER;
  if (runtime->conversation.current_turn != NULL) {
    runtime->conversation.current_turn->committed_ms = now_ms;
  }
}

static void cli_conversation_begin_report(
    struct cli_runtime *runtime,
    const char *path,
    bool back_office,
    uint64_t now_ms)
{
  assert(runtime != NULL && path != NULL);
  struct cli_report_turn *turn = cli_report_begin_turn(
      &runtime->conversation.report, path, back_office, now_ms);
  if (turn == NULL) {
    cli_runtime_log(
        "error", "conversation exceeds fixed %d-turn report budget",
        CLI_REPORT_MAX_TURNS);
    runtime->stop_requested = true;
    return;
  }
  turn->frames_sent = runtime->voicelab.frames_sent;
  turn->sequence_gaps = runtime->playout.gaps;
  runtime->conversation.current_turn = turn;
  if (back_office) ++runtime->conversation.back_office_sent;
}

static void cli_conversation_finish_run(
    struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  runtime->wants_talk = false;
  runtime->wants_call = false;
  if (runtime->conversation.current_turn != NULL) {
    /*
     * The operator's wall-clock bound cancels work; it does not prove the
     * provider failed. Keep the cancellation visible without contaminating
     * completed-turn distributions or the failure counter. The current turn
     * is necessarily the most recently appended report row.
     */
    assert(runtime->conversation.report.count > 0U);
    assert(runtime->conversation.current_turn ==
           &runtime->conversation.report.turns[
               runtime->conversation.report.count - 1U]);
    --runtime->conversation.report.count;
    runtime->conversation.current_turn = NULL;
    ++runtime->conversation.deadline_cancelled_turns;
    cli_runtime_log("info", "turn cancelled: configured run deadline");
  }
  runtime->conversation.state = CLI_CONVERSATION_FINISHED;
  runtime->stop_requested = true;
}

static size_t cli_conversation_failure_count(
    const struct cli_conversation *conversation)
{
  assert(conversation != NULL);
  size_t failures = 0U;
  for (size_t index = 0U; index < conversation->report.count; ++index) {
    if (conversation->report.turns[index].failed) ++failures;
  }
  return failures;
}
