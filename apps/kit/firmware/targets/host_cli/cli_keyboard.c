/* cli_keyboard.c: owns the terminal's raw mode and the hold inference. */

#include <assert.h>
#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <unistd.h>

#include "cli_keyboard.h"

enum {
  CLI_KEYBOARD_SPACE = 0x20,
  CLI_KEYBOARD_QUIT_LOWER = 'q',
  CLI_KEYBOARD_QUIT_UPPER = 'Q',
};

/*
 * The terminal this process found, and whether it still owes it a restore.
 *
 * File scope rather than a field, because the restore must be reachable from
 * a signal handler, which cannot be given a pointer. `armed` is sig_atomic_t
 * for the same reason: it is read and written from a handler.
 */
static struct termios cli_keyboard_saved_termios;
static int cli_keyboard_saved_flags;
static volatile sig_atomic_t cli_keyboard_armed;

/* Applies one byte to the hold belief. Returns the event it forces, if any. */
static enum cli_keyboard_event cli_keyboard_apply(
    struct cli_keyboard *keyboard, uint8_t key, uint64_t now_ms);

/* Turns off canonical input and echo, leaving signals and output alone. */
static enum cli_keyboard_status cli_keyboard_enter_raw(void);

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
    case CLI_KEYBOARD_TALK_START: return "talk-start";
    case CLI_KEYBOARD_TALK_STOP: return "talk-stop";
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
  /*
   * atexit covers the paths that neither close nor a handler reaches: a
   * failed assertion, or any exit() a future caller adds. Registering it more
   * than once would be harmless, but this only ever runs once per process.
   */
  (void)atexit(cli_keyboard_restore_terminal);
  keyboard->raw = true;
  return CLI_KEYBOARD_OK;
}

enum cli_keyboard_status cli_keyboard_feed(
    struct cli_keyboard *keyboard,
    const uint8_t *keys,
    size_t count,
    uint64_t now_ms,
    enum cli_keyboard_event *out)
{
  if (keyboard == NULL || out == NULL || (keys == NULL && count != 0U)) {
    return CLI_KEYBOARD_ERR_ARG;
  }
  *out = CLI_KEYBOARD_NONE;
  for (size_t index = 0U; index < count; ++index) {
    const enum cli_keyboard_event event =
        cli_keyboard_apply(keyboard, keys[index], now_ms);
    /* A hang-up outranks anything else in the same read and is never lost. */
    if (event == CLI_KEYBOARD_HANG_UP) {
      *out = event;
      return CLI_KEYBOARD_OK;
    }
    if (event != CLI_KEYBOARD_NONE) *out = event;
  }
  if (*out != CLI_KEYBOARD_NONE) return CLI_KEYBOARD_OK;
  if (!keyboard->holding) return CLI_KEYBOARD_OK;
  if (now_ms - keyboard->last_space_ms < CLI_KEYBOARD_HOLD_TIMEOUT_MS) {
    return CLI_KEYBOARD_OK;
  }
  keyboard->holding = false;
  *out = CLI_KEYBOARD_TALK_STOP;
  return CLI_KEYBOARD_OK;
}

enum cli_keyboard_status cli_keyboard_poll(
    struct cli_keyboard *keyboard,
    uint64_t now_ms,
    enum cli_keyboard_event *out)
{
  if (keyboard == NULL || out == NULL) return CLI_KEYBOARD_ERR_ARG;
  uint8_t keys[CLI_KEYBOARD_READ_BYTES];
  const ssize_t taken = read(STDIN_FILENO, keys, sizeof(keys));
  const size_t count = taken > 0 ? (size_t)taken : 0U;
  return cli_keyboard_feed(keyboard, keys, count, now_ms, out);
}

void cli_keyboard_close(struct cli_keyboard *keyboard)
{
  cli_keyboard_restore_terminal();
  if (keyboard == NULL) return;
  keyboard->raw = false;
  keyboard->holding = false;
}

void cli_keyboard_restore_terminal(void)
{
  if (cli_keyboard_armed == 0) return;
  cli_keyboard_armed = 0;
  (void)tcsetattr(STDIN_FILENO, TCSANOW, &cli_keyboard_saved_termios);
  (void)fcntl(STDIN_FILENO, F_SETFL, cli_keyboard_saved_flags);
}

static enum cli_keyboard_event cli_keyboard_apply(
    struct cli_keyboard *keyboard, uint8_t key, uint64_t now_ms)
{
  assert(keyboard != NULL);
  if (key == CLI_KEYBOARD_QUIT_LOWER || key == CLI_KEYBOARD_QUIT_UPPER) {
    keyboard->holding = false;
    ++keyboard->hang_ups;
    return CLI_KEYBOARD_HANG_UP;
  }
  if (key != CLI_KEYBOARD_SPACE) return CLI_KEYBOARD_NONE;
  keyboard->last_space_ms = now_ms;
  /* Repeats while held are the evidence the key is still down, not new turns. */
  if (keyboard->holding) return CLI_KEYBOARD_NONE;
  keyboard->holding = true;
  ++keyboard->turns_started;
  return CLI_KEYBOARD_TALK_START;
}

static enum cli_keyboard_status cli_keyboard_enter_raw(void)
{
  if (tcgetattr(STDIN_FILENO, &cli_keyboard_saved_termios) != 0) {
    return CLI_KEYBOARD_ERR_PLATFORM;
  }
  cli_keyboard_saved_flags = fcntl(STDIN_FILENO, F_GETFL, 0);
  if (cli_keyboard_saved_flags < 0) return CLI_KEYBOARD_ERR_PLATFORM;
  struct termios raw = cli_keyboard_saved_termios;
  /*
   * ICANON and ECHO only. ISIG stays on so Ctrl-C is still a signal, and the
   * output flags are left alone so the diagnostic lines this process writes
   * keep their line endings.
   */
  raw.c_lflag &= (tcflag_t)~(ICANON | ECHO);
  raw.c_cc[VMIN] = 0;
  raw.c_cc[VTIME] = 0;
  if (tcsetattr(STDIN_FILENO, TCSANOW, &raw) != 0) {
    return CLI_KEYBOARD_ERR_PLATFORM;
  }
  /*
   * Non-blocking, because the cooperative loop has audio to move and cannot
   * wait on a key. The flag lives on the shared file description, so leaving
   * it set would hand the shell a non-blocking stdin — hence it is saved and
   * restored alongside the terminal attributes.
   */
  if (fcntl(STDIN_FILENO, F_SETFL, cli_keyboard_saved_flags | O_NONBLOCK) !=
      0) {
    (void)tcsetattr(STDIN_FILENO, TCSANOW, &cli_keyboard_saved_termios);
    return CLI_KEYBOARD_ERR_PLATFORM;
  }
  cli_keyboard_armed = 1;
  return CLI_KEYBOARD_OK;
}
