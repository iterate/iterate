/*
 * Waveshare ESP32-S3 Touch AMOLED 1.8 — the Iterate UI.
 *
 * Bring-up is the board's own BSP (waveshare/esp32_s3_touch_amoled_1_8):
 * bsp_display_start() brings up the SH8601 QSPI panel, the FT3168 touch
 * controller behind its TCA9554 expander, and esp_lvgl_port's LVGL task and
 * lock. Hand-rolling that was how this file started, and it cost a day to
 * two board facts the BSP already knows — the touch reset hangs off the
 * expander, and the draw buffers have to come out of the right heap.
 *
 * Everything below the bring-up is ours: other tasks publish into a small
 * mutex-guarded snapshot, and one LVGL timer paints it. Nothing outside this
 * file touches LVGL.
 */
#include "waveshare_display.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "esp_lcd_touch.h"
#include "bsp/esp-bsp.h"
#include "bsp/touch.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "iterate/kit/conversation_lights.h"
#include "iterate/kit/device_menu.h"
#include "lvgl.h"
#include "waveshare_avatar.h"

/*
 * Included for this one check and nothing else: the menu's decisions reach
 * this file as a view, not as its struct. If somebody adds a fourth item, the
 * build stops here — where the screen is — rather than shipping a device that
 * offers an option it has no room to draw.
 */
_Static_assert(
    (int)WAVESHARE_MENU_ITEMS_MAX == (int)ITERATE_KIT_MENU_ITEM_COUNT,
    "the menu view must carry every item device_menu.h defines");

static const char tag[] = "waveshare-ui";

enum {
  STATUS_CHARS = 64,
  /* How often the published snapshot is painted, in milliseconds. */
  REFRESH_PERIOD_MS = 100,
};

/*
 * THE SCREEN: A FACE, AND A BAR ALONG THE BOTTOM.
 *
 * The face is as large as crisp pixels allow, centred in everything above the
 * bar. The bar is two short lines and twelve dots:
 *
 *   in call - speaking                              (state)  ●●●●●●●●●●●●
 *   tap: hang up · top: hold to talk · bottom: menu (controls)
 *
 * THE WORDS ARE THERE BECAUSE THE DEVICE WAS UNUSABLE WITHOUT THEM. For one
 * revision this screen was the face and the dots alone, on the reasoning that
 * every word competed with the one thing worth looking at. Tried in the hand,
 * the result was a device nobody could talk to: no way to tell a call from no
 * call, and no way to learn what either button did. Twelve dots are a status
 * indicator for somebody who already knows the code.
 *
 * So the bar says two things and nothing else: WHAT IS HAPPENING, and WHAT THE
 * CONTROLS DO RIGHT NOW. Everything durable — which stream, which project,
 * which deployment — is still in the MENU, one press away, where there is room
 * to read it. A screen that shows you everything all the time is a screen you
 * stop reading; a screen that shows you nothing is one you cannot use.
 */
enum {
  /*
   * BLACK, because the face's own background is black.
   *
   * It was 0x101820, a very dark navy, which was invisibly different from black
   * on a screen made of text — and became a hard-edged rectangle the moment a
   * sprite with its own background sat in the middle of it. The face is not a
   * panel and must not read as one, so the screen matches the sprite rather
   * than the sprite being recoloured to match the screen.
   *
   * setBackground still does what it says: an agent asking for a colour gets a
   * coloured screen, with the face's own black square inside it.
   */
  SCREEN_BACKGROUND_RGB = 0x000000,
  /*
   * THE PANEL'S CORNERS ARE ROUNDED, and 8 was not enough to clear them.
   *
   * Measured by eye on the board: the bar's text and the dots sit in the bottom
   * two corners, and both were being cut. This is a physical property of the
   * glass that no amount of LVGL geometry can see — the framebuffer is a full
   * 368x448 rectangle and the driver accepts every pixel of it, including the
   * ones the display cannot show.
   *
   * So the padding clears the arc rather than the rectangle, and the bar takes a
   * further inset of its own because it is the only thing that lives in a
   * corner. If anything still clips, these two numbers are where to look.
   */
  SCREEN_PAD = 22,
  BAR_SIDE_INSET = 8,
  BAR_BOTTOM_INSET = 8,
  /*
   * Two. The atlases are 80x60 drawn into a 160x120 frame, so this is the
   * second doubling — every source pixel becomes a crisp 4x4 block. A
   * non-integer scale would resample pixel art into mush, which is the whole
   * look gone for the sake of a few points of width.
   */
  FACE_SCALE = 2,
  FACE_WIDTH = FACE_RENDER_WIDTH * FACE_SCALE,
  FACE_HEIGHT = FACE_RENDER_HEIGHT * FACE_SCALE,
  FACE_PIXELS = FACE_WIDTH * FACE_HEIGHT,
  /* One light, and the space to its neighbour. */
  LIGHT_SIZE = 6,
  LIGHT_GAP = 3,
  /*
   * All twelve in ONE ROW along the bottom.
   *
   * The shared model's sector order — network, speaker, microphone, spare —
   * then reads left to right, and the ordinary connected-and-waiting state is
   * three green dots followed by nine dark ones. Tidy, and nothing else on
   * screen. The two-column block this replaces was built for a vertical rail;
   * transposed into a bar it would have been a square of dots in a corner.
   */
  LIGHTS_WIDTH =
      ITERATE_KIT_CONVERSATION_LIGHT_COUNT * LIGHT_SIZE +
      (ITERATE_KIT_CONVERSATION_LIGHT_COUNT - 1) * LIGHT_GAP,
  LIGHTS_HEIGHT = LIGHT_SIZE,
  /*
   * The bar: a state row, a controls row under it, and the dots beside the
   * state. Measured from the bottom edge inwards, because that is the edge all
   * three are anchored to and the one the face has to stay clear of.
   */
  BAR_CONTROLS_BASELINE = -BAR_BOTTOM_INSET,
  BAR_STATE_BASELINE = -BAR_BOTTOM_INSET - 20,
  BAR_HEIGHT = 42 + BAR_BOTTOM_INSET,
  /* Air between the face and the bar, so neither reads as touching. */
  BAR_GAP_ABOVE = 10,
  /* Everything the face may have: the screen, less the padding and the bar. */
  FACE_AREA_HEIGHT =
      WAVESHARE_DISPLAY_HEIGHT - SCREEN_PAD * 2 - BAR_HEIGHT - BAR_GAP_ABOVE,
  /*
   * How far the face's centre sits above the screen's, so that it is centred in
   * the space it actually has rather than in the whole panel. Expressed as an
   * offset because LVGL centres against the parent, and the parent is the
   * screen.
   */
  FACE_CENTRE_OFFSET_Y = -(BAR_HEIGHT + BAR_GAP_ABOVE) / 2,
  MENU_CONTENT_WIDTH_AVAILABLE = WAVESHARE_DISPLAY_WIDTH - SCREEN_PAD * 2,
};

_Static_assert(
    FACE_WIDTH <= WAVESHARE_DISPLAY_WIDTH - SCREEN_PAD * 2,
    "the face at this scale is wider than the screen");
/*
 * 2x is the CEILING, not a preference. The atlases are 160x120, so 3x is 480
 * wide against a 368-point panel — it would have to be cropped — and any
 * non-integer scale resamples pixel art into mush. This assertion is what stops
 * someone raising FACE_SCALE to fill more of the screen and quietly getting the
 * cropped or blurred version instead.
 */
_Static_assert(
    FACE_HEIGHT <= FACE_AREA_HEIGHT,
    "the face at this scale is taller than the space left above the lights");

enum {
  /*
   * The stream path is kept whole here and shortened only when it is drawn,
   * because how much of it fits is a question about the screen, not about the
   * caller. Long enough for the paths os hands out with room to spare.
   */
  MENU_PATH_CHARS = 128,
  MENU_FIELD_CHARS = 64,
  MENU_ITEM_CHARS = 32,
  /*
   * project, environment and connection, with the separators between them:
   * big enough that the compiler can see the formatted line cannot truncate,
   * which is the only way a field silently loses its last characters.
   */
  MENU_CONTEXT_CHARS = MENU_FIELD_CHARS * 3 + 16,
};

/*
 * The menu as the screen holds it: every field a string this module owns.
 *
 * All members are bytes, so the struct has no padding and one memcmp against
 * the painted copy is enough to answer "has anything changed?" — which is how
 * a status line ticking during a call avoids redrawing the menu behind it.
 */
