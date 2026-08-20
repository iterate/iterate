/* cli_screen.c: builds the session frame and writes it when it changes. */

#include <assert.h>
#include <inttypes.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#include "cli_screen.h"

/*
 * ANSI, and only the four sequences that cannot be done without.
 *
 * HOME then CLEAR-TO-END-OF-LINE per line then CLEAR-BELOW, rather than a
 * clear-screen followed by a redraw. Clearing first leaves the terminal blank
 * for the duration of the write, which at any redraw rate a person would
 * notice is a flicker; overwriting in place never shows an empty frame.
 */
#define CLI_SCREEN_HOME "\033[H"
#define CLI_SCREEN_CLEAR_EOL "\033[K"
#define CLI_SCREEN_CLEAR_BELOW "\033[J"
#define CLI_SCREEN_HIDE_CURSOR "\033[?25l"
#define CLI_SCREEN_SHOW_CURSOR "\033[?25h"
#define CLI_SCREEN_DIM "\033[2m"
#define CLI_SCREEN_BOLD "\033[1m"
#define CLI_SCREEN_RED "\033[31m"
#define CLI_SCREEN_GREEN "\033[32m"
#define CLI_SCREEN_YELLOW "\033[33m"
#define CLI_SCREEN_RESET "\033[0m"

static struct cli_screen *cli_screen_current;

/* Appends one printf-shaped line, terminated and cleared to end of line. */
static void cli_screen_line(
    char *frame, size_t capacity, size_t *length, const char *format, ...)
#if defined(__GNUC__)
    __attribute__((format(printf, 4, 5)))
#endif
    ;

/* Renders "4.1s" style ages, or "never" for an epoch of zero. */
static void cli_screen_age(
    char *out, size_t capacity, uint64_t at_ms, uint64_t now_ms);

void cli_screen_enable(struct cli_screen *screen, bool enabled)
{
  if (screen == NULL) return;
  screen->enabled = enabled;
  if (enabled) {
    cli_screen_current = screen;
    (void)fputs(CLI_SCREEN_HIDE_CURSOR, stderr);
    return;
  }
  if (cli_screen_current == screen) cli_screen_current = NULL;
}

struct cli_screen *cli_screen_active(void)
{
  return cli_screen_current;
}

void cli_screen_note(
    struct cli_screen *screen, const char *level, const char *text)
{
  if (screen == NULL || !screen->enabled || text == NULL) return;
  char *slot = screen->log[screen->log_write];
  (void)snprintf(
      slot, CLI_SCREEN_LINE_BYTES, "%-5s %s",
      level == NULL ? "info" : level, text);
  screen->log_write = (screen->log_write + 1U) % CLI_SCREEN_LOG_LINES;
  if (screen->log_used < CLI_SCREEN_LOG_LINES) ++screen->log_used;
}

void cli_screen_draw(
    struct cli_screen *screen, const struct cli_screen_state *state)
{
  char frame[CLI_SCREEN_FRAME_BYTES];
  size_t length = 0U;
  char api_age[24];
  char call_age[24];
  if (screen == NULL || !screen->enabled || state == NULL) return;

  const bool api_up = state->api_connected_at_ms != 0U;
  const bool call_up = state->call_established_at_ms != 0U;
  cli_screen_age(api_age, sizeof(api_age), state->api_connected_at_ms,
                 state->elapsed_ms);
  cli_screen_age(call_age, sizeof(call_age), state->call_established_at_ms,
                 state->elapsed_ms);

  cli_screen_line(
      frame, sizeof(frame), &length, "%s%s%s  %s%s%s",
      CLI_SCREEN_BOLD, "iterate-kit-cli", CLI_SCREEN_RESET,
      CLI_SCREEN_DIM,
      state->stream_path == NULL ? "" : state->stream_path,
      CLI_SCREEN_RESET);
  cli_screen_line(frame, sizeof(frame), &length, "%s", "");

  /*
   * TWO LIGHTS, AND THE SECOND CANNOT BE GREEN WITHOUT THE FIRST. Neither lit
   * means nothing has reached /api; one means the stream is mounted and the
   * provider has not accepted a call; two means a call is up and speech has
   * somewhere to go. A pending call is drawn amber rather than green so the
   * seconds between asking and being accepted are visible — those seconds are
   * where a press used to disappear.
   */
  const char *api_colour = api_up ? CLI_SCREEN_GREEN : CLI_SCREEN_RED;
  const char *call_colour = call_up
      ? CLI_SCREEN_GREEN
      : (state->call_pending ? CLI_SCREEN_YELLOW : CLI_SCREEN_RED);
  cli_screen_line(
      frame, sizeof(frame), &length,
      "  %s●%s%s●%s   api %-10s  call %-10s  %s%s%s",
      api_colour, CLI_SCREEN_RESET, call_colour, CLI_SCREEN_RESET,
      api_age, call_age,
      CLI_SCREEN_DIM,
      api_up ? "" : (state->transport_state == NULL ? "" : state->transport_state),
      CLI_SCREEN_RESET);
  cli_screen_line(frame, sizeof(frame), &length, "%s", "");

