/* cli_options.c: owns the command line, the environment fallbacks, and help. */

#include <assert.h>
#include <stdlib.h>
#include <string.h>

#include "cli_options.h"

enum {
  /* Bound on a flag's value, so a hostile argv cannot make help unreadable. */
  CLI_OPTIONS_PROBLEM_TEXT_MAX = 96,
};

#define CLI_OPTIONS_DEFAULT_STREAM_PATH "/voicelab/device"
#define CLI_OPTIONS_DEFAULT_NAME "host"
#define CLI_OPTIONS_DEFAULT_SPEAKER_WAV "iterate-kit-playback.wav"
#define CLI_OPTIONS_DEFAULT_REPORT_JSON "iterate-kit-report.json"
/* Parts per thousand of real time; matches CLI_VIRTUAL_CLOCK_RATE_UNIT. */
#define CLI_OPTIONS_DEFAULT_CLOCK_RATE 1000U

/** What a flag does with the word after it. */
enum cli_options_kind {
  /** Borrows the next word as a string. */
  CLI_OPTIONS_KIND_TEXT,
  /** Takes no value; presence is the whole meaning. */
  CLI_OPTIONS_KIND_SWITCH,
  /** Positive number of minutes. */
  CLI_OPTIONS_KIND_MINUTES,
  /** Non-negative count. */
  CLI_OPTIONS_KIND_COUNT,
};

/** Which field a flag writes. Named so the table stays readable. */
enum cli_options_field {
  CLI_OPTIONS_FIELD_PROJECT_ID,
  CLI_OPTIONS_FIELD_API_KEY,
  CLI_OPTIONS_FIELD_OS_BASE_URL,
  CLI_OPTIONS_FIELD_STREAM_PATH,
  CLI_OPTIONS_FIELD_NAME,
  CLI_OPTIONS_FIELD_MIC_WAV,
  CLI_OPTIONS_FIELD_UTTERANCE_DIR,
  CLI_OPTIONS_FIELD_SPEAKER_WAV,
  CLI_OPTIONS_FIELD_MIC_RECORD,
  CLI_OPTIONS_FIELD_PRETEND_SPEAKER,
  CLI_OPTIONS_FIELD_REPORT_JSON,
  CLI_OPTIONS_FIELD_CONVERSE,
  CLI_OPTIONS_FIELD_MINUTES,
  CLI_OPTIONS_FIELD_BACK_OFFICE_EVERY,
  CLI_OPTIONS_FIELD_SPEAKER_PACE,
  CLI_OPTIONS_FIELD_DEVICE,
  CLI_OPTIONS_FIELD_SCHEDULE_OUT,
  CLI_OPTIONS_FIELD_SCHEDULE_IN,
  CLI_OPTIONS_FIELD_SCHEDULE_SEED,
  CLI_OPTIONS_FIELD_CLOCK_RATE,
  CLI_OPTIONS_FIELD_SEALED,
  CLI_OPTIONS_FIELD_CPU_STALLS,
  CLI_OPTIONS_FIELD_CPU_STALL_MS,
  CLI_OPTIONS_FIELD_CLOCK_SKEWS,
  CLI_OPTIONS_FIELD_CLOCK_SKEW_MS,
  CLI_OPTIONS_FIELD_CLOCK_JITTER_MS,
  CLI_OPTIONS_FIELD_WIRE_STALLS,
  CLI_OPTIONS_FIELD_WIRE_STALL_MS,
  CLI_OPTIONS_FIELD_WIRE_RESETS,
  CLI_OPTIONS_FIELD_WIRE_THROTTLE,
  CLI_OPTIONS_FIELD_FRAME_LOSS,
  CLI_OPTIONS_FIELD_FRAME_DUPLICATE,
  CLI_OPTIONS_FIELD_FRAME_REORDER,
  CLI_OPTIONS_FIELD_MIC_SHORT,
  CLI_OPTIONS_FIELD_MIC_CLIP,
  CLI_OPTIONS_FIELD_LIVE_AUDIO,
  CLI_OPTIONS_FIELD_LIVE_MIC,
  CLI_OPTIONS_FIELD_PUSH_TO_TALK,
  CLI_OPTIONS_FIELD_INSECURE,
  CLI_OPTIONS_FIELD_HELP,
};