struct menu_snapshot {
  char stream_path[MENU_PATH_CHARS];
  char project[MENU_FIELD_CHARS];
  char environment[MENU_FIELD_CHARS];
  char connection[MENU_FIELD_CHARS];
  char items[WAVESHARE_MENU_ITEMS_MAX][MENU_ITEM_CHARS];
  uint8_t item_count;
  uint8_t selected;
};

/**
 * An image as the screen holds it: the caller's pixels, and when they go.
 *
 * The pixels are the ONLY borrowed thing in `ui` — everything else is copied
 * into a field this module owns — so the deadline travels with them rather
 * than being recomputed at paint time. Whoever set the deadline is the only
 * one who knows what "for five seconds" meant.
 */
struct image_snapshot {
  const uint16_t *pixels;
  uint16_t width;
  uint16_t height;
  uint64_t deadline_ms;
};

static struct {
  SemaphoreHandle_t lock;
  enum waveshare_ui_state state;
  char status[STATUS_CHARS];
  struct menu_snapshot menu;
  uint32_t background;
  bool call_requested;
  bool call_active;
  bool talk_held;
  /* The app's gate. True until told otherwise, so a device that has not
   * finished starting does not accuse itself of being offline. */
  bool link_ready;
  /*
   * The image overlay, in three parts because "is an image active" and "has
   * one been asked for" are different questions.
   *
   * `image.pixels` is what the caller wants on screen, NULL once it wants
   * nothing. `image_held` is whether the LVGL task still has those pixels as a
   * drawing source, and it outlives the request — that gap is what keeps a
   * caller from freeing a buffer the next flush would read. `image_epoch`
   * counts decisions, so the LVGL task can tell "the same image again" from "a
   * new one that happens to sit at the same address".
   */
  struct image_snapshot image;
  bool image_held;
  uint32_t image_epoch;
  bool dirty;
} ui = {
  .background = SCREEN_BACKGROUND_RGB,
  .link_ready = true,
};

static lv_obj_t *screen_root;
/*
 * The status line, which now lives INSIDE the menu.
 *
 * It used to sit under the headline on the main screen, where it was the only
 * thing saying "reconnecting" or "call ended". Deleting it outright would have
 * thrown that away along with the twenty places that set it; putting it in the
 * menu keeps every one of them meaningful and puts the words where somebody has
 * asked to read words.
 */
static lv_obj_t *status_label;
/*
 * The bar's two rows: what is happening, and what the controls do.
 *
 * Ordinary LVGL labels rather than the 3x5 alphabet an earlier revision drew by
 * hand. That font existed to fit three characters into a 24-point rail; along
 * the bottom there is room for words, and "tap: hang up" needs no decoding.
 */
static lv_obj_t *bar_state_label;
static lv_obj_t *bar_controls_label;
/*
 * The face and the rail are canvases rather than widgets because neither is
 * made of widgets: one is a sprite renderer's output and the other is a grid of
 * lights and a 3x5 alphabet. Both are painted as pixels and shown as images,
 * which is also why neither needs an LVGL font or theme.
 */
static lv_obj_t *face_canvas;
/* What the canvas shows: the rendered frame expanded FACE_SCALE times. */
static uint16_t *face_pixels;
/* One 160x120 frame as the renderer produced it, before expansion. */
static uint16_t *face_frame;
/*
 * The frame currently on the canvas.
 *
 * Kept so an unchanged frame can be skipped entirely. A still face between
 * blinks is common, and expanding and invalidating 320x240 points ten times a
 * second to draw the same picture is the kind of load that shows up as audio
 * trouble rather than as a slow screen.
 */
static uint16_t *face_shown;
static lv_obj_t *menu_info;
static lv_obj_t *menu_path_label;
static lv_obj_t *menu_context_label;
static lv_obj_t *menu_options;
static lv_obj_t *menu_rows[WAVESHARE_MENU_ITEMS_MAX];
static lv_obj_t *image_overlay;
/* Snapshot staging: full-resolution RGB565 in PSRAM, reused per capture. */
static lv_draw_buf_t snapshot_buf;
static uint8_t *snapshot_pixels;
/* Half-scale result, filled by the LVGL task and read by the capability. */
static uint16_t *snapshot_scaled;
static volatile bool snapshot_requested;
static volatile bool snapshot_ready;

/* --- public, thread-safe setters ----------------------------------------- */

static void publish(void (*mutate)(void *), void *argument) {
  if (ui.lock == NULL) return;
  xSemaphoreTake(ui.lock, portMAX_DELAY);
  mutate(argument);
  ui.dirty = true;
  xSemaphoreGive(ui.lock);
}

static void set_state_locked(void *argument) {
  ui.state = *(enum waveshare_ui_state *)argument;
}

void waveshare_display_set_state(enum waveshare_ui_state state) {
  publish(set_state_locked, &state);
}

static void set_status_locked(void *argument) {
  const char *text = argument;
  snprintf(ui.status, sizeof(ui.status), "%s", text);
}

void waveshare_display_set_status(const char *text) {
  publish(set_status_locked, (void *)(uintptr_t)text);
}

/**
 * Take a borrowed string into a field this module owns.
 *
 * The whole field is cleared first, not just terminated: the painted copy is
 * compared byte for byte to decide whether the screen needs redrawing, and
 * leftovers past the terminator would make identical text look changed and
 * repaint the menu on every publish.
 */
static void copy_field(char *field, size_t capacity, const char *text) {
  assert(field != NULL);
  assert(capacity > 0U);
  memset(field, 0, capacity);
  /* A missing field is empty, never a crash: one absent string must not cost
   * the person the three that arrived. */
  snprintf(field, capacity, "%s", text == NULL ? "" : text);
}

static void set_menu_locked(void *argument) {
  const struct waveshare_menu_view *view = argument;
  const uint8_t count = view->item_count < (uint8_t)WAVESHARE_MENU_ITEMS_MAX
      ? view->item_count
      : (uint8_t)WAVESHARE_MENU_ITEMS_MAX;
  uint8_t index;
  copy_field(ui.menu.stream_path, sizeof(ui.menu.stream_path), view->stream_path);
  copy_field(ui.menu.project, sizeof(ui.menu.project), view->project);
  copy_field(ui.menu.environment, sizeof(ui.menu.environment), view->environment);
  copy_field(ui.menu.connection, sizeof(ui.menu.connection), view->connection);
  /* Every slot is written, including the ones past `count`, so a shorter menu
   * cannot leave the previous one's last option on screen. */
  for (index = 0U; index < (uint8_t)WAVESHARE_MENU_ITEMS_MAX; ++index) {
    copy_field(
        ui.menu.items[index],
        sizeof(ui.menu.items[index]),
        index < count ? view->items[index] : NULL);
  }
  ui.menu.item_count = count;
  /*
   * A cursor past the last item would leave no row marked at all, which reads
   * as a menu that has stopped answering the button.
   */
  ui.menu.selected = view->selected < count ? view->selected : 0U;
}

void waveshare_display_set_menu(const struct waveshare_menu_view *view) {
  if (view == NULL) return;
  publish(set_menu_locked, (void *)(uintptr_t)view);
}

static void set_background_locked(void *argument) {
  ui.background = *(uint32_t *)argument;
}

void waveshare_display_set_background(uint32_t rgb) {
  publish(set_background_locked, &rgb);
}

static void set_link_ready_locked(void *argument) {
  ui.link_ready = *(bool *)argument;
}

void waveshare_display_set_link_ready(bool ready) {
  publish(set_link_ready_locked, &ready);
}

static void set_call_active_locked(void *argument) {
  const bool active = *(bool *)argument;
  ui.call_active = active;
  if (!ui.call_active) ui.call_requested = false;
}

void waveshare_display_set_call_active(bool active) {
  publish(set_call_active_locked, &active);
}

bool waveshare_display_call_requested(void) {
  bool requested;
  if (ui.lock == NULL) return false;
  xSemaphoreTake(ui.lock, portMAX_DELAY);
  requested = ui.call_requested;
  xSemaphoreGive(ui.lock);
  return requested;
}

static void request_call_locked(void *argument) {
  ui.call_requested = *(bool *)argument;
}

void waveshare_display_request_call(bool requested) {
  publish(request_call_locked, &requested);
}

static void hold_talk_locked(void *argument) {
  ui.talk_held = *(bool *)argument;
}

void waveshare_display_hold_talk(bool held) {
  publish(hold_talk_locked, &held);
}

