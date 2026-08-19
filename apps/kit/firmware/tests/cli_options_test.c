#include "cli_options.h"

#include <assert.h>
#include <stdlib.h>
#include <string.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

/*
 * The failure that motivated this module: a flag wanting a value and finding
 * none used to assign NULL and carry on. `--name` last on the line left the
 * capability name unset, the run mounted itself under nothing, and the
 * diagnosis started from "the CLI is invisible" rather than from "you made a
 * typo" — which is a long way to travel for a missing word.
 */

static enum cli_options_status run(
    struct cli_options *out, char *problem, size_t problem_bytes, ...)
{
  (void)out;
  (void)problem;
  (void)problem_bytes;
  return CLI_OPTIONS_OK;
}

static enum cli_options_status parse(
    struct cli_options *out, char *problem, char **argv, int argc)
{
  return cli_options_parse(out, argc, argv, problem, 128U);
}

static void a_flag_without_its_value_is_an_error(void)
{
  struct cli_options options;
  char problem[128];
  char *argv[] = {(char *)"cli", (char *)"--name"};

  assert(parse(&options, problem, argv, 2) == CLI_OPTIONS_ERR_MISSING_VALUE);
  assert(strcmp(problem, "--name") == 0);
}

/* An unknown flag names itself, so the message can be acted on. */
static void an_unknown_flag_names_itself(void)
{
  struct cli_options options;
  char problem[128];
  char *argv[] = {(char *)"cli", (char *)"--nmae", (char *)"x"};

  assert(parse(&options, problem, argv, 3) == CLI_OPTIONS_ERR_UNKNOWN);
  assert(strcmp(problem, "--nmae") == 0);
}

/*
 * The credentials have no default. A CLI that invents a project to connect to
 * would authenticate somewhere nobody asked for.
 */
static void the_credentials_are_required(void)
{
  struct cli_options options;
  char problem[128];
  char *argv[] = {(char *)"cli"};

  (void)unsetenv("ITERATE_PROJECT_ID");
  (void)unsetenv("ITERATE_PROJECT_API_KEY");
  (void)unsetenv("ITERATE_OS_BASE_URL");
  assert(parse(&options, problem, argv, 1) == CLI_OPTIONS_ERR_REQUIRED);
  assert(strcmp(problem, "--project-id") == 0);
}

/* Flags win over the environment; the environment wins over nothing. */
static void the_environment_fills_only_what_the_flags_left(void)
{
  struct cli_options options;
  char problem[128];
  char *argv[] = {(char *)"cli", (char *)"--project-id", (char *)"prj_flag"};

  (void)setenv("ITERATE_PROJECT_ID", "prj_env", 1);
  (void)setenv("ITERATE_PROJECT_API_KEY", "key_env", 1);
  (void)setenv("ITERATE_OS_BASE_URL", "https://os.example", 1);
  assert(parse(&options, problem, argv, 3) == CLI_OPTIONS_OK);
  assert(strcmp(options.project_id, "prj_flag") == 0);
  assert(strcmp(options.project_api_key, "key_env") == 0);
  /* Untouched by either: the default stands. */
  assert(strcmp(options.stream_path, "/voice-agent/device") == 0);
  assert(strcmp(options.name, "host") == 0);
}

/*
 * A conversation with no utterances would hold a call open and say nothing,
 * which reads in the report as a device that never answered.
 */
static void conversing_without_utterances_is_refused(void)
{
  struct cli_options options;
  char problem[128];
  char *argv[] = {(char *)"cli", (char *)"--converse", (char *)"10"};

  (void)setenv("ITERATE_PROJECT_ID", "prj", 1);
  (void)setenv("ITERATE_PROJECT_API_KEY", "key", 1);
  (void)setenv("ITERATE_OS_BASE_URL", "https://os.example", 1);
  assert(parse(&options, problem, argv, 3) == CLI_OPTIONS_ERR_INCOMPATIBLE);
}

/*
 * Two drivers cannot share one talk button. Running both, each would end the
 * other's turn and the report would describe a conversation neither of them
 * had; picking one silently would leave the operator pressing a key that does
 * nothing and no way to find out why.
 */
static void a_person_and_a_driver_cannot_both_take_the_turns(void)
{
  struct cli_options options;
  char problem[128];
  char *argv[] = {
    (char *)"cli", (char *)"--push-to-talk", (char *)"--converse",
    (char *)"5", (char *)"--utterance-dir", (char *)"/tmp"};

  (void)setenv("ITERATE_PROJECT_ID", "prj", 1);
  (void)setenv("ITERATE_PROJECT_API_KEY", "key", 1);
  (void)setenv("ITERATE_OS_BASE_URL", "https://os.example", 1);
  assert(parse(&options, problem, argv, 6) == CLI_OPTIONS_ERR_INCOMPATIBLE);
}

