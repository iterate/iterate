/* main.c: assembles the macOS voice target and owns its cooperative poll loop. */

#include <assert.h>
#include <errno.h>
#include <inttypes.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "cli_capabilities.h"
#include "cli_conversation.h"
#include "cli_runtime.h"
#include "iterate/kit/voice_device_profile.h"

enum {
  CLI_MAIN_EXIT_OK = 0,
  CLI_MAIN_EXIT_RUNTIME = 1,
  CLI_MAIN_EXIT_OPTIONS = 2,
  CLI_MAIN_LOOP_MS = 5,
  CLI_MAIN_HOST_STALL_FRAMES = 4,
  CLI_MAIN_CALL_START_RETRY_MS = 8000,
  CLI_MAIN_CALL_PENDING_TIMEOUT_MS = 20000,
  CLI_MAIN_CALL_OUTBOX_SLOTS = 3,
  CLI_MAIN_RECYCLE_OUTBOX_SLOTS = 4,
  CLI_MAIN_RECYCLES_BEFORE_TRANSPORT = 3,
  CLI_MAIN_PULSE_ACTIVE_TAIL_MS = 3000,
  CLI_MAIN_PULSE_INTERVAL_MS = 1000,
  CLI_MAIN_RESTART_REPLY_MS = 400,
  CLI_MAIN_INITIAL_PLAYOUT_SEQUENCE = 1,
  CLI_MAIN_MS_PER_SECOND = 1000,
  /*
   * How long a schedule assumes a session lasts when nobody said. Episodes
   * are scattered across this span, so a number far below the real run leaves
   * the tail of it fault-free and a number far above it makes faults rare.
   * An hour matches the longest run anybody has asked this rig for.
   */
  CLI_MAIN_DEFAULT_SESSION_MINUTES = 60,
  CLI_MAIN_NS_PER_MS = 1000000,
  CLI_MAIN_US_PER_SECOND = 1000000,
  CLI_MAIN_NS_PER_US = 1000,
  CLI_MAIN_PROBLEM_BYTES = 128,
  CLI_MAIN_TRANSPORT_POLL_EVENTS = 16,
  CLI_MAIN_MS_PER_MINUTE = 60000,
  /*
   * How long a hang-up may take before the process leaves anyway. The
   * end-call has to reach the provider or the session is left running at the
   * far end, but a wedged transport must not hold a person's terminal.
   */
  CLI_MAIN_HANGUP_GRACE_MS = 3000,
};

#define CLI_MAIN_CALL_GREETING \
  "Hi, I am your Iterate device. What can I do for you?"
#define CLI_MAIN_CALL_END_REASON "host-cli"
#define CLI_MAIN_CONNECTION_INSTRUCTIONS \
  "Iterate voice device (macOS CLI target)"

static struct cli_runtime cli_main_runtime;
static volatile sig_atomic_t cli_main_interrupted = 0;

/* Records SIGINT or SIGTERM for the cooperative owner to observe. */
static void cli_main_signal_handler(int signal_number);

/* Writes one bounded configuration field. False means missing or too long. */
static bool cli_main_copy_field(
    char *out, size_t capacity, const char *value);

/* Explains the parse status with the same diagnostic the C++ target emitted. */
static void cli_main_explain_options(
    enum cli_options_status status, const char *problem);

/* Initializes both fixed control rings. */
static bool cli_main_init_control_rings(struct cli_runtime *runtime);

/* Copies borrowed options into the firmware-sized runtime configuration. */
static bool cli_main_init_configuration(struct cli_runtime *runtime);

/* Initializes the capability peer with storage borrowed for process life. */
static bool cli_main_init_peer(struct cli_runtime *runtime);

/* Initializes the bounded Cap'n Web connection. */
static bool cli_main_init_connection(struct cli_runtime *runtime);

/* Prepares and starts the POSIX transport. */
static bool cli_main_init_transport(struct cli_runtime *runtime);

/* Opens the authoritative WAV and optional CoreAudio mirror. */
static bool cli_main_init_audio(struct cli_runtime *runtime);

/* Opens one source or discovers the unattended utterance set. */
static bool cli_main_init_input(struct cli_runtime *runtime);

/* Assembles every runtime boundary before polling can begin. */
static bool cli_main_init_runtime(struct cli_runtime *runtime);

/* Releases every opened platform resource. Safe after partial initialization. */
static void cli_main_close_runtime(struct cli_runtime *runtime);

/* Starts a voicelab mount for each fresh ready connection generation. */
static void cli_main_start_voicelab(struct cli_runtime *runtime);

/* Receives one decoded speaker frame from voicelab. */
static void cli_main_on_speaker(
    void *context,
    const uint8_t *pcm,
    size_t length,
    const struct iterate_kit_playout_frame *identity);

/* Receives response and call lifecycle controls from voicelab. */
static void cli_main_on_control(
    void *context, enum iterate_kit_voicelab_control control);

/* Logs final user and assistant transcripts. */
static void cli_main_on_transcript(
    void *context, bool from_user, const char *text, bool final);

/* Records one frame on the true timeline: the WAV, then the room. */
static void cli_main_record_frame(
    struct cli_runtime *runtime, const uint8_t *pcm);

/* Records the silence the modelled converter emitted for want of a frame. */
static void cli_main_record_converter_silence(
    struct cli_runtime *runtime, uint32_t frames);

/* Records one frame and hands it to the modelled converter. */
static void cli_main_write_playback(
    struct cli_runtime *runtime, const uint8_t *pcm);

/* Feeds the converter until it stops asking; unpaced, exactly one frame. */
static void cli_main_feed_playback(
    struct cli_runtime *runtime, uint64_t now_ms);

/* Completes an answered or overdue turn before consuming another frame. */
static void cli_main_finish_answer_if_ready(
    struct cli_runtime *runtime, uint64_t now_ms);

/* Produces one concealment frame when the playback clock requires it. */
static void cli_main_conceal_if_needed(
    struct cli_runtime *runtime, uint64_t now_ms);

/* Applies the playback clock's decision to one dequeued frame. */
static void cli_main_play_frame(
    struct cli_runtime *runtime, const uint8_t *frame, uint64_t now_ms);

/* Advances the real-time playback clock by at most one frame. */
static void cli_main_poll_playback(
    struct cli_runtime *runtime, uint64_t now_ms);

/* Captures one scheduled microphone frame into the latest-wins queue. */
static void cli_main_capture_frame(struct cli_runtime *runtime);

/* Takes one frame from the CoreAudio capture ring, if one is waiting. */
static void cli_main_capture_live_frame(struct cli_runtime *runtime);

/* Takes one frame from the recording, latching its end. */
static void cli_main_capture_recorded_frame(struct cli_runtime *runtime);

/* Configures the modelled converter from --speaker-pace. */
static bool cli_main_init_converter(struct cli_runtime *runtime);

/* Arms the session deadline and, for --push-to-talk, takes the terminal. */
static bool cli_main_init_keyboard(struct cli_runtime *runtime);

/* Applies one key press to what this session wants. */
static void cli_main_apply_key(
    struct cli_runtime *runtime,
    enum cli_keyboard_event event,
    uint64_t now_ms);

/* Ends the call, then the process, giving the far end a bounded chance. */
static void cli_main_begin_hangup(
    struct cli_runtime *runtime, uint64_t now_ms);

/* Advances the interactive session: keys, the deadline, and the hang-up. */
static void cli_main_poll_interactive(
    struct cli_runtime *runtime, uint64_t now_ms);

/* Sends one bounded batch when the control lane has its reserved space. */
static void cli_main_send_microphone(struct cli_runtime *runtime, uint64_t now_ms);

/* Advances capture and upload by at most one frame and one batch. */
static void cli_main_poll_microphone(
    struct cli_runtime *runtime, uint64_t now_ms);

/* Begins a talk turn once the call and control lane are ready. */
static void cli_main_start_talk(
    struct cli_runtime *runtime, uint64_t now_ms, size_t outbox_free);

/* Commits a talk turn after queued capture drains or its flush deadline passes. */
static void cli_main_finish_talk(
    struct cli_runtime *runtime, uint64_t now_ms);

/* Reconciles desired push-to-talk state with the mounted runtime. */
static void cli_main_reconcile_talk(
    struct cli_runtime *runtime, uint64_t now_ms, size_t outbox_free);

/* Reconciles desired call state with the mounted runtime. */
static void cli_main_reconcile_call(
    struct cli_runtime *runtime, uint64_t now_ms, size_t outbox_free);

/* Supervises fatal transport state and the process-level liveness deadline. */
static void cli_main_supervise_transport(
    struct cli_runtime *runtime, uint64_t now_ms);

/* Supervises ping progress and requests a bounded transport restart. */
static void cli_main_supervise_liveness(
    struct cli_runtime *runtime, uint64_t now_ms);

/* Drops a call whose provider bridge has gone silent. */
static void cli_main_supervise_bridge(
    struct cli_runtime *runtime, uint64_t now_ms);