/**
 * One flag: how it is written, what it sets, how its value is read, and the
 * environment variable that supplies it when the flag is absent.
 *
 * A table rather than a chain of string comparisons because every property of
 * a flag then lives on one line: adding one cannot forget the help text, and
 * help cannot drift from what is actually accepted, since both are generated
 * from here.
 */
struct cli_options_flag {
  const char *name;
  enum cli_options_kind kind;
  enum cli_options_field field;
  const char *environment;
  /** Complete legacy help line; the CLI's output is an external contract. */
  const char *help_line;
};

static const struct cli_options_flag CLI_OPTIONS_FLAGS[] = {
  {"--project-id", CLI_OPTIONS_KIND_TEXT, CLI_OPTIONS_FIELD_PROJECT_ID,
   "ITERATE_PROJECT_ID",
   "  --project-id ID       Project id (ITERATE_PROJECT_ID)\n"},
  {"--api-key", CLI_OPTIONS_KIND_TEXT, CLI_OPTIONS_FIELD_API_KEY,
   "ITERATE_PROJECT_API_KEY",
   "  --api-key KEY         Project API key (ITERATE_PROJECT_API_KEY)\n"},
  {"--os-base-url", CLI_OPTIONS_KIND_TEXT, CLI_OPTIONS_FIELD_OS_BASE_URL,
   "ITERATE_OS_BASE_URL",
   "  --os-base-url URL     OS origin, e.g. https://os.iterate.com "
   "(ITERATE_OS_BASE_URL)\n"},
  {"--stream-path", CLI_OPTIONS_KIND_TEXT, CLI_OPTIONS_FIELD_STREAM_PATH,
   "ITERATE_KIT_STREAM_PATH",
   "  --stream-path PATH    Stream path (ITERATE_KIT_STREAM_PATH; "
   "default /voicelab/device)\n"},
  {"--name", CLI_OPTIONS_KIND_TEXT, CLI_OPTIONS_FIELD_NAME,
   "ITERATE_KIT_CAPABILITY_NAME",
   "  --name NAME           Mount capability as kit.NAME "
   "(ITERATE_KIT_CAPABILITY_NAME; default host)\n"},
  {"--mic-wav", CLI_OPTIONS_KIND_TEXT, CLI_OPTIONS_FIELD_MIC_WAV,
   "ITERATE_KIT_MIC_WAV",
   "  --mic-wav FILE        PCM16 mono 16 kHz source for remote PTT "
   "(ITERATE_KIT_MIC_WAV)\n"},
  {"--speaker-wav", CLI_OPTIONS_KIND_TEXT, CLI_OPTIONS_FIELD_SPEAKER_WAV,
   NULL,
   "  --speaker-wav FILE    True played timeline, including concealed "
   "silence (default iterate-kit-playback.wav)\n"},
  {"--live-audio", CLI_OPTIONS_KIND_SWITCH, CLI_OPTIONS_FIELD_LIVE_AUDIO,
   NULL, "  --live-audio          Also send the true timeline to CoreAudio\n"},
  {"--live-mic", CLI_OPTIONS_KIND_SWITCH, CLI_OPTIONS_FIELD_LIVE_MIC,
   NULL,
   "  --live-mic            Capture from this Mac's default input instead of "
   "--mic-wav\n"},
  {"--push-to-talk", CLI_OPTIONS_KIND_SWITCH, CLI_OPTIONS_FIELD_PUSH_TO_TALK,
   NULL,
   "  --push-to-talk        Hold SPACE to talk, release to send, q to hang "
   "up\n"},
  {"--minutes", CLI_OPTIONS_KIND_MINUTES, CLI_OPTIONS_FIELD_MINUTES,
   NULL,
   "  --minutes MINUTES     Wall-clock limit for an interactive session\n"},
  {"--converse", CLI_OPTIONS_KIND_MINUTES, CLI_OPTIONS_FIELD_CONVERSE,
   NULL, "  --converse MINUTES    Run the unattended conversation driver\n"},
  {"--utterance-dir", CLI_OPTIONS_KIND_TEXT, CLI_OPTIONS_FIELD_UTTERANCE_DIR,
   NULL,
   "  --utterance-dir DIR   Directory of PCM16 mono 16 kHz WAVs for "
   "--converse\n"},
  {"--colleague-every", CLI_OPTIONS_KIND_COUNT,
   CLI_OPTIONS_FIELD_BACK_OFFICE_EVERY, NULL,
   "  --colleague-every N   Use the colleague-forcing utterance every "
   "Nth turn (0 disables)\n"},
  {"--speaker-pace", CLI_OPTIONS_KIND_COUNT, CLI_OPTIONS_FIELD_SPEAKER_PACE,
   NULL,
   "  --speaker-pace FPS    Model a converter consuming FPS frames/second "
   "(0 disables; 50 is the device)\n"},
  {"--device", CLI_OPTIONS_KIND_TEXT, CLI_OPTIONS_FIELD_DEVICE, NULL,
   "  --device NAME         Wear a board's bounded sizes "
   "(host-ideal, waveshare-s3-amoled)\n"},
  {"--schedule-seed", CLI_OPTIONS_KIND_COUNT, CLI_OPTIONS_FIELD_SCHEDULE_SEED,
   NULL,
   "  --schedule-seed N     Draw this session's faults from N (0 draws "
   "none)\n"},
  {"--schedule-out", CLI_OPTIONS_KIND_TEXT, CLI_OPTIONS_FIELD_SCHEDULE_OUT,
   NULL,
   "  --schedule-out FILE   Write the schedule used, to attach to a bug\n"},
  {"--schedule-in", CLI_OPTIONS_KIND_TEXT, CLI_OPTIONS_FIELD_SCHEDULE_IN,
   NULL,
   "  --schedule-in FILE    Replay a schedule verbatim, ignoring the "
   "recipe\n"},
  {"--sealed", CLI_OPTIONS_KIND_SWITCH, CLI_OPTIONS_FIELD_SEALED, NULL,
   "  --sealed              No host clock at all; a seed replays bit for "
   "bit\n"},
  {"--clock-rate", CLI_OPTIONS_KIND_COUNT, CLI_OPTIONS_FIELD_CLOCK_RATE, NULL,
   "  --clock-rate N        Session ms per real ms, per thousand "
   "(1000 is realtime)\n"},
  {"--cpu-stalls-per-min", CLI_OPTIONS_KIND_COUNT,
   CLI_OPTIONS_FIELD_CPU_STALLS, NULL,
   "  --cpu-stalls-per-min N   Preempt the loop N times a minute\n"},
  {"--cpu-stall-max-ms", CLI_OPTIONS_KIND_COUNT,
   CLI_OPTIONS_FIELD_CPU_STALL_MS, NULL,
   "  --cpu-stall-max-ms MS    Longest such stall\n"},
  {"--clock-skews-per-min", CLI_OPTIONS_KIND_COUNT,
   CLI_OPTIONS_FIELD_CLOCK_SKEWS, NULL,
   "  --clock-skews-per-min N  Step the clock backwards N times a minute\n"},
  {"--clock-skew-max-ms", CLI_OPTIONS_KIND_COUNT,
   CLI_OPTIONS_FIELD_CLOCK_SKEW_MS, NULL,
   "  --clock-skew-max-ms MS   Furthest such step\n"},
  {"--clock-jitter-ms", CLI_OPTIONS_KIND_COUNT,
   CLI_OPTIONS_FIELD_CLOCK_JITTER_MS, NULL,
   "  --clock-jitter-ms MS     Wander stamps by up to MS either way\n"},
  {"--wire-stalls-per-min", CLI_OPTIONS_KIND_COUNT,
   CLI_OPTIONS_FIELD_WIRE_STALLS, NULL,
   "  --wire-stalls-per-min N  Stop bytes moving N times a minute "
   "(needs the proxy)\n"},
  {"--wire-stall-max-ms", CLI_OPTIONS_KIND_COUNT,
   CLI_OPTIONS_FIELD_WIRE_STALL_MS, NULL,
   "  --wire-stall-max-ms MS   Longest such stall\n"},
  {"--wire-resets", CLI_OPTIONS_KIND_COUNT, CLI_OPTIONS_FIELD_WIRE_RESETS,
   NULL, "  --wire-resets N          Sever the connection N times\n"},
  {"--wire-throttle-fps", CLI_OPTIONS_KIND_COUNT,
   CLI_OPTIONS_FIELD_WIRE_THROTTLE, NULL,
   "  --wire-throttle-fps FPS  Hold the downlink to FPS frames/second "
   "(9 was measured)\n"},
  {"--frame-loss-one-in", CLI_OPTIONS_KIND_COUNT,
   CLI_OPTIONS_FIELD_FRAME_LOSS, NULL,
   "  --frame-loss-one-in N    Drop one delivered frame in N\n"},
  {"--frame-duplicate-one-in", CLI_OPTIONS_KIND_COUNT,
   CLI_OPTIONS_FIELD_FRAME_DUPLICATE, NULL,
   "  --frame-duplicate-one-in N  Deliver one frame in N twice\n"},
  {"--frame-reorder-one-in", CLI_OPTIONS_KIND_COUNT,
   CLI_OPTIONS_FIELD_FRAME_REORDER, NULL,
   "  --frame-reorder-one-in N    Hold one frame in N back\n"},
  {"--mic-short-one-in", CLI_OPTIONS_KIND_COUNT, CLI_OPTIONS_FIELD_MIC_SHORT,
   NULL,
   "  --mic-short-one-in N     Return a partial capture buffer one time in "
   "N\n"},
  {"--mic-clip", CLI_OPTIONS_KIND_SWITCH, CLI_OPTIONS_FIELD_MIC_CLIP, NULL,
   "  --mic-clip               Drive capture to full scale\n"},
  {"--mic-record", CLI_OPTIONS_KIND_TEXT, CLI_OPTIONS_FIELD_MIC_RECORD, NULL,
   "  --mic-record FILE     Record what the microphone captured\n"},
  {"--pretend-speaker", CLI_OPTIONS_KIND_TEXT,
   CLI_OPTIONS_FIELD_PRETEND_SPEAKER, NULL,
   "  --pretend-speaker FILE  Run the live speaker path into FILE, not the "
   "room\n"},
  {"--report-json", CLI_OPTIONS_KIND_TEXT, CLI_OPTIONS_FIELD_REPORT_JSON,
   NULL,
   "  --report-json FILE    Unattended JSON report (default "
   "iterate-kit-report.json)\n"},
  {"--insecure", CLI_OPTIONS_KIND_SWITCH, CLI_OPTIONS_FIELD_INSECURE,
   NULL,
   "  --insecure            Disable TLS certificate verification; local "
   "testing only\n"},
  {"--help", CLI_OPTIONS_KIND_SWITCH, CLI_OPTIONS_FIELD_HELP,
   NULL, "  --help                Show this help\n"},
};