/*
 * An interactive session's limit is its own field. Folded into --converse it
 * would start the unattended driver, which needs utterances nobody supplied,
 * and the session would refuse to start for a reason that made no sense.
 */
static void an_interactive_limit_is_not_the_conversation_driver(void)
{
  struct cli_options options;
  char problem[128];
  char *argv[] = {
    (char *)"cli", (char *)"--push-to-talk", (char *)"--live-mic",
    (char *)"--minutes", (char *)"5"};

  assert(parse(&options, problem, argv, 5) == CLI_OPTIONS_OK);
  assert(options.push_to_talk && options.live_mic);
  assert(options.minutes == 5.0);
  assert(options.converse_minutes == 0.0);
  /* And it defaults to no limit, so a session lasts until somebody ends it. */
  char *bare[] = {(char *)"cli"};
  assert(parse(&options, problem, bare, 1) == CLI_OPTIONS_OK);
  assert(options.minutes == 0.0);
}

/* Numbers are checked, so a typo cannot become a silent zero-minute run. */
static void numbers_must_be_numbers(void)
{
  struct cli_options options;
  char problem[128];
  char *bad_minutes[] = {(char *)"cli", (char *)"--converse", (char *)"ten"};
  char *zero_minutes[] = {(char *)"cli", (char *)"--converse", (char *)"0"};
  char *trailing[] = {(char *)"cli", (char *)"--converse", (char *)"10m"};
  char *bad_count[] = {
    (char *)"cli", (char *)"--colleague-every", (char *)"-1"};

  assert(parse(&options, problem, bad_minutes, 3) ==
         CLI_OPTIONS_ERR_NOT_A_NUMBER);
  assert(parse(&options, problem, zero_minutes, 3) ==
         CLI_OPTIONS_ERR_NOT_A_NUMBER);
  assert(parse(&options, problem, trailing, 3) ==
         CLI_OPTIONS_ERR_NOT_A_NUMBER);
  assert(parse(&options, problem, bad_count, 3) ==
         CLI_OPTIONS_ERR_NOT_A_NUMBER);
}

/* --insecure must never be reachable by accident. */
static void certificate_checking_is_on_unless_asked_otherwise(void)
{
  struct cli_options options;
  char problem[128];
  char *plain[] = {(char *)"cli"};
  char *asked[] = {(char *)"cli", (char *)"--insecure"};

  (void)setenv("ITERATE_PROJECT_ID", "prj", 1);
  (void)setenv("ITERATE_PROJECT_API_KEY", "key", 1);
  (void)setenv("ITERATE_OS_BASE_URL", "https://os.example", 1);
  assert(parse(&options, problem, plain, 1) == CLI_OPTIONS_OK);
  assert(!options.insecure);
  assert(parse(&options, problem, asked, 2) == CLI_OPTIONS_OK);
  assert(options.insecure);
}

/* Help is a status, not an exit: the caller decides what to do about it. */
static void help_is_reported_rather_than_taken(void)
{
  struct cli_options options;
  char problem[128];
  char *argv[] = {(char *)"cli", (char *)"--help"};

  assert(parse(&options, problem, argv, 2) == CLI_OPTIONS_HELP);
}

static void null_arguments_are_refused(void)
{
  struct cli_options options;
  char problem[128];
  char *argv[] = {(char *)"cli"};

  assert(cli_options_parse(NULL, 1, argv, problem, sizeof(problem)) ==
         CLI_OPTIONS_ERR_ARG);
  assert(cli_options_parse(&options, 1, NULL, problem, sizeof(problem)) ==
         CLI_OPTIONS_ERR_ARG);
  assert(cli_options_parse(&options, 1, argv, NULL, 0U) == CLI_OPTIONS_ERR_ARG);
  assert(strcmp(cli_options_status_name(CLI_OPTIONS_ERR_MISSING_VALUE),
                "missing-value") == 0);
}

int main(void)
{
  (void)run;
  a_flag_without_its_value_is_an_error();
  an_unknown_flag_names_itself();
  the_credentials_are_required();
  the_environment_fills_only_what_the_flags_left();
  conversing_without_utterances_is_refused();
  a_person_and_a_driver_cannot_both_take_the_turns();
  an_interactive_limit_is_not_the_conversation_driver();
  numbers_must_be_numbers();
  certificate_checking_is_on_unless_asked_otherwise();
  help_is_reported_rather_than_taken();
  null_arguments_are_refused();
  return 0;
}
