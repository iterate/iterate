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
  CLI_MAIN_CALL_OUTBOX_SLOTS = 3,
  CLI_MAIN_RECYCLE_OUTBOX_SLOTS = 4,
  CLI_MAIN_RECYCLES_BEFORE_TRANSPORT = 3,
  CLI_MAIN_PULSE_ACTIVE_TAIL_MS = 3000,
  CLI_MAIN_PULSE_INTERVAL_MS = 1000,
  /* How stale a Ctrl-C'd recording may be. See the sync site for why it is
   * not one second. */
  CLI_MAIN_SINK_SYNC_INTERVAL_MS = 5000,
  CLI_MAIN_RESTART_REPLY_MS = 400,
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

/* Adapts the host WAV writer to the Darwin file-clock boundary. */
static bool cli_main_write_pretend_speaker(
    void *context, const uint8_t *pcm, size_t length);

/* Takes one coherent snapshot of Darwin's completion and fault evidence. */
static struct iterate_kit_darwin_audio_codec_metrics cli_main_audio_metrics(
    const struct cli_runtime *runtime);

/* Opens one source or discovers the unattended utterance set. */
static bool cli_main_init_input(struct cli_runtime *runtime);

/* Assembles every runtime boundary before polling can begin. */
static bool cli_main_init_runtime(struct cli_runtime *runtime);
static bool cli_main_init_device_controls(struct cli_runtime *runtime);

/* Releases every opened platform resource. Safe after partial initialization. */
static void cli_main_close_runtime(struct cli_runtime *runtime);

/* Drains accepted room audio through the hardware/file completion boundary. */
static bool cli_main_drain_audio(struct cli_runtime *runtime);

/* Turns asynchronous CoreAudio failures into one terminal runtime outcome. */
static void cli_main_supervise_audio(struct cli_runtime *runtime);

/* Starts a voicelab mount for each fresh ready connection generation. */
static void cli_main_start_voicelab(struct cli_runtime *runtime);

/* Receives one decoded speaker frame from voicelab. */
/* Runs one surviving frame from arrival to the speaker buffer. */
static void cli_main_accept_speaker_frame(
    struct cli_runtime *runtime,
    const uint8_t *pcm,
    size_t length);

static void cli_main_on_speaker(
    void *context, const uint8_t *pcm, size_t length);

/* Receives response and call lifecycle controls from voicelab. */
static void cli_main_on_control(
    void *context, enum iterate_kit_voicelab_control control);

/* Logs every downlink event type as it arrives, with its arrival time. */
static void cli_main_on_event_seen(
    void *context, const char *type, size_t length);

/* Records one frame on the true timeline: the WAV, then the room. */
static bool cli_main_record_frame(
    struct cli_runtime *runtime, const uint8_t *pcm);

/* Records one captured microphone frame to the uplink WAV. */
static void cli_main_record_mic_frame(
    struct cli_runtime *runtime, const uint8_t *pcm);

/* Records the silence the modelled converter emitted for want of a frame. */
static void cli_main_record_converter_silence(
    struct cli_runtime *runtime, uint32_t frames);

/* Records one frame and hands it to the modelled converter. */
static bool cli_main_write_playback(
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
static void cli_main_capture_frame(struct cli_runtime *runtime, bool keep);

/* Takes one frame from the CoreAudio capture ring, if one is waiting. */
static void cli_main_capture_live_frame(struct cli_runtime *runtime, bool keep);

/* Takes one frame from the recording, latching its end. */
static void cli_main_capture_recorded_frame(struct cli_runtime *runtime);

/* Runs capture through the selected DSP and then admits its clean output. */
static void cli_main_accept_capture_frame(
    struct cli_runtime *runtime, const int16_t *capture);

/* Configures the modelled converter; the CLI's speaker is unpaced. */
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
    struct cli_runtime *runtime,
    uint64_t now_ms,
    enum iterate_kit_device_event_source source);

/* Publishes one desired talk edge; queue failure is terminal and observable. */
static bool cli_main_request_talk(
    struct cli_runtime *runtime,
    bool active,
    enum iterate_kit_device_event_source source);

/* Publishes the maximum-turn edge before this loop drains device controls. */
static void cli_main_enforce_talk_deadline(
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
    struct cli_runtime *runtime, size_t outbox_free);

/* Supervises fatal transport state and the process-level liveness deadline. */
static void cli_main_supervise_transport(
    struct cli_runtime *runtime, uint64_t now_ms);


/* Drops a call whose provider bridge has gone silent. */

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

/* Advances the stats schedule without starving mandatory replies. */
static void cli_main_poll_periodic(
    struct cli_runtime *runtime, uint64_t now_ms, size_t outbox_free);

/* Recycles a completed downlink only after playback and talk are quiescent. */
static void cli_main_recycle_if_ready(
    struct cli_runtime *runtime, size_t outbox_free);

/* Gives a restart reply time to leave, then re-executes the same argv. */
static void cli_main_reexec_if_ready(
    struct cli_runtime *runtime, uint64_t now_ms);

/* Sleeps one bounded cooperative loop interval. */
static void cli_main_sleep(void);

/* Runs the intentionally nonterminating cooperative event pump until stopped. */
static void cli_main_run_loop(struct cli_runtime *runtime);

/*
 * The process's one clock: the host's monotonic reading, taken HERE and
 * nowhere else, so every stamp in the process demonstrably comes from the
 * same place. The `cli_runtime_now_ms(void *context)` seam survives because
 * it is called with a NULL context from nine places; the deterministic tests
 * do not go through it — they hand their subjects time directly, the way
 * tests/cli_paced_sink_test.c drives cli_paced_sink_advance.
 */
static uint64_t host_monotonic_us(void)
{
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return 0U;
  return (uint64_t)now.tv_sec * CLI_MAIN_US_PER_SECOND +
      (uint64_t)now.tv_nsec / CLI_MAIN_NS_PER_US;
}

uint64_t cli_runtime_now_ms(void *context)
{
  (void)context;
  return host_monotonic_us() / 1000U;
}

int64_t cli_runtime_transport_now_us(void *context)
{
  (void)context;
  return (int64_t)host_monotonic_us();
}

uint64_t cli_runtime_now_us(void)
{
  return host_monotonic_us();
}

void cli_runtime_log(const char *level, const char *format, ...)
{
  if (level == NULL || format == NULL) return;
  /*
   * A SCREEN OWNS THE TERMINAL EXCLUSIVELY. Left to write here, these lines
   * would land in the middle of a frame being redrawn and tear it — so once a
   * screen is up they become the log tail INSIDE it, which is where somebody
   * watching a live session was going to read them anyway. Every run without
   * a screen — scripted, recorded, piped — is untouched, and those are the
   * runs whose output another program parses.
   */
  struct cli_screen *screen = cli_screen_active();
  if (screen != NULL) {
    char line[CLI_SCREEN_LINE_BYTES];
    va_list screen_args;
    va_start(screen_args, format);
    (void)vsnprintf(line, sizeof(line), format, screen_args);
    va_end(screen_args);
    cli_screen_note(screen, level, line);
    return;
  }
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
  /*
   * A TERMINAL, A PERSON, AND A KEY TO HOLD — all three, or no screen.
   *
   * A frame that redraws in place is the right interface for somebody
   * watching and the wrong one for everything else: scripted conversations,
   * recorded runs and the fault harnesses are read by other programs, and
   * what those programs read is the line log the screen would swallow. Piped
   * output fails the isatty check for the same reason.
   */
  cli_screen_enable(
      &runtime->screen,
      (runtime->options.push_to_talk || runtime->options.open_mic) &&
          isatty(fileno(stderr)) != 0);
  cli_main_run_loop(runtime);
  cli_screen_finish(&runtime->screen);
  const bool audio_drained = cli_main_drain_audio(runtime);
  cli_main_close_runtime(runtime);
  const struct iterate_kit_darwin_audio_codec_metrics audio =
      cli_main_audio_metrics(runtime);
  const bool audio_healthy =
      audio.playback_platform_error == 0 &&
      audio.capture_platform_error == 0;
  /*
   * WHENEVER A REPORT WAS ASKED FOR, not only unattended. The summary block
   * (speaker sequence continuity, restarts, room audio accounting) is
   * measured in every mode; only the per-turn rows are converse-only, and an
   * attended run simply writes zero of them. Gated on converse_minutes, an
   * attended `talk` asked for a report on every run and was told ENOENT on
   * every quit.
   */
  if (runtime->options.report_json != NULL &&
      cli_conversation_write_report(runtime) != CLI_CONVERSATION_OK) {
    cli_runtime_log(
        "error", "failed to write report: %s", runtime->options.report_json);
    return CLI_MAIN_EXIT_RUNTIME;
  }
  return audio_drained && audio_healthy
      ? CLI_MAIN_EXIT_OK
      : CLI_MAIN_EXIT_RUNTIME;
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
          runtime->options.os_base_url);
  if (copied) return true;
  cli_runtime_log("error", "configuration value missing or exceeds firmware bound");
  return false;
}