enum {
  CLI_OPTIONS_FLAG_COUNT =
      (int)(sizeof(CLI_OPTIONS_FLAGS) / sizeof(CLI_OPTIONS_FLAGS[0])),
};

/* Records `text` as the reason parsing stopped. Always NUL-terminates. */
static void cli_options_note(char *problem, size_t bytes, const char *text);

/* Returns the flag `name` names, or NULL. */
static const struct cli_options_flag *cli_options_find(const char *name);

/* Writes one flag's value into `out`. Fails with ERR_NOT_A_NUMBER. */
static enum cli_options_status cli_options_apply(
    struct cli_options *out,
    const struct cli_options_flag *flag,
    const char *value);

/* Applies every argv flag after the public boundary validated storage. */
static enum cli_options_status cli_options_parse_flags(
    struct cli_options *out,
    int argc,
    char **argv,
    char *problem,
    size_t problem_bytes);

/* Parses a positive count of minutes. Fails with ERR_NOT_A_NUMBER. */
static enum cli_options_status cli_options_read_minutes(
    const char *text, double *out_minutes);

/* Parses a non-negative count. Fails with ERR_NOT_A_NUMBER. */
static enum cli_options_status cli_options_read_count(
    const char *text, uint32_t *out_count);

/* Fills anything still unset from the environment, then from defaults. */
static void cli_options_fill(struct cli_options *out);

