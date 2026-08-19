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

/**
 * Mirror of the loop's call intent, so the ring answers the press ITSELF.
 *
 * While a call is wanted but not yet active the ring shows the shared amber
 * "working on it" comet — the press acknowledged within a frame instead of
 * after the seconds the far end takes to accept. The moment call_active
 * flips, the view owns the ring again.
 */
void havpe_ui_set_wants_call(bool wanted);

/**
 * Borrow the ring for ~1 s of direct dial feedback.
 *
 * Volume is N of 12 pixels lit (the official firmware's own display for this
 * gesture, red single pixel at zero); a mode is its lit quadrant of three.
 * Each call re-arms the dwell, so feedback follows the finger; when it
 * lapses, the state animation returns untouched.
 */
void havpe_ui_show_volume(uint8_t percent);
void havpe_ui_show_mode(uint8_t mode);

/**
 * The adopted mode, for the idle ring.
 *
 * While no session is up and the link is healthy, the ring shows this mode's
 * quadrant dimly — the glanceable answer to "which posture will the next
 * press take", which is the fact whose absence produced a tap in an
 * unsuspected push-to-talk mode and two calls nobody could talk to. Dim on
 * purpose: idle is a state, not a light show.
 */
void havpe_ui_set_mode(uint8_t mode);

/**
 * Dial counts accumulated since the last take; either sign, consumed on read.
 *
 * Sampled inside the tick at the app-loop cadence (~5 ms) because quadrature
 * decays with sampling rate; drained by the composition at the 25 ms control
 * poll. Both run on the app task.
 */
int havpe_ui_take_dial(void);

/** Throttled ring refresh; call from the app loop only. */
void havpe_ui_tick(void);

/* --- the center button ------------------------------------------------------
 *
 * GPIO0, active low, and a boot strap: input only, and the device must never
 * restart while it is held low (that enters the ROM downloader). This module
 * only CLASSIFIES the gesture — a press past the threshold is a hold, a
 * shorter release a tap; what either MEANS in which state is the session
 * grammar's table in havpe_modes.h. The threshold trades ~250 ms of hold
 * onset for the one-button grammar; a person's press-then-speak lead
 * ordinarily covers it. Poll every app-loop pass.
 */
void havpe_button_poll(void);

/** Level: the press has been held past the tap threshold. */
bool havpe_button_talk_held(void);

/** One completed short tap (consumed on read). */
bool havpe_button_take_tap(void);

/** One deliberate end-hold (a press crossing 800 ms), consumed on read.
 * Fires while still pressed, so the hang-up answers the finger, not the
 * release. Latched once per press. */
bool havpe_button_take_end_hold(void);

#ifdef __cplusplus
}
#endif

#endif