/* Recycles a silent delivery lane, escalating repeated failures to transport. */
static void cli_main_supervise_downlink(
    struct cli_runtime *runtime, uint64_t now_ms, size_t outbox_free);

/* Runs every bounded recovery policy once. */
static void cli_main_supervise(
    struct cli_runtime *runtime, uint64_t now_ms, size_t outbox_free);

/* Logs transport and voicelab state changes exactly once per transition. */
static void cli_main_announce_states(struct cli_runtime *runtime);

/* Logs the detailed terminal transport state that explains a failed mount. */
static void cli_main_announce_transport_failure(
    const struct cli_runtime *runtime);

/* Emits the once-per-second active-call heartbeat. */
static void cli_main_pulse(
    struct cli_runtime *runtime,
    uint64_t now_ms,
    const struct iterate_kit_spsc_ring_metrics *outbox);

/* Runs mounted voicelab work after transport and generation gates open. */
static void cli_main_poll_ready(
    struct cli_runtime *runtime,
    uint64_t now_ms,
    const struct iterate_kit_spsc_ring_metrics *outbox);

/* Advances ping and stats schedules without starving mandatory replies. */
static void cli_main_poll_periodic(
    struct cli_runtime *runtime, uint64_t now_ms, size_t outbox_free);

/* Recycles a completed downlink only after playback and talk are quiescent. */
static void cli_main_recycle_if_ready(
    struct cli_runtime *runtime, size_t outbox_free);

/* Gives a restart reply time to leave, then re-executes the same argv. */
static void cli_main_reexec_if_ready(
    struct cli_runtime *runtime, uint64_t now_ms);

/* Points the process's one clock at the schedule. */
static bool cli_main_arm_clock(struct cli_runtime *runtime);

/* Draws this session's adversity and arms the clock with it. */
static bool cli_main_init_harness(struct cli_runtime *runtime);

/* Adopts a named board's bounded sizes. */
static bool cli_main_init_profile(struct cli_runtime *runtime);

/* Sleeps one bounded cooperative loop interval. */
static void cli_main_sleep(void);

/* Runs the intentionally nonterminating cooperative event pump until stopped. */
static void cli_main_run_loop(struct cli_runtime *runtime);

/*
 * The process's one clock.
 *
 * A file-scope object rather than a runtime field because the existing seam —
 * `cli_runtime_now_ms(void *context)` — is called with a NULL context from
 * nine places, and threading a clock through every one of them would be a
 * large diff whose only effect is to say what this comment says: there is
 * exactly one clock, and every stamp in the process comes from it.
 *
 * Anchored to the host and undistorted until something configures otherwise,
 * so a rig with no schedule behaves exactly as it did before this existed.
 *
 * INITIALISED HERE, NOT IN main(). Logging takes a stamp while the command
 * line is still being parsed, so this must be usable before any setup code
 * runs; a zero-filled clock would have a rate of zero and trip an assertion
 * in the first line anybody logged. Anchoring at host zero makes session time
 * equal the host's own monotonic reading, which is byte-for-byte what this
 * function returned before the seam existed.
 */
static struct cli_virtual_clock cli_main_clock = {
    .mode = CLI_VIRTUAL_CLOCK_ANCHORED,
    .rate = CLI_VIRTUAL_CLOCK_RATE_UNIT,
    .skew_armed = true,
};

struct cli_virtual_clock *cli_runtime_clock(void)
{
  return &cli_main_clock;
}

uint64_t cli_runtime_now_ms(void *context)
{
  (void)context;
  return cli_virtual_clock_now_ms(&cli_main_clock);
}

uint64_t cli_runtime_now_us(void)
{
  return cli_virtual_clock_now_us(&cli_main_clock);
}

void cli_runtime_log(const char *level, const char *format, ...)
{
  if (level == NULL || format == NULL) return;
  (void)fprintf(
      stderr, "t=%" PRIu64 " level=%s ", cli_runtime_now_ms(NULL), level);
  va_list args;
  va_start(args, format);
  (void)vfprintf(stderr, format, args);
  va_end(args);
  (void)fputc('\n', stderr);
}

int main(int argc, char **argv)
{
  struct cli_runtime *runtime = &cli_main_runtime;
  runtime->argv = argv;
  char problem[CLI_MAIN_PROBLEM_BYTES] = {0};
  const enum cli_options_status options_status = cli_options_parse(
      &runtime->options, argc, argv, problem, sizeof(problem));
  if (options_status == CLI_OPTIONS_HELP) {
    cli_options_print_help(stdout);
    return CLI_MAIN_EXIT_OK;
  }
  if (options_status != CLI_OPTIONS_OK) {
    cli_main_explain_options(options_status, problem);
    cli_options_print_help(stderr);
    return CLI_MAIN_EXIT_OPTIONS;
  }
  (void)signal(SIGINT, cli_main_signal_handler);
  (void)signal(SIGTERM, cli_main_signal_handler);
  if (!cli_main_init_runtime(runtime)) {
    cli_main_close_runtime(runtime);
    return CLI_MAIN_EXIT_RUNTIME;
  }
  cli_main_run_loop(runtime);
  cli_main_close_runtime(runtime);
  if (runtime->options.converse_minutes > 0.0 &&
      cli_conversation_write_report(runtime) != CLI_CONVERSATION_OK) {
    cli_runtime_log(
        "error", "failed to write report: %s", runtime->options.report_json);
    return CLI_MAIN_EXIT_RUNTIME;
  }
  return CLI_MAIN_EXIT_OK;
}

static void cli_main_signal_handler(int signal_number)
{
  (void)signal_number;
  /*
   * The terminal goes back FIRST, before the flag the loop will eventually
   * notice. A run killed while holding SPACE would otherwise leave the shell
   * without echo or line editing, and the person's next act would be to close
   * the window rather than run this again.
   *
   * Both calls inside are async-signal-safe and the whole thing is idempotent.
   */
  cli_keyboard_restore_terminal();
  cli_main_interrupted = 1;
}

static bool cli_main_copy_field(
    char *out, size_t capacity, const char *value)
{
  assert(out != NULL && capacity > 0U);
  if (value == NULL || value[0] == '\0') return false;
  const size_t length = strlen(value);
  if (length >= capacity) return false;
  memcpy(out, value, length + 1U);
  return true;
}

static void cli_main_explain_options(
    enum cli_options_status status, const char *problem)
{
  assert(problem != NULL);
  if (status == CLI_OPTIONS_ERR_UNKNOWN) {
    (void)fprintf(stderr, "unknown option: %s\n", problem);
  } else if (status == CLI_OPTIONS_ERR_MISSING_VALUE) {
    (void)fprintf(stderr, "%s requires a value\n", problem);
  } else if (status == CLI_OPTIONS_ERR_NOT_A_NUMBER &&
             strcmp(problem, "--converse") == 0) {
    (void)fprintf(stderr, "--converse must be a positive number\n");
  } else if (status == CLI_OPTIONS_ERR_NOT_A_NUMBER) {
    (void)fprintf(
        stderr, "--colleague-every must be a nonnegative integer\n");
  } else if (status == CLI_OPTIONS_ERR_INCOMPATIBLE) {
    /*
     * Print what the parser actually found. This used to print a fixed
     * sentence about --converse whatever the incompatibility was, so a bad
     * --name was reported as a missing --utterance-dir and the operator went
     * looking in the wrong place.
     */
    (void)fprintf(stderr, "%s\n", problem);
  } else {
    (void)fprintf(
        stderr, "project id, API key, and OS base URL are required; see --help\n");
  }
}

static bool cli_main_init_control_rings(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  const enum iterate_kit_status inbox = iterate_kit_spsc_ring_init(
      &runtime->control_inbox, runtime->inbox_storage,
      ITERATE_KIT_VOICE_CONTROL_INBOX_SLOT_CAPACITY,
      ITERATE_KIT_VOICE_CONTROL_INBOX_SLOTS, runtime->inbox_lengths);
  const enum iterate_kit_status outbox = iterate_kit_spsc_ring_init(
      &runtime->control_outbox, runtime->outbox_storage,
      ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOT_CAPACITY,
      ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS, runtime->outbox_lengths);
  if (inbox == ITERATE_KIT_OK && outbox == ITERATE_KIT_OK) return true;
  cli_runtime_log("error", "bounded control ring initialization failed");
  return false;
}

static bool cli_main_init_configuration(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  const bool copied = cli_main_copy_field(
      runtime->configuration.project_id,
      sizeof(runtime->configuration.project_id), runtime->options.project_id) &&
      cli_main_copy_field(
          runtime->configuration.project_api_key,
          sizeof(runtime->configuration.project_api_key),
          runtime->options.project_api_key) &&
      cli_main_copy_field(
          runtime->configuration.os_base_url,
          sizeof(runtime->configuration.os_base_url),
          runtime->options.os_base_url) &&
      cli_main_copy_field(
          runtime->configuration.pcm_base_url,
          sizeof(runtime->configuration.pcm_base_url),
          runtime->options.os_base_url);
  if (copied) return true;
  cli_runtime_log("error", "configuration value missing or exceeds firmware bound");
  return false;
}

