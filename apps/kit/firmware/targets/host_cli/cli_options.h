#ifndef ITERATE_KIT_CLI_OPTIONS_H
#define ITERATE_KIT_CLI_OPTIONS_H

/*
 * cli_options: what the CLI was asked to do, from flags and environment.
 *
 * Every value here is borrowed — pointers into argv or into the environment,
 * both of which outlive the process's use of them. Nothing is copied and
 * nothing is owned, so there is nothing to free and no lifetime to reason
 * about beyond "do not call this with an argv you are about to discard".
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

/** One status per way the command line can be wrong. */
enum cli_options_status {
  CLI_OPTIONS_OK = 0,
  /** --help was given: help has been printed, the caller should exit 0. */
  CLI_OPTIONS_HELP,
  /** A NULL argv or output pointer. */
  CLI_OPTIONS_ERR_ARG,
  /** A flag nobody recognises. */
  CLI_OPTIONS_ERR_UNKNOWN,
  /** A flag that takes a value was last on the line. */
  CLI_OPTIONS_ERR_MISSING_VALUE,
  /** A numeric flag whose value was not a number in range. */
  CLI_OPTIONS_ERR_NOT_A_NUMBER,
  /** Something with no default was not supplied anywhere. */
  CLI_OPTIONS_ERR_REQUIRED,
  /** A combination that cannot mean anything. */
  CLI_OPTIONS_ERR_INCOMPATIBLE,
};

/**
 * The parsed command line.
 *
 * Defaults are applied by cli_options_parse, so a caller never has to know
 * which fields have one. The three credentials have no default on purpose:
 * a CLI that invents a project to talk to is worse than one that refuses.
 */
struct cli_options {
  const char *project_id;
  const char *project_api_key;
  const char *os_base_url;
  const char *stream_path;
  /** Mounted as kit.<name>, and used as this run's call id. */
  const char *name;
  const char *mic_wav;
  const char *utterance_dir;
  const char *speaker_wav;
  const char *report_json;
  /** Minutes of unattended conversation; 0 means "just stay mounted". */
  double converse_minutes;
  /**
   * Wall-clock limit for an interactive session; 0 means "until told to stop".
   *
   * Deliberately not the same field as `converse_minutes`: one bounds a driver
   * that takes turns by itself, the other bounds a person sitting at a
   * terminal, and a single field would make the two indistinguishable at every
   * site that has to ask which kind of run this is.
   */
  double minutes;
  /** Every Nth utterance forces a back-office consultation; 0 disables. */
  uint32_t back_office_every;
  /**
   * Frames per second the modelled converter consumes; 0 leaves the speaker
   * the file it has always been. See cli_paced_sink.h for what turning it on
   * makes reachable, and adversarial-seams.md for why it exists.
   */
  uint32_t speaker_pace_fps;
  bool live_audio;
  /** Captures from this machine's default input device instead of a WAV. */
  bool live_mic;
  /** Hold SPACE to talk, release to send, q to hang up. */
  bool push_to_talk;
  /** Skips TLS certificate verification. Off unless explicitly asked for. */
  bool insecure;
};

/** Human-readable status name, for logs and test failure messages. */
const char *cli_options_status_name(enum cli_options_status status);

/** Write the full flag reference, one line each. */
void cli_options_print_help(FILE *out);

/**
 * Parse `argv`, then fill unset values from the environment, then apply
 * defaults, then check what is required.
 *
 * `problem` receives a short human-readable description of the first fault
 * found — the offending flag, usually — and is set to the empty string on
 * success. It is never left uninitialised, so a caller can print it whatever
 * the status.
 */
enum cli_options_status cli_options_parse(
    struct cli_options *out,
    int argc,
    char **argv,
    char *problem,
    size_t problem_bytes);

#endif /* ITERATE_KIT_CLI_OPTIONS_H */
