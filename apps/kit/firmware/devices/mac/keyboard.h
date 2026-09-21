#ifndef ITERATE_KIT_MAC_KEYBOARD_H
#define ITERATE_KIT_MAC_KEYBOARD_H

#include <stdbool.h>

/* The button, on a laptop: space or return is a press, q (or Ctrl-C) leaves.
 * Raw mode on stdin while open; the terminal is restored on close and on exit. */

enum mac_keyboard_event {
  MAC_KEYBOARD_NONE = 0,
  MAC_KEYBOARD_PRESS,
  MAC_KEYBOARD_QUIT,
};

/** False when stdin is not a terminal; the device then only takes remote presses. */
bool mac_keyboard_open(void);
enum mac_keyboard_event mac_keyboard_poll(void);
void mac_keyboard_close(void);

#endif
