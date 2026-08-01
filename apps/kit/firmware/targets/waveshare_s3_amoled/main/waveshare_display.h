#ifndef ITERATE_KIT_WAVESHARE_DISPLAY_H
#define ITERATE_KIT_WAVESHARE_DISPLAY_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  WAVESHARE_DISPLAY_WIDTH = 368,
  WAVESHARE_DISPLAY_HEIGHT = 448,
};

/** What the device is doing, shown as the headline line on screen. */
enum waveshare_ui_state {
  WAVESHARE_UI_CONNECTING = 0,
  WAVESHARE_UI_IDLE,      /* connected, no call */
  WAVESHARE_UI_LISTENING, /* call open, microphone live */
  WAVESHARE_UI_SPEAKING,  /* answer playing */
};

/**
 * Bring up the SH8601 QSPI AMOLED (368x448) and start the LVGL task that owns
 * every widget. Touch is polled by the same task. Safe to call once, after
 * the shared I2C bus exists (waveshare_audio_init creates it).
 */
bool waveshare_display_init(void);

/** Headline state. Thread-safe; may be called from any task. */
void waveshare_display_set_state(enum waveshare_ui_state state);

/** Connection/context subtitle, e.g. the stream path or an error. */
void waveshare_display_set_status(const char *text);

/** Append (or replace, when `final` is false) the newest transcript line. */
void waveshare_display_push_transcript(
    const char *speaker, const char *text, bool final);

/** Background colour as 24-bit RGB; drives the `setBackground` tool. */
void waveshare_display_set_background(uint32_t rgb);

/**
 * True while the user wants a call. The touch button toggles it; the app loop
 * polls this and appends call-requested / call-ended accordingly.
 */
bool waveshare_display_call_requested(void);

/** Let the UI reflect what the call actually did (bridge accepted/ended). */
void waveshare_display_set_call_active(bool active);

/** Same intent as pressing the button; drives the startCall/hangUp tools. */
void waveshare_display_request_call(bool requested);

enum {
  /* Screenshots ship at half scale: legible, and 1/4 of the bytes. */
  WAVESHARE_SNAPSHOT_WIDTH = WAVESHARE_DISPLAY_WIDTH / 2,
  WAVESHARE_SNAPSHOT_HEIGHT = WAVESHARE_DISPLAY_HEIGHT / 2,
  WAVESHARE_SNAPSHOT_BYTES = WAVESHARE_SNAPSHOT_WIDTH * WAVESHARE_SNAPSHOT_HEIGHT * 2,
};

/**
 * Render what is on screen into `out` as half-scale RGB565 little-endian,
 * `WAVESHARE_SNAPSHOT_BYTES` long — so a test can see the device's screen
 * without a camera. Safe from any task; takes the LVGL lock.
 */
bool waveshare_display_snapshot(uint8_t *out, size_t capacity);

#ifdef __cplusplus
}
#endif

#endif
