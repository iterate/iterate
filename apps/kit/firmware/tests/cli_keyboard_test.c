#include "cli_keyboard.h"

#include <assert.h>
#include <string.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

static struct cli_keyboard keyboard;

static enum cli_keyboard_event feed(const uint8_t *keys, size_t count)
{
  enum cli_keyboard_event event = CLI_KEYBOARD_NONE;
  assert(cli_keyboard_feed(&keyboard, keys, count, &event) ==
         CLI_KEYBOARD_OK);
  return event;
}

static void only_q_ends_the_session(void)
{
  memset(&keyboard, 0, sizeof(keyboard));
  const uint8_t noise[] = {' ', 'x', '\n'};
  assert(feed(noise, sizeof(noise)) == CLI_KEYBOARD_NONE);
  const uint8_t quit = 'q';
  assert(feed(&quit, 1U) == CLI_KEYBOARD_HANG_UP);
  assert(keyboard.hang_ups == 1U);
}

static void a_hang_up_wins_in_a_mixed_read(void)
{
  memset(&keyboard, 0, sizeof(keyboard));
  const uint8_t keys[] = {'x', 'q', 'Q'};
  assert(feed(keys, sizeof(keys)) == CLI_KEYBOARD_HANG_UP);
  assert(keyboard.hang_ups == 1U);
}

static void unusable_arguments_are_refused(void)
{
  enum cli_keyboard_event event;
  assert(cli_keyboard_feed(NULL, NULL, 0U, &event) ==
         CLI_KEYBOARD_ERR_ARG);
  assert(cli_keyboard_feed(&keyboard, NULL, 1U, &event) ==
         CLI_KEYBOARD_ERR_ARG);
}

int main(void)
{
  only_q_ends_the_session();
  a_hang_up_wins_in_a_mixed_read();
  unusable_arguments_are_refused();
  return 0;
}
