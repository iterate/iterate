#ifndef ITERATE_KIT_CLI_KEYBOARD_H
#define ITERATE_KIT_CLI_KEYBOARD_H

/*
 * cli_keyboard: q ends an interactive host session. It owns raw-mode setup
 * and restoration; no key participates in capture or turn control.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum { CLI_KEYBOARD_READ_BYTES = 64 };

/** One status per terminal setup failure. */
enum cli_keyboard_status {
  CLI_KEYBOARD_OK = 0,
  CLI_KEYBOARD_ERR_ARG,
  /** stdin is a pipe or a file. */
  CLI_KEYBOARD_ERR_NOT_A_TERMINAL,
  CLI_KEYBOARD_ERR_PLATFORM,
};

/** What the person did, at most one per poll. */
enum cli_keyboard_event {
  CLI_KEYBOARD_NONE = 0,
  CLI_KEYBOARD_HANG_UP,
};

/** Caller-owned terminal state. */
struct cli_keyboard {
  bool raw;
  uint32_t hang_ups;
};

/** Human-readable status name, for logs and test failure messages. */
const char *cli_keyboard_status_name(enum cli_keyboard_status status);

/** Human-readable event name, for the session log. */
const char *cli_keyboard_event_name(enum cli_keyboard_event event);

/**
 * Put the terminal into non-canonical, non-echoing, non-blocking mode and
 * arm the restore. Refuses a stdin that is not a terminal rather than
 * silently never producing an event. Pairs with cli_keyboard_close.
 */
enum cli_keyboard_status cli_keyboard_open(struct cli_keyboard *keyboard);

/**
 * Apply bytes read at now_ms. Only q produces an event.
 */
enum cli_keyboard_status cli_keyboard_feed(
    struct cli_keyboard *keyboard,
    const uint8_t *keys,
    size_t count,
    uint64_t now_ms,
    enum cli_keyboard_event *out);

/** Read whatever is waiting on stdin and feed it. Never blocks. */
enum cli_keyboard_status cli_keyboard_poll(
    struct cli_keyboard *keyboard,
    uint64_t now_ms,
    enum cli_keyboard_event *out);

/** Restore the terminal and forget the key state. Safe if never opened. */
void cli_keyboard_close(struct cli_keyboard *keyboard);

/**
 * Put the terminal back exactly as it was found.
 *
 * Async-signal-safe — tcsetattr and fcntl both are — and idempotent, so it is
 * callable from a signal handler, from atexit, and from close, which between
 * them cover every way this process can end.
 */
void cli_keyboard_restore_terminal(void);

#endif /* ITERATE_KIT_CLI_KEYBOARD_H */