static bool cli_main_init_peer(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  runtime->module = cli_capabilities_module(
      &runtime->capabilities, runtime);
  size_t description_length = 0U;
  const char *description = cli_capabilities_description(&description_length);
  const struct iterate_kit_peer_options options = {
    .description_expression = description,
    .description_expression_length = description_length,
    .modules = &runtime->module,
    .module_count = 1U,
  };
  if (iterate_kit_peer_init(&runtime->peer, &options) == CAPNWEB_OK) return true;
  cli_runtime_log("error", "capability peer initialization failed");
  return false;
}

static bool cli_main_init_connection(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  runtime->mount_path[0] = "kit";
  runtime->mount_path[1] = runtime->options.name;
  const struct iterate_kit_itx_connection_options options = {
    .pending_calls = runtime->pending_calls,
    .pending_call_count = ITERATE_KIT_VOICE_PENDING_CALL_CAPACITY,
    .exports = runtime->exports,
    .export_count = ITERATE_KIT_VOICE_EXPORT_CAPACITY,
    .imports = runtime->imports,
    .import_count = ITERATE_KIT_VOICE_IMPORT_CAPACITY,
    .tokens = runtime->tokens,
    .token_count = ITERATE_KIT_VOICE_TOKEN_CAPACITY,
    .outbound_buffer = runtime->output,
    .outbound_buffer_size = sizeof(runtime->output),
    .send_text = iterate_kit_posix_itx_transport_send_text,
    .send_text_context = &runtime->transport,
    .project_id = runtime->configuration.project_id,
    .project_api_key = runtime->configuration.project_api_key,
    .mount_path = runtime->mount_path,
    .mount_path_count =
        sizeof(runtime->mount_path) / sizeof(runtime->mount_path[0]),
    .capability = iterate_kit_peer_capability(&runtime->peer),
    .instructions = CLI_MAIN_CONNECTION_INSTRUCTIONS,
    .session_ended = cli_capabilities_session_ended,
    .session_ended_context = runtime,
  };
  if (iterate_kit_itx_connection_init(
          &runtime->connection, &options) == CAPNWEB_OK) return true;
  cli_runtime_log("error", "Cap'n Web connection initialization failed");
  return false;
}

static bool cli_main_init_transport(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  const struct iterate_kit_posix_itx_transport_options options = {
    .configuration = &runtime->configuration,
    .connection = &runtime->connection,
    .control_inbox = &runtime->control_inbox,
    .control_outbox = &runtime->control_outbox,
    .DANGEROUS_disable_certificate_verification = runtime->options.insecure,
  };
  if (iterate_kit_posix_itx_transport_prepare(
          &runtime->transport, &options) != ITERATE_KIT_OK) {
    cli_runtime_log("error", "POSIX itx transport initialization failed");
    return false;
  }
  if (iterate_kit_posix_itx_transport_start(&runtime->transport) ==
      ITERATE_KIT_OK) return true;
  cli_runtime_log("error", "POSIX itx transport initialization failed");
  return false;
}

static bool cli_main_init_audio(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  const enum cli_wav_status wav = cli_wav_sink_open(
      &runtime->sink, runtime->options.speaker_wav);
  if (wav != CLI_WAV_OK) {
    cli_runtime_log(
        "error", "cannot open speaker WAV: %s", runtime->options.speaker_wav);
    return false;
  }
  /*
   * Order matters. The profile decides the converter's rate and lead, and the
   * harness decides what time itself will do, so both must be settled before
   * anything samples a clock or offers a frame.
   */
  if (!cli_main_init_profile(runtime)) return false;
  if (!cli_main_init_harness(runtime)) return false;
  if (!cli_main_init_converter(runtime)) return false;
  if (runtime->options.live_audio &&
      cli_audio_out_open(&runtime->live_out) != CLI_AUDIO_OUT_OK) {
    cli_runtime_log("error", "CoreAudio output initialization failed");
    return false;
  }
  if (!runtime->options.live_mic) return true;
  if (cli_audio_in_open(&runtime->live_in) == CLI_AUDIO_IN_OK) return true;
  cli_runtime_log("error", "CoreAudio input initialization failed");
  return false;
}

/** Turn the command line's recipe knobs into a schedule recipe. */
static struct cli_fault_recipe cli_main_recipe(
    const struct cli_options *options, uint64_t session_ms)
{
  struct cli_fault_recipe recipe;
  assert(options != NULL);
  memset(&recipe, 0, sizeof(recipe));
  recipe.session_ms = session_ms;
  recipe.cpu_stalls_per_minute = options->cpu_stalls_per_minute;
  recipe.cpu_stall_max_ms = options->cpu_stall_max_ms;
  recipe.clock_skews_per_minute = options->clock_skews_per_minute;
  recipe.clock_skew_max_ms = options->clock_skew_max_ms;
  recipe.clock_jitter_ms = options->clock_jitter_ms;
  recipe.wire_stalls_per_minute = options->wire_stalls_per_minute;
  recipe.wire_stall_max_ms = options->wire_stall_max_ms;
  recipe.wire_resets_per_session = options->wire_resets;
  recipe.wire_throttle_fps = options->wire_throttle_fps;
  recipe.frame_loss_one_in = options->frame_loss_one_in;
  recipe.frame_duplicate_one_in = options->frame_duplicate_one_in;
  recipe.frame_reorder_one_in = options->frame_reorder_one_in;
  recipe.mic_short_one_in = options->mic_short_one_in;
  recipe.mic_clip = options->mic_clip;
  return recipe;
}

/** Read a schedule back from a file, so a failure can be replayed exactly. */
static bool cli_main_load_schedule(
    struct cli_fault_schedule *schedule, const char *path)
{
  enum cli_fault_schedule_status status;
  FILE *file = fopen(path, "r");
  assert(schedule != NULL && path != NULL);
  if (file == NULL) {
    cli_runtime_log("error", "cannot read schedule %s", path);
    return false;
  }
  status = cli_fault_schedule_read_json(schedule, file);
  (void)fclose(file);
  if (status == CLI_FAULT_SCHEDULE_OK) return true;
  cli_runtime_log(
      "error", "schedule %s is %s", path,
      cli_fault_schedule_status_name(status));
  return false;
}

/** Write the schedule actually used, so it can be attached to a bug. */
static void cli_main_save_schedule(
    const struct cli_fault_schedule *schedule, const char *path)
{
  FILE *file;
  assert(schedule != NULL && path != NULL);
  file = fopen(path, "w");
  if (file == NULL) {
    cli_runtime_log("warn", "cannot write schedule %s", path);
    return;
  }
  (void)cli_fault_schedule_write_json(schedule, file);
  (void)fclose(file);
}

/**
 * Draw this session's adversity, then arm the clock with it.
 *
 * The seed is logged FIRST, before anything can fail, because a truncated log
 * from an overnight run must still carry the one number that reproduces it.
 * It is logged last as well, by the report, since that is where anybody looks.
 */
static bool cli_main_init_harness(struct cli_runtime *runtime)
{
  const struct cli_options *options = &runtime->options;
  uint64_t session_ms;
  assert(runtime != NULL);

  cli_fault_schedule_clear(&runtime->schedule);
  session_ms = (uint64_t)((options->converse_minutes > 0.0
                               ? options->converse_minutes
                               : CLI_MAIN_DEFAULT_SESSION_MINUTES) *
                          60000.0);
  if (options->schedule_in != NULL) {
    if (!cli_main_load_schedule(&runtime->schedule, options->schedule_in)) {
      return false;
    }
  } else if (options->schedule_seed != 0U) {
    const struct cli_fault_recipe recipe =
        cli_main_recipe(options, session_ms);
    const enum cli_fault_schedule_status status = cli_fault_schedule_generate(
        &runtime->schedule, options->schedule_seed, &recipe);
    if (status != CLI_FAULT_SCHEDULE_OK) {
      cli_runtime_log(
          "error", "cannot draw a schedule: %s",
          cli_fault_schedule_status_name(status));
      return false;
    }
  }
  if (options->schedule_out != NULL) {
    cli_main_save_schedule(&runtime->schedule, options->schedule_out);
  }
  if (!runtime->schedule.empty) {
    cli_runtime_log(
        "info", "schedule seed=%" PRIu64 " episodes=%zu sessionMs=%" PRIu64,
        runtime->schedule.seed, runtime->schedule.episode_count,
        runtime->schedule.session_ms);
  }
  return cli_main_arm_clock(runtime);
}