/* Fills unset text fields from their declared environment variables. */
static void cli_options_fill_environment(struct cli_options *out);

/* Assigns one environment-backed text field only when no flag supplied it. */
static void cli_options_fill_text(
    struct cli_options *out,
    enum cli_options_field field,
    const char *value);

/* Applies defaults only after both flags and environment had their chance. */
static void cli_options_fill_defaults(struct cli_options *out);

/* Rejects an options set nothing could act on. */

/**
 * Whether `name` can be a capability mount segment.
 *
 * ORIGINATING FAILURE. The name becomes `kit.<name>`, and a hyphen in it is
 * rejected by the platform as an invalid argument. The rig did not find out
 * until the Cap'n Web mount failed five seconds into the run, reporting
 * `capnweb=-1` and a URL — nothing about names, nothing about which argument.
 * A shell wrapper passed `mac-$STAMP` for weeks on that basis and had never
 * once connected. Refusing it here costs one comparison and names the flag.
 */
static bool cli_options_name_is_mountable(const char *name)
{
  size_t index;
  assert(name != NULL);
  if (name[0] == '\0') return false;
  for (index = 0U; name[index] != '\0'; index++) {
    const char c = name[index];
    const bool lower = c >= 'a' && c <= 'z';
    const bool digit = c >= '0' && c <= '9';
    if (!lower && !digit && c != '_') return false;
  }
  return true;
}

