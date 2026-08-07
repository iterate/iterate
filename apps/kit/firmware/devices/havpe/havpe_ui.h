#ifndef ITERATE_KIT_HAVPE_UI_H
#define ITERATE_KIT_HAVPE_UI_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * The 12-pixel WS2812 ring is this board's entire display. Bring-up gates
 * the ring's supply rail (GPIO 45) before the first refresh: RMT reports
 * successful writes with the rail off, so an ungated ring is a healthy-
 * looking capability on a dark device.
 */
bool havpe_ui_init(void);

/* Mirrors the state vocabulary of the screen boards. */
enum havpe_ui_state {
  HAVPE_UI_IDLE = 0,
  HAVPE_UI_CONNECTING,
  HAVPE_UI_LISTENING,
  HAVPE_UI_SPEAKING,
};

void havpe_ui_set_state(enum havpe_ui_state state);
void havpe_ui_set_status(const char *status);
void havpe_ui_set_call_active(bool active);
void havpe_ui_set_link_ready(bool ready);
/** The first rung: the Cap'n Web session to /api is up and this device is on it. */
void havpe_ui_set_api_ready(bool ready);
/**
 * The middle rung: a conversation stream exists and this device is on it.
 *
 * Separate from `link_ready` because they fail separately and a person needs
 * to see which. A session to /api with no stream is a board that will accept a
 * press and then take seconds to find somewhere to send it.
 */
void havpe_ui_set_stream_ready(bool ready);

/**
 * The loudest sample in the most recent captured frame.
 *
 * Called from the CAPTURE task, which is why it stores a single aligned word
 * and nothing else. Presentation only: the microphone sector of the ring
 * meters it so a person can SEE the device hearing them, and nothing in AEC,
 * VAD or flow control reads it.
 */
void havpe_ui_set_microphone_peak(uint32_t peak);
/**
 * Latches an unrecoverable start-up fault onto this device's status surface.
 *
 * Distinct from "not connected": a device that is still trying looks like one
 * that is trying, and a device that will never work must not. Nothing clears
 * this — the only exit is a reboot, which is the truth.
 */
void havpe_ui_set_fault(void);

/** The user's call INTENT, owned locally (see the Waveshare port). */
void havpe_ui_request_call(bool wanted);
bool havpe_ui_call_requested(void);

/** Throttled ring refresh; call from the app loop only. */
void havpe_ui_tick(void);

/* --- the center button ------------------------------------------------------
 *
 * GPIO0, active low, and a boot strap: input only, and the device must never
 * restart while it is held low (that enters the ROM downloader). One button
 * carries both intents with a deliberate product grammar:
 *
 *   hold past the tap threshold  -> push-to-talk (turn runs while held)
 *   short tap                    -> toggle the call
 *
 * The tap threshold trades ~250 ms of push-to-talk onset for one-button call
 * control; a person's press-then-speak lead ordinarily covers it. Poll every
 * app-loop pass; edges are classified here so the composition sees only the
 * two intents.
 */
void havpe_button_poll(void);

/** Level: the press has been held past the tap threshold (talk wanted). */
bool havpe_button_talk_held(void);

/** One completed short tap (consumed on read): toggle the call. */
bool havpe_button_take_tap(void);

#ifdef __cplusplus
}
#endif

#endif