/** Point the process's one clock at the schedule, sealed or anchored. */
static bool cli_main_arm_clock(struct cli_runtime *runtime)
{
  struct cli_virtual_clock *clock = cli_runtime_clock();
  const struct cli_fault_schedule *schedule =
      runtime->schedule.empty ? NULL : &runtime->schedule;
  enum cli_virtual_clock_status status;
  assert(runtime != NULL);

  if (runtime->options.sealed) {
    cli_runtime_log(
        "info", "sealed: no host clock is read, so this seed replays exactly");
    return cli_virtual_clock_seal(clock, schedule) == CLI_VIRTUAL_CLOCK_OK;
  }
  status = cli_virtual_clock_anchor(
      clock, cli_virtual_clock_now_ms(clock), runtime->options.clock_rate,
      schedule);
  if (status == CLI_VIRTUAL_CLOCK_OK) return true;
  cli_runtime_log(
      "error", "--clock-rate %u is %s", runtime->options.clock_rate,
      cli_virtual_clock_status_name(status));
  return false;
}

/**
 * Adopt a board's bounded sizes, so "it works on the CLI" stops meaning "it
 * works at the host's sizes".
 */
static bool cli_main_init_profile(struct cli_runtime *runtime)
{
  const struct cli_device_profile *profile = NULL;
  assert(runtime != NULL);
  if (runtime->options.device == NULL) {
    runtime->profile = cli_device_profile_default();
    return true;
  }
  if (cli_device_profile_find(runtime->options.device, &profile) !=
      CLI_DEVICE_PROFILE_OK) {
    size_t index;
    cli_runtime_log("error", "no device named %s. Known:",
                    runtime->options.device);
    for (index = 0U; index < cli_device_profile_count(); index++) {
      cli_runtime_log("error", "  %s", cli_device_profile_at(index)->name);
    }
    return false;
  }
  if (!cli_device_profile_check(profile)) {
    cli_runtime_log("error", "device profile %s is incoherent", profile->name);
    return false;
  }
  runtime->profile = profile;
  cli_runtime_log("info", "device %s: %s", profile->name, profile->summary);
  return true;
}

static bool cli_main_init_converter(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  /*
   * A device profile names the converter's true rate and lead, so wearing a
   * board implies pacing at that board's rate: a rig claiming to be the
   * Waveshare while its speaker accepts everything instantly is claiming the
   * one thing the board never does.
   */
  const struct cli_paced_sink_config config = {
    .frames_per_second = runtime->options.speaker_pace_fps != 0U
                             ? runtime->options.speaker_pace_fps
                             : (runtime->options.device != NULL
                                    ? runtime->profile->capture_frames_per_second
                                    : 0U),
    .depth_frames = runtime->options.device != NULL
                        ? runtime->profile->output_lead_frames
                        : 0U,
  };
  if (cli_paced_sink_configure(&runtime->paced_sink, &config) !=
      CLI_PACED_SINK_OK) {
    cli_runtime_log(
        "error", "--speaker-pace %u is not a rate any converter runs at",
        runtime->options.speaker_pace_fps);
    return false;
  }
  if (!cli_paced_sink_paced(&runtime->paced_sink)) return true;
  cli_runtime_log(
      "info", "speaker paced at %u frames/second, %u frames of lead",
      runtime->paced_sink.frames_per_second, runtime->paced_sink.depth_frames);
  return true;
}

static bool cli_main_init_keyboard(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  if (runtime->options.minutes > 0.0) {
    runtime->finish_at_ms = runtime->started_ms +
        (uint64_t)(runtime->options.minutes * CLI_MAIN_MS_PER_MINUTE);
  }
  if (!runtime->options.push_to_talk) return true;
  const enum cli_keyboard_status status =
      cli_keyboard_open(&runtime->keyboard);
  if (status == CLI_KEYBOARD_OK) {
    cli_runtime_log(
        "info", "hold SPACE to talk, release to send, q to hang up");
    return true;
  }
  cli_runtime_log(
      "error", "cannot take the keyboard: %s",
      cli_keyboard_status_name(status));
  return false;
}

static bool cli_main_init_input(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  if (runtime->options.converse_minutes > 0.0) {
    const struct cli_conversation_options options = {
      .directory = runtime->options.utterance_dir,
      .minutes = runtime->options.converse_minutes,
      .back_office_every = runtime->options.back_office_every,
      .now_ms = runtime->started_ms,
    };
    const enum cli_conversation_status status = cli_conversation_init(
        &runtime->conversation, &options);
    if (status == CLI_CONVERSATION_OK) return true;
    cli_runtime_log(
        "error", "no usable WAVs in %s", runtime->options.utterance_dir);
    return false;
  }
  runtime->conversation.state = CLI_CONVERSATION_DISABLED;
  /* With a live microphone the source is the room, and it never runs out. */
  if (runtime->options.live_mic) return true;
  const enum cli_wav_status status = cli_wav_source_open(
      &runtime->source, runtime->options.mic_wav);
  if (status == CLI_WAV_OK) {
    if (runtime->options.mic_wav == NULL) {
      cli_runtime_log(
          "warn", "no microphone WAV; using bounded voiced test synthesis");
    }
    return true;
  }
  cli_runtime_log("error", "invalid microphone WAV: %s",
                  runtime->options.mic_wav);
  return false;
}

static bool cli_main_init_runtime(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  if (!cli_main_init_configuration(runtime)) return false;
  if (!cli_main_init_control_rings(runtime)) return false;
  if (!cli_main_init_peer(runtime)) return false;
  if (!cli_main_init_connection(runtime)) return false;
  if (!cli_main_init_transport(runtime)) return false;
  if (!cli_main_init_audio(runtime)) return false;
  runtime->started_ms = cli_runtime_now_ms(NULL);
  if (!cli_main_init_input(runtime)) return false;
  if (!cli_main_init_keyboard(runtime)) return false;
  cli_speaker_clear(&runtime->speaker);
  cli_microphone_clear(&runtime->microphone);
  iterate_kit_playout_reset(&runtime->playout, CLI_MAIN_INITIAL_PLAYOUT_SEQUENCE);
  iterate_kit_voice_playback_clock_init(&runtime->playback_clock);
  cli_runtime_log(
      "info", "iterate-kit-cli ready mount=kit.%s stream=%s staticBytes=%zu outbox=%u",
      runtime->options.name, runtime->options.stream_path, sizeof(*runtime),
      ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS);
  return true;
}

static void cli_main_close_runtime(struct cli_runtime *runtime)
{
  if (runtime == NULL) return;
  /* The terminal goes back first; everything after it can take its time. */
  cli_keyboard_close(&runtime->keyboard);
  (void)iterate_kit_posix_itx_transport_stop(&runtime->transport);
  cli_wav_source_close(&runtime->source);
  cli_wav_sink_close(&runtime->sink);
  cli_audio_out_close(&runtime->live_out);
  cli_audio_in_close(&runtime->live_in);
}

static void cli_main_start_voicelab(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  if (runtime->transport.state != ITERATE_KIT_POSIX_ITX_READY ||
      runtime->connection.state != ITERATE_KIT_ITX_CONNECTION_READY ||
      runtime->voicelab_generation == runtime->connection.generation) return;
  const struct iterate_kit_voicelab_options options = {
    .session = &runtime->connection.session,
    .project_id = runtime->configuration.project_id,
    .project_api_key = runtime->configuration.project_api_key,
    .stream_path = runtime->options.stream_path,
    .call_id = runtime->options.name,
    .now_ms = cli_runtime_now_ms,
    .on_speaker = cli_main_on_speaker,
    .on_control = cli_main_on_control,
    .on_transcript = cli_main_on_transcript,
    .clock_context = NULL,
    .downlink_context = runtime,
  };
  const enum capnweb_status status = iterate_kit_voicelab_start(
      &runtime->voicelab, &options);
  if (status != CAPNWEB_OK) {
    cli_runtime_log("error", "voicelab start failed status=%d", status);
    return;
  }
  if (runtime->mounted_once) ++runtime->session_restarts;
  runtime->mounted_once = true;
  runtime->voicelab_generation = runtime->connection.generation;
  runtime->frame_sequence = 0U;
  cli_runtime_log(
      "info", "voicelab mount generation=%u", runtime->connection.generation);
}

static void cli_main_on_speaker(
    void *context,
    const uint8_t *pcm,
    size_t length,
    const struct iterate_kit_playout_frame *identity)
{
  struct cli_runtime *runtime = context;
  if (runtime == NULL || pcm == NULL || identity == NULL ||
      (length & 1U) != 0U || length != ITERATE_KIT_VOICE_FRAME_BYTES) {
    if (runtime != NULL) ++runtime->speaker_bad_frames;
    return;
  }
  const enum iterate_kit_playout_action action = iterate_kit_playout_classify(
      &runtime->playout, identity);
  if (action == ITERATE_KIT_PLAYOUT_IGNORE) return;
  if (action == ITERATE_KIT_PLAYOUT_REPLACE) {
    cli_speaker_clear(&runtime->speaker);
    iterate_kit_voice_playback_clock_reprime(&runtime->playback_clock);
  }
  if (length > cli_speaker_space(&runtime->speaker)) {
    ++runtime->speaker_overflow_drops;
    return;
  }
  if (iterate_kit_voice_playback_clock_audio_arrived(
          &runtime->playback_clock, cli_runtime_now_ms(NULL))) {
    ++runtime->speaker_underruns;
    if (runtime->conversation.current_turn != NULL) {
      ++runtime->conversation.current_turn->underruns;
    }
  }
  if (cli_speaker_write(&runtime->speaker, pcm, length) != CLI_SPEAKER_OK) {
    ++runtime->speaker_overflow_drops;
    return;
  }
  if (runtime->conversation.current_turn != NULL) {
    ++runtime->conversation.current_turn->frames_received;
  }
}

