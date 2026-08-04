#ifndef ITERATE_KIT_WAVESHARE_DISPLAY_H
#define ITERATE_KIT_WAVESHARE_DISPLAY_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "waveshare_image.h"

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
  /*
   * The between-calls menu (device_menu.h) is on screen. It takes the screen
   * over rather than sharing it: the headline, the status line and the
   * transcript all describe a call, and on 368 points of width there is room
   * for one thing to be legible at arm's length.
   */
  WAVESHARE_UI_MENU,
};

enum {
  /*
   * Options the screen has room for, which is every item the menu can ever
   * offer (ITERATE_KIT_MENU_ITEM_COUNT) — not just the ones a given context
   * shows. The display checks the two agree at build time, so a fifth item is
   * a compile error rather than an option the device offers and never draws.
   */
  WAVESHARE_MENU_ITEMS_MAX = 6,
};

/**
 * Everything the menu screen shows: what the menu module decided, plus the
 * context that makes the decision meaningful — which conversation this device
 * would resume, and where it lives.
 *
 * Every string here is BORROWED for the duration of the call. The display
 * copies what it needs before returning, because the caller composes these
 * out of buffers it reuses, and a pointer kept past the call would paint
 * whatever landed in them next.
 */
struct waveshare_menu_view {
  /** Stream this device is mounted on, e.g. "/agents/voice/2608031015". */
  const char *stream_path;
  /** Project that owns the stream, e.g. "jonas-templestein-s-organization". */
  const char *project;
  /** Deployment the base URL points at, e.g. "preview_3". */
  const char *environment;
  /** Transport in a word, e.g. "ready" / "connecting" / "offline". */
  const char *connection;
  /** Option labels in cursor order, from iterate_kit_menu_item_name. */
  const char *items[WAVESHARE_MENU_ITEMS_MAX];
  /** How many of `items` to show; anything above the maximum is dropped. */
  uint8_t item_count;
  /** Item under the cursor. Out of range puts it back on the first item. */
  uint8_t selected;
};

/**
 * Bring up the SH8601 QSPI AMOLED (368x448) and start the LVGL task that owns
 * every widget. Touch is polled by the same task. Safe to call once, after
 * the shared I2C bus exists (waveshare_audio_init creates it).
 */
bool waveshare_display_init(void);

/** Headline state. Thread-safe; may be called from any task. */
void waveshare_display_set_state(enum waveshare_ui_state state);

/** Connection/context subtitle, e.g. the reason the link is down. */
void waveshare_display_set_status(const char *text);

/**
 * Whether the device can currently do anything at all — the app's own gate:
 * transport ready, stream mounted, generations agreed.
 *
 * A FLAG, PUBLISHED EVERY TIME IT CHANGES, NOT A UI STATE. It began as a state
 * value and that was wrong: nine places in the app set the state to IDLE for
 * their own good reasons, so "offline" survived until the next one of them ran
 * and the screen then said "ready" while the console said "authentication
 * rejected" every three seconds. A person pressed the call button and nothing
 * happened, which is precisely the failure the screen existed to explain.
 *
 * Being a separate flag, nothing else can overwrite it, and the bar prefers it
 * over whatever the state happens to be.
 */
void waveshare_display_set_link_ready(bool ready);

/**
 * Publish what the menu screen should say. Thread-safe; may be called from any
 * task. Strings are borrowed — see `struct waveshare_menu_view`.
 *
 * Nothing here changes what is on screen unless the state is
 * WAVESHARE_UI_MENU, so the view and the state can be published in either
 * order without a half-drawn menu appearing in between.
 */
void waveshare_display_set_menu(const struct waveshare_menu_view *view);

/*
 * THERE IS NO TRANSCRIPT ON THIS SCREEN. Deliberately, for now: the face is the
 * screen, and words under it were words competing with it. Provider transcript
 * deltas still reach the SD-card recorder, which is where they are read back.
 * If they return here they return as a deliberate design, not as a leftover.
 */

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

/**
 * True while a turn is being spoken. The on-screen talk button and the
 * pushToTalk tool both set this; the physical PWR button is ORed with it, so
 * remote and local control take turns through one flag.
 */
bool waveshare_display_talk_held(void);
void waveshare_display_hold_talk(bool held);

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

enum {
  /*
   * Longest an image may hold the screen, in seconds.
   *
   * While it is up the headline, the status line and the transcript are all
   * behind it, so the person cannot see what their call is doing. Half a
   * minute is longer than a picture stays interesting and short enough that a
   * wrong number reads as a glitch rather than a device that has stopped
   * answering; anything longer has to be asked for again.
   */
  WAVESHARE_IMAGE_SECONDS_MAX = 30,
};

/**
 * Show `bitmap` full-screen for `seconds`, then reveal the UI again.
 *
 * The pixels are BORROWED for as long as the image is active and are never
 * freed here: this module has no idea where they came from, and a display that
 * freed a caller's buffer would be a double-free waiting for the day someone
 * shows the same bitmap twice. Release them once
 * `waveshare_display_image_active` goes false — including a bitmap a later
 * call replaced, because the panel may still be drawing it until the LVGL task
 * next runs.
 *
 * Latest wins: showing a second image while one is up replaces it and restarts
 * the clock, without the image ever going inactive in between.
 *
 * Nothing is centred by cropping and nothing is scaled, so the request is
 * refused rather than adjusted: false for a NULL bitmap or NULL pixels, a zero
 * width or height, dimensions past the panel, `seconds` of 0, or `seconds`
 * past WAVESHARE_IMAGE_SECONDS_MAX. A picture that appears at a size or for a
 * length of time nobody asked for is a bug wearing a working feature's face.
 *
 * Thread-safe; may be called from any task.
 */
bool waveshare_display_show_image(
    const struct waveshare_image_bitmap *bitmap, uint32_t seconds);

/**
 * True while the image is on screen, or still the panel's drawing source.
 *
 * It goes false only once the LVGL task has let the pixels go, which is the
 * moment — and the only moment — every bitmap handed over since it was last
 * false can be freed.
 */
bool waveshare_display_image_active(void);

/**
 * Take the image down now, revealing the UI again. Idempotent.
 *
 * Asking twice costs nothing; the second call finds nothing to take down and
 * leaves the panel alone.
 */
void waveshare_display_hide_image(void);

#ifdef __cplusplus
}
#endif

#endif
