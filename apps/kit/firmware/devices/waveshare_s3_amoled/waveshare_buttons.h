#ifndef ITERATE_KIT_WAVESHARE_BUTTONS_H
#define ITERATE_KIT_WAVESHARE_BUTTONS_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * The board's two physical buttons, debounced and polled.
 *
 *   UPPER = BOOT (GPIO0, low = pressed)
 *   LOWER = PWR  (EXIO4 on the TCA9554, high = pressed)
 *
 * NAMED FOR WHERE THEY ARE, NOT FOR WHAT THEY DO. They used to be called
 * "call" and "talk"; when those meanings moved between the buttons, every
 * name in the file became a lie and the code read as though it did the
 * opposite of what it did. Position is the one thing about a button that
 * cannot change underneath you.
 *
 * ONLY THE UPPER BUTTON MAY BE HELD. PWR sits in the board's power path, and
 * holding it powers the device down in hardware — no firmware involved, and
 * none of it interceptable. Push-to-talk therefore lives on BOOT, an ordinary
 * pin that can be held all day; the lower button is only ever tapped.
 *
 * Reading the lower button is an I2C transaction on the bus the codec and the
 * touch controller share, so both are polled at a human cadence rather than
 * the app loop's.
 */
bool waveshare_buttons_init(void);

/**
 * One press of the UPPER button, taken on the down edge and consumed here.
 *
 * The down edge rather than the release, because nothing on this button now
 * waits to discover whether a press was really a hold, and a menu that only
 * moved once you let go feels broken.
 */
bool waveshare_buttons_take_upper_press(void);

/** Inject an upper/lower press into the same pending latches the settle
 * loop fills — one handler path for finger and capability alike. */
void waveshare_buttons_inject_upper(void);
void waveshare_buttons_inject_lower(void);

/**
 * True while the UPPER button is held. This is the microphone.
 *
 * A level rather than an event: during a call the microphone is open exactly
 * while the button is down, so the caller needs this on every pass rather
 * than once.
 */
bool waveshare_buttons_upper_held(void);

/** One press of the LOWER button, taken on the down edge and consumed here. */
bool waveshare_buttons_take_lower_press(void);

/**
 * I2C reads of the lower button that failed.
 *
 * Worth publishing because the read deliberately fails RELEASED, which makes
 * a lower button that has quietly stopped working look exactly like a user
 * who has stopped pressing it. This counter is the only difference.
 */
uint32_t waveshare_buttons_lower_read_failures(void);

/** Poll both buttons; call from the app loop. */
void waveshare_buttons_poll(void);

#ifdef __cplusplus
}
#endif

#endif