static enum cli_options_status cli_options_check(
    const struct cli_options *out, char *problem, size_t problem_bytes);

/* Rejects flag pairs that cannot both be honoured. Fails ERR_INCOMPATIBLE. */
static enum cli_options_status cli_options_check_combinations(
    const struct cli_options *out, char *problem, size_t problem_bytes);

const char *cli_options_status_name(enum cli_options_status status)
{
  switch (status) {
    case CLI_OPTIONS_OK: return "ok";
    case CLI_OPTIONS_HELP: return "help";
    case CLI_OPTIONS_ERR_ARG: return "bad-argument";
    case CLI_OPTIONS_ERR_UNKNOWN: return "unknown-flag";
    case CLI_OPTIONS_ERR_MISSING_VALUE: return "missing-value";
    case CLI_OPTIONS_ERR_NOT_A_NUMBER: return "not-a-number";
    case CLI_OPTIONS_ERR_REQUIRED: return "missing-required";
    case CLI_OPTIONS_ERR_INCOMPATIBLE: return "incompatible";
    default: return "unknown";
  }
}

void cli_options_print_help(FILE *out)
{
  if (out == NULL) return;
  (void)fprintf(out, "Usage: iterate-kit-cli [options]\n\n");
  (void)fprintf(
      out,
      "Runs the Waveshare voicelab runtime on macOS with the same bounded "
      "resource profile. Flags override their environment variables.\n\n");
  for (int index = 0; index < CLI_OPTIONS_FLAG_COUNT; ++index) {
    const struct cli_options_flag *flag = &CLI_OPTIONS_FLAGS[index];
    (void)fputs(flag->help_line, out);
  }
}

enum cli_options_status cli_options_parse(
    struct cli_options *out,
    int argc,
    char **argv,
    char *problem,
    size_t problem_bytes)
{
  if (out == NULL || argv == NULL || problem == NULL || problem_bytes == 0U) {
    return CLI_OPTIONS_ERR_ARG;
  }
  memset(out, 0, sizeof(*out));
  cli_options_note(problem, problem_bytes, "");
  const enum cli_options_status status = cli_options_parse_flags(
      out, argc, argv, problem, problem_bytes);
  if (status != CLI_OPTIONS_OK) return status;
  cli_options_fill(out);
  return cli_options_check(out, problem, problem_bytes);
}

static enum cli_options_status cli_options_parse_flags(
    struct cli_options *out,
    int argc,
    char **argv,
    char *problem,
    size_t problem_bytes)
{
  assert(out != NULL && argv != NULL && problem != NULL && problem_bytes > 0U);
  for (int index = 1; index < argc; ++index) {
    const struct cli_options_flag *flag = cli_options_find(argv[index]);
    if (flag == NULL) {
      cli_options_note(problem, problem_bytes, argv[index]);
      return CLI_OPTIONS_ERR_UNKNOWN;
    }
    if (flag->field == CLI_OPTIONS_FIELD_HELP) return CLI_OPTIONS_HELP;
    if (flag->kind == CLI_OPTIONS_KIND_SWITCH) {
      (void)cli_options_apply(out, flag, NULL);
      continue;
    }
    /*
     * A flag that wants a value and has none is an ERROR, not a NULL quietly
     * assigned. Assigning it left the capability name unset while the run
     * carried on and mounted itself as nothing, which is a diagnosis nobody
     * wants to make twice.
     */
    if (index + 1 >= argc) {
      cli_options_note(problem, problem_bytes, flag->name);
      return CLI_OPTIONS_ERR_MISSING_VALUE;
    }
    ++index;
    const enum cli_options_status status =
        cli_options_apply(out, flag, argv[index]);
    if (status != CLI_OPTIONS_OK) {
      cli_options_note(problem, problem_bytes, flag->name);
      return status;
    }
  }
  return CLI_OPTIONS_OK;
}

