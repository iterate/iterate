#ifndef ITERATE_KIT_HAVPE_UI_H
#define ITERATE_KIT_HAVPE_UI_H

#include <stdbool.h>
#include <stdint.h>

#include "iterate/kit/voice/loop.h"

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

/** Copy the loop's whole view, latch faults, and mark changed lights dirty.
 * Call from the app task before ticking; microphone peaks alone do not repaint.
 */
void havpe_ui_present(const struct iterate_kit_voice_view *view);

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

/** Inject a centre-button tap into the same pending latch the debouncer
 * fills — one handler path for finger and capability alike. */
void havpe_button_inject_tap(void);

#ifdef __cplusplus
}
#endif

#endif
