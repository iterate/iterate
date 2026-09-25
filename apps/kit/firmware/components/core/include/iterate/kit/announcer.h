#ifndef ITERATE_KIT_ANNOUNCER_H
#define ITERATE_KIT_ANNOUNCER_H

#include <stdbool.h>
#include <stdint.h>

#include "iterate/kit/wifi_status.h"

#ifdef __cplusplus
extern "C" {
#endif

/*
 * WHAT THE BOARD SAYS OUT LOUD, AND WHEN.
 *
 * A board that is offline or still connecting is otherwise silent, and most
 * have no screen: nobody can tell "joining Wi-Fi" from "wrong password" from
 * "iterate refused the key". The announcer turns connection facts and control
 * edges into phrases; the voice loop renders and plays them
 * (iterate/kit/tinyvoice.h). Pure policy: no clock, audio or platform of its own.
 *
 * - A boot someone caused (power, the reset button, USB) is narrated until it
 *   connects. Each connection state that lasts a second is said, once, for at
 *   most three minutes. A boot nobody watched (an update, a crash, a watchdog)
 *   is not: no singing at 3 am.
 * - Once connected, drops are silent.
 * - A wake word gets "Hello!" when connected, and the reason it cannot talk
 *   when not. So does a button press while not connected.
 * - One phrase at a time, latest wins: the loop takes the next phrase only when
 *   its speaker is free, so a phrase never cuts off another and a state that
 *   went stale while waiting is never said.
 */

enum iterate_kit_announcement {
  ITERATE_KIT_ANNOUNCEMENT_NONE = 0,
  ITERATE_KIT_ANNOUNCEMENT_CONNECTING_TO_WIFI,
  ITERATE_KIT_ANNOUNCEMENT_WIFI_PASSWORD_REJECTED,
  ITERATE_KIT_ANNOUNCEMENT_WIFI_NOT_FOUND,
  ITERATE_KIT_ANNOUNCEMENT_CONNECTING_TO_ITERATE,
  ITERATE_KIT_ANNOUNCEMENT_ITERATE_UNREACHABLE,
  ITERATE_KIT_ANNOUNCEMENT_KEY_REFUSED,
  ITERATE_KIT_ANNOUNCEMENT_READY,
  ITERATE_KIT_ANNOUNCEMENT_HELLO,
  ITERATE_KIT_ANNOUNCEMENT_COUNT,
};

enum {
  /** A state is narrated once it has lasted this long, so a quick hop is skipped. */
  ITERATE_KIT_ANNOUNCER_SETTLE_MS = 1000,
  /** Wi-Fi joined but iterate not reached for this long is "can't reach". */
  ITERATE_KIT_ANNOUNCER_UNREACHABLE_AFTER_MS = 20000,
  /** Narration ends here even if the board never connects. */
  ITERATE_KIT_ANNOUNCER_NARRATION_MS = 180000,
};

/** One step's facts. The two presses are edges: true on the step they happen. */
struct iterate_kit_announcer_input {
  uint64_t now_ms;
  enum iterate_kit_wifi_status wifi;
  /** iterate refused the device's key (401/403 on the upgrade) and it still stands. */
  bool key_refused;
  /** The project is mounted: the board can take a call. */
  bool connected;
  /** The wake word started a session. */
  bool woken;
  /** A button press started a session. */
  bool pressed;
};

struct iterate_kit_announcer {
  bool narrating;
  uint64_t narration_ends_at_ms;
  /** Bit per announcement already narrated this boot. */
  uint32_t narrated;
  enum iterate_kit_announcement state;
  uint64_t state_since_ms;
  bool wifi_was_joined;
  uint64_t wifi_joined_at_ms;
  enum iterate_kit_announcement pending;
};

/** `narrate`: a person probably caused this boot (iterate/kit/platforms/reset_reason.h). */
void iterate_kit_announcer_init(
    struct iterate_kit_announcer *announcer, bool narrate, uint64_t now_ms);

void iterate_kit_announcer_step(
    struct iterate_kit_announcer *announcer,
    const struct iterate_kit_announcer_input *input);

/**
 * The phrase to say now, or NONE; taking it clears it. Call only when the
 * speaker is free to start one.
 */
enum iterate_kit_announcement iterate_kit_announcer_take(
    struct iterate_kit_announcer *announcer);

/** The phrase as tinyvoice phonemes. */
const char *iterate_kit_announcement_script(enum iterate_kit_announcement announcement);

/** The phrase in English, for logs and health. */
const char *iterate_kit_announcement_text(enum iterate_kit_announcement announcement);

#ifdef __cplusplus
}
#endif

#endif /* ITERATE_KIT_ANNOUNCER_H */