static void cli_options_note(char *problem, size_t bytes, const char *text)
{
  assert(problem != NULL && bytes > 0U);
  const size_t limit = bytes - 1U < CLI_OPTIONS_PROBLEM_TEXT_MAX
      ? bytes - 1U
      : CLI_OPTIONS_PROBLEM_TEXT_MAX;
  size_t length = 0U;
  while (text != NULL && text[length] != '\0' && length < limit) ++length;
  if (length > 0U) memcpy(problem, text, length);
  problem[length] = '\0';
}

static const struct cli_options_flag *cli_options_find(const char *name)
{
  assert(name != NULL);
  for (int index = 0; index < CLI_OPTIONS_FLAG_COUNT; ++index) {
    if (strcmp(CLI_OPTIONS_FLAGS[index].name, name) == 0) {
      return &CLI_OPTIONS_FLAGS[index];
    }
  }
  return NULL;
}

static enum cli_options_status cli_options_apply(
    struct cli_options *out,
    const struct cli_options_flag *flag,
    const char *value)
{
  assert(out != NULL && flag != NULL);
  switch (flag->field) {
    case CLI_OPTIONS_FIELD_PROJECT_ID: out->project_id = value; break;
    case CLI_OPTIONS_FIELD_API_KEY: out->project_api_key = value; break;
    case CLI_OPTIONS_FIELD_OS_BASE_URL: out->os_base_url = value; break;
    case CLI_OPTIONS_FIELD_STREAM_PATH: out->stream_path = value; break;
    case CLI_OPTIONS_FIELD_NAME: out->name = value; break;
    case CLI_OPTIONS_FIELD_MIC_WAV: out->mic_wav = value; break;
    case CLI_OPTIONS_FIELD_UTTERANCE_DIR: out->utterance_dir = value; break;
    case CLI_OPTIONS_FIELD_SPEAKER_WAV: out->speaker_wav = value; break;
    case CLI_OPTIONS_FIELD_MIC_RECORD: out->mic_record = value; break;
    case CLI_OPTIONS_FIELD_PRETEND_SPEAKER:
      out->pretend_speaker = value;
      break;
    case CLI_OPTIONS_FIELD_REPORT_JSON: out->report_json = value; break;
    case CLI_OPTIONS_FIELD_CONVERSE:
      return cli_options_read_minutes(value, &out->converse_minutes);
    case CLI_OPTIONS_FIELD_MINUTES:
      return cli_options_read_minutes(value, &out->minutes);
    case CLI_OPTIONS_FIELD_BACK_OFFICE_EVERY:
      return cli_options_read_count(value, &out->back_office_every);
    case CLI_OPTIONS_FIELD_SPEAKER_PACE:
      return cli_options_read_count(value, &out->speaker_pace_fps);
    case CLI_OPTIONS_FIELD_DEVICE: out->device = value; break;
    case CLI_OPTIONS_FIELD_SCHEDULE_OUT: out->schedule_out = value; break;
    case CLI_OPTIONS_FIELD_SCHEDULE_IN: out->schedule_in = value; break;
    case CLI_OPTIONS_FIELD_SCHEDULE_SEED:
      return cli_options_read_count(value, &out->schedule_seed);
    case CLI_OPTIONS_FIELD_CLOCK_RATE:
      return cli_options_read_count(value, &out->clock_rate);
    case CLI_OPTIONS_FIELD_CPU_STALLS:
      return cli_options_read_count(value, &out->cpu_stalls_per_minute);
    case CLI_OPTIONS_FIELD_CPU_STALL_MS:
      return cli_options_read_count(value, &out->cpu_stall_max_ms);
    case CLI_OPTIONS_FIELD_CLOCK_SKEWS:
      return cli_options_read_count(value, &out->clock_skews_per_minute);
    case CLI_OPTIONS_FIELD_CLOCK_SKEW_MS:
      return cli_options_read_count(value, &out->clock_skew_max_ms);
    case CLI_OPTIONS_FIELD_CLOCK_JITTER_MS:
      return cli_options_read_count(value, &out->clock_jitter_ms);
    case CLI_OPTIONS_FIELD_WIRE_STALLS:
      return cli_options_read_count(value, &out->wire_stalls_per_minute);
    case CLI_OPTIONS_FIELD_WIRE_STALL_MS:
      return cli_options_read_count(value, &out->wire_stall_max_ms);
    case CLI_OPTIONS_FIELD_WIRE_RESETS:
      return cli_options_read_count(value, &out->wire_resets);
    case CLI_OPTIONS_FIELD_WIRE_THROTTLE:
      return cli_options_read_count(value, &out->wire_throttle_fps);
    case CLI_OPTIONS_FIELD_FRAME_LOSS:
      return cli_options_read_count(value, &out->frame_loss_one_in);
    case CLI_OPTIONS_FIELD_FRAME_DUPLICATE:
      return cli_options_read_count(value, &out->frame_duplicate_one_in);
    case CLI_OPTIONS_FIELD_FRAME_REORDER:
      return cli_options_read_count(value, &out->frame_reorder_one_in);
    case CLI_OPTIONS_FIELD_MIC_SHORT:
      return cli_options_read_count(value, &out->mic_short_one_in);
    case CLI_OPTIONS_FIELD_MIC_CLIP: out->mic_clip = true; break;
    case CLI_OPTIONS_FIELD_SEALED: out->sealed = true; break;
    case CLI_OPTIONS_FIELD_LIVE_AUDIO: out->live_audio = true; break;
    case CLI_OPTIONS_FIELD_LIVE_MIC: out->live_mic = true; break;
    case CLI_OPTIONS_FIELD_PUSH_TO_TALK: out->push_to_talk = true; break;
    case CLI_OPTIONS_FIELD_INSECURE: out->insecure = true; break;
    case CLI_OPTIONS_FIELD_HELP: break;
    default: break;
  }
  return CLI_OPTIONS_OK;
}