static bool cli_main_init_peer(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  runtime->modules[0] = cli_capabilities_module(
      &runtime->capabilities, runtime);
  runtime->modules[1] = cli_device_controls_module(
      &runtime->device_controls);
  size_t description_length = 0U;
  const char *description = cli_capabilities_description(&description_length);
  const struct iterate_kit_peer_options options = {
    .description_expression = description,
    .description_expression_length = description_length,
    .modules = runtime->modules,
    .module_count = sizeof(runtime->modules) / sizeof(runtime->modules[0]),
  };
  if (iterate_kit_peer_init(&runtime->peer, &options) == CAPNWEB_OK) return true;
  cli_runtime_log("error", "capability peer initialization failed");
  return false;
}

static bool cli_main_init_device_controls(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  if (cli_device_controls_init(&runtime->device_controls, runtime) ==
      ITERATE_KIT_OK) return true;
  cli_runtime_log("error", "bounded device control initialization failed");
  return false;
}

static bool cli_main_init_connection(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  if ((size_t)snprintf(
          runtime->client_path,
          sizeof(runtime->client_path),
          "/clients/%s",
          runtime->options.name) >= sizeof(runtime->client_path)) {
    cli_runtime_log("error", "device name too long for a client path");
    return false;
  }
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
    .client_path = runtime->client_path,
    .capability = iterate_kit_peer_capability(&runtime->peer),
    .description = CLI_MAIN_CONNECTION_INSTRUCTIONS,
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
    /* The same clock everything else reads, so the transport's reconnect
     * and handshake deadlines can never disagree with the loop's stamps. */
    .now_us = cli_runtime_transport_now_us,
    .now_us_context = NULL,
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
  if (runtime->options.mic_record != NULL &&
      cli_wav_sink_open(&runtime->mic_sink, runtime->options.mic_record) !=
          CLI_WAV_OK) {
    cli_runtime_log(
        "error", "cannot open microphone WAV: %s", runtime->options.mic_record);
    return false;
  }
  if (!cli_main_init_converter(runtime)) return false;
  /*
   * The pretend speaker is the SAME converter, pulled by this loop instead of
   * by CoreAudio's thread. Everything downstream — the ring, the starvation
   * count, the drops — is the code a listener depends on, which is the only
   * reason a rehearsal is worth running.
   */
  if (runtime->options.pretend_speaker != NULL) {
    if (cli_wav_sink_open(
            &runtime->pretend_sink, runtime->options.pretend_speaker) !=
        CLI_WAV_OK) {
      cli_runtime_log(
          "error", "cannot open pretend speaker: %s",
          runtime->options.pretend_speaker);
      return false;
    }
    cli_runtime_log(
        "info", "pretend speaker: the live path, into %s",
        runtime->options.pretend_speaker);
  }
  const struct iterate_kit_darwin_audio_file_sink pretend_speaker = {
    .context = &runtime->pretend_sink,
    .write = cli_main_write_pretend_speaker,
  };
  const struct iterate_kit_darwin_audio_codec_options codec_options = {
    .capture_enabled = runtime->options.live_mic,
    .playback_enabled = runtime->options.live_audio ||
        runtime->options.pretend_speaker != NULL,
    .file_playback = runtime->options.pretend_speaker == NULL
        ? NULL
        : &pretend_speaker,
  };
  if (iterate_kit_darwin_audio_codec_open(
          &runtime->audio_codec, &codec_options) != ITERATE_KIT_OK) {
    cli_runtime_log("error", "CoreAudio codec initialization failed");
    return false;
  }
  runtime->audio_processor = iterate_kit_audio_processor_passthrough();
  if (iterate_kit_audio_processor_validate(&runtime->audio_processor) !=
      ITERATE_KIT_OK) {
    cli_runtime_log("error", "audio processor initialization failed");
    return false;
  }
  return true;
}

static bool cli_main_write_pretend_speaker(
    void *context, const uint8_t *pcm, size_t length)
{
  return cli_wav_sink_write(context, pcm, length) == CLI_WAV_OK;
}

static struct iterate_kit_darwin_audio_codec_metrics cli_main_audio_metrics(
    const struct cli_runtime *runtime)
{
  struct iterate_kit_darwin_audio_codec_metrics metrics;
  assert(runtime != NULL);
  iterate_kit_darwin_audio_codec_metrics(&runtime->audio_codec, &metrics);
  return metrics;
}

static bool cli_main_init_converter(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  /*
   * Unpaced: the CLI's speaker accepts every frame instantly, as it always
   * has. The paced converter model survives in cli_paced_sink because the
   * deterministic playback-loop tests drive it directly.
   */
  const struct cli_paced_sink_config config = {0};
  return cli_paced_sink_configure(&runtime->paced_sink, &config) ==
      CLI_PACED_SINK_OK;
}