static void cli_main_on_control(
    void *context, enum iterate_kit_voicelab_control control)
{
  struct cli_runtime *runtime = context;
  if (runtime == NULL) return;
  if (control == ITERATE_KIT_VOICELAB_CONTROL_SPEECH_STARTED) {
    cli_speaker_clear(&runtime->speaker);
    iterate_kit_playout_interrupt(&runtime->playout);
    iterate_kit_voice_playback_clock_reprime(&runtime->playback_clock);
    ++runtime->barge_in_flushes;
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_RESPONSE_DONE) {
    /*
     * Completion can precede its audio on the wire. Marking playout abandoned
     * here discarded every following frame as stale, so only the clock learns
     * the answer is closed; the queued identity remains valid until drained.
     */
    runtime->answer_done = true;
    iterate_kit_voice_playback_clock_answer_done(&runtime->playback_clock);
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_CALL_ACCEPTED) {
    cli_runtime_log("info", "call accepted");
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_CALL_ENDED) {
    cli_runtime_log("warn", "call ended by the bridge");
    ++runtime->calls_lost;
    runtime->talking = false;
    runtime->flushing_turn = false;
    runtime->wants_talk = false;
    cli_runtime_log(
        "warn", "call ended; wantsCall=%s",
        runtime->wants_call ? "true" : "false");
  }
}

static void cli_main_on_transcript(
    void *context, bool from_user, const char *text, bool final)
{
  (void)context;
  if (!final) return;
  cli_runtime_log(
      "info", "transcript speaker=%s text=%s",
      from_user ? "user" : "assistant", text);
}

static void cli_main_record_frame(
    struct cli_runtime *runtime, const uint8_t *pcm)
{
  assert(runtime != NULL && pcm != NULL);
  if (cli_wav_sink_write(
          &runtime->sink, pcm, ITERATE_KIT_VOICE_FRAME_BYTES) != CLI_WAV_OK) {
    ++runtime->speaker_write_failures;
    runtime->stop_requested = true;
    return;
  }
  (void)cli_audio_out_write(
      &runtime->live_out, pcm, ITERATE_KIT_VOICE_FRAME_BYTES);
}

static void cli_main_record_converter_silence(
    struct cli_runtime *runtime, uint32_t frames)
{
  assert(runtime != NULL);
  /*
   * An underrun is silence a listener HEARD. Leaving it out of the recording
   * is how a run that dropped a fifth of a second of a call produces a WAV
   * that is simply a fifth of a second shorter and sounds perfect — a file
   * has no timestamps, so nothing downstream can notice the difference.
   *
   * The count is bounded by the converter model, which resyncs rather than
   * replaying an unbounded schedule, so this cannot become an unbounded write.
   *
   * The count itself stays in the converter model rather than being folded
   * into speaker_underruns, which already means something else: that the ring
   * was dry when more speech arrived. One is a fact about this rig's
   * scheduler, the other about the downlink, and a single number would answer
   * neither question.
   */
  static const uint8_t silence[ITERATE_KIT_VOICE_FRAME_BYTES] = {0};
  for (uint32_t index = 0U; index < frames; ++index) {
    cli_main_record_frame(runtime, silence);
  }
}

static void cli_main_write_playback(
    struct cli_runtime *runtime, const uint8_t *pcm)
{
  assert(runtime != NULL && pcm != NULL);
  cli_main_record_frame(runtime, pcm);
  (void)cli_paced_sink_offer(&runtime->paced_sink);
}

static void cli_main_finish_answer_if_ready(
    struct cli_runtime *runtime, uint64_t now_ms)
{
  assert(runtime != NULL);
  struct cli_report_turn *turn = runtime->conversation.current_turn;
  if (turn == NULL) return;
  const bool played_out = runtime->answer_done && runtime->speaker.used == 0U &&
      turn->frames_played > 0U;
  const bool overdue = turn->committed_ms != 0U &&
      iterate_kit_voice_elapsed_ms(now_ms, turn->committed_ms) >
          ITERATE_KIT_VOICE_TURN_MAX_MS;
  if (!played_out && !overdue) return;
  runtime->answer_done = false;
  cli_conversation_finish_turn(runtime, now_ms);
  if (runtime->conversation.state == CLI_CONVERSATION_WAIT_ANSWER) {
    runtime->conversation.state = CLI_CONVERSATION_GAP;
    runtime->conversation.next_action_at_ms =
        now_ms + CLI_CONVERSATION_GAP_MS;
  }
}

static void cli_main_conceal_if_needed(
    struct cli_runtime *runtime, uint64_t now_ms)
{
  assert(runtime != NULL);
  const enum iterate_kit_voice_playback_action action =
      iterate_kit_voice_playback_clock_empty(&runtime->playback_clock, now_ms);
  if (action != ITERATE_KIT_VOICE_PLAYBACK_CONCEAL) return;
  static const uint8_t silence[ITERATE_KIT_VOICE_FRAME_BYTES] = {0};
  cli_main_write_playback(runtime, silence);
  ++runtime->speaker_conceal_frames;
  if (runtime->conversation.current_turn != NULL) {
    ++runtime->conversation.current_turn->frames_concealed;
  }
}

static void cli_main_play_frame(
    struct cli_runtime *runtime, const uint8_t *frame, uint64_t now_ms)
{
  assert(runtime != NULL && frame != NULL);
  const enum iterate_kit_voice_playback_action action =
      iterate_kit_voice_playback_clock_frame(
          &runtime->playback_clock, (uint32_t)runtime->speaker.used,
          runtime->speaker_frames_played, now_ms);
  if (action == ITERATE_KIT_VOICE_PLAYBACK_DROP_CATCHUP) {
    ++runtime->speaker_catchup_frames;
    return;
  }
  if (action == ITERATE_KIT_VOICE_PLAYBACK_DROP_DEBT) {
    ++runtime->speaker_debt_paid;
    return;
  }
  if (action != ITERATE_KIT_VOICE_PLAYBACK_PLAY) return;
  cli_main_write_playback(runtime, frame);
  ++runtime->speaker_frames_played;
  ++runtime->speaker_writes;
  const uint32_t margin = cli_speaker_queued_ms(&runtime->speaker);
  if (runtime->speaker_writes == 1U ||
      margin < runtime->speaker_margin_min_ms) {
    runtime->speaker_margin_min_ms = margin;
  }
  if (margin > runtime->speaker_margin_max_ms) {
    runtime->speaker_margin_max_ms = margin;
  }
  struct cli_report_turn *turn = runtime->conversation.current_turn;
  if (turn == NULL) return;
  cli_report_observe_occupancy(turn, margin);
  ++turn->frames_played;
  if (turn->first_audio_ms == 0U) turn->first_audio_ms = now_ms;
}

static void cli_main_poll_playback(
    struct cli_runtime *runtime, uint64_t now_ms)
{
  assert(runtime != NULL);
  /*
   * The converter's clock moves whether or not anybody feeds it, so it is
   * advanced before the software deadline is even consulted. Unpaced this is
   * a no-op and everything below is exactly what it was.
   */
  cli_main_record_converter_silence(
      runtime,
      cli_paced_sink_advance(&runtime->paced_sink, cli_runtime_now_us()));
  if (runtime->next_playback_at_ms == 0U) {
    runtime->next_playback_at_ms = now_ms;
  }
  if (now_ms < runtime->next_playback_at_ms) return;
  runtime->next_playback_at_ms += ITERATE_KIT_VOICE_FRAME_MS;
  const uint64_t stall_limit = runtime->next_playback_at_ms +
      ITERATE_KIT_VOICE_FRAME_MS * CLI_MAIN_HOST_STALL_FRAMES;
  if (now_ms > stall_limit) {
    /* Host scheduler stalls remain visible but are never replayed as a burst. */
    runtime->next_playback_at_ms = now_ms + ITERATE_KIT_VOICE_FRAME_MS;
  }
  cli_main_finish_answer_if_ready(runtime, now_ms);
  cli_main_feed_playback(runtime, now_ms);
}

