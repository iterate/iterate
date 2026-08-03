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
   * Options the screen has room for, which is every item the menu defines
   * (ITERATE_KIT_MENU_ITEM_COUNT). The display checks the two agree at build
   * time, so a fourth item is a compile error rather than an option the
   * device offers and never draws.
   */
  WAVESHARE_MENU_ITEMS_MAX = 3,
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

/** Connection/context subtitle, e.g. the stream path or an error. */
void waveshare_display_set_status(const char *text);

/**
 * Publish what the menu screen should say. Thread-safe; may be called from any
 * task. Strings are borrowed — see `struct waveshare_menu_view`.
 *
 * Nothing here changes what is on screen unless the state is
 * WAVESHARE_UI_MENU, so the view and the state can be published in either
 * order without a half-drawn menu appearing in between.
 */
void waveshare_display_set_menu(const struct waveshare_menu_view *view);

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

#ifdef __cplusplus
}
#endif

#endif