  /*
   * THE KEY, AS THIS PROCESS SEES IT. Held is the raw fact from the keyboard
   * and talking is what the loop did about it; they are drawn separately
   * because the whole of the reported defect was the gap between them.
   */
  cli_screen_line(
      frame, sizeof(frame), &length, "  %s%s%s   %s%s%s   %s%s%s",
      state->space_held ? CLI_SCREEN_BOLD : CLI_SCREEN_DIM,
      state->space_held ? "SPACE HELD" : "space     ", CLI_SCREEN_RESET,
      state->talking ? CLI_SCREEN_BOLD CLI_SCREEN_GREEN : CLI_SCREEN_DIM,
      state->talking ? "TALKING" : "       ", CLI_SCREEN_RESET,
      state->flushing ? CLI_SCREEN_BOLD CLI_SCREEN_YELLOW : CLI_SCREEN_DIM,
      state->flushing ? "FLUSHING" : "        ", CLI_SCREEN_RESET);
  cli_screen_line(frame, sizeof(frame), &length, "%s", "");

  cli_screen_line(
      frame, sizeof(frame), &length,
      "  mic   captured %-7u held %-6u sent %-7u lost %u",
      state->mic_captured, state->mic_held, state->mic_sent, state->mic_lost);
  cli_screen_line(
      frame, sizeof(frame), &length,
      "  spk   received %-6u played %-5u conceal %-4u under %-4u drop %-4u starve %-4u skip %-4u ring %ums",
      state->spk_received, state->spk_played, state->spk_conceal,
      state->spk_underruns, state->spk_dropped, state->spk_starved,
      state->spk_catchup, state->spk_ring_ms);
  if (state->turn_release_to_commit_ms != 0U ||
      state->turn_commit_to_audio_ms != 0U) {
    cli_screen_line(
        frame, sizeof(frame), &length,
        "  turn  release->commit %-5ums commit->audio %-5ums total %ums",
        state->turn_release_to_commit_ms, state->turn_commit_to_audio_ms,
        state->turn_release_to_commit_ms + state->turn_commit_to_audio_ms);
  }
  cli_screen_line(
      frame, sizeof(frame), &length,
      "  net   outbox %u/%u   loops %u   up %" PRIu64 "s",
      state->outbox_used, state->outbox_slots, state->loops,
      state->elapsed_ms / 1000U);
  cli_screen_line(frame, sizeof(frame), &length, "%s", "");

  for (size_t index = 0U; index < screen->log_used; ++index) {
    const size_t slot = (screen->log_write + CLI_SCREEN_LOG_LINES -
                         screen->log_used + index) % CLI_SCREEN_LOG_LINES;
    cli_screen_line(
        frame, sizeof(frame), &length, "  %s%s%s",
        CLI_SCREEN_DIM, screen->log[slot], CLI_SCREEN_RESET);
  }

  /*
   * AN UNCHANGED FRAME IS NOT WRITTEN. The loop runs at a few hundred hertz
   * and almost every pass changes nothing a person could see; writing anyway
   * would make the terminal the most expensive thing in the process and would
   * fight the scrollback of anybody who has selected text.
   */
  if (length == screen->drawn_length &&
      memcmp(frame, screen->drawn, length) == 0) {
    return;
  }
  (void)fwrite(CLI_SCREEN_HOME, 1U, strlen(CLI_SCREEN_HOME), stderr);
  (void)fwrite(frame, 1U, length, stderr);
  (void)fwrite(
      CLI_SCREEN_CLEAR_BELOW, 1U, strlen(CLI_SCREEN_CLEAR_BELOW), stderr);
  (void)fflush(stderr);
  memcpy(screen->drawn, frame, length);
  screen->drawn_length = length;
}

void cli_screen_finish(struct cli_screen *screen)
{
  if (screen == NULL || !screen->enabled) return;
  (void)fputs(CLI_SCREEN_SHOW_CURSOR "\n", stderr);
  (void)fflush(stderr);
  cli_screen_enable(screen, false);
}

static void cli_screen_line(
    char *frame, size_t capacity, size_t *length, const char *format, ...)
{
  assert(frame != NULL && length != NULL && format != NULL);
  if (*length >= capacity) return;
  va_list args;
  va_start(args, format);
  const int written = vsnprintf(
      frame + *length, capacity - *length, format, args);
  va_end(args);
  if (written < 0) return;
  *length += (size_t)written < capacity - *length
      ? (size_t)written
      : capacity - *length - 1U;
  const char *tail = CLI_SCREEN_CLEAR_EOL "\r\n";
  const size_t tail_length = strlen(tail);
  if (*length + tail_length >= capacity) return;
  memcpy(frame + *length, tail, tail_length);
  *length += tail_length;
}

static void cli_screen_age(
    char *out, size_t capacity, uint64_t at_ms, uint64_t now_ms)
{
  assert(out != NULL);
  if (at_ms == 0U) {
    (void)snprintf(out, capacity, "-");
    return;
  }
  const uint64_t age = now_ms > at_ms ? now_ms - at_ms : 0U;
  (void)snprintf(out, capacity, "%" PRIu64 ".%01" PRIu64 "s ago",
                 age / 1000U, (age % 1000U) / 100U);
}