static enum cli_options_status cli_options_read_minutes(
    const char *text, double *out_minutes)
{
  assert(out_minutes != NULL);
  if (text == NULL) return CLI_OPTIONS_ERR_NOT_A_NUMBER;
  char *end = NULL;
  const double minutes = strtod(text, &end);
  if (end == text || end == NULL || *end != '\0' || !(minutes > 0.0)) {
    return CLI_OPTIONS_ERR_NOT_A_NUMBER;
  }
  *out_minutes = minutes;
  return CLI_OPTIONS_OK;
}

static enum cli_options_status cli_options_read_count(
    const char *text, uint32_t *out_count)
{
  assert(out_count != NULL);
  if (text == NULL) return CLI_OPTIONS_ERR_NOT_A_NUMBER;
  char *end = NULL;
  const unsigned long value = strtoul(text, &end, 10);
  if (end == text || end == NULL || *end != '\0' || value > UINT32_MAX) {
    return CLI_OPTIONS_ERR_NOT_A_NUMBER;
  }
  *out_count = (uint32_t)value;
  return CLI_OPTIONS_OK;
}

static void cli_options_fill(struct cli_options *out)
{
  assert(out != NULL);
  cli_options_fill_environment(out);
  cli_options_fill_defaults(out);
}

static void cli_options_fill_environment(struct cli_options *out)
{
  assert(out != NULL);
  for (int index = 0; index < CLI_OPTIONS_FLAG_COUNT; ++index) {
    const struct cli_options_flag *flag = &CLI_OPTIONS_FLAGS[index];
    if (flag->environment == NULL) continue;
    if (flag->kind != CLI_OPTIONS_KIND_TEXT) continue;
    const char *value = getenv(flag->environment);
    if (value == NULL || value[0] == '\0') continue;
    cli_options_fill_text(out, flag->field, value);
  }
}

static void cli_options_fill_text(
    struct cli_options *out,
    enum cli_options_field field,
    const char *value)
{
  assert(out != NULL && value != NULL);
  switch (field) {
    case CLI_OPTIONS_FIELD_PROJECT_ID:
      if (out->project_id == NULL) out->project_id = value;
      break;
    case CLI_OPTIONS_FIELD_API_KEY:
      if (out->project_api_key == NULL) out->project_api_key = value;
      break;
    case CLI_OPTIONS_FIELD_OS_BASE_URL:
      if (out->os_base_url == NULL) out->os_base_url = value;
      break;
    case CLI_OPTIONS_FIELD_STREAM_PATH:
      if (out->stream_path == NULL) out->stream_path = value;
      break;
    case CLI_OPTIONS_FIELD_NAME:
      if (out->name == NULL) out->name = value;
      break;
    case CLI_OPTIONS_FIELD_MIC_WAV:
      if (out->mic_wav == NULL) out->mic_wav = value;
      break;
    default:
      break;
  }
}