bool waveshare_display_talk_held(void) {
  bool held;
  if (ui.lock == NULL) return false;
  xSemaphoreTake(ui.lock, portMAX_DELAY);
  held = ui.talk_held;
  xSemaphoreGive(ui.lock);
  return held;
}

/* Two different thousands: one turns a caller's seconds into a deadline, the
 * other turns esp_timer's microseconds into the same unit. */
enum {
  MS_PER_SECOND = 1000,
  US_PER_MS = 1000,
};

/** The clock the image deadline is set on and expired against. */
static uint64_t now_ms(void) {
  return (uint64_t)(esp_timer_get_time() / US_PER_MS);
}

/**
 * Whether a request can be honoured exactly as it was asked for.
 *
 * Every bound is a refusal rather than a clamp. Nothing here is scaled or
 * cropped, so an image wider than the panel has no honest rendering, and an
 * overlay that outstays its welcome is indistinguishable from a frozen screen.
 */
static bool image_request_valid(
    const struct waveshare_image_bitmap *bitmap, uint32_t seconds) {
  /* No lock means waveshare_display_init has not run, so there is no screen
   * to put this on and no timer that would ever take it down again. */
  if (ui.lock == NULL) return false;
  if (bitmap == NULL || bitmap->pixels == NULL) return false;
  if (bitmap->width == 0U || bitmap->height == 0U) return false;
  if (bitmap->width > (uint16_t)WAVESHARE_DISPLAY_WIDTH) return false;
  if (bitmap->height > (uint16_t)WAVESHARE_DISPLAY_HEIGHT) return false;
  return seconds > 0U && seconds <= (uint32_t)WAVESHARE_IMAGE_SECONDS_MAX;
}

static void show_image_locked(void *argument) {
  ui.image = *(const struct image_snapshot *)argument;
  /*
   * Held from the moment the pixels are handed over, not from the moment they
   * reach the panel — the LVGL task paints on its own tick. A caller that saw
   * "not active" in that gap would free the bitmap it had just handed over,
   * which is the whole hazard in swapping one image for another.
   */
  ui.image_held = true;
  ++ui.image_epoch;
}

bool waveshare_display_show_image(
    const struct waveshare_image_bitmap *bitmap, uint32_t seconds) {
  struct image_snapshot request;
  if (!image_request_valid(bitmap, seconds)) {
    ESP_LOGW(
        tag,
        "image refused: %ux%u for %us",
        bitmap == NULL ? 0U : (unsigned)bitmap->width,
        bitmap == NULL ? 0U : (unsigned)bitmap->height,
        (unsigned)seconds);
    return false;
  }
  request.pixels = bitmap->pixels;
  request.width = bitmap->width;
  request.height = bitmap->height;
  /* The deadline is fixed here so that a device busy enough to miss a few
   * refreshes still shows the picture for as long as was asked, not for as
   * long as it took to get round to it. */
  request.deadline_ms = now_ms() + (uint64_t)seconds * MS_PER_SECOND;
  publish(show_image_locked, &request);
  return true;
}

static void hide_image_locked(void *argument) {
  (void)argument;
  /* A second hide finds nothing to take down. Bumping the epoch anyway would
   * cost the panel a full-screen invalidate for a picture already gone. */
  if (ui.image.pixels == NULL) return;
  ui.image.pixels = NULL;
  ++ui.image_epoch;
}

void waveshare_display_hide_image(void) {
  publish(hide_image_locked, NULL);
}

bool waveshare_display_image_active(void) {
  bool active;
  if (ui.lock == NULL) return false;
  xSemaphoreTake(ui.lock, portMAX_DELAY);
  /* Either half is enough: a request not yet painted, or pixels the LVGL task
   * has not let go of yet. */
  active = ui.image.pixels != NULL || ui.image_held;
  xSemaphoreGive(ui.lock);
  return active;
}

/* --- LVGL task ------------------------------------------------------------ */

/* --- the lights along the bottom ------------------------------------------ */

/*
 * The light grid and the 4x gain below are COPIED from
 * platforms/iterate_stackchan_avatar, on purpose and for now: the two boards
 * should say the same things in the same visual language. Where the shared
 * version of this lives is a later change; copying it first is how we find out
 * whether it really is the same thing on a screen this shape.
 *
 * What did NOT come across is that adapter's 3x5 alphabet. It was here for one
 * revision, drawing three-letter hints beside each physical button, and the hints
 * are gone — so the font went with them rather than sitting in the file waiting
 * to be useful.
 */
struct light_surface {
  uint16_t *pixels;
  int32_t width;
  int32_t height;
};

/* Static rather than allocated: a hundred points cannot justify a failure path,
 * and lights that vanished because a heap was tight would take the screen's only
 * remaining indication of what the device is doing with them. */
static uint16_t lights_pixels[LIGHTS_WIDTH * LIGHTS_HEIGHT]
    __attribute__((aligned(8)));

static const struct light_surface lights_surface = {
    lights_pixels, LIGHTS_WIDTH, LIGHTS_HEIGHT};

static lv_obj_t *lights_canvas;

static uint16_t rail_colour(uint8_t red, uint8_t green, uint8_t blue) {
  return (uint16_t)(
      ((uint16_t)(red >> 3) << 11) | ((uint16_t)(green >> 2) << 5) |
      (uint16_t)(blue >> 3));
}

static uint16_t rail_colour_hex(uint32_t rgb) {
  return rail_colour(
      (uint8_t)((rgb >> 16) & 0xffU),
      (uint8_t)((rgb >> 8) & 0xffU),
      (uint8_t)(rgb & 0xffU));
}

static void surface_fill(
    const struct light_surface *surface,
    int32_t x,
    int32_t y,
    int32_t width,
    int32_t height,
    uint16_t colour) {
  int32_t row;
  assert(surface != NULL);
  for (row = 0; row < height; ++row) {
    const int32_t at_y = y + row;
    int32_t column;
    if (at_y < 0 || at_y >= surface->height) continue;
    for (column = 0; column < width; ++column) {
      const int32_t at_x = x + column;
      if (at_x < 0 || at_x >= surface->width) continue;
      surface->pixels[at_y * surface->width + at_x] = colour;
    }
  }
}

/*
 * WHAT IS HAPPENING, in the fewest words that answer it.
 *
 * `call_active` and not the UI state decides whether this says "in call",
 * because the state alone cannot: a call that has been accepted and is waiting
 * for somebody to press talk sits in IDLE, which is also what no call at all
 * looks like. That ambiguity is exactly what made the previous screen unusable.
 */
static const char *bar_state_text(
    enum waveshare_ui_state state,
    bool link_ready,
    bool call_active,
    bool talk_held) {
  if (state == WAVESHARE_UI_MENU) return "menu";
  /*
   * THE LINK COMES FIRST, ahead of anything the state says.
   *
   * "Ready" on a device the server is refusing is the one lie this screen must
   * not tell: every control on it needs that link, so a person pressing them
   * gets silence and no explanation. Measured: the board read "ready" while the
   * console logged "authentication rejected" every three and a half seconds.
   */
  if (!link_ready) return "offline";
  if (!call_active) {
    return state == WAVESHARE_UI_CONNECTING ? "connecting" : "ready";
  }
  if (talk_held) return "in call - listening";
  return state == WAVESHARE_UI_SPEAKING ? "in call - speaking" : "in call";
}

static uint32_t bar_state_colour(
    enum waveshare_ui_state state, bool link_ready, bool call_active) {
  if (state == WAVESHARE_UI_MENU) return 0xe8eaed;
  /* Red, and the only red on this screen: the one state a person cannot wait
   * out, and the only one that means go and look at the server. */
  if (!link_ready) return 0xf87171;
  if (!call_active) {
    return state == WAVESHARE_UI_CONNECTING ? 0xfbbf24 : 0x8a8f98;
  }
  return 0x4ade80;
}

/*
 * WHAT THE CONTROLS DO RIGHT NOW.
 *
 * All three of them, named by where they are rather than by what they are: a
 * person holding this board can see a top button, a bottom button and a screen,
 * and does not know which pin is BOOT. Rewritten on every state change because
 * the answer genuinely differs — the top button talks during a call and calls
 * outside one, and the same tap starts and ends.
 */
