/* keyboard.c: raw-mode stdin as the board's button. */
#include "keyboard.h"

#include <fcntl.h>
#include <stdlib.h>
#include <termios.h>
#include <unistd.h>

static struct termios saved;
static int saved_flags;
static bool open_now;

static void restore(void) {
  if (!open_now) return;
  (void)tcsetattr(STDIN_FILENO, TCSANOW, &saved);
  (void)fcntl(STDIN_FILENO, F_SETFL, saved_flags);
  open_now = false;
}

bool mac_keyboard_open(void) {
  struct termios raw;
  if (isatty(STDIN_FILENO) == 0) return false;
  if (tcgetattr(STDIN_FILENO, &saved) != 0) return false;
  saved_flags = fcntl(STDIN_FILENO, F_GETFL, 0);
  if (saved_flags < 0) return false;
  raw = saved;
  raw.c_lflag &= (tcflag_t)~(ICANON | ECHO);
  raw.c_cc[VMIN] = 0;
  raw.c_cc[VTIME] = 0;
  if (tcsetattr(STDIN_FILENO, TCSANOW, &raw) != 0 ||
      fcntl(STDIN_FILENO, F_SETFL, saved_flags | O_NONBLOCK) != 0) {
    (void)tcsetattr(STDIN_FILENO, TCSANOW, &saved);
    return false;
  }
  open_now = true;
  (void)atexit(restore);
  return true;
}

enum mac_keyboard_event mac_keyboard_poll(void) {
  unsigned char keys[16];
  ssize_t count;
  enum mac_keyboard_event event = MAC_KEYBOARD_NONE;
  if (!open_now) return MAC_KEYBOARD_NONE;
  count = read(STDIN_FILENO, keys, sizeof(keys));
  for (ssize_t index = 0; index < count; ++index) {
    const unsigned char key = keys[index];
    if (key == 'q' || key == 'Q' || key == 3U) return MAC_KEYBOARD_QUIT;
    if (key == ' ' || key == '\n' || key == '\r') event = MAC_KEYBOARD_PRESS;
  }
  return event;
}

void mac_keyboard_close(void) { restore(); }