static bool cli_main_init_keyboard(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  if (runtime->options.minutes > 0.0) {
    runtime->finish_at_ms = runtime->started_ms +
        (uint64_t)(runtime->options.minutes * CLI_MAIN_MS_PER_MINUTE);
  }
  if (!runtime->options.push_to_talk && !runtime->options.open_mic) return true;
  const enum cli_keyboard_status status =
      cli_keyboard_open(&runtime->keyboard);
  if (status == CLI_KEYBOARD_OK) {
    if (runtime->options.open_mic) {
      /*
       * A BOARD'S POSTURE: launching the run is the wake press, so talk is
       * requested once, here, and stays wanted for the session — the
       * server's VAD segments the turns from the continuous stream (it
       * needs the silence BETWEEN utterances, which is exactly what a
       * space-gated capture never sends). When the session ends — hang-up,
       * idle — the microphone gates and SPACE is the next wake press.
       */
      cli_runtime_log("info", "open mic: just talk; SPACE re-wakes, q quits");
      (void)cli_main_request_talk(
          runtime, true, ITERATE_KIT_DEVICE_EVENT_SOURCE_SYSTEM);
    } else {
      cli_runtime_log(
          "info", "hold SPACE to talk, release to send, q to hang up");
    }
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
  /* Without one, turns speak bounded voiced test synthesis; a scripted
   * conversation supplies its own WAVs through --utterance-dir. */
  if (cli_wav_source_open(&runtime->source, NULL) == CLI_WAV_OK) {
    cli_runtime_log(
        "warn", "no live microphone; using bounded voiced test synthesis");
    return true;
  }
  cli_runtime_log("error", "cannot open the synthetic microphone source");
  return false;
}

static bool cli_main_init_runtime(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  if (!cli_main_init_configuration(runtime)) return false;
  if (!cli_main_init_control_rings(runtime)) return false;
  if (!cli_main_init_device_controls(runtime)) return false;
  if (!cli_main_init_peer(runtime)) return false;
  if (!cli_main_init_connection(runtime)) return false;
  if (!cli_main_init_transport(runtime)) return false;
  if (!cli_main_init_audio(runtime)) return false;
  runtime->started_ms = cli_runtime_now_ms(NULL);
  if (!cli_main_init_input(runtime)) return false;
  if (!cli_main_init_keyboard(runtime)) return false;
  cli_speaker_clear(&runtime->speaker);
  cli_microphone_clear(&runtime->microphone);
  iterate_kit_voice_playback_clock_init(&runtime->playback_clock);
  cli_runtime_log(
      "info", "iterate-kit-cli ready client=%s stream=%s staticBytes=%zu outbox=%u",
      runtime->client_path, runtime->options.stream_path, sizeof(*runtime),
      ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS);
  return true;
}

static void cli_main_close_runtime(struct cli_runtime *runtime)
{
  if (runtime == NULL) return;
  /* The terminal goes back first; everything after it can take its time. */
  cli_keyboard_close(&runtime->keyboard);
  (void)iterate_kit_posix_itx_transport_stop(&runtime->transport);
  (void)iterate_kit_peer_close(&runtime->peer);
  iterate_kit_darwin_audio_codec_close(&runtime->audio_codec);
  cli_wav_source_close(&runtime->source);
  cli_wav_sink_close(&runtime->sink);
  cli_wav_sink_close(&runtime->mic_sink);
  cli_wav_sink_close(&runtime->pretend_sink);
}

static bool cli_main_drain_audio(struct cli_runtime *runtime)
{
  enum iterate_kit_darwin_audio_output_status status;
  assert(runtime != NULL);
  iterate_kit_darwin_audio_codec_set_playback_expected(
      &runtime->audio_codec, false);
  status = iterate_kit_darwin_audio_codec_drain(
      &runtime->audio_codec, (uint32_t)CLI_MAIN_HANGUP_GRACE_MS);
  const struct iterate_kit_darwin_audio_codec_metrics audio =
      cli_main_audio_metrics(runtime);
  cli_runtime_log(
      status == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK ? "info" : "error",
      "room completion status=%s completedBytes=%u droppedBytes=%u "
      "starvedBuffers=%u outputError=%" PRId32 " inputError=%" PRId32,
      iterate_kit_darwin_audio_output_status_name(status),
      audio.playback_completed_bytes,
      audio.playback_dropped_bytes,
      audio.playback_starved_buffers,
      audio.playback_platform_error,
      audio.capture_platform_error);
  return status == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK &&
      audio.playback_platform_error == 0 &&
      audio.capture_platform_error == 0;
}

static void cli_main_supervise_audio(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  const struct iterate_kit_darwin_audio_codec_metrics audio =
      cli_main_audio_metrics(runtime);
  const int32_t output_error = audio.playback_platform_error;
  const int32_t input_error = audio.capture_platform_error;
  if (output_error == 0 && input_error == 0) return;
  cli_runtime_log(
      "error", "audio platform failure output=%" PRId32 " input=%" PRId32,
      output_error, input_error);
  runtime->stop_requested = true;
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
    .conversation_id = runtime->options.name,
    .now_ms = cli_runtime_now_ms,
    .on_speaker = cli_main_on_speaker,
    .on_control = cli_main_on_control,
    .on_event_seen = cli_main_on_event_seen,
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

/**
 * One arriving frame, from the wire to the speaker: the overflow accounting,
 * the underrun observation, the turn's own census.
 *
 * There is no per-frame decision left to make. The sender paces the answer
 * and announces a replacing one with `drop`, which arrives as SPEECH_STARTED
 * ahead of the audio it invalidates, so a frame reaching here is a frame to
 * play.
 */
static void cli_main_accept_speaker_frame(
    struct cli_runtime *runtime,
    const uint8_t *pcm,
    size_t length)
{
  assert(runtime != NULL && pcm != NULL);
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

static void cli_main_on_speaker(
    void *context, const uint8_t *pcm, size_t length)
{
  struct cli_runtime *runtime = context;
  /*
   * ANY LENGTH, so long as it is whole samples. The speaker below is a byte
   * ring and splices chunks end to end, so the sender is free to hand over
   * audio of whatever length it has; an ODD length is still refused, because
   * that would shift the 16-bit sample grid permanently rather than merely
   * cutting the waveform somewhere unexpected.
   */
  if (runtime == NULL || pcm == NULL || length == 0U || (length & 1U) != 0U) {
    if (runtime != NULL) ++runtime->speaker_bad_frames;
    return;
  }
  /*
   * THE FIRST AUDIO OF AN ANSWER IS WHERE THE WAIT ENDS, so the whole turn is
   * differenced here — once, on the frame that ends it, rather than sampled
   * by whatever happens to look. `turn_released_ms` is cleared by the same
   * line, which is what makes this the FIRST frame and not every frame.
   */
  if (runtime->turn_released_ms != 0U) {
    const uint64_t now_ms = cli_runtime_now_ms(NULL);
    runtime->turn_answer_seen_ms = now_ms;
    const uint64_t commit_ms = runtime->turn_committed_ms == 0U
        ? now_ms
        : runtime->turn_committed_ms;
    cli_runtime_log(
        "info",
        "turn release->commit=%" PRIu64 "ms commit->audio=%" PRIu64
        "ms total=%" PRIu64 "ms",
        commit_ms - runtime->turn_released_ms,
        now_ms - commit_ms,
        now_ms - runtime->turn_released_ms);
    runtime->turn_release_to_commit_ms =
        (uint32_t)(commit_ms - runtime->turn_released_ms);
    runtime->turn_commit_to_audio_ms = (uint32_t)(now_ms - commit_ms);
    runtime->turn_released_ms = 0U;
  }
  cli_main_accept_speaker_frame(runtime, pcm, length);
}

/*
 * WHAT ACTUALLY CAME DOWN THE WIRE.
 *
 * The state lines above say what the client is doing; this says what the
 * server sent, which is the question you have when the answer is "nothing
 * happened". Types are logged with only their last segment — the
 * `events.iterate.com/voice-agent/` prefix is on every one of them and
 * repeating it forty times a second buries the part that differs.
 */
static void cli_main_on_event_seen(
    void *context, const char *type, size_t length)
{
  struct cli_runtime *runtime = context;
  const char *leaf = type;
  size_t index;
  assert(runtime != NULL);
  for (index = 0U; index < length; ++index) {
    if (type[index] == '/') {
      leaf = type + index + 1U;
    }
  }
  /* Speaker frames arrive fifty times a second; counting them is useful and
   * printing each one is not. The pulse line already reports rx/gaps. */
  if (strncmp(leaf, "spk-frame", sizeof("spk-frame") - 1U) == 0) {
    return;
  }
  cli_runtime_log("info", "event %.*s", (int)(length - (size_t)(leaf - type)), leaf);
}

static void cli_main_on_control(
    void *context, enum iterate_kit_voicelab_control control)
{
  struct cli_runtime *runtime = context;
  if (runtime == NULL) return;
  if (control == ITERATE_KIT_VOICELAB_CONTROL_SPEECH_STARTED) {
    /*
     * A NEW ANSWER BEGINS, AND WHATEVER IS QUEUED BELONGS TO THE LAST ONE.
     *
     * `drop` rides the first chunk of the replacing answer and is raised
     * before that chunk's audio is handed over, so the clear here provably
     * precedes the audio that replaces it. This is where the old per-frame
     * REPLACE branch's work now lives, timeline included.
     */
    iterate_kit_darwin_audio_codec_set_playback_expected(&runtime->audio_codec, false);
    cli_speaker_clear(&runtime->speaker);
    iterate_kit_voice_playback_clock_reprime(&runtime->playback_clock);
    /* A new answer is a new timeline: lag does not carry across answers. */
    runtime->answer_started_ms = 0U;
    runtime->answer_emitted_ms = 0U;
    ++runtime->barge_in_flushes;
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_RESPONSE_DONE) {
    /*
     * The answer is closed, but the tail of it is still queued: this edge
     * rides the answer's last chunk and is raised after that chunk's audio is
     * handed over. Only the clock is told; nothing is thrown away.
     */
    runtime->answer_done = true;
    iterate_kit_voice_playback_clock_answer_done(&runtime->playback_clock);
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_CALL_ACCEPTED) {
    cli_runtime_log("info", "call accepted");
  } else if (control == ITERATE_KIT_VOICELAB_CONTROL_CALL_ENDED) {
    cli_runtime_log("warn", "call ended by the bridge");
    runtime->answer_done = true;
    ++runtime->calls_lost;
    runtime->talking = false;
    runtime->flushing_turn = false;
    (void)cli_main_request_talk(
        runtime, false, ITERATE_KIT_DEVICE_EVENT_SOURCE_SYSTEM);
    if (runtime->options.open_mic && !runtime->hanging_up) {
      /*
       * AND THE SESSION ENDS WITH IT — the board grammar. This used to
       * re-request talk on the theory that an open microphone outlives any
       * one call, so the model's hang_up was answered by the very next
       * microphone frame opening a successor in the same second, and an
       * idle-timeout end resurrected whenever anyone in the room was
       * talking. The microphone now stays gated until the next wake press.
       */
      cli_runtime_log("info", "call over — SPACE wakes the next one, q quits");
    }
    cli_runtime_log("warn", "call ended");
  }
}

static bool cli_main_record_frame(
    struct cli_runtime *runtime, const uint8_t *pcm)
{
  assert(runtime != NULL && pcm != NULL);
  if (cli_wav_sink_write(
          &runtime->sink, pcm, ITERATE_KIT_VOICE_FRAME_BYTES) != CLI_WAV_OK) {
    ++runtime->speaker_write_failures;
    runtime->stop_requested = true;
    return false;
  }
  if (!runtime->options.live_audio &&
      runtime->options.pretend_speaker == NULL) {
    return true;
  }
  /*
   * NOT discarded. This refusal used to be cast away, so a speaker that was
   * dropping most of a conversation reported nothing at all and the room went
   * quiet while every counter stayed clean.
   */
  int16_t playback[ITERATE_KIT_VOICE_FRAME_SAMPLES];
  memcpy(playback, pcm, sizeof(playback));
  const enum iterate_kit_status room = iterate_kit_audio_codec_write(
      &runtime->audio_codec.codec,
      playback,
      ITERATE_KIT_VOICE_FRAME_SAMPLES);
  if (room == ITERATE_KIT_BACKPRESSURE) {
    ++runtime->speaker_room_drops;
    return false;
  } else if (room != ITERATE_KIT_OK) {
    cli_runtime_log(
        "error", "speaker output failed status=%d", (int)room);
    runtime->stop_requested = true;
    return false;
  }
  if (runtime->conversation.current_turn != NULL) {
    runtime->turn_room_submitted_bytes += ITERATE_KIT_VOICE_FRAME_BYTES;
  }
  return true;
}

/**
 * Record one captured frame to the microphone WAV.
 *
 * The uplink deserves a witness as much as the downlink does. Without one,
 * "it did not hear me" and "it heard me and answered badly" are the same
 * observation, and the only way to tell them apart is to ask the provider
 * what it thought it received.
 */
static void cli_main_record_mic_frame(
    struct cli_runtime *runtime, const uint8_t *pcm)
{
  assert(runtime != NULL && pcm != NULL);
  if (runtime->options.mic_record == NULL) return;
  if (cli_wav_sink_write(
          &runtime->mic_sink, pcm, ITERATE_KIT_VOICE_FRAME_BYTES) == CLI_WAV_OK) {
    return;
  }
  ++runtime->mic_write_failures;
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
    (void)cli_main_record_frame(runtime, silence);
  }
}

static bool cli_main_write_playback(
    struct cli_runtime *runtime, const uint8_t *pcm)
{
  assert(runtime != NULL && pcm != NULL);
  if (!cli_main_record_frame(runtime, pcm)) return false;
  (void)cli_paced_sink_offer(&runtime->paced_sink);
  return true;
}

static void cli_main_finish_answer_if_ready(
    struct cli_runtime *runtime, uint64_t now_ms)
{
  assert(runtime != NULL);
  const bool software_drained =
      runtime->answer_done && runtime->speaker.used == 0U;
  if (software_drained) {
    iterate_kit_darwin_audio_codec_set_playback_expected(
        &runtime->audio_codec, false);
  }
  struct cli_report_turn *turn = runtime->conversation.current_turn;
  if (turn == NULL) {
    if (software_drained) runtime->answer_done = false;
    return;
  }
  const bool room_drained =
      (!runtime->options.live_audio &&
       runtime->options.pretend_speaker == NULL) ||
      cli_main_audio_metrics(runtime).playback_completed_bytes -
              runtime->turn_room_completed_start_bytes >=
          runtime->turn_room_submitted_bytes;
  const bool played_out =
      software_drained && room_drained && turn->frames_played > 0U;
  /*
   * STALLED, NOT MERELY LONG.
   *
   * This deadline exists to end a turn nothing is going to finish — a lost
   * commit, a provider that stopped talking mid-answer. Measured from the
   * commit, it also ended turns that were playing perfectly well: asked to
   * count to one hundred the model speaks for well over thirty seconds, and
   * the driver abandoned the turn mid-count with hundreds of frames still
   * queued, which reads in a report as audio the speaker lost.
   *
   * So the clock runs from the last sign of life — a frame played — and a
   * turn still producing audio is never overdue however long it takes. A turn
   * that has genuinely stopped still ends on exactly the old deadline, since
   * before any audio arrives the last sign of life IS the commit.
   */
  const uint64_t since =
      runtime->turn_progress_ms != 0U ? runtime->turn_progress_ms : turn->committed_ms;
  const bool overdue = since != 0U &&
      iterate_kit_voice_elapsed_ms(now_ms, since) > ITERATE_KIT_VOICE_TURN_MAX_MS;
  if (!played_out && !overdue) return;
  runtime->answer_done = false;
  runtime->turn_progress_ms = 0U;
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
  if (!cli_main_write_playback(runtime, silence)) return;
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
          iterate_kit_voice_playout_lag_ms(
              runtime->answer_started_ms, runtime->answer_emitted_ms,
              now_ms),
          now_ms);
  if (action == ITERATE_KIT_VOICE_PLAYBACK_DROP_CATCHUP) {
    /* The skipped frame still spent its place in the timeline; see the
     * device's copy of this branch for why leaving it makes skipping run
     * away and delete half an answer. */
    ++runtime->speaker_catchup_frames;
    runtime->answer_emitted_ms += ITERATE_KIT_VOICE_FRAME_MS;
    return;
  }
  if (action != ITERATE_KIT_VOICE_PLAYBACK_PLAY) return;
  if (!cli_main_write_playback(runtime, frame)) return;
  ++runtime->speaker_frames_played;
  ++runtime->speaker_writes;
  {
    if (runtime->answer_started_ms == 0U) {
      runtime->answer_started_ms = now_ms;
      runtime->answer_emitted_ms = 0U;
    }
    {
      const uint32_t lag = iterate_kit_voice_playout_lag_ms(
          runtime->answer_started_ms, runtime->answer_emitted_ms, now_ms);
      if (lag > runtime->speaker_lag_max_ms) {
        runtime->speaker_lag_max_ms = lag;
      }
    }
    runtime->answer_emitted_ms += ITERATE_KIT_VOICE_FRAME_MS;
  }
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
  runtime->turn_progress_ms = now_ms;
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
  if (runtime->options.live_audio ||
      runtime->options.pretend_speaker != NULL) {
    /*
     * There is already a clock here: CoreAudio, or the FILE-mode puller used
     * as its deterministic stand-in. Let that boundary request payload by
     * draining its real descriptor lead. A second 20 ms deadline in this
     * loop ran at a slightly different rate and eventually made one healthy
     * clock report the other as starvation.
     *
     * Polling is intentionally faster than the 20 ms pull period. It merely
     * replenishes bounded lead; it cannot run playback ahead because
     * Darwin's queued-byte metric measures only the refill reserve; payload
     * already owned by the hardware cannot satisfy the callback that asks to
     * reuse a completed buffer.
     */
    cli_main_finish_answer_if_ready(runtime, now_ms);
    cli_main_feed_playback(runtime, now_ms);
    return;
  }
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
  const bool room_pulls = runtime->options.live_audio ||
      runtime->options.pretend_speaker != NULL;
  const uint32_t room_queued_bytes =
      cli_main_audio_metrics(runtime).playback_queued_bytes;
  if (room_pulls &&
      room_queued_bytes >= ITERATE_KIT_DARWIN_AUDIO_OUTPUT_LEAD_BYTES) {
    return;
  }
  /*
   * The first frame is unconditional, which is what this loop did before a
   * converter was modelled. The continuation is a converter still asking:
   * either the deterministic paced sink has a free slot, or the real
   * hardware-facing output has less than its descriptor lead buffered. An
   * unpaced output asks neither, so the default path remains exactly one
   * frame per due tick.
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
      /*
       * The hardware puller is the exact authority for missing room audio.
       * Feeding software-generated concealment on this loop's 5 ms poll
       * would fill a 20 ms hardware queue four times too fast and hide the
       * callback's own starvation evidence. The unpaced/file-only model has
       * no such authority, so it retains the core concealment decision.
       */
      if (room_pulls) return;
      cli_main_conceal_if_needed(runtime, now_ms);
      return;
    }
    cli_main_play_frame(runtime, frame, now_ms);
    ++fed;
  } while (fed < CLI_PACED_SINK_MAX_DEPTH_FRAMES &&
           (cli_paced_sink_ready(&runtime->paced_sink) ||
            (room_pulls &&
             cli_main_audio_metrics(runtime).playback_queued_bytes <
                 ITERATE_KIT_DARWIN_AUDIO_OUTPUT_LEAD_BYTES)));
}

