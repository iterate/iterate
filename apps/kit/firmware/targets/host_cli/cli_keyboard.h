#ifndef ITERATE_KIT_CLI_KEYBOARD_H
#define ITERATE_KIT_CLI_KEYBOARD_H

/*
 * cli_keyboard: hold SPACE to talk, release to send, q to hang up.
 *
 * ORIGINATING FAILURE. The device has a physical talk button. The host target
 * had no way to press one, so the only turns it could take were scripted, and
 * the questions that need a person — did it interrupt me, did the first word
 * survive, does it feel slow — could not be asked at all without flashing a
 * board first.
 *
 * THERE IS NO KEY-UP EVENT. A terminal delivers characters, not key state:
 * macOS sends a byte when SPACE goes down and then, after the system's
 * "delay until repeat", a stream of repeats while it is held. Release is
 * therefore not an event but an ABSENCE — repeats stop — and the only way to
 * detect it is a timeout. That makes CLI_KEYBOARD_HOLD_TIMEOUT_MS a guess
 * about somebody else's keyboard settings, which is why it is a named
 * constant with its arithmetic written down rather than a literal.
 *
 * TERMINAL OWNERSHIP. Reading keys one at a time needs the line discipline
 * off, and a CLI that leaves a terminal in raw mode when it dies is a CLI
 * nobody runs twice. The saved terminal state is therefore FILE SCOPE, not a
 * field of the handle: a signal handler cannot be handed a pointer, and the
 * restore has to work from one. ISIG is deliberately left on, so Ctrl-C still
 * raises SIGINT rather than arriving as a byte nobody reads.
 *
 * The policy — which bytes mean what, and when an absence means release — is
 * cli_keyboard_feed, which touches no terminal and no clock. That is what
 * makes the inference testable without a keyboard.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

enum {
  /*
   * How long after the last SPACE the turn is considered released.
   *
   * This must EXCEED the system's delay until the first auto-repeat, or a
   * held key is indistinguishable from a tap and one held sentence is chopped
   * into a series of quarter-second turns. macOS defaults InitialKeyRepeat to
   * 25 ticks of 15 ms — 375 ms — and lets it be configured slower still; the
   * repeats that follow are ~90 ms apart and never the problem. 700 ms clears
   * the default and the settings either side of it.
   *
   * The cost of being generous is trailing room tone at the end of a turn,
   * which the provider's own endpointing discards. The cost of being mean is
   * a feature that does not work, so this errs long. If a hold still breaks
   * into fragments on somebody's machine, this constant is the fix.
   */
  CLI_KEYBOARD_HOLD_TIMEOUT_MS = 700,
  /* One read per loop iteration; a burst of repeats is a handful of bytes. */
  CLI_KEYBOARD_READ_BYTES = 64,
};

/** One status per way the terminal can refuse to become a talk button. */
enum cli_keyboard_status {
  CLI_KEYBOARD_OK = 0,
  CLI_KEYBOARD_ERR_ARG,
  /** stdin is a pipe or a file. Push-to-talk needs somebody to push. */
  CLI_KEYBOARD_ERR_NOT_A_TERMINAL,
  CLI_KEYBOARD_ERR_PLATFORM,
};

/** What the person did, at most one per poll. */
enum cli_keyboard_event {
  CLI_KEYBOARD_NONE = 0,
  CLI_KEYBOARD_TALK_START,
  /** Inferred from silence, never observed; see the timeout above. */
  CLI_KEYBOARD_TALK_STOP,
  CLI_KEYBOARD_HANG_UP,
};

/**
 * Caller-owned key state.
 *
 * `holding` is this module's belief about a key nobody can observe, so it is
 * named for a belief. The counters are what a session log needs to explain a
 * turn that never happened.
 */
struct cli_keyboard {
  bool raw;
  bool holding;
  uint64_t last_space_ms;
  uint32_t turns_started;
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
 * Apply `count` bytes read at `now_ms`, then decide whether the absence of
 * further bytes has lasted long enough to be a release.
 *
 * Touches no terminal and reads no clock, so the inference can be driven from
 * a test. At most one event per call, and a hang-up seen in the same read as
 * a space wins: hanging up is never something anybody wants to press twice.
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