static void cli_options_fill_defaults(struct cli_options *out)
{
  assert(out != NULL);
  if (out->stream_path == NULL) {
    out->stream_path = CLI_OPTIONS_DEFAULT_STREAM_PATH;
  }
  if (out->name == NULL) out->name = CLI_OPTIONS_DEFAULT_NAME;
  if (out->speaker_wav == NULL) {
    out->speaker_wav = CLI_OPTIONS_DEFAULT_SPEAKER_WAV;
  }
  if (out->report_json == NULL) {
    out->report_json = CLI_OPTIONS_DEFAULT_REPORT_JSON;
  }
  /*
   * Realtime unless somebody asked otherwise. A zero here would mean "time
   * does not pass", and every deadline in the process would wait forever for
   * a stamp that never moves — a hang with no message, from a flag nobody set.
   */
  if (out->clock_rate == 0U) out->clock_rate = CLI_OPTIONS_DEFAULT_CLOCK_RATE;
}

static enum cli_options_status cli_options_check(
    const struct cli_options *out, char *problem, size_t problem_bytes)
{
  assert(out != NULL);
  if (out->live_audio && out->pretend_speaker != NULL) {
    cli_options_note(
        problem, problem_bytes,
        "--live-audio and --pretend-speaker are the same seam: pick one");
    return CLI_OPTIONS_ERR_INCOMPATIBLE;
  }
  if (out->name != NULL && !cli_options_name_is_mountable(out->name)) {
    cli_options_note(
        problem, problem_bytes,
        "--name becomes the mount kit.<name>: use a-z, 0-9 or _ only");
    return CLI_OPTIONS_ERR_INCOMPATIBLE;
  }
  /*
   * The three credentials have no default because there is no safe one. A
   * CLI that picks a project to talk to is worse than a CLI that refuses.
   */
  if (out->project_id == NULL) {
    cli_options_note(problem, problem_bytes, "--project-id");
    return CLI_OPTIONS_ERR_REQUIRED;
  }
  if (out->project_api_key == NULL) {
    cli_options_note(problem, problem_bytes, "--api-key");
    return CLI_OPTIONS_ERR_REQUIRED;
  }
  if (out->os_base_url == NULL) {
    cli_options_note(problem, problem_bytes, "--os-base-url");
    return CLI_OPTIONS_ERR_REQUIRED;
  }
  return cli_options_check_combinations(out, problem, problem_bytes);
}

static enum cli_options_status cli_options_check_combinations(
    const struct cli_options *out, char *problem, size_t problem_bytes)
{
  assert(out != NULL);
  if (out->converse_minutes > 0.0 && out->utterance_dir == NULL) {
    cli_options_note(problem, problem_bytes, "--converse needs --utterance-dir");
    return CLI_OPTIONS_ERR_INCOMPATIBLE;
  }
  /*
   * Two drivers, one talk button. --converse takes turns on a schedule and
   * --push-to-talk takes them when a person presses a key; run together, each
   * would end the other's turn and the report would describe a conversation
   * neither of them had. Picking one silently is worse than refusing: the
   * operator would spend the session wondering why their key does nothing.
   */
  if (out->push_to_talk && out->converse_minutes > 0.0) {
    cli_options_note(
        problem, problem_bytes, "--push-to-talk cannot run with --converse");
    return CLI_OPTIONS_ERR_INCOMPATIBLE;
  }
  /*
   * A live microphone and a recorded one are both "the microphone", and there
   * is no useful reading of both. Preferring one would make the other flag a
   * no-op that looks like it worked.
   */
  if (out->live_mic && out->mic_wav != NULL) {
    cli_options_note(
        problem, problem_bytes, "--live-mic cannot run with --mic-wav");
    return CLI_OPTIONS_ERR_INCOMPATIBLE;
  }
  return CLI_OPTIONS_OK;
}