static void cli_main_capture_frame(struct cli_runtime *runtime, bool keep)
{
  assert(runtime != NULL);
  if (runtime->options.live_mic) {
    cli_main_capture_live_frame(runtime, keep);
    return;
  }
  /* A RECORDING IS NOT A ROOM. Nothing accumulates in a file while nobody
   * reads it, so between turns the honest thing is not to read: consuming the
   * WAV to throw it away would silently eat the next utterance. */
  if (!keep) return;
  cli_main_capture_recorded_frame(runtime);
}

static void cli_main_capture_live_frame(struct cli_runtime *runtime, bool keep)
{
  assert(runtime != NULL);
  /*
   * DRAIN TO EMPTY, EVERY PASS. Reading exactly one frame per tick could not
   * work and the arithmetic says so: CoreAudio produces one frame per 20 ms
   * and this loop consumed one per 20 ms, so the two only stay level while
   * the loop never misses its slot. It has no way to catch up from a single
   * late pass, and every frame it falls behind is permanent — the ring laps
   * after 32 of them and counts the rest as lost. Measured after the previous
   * fix: 333 frames lost in 37 seconds, from a drain that was supposedly
   * always running.
   *
   * A bounded loop only because the ring is bounded; there is nothing else to
   * read once it is empty.
   */
  for (size_t frames = 0U; frames <= ITERATE_KIT_DARWIN_AUDIO_INPUT_RING_FRAMES;
       ++frames) {
    int16_t capture[ITERATE_KIT_VOICE_FRAME_SAMPLES] = {0};
    size_t sample_count = 0U;
    if (iterate_kit_audio_codec_read(
            &runtime->audio_codec.codec,
            capture,
            NULL,
            ITERATE_KIT_VOICE_FRAME_SAMPLES,
            &sample_count) != ITERATE_KIT_OK) {
      return;
    }
    assert(sample_count == ITERATE_KIT_VOICE_FRAME_SAMPLES);
    /*
     * READ ALWAYS, KEEP SOMETIMES — and the flush is the case that proves the
     * two must be separate. Nothing is KEPT once the turn is flushing: the
     * frames already queued are what the person said, and adding more would
     * hold the commit open until its timeout. But this used to return BEFORE
     * the read, so a flush stopped draining the ring as well as stopping
     * capture, and the backlog it left was charged to the next turn.
     */
    if (!keep || runtime->flushing_turn) continue;
    cli_main_accept_capture_frame(runtime, capture);
  }
}