static void cli_main_feed_playback(
    struct cli_runtime *runtime, uint64_t now_ms)
{
  assert(runtime != NULL);
  /*
   * The first frame is unconditional, which is what this loop did before a
   * converter was modelled. The continuation is the converter still asking:
   * an unpaced sink never asks, so the default path takes exactly one frame
   * per due tick and is unchanged.
   *
   * The explicit bound is not belt and braces. A frame the playback clock
   * DISCARDS never reaches the converter and so never fills a slot, and
   * without a count a discard policy would drain the whole thirty-second ring
   * in one iteration while the converter went on asking.
   */
  uint32_t fed = 0U;
  do {
    if (!iterate_kit_voice_playback_clock_ready(
            &runtime->playback_clock, (uint32_t)runtime->speaker.used)) return;
    uint8_t frame[ITERATE_KIT_VOICE_FRAME_BYTES] = {0};
    if (cli_speaker_read(&runtime->speaker, frame, sizeof(frame)) !=
        CLI_SPEAKER_OK) {
      cli_main_conceal_if_needed(runtime, now_ms);
      return;
    }
    cli_main_play_frame(runtime, frame, now_ms);
    ++fed;
  } while (fed < CLI_PACED_SINK_MAX_DEPTH_FRAMES &&
           cli_paced_sink_ready(&runtime->paced_sink));
}

static void cli_main_capture_frame(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  if (runtime->options.live_mic) {
    cli_main_capture_live_frame(runtime);
    return;
  }
  cli_main_capture_recorded_frame(runtime);
}

static void cli_main_capture_live_frame(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  /*
   * Nothing is captured once the turn is flushing. The frames already queued
   * are what the person said; adding more would keep the queue from ever
   * draining and hold the commit open until its timeout, so every turn would
   * end a second and a half after the key came up.
   */
  if (runtime->flushing_turn) return;
  uint8_t frame[ITERATE_KIT_VOICE_FRAME_BYTES] = {0};
  if (cli_audio_in_pop(&runtime->live_in, frame, sizeof(frame)) !=
      CLI_AUDIO_IN_OK) return;
  ++runtime->mic_frames_captured;
  (void)cli_microphone_push(&runtime->microphone, frame, sizeof(frame));
}

static void cli_main_capture_recorded_frame(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  uint8_t frame[ITERATE_KIT_VOICE_FRAME_BYTES] = {0};
  if (runtime->source_finished) return;
  if (cli_wav_source_frame(&runtime->source, frame, sizeof(frame)) !=
      CLI_WAV_OK) {
    runtime->source_finished = true;
    return;
  }
  ++runtime->mic_frames_captured;
  (void)cli_microphone_push(&runtime->microphone, frame, sizeof(frame));
}

static void cli_main_send_microphone(struct cli_runtime *runtime, uint64_t now_ms)
{
  assert(runtime != NULL);
  const size_t queued = cli_microphone_queued(&runtime->microphone);
  /*
   * A partial batch is sent once no more frames are coming: the recording ran
   * out, or the turn is flushing because the talk button came up. Without the
   * flush case a live microphone would strand up to three frames — the last
   * syllable of the sentence — until the flush timeout threw them away.
   */
  if (queued < ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND &&
      !runtime->source_finished && !runtime->flushing_turn) return;
  if (queued == 0U) return;
  struct iterate_kit_spsc_ring_metrics outbox = {0};
  iterate_kit_spsc_ring_metrics(&runtime->control_outbox, &outbox);
  const size_t free_slots = ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS -
      outbox.current_slots;
  if (free_slots < ITERATE_KIT_VOICE_MIC_OUTBOX_RESERVE) return;
  const size_t frame_count = queued < ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND
      ? queued
      : ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND;
  const uint8_t *frames[ITERATE_KIT_VOICE_MIC_FRAMES_PER_APPEND] = {0};
  for (size_t index = 0U; index < frame_count; ++index) {
    const size_t slot = (runtime->microphone.read + index) %
        ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH;
    frames[index] = runtime->microphone.frames[slot];
  }
  const enum capnweb_status status = iterate_kit_voicelab_append_frames(
      &runtime->voicelab, frames, frame_count,
      ITERATE_KIT_VOICE_FRAME_BYTES, runtime->frame_sequence, now_ms);
  if (status != CAPNWEB_OK) return;
  runtime->frame_sequence += (uint32_t)frame_count;
  runtime->microphone.read = (runtime->microphone.read + frame_count) %
      ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH;
  runtime->microphone.used -= frame_count;
  runtime->flush_frames_left = (uint32_t)runtime->microphone.used;
}

static void cli_main_poll_microphone(
    struct cli_runtime *runtime, uint64_t now_ms)
{
  assert(runtime != NULL);
  if (runtime->next_mic_at_ms == 0U) runtime->next_mic_at_ms = now_ms;
  if (now_ms < runtime->next_mic_at_ms) return;
  runtime->next_mic_at_ms += ITERATE_KIT_VOICE_FRAME_MS;
  const uint64_t stall_limit = runtime->next_mic_at_ms +
      ITERATE_KIT_VOICE_FRAME_MS * CLI_MAIN_HOST_STALL_FRAMES;
  if (now_ms > stall_limit) {
    ++runtime->mic_frames_dropped;
    runtime->next_mic_at_ms = now_ms + ITERATE_KIT_VOICE_FRAME_MS;
  }
  if (!runtime->talking) {
    ++runtime->mic_frames_gated;
    return;
  }
  cli_main_capture_frame(runtime);
  cli_main_send_microphone(runtime, now_ms);
}

static void cli_main_start_talk(
    struct cli_runtime *runtime, uint64_t now_ms, size_t outbox_free)
{
  assert(runtime != NULL);
  const bool wants_talk = runtime->wants_call && runtime->wants_talk;
  if (!wants_talk || runtime->talking || !runtime->voicelab.call_active ||
      outbox_free < CLI_MAIN_CALL_OUTBOX_SLOTS) return;
  /* A recording has to be rewound for each turn; a room does not. */
  if (runtime->conversation.state == CLI_CONVERSATION_DISABLED &&
      !runtime->options.live_mic) {
    if (cli_wav_source_open(&runtime->source, runtime->options.mic_wav) !=
        CLI_WAV_OK) {
      cli_runtime_log("error", "cannot rewind microphone WAV for new turn");
      runtime->wants_talk = false;
      return;
    }
    runtime->source_finished = false;
  }
  runtime->talking = true;
  runtime->flushing_turn = false;
  runtime->turn_started_ms = now_ms;
  runtime->frame_sequence = 0U;
  cli_microphone_clear(&runtime->microphone);
  cli_speaker_clear(&runtime->speaker);
  iterate_kit_playout_interrupt(&runtime->playout);
  iterate_kit_voice_playback_clock_reprime(&runtime->playback_clock);
  (void)iterate_kit_voicelab_mark_turn(
      &runtime->voicelab, ITERATE_KIT_VOICELAB_TURN_START);
}

static void cli_main_finish_talk(
    struct cli_runtime *runtime, uint64_t now_ms)
{
  assert(runtime != NULL);
  if (!runtime->flushing_turn) return;
  if (runtime->microphone.used != 0U && now_ms < runtime->flush_deadline_ms) {
    return;
  }
  if (runtime->microphone.used != 0U) {
    runtime->mic_frames_dropped += (uint32_t)runtime->microphone.used;
    cli_microphone_clear(&runtime->microphone);
  }
  runtime->talking = false;
  runtime->flushing_turn = false;
  (void)iterate_kit_voicelab_mark_turn(
      &runtime->voicelab, ITERATE_KIT_VOICELAB_TURN_COMMIT);
}

static void cli_main_reconcile_talk(
    struct cli_runtime *runtime, uint64_t now_ms, size_t outbox_free)
{
  assert(runtime != NULL);
  const bool ready = runtime->voicelab.state == ITERATE_KIT_VOICELAB_READY &&
      runtime->voicelab.call_active;
  if (runtime->talking && !runtime->flushing_turn && !ready) {
    runtime->talking = false;
    runtime->flushing_turn = false;
  }
  if (runtime->talking && !runtime->flushing_turn &&
      iterate_kit_voice_elapsed_ms(now_ms, runtime->turn_started_ms) >
          ITERATE_KIT_VOICE_TURN_MAX_MS) runtime->wants_talk = false;
  cli_main_start_talk(runtime, now_ms, outbox_free);
  const bool wants_talk = runtime->wants_call && runtime->wants_talk;
  if (!wants_talk && runtime->talking && !runtime->flushing_turn) {
    runtime->flushing_turn = true;
    runtime->flush_frames_left = (uint32_t)runtime->microphone.used;
    runtime->flush_deadline_ms =
        now_ms + ITERATE_KIT_VOICE_TURN_FLUSH_TIMEOUT_MS;
  }
  cli_main_finish_talk(runtime, now_ms);
}

