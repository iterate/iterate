#ifndef ITERATE_KIT_WAVESHARE_BUTTONS_H
#define ITERATE_KIT_WAVESHARE_BUTTONS_H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * The board's two physical buttons, debounced and polled.
 *
 *   BOOT  (GPIO0, low = pressed)   -> call: press toggles the call
 *   PWR   (EXIO4, high = pressed)  -> talk: HELD while speaking
 *
 * Same division as the M5StickS3: one button owns the call, the other owns
 * the microphone turn. PWR is on the TCA9554 expander rather than an ESP pin,
 * so reads go over I2C; holding it past ~6s powers the board down, which is
 * the hardware's own behaviour and not something firmware can intercept.
 */
bool waveshare_buttons_init(void);

/** True for one poll after the call button goes down. */
bool waveshare_buttons_take_call_press(void);

/** True while the talk button is held. */
bool waveshare_buttons_talk_held(void);

/** Poll both buttons; call from the app loop. */
void waveshare_buttons_poll(void);

#ifdef __cplusplus
}
#endif

#endif