static const char *bar_controls_text(
    enum waveshare_ui_state state, bool link_ready, bool call_active) {
  /*
   * ASCII ONLY, and that is a hard rule for anything drawn here.
   *
   * These separators were middle dots (U+00B7), which is not in the compiled
   * montserrat glyph range — LVGL drew its missing-glyph rectangle instead, so
   * the bar read "tap or top: call [] bottom: menu". A font subset is chosen at
   * build time by Kconfig; anything outside it fails this way, visibly and
   * silently.
   */
  if (state == WAVESHARE_UI_MENU) return "top: choose   /   bottom: next";
  /*
   * With no link this row gives up its space to the REASON, which the caller
   * puts in the status line. Naming the controls would be worse than useless:
   * every one of them needs the server that is not answering.
   */
  if (!link_ready) return NULL;
  if (call_active) return "tap: hang up   /   top: hold to talk   /   bottom: menu";
  return "tap or top: call   /   bottom: menu";
}

/*
 * The lights' own view of the device, derived rather than published.
 *
 * Every field here is something this module was already told in order to draw
 * the headline, the status line and the buttons. Asking main.c for a second,
 * parallel description of the same facts would create two truths about one
 * device, and the screen would eventually show the older one.
 */
static void rail_visual_state(
    enum waveshare_ui_state state,
    bool call_active,
    bool talk_held,
    struct iterate_kit_conversation_visual_state *out) {
  memset(out, 0, sizeof(*out));
  out->network = state == WAVESHARE_UI_CONNECTING
      ? ITERATE_KIT_NETWORK_CONNECTING
      : ITERATE_KIT_NETWORK_CONNECTED;
  out->conversation_active = call_active;
  /* The bridge accepting the call IS this device's media being ready. */
  out->media_ready = call_active;
  out->microphone_listening = talk_held;
  /*
   * The speaker meter comes from the pose, which is driven by audio that
   * reached the DAC — so a lit speaker sector means sound was played, not that
   * a packet arrived. Zero while no call is up, because the level decays
   * rather than snapping, and a meter still twitching after a hang-up would be
   * describing a call that has gone.
   */
  out->speaker_peak = call_active ? waveshare_avatar_speaker_level() : 0U;
}

/*
 * Shared ring colours are dim enough for exposed LEDs in a room; an LCD
 * subpixel over a dark screen needs more drive. The same bounded 4x gain the
 * StackChan adapter applies, so the semantic colours and bands stay shared and
 * only the output medium differs.
 */
static uint8_t rail_light_component(uint8_t component) {
  return component > UINT8_MAX / 4U ? UINT8_MAX : (uint8_t)(component * 4U);
}

static void paint_lights(
    const struct iterate_kit_conversation_visual_state *visual,
    uint32_t background) {
  struct iterate_kit_rgb8 lights[ITERATE_KIT_CONVERSATION_LIGHT_COUNT];
  uint32_t index;

  surface_fill(
      &lights_surface, 0, 0, LIGHTS_WIDTH, LIGHTS_HEIGHT,
      rail_colour_hex(background));
  iterate_kit_conversation_lights_render(visual, lights);
  /*
   * One row, left to right, in the shared model's sector order: network,
   * speaker, microphone, spare. The fourth sector stays dark until it means
   * something, exactly as that model says — so an idle, connected device shows
   * three green dots and nine unlit ones.
   */
  for (index = 0U; index < (uint32_t)ITERATE_KIT_CONVERSATION_LIGHT_COUNT;
       ++index) {
    surface_fill(
        &lights_surface,
        (int32_t)index * (LIGHT_SIZE + LIGHT_GAP),
        0,
        LIGHT_SIZE,
        LIGHT_SIZE,
        rail_colour(
            rail_light_component(lights[index].red),
            rail_light_component(lights[index].green),
            rail_light_component(lights[index].blue)));
  }
  lv_obj_invalidate(lights_canvas);
}

/* --- the menu screen ------------------------------------------------------ */

/*
 * Menu geometry, in points of the 368x448 portrait panel.
 *
 * THE MENU TAKES THE WHOLE SCREEN, INCLUDING THE FACE. For one revision it was
 * a panel in the lower half with the face still above it, on the reasoning that
 * a menu is something the device shows you rather than somewhere it goes. In the
 * hand that was wrong twice over: four options and an info block in half a
 * screen have to be set too small to read at arm's length, and the face — the
 * one thing that does not help you choose — was taking the good half.
 *
 * So the options are back at montserrat_28, which is what they were when this
 * screen was all there was, and the face is hidden while they are up.
 *
 * Everything is still one flex column: at these sizes a path that wrapped to a
 * second row would otherwise draw over the first option, and stacking makes
 * that impossible rather than unlikely.
 */
enum {
  MENU_CONTENT_WIDTH = MENU_CONTENT_WIDTH_AVAILABLE,
  MENU_INFO_Y = 8,
  MENU_INFO_GAP = 6,
  /* The context block is small text on several lines; it needs air between. */
  MENU_INFO_LINE_SPACE = 3,
  MENU_ROW_GAP = 8,
  MENU_ROW_PAD_X = 12,
  MENU_ROW_PAD_Y = 6,
  MENU_ROW_RADIUS = 8,
  /*
   * Characters of stream path kept.
   *
   * Set to what ONE row holds at montserrat_20 across 352 points, because the
   * paths this device gives itself now fit that: `/agents/voice/` plus a
   * timestamp is 31 characters. A longer one still wraps rather than being cut
   * off — fit_path drops the HEAD, which is the part every path shares.
   */
  MENU_PATH_COLUMNS = 28,
  MENU_ELLIPSIS_CHARS = 3,
};

/* Menu colours, as 24-bit RGB. */
enum {
  MENU_PATH_RGB = 0xe8eaed,
  MENU_CONTEXT_RGB = 0x8a8f98,
  MENU_ROW_RGB = 0xe8eaed,
  MENU_CURSOR_BG_RGB = 0xe8eaed,
  /* The screen's own background, so the selected row reads as a hole in it. */
  MENU_CURSOR_TEXT_RGB = SCREEN_BACKGROUND_RGB,
};

/** Which of the two looks a row wears; the caller acts on the difference. */
enum menu_row_style {
  MENU_ROW_PLAIN = 0,
  MENU_ROW_CURSOR,
};

/**
 * Fit a stream path by dropping its HEAD.
 *
 * Every path this device is given begins the same way — /agents/voice/… — and
 * ends in the id that says which conversation it is, so the usual truncation
 * would turn three different streams into three identical-looking rows and
 * leave the person choosing between them with nothing to choose on.
 */
static void fit_path(char *out, size_t capacity, const char *path) {
  const size_t columns = (size_t)MENU_PATH_COLUMNS;
  size_t length;
  assert(out != NULL);
  assert(path != NULL);
  assert(capacity > columns);
  length = strlen(path);
  if (length <= columns) {
    snprintf(out, capacity, "%s", path);
    return;
  }
  snprintf(
      out,
      capacity,
      "...%s",
      path + length - (columns - (size_t)MENU_ELLIPSIS_CHARS));
}

static void set_hidden(lv_obj_t *object, bool hidden) {
  assert(object != NULL);
  if (hidden) {
    lv_obj_add_flag(object, LV_OBJ_FLAG_HIDDEN);
    return;
  }
  lv_obj_clear_flag(object, LV_OBJ_FLAG_HIDDEN);
}

/*
 * The menu takes the screen, and the face goes away while it is up.
 *
 * The face is the reason there is nothing else on this screen; it is also the
 * reason there is no room for a legible menu beside it. While somebody is
 * choosing, the choices ARE the screen. The lights stay: what the device is
 * doing does not stop being true because a menu is open.
 */
static void show_menu_screen(bool visible) {
  set_hidden(menu_info, !visible);
  if (face_canvas != NULL) set_hidden(face_canvas, visible);
}

static void style_menu_row(lv_obj_t *row, enum menu_row_style style) {
  const bool cursor = style == MENU_ROW_CURSOR;
  assert(row != NULL);
  /*
   * The cursor is the whole row inverted, not a marker in front of it. On a
   * 1.8" panel a leading glyph is a smudge in a photograph, and a photograph
   * of this screen is how anyone away from the device knows which option it
   * is about to take.
   */
  lv_obj_set_style_bg_opa(
      row, (lv_opa_t)(cursor ? LV_OPA_COVER : LV_OPA_TRANSP), 0);
  lv_obj_set_style_text_color(
      row,
      lv_color_hex((uint32_t)(cursor ? MENU_CURSOR_TEXT_RGB : MENU_ROW_RGB)),
      0);
}

/*
 * A bare column.
 *
 * Bare because lv_obj's default look is a pale rounded card with a border,
 * which on this background reads as a box somebody drew around the contents.
 * A column because both blocks stack text whose height depends on how much of
 * it there is — the path wraps, and so does the longest option — and fixed
 * offsets would have one block draw over the next the first time it did.
 */