static void cli_main_capture_recorded_frame(struct cli_runtime *runtime)
{
  assert(runtime != NULL);
  int16_t capture[ITERATE_KIT_VOICE_FRAME_SAMPLES] = {0};
  if (runtime->source_finished) return;
  if (cli_wav_source_frame(
          &runtime->source, (uint8_t *)capture, sizeof(capture)) !=
      CLI_WAV_OK) {
    runtime->source_finished = true;
    return;
  }
  cli_main_accept_capture_frame(runtime, capture);
}

static void cli_main_accept_capture_frame(
    struct cli_runtime *runtime, const int16_t *capture)
{
  assert(runtime != NULL && capture != NULL);
  int16_t clean[ITERATE_KIT_VOICE_FRAME_SAMPLES] = {0};
  const struct iterate_kit_audio_processor_frame frame = {
    .near = capture,
    .reference = NULL,
    .playout_activity = NULL,
    .output = clean,
    .sample_count = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  };
  if (iterate_kit_audio_processor_process(
          &runtime->audio_processor, &frame) != ITERATE_KIT_OK) {
    cli_runtime_log("error", "audio processor failed");
    runtime->stop_requested = true;
    return;
  }
  ++runtime->mic_frames_captured;
  cli_main_record_mic_frame(runtime, (const uint8_t *)clean);
  (void)cli_microphone_push(
      &runtime->microphone, (const uint8_t *)clean, sizeof(clean));
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
  /*
   * ALWAYS DRAIN THE CAPTURE RING; KEEP ONLY WHAT A TURN ASKED FOR.
   *
   * The old shape returned here without reading, and CoreAudio does not stop
   * capturing because nobody is listening — so between turns the ring filled,
   * lapped, and counted every frame it displaced. Measured in one 34-second
   * session: 1,735 frames captured, 1,162 of them lost, and the loss counter
   * is the first thing anybody reads when audio sounds wrong. It was reporting
   * a healthy microphone as a broken one.
   *
   * It was not only cosmetic. A ring left full means the first frames read
   * after a press are whatever the room said before it, and the discarded-
   * oldest policy then jumps the cursor mid-turn. Draining continuously keeps
   * the cursor at the live edge, so a press begins with the present.
   */
  cli_main_capture_frame(runtime, runtime->talking);
  if (!runtime->talking) {
    ++runtime->mic_frames_gated;
    return;
  }
  cli_main_send_microphone(runtime, now_ms);
}

