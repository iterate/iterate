/* cli_keyboard.c: owns terminal raw mode and the one explicit quit key. */

#include <assert.h>
#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>

#include "cli_keyboard.h"

enum { CLI_KEYBOARD_QUIT_LOWER = 'q', CLI_KEYBOARD_QUIT_UPPER = 'Q' };

static struct termios cli_keyboard_saved_termios;
static int cli_keyboard_saved_flags;
static volatile sig_atomic_t cli_keyboard_armed;

static enum cli_keyboard_status cli_keyboard_enter_raw(void)
{
  if (tcgetattr(STDIN_FILENO, &cli_keyboard_saved_termios) != 0) {
    return CLI_KEYBOARD_ERR_PLATFORM;
  }
  cli_keyboard_saved_flags = fcntl(STDIN_FILENO, F_GETFL, 0);
  if (cli_keyboard_saved_flags < 0) return CLI_KEYBOARD_ERR_PLATFORM;
  struct termios raw = cli_keyboard_saved_termios;
  raw.c_lflag &= (tcflag_t)~(ICANON | ECHO);
  raw.c_cc[VMIN] = 0;
  raw.c_cc[VTIME] = 0;
  if (tcsetattr(STDIN_FILENO, TCSANOW, &raw) != 0 ||
      fcntl(STDIN_FILENO, F_SETFL, cli_keyboard_saved_flags | O_NONBLOCK) != 0) {
    (void)tcsetattr(STDIN_FILENO, TCSANOW, &cli_keyboard_saved_termios);
    return CLI_KEYBOARD_ERR_PLATFORM;
  }
  cli_keyboard_armed = 1;
  return CLI_KEYBOARD_OK;
}

const char *cli_keyboard_status_name(enum cli_keyboard_status status)
{
  switch (status) {
    case CLI_KEYBOARD_OK: return "ok";
    case CLI_KEYBOARD_ERR_ARG: return "bad-argument";
    case CLI_KEYBOARD_ERR_NOT_A_TERMINAL: return "not-a-terminal";
    case CLI_KEYBOARD_ERR_PLATFORM: return "termios";
    default: return "unknown";
  }
}

const char *cli_keyboard_event_name(enum cli_keyboard_event event)
{
  switch (event) {
    case CLI_KEYBOARD_NONE: return "none";
    case CLI_KEYBOARD_HANG_UP: return "hang-up";
    default: return "unknown";
  }
}

enum cli_keyboard_status cli_keyboard_open(struct cli_keyboard *keyboard)
{
  if (keyboard == NULL) return CLI_KEYBOARD_ERR_ARG;
  memset(keyboard, 0, sizeof(*keyboard));
  if (isatty(STDIN_FILENO) == 0) return CLI_KEYBOARD_ERR_NOT_A_TERMINAL;
  const enum cli_keyboard_status status = cli_keyboard_enter_raw();
  if (status != CLI_KEYBOARD_OK) return status;
  (void)atexit(cli_keyboard_restore_terminal);
  keyboard->raw = true;
  return CLI_KEYBOARD_OK;
}

enum cli_keyboard_status cli_keyboard_feed(
    struct cli_keyboard *keyboard, const uint8_t *keys, size_t count,
    enum cli_keyboard_event *out)
{
  if (keyboard == NULL || out == NULL || (keys == NULL && count != 0U)) {
    return CLI_KEYBOARD_ERR_ARG;
  }
  *out = CLI_KEYBOARD_NONE;
  for (size_t index = 0U; index < count; ++index) {
    if (keys[index] == CLI_KEYBOARD_QUIT_LOWER ||
        keys[index] == CLI_KEYBOARD_QUIT_UPPER) {
      ++keyboard->hang_ups;
      *out = CLI_KEYBOARD_HANG_UP;
      return CLI_KEYBOARD_OK;
    }
  }
  return CLI_KEYBOARD_OK;
}

enum cli_keyboard_status cli_keyboard_poll(
    struct cli_keyboard *keyboard, enum cli_keyboard_event *out)
{
  if (keyboard == NULL || out == NULL) return CLI_KEYBOARD_ERR_ARG;
  uint8_t keys[CLI_KEYBOARD_READ_BYTES];
  const ssize_t taken = read(STDIN_FILENO, keys, sizeof(keys));
  return cli_keyboard_feed(
      keyboard, keys, taken > 0 ? (size_t)taken : 0U, out);
}

void cli_keyboard_close(struct cli_keyboard *keyboard)
{
  cli_keyboard_restore_terminal();
  if (keyboard != NULL) keyboard->raw = false;
}

void cli_keyboard_restore_terminal(void)
{
  if (cli_keyboard_armed == 0) return;
  cli_keyboard_armed = 0;
  (void)tcsetattr(STDIN_FILENO, TCSANOW, &cli_keyboard_saved_termios);
  (void)fcntl(STDIN_FILENO, F_SETFL, cli_keyboard_saved_flags);
}