static void cli_main_reconcile_call(
    struct cli_runtime *runtime, uint64_t now_ms, size_t outbox_free)
{
  assert(runtime != NULL);
  if (runtime->voicelab.call_pending &&
      runtime->call_pending_since_ms != 0U &&
      iterate_kit_voice_elapsed_ms(now_ms, runtime->call_pending_since_ms) >
          CLI_MAIN_CALL_PENDING_TIMEOUT_MS) {
    iterate_kit_voicelab_forget_call(&runtime->voicelab);
    runtime->call_pending_since_ms = 0U;
    runtime->next_call_attempt_at_ms = 0U;
  }
  if (!runtime->voicelab.call_pending) runtime->call_pending_since_ms = 0U;
  if (runtime->wants_call && !runtime->voicelab.call_active &&
      !runtime->voicelab.call_pending &&
      outbox_free >= CLI_MAIN_CALL_OUTBOX_SLOTS &&
      now_ms >= runtime->next_call_attempt_at_ms) {
    runtime->call_pending_since_ms = now_ms;
    runtime->next_call_attempt_at_ms =
        now_ms + CLI_MAIN_CALL_START_RETRY_MS;
    (void)iterate_kit_voicelab_start_call(
        &runtime->voicelab, CLI_MAIN_CALL_GREETING);
  }
  if (!runtime->wants_call && runtime->voicelab.call_active &&
      outbox_free >= CLI_MAIN_CALL_OUTBOX_SLOTS) {
    (void)iterate_kit_voicelab_end_call(
        &runtime->voicelab, CLI_MAIN_CALL_END_REASON);
  }
}

static void cli_main_supervise_transport(
    struct cli_runtime *runtime, uint64_t now_ms)
{
  assert(runtime != NULL);
  if (runtime->transport.state != ITERATE_KIT_POSIX_ITX_FAILED) {
    runtime->unhealthy_since_ms = 0U;
    return;
  }
  if (runtime->unhealthy_since_ms == 0U) runtime->unhealthy_since_ms = now_ms;
  if (iterate_kit_voice_elapsed_ms(now_ms, runtime->unhealthy_since_ms) <=
      ITERATE_KIT_VOICE_UNHEALTHY_RESTART_MS) return;
  cli_runtime_log("error", "transport unrecoverable; re-exec requested");
  cli_capabilities_request_restart(runtime, now_ms);
}

static void cli_main_supervise_liveness(
    struct cli_runtime *runtime, uint64_t now_ms)
{
  assert(runtime != NULL);
  if (runtime->last_liveness_ms == 0U) runtime->last_liveness_ms = now_ms;
  if (runtime->voicelab.ping_count != runtime->last_ping_count) {
    runtime->last_ping_count = runtime->voicelab.ping_count;
    runtime->last_liveness_ms = now_ms;
  }
  if (runtime->transport.state != ITERATE_KIT_POSIX_ITX_READY) {
    runtime->last_liveness_ms = now_ms;
  }
  const bool ping_timed_out = runtime->voicelab.ping_pending &&
      iterate_kit_voice_elapsed_ms(now_ms, runtime->voicelab.ping_started_ms) >
          ITERATE_KIT_VOICE_PING_TIMEOUT_MS;
  if (ping_timed_out && now_ms >= runtime->next_liveness_restart_at_ms) {
    runtime->next_liveness_restart_at_ms =
        now_ms + ITERATE_KIT_VOICE_PING_TIMEOUT_MS;
    ++runtime->liveness_restarts;
    ++runtime->transport_restarts;
    iterate_kit_posix_itx_transport_request_restart(&runtime->transport);
  }
  if (iterate_kit_voice_elapsed_ms(now_ms, runtime->last_liveness_ms) >
      ITERATE_KIT_VOICE_NO_LIVENESS_RESTART_MS) {
    cli_capabilities_request_restart(runtime, now_ms);
  }
}

static void cli_main_supervise_bridge(
    struct cli_runtime *runtime, uint64_t now_ms)
{
  assert(runtime != NULL);
  if (runtime->voicelab.state != ITERATE_KIT_VOICELAB_READY ||
      !runtime->voicelab.call_active ||
      runtime->voicelab.last_bridge_ms == 0U) return;
  const uint64_t bridge_age = iterate_kit_voice_elapsed_ms(
      now_ms, runtime->voicelab.last_bridge_ms);
  if (bridge_age <= ITERATE_KIT_VOICE_BRIDGE_SILENCE_MS) return;
  const uint64_t batch_age = runtime->voicelab.last_batch_ms == 0U
      ? 0U
      : iterate_kit_voice_elapsed_ms(
            now_ms, runtime->voicelab.last_batch_ms);
  cli_runtime_log(
      "warn",
      "call dropped: no bridge event for %" PRIu64
      "ms (bridgeAge=%" PRIu64 " batchAge=%" PRIu64 " batches=%u rtt=%u)",
      (uint64_t)ITERATE_KIT_VOICE_BRIDGE_SILENCE_MS, bridge_age, batch_age,
      runtime->voicelab.batches_on_connection, runtime->voicelab.last_rtt_ms);
  ++runtime->bridge_losses;
  ++runtime->calls_lost;
  iterate_kit_voicelab_forget_call(&runtime->voicelab);
  runtime->next_call_attempt_at_ms = 0U;
}

static void cli_main_supervise_downlink(
    struct cli_runtime *runtime, uint64_t now_ms, size_t outbox_free)
{
  assert(runtime != NULL);
  const bool silent = runtime->voicelab.state == ITERATE_KIT_VOICELAB_READY &&
      runtime->wants_call && runtime->voicelab.has_connection_capability &&
      !runtime->voicelab.recycle_pending &&
      outbox_free >= CLI_MAIN_RECYCLE_OUTBOX_SLOTS &&
      runtime->voicelab.last_batch_ms != 0U &&
      iterate_kit_voice_elapsed_ms(now_ms, runtime->voicelab.last_batch_ms) >
          ITERATE_KIT_VOICE_DOWNLINK_SILENCE_MS;
  if (silent) {
    ++runtime->downlink_recycles;
    if (runtime->downlink_recycles_running >=
        CLI_MAIN_RECYCLES_BEFORE_TRANSPORT) {
      runtime->downlink_recycles_running = 0U;
      ++runtime->transport_restarts;
      iterate_kit_posix_itx_transport_request_restart(&runtime->transport);
    } else {
      ++runtime->downlink_recycles_running;
      runtime->voicelab.last_batch_ms = now_ms;
      (void)iterate_kit_voicelab_recycle_connection(&runtime->voicelab);
    }
  }
  if (runtime->downlink_recycles_running > 0U &&
      runtime->voicelab.batches_on_connection > 0U) {
    runtime->downlink_recycles_running = 0U;
  }
}

static void cli_main_supervise(
    struct cli_runtime *runtime, uint64_t now_ms, size_t outbox_free)
{
  assert(runtime != NULL);
  cli_main_supervise_transport(runtime, now_ms);
  cli_main_supervise_liveness(runtime, now_ms);
  cli_main_supervise_bridge(runtime, now_ms);
  cli_main_supervise_downlink(runtime, now_ms, outbox_free);
}

static void cli_main_announce_states(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  if (runtime->transport.state != runtime->announced_transport) {
    runtime->announced_transport = runtime->transport.state;
    if (runtime->transport.state == ITERATE_KIT_POSIX_ITX_FAILED) {
      cli_main_announce_transport_failure(runtime);
    } else {
      cli_runtime_log(
          "info", "transport state=%s",
          iterate_kit_posix_itx_transport_state_name(runtime->transport.state));
    }
  }
  if (runtime->voicelab.state == runtime->announced_voicelab &&
      runtime->voicelab.failure == runtime->announced_failure) return;
  runtime->announced_voicelab = runtime->voicelab.state;
  runtime->announced_failure = runtime->voicelab.failure;
  cli_runtime_log(
      runtime->voicelab.failure == ITERATE_KIT_VOICELAB_FAILURE_NONE
          ? "info"
          : "error",
      "voicelab state=%s failure=%s capnweb=%d",
      iterate_kit_voicelab_state_name(runtime->voicelab.state),
      iterate_kit_voicelab_failure_name(runtime->voicelab.failure),
      (int)runtime->voicelab.capnweb_status);
}

static void cli_main_announce_transport_failure(
    const struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  cli_runtime_log(
      "error",
      "transport state=failed url=%s errno=%d capnweb=%d starts=%u opens=%u "
      "errors=%u disconnects=%u mountTimeouts=%u protoFail=%u recvFail=%u "
      "fatal=%u/%u",
      runtime->transport.websocket_url,
      (int)runtime->transport.last_platform_error,
      (int)runtime->transport.last_capnweb_status,
      runtime->transport.websocket_start_attempts,
      runtime->transport.websocket_connections,
      runtime->transport.websocket_errors,
      runtime->transport.websocket_disconnects,
      runtime->transport.mount_timeouts, runtime->transport.protocol_failures,
      runtime->transport.control_receive_failures,
      (unsigned)runtime->transport.fatal_failure_latched,
      runtime->transport.fatal_failure_reason);
}