static void cli_main_start_talk(
    struct cli_runtime *runtime, uint64_t now_ms, size_t outbox_free)
{
  assert(runtime != NULL);
  /*
   * THE BUTTON IS THE WHOLE CONDITION.
   *
   * A push-to-talk client differs from an open-mic one in exactly one way: it
   * sends microphone frames while a key is down instead of always. It has no
   * opinion about calls, sessions or provider connections, and every opinion
   * it used to hold cost a turn. This test read
   * `runtime->wants_call && runtime->wants_talk && ... && call_active`, so
   * speech was discarded unless a call already existed — while the far end's
   * rule is that a call is OPENED by somebody talking, holds what arrives
   * before the provider handshake finishes, and replays it the moment it is
   * usable. The client was refusing to produce the frames the server was
   * waiting to hold.
   */
  if (!runtime->wants_talk || runtime->talking ||
      outbox_free < CLI_MAIN_CALL_OUTBOX_SLOTS) return;
  /* The synthetic source has to be rewound for each turn; a room does not. */
  if (runtime->conversation.state == CLI_CONVERSATION_DISABLED &&
      !runtime->options.live_mic) {
    if (cli_wav_source_open(&runtime->source, NULL) != CLI_WAV_OK) {
      cli_runtime_log("error", "cannot rewind the microphone source");
      (void)cli_main_request_talk(
          runtime, false, ITERATE_KIT_DEVICE_EVENT_SOURCE_SYSTEM);
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
  iterate_kit_voice_playback_clock_reprime(&runtime->playback_clock);
  /*
   * A LOST ptt-start IS A LOST BARGE-IN: the server's answer-drop triggers on
   * this exact event, so a press that captures audio but fails to say
   * "start" leaves a dead answer playing through the whole interruption —
   * with nothing anywhere saying why. Never voided.
   */
  const enum capnweb_status turn_start_status = iterate_kit_voicelab_mark_turn(
      &runtime->voicelab, ITERATE_KIT_VOICELAB_TURN_START);
  if (turn_start_status != CAPNWEB_OK) {
    cli_runtime_log(
        "error", "ptt-start append failed: capnweb status %d",
        (int)turn_start_status);
  }
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
  /* A lost commit strands the provider holding an uncommitted turn — as
   * invisible as a lost start, and logged for the same reason. */
  const enum capnweb_status turn_commit_status = iterate_kit_voicelab_mark_turn(
      &runtime->voicelab, ITERATE_KIT_VOICELAB_TURN_COMMIT);
  if (turn_commit_status != CAPNWEB_OK) {
    cli_runtime_log(
        "error", "ptt-end append failed: capnweb status %d",
        (int)turn_commit_status);
  }
  runtime->turn_committed_ms = now_ms;
}

static void cli_main_reconcile_talk(
    struct cli_runtime *runtime, uint64_t now_ms, size_t outbox_free)
{
  assert(runtime != NULL);
  /*
   * A LINK THAT IS STILL COMING UP IS NOT A LINK THAT WENT AWAY.
   *
   * This asked for READY and a live call, and cancelled the turn whenever
   * either was missing — so a turn begun during a cold connect was cancelled
   * on the very next pass, before a single frame was captured. A turn should
   * survive the wait; the hold queue is what it waits in.
   *
   * A transport that has actually FAILED is different: nothing is coming and
   * the supervisor is about to restart it, so holding speech for it would be
   * holding it for nobody. Runaway turns are already bounded elsewhere by
   * ITERATE_KIT_VOICE_TURN_MAX_MS.
   */
  const bool link_lost =
      runtime->transport.state == ITERATE_KIT_POSIX_ITX_FAILED ||
      runtime->transport.state == ITERATE_KIT_POSIX_ITX_STOPPED;
  if (runtime->talking && !runtime->flushing_turn && link_lost) {
    runtime->talking = false;
    runtime->flushing_turn = false;
  }
  cli_main_start_talk(runtime, now_ms, outbox_free);
  if (!runtime->wants_talk && runtime->talking && !runtime->flushing_turn) {
    runtime->flushing_turn = true;
    runtime->turn_released_ms = now_ms;
    runtime->turn_committed_ms = 0U;
    runtime->turn_answer_seen_ms = 0U;
    runtime->flush_frames_left = (uint32_t)runtime->microphone.used;
    runtime->flush_deadline_ms =
        now_ms + ITERATE_KIT_VOICE_TURN_FLUSH_TIMEOUT_MS;
  }
  cli_main_finish_talk(runtime, now_ms);
}

static void cli_main_reconcile_call(
    struct cli_runtime *runtime, size_t outbox_free)
{
  assert(runtime != NULL);
  /*
   * NOBODY ASKS FOR A CALL ANY MORE. A block here used to dial one whenever
   * `wants_call` was set and none existed, retrying on a timer — a second
   * source of truth for a fact the server owns, and one that opened a
   * provider connection for somebody who had not yet said anything. The
   * server opens a call on the first microphone frame; the only call
   * lifecycle left on this side is ENDING one, below, because hanging up is
   * something a person does and the server cannot guess.
   */
  if (runtime->hanging_up && runtime->voicelab.call_active &&
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

/*
 * BOTH SUPERVISORS THAT LIVED HERE ARE GONE, WITH THE PROBE THEY RAN ON.
 *
 * `cli_main_supervise_liveness` restarted the process when no application-level
 * round trip had completed for three minutes, and `cli_main_supervise_bridge`
 * dropped a call whose bridge had not been heard from for twenty seconds. Both
 * keyed on the pulled `voice-agent/ping` append and the `voice-agent/pong` it
 * earned back, and that pair is deleted: a WebSocket already carries its own
 * PING/PONG and the platform exposes a connection-layer probe, so this was a
 * third liveness mechanism above the two that measure it honestly.
 *
 * Neither could be re-keyed. Every remaining signal is inbound-only and stops
 * on a healthy idle device, and the pong was the only bridge-sourced event that
 * arrived during a SILENT call — so re-keying the first would restart idle
 * processes on a timer, and the second would drop a live call on any pause in
 * the conversation. What still acts is `cli_main_supervise_downlink`, which
 * fires on silence only when traffic is expected.
 */

static void cli_main_supervise_downlink(
    struct cli_runtime *runtime, uint64_t now_ms, size_t outbox_free)
{
  assert(runtime != NULL);
  const bool silent = runtime->voicelab.state == ITERATE_KIT_VOICELAB_READY &&
      runtime->voicelab.call_active &&
      runtime->voicelab.has_connection_capability &&
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
  cli_main_supervise_downlink(runtime, now_ms, outbox_free);
}

/**
 * Latch the two edges the screen reports as connectivity.
 *
 * WHY BOTH ARE HERE AND NOT AT THEIR CAUSES. Reaching /api and having a
 * provider call accepted happen in two unrelated parts of the stack, and both
 * are only observable as a state that is now different from the state last
 * seen. Written at their causes they would be two latches nobody could find;
 * written together they are the definition of what the lights mean.
 */
static void cli_main_track_connectivity(
    struct cli_runtime *runtime, uint64_t now_ms)
{
  assert(runtime != NULL);
  const bool api_up = runtime->transport.state == ITERATE_KIT_POSIX_ITX_READY &&
      runtime->voicelab.state == ITERATE_KIT_VOICELAB_READY;
  if (api_up) {
    if (runtime->api_connected_at_ms == 0U) {
      runtime->api_connected_at_ms = now_ms;
    }
  } else {
    runtime->api_connected_at_ms = 0U;
  }
  if (runtime->voicelab.call_active) {
    if (runtime->call_established_at_ms == 0U) {
      runtime->call_established_at_ms = now_ms;
    }
  } else {
    runtime->call_established_at_ms = 0U;
  }
}

static void cli_main_draw_screen(struct cli_runtime *runtime, uint64_t now_ms)
{
  assert(runtime != NULL);
  if (!runtime->screen.enabled) return;
  struct iterate_kit_spsc_ring_metrics outbox = {0};
  iterate_kit_spsc_ring_metrics(&runtime->control_outbox, &outbox);
  const struct iterate_kit_darwin_audio_codec_metrics audio =
      cli_main_audio_metrics(runtime);
  const struct cli_screen_state state = {
    .stream_path = runtime->options.stream_path,
    .elapsed_ms = iterate_kit_voice_elapsed_ms(now_ms, runtime->started_ms),
    .api_connected_at_ms = runtime->api_connected_at_ms == 0U
        ? 0U
        : iterate_kit_voice_elapsed_ms(
              runtime->api_connected_at_ms, runtime->started_ms),
    .call_established_at_ms = runtime->call_established_at_ms == 0U
        ? 0U
        : iterate_kit_voice_elapsed_ms(
              runtime->call_established_at_ms, runtime->started_ms),
    .call_pending = runtime->voicelab.call_pending,
    .transport_state =
        iterate_kit_posix_itx_transport_state_name(runtime->transport.state),
    .space_held = runtime->wants_talk,
    .talking = runtime->talking,
    .flushing = runtime->flushing_turn,
    .mic_captured = audio.capture_frames,
    .mic_held = (uint32_t)cli_microphone_queued(&runtime->microphone),
    .mic_sent = runtime->voicelab.frames_sent,
    .mic_lost = audio.capture_frames_dropped,
    .spk_received = runtime->voicelab.spk_frames_received,
    .spk_played = runtime->speaker_frames_played,
    .spk_ring_ms = cli_speaker_queued_ms(&runtime->speaker),
    .spk_conceal = runtime->speaker_conceal_frames,
    .spk_underruns = runtime->speaker_underruns,
    .spk_dropped = runtime->speaker_room_drops + runtime->speaker_overflow_drops,
    .spk_starved = audio.playback_starved_buffers,
    .spk_catchup = runtime->speaker_catchup_frames,
    .turn_release_to_commit_ms = runtime->turn_release_to_commit_ms,
    .turn_commit_to_audio_ms = runtime->turn_commit_to_audio_ms,
    .outbox_used = (uint32_t)outbox.current_slots,
    .outbox_slots = (uint32_t)ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS,
    .loops = runtime->loop_count,
  };
  cli_screen_draw(&runtime->screen, &state);
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
      "openTimeouts=%u errors=%u disconnects=%u mountTimeouts=%u "
      "protoFail=%u recvFail=%u fatal=%u/%u",
      runtime->transport.websocket_url,
      (int)runtime->transport.last_platform_error,
      (int)runtime->transport.last_capnweb_status,
      runtime->transport.websocket_start_attempts,
      runtime->transport.websocket_connections,
      runtime->transport.websocket_open_timeouts,
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
  /*
   * Keep both recordings openable. An interactive session ends with Ctrl-C,
   * which never reaches the close path, and a header patched only at close
   * left every such recording unplayable.
   *
   * NEVER WHILE THERE IS AUDIO TO PLAY, and never faster than the recovery is
   * worth. Each of these is an fsync on the cooperative loop's own thread, and
   * the output boundary this loop feeds keeps an 80 ms refill reserve — so a
   * sync that blocks longer than that is silence the listener hears. Measured:
   * 42 starved buffers over 78 seconds against 78 pulses, roughly one every
   * other sync, with a ring holding 965 ms and nothing else dropping a frame.
   *
   * What the syncs buy is a playable recording after a Ctrl-C, which nobody
   * needs to be one second fresh. Deferring them to the gaps costs at most the
   * tail of an answer in a killed session and costs a live listener nothing.
   */
  if (cli_speaker_queued_ms(&runtime->speaker) == 0U &&
      iterate_kit_voice_elapsed_ms(now_ms, runtime->last_sink_sync_ms) >=
          CLI_MAIN_SINK_SYNC_INTERVAL_MS) {
    runtime->last_sink_sync_ms = now_ms;
    (void)cli_wav_sink_sync(&runtime->sink);
    if (runtime->options.mic_record != NULL) {
      (void)cli_wav_sink_sync(&runtime->mic_sink);
    }
    if (runtime->options.pretend_speaker != NULL) {
      (void)cli_wav_sink_sync(&runtime->pretend_sink);
    }
  }
  /*
   * THE FRAME IS THE PULSE, when there is a frame. Every number below is
   * already on screen and refreshed continuously, so emitting this as well
   * only fills the eight-line log tail with itself once a second — which is
   * exactly what happened to somebody looking for the "talking" and "sent"
   * lines that told them their key had registered. Those had scrolled out
   * behind ten copies of a redundant line.
   */
  if (runtime->screen.enabled) return;
  const struct iterate_kit_darwin_audio_codec_metrics audio =
      cli_main_audio_metrics(runtime);
  cli_runtime_log(
      "info",
      "pulse loops=%u outbox=%u/%u sent=%u frames=%u batches=%u rx=%u "
      "submitted=%u conceal=%u under=%u ringMs=%u convUnder=%u "
      "convRefused=%u micIn=%u micLost=%u roomDrop=%u roomStarve=%u "
      "roomPlayed=%u roomMs=%u roomErr=%" PRId32 " micErr=%" PRId32
      " seqGaps=%u/%u",
      runtime->loop_count, outbox->current_slots,
      ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS,
      runtime->transport.control_sender.messages_sent,
      runtime->voicelab.frames_sent, runtime->voicelab.batches_on_connection,
      runtime->voicelab.spk_frames_received,
      runtime->speaker_frames_played, runtime->speaker_conceal_frames,
      runtime->speaker_underruns, cli_speaker_queued_ms(&runtime->speaker),
      /*
       * A live microphone that macOS refused looks exactly like a quiet room
       * until micIn stays at zero through a turn, so it is on the one line
       * anybody watching a session will already be reading.
       */
      runtime->paced_sink.underrun_frames, runtime->paced_sink.refused_frames,
      audio.capture_frames, audio.capture_frames_dropped,
      /*
       * The room, as distinct from the recording. roomDrop is audio the
       * speaker never got, roomStarve is silence somebody actually heard, and
       * both were invisible while a whole conversation failed to be audible.
       */
      runtime->speaker_room_drops,
      audio.playback_starved_buffers,
      audio.playback_completed_bytes /
          ITERATE_KIT_VOICE_FRAME_BYTES,
      audio.playback_queued_bytes /
          (ITERATE_KIT_VOICE_FRAME_BYTES / ITERATE_KIT_VOICE_FRAME_MS),
      audio.playback_platform_error,
      audio.capture_platform_error,
      /*
       * HOLES IN THE ANSWER, which no other counter on this line can see.
       *
       * Everything above measures a chunk that arrived. These count the ones
       * that did not: the second voice agent numbers every speaker chunk
       * within a call, so a break in the numbering is audio that was sent and
       * never landed. Printed as gaps/frames because one hole of forty is a
       * different failure from forty holes of one, and the first agent — which
       * sends no numbers — leaves both at zero.
       */
      runtime->voicelab.spk_seq_gaps, runtime->voicelab.spk_seq_missing);
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
  cli_main_reconcile_call(runtime, outbox_free);
  cli_main_recycle_if_ready(runtime, outbox_free);
  cli_main_poll_periodic(runtime, now_ms, outbox_free);
  cli_main_pulse(runtime, now_ms, outbox);
}

static void cli_main_poll_periodic(
    struct cli_runtime *runtime, uint64_t now_ms, size_t outbox_free)
{
  assert(runtime != NULL);
  /* Seed the telemetry clock on the first pass. */
  if (runtime->next_stats_at_ms == 0U) {
    runtime->next_stats_at_ms = now_ms + ITERATE_KIT_VOICE_STATS_INTERVAL_MS;
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
  if (!cli_main_drain_audio(runtime)) {
    cli_runtime_log("error", "refusing re-exec before room audio drains");
    runtime->stop_requested = true;
    return;
  }
  /* execv keeps the file descriptors, so the terminal must be handed back. */
  cli_keyboard_close(&runtime->keyboard);
  iterate_kit_darwin_audio_codec_close(&runtime->audio_codec);
  cli_wav_sink_close(&runtime->sink);
  cli_wav_sink_close(&runtime->mic_sink);
  cli_wav_sink_close(&runtime->pretend_sink);
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
  /* Open mic has no turn button: releasing SPACE must not mute a latched
   * session — a space that MUTED would be a second turn-taking authority
   * fighting the server's VAD — and while the session is live a press means
   * nothing either. A press with NOTHING latched is the wake: the same
   * press-to-wake the board grammar gives an ended session. */
  if (runtime->options.open_mic &&
      (event == CLI_KEYBOARD_TALK_STOP ||
       (event == CLI_KEYBOARD_TALK_START && runtime->wants_talk))) {
    return;
  }
  switch (event) {
    case CLI_KEYBOARD_TALK_START:
      (void)cli_main_request_talk(
          runtime, true, ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL);
      /*
       * THE KEY IS WHAT ASKS FOR A CALL, and until it is pressed there is no
       * reason for one to exist.
       *
       * This used to be set unconditionally on every interactive poll, so the
       * process dialled a provider the moment it started and held the session
       * open through however long somebody sat looking at the prompt — paying
       * for it, and burning the idle deadline. Waiting costs nothing now: the
       * far end opens a call on the first frame of speech and holds what
       * arrives while it does, and this end holds what it cannot yet send.
       */
      cli_runtime_log("info", "talking");
      break;
    case CLI_KEYBOARD_TALK_STOP:
      /*
       * Clearing the intent is the whole commit: reconcile_talk sees the turn
       * is no longer wanted, flushes whatever capture queued, and marks the
       * turn. Committing here instead would bypass the flush and cut the last
       * word off every sentence.
       */
      (void)cli_main_request_talk(
          runtime, false, ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL);
      cli_runtime_log("info", "sent");
      break;
    case CLI_KEYBOARD_HANG_UP:
      cli_main_begin_hangup(
          runtime, now_ms, ITERATE_KIT_DEVICE_EVENT_SOURCE_PHYSICAL);
      break;
    case CLI_KEYBOARD_NONE:
    default:
      break;
  }
}

static void cli_main_begin_hangup(
    struct cli_runtime *runtime,
    uint64_t now_ms,
    enum iterate_kit_device_event_source source)
{
  assert(runtime != NULL);
  if (runtime->hanging_up) return;
  runtime->hanging_up = true;
  (void)cli_main_request_talk(runtime, false, source);
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
    cli_main_begin_hangup(
        runtime, now_ms, ITERATE_KIT_DEVICE_EVENT_SOURCE_SYSTEM);
    return;
  }
  if (!runtime->options.push_to_talk && !runtime->options.open_mic) return;
  enum cli_keyboard_event event = CLI_KEYBOARD_NONE;
  if (cli_keyboard_poll(&runtime->keyboard, now_ms, &event) !=
      CLI_KEYBOARD_OK) return;
  cli_main_apply_key(runtime, event, now_ms);
}

static bool cli_main_request_talk(
    struct cli_runtime *runtime,
    bool active,
    enum iterate_kit_device_event_source source)
{
  const enum iterate_kit_status status = cli_device_controls_request_talk(
      &runtime->device_controls, active, source);
  if (status == ITERATE_KIT_OK) return true;
  cli_runtime_log(
      "error", "device control queue rejected talk=%s source=%s status=%d",
      active ? "true" : "false",
      iterate_kit_device_event_source_name(source),
      (int)status);
  runtime->stop_requested = true;
  return false;
}

static void cli_main_enforce_talk_deadline(
    struct cli_runtime *runtime, uint64_t now_ms)
{
  assert(runtime != NULL);
  /* The fence bounds a STUCK BUTTON. An open microphone is not stuck — it is
   * the design — and cutting its stream at thirty seconds would end capture
   * for the rest of the process, since nothing re-requests it. */
  if (runtime->options.open_mic) return;
  if (!runtime->talking || runtime->flushing_turn ||
      iterate_kit_voice_elapsed_ms(now_ms, runtime->turn_started_ms) <=
          ITERATE_KIT_VOICE_TURN_MAX_MS) return;
  (void)cli_main_request_talk(
      runtime, false, ITERATE_KIT_DEVICE_EVENT_SOURCE_SYSTEM);
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
    /*
     * The pretend speaker's converter runs on this loop rather than on
     * CoreAudio's thread, so it only advances if somebody advances it. Placed
     * beside the playback poll because they model the same instant.
     */
    iterate_kit_darwin_audio_codec_pump(
        &runtime->audio_codec, cli_runtime_now_us());
    cli_main_supervise_audio(runtime);
    cli_main_poll_interactive(runtime, now_ms);
    cli_conversation_poll(runtime, now_ms);
    cli_main_enforce_talk_deadline(runtime, now_ms);
    if (cli_device_controls_poll(&runtime->device_controls) !=
        ITERATE_KIT_OK) {
      cli_runtime_log("error", "device control handler failed");
      runtime->stop_requested = true;
    }
    struct iterate_kit_spsc_ring_metrics outbox = {0};
    iterate_kit_spsc_ring_metrics(&runtime->control_outbox, &outbox);
    const size_t outbox_free = ITERATE_KIT_VOICE_CONTROL_OUTBOX_SLOTS -
        outbox.current_slots;
    cli_main_supervise(runtime, now_ms, outbox_free);
    /*
     * THE MICROPHONE IS NOT PART OF BEING READY, and putting it there cost
     * every frame said before the link came up.
     *
     * These two lived inside `cli_main_poll_ready`, which returns unless the
     * transport and the voicelab chain have both finished. CoreAudio does not
     * wait for either: it captures from the moment the process starts, into a
     * 32-frame ring, and for the whole of a seven-second connect nobody was
     * emptying it. Measured: 341 frames lost, against ~350 captured during
     * the connect and a ring that holds 32. Not a leak — an unattended tap.
     *
     * `reconcile_talk` moves for the other half of the same reason. A key
     * pressed during the connect could not start a turn while the gate held
     * it, however willing the far end was to hold what arrived.
     *
     * Neither needs a link. Capture keeps only what a turn asked for, the
     * sender declines gracefully when the outbox or the stream cannot take a
     * batch, and what it declines to send stays queued.
     */
    cli_main_reconcile_talk(runtime, now_ms, outbox_free);
    cli_main_poll_microphone(runtime, now_ms);
    cli_main_poll_ready(runtime, now_ms, &outbox);
    ++runtime->loop_count;
    cli_main_track_connectivity(runtime, now_ms);
    cli_main_draw_screen(runtime, now_ms);
    cli_main_reexec_if_ready(runtime, now_ms);
    cli_main_sleep();
  }
}
