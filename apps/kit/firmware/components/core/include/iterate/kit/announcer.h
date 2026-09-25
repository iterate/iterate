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
 *   when not. So does a button press while not connected. Only while the
 *   speaker is free, so the answer starts at once; otherwise the board chimes.
 * - Narration waits while a session is open or opening: the microphone is live.
 * - One phrase at a time: the loop takes the next phrase only when its speaker
 *   is free, so a phrase never cuts off another. A phrase waiting for the
 *   speaker is about the state it was queued for: narration of a state that
 *   has passed is dropped, and an answer follows the state.
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

/** One step's facts. `woken` and `pressed` are edges: true on the step they happen. */
struct iterate_kit_announcer_input {
  uint64_t now_ms;
  enum iterate_kit_wifi_status wifi;
  /** iterate refused the device's key (401/403 on the upgrade) and it still stands. */
  bool key_refused;
  /** The project is mounted: the board can take a call. */
  bool connected;
  /** A session is open or opening, so the microphone is live: narration waits. */
  bool in_session;
  /** The wake word started a session that `iterate_kit_announcer_answers` promised to answer. */
  bool woken;
  /** A button press did, likewise. */
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
  /** `pending` answers a press or the wake word, rather than narrating. */
  bool pending_answers;
};

/** `narrate`: a person probably caused this boot (iterate/kit/platforms/reset_reason.h). */
void iterate_kit_announcer_init(
    struct iterate_kit_announcer *announcer, bool narrate, uint64_t now_ms);

void iterate_kit_announcer_step(
    struct iterate_kit_announcer *announcer,
    const struct iterate_kit_announcer_input *input);

/**
 * Whether a session start of this kind gets an answer out loud now, in place
 * of the board's chime: the wake word always, a press while not connected, and
 * either only while the speaker is free, so the answer can start at once. The
 * loop publishes this to the board before the start happens, and passes a
 * start to the announcer only when it was promised, so a start always gets
 * exactly one of the two.
 */
bool iterate_kit_announcer_answers(bool wake_word, bool connected, bool speaker_free);

/**
 * The phrase to say now, or NONE. Taking it clears it and counts it as said
 * (a caller dropping it during a call means the same). Call only when the
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