static void cli_main_pulse(
    struct cli_runtime *runtime,
    uint64_t now_ms,
    const struct iterate_kit_spsc_ring_metrics *outbox)
{
  assert(runtime != NULL && outbox != NULL);
  const uint64_t age = iterate_kit_voice_elapsed_ms(
      now_ms, runtime->last_pulse_ms);
  if (!(runtime->talking || runtime->voicelab.call_active ||
        age < CLI_MAIN_PULSE_ACTIVE_TAIL_MS)) return;
  if (age < CLI_MAIN_PULSE_INTERVAL_MS) return;
  runtime->last_pulse_ms = now_ms;
  cli_runtime_log(
      "info",
      "pulse loops=%u outbox=%u/%u sent=%u frames=%u batches=%u rx=%u "
      "gaps=%u played=%u conceal=%u under=%u ringMs=%u convUnder=%u "
      "convRefused=%u micIn=%u micLost=%u",
      runtime->loop_count, outbox->current_slots,
      ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS,
      runtime->transport.control_sender.messages_sent,
      runtime->voicelab.frames_sent, runtime->voicelab.batches_on_connection,
      runtime->voicelab.spk_frames_received, runtime->playout.gaps,
      runtime->speaker_frames_played, runtime->speaker_conceal_frames,
      runtime->speaker_underruns, cli_speaker_queued_ms(&runtime->speaker),
      /*
       * A live microphone that macOS refused looks exactly like a quiet room
       * until micIn stays at zero through a turn, so it is on the one line
       * anybody watching a session will already be reading.
       */
      runtime->paced_sink.underrun_frames, runtime->paced_sink.refused_frames,
      runtime->live_in.captured, runtime->live_in.dropped);
}

static void cli_main_poll_ready(
    struct cli_runtime *runtime,
    uint64_t now_ms,
    const struct iterate_kit_spsc_ring_metrics *outbox)
{
  assert(runtime != NULL && outbox != NULL);
  if (runtime->voicelab.state != ITERATE_KIT_VOICELAB_READY ||
      runtime->transport.state != ITERATE_KIT_POSIX_ITX_READY ||
      runtime->voicelab_generation != runtime->connection.generation) return;
  const size_t outbox_free = ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS -
      outbox->current_slots;
  cli_main_reconcile_call(runtime, now_ms, outbox_free);
  cli_main_reconcile_talk(runtime, now_ms, outbox_free);
  cli_main_poll_microphone(runtime, now_ms);
  cli_main_recycle_if_ready(runtime, outbox_free);
  cli_main_poll_periodic(runtime, now_ms, outbox_free);
  cli_main_pulse(runtime, now_ms, outbox);
}

static void cli_main_poll_periodic(
    struct cli_runtime *runtime, uint64_t now_ms, size_t outbox_free)
{
  assert(runtime != NULL);
  if (runtime->next_ping_at_ms == 0U) {
    runtime->next_ping_at_ms = now_ms + CLI_MAIN_PULSE_INTERVAL_MS;
    runtime->next_stats_at_ms = now_ms + ITERATE_KIT_VOICE_STATS_INTERVAL_MS;
  }
  if (now_ms >= runtime->next_ping_at_ms &&
      outbox_free >= CLI_MAIN_CALL_OUTBOX_SLOTS) {
    (void)iterate_kit_voicelab_ping(&runtime->voicelab);
    runtime->next_ping_at_ms = now_ms + ITERATE_KIT_VOICE_PING_INTERVAL_MS;
  }
  if (now_ms >= runtime->next_stats_at_ms &&
      outbox_free >= CLI_MAIN_CALL_OUTBOX_SLOTS) {
    if (cli_capabilities_append_stats(runtime) != CLI_CAPABILITIES_OK) {
      cli_runtime_log("error", "dev-stats append failed");
    }
    runtime->next_stats_at_ms = now_ms + ITERATE_KIT_VOICE_STATS_INTERVAL_MS;
  }
}

static void cli_main_recycle_if_ready(
    struct cli_runtime *runtime, size_t outbox_free)
{
  assert(runtime != NULL);
  if (!iterate_kit_voicelab_needs_recycle(&runtime->voicelab) ||
      runtime->speaker.used != 0U || runtime->talking ||
      outbox_free < CLI_MAIN_RECYCLE_OUTBOX_SLOTS) return;
  ++runtime->downlink_recycles;
  (void)iterate_kit_voicelab_recycle_connection(&runtime->voicelab);
}

static void cli_main_reexec_if_ready(
    struct cli_runtime *runtime, uint64_t now_ms)
{
  assert(runtime != NULL);
  if (!runtime->restart_requested ||
      iterate_kit_voice_elapsed_ms(now_ms, runtime->restart_requested_at_ms) <
          CLI_MAIN_RESTART_REPLY_MS) return;
  /* The one-way transport gets a full interval to put its reply on the wire. */
  cli_runtime_log("warn", "re-executing iterate-kit-cli");
  /* execv keeps the file descriptors, so the terminal must be handed back. */
  cli_keyboard_close(&runtime->keyboard);
  cli_wav_sink_close(&runtime->sink);
  cli_audio_out_close(&runtime->live_out);
  cli_audio_in_close(&runtime->live_in);
  (void)iterate_kit_posix_itx_transport_stop(&runtime->transport);
  (void)execv(runtime->argv[0], runtime->argv);
  cli_runtime_log("error", "execv failed errno=%d", errno);
  runtime->stop_requested = true;
}

static void cli_main_apply_key(
    struct cli_runtime *runtime,
    enum cli_keyboard_event event,
    uint64_t now_ms)
{
  assert(runtime != NULL);
  switch (event) {
    case CLI_KEYBOARD_TALK_START:
      runtime->wants_talk = true;
      cli_runtime_log("info", "talking");
      break;
    case CLI_KEYBOARD_TALK_STOP:
      /*
       * Clearing the intent is the whole commit: reconcile_talk sees the turn
       * is no longer wanted, flushes whatever capture queued, and marks the
       * turn. Committing here instead would bypass the flush and cut the last
       * word off every sentence.
       */
      runtime->wants_talk = false;
      cli_runtime_log("info", "sent");
      break;
    case CLI_KEYBOARD_HANG_UP:
      cli_main_begin_hangup(runtime, now_ms);
      break;
    case CLI_KEYBOARD_NONE:
    default:
      break;
  }
}

static void cli_main_begin_hangup(
    struct cli_runtime *runtime, uint64_t now_ms)
{
  assert(runtime != NULL);
  if (runtime->hanging_up) return;
  runtime->hanging_up = true;
  runtime->wants_talk = false;
  runtime->wants_call = false;
  runtime->hangup_deadline_ms = now_ms + CLI_MAIN_HANGUP_GRACE_MS;
  cli_runtime_log("info", "hanging up");
}

static void cli_main_poll_interactive(
    struct cli_runtime *runtime, uint64_t now_ms)
{
  assert(runtime != NULL);
  if (runtime->hanging_up) {
    /*
     * Leave once the far end agrees the call is over, or once the grace has
     * run out. Waiting forever on a wedged transport would hold the person's
     * terminal; leaving at once would strand the session at the provider,
     * still listening to a room nobody is in.
     */
    if (!runtime->voicelab.call_active ||
        now_ms >= runtime->hangup_deadline_ms) runtime->stop_requested = true;
    return;
  }
  if (runtime->finish_at_ms != 0U && now_ms >= runtime->finish_at_ms) {
    cli_runtime_log("info", "session time is up");
    cli_main_begin_hangup(runtime, now_ms);
    return;
  }
  if (!runtime->options.push_to_talk) return;
  /* Nothing else asks for a call in this mode, so the key holder does. */
  runtime->wants_call = true;
  enum cli_keyboard_event event = CLI_KEYBOARD_NONE;
  if (cli_keyboard_poll(&runtime->keyboard, now_ms, &event) !=
      CLI_KEYBOARD_OK) return;
  cli_main_apply_key(runtime, event, now_ms);
}

static void cli_main_sleep(void)
{
  const struct timespec delay = {
    .tv_sec = 0,
    .tv_nsec = (long)CLI_MAIN_LOOP_MS * CLI_MAIN_NS_PER_MS,
  };
  (void)nanosleep(&delay, NULL);
}

static void cli_main_run_loop(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  /* Intentionally nonterminating event pump; signal and state flags bound it. */
  while (!runtime->stop_requested && cli_main_interrupted == 0) {
    const uint64_t now_ms = cli_runtime_now_ms(NULL);
    (void)iterate_kit_posix_itx_transport_poll(
        &runtime->transport, CLI_MAIN_TRANSPORT_POLL_EVENTS);
    cli_main_announce_states(runtime);
    cli_main_start_voicelab(runtime);
    cli_main_poll_playback(runtime, now_ms);
    cli_main_poll_interactive(runtime, now_ms);
    cli_conversation_poll(runtime, now_ms);
    struct iterate_kit_spsc_ring_metrics outbox = {0};
    iterate_kit_spsc_ring_metrics(&runtime->control_outbox, &outbox);
    const size_t outbox_free = ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS -
        outbox.current_slots;
    cli_main_supervise(runtime, now_ms, outbox_free);
    cli_main_poll_ready(runtime, now_ms, &outbox);
    ++runtime->loop_count;
    cli_main_reexec_if_ready(runtime, now_ms);
    cli_main_sleep();
  }
}
