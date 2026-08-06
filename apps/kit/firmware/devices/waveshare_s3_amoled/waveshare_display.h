#ifndef ITERATE_KIT_WAVESHARE_DISPLAY_H
#define ITERATE_KIT_WAVESHARE_DISPLAY_H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

enum waveshare_ui_state {
  WAVESHARE_UI_CONNECTING = 0,
  WAVESHARE_UI_IDLE,
  WAVESHARE_UI_LISTENING,
  WAVESHARE_UI_SPEAKING,
};

/**
 * Start the vendor SH8601/LVGL stack and the shared avatar renderer.
 *
 * This must run before audio initialization. The vendor board routes the
 * display, touch and codec reset signals through the same TCA9554 expander;
 * releasing those resets after configuring the codec would reset a live audio
 * path.
 */
bool waveshare_display_init(void);

/** Thread-safe UI publications. No caller other than this module touches LVGL. */
void waveshare_display_set_state(enum waveshare_ui_state state);
void waveshare_display_set_status(const char *text);
void waveshare_display_set_link_ready(bool ready);
/**
 * Latches an unrecoverable start-up fault onto this device's status surface.
 *
 * Distinct from "not connected": a device that is still trying looks like one
 * that is trying, and a device that will never work must not. Nothing clears
 * this — the only exit is a reboot, which is the truth.
 */
void waveshare_display_set_fault(void);
void waveshare_display_set_call_active(bool active);

/** Local call and push-to-talk intent shared with the application task. */
bool waveshare_display_call_requested(void);
void waveshare_display_request_call(bool requested);
bool waveshare_display_talk_held(void);
void waveshare_display_hold_talk(bool held);

#ifdef __cplusplus
}
#endif

#endif