static lv_obj_t *build_column(int32_t y, int32_t row_gap) {
  lv_obj_t *column = lv_obj_create(screen_root);
  lv_obj_remove_style_all(column);
  lv_obj_set_size(column, MENU_CONTENT_WIDTH, LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(column, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_row(column, row_gap, 0);
  lv_obj_clear_flag(column, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_align(column, LV_ALIGN_TOP_LEFT, 0, y);
  return column;
}

/* A line of text in a column: full width, so it wraps at the screen edge
 * rather than at whatever the longest word happens to be. */
static lv_obj_t *build_menu_text(
    lv_obj_t *parent, const lv_font_t *font, uint32_t rgb) {
  lv_obj_t *label;
  assert(parent != NULL);
  assert(font != NULL);
  label = lv_label_create(parent);
  lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP);
  lv_obj_set_width(label, lv_pct(100));
  lv_label_set_text(label, "");
  lv_obj_set_style_text_color(label, lv_color_hex(rgb), 0);
  lv_obj_set_style_text_font(label, font, 0);
  return label;
}

/*
 * One option.
 *
 * 22: the menu owns the screen so it can afford to be read at arm's length,
 * but 28 — the largest font compiled in — made five options feel like a
 * shouting match, and five of them at that size do not fit above the bar.
 *
 * Wrapping rather than clipping: an option that says "new conversatio" is a
 * different promise from the one the menu is making.
 */
static lv_obj_t *build_menu_row(void) {
  lv_obj_t *row;
  assert(menu_options != NULL);
  row = build_menu_text(menu_options, &lv_font_montserrat_22, MENU_ROW_RGB);
  lv_obj_set_style_pad_hor(row, MENU_ROW_PAD_X, 0);
  lv_obj_set_style_pad_ver(row, MENU_ROW_PAD_Y, 0);
  lv_obj_set_style_radius(row, MENU_ROW_RADIUS, 0);
  /* Only the opacity moves between plain and cursor, so the fill colour is
   * set once here — every style setter invalidates its object, changed or
   * not, and the cursor moves on every press of the lower button. */
  lv_obj_set_style_bg_color(row, lv_color_hex(MENU_CURSOR_BG_RGB), 0);
  style_menu_row(row, MENU_ROW_PLAIN);
  return row;
}

/*
 * Built once at start-up and then only hidden, rather than created when the
 * menu opens: this screen appears on every press of the lower button between
 * calls, and building it there would put a dozen allocations on the LVGL heap
 * in the middle of the frame the person is waiting to see.
 */
static void build_menu(void) {
  uint8_t index;
  menu_info = build_column(MENU_INFO_Y, MENU_INFO_GAP);
  menu_path_label =
      build_menu_text(menu_info, &lv_font_montserrat_20, MENU_PATH_RGB);
  menu_context_label =
      build_menu_text(menu_info, &lv_font_montserrat_16, MENU_CONTEXT_RGB);
  lv_obj_set_style_text_line_space(menu_context_label, MENU_INFO_LINE_SPACE, 0);
  /*
   * The status line, in the menu rather than on the main screen.
   *
   * Everything that sets it is describing something transient — "reconnecting",
   * "call ended", "could not ask the server" — and this is now the only place
   * those words can be seen. Dimmer than the context above it: it is the least
   * durable fact on the screen.
   */
  status_label =
      build_menu_text(menu_info, &lv_font_montserrat_16, MENU_CONTEXT_RGB);

  /*
   * A child of the info block rather than a second block at a fixed offset, so
   * that a path or a context line growing pushes the options DOWN instead of
   * being drawn over by them. See the geometry comment.
   */
  menu_options = lv_obj_create(menu_info);
  lv_obj_remove_style_all(menu_options);
  lv_obj_set_size(menu_options, lv_pct(100), LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(menu_options, LV_FLEX_FLOW_COLUMN);
  lv_obj_set_style_pad_row(menu_options, MENU_ROW_GAP, 0);
  lv_obj_set_style_pad_top(menu_options, MENU_ROW_GAP, 0);
  lv_obj_clear_flag(menu_options, LV_OBJ_FLAG_SCROLLABLE);
  for (index = 0U; index < (uint8_t)WAVESHARE_MENU_ITEMS_MAX; ++index) {
    menu_rows[index] = build_menu_row();
  }
  /* The published cursor starts on the first item; the screen agrees with it
   * before anything has been published. */
  style_menu_row(menu_rows[0], MENU_ROW_CURSOR);
  show_menu_screen(false);
}

static void paint_menu_row(const struct menu_snapshot *menu, uint8_t index) {
  lv_obj_t *row;
  assert(menu != NULL);
  assert(index < (uint8_t)WAVESHARE_MENU_ITEMS_MAX);
  row = menu_rows[index];
  /* An option the menu is not offering is hidden, not blanked, so the column
   * does not keep a gap where it used to be. */
  if (index >= menu->item_count) {
    set_hidden(row, true);
    return;
  }
  set_hidden(row, false);
  lv_label_set_text(row, menu->items[index]);
  style_menu_row(
      row, index == menu->selected ? MENU_ROW_CURSOR : MENU_ROW_PLAIN);
}

/*
 * Repaint only when the published menu differs from what is on the panel.
 *
 * Setting a label's text invalidates it whether or not the text changed, and
 * this runs on every publish of anything — so without the comparison a status
 * line ticking during a call would redraw the whole menu block sitting hidden
 * behind it, which is the flush storm refresh_ui's comment describes.
 */
static void paint_menu(const struct menu_snapshot *menu) {
  static struct menu_snapshot painted;
  char path[MENU_PATH_COLUMNS + 1];
  char context[MENU_CONTEXT_CHARS];
  uint8_t index;
  assert(menu != NULL);
  if (memcmp(menu, &painted, sizeof(painted)) == 0) return;
  painted = *menu;
  fit_path(path, sizeof(path), menu->stream_path);
  lv_label_set_text(menu_path_label, path);
  snprintf(
      context,
      sizeof(context),
      "%s\n%s  -  %s",
      menu->project,
      menu->environment,
      menu->connection);
  lv_label_set_text(menu_context_label, context);
  for (index = 0U; index < (uint8_t)WAVESHARE_MENU_ITEMS_MAX; ++index) {
    paint_menu_row(menu, index);
  }
}

/* --- the image overlay ---------------------------------------------------- */

enum {
  /* RGB565, which is what the panel takes and what a bitmap arrives as. */
  IMAGE_BYTES_PER_PIXEL = 2,
  /* Black, so an image smaller than the panel sits in a frame of nothing
   * rather than on whatever colour the setBackground tool last chose. */
  IMAGE_BACKDROP_RGB = 0x000000,
};

/*
 * One full-panel object over everything else, rather than another group
 * show_menu_screen hides and unhides.
 *
 * Covering the UI instead of replacing it is what makes the restore exact.
 * refresh_ui keeps painting the widgets underneath from the published snapshot
 * the whole time the image is up, so taking the overlay down reveals whatever
 * the device is doing NOW — a call that started while the picture was on
 * screen is already drawn behind it. There is no remembered state, so there is
 * nothing to go stale, and no way for a takedown to put an old headline back.
 *
 * It hangs off the screen rather than lv_layer_top() so that
 * waveshare_display_snapshot, which renders the active screen, sees the image
 * too: a screenshot showing the UI hidden behind it would be a screenshot of
 * something nobody is looking at.
 */
static void build_image_overlay(void) {
  assert(screen_root != NULL);
  /* Created last, so it is the last child of the screen and draws over its
   * siblings; nothing in this file reorders them afterwards. */
  image_overlay = lv_image_create(screen_root);
  lv_obj_remove_style_all(image_overlay);
  lv_obj_set_size(
      image_overlay, WAVESHARE_DISPLAY_WIDTH, WAVESHARE_DISPLAY_HEIGHT);
  /* The screen pads its content and this has to reach the bezel. The padding
   * is read back rather than repeated as a constant here, because two copies
   * of one number is how a full-screen overlay ends up with a 16-point seam. */
  lv_obj_align(
      image_overlay,
      LV_ALIGN_TOP_LEFT,
      -lv_obj_get_style_pad_left(screen_root, LV_PART_MAIN),
      -lv_obj_get_style_pad_top(screen_root, LV_PART_MAIN));
  lv_obj_set_style_bg_color(image_overlay, lv_color_hex(IMAGE_BACKDROP_RGB), 0);
  lv_obj_set_style_bg_opa(image_overlay, LV_OPA_COVER, 0);
  /* Centred, never fitted. Scaling up a small picture on a 368-point panel
   * turns it to mush, and which half of a large one to keep is not a question
   * the display can answer — so both are shown at their own size, or refused. */
  lv_image_set_inner_align(image_overlay, LV_IMAGE_ALIGN_CENTER);
  lv_obj_clear_flag(image_overlay, LV_OBJ_FLAG_SCROLLABLE);
  set_hidden(image_overlay, true);
}

/*
 * Point the overlay at `image`, or take it down when there are no pixels.
 *
 * One static descriptor serves every image. LVGL reads uncompressed RGB565
 * straight out of it — no decode, no copy — which is the only way a full-panel
 * picture fits on this board at all: 368x448 is 322 KiB, and the LVGL heap is
 * a fraction of that.
 */
static void paint_image(const struct image_snapshot *image) {
  static lv_image_dsc_t descriptor;
  assert(image != NULL);
  assert(image_overlay != NULL);
  if (image->pixels == NULL) {
    set_hidden(image_overlay, true);
    /* The source is dropped HERE, on the task that draws it, before the caller
     * is told the image is inactive. A source still pointing into a buffer the
     * caller has freed is one invalidated area away from being read. */
    lv_image_set_src(image_overlay, NULL);
    return;
  }
  descriptor.header.magic = LV_IMAGE_HEADER_MAGIC;
  descriptor.header.cf = LV_COLOR_FORMAT_RGB565;
  descriptor.header.w = image->width;
  descriptor.header.h = image->height;
  descriptor.header.stride = (uint16_t)(image->width * IMAGE_BYTES_PER_PIXEL);
  descriptor.data_size =
      (uint32_t)image->width * image->height * IMAGE_BYTES_PER_PIXEL;
  descriptor.data = (const uint8_t *)(const void *)image->pixels;
  /*
   * One descriptor can be reused because LVGL never keeps a decode of it: an
   * uncompressed variable image is drawn from the caller's memory directly, and
   * its decoder explicitly refuses to cache anything it can use in place. If
   * that ever changed, the second picture of a session would be the first one
   * again, and the fix would be to drop the descriptor from the image cache
   * here before pointing it somewhere new.
   */
  lv_image_set_src(image_overlay, &descriptor);
  set_hidden(image_overlay, false);
}

/*
 * Bring the overlay in line with what has been published, and expire it.
 *
 * The deadline is checked here, on the LVGL task, and not by whoever asked for
 * the image: an overlay that came down only when someone remembered to poll
 * would stay up for as long as the app loop was busy, and the app loop is the
 * thing that gets busy — it decodes speaker PCM.
 *
 * A takedown is two critical sections with the LVGL work between them, because
 * the pixels have to stop being a drawing source BEFORE the caller is told it
 * may free them. The second section re-checks the epoch, so an image published
 * while the previous one was coming down stays active instead of being
 * reported as finished — the caller would otherwise free the picture that is
 * about to go up.
 */
static void refresh_image(void) {
  static uint32_t painted_epoch;
  struct image_snapshot image;
  uint32_t epoch;

  xSemaphoreTake(ui.lock, portMAX_DELAY);
  /* Expiry is decided once, under the lock, so a show racing it either lands
   * first — moving the deadline out — or lands after, as a new image with its
   * own clock. It can never be half of both. */
  if (ui.image.pixels != NULL && now_ms() >= ui.image.deadline_ms) {
    ui.image.pixels = NULL;
    ++ui.image_epoch;
  }
  image = ui.image;
  epoch = ui.image_epoch;
  xSemaphoreGive(ui.lock);

  if (epoch == painted_epoch) return;
  painted_epoch = epoch;
  paint_image(&image);
  if (image.pixels != NULL) return;
  xSemaphoreTake(ui.lock, portMAX_DELAY);
  if (ui.image_epoch == epoch) ui.image_held = false;
  xSemaphoreGive(ui.lock);
}

static void build_ui(void) {
  screen_root = lv_screen_active();
  lv_obj_set_style_bg_color(screen_root, lv_color_hex(ui.background), 0);
  lv_obj_set_style_bg_opa(screen_root, LV_OPA_COVER, 0);
  lv_obj_set_style_pad_all(screen_root, SCREEN_PAD, 0);
  lv_obj_clear_flag(screen_root, LV_OBJ_FLAG_SCROLLABLE);

  /*
   * The face, and the only thing on this screen.
   *
   * A canvas rather than an image, because its pixels are produced here every
   * tick rather than compiled in — and at 160x120 scaled twice, so every source
   * pixel is a crisp 2x2 block with no resampling. Centred in what it has
   * rather than in the panel, which is not the same thing once the lights take
   * the bottom edge.
   */
  if (face_pixels != NULL) {
    face_canvas = lv_canvas_create(screen_root);
    lv_canvas_set_buffer(
        face_canvas, face_pixels, FACE_WIDTH, FACE_HEIGHT,
        LV_COLOR_FORMAT_RGB565);
    lv_obj_align(face_canvas, LV_ALIGN_CENTER, 0, FACE_CENTRE_OFFSET_Y);
  }

  /*
   * The bar: state and dots on one row, controls on the row under it. No panel
   * and no divider — the dots' surface is filled with the screen's own colour,
   * so what is visible is the marks and the words and nothing around them.
   */
  bar_state_label = lv_label_create(screen_root);
  lv_label_set_text(bar_state_label, "");
  lv_obj_set_style_text_font(bar_state_label, &lv_font_montserrat_16, 0);
  lv_obj_align(
      bar_state_label, LV_ALIGN_BOTTOM_LEFT, BAR_SIDE_INSET,
      BAR_STATE_BASELINE);

  bar_controls_label = lv_label_create(screen_root);
  lv_label_set_text(bar_controls_label, "");
  lv_obj_set_style_text_color(bar_controls_label, lv_color_hex(0x6b7280), 0);
  lv_obj_set_style_text_font(bar_controls_label, &lv_font_montserrat_14, 0);
  lv_obj_align(
      bar_controls_label, LV_ALIGN_BOTTOM_LEFT, BAR_SIDE_INSET,
      BAR_CONTROLS_BASELINE);

  lights_canvas = lv_canvas_create(screen_root);
  lv_canvas_set_buffer(
      lights_canvas, lights_pixels, LIGHTS_WIDTH, LIGHTS_HEIGHT,
      LV_COLOR_FORMAT_RGB565);
  /* Beside the state row rather than under it: the dots and the state word are
   * the same sentence, and the controls row is a different one. */
  lv_obj_align(
      lights_canvas, LV_ALIGN_BOTTOM_RIGHT, -BAR_SIDE_INSET,
      BAR_STATE_BASELINE + 4);

  /* Last, because it hides the widgets above it as its final act. */
  build_menu();
  /* After the menu, so the overlay is the newest child and covers it too. */
  build_image_overlay();
}

/*
 * Repaint the lights when what they would show changes. Runs every tick.
 *
 * Outside refresh_ui's dirty check, and for a sharp reason: the speaker meter is
 * read from the face's pose at paint time, so nothing publishes when it moves.
 * Change detection is `lights_equal` — VIEW equality, which treats two levels
 * inside one band as the same picture. Comparing the raw level instead would
 * repaint on every sample of a voice.
 */
static void refresh_lights(void) {
  static struct iterate_kit_conversation_visual_state shown_visual;
  static uint32_t shown_background = 0xffffffffU;
  static bool painted;
  struct iterate_kit_conversation_visual_state visual;
  enum waveshare_ui_state state;
  uint32_t background;
  bool call_active;
  bool talk_held;

  xSemaphoreTake(ui.lock, portMAX_DELAY);
  state = ui.state;
  background = ui.background;
  call_active = ui.call_active;
  talk_held = ui.talk_held;
  xSemaphoreGive(ui.lock);

  rail_visual_state(state, call_active, talk_held, &visual);
  if (!painted || background != shown_background ||
      !iterate_kit_conversation_lights_equal(&visual, &shown_visual)) {
    paint_lights(&visual, background);
    shown_visual = visual;
    shown_background = background;
    painted = true;
  }
}

static void refresh_ui(void) {
  static struct menu_snapshot menu;
  enum waveshare_ui_state state;
  uint32_t background;
  bool call_active;
  bool talk_held;
  bool link_ready;
  char status[STATUS_CHARS];

  xSemaphoreTake(ui.lock, portMAX_DELAY);
  if (!ui.dirty) {
    xSemaphoreGive(ui.lock);
    return;
  }
  ui.dirty = false;
  state = ui.state;
  background = ui.background;
  call_active = ui.call_active;
  talk_held = ui.talk_held;
  link_ready = ui.link_ready;
  memcpy(status, ui.status, sizeof(status));
  menu = ui.menu;
  xSemaphoreGive(ui.lock);

  /*
   * Only touch a widget whose value actually changed. A style setter
   * invalidates its object even when the value is identical, and setting the
   * screen's background colour invalidates the WHOLE screen — so re-applying
   * everything each tick meant a full-screen repaint on every update. At 20
   * lines per flush that is 23 transactions against a queue of 10, and the
   * excess fails; a failed flush never reports completion, so LVGL waits for
   * it forever and the panel freezes on the last good frame. That is exactly
   * the "stuck on connecting" symptom.
   */
  {
    static uint32_t shown_background = 0xffffffffU;
    static enum waveshare_ui_state shown_state = (enum waveshare_ui_state)-1;

    if (background != shown_background) {
      shown_background = background;
      lv_obj_set_style_bg_color(screen_root, lv_color_hex(background), 0);
    }
    if (state != shown_state) {
      shown_state = state;
      show_menu_screen(state == WAVESHARE_UI_MENU);
    }
    /* Both already skip identical text; the colour is guarded because a style
     * setter invalidates its object whether or not the value changed. */
    lv_label_set_text(
        bar_state_label,
        bar_state_text(state, link_ready, call_active, talk_held));
    {
      /* NULL means "show the reason instead" — see bar_controls_text. */
      const char *const controls =
          bar_controls_text(state, link_ready, call_active);
      lv_label_set_text(
          bar_controls_label, controls != NULL ? controls : status);
    }
    {
      const uint32_t colour =
          bar_state_colour(state, link_ready, call_active);
      static uint32_t shown_colour = 0xffffffffU;
      if (colour != shown_colour) {
        shown_colour = colour;
        lv_obj_set_style_text_color(
            bar_state_label, lv_color_hex(colour), 0);
      }
    }
    /* lv_label_set_text already skips identical text, and both of these are
     * inside the menu — hidden, and free to repaint, unless it is up. */
    lv_label_set_text(status_label, status);
    /* An empty status is not a blank row: the column would keep its height and
     * push the options down for a line that says nothing. */
    set_hidden(status_label, status[0] == '\0');
    paint_menu(&menu);
  }
}

/*
 * The SH8601 takes pixels over QSPI in even-aligned windows: a flush whose
 * left edge or width is odd lands shifted, which shows up as rectangles of
 * stale image where a label was redrawn. LVGL invalidates whatever bounds a
 * widget happens to have, so every invalidated area is snapped outwards here.
 */
static void align_invalidated_area(lv_event_t *event) {
  lv_area_t *area = lv_event_get_param(event);
  if (area == NULL) return;
  area->x1 &= ~1;
  area->y1 &= ~1;
  area->x2 |= 1;
  area->y2 |= 1;
}

/*
 * The snapshot is rendered HERE, on the LVGL task, not on whoever asked for
 * it. A full-frame lv_snapshot plus the downscale is tens of milliseconds of
 * work, and the task that dispatches capability calls is the same one that
 * decodes speaker PCM — so rendering on demand stalled the audio downlink
 * for the duration of every screenshot.
 */
/*
 * One frame of face, expanded onto the canvas only if it is a new picture.
 *
 * The renderer is asked for a frame every tick regardless, because its own
 * clock drives blinks and breathing and its mouth history has to keep moving —
 * but an unchanged frame stops here. A still face is the common case between
 * blinks, and expanding 38,400 points into 153,600 and invalidating them ten
 * times a second to draw the same picture is exactly the kind of load that
 * arrives later as an audio complaint.
 */
/*
 * How long the face stays awake-idle after boot or after the last call before
 * it dozes, in ms. Three deterministic minutes: long enough that a device
 * someone is still near keeps acting — breathing, glancing, shifting
 * expression on the renderer's own wall clock — and short enough that an
 * abandoned desk device closes its eyes within one cup of coffee.
 */
enum { FACE_DOZE_DELAY_MS = 3U * 60U * 1000U };

/* LVGL task only (refresh_face), so the stamp needs no lock. */
static bool face_awake(bool call_active) {
  /* Zero means boot, and boot earns the same awake-idle grace as a call. */
  static uint64_t last_call_ms;

  if (call_active) last_call_ms = now_ms();
  return call_active ||
         now_ms() - last_call_ms < (uint64_t)FACE_DOZE_DELAY_MS;
}

static void refresh_face(void) {
  int32_t source_y;
  bool call_active;
  bool awake;

  if (face_frame == NULL || face_pixels == NULL || face_shown == NULL) return;
  /*
   * A CALL IS WHAT BEING AWAKE MEANS, and this module is already the one that
   * knows — but falling asleep the instant a call ended (or the device booted)
   * made an idle device read as a dead one. The call fact still comes from the
   * one place that owns it; face_awake() merely lets that fact linger for a
   * few minutes of awake-idle acting before the shared doze face takes over.
   */
  xSemaphoreTake(ui.lock, portMAX_DELAY);
  call_active = ui.call_active;
  xSemaphoreGive(ui.lock);
  awake = face_awake(call_active);
  if (!waveshare_avatar_render(
          face_frame, (size_t)FACE_RENDER_PIXEL_COUNT, awake)) {
    return;
  }
  if (memcmp(face_frame, face_shown, (size_t)FACE_RENDER_FRAME_BYTES) == 0) {
    return;
  }
  memcpy(face_shown, face_frame, (size_t)FACE_RENDER_FRAME_BYTES);
  /*
   * Behind a full-screen image, or behind the menu, there is nothing to show —
   * but the frame above is still KEPT, so the face is current the moment the
   * picture comes down or the menu closes rather than a tick behind it.
   */
  if (lv_obj_has_flag(image_overlay, LV_OBJ_FLAG_HIDDEN) == false) return;
  if (lv_obj_has_flag(face_canvas, LV_OBJ_FLAG_HIDDEN)) return;

  for (source_y = 0; source_y < FACE_RENDER_HEIGHT; ++source_y) {
    uint16_t *const out =
        &face_pixels[(size_t)source_y * FACE_SCALE * FACE_WIDTH];
    const uint16_t *const in =
        &face_frame[(size_t)source_y * FACE_RENDER_WIDTH];
    int32_t source_x;
    int32_t repeat;
    for (source_x = 0; source_x < FACE_RENDER_WIDTH; ++source_x) {
      for (repeat = 0; repeat < FACE_SCALE; ++repeat) {
        out[source_x * FACE_SCALE + repeat] = in[source_x];
      }
    }
    /* The row is now correct; the rest of the block is a copy of it. */
    for (repeat = 1; repeat < FACE_SCALE; ++repeat) {
      memcpy(
          out + (size_t)repeat * FACE_WIDTH, out,
          (size_t)FACE_WIDTH * sizeof(*out));
    }
  }
  lv_obj_invalidate(face_canvas);
}

static void refresh_timer(lv_timer_t *timer) {
  (void)timer;
  refresh_ui();
  refresh_lights();
  refresh_face();
  /* Before the snapshot, so a screenshot taken on this tick shows the overlay
   * as it stands rather than one refresh behind it. */
  refresh_image();
  if (snapshot_requested && snapshot_pixels != NULL) {
    snapshot_requested = false;
    if (lv_snapshot_take_to_draw_buf(
            lv_screen_active(), LV_COLOR_FORMAT_RGB565, &snapshot_buf) ==
        LV_RESULT_OK) {
      const uint16_t *source = (const uint16_t *)(const void *)snapshot_buf.data;
      size_t y;
      for (y = 0U; y < (size_t)WAVESHARE_SNAPSHOT_HEIGHT; ++y) {
        size_t x;
        const uint16_t *row =
            &source[y * 2U * (snapshot_buf.header.stride / 2U)];
        for (x = 0U; x < (size_t)WAVESHARE_SNAPSHOT_WIDTH; ++x) {
          snapshot_scaled[y * (size_t)WAVESHARE_SNAPSHOT_WIDTH + x] =
              row[x * 2U];
        }
      }
      snapshot_ready = true;
    }
  }
}

bool waveshare_display_snapshot(uint8_t *out, size_t capacity) {
  const uint64_t deadline = (uint64_t)(esp_timer_get_time() / 1000) + 1000U;
  if (out == NULL || capacity < (size_t)WAVESHARE_SNAPSHOT_BYTES ||
      snapshot_scaled == NULL) {
    return false;
  }
  /* Ask the LVGL task for a fresh frame and wait for it, rather than
   * rendering one here — see refresh_timer. */
  snapshot_ready = false;
  snapshot_requested = true;
  while (!snapshot_ready) {
    if ((uint64_t)(esp_timer_get_time() / 1000) > deadline) return false;
    vTaskDelay(pdMS_TO_TICKS(10));
  }
  memcpy(out, snapshot_scaled, (size_t)WAVESHARE_SNAPSHOT_BYTES);
  return true;
}

/*
 * The panel, the touch controller and their neighbours come out of reset only
 * when EXIO0/1/2/6 on the board's TCA9554 are pulsed low and then high — the
 * sequence in Waveshare's own sketches. Nothing in the BSP does it (its
 * BSP_LCD_RST is "not connected"), and without it the panel stays dark no
 * matter what is written to it: the vendor's own LVGL demo is black too.
 */
static void release_board_resets(void) {
  const uint32_t pins = IO_EXPANDER_PIN_NUM_0 | IO_EXPANDER_PIN_NUM_1 |
      IO_EXPANDER_PIN_NUM_2 | IO_EXPANDER_PIN_NUM_6;
  esp_io_expander_handle_t expander = bsp_io_expander_init();
  if (expander == NULL) {
    ESP_LOGW(tag, "no io expander; panel may stay in reset");
    return;
  }
  (void)esp_io_expander_set_dir(expander, pins, IO_EXPANDER_OUTPUT);
  (void)esp_io_expander_set_level(expander, pins, 0);
  vTaskDelay(pdMS_TO_TICKS(20));
  (void)esp_io_expander_set_level(expander, pins, 1);
  vTaskDelay(pdMS_TO_TICKS(20));
}

bool waveshare_display_init(void) {
  ui.lock = xSemaphoreCreateMutex();
  if (ui.lock == NULL) return false;
  snprintf(ui.status, sizeof(ui.status), "starting");

  release_board_resets();
  /*
   * Deliberately NOT bsp_display_start(): that path registers this QSPI panel
   * through lvgl_port_add_disp_rgb(), which calls
   * esp_lcd_rgb_panel_register_event_callbacks() on a handle that is actually
   * a 64-byte sh8601_panel_t — five pointer stores past the end of the
   * allocation, corrupting the heap the SPI driver allocates from. It also
   * discards the caller's buffer flags (its private init takes no arguments),
   * leaving the draw buffer in PSRAM, which makes every flush allocate a
   * full-size internal bounce buffer and fail with "spi transmit (queue)
   * color failed" once that heap is tight. A failed flush leaves stale pixels
   * on the panel, which is what superimposed text is.
   *
   * This is the shape every working port of this board uses.
   */
  {
    esp_lcd_panel_handle_t panel = NULL;
    esp_lcd_panel_io_handle_t panel_io = NULL;
    const bsp_display_config_t panel_config = {0};
    const lvgl_port_cfg_t port_config = {
      .task_priority = 2,
      .task_stack = 8192,
      .task_affinity = 1, /* core 1 with the audio tasks, but below them */
      .task_max_sleep_ms = 500,
      .timer_period_ms = 5,
    };
    lvgl_port_display_cfg_t display_config;

    if (bsp_display_new(&panel_config, &panel, &panel_io) != ESP_OK) {
      ESP_LOGE(tag, "panel bring-up failed");
      return false;
    }
    if (lvgl_port_init(&port_config) != ESP_OK) {
      ESP_LOGE(tag, "lvgl port init failed");
      return false;
    }
    memset(&display_config, 0, sizeof(display_config));
    display_config.io_handle = panel_io;
    display_config.panel_handle = panel;
    /* 20 lines: 14720 bytes, comfortably inside the internal DMA heap, and a
     * whole-screen repaint is 23 flushes against a 10-deep queue only if the
     * driver has to bounce — which it no longer does. */
    display_config.buffer_size = BSP_LCD_H_RES * 20;
    display_config.double_buffer = false;
    display_config.hres = BSP_LCD_H_RES;
    display_config.vres = BSP_LCD_V_RES;
    display_config.color_format = LV_COLOR_FORMAT_RGB565;
    display_config.flags.buff_dma = true;
    display_config.flags.buff_spiram = false;
    display_config.flags.sw_rotate = false;
    display_config.flags.swap_bytes = true;
    if (lvgl_port_add_disp(&display_config) == NULL) {
      ESP_LOGE(tag, "lvgl display registration failed");
      return false;
    }
    /*
     * Touch is deliberately NOT registered.
     *
     * Nothing in this UI is touchable — both controls are physical buttons —
     * and the FT3168 sleeps between touches, NACKing every register read
     * while it does. esp_lvgl_port polls it with an INFINITE I2C timeout, on
     * the bus the codec, the PMIC and the talk button share, and it holds the
     * bus lock while it spins. That is a multi-second stall landing on
     * whatever else needs I2C, which is how a boot that should take five
     * seconds took twenty.
     */
  }
  (void)bsp_display_brightness_set(90);

  /*
   * Snapshots render at full resolution before being halved, and LVGL's own
   * heap is far too small for a 368x448 frame — so the buffer is ours, in
   * PSRAM, allocated once.
   */
  {
    const uint32_t stride = (uint32_t)WAVESHARE_DISPLAY_WIDTH * 2U;
    const size_t bytes = (size_t)stride * WAVESHARE_DISPLAY_HEIGHT;
    snapshot_pixels = heap_caps_malloc(bytes, MALLOC_CAP_SPIRAM);
    snapshot_scaled = heap_caps_malloc(
        (size_t)WAVESHARE_SNAPSHOT_BYTES, MALLOC_CAP_SPIRAM);
    if (snapshot_pixels != NULL && snapshot_scaled != NULL) {
      lv_draw_buf_init(
          &snapshot_buf,
          WAVESHARE_DISPLAY_WIDTH,
          WAVESHARE_DISPLAY_HEIGHT,
          LV_COLOR_FORMAT_RGB565,
          stride,
          snapshot_pixels,
          (uint32_t)bytes);
    } else {
      ESP_LOGW(tag, "no PSRAM for screenshots; takeScreenshot will fail");
    }
  }

  /*
   * The face's three buffers, in PSRAM and allocated once: what the canvas
   * shows, the frame the renderer just produced, and the frame already on
   * screen. 230 KiB, which is why they are not static — and why a board that
   * cannot spare them still gets a working screen without a face rather than no
   * screen at all.
   */
  {
    const size_t frame_bytes = (size_t)FACE_RENDER_FRAME_BYTES;
    face_pixels = heap_caps_malloc(
        (size_t)FACE_PIXELS * sizeof(*face_pixels), MALLOC_CAP_SPIRAM);
    face_frame = heap_caps_malloc(frame_bytes, MALLOC_CAP_SPIRAM);
    face_shown = heap_caps_malloc(frame_bytes, MALLOC_CAP_SPIRAM);
    if (face_pixels == NULL || face_frame == NULL || face_shown == NULL) {
      ESP_LOGE(tag, "no PSRAM for the face; the screen will be text only");
      heap_caps_free(face_pixels);
      heap_caps_free(face_frame);
      heap_caps_free(face_shown);
      face_pixels = NULL;
      face_frame = NULL;
      face_shown = NULL;
    } else if (!waveshare_avatar_init()) {
      /* Logged there. The canvas stays, blank, rather than the layout moving
       * underneath every other element on the screen. */
      memset(face_pixels, 0, (size_t)FACE_PIXELS * sizeof(*face_pixels));
    } else {
      memset(face_pixels, 0, (size_t)FACE_PIXELS * sizeof(*face_pixels));
      /* Impossible as a rendered frame, so the first real one always paints. */
      memset(face_shown, 0xff, frame_bytes);
    }
  }

  if (!bsp_display_lock(0)) {
    ESP_LOGE(tag, "lvgl lock failed");
    return false;
  }
  lv_display_add_event_cb(
      lv_display_get_default(),
      align_invalidated_area,
      LV_EVENT_INVALIDATE_AREA,
      NULL);
  build_ui();
  ui.dirty = true;
  refresh_ui();
  (void)lv_timer_create(refresh_timer, REFRESH_PERIOD_MS, NULL);
  bsp_display_unlock();

  ESP_LOGI(tag, "iterate UI up on %dx%d AMOLED",
           WAVESHARE_DISPLAY_WIDTH, WAVESHARE_DISPLAY_HEIGHT);
  return true;
}
