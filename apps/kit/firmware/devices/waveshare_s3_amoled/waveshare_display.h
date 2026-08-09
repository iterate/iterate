#ifndef ITERATE_KIT_WAVESHARE_DISPLAY_H
#define ITERATE_KIT_WAVESHARE_DISPLAY_H

#include <stdbool.h>

#include "iterate/kit/voice/loop.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Start the vendor SH8601/LVGL stack and the shared avatar renderer.
 *
 * This must run before audio initialization. The vendor board routes the
 * display, touch and codec reset signals through the same TCA9554 expander;
 * releasing those resets after configuring the codec would reset a live audio
 * path.
 */
bool waveshare_display_init(void);

/**
 * Publish the whole view. Thread-safe; no caller other than this module
 * touches LVGL.
 *
 * ONE CALL, NOT NINE. This was eight setters plus two intent accessors, called
 * 48 times from one device file and read back through the mutex three times a
 * pass. They were not ten facts, they were one fact written ten ways — and
 * writing it in pieces is how this panel came to read "ready" while the server
 * was refusing the device every three seconds. The intent half moved into the
 * loop, which is where a board with no panel could also keep it.
 */
void waveshare_display_present(const struct iterate_kit_voice_view *view);

#ifdef __cplusplus
}
#endif

#endif
