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
#include "iterate/kit/device_menu.h"
#include "lvgl.h"

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
  /* Each message is now two rows plus a blank one, so fewer fit. */
  TRANSCRIPT_LINES = 4,
  /*
   * Long enough for a whole answer. At 96 the line was hard-cut at ~90
   * characters (a 4-char speaker prefix eats into it), so any answer past
   * that appeared frozen on screen while the voice kept going — which reads
   * as stuck or duplicated text.
   */
  TRANSCRIPT_LINE_CHARS = 288,
  STATUS_CHARS = 64,
  /* How often the published snapshot is painted, in milliseconds. */
  REFRESH_PERIOD_MS = 100,
};

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

struct transcript_line {
  char text[TRANSCRIPT_LINE_CHARS];
  bool from_device_user;
  /*
   * Open-ness belongs to the LINE, not to the widget. It used to be one
   * global flag, so a user line arriving mid-answer closed the assistant's
   * growing line — and the next delta then started a NEW line containing the
   * whole accumulated answer again. That is the repeated text on screen.
   */
  bool open;
};

static struct {
  SemaphoreHandle_t lock;
  enum waveshare_ui_state state;
  char status[STATUS_CHARS];
  struct menu_snapshot menu;
  struct transcript_line lines[TRANSCRIPT_LINES];
  size_t line_count;
  uint32_t background;
  bool call_requested;
  bool call_active;
  bool talk_held;
  bool dirty;
} ui = {
  .background = 0x101820,
};

static lv_obj_t *screen_root;
static lv_obj_t *state_label;
static lv_obj_t *status_label;
static lv_obj_t *transcript_label;
static lv_obj_t *top_button_label;
static lv_obj_t *bottom_button_label;
static lv_obj_t *menu_info;
static lv_obj_t *menu_path_label;
static lv_obj_t *menu_context_label;
static lv_obj_t *menu_options;
static lv_obj_t *menu_rows[WAVESHARE_MENU_ITEMS_MAX];
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

static void set_call_active_locked(void *argument) {
  const bool active = *(bool *)argument;
  if (ui.call_active && !active) {
    /* A finished call's transcript belongs to that call, not the next one. */
    ui.line_count = 0U;
    memset(ui.lines, 0, sizeof(ui.lines));
  }
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

struct transcript_update {
  const char *speaker;
  const char *text;
  bool final;
};

static void push_transcript_locked(void *argument) {
  const struct transcript_update *update = argument;
  struct transcript_line *line;
  const bool is_user = update->speaker != NULL && update->speaker[0] == 'y';
  /*
   * A partial line is rewritten in place until it is marked final, so a
   * streaming reply grows on screen instead of stacking duplicates.
   */
  if (ui.line_count > 0U && ui.lines[ui.line_count - 1U].open &&
      ui.lines[ui.line_count - 1U].from_device_user == is_user) {
    line = &ui.lines[ui.line_count - 1U];
  } else {
    if (ui.line_count == TRANSCRIPT_LINES) {
      memmove(&ui.lines[0], &ui.lines[1], sizeof(ui.lines[0]) * (TRANSCRIPT_LINES - 1U));
      ui.line_count = TRANSCRIPT_LINES - 1U;
    }
    line = &ui.lines[ui.line_count++];
  }
  line->from_device_user = is_user;
  /* Label on its own row; refresh_ui puts a blank row between messages. */
  snprintf(
      line->text,
      sizeof(line->text),
      "%s\n%s",
      is_user ? "you:" : "iterate:",
      update->text);
  line->open = !update->final;
}

void waveshare_display_push_transcript(
    const char *speaker, const char *text, bool final) {
  struct transcript_update update = {speaker, text, final};
  publish(push_transcript_locked, &update);
}

/* --- LVGL task ------------------------------------------------------------ */

static const char *state_text(enum waveshare_ui_state state) {
  switch (state) {
    case WAVESHARE_UI_CONNECTING: return "connecting";
    case WAVESHARE_UI_IDLE: return "ready";
    case WAVESHARE_UI_LISTENING: return "listening";
    case WAVESHARE_UI_SPEAKING: return "speaking";
    default: return "";
  }
}

static uint32_t state_colour(enum waveshare_ui_state state) {
  switch (state) {
    case WAVESHARE_UI_CONNECTING: return 0x8a8f98;
    case WAVESHARE_UI_IDLE: return 0xe8eaed;
    case WAVESHARE_UI_LISTENING: return 0x4ade80;
    case WAVESHARE_UI_SPEAKING: return 0x60a5fa;
    default: return 0xffffff;
  }
}

/* --- the menu screen ------------------------------------------------------ */

/* Menu geometry, in points of the 368x448 portrait panel. */
enum {
  /* The screen's own padding is 16 on each side. */
  MENU_CONTENT_WIDTH = WAVESHARE_DISPLAY_WIDTH - 32,
  MENU_INFO_Y = 28,
  MENU_INFO_GAP = 6,
  /* The context block is two lines of small text; they need air between. */
  MENU_INFO_LINE_SPACE = 3,
  /*
   * Far enough down that the info block can grow to a wrapped path and two
   * context lines without reaching the options, and high enough that three
   * options — one of which wraps — stay clear of the lower button's label.
   */
  MENU_OPTIONS_Y = 130,
  MENU_ROW_GAP = 12,
  MENU_ROW_PAD_X = 12,
  MENU_ROW_PAD_Y = 10,
  MENU_ROW_RADIUS = 8,
  /*
   * Characters of stream path kept. The label wraps, so a path this long is
   * still shown in full, over two rows; the limit only exists so that a path
   * nobody expected cannot push the options off the bottom of the screen.
   */
  MENU_PATH_COLUMNS = 44,
  MENU_ELLIPSIS_CHARS = 3,
};

/* Menu colours, as 24-bit RGB. */
enum {
  MENU_PATH_RGB = 0xe8eaed,
  MENU_CONTEXT_RGB = 0x8a8f98,
  MENU_ROW_RGB = 0xe8eaed,
  MENU_CURSOR_BG_RGB = 0xe8eaed,
  /* The screen's own background, so the selected row reads as a hole in it. */
  MENU_CURSOR_TEXT_RGB = 0x101820,
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
 * The menu takes the screen over rather than sharing it. The headline, the
 * status line and the transcript all describe a call, and leaving them under
 * options set in a size that can be read at arm's length is how 368 points of
 * width becomes a screen with nothing legible on it.
 */
static void show_menu_screen(bool visible) {
  set_hidden(menu_info, !visible);
  set_hidden(menu_options, !visible);
  set_hidden(state_label, visible);
  set_hidden(status_label, visible);
  set_hidden(transcript_label, visible);
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
 * One option, in the largest font this build carries.
 *
 * Wrapping rather than clipping: "continue conversation" is wider than the
 * screen at this size, and an option that says "continue conversatio" is a
 * different promise from the one the menu is making.
 */
static lv_obj_t *build_menu_row(void) {
  lv_obj_t *row;
  assert(menu_options != NULL);
  row = build_menu_text(menu_options, &lv_font_montserrat_28, MENU_ROW_RGB);
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
      build_menu_text(menu_info, &lv_font_montserrat_16, MENU_PATH_RGB);
  menu_context_label =
      build_menu_text(menu_info, &lv_font_montserrat_14, MENU_CONTEXT_RGB);
  lv_obj_set_style_text_line_space(menu_context_label, MENU_INFO_LINE_SPACE, 0);

  menu_options = build_column(MENU_OPTIONS_Y, MENU_ROW_GAP);
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

/*
 * What the two physical buttons do right now. In the menu they are the menu's
 * two verbs — cycle and choose — and a label still offering "call" there
 * describes a button that would do something else entirely.
 */
static const char *top_button_text(
    enum waveshare_ui_state state, bool call_requested) {
  if (state == WAVESHARE_UI_MENU) return "select  >";
  return call_requested ? "end call  >" : "call  >";
}

static const char *bottom_button_text(
    enum waveshare_ui_state state, bool talk_held) {
  if (state == WAVESHARE_UI_MENU) return "next  >";
  return talk_held ? "talking  >" : "talk  >";
}

static void build_ui(void) {
  screen_root = lv_screen_active();
  lv_obj_set_style_bg_color(screen_root, lv_color_hex(ui.background), 0);
  lv_obj_set_style_bg_opa(screen_root, LV_OPA_COVER, 0);
  lv_obj_set_style_pad_all(screen_root, 16, 0);
  lv_obj_clear_flag(screen_root, LV_OBJ_FLAG_SCROLLABLE);

  lv_obj_t *brand = lv_label_create(screen_root);
  lv_label_set_text(brand, "iterate");
  lv_obj_set_style_text_color(brand, lv_color_hex(0x8a8f98), 0);
  lv_obj_set_style_text_font(brand, &lv_font_montserrat_16, 0);
  lv_obj_align(brand, LV_ALIGN_TOP_LEFT, 0, 0);

  state_label = lv_label_create(screen_root);
  lv_label_set_text(state_label, state_text(WAVESHARE_UI_CONNECTING));
  lv_obj_set_style_text_font(state_label, &lv_font_montserrat_28, 0);
  lv_obj_align(state_label, LV_ALIGN_TOP_LEFT, 0, 28);

  status_label = lv_label_create(screen_root);
  lv_label_set_text(status_label, "");
  lv_obj_set_style_text_color(status_label, lv_color_hex(0x8a8f98), 0);
  lv_obj_set_style_text_font(status_label, &lv_font_montserrat_14, 0);
  lv_obj_align(status_label, LV_ALIGN_TOP_LEFT, 0, 66);

  transcript_label = lv_label_create(screen_root);
  lv_label_set_long_mode(transcript_label, LV_LABEL_LONG_WRAP);
  lv_obj_set_width(transcript_label, WAVESHARE_DISPLAY_WIDTH - 32 - 56);
  lv_label_set_text(transcript_label, "");
  lv_obj_set_style_text_color(transcript_label, lv_color_hex(0xe8eaed), 0);
  lv_obj_set_style_text_font(transcript_label, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_line_space(transcript_label, 3, 0);
  lv_obj_align(transcript_label, LV_ALIGN_TOP_LEFT, 0, 100);

  /*
   * The two physical buttons live on the right edge, so their labels sit
   * against that edge at the height of the button they name.
   */
  top_button_label = lv_label_create(screen_root);
  lv_label_set_text(top_button_label, "call  >");
  lv_obj_set_style_text_color(top_button_label, lv_color_hex(0x8a8f98), 0);
  lv_obj_set_style_text_font(top_button_label, &lv_font_montserrat_14, 0);
  lv_obj_align(top_button_label, LV_ALIGN_TOP_RIGHT, 0, 4);

  bottom_button_label = lv_label_create(screen_root);
  lv_label_set_text(bottom_button_label, "talk  >");
  lv_obj_set_style_text_color(bottom_button_label, lv_color_hex(0x8a8f98), 0);
  lv_obj_set_style_text_font(bottom_button_label, &lv_font_montserrat_14, 0);
  lv_obj_align(bottom_button_label, LV_ALIGN_BOTTOM_RIGHT, 0, -24);

  /* Last, because it hides the widgets above it as its final act. */
  build_menu();
}

static void refresh_ui(void) {
  static char transcript[TRANSCRIPT_LINES * TRANSCRIPT_LINE_CHARS];
  static struct menu_snapshot menu;
  enum waveshare_ui_state state;
  uint32_t background;
  bool call_requested;
  bool call_active;
  bool talk_held;
  char status[STATUS_CHARS];
  size_t offset = 0U;
  size_t index;

  xSemaphoreTake(ui.lock, portMAX_DELAY);
  if (!ui.dirty) {
    xSemaphoreGive(ui.lock);
    return;
  }
  ui.dirty = false;
  state = ui.state;
  background = ui.background;
  call_requested = ui.call_requested;
  call_active = ui.call_active;
  talk_held = ui.talk_held;
  memcpy(status, ui.status, sizeof(status));
  menu = ui.menu;
  transcript[0] = '\0';
  for (index = 0U; index < ui.line_count; ++index) {
    const int written = snprintf(
        transcript + offset,
        sizeof(transcript) - offset,
        "%s%s",
        index == 0U ? "" : "\n\n", /* blank row between messages */
        ui.lines[index].text);
    if (written < 0 || (size_t)written >= sizeof(transcript) - offset) break;
    offset += (size_t)written;
  }
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
    static bool shown_talk_held;
    static bool shown_call_active;
    static bool shown_call_requested;

    if (background != shown_background) {
      shown_background = background;
      lv_obj_set_style_bg_color(screen_root, lv_color_hex(background), 0);
    }
    if (state != shown_state) {
      shown_state = state;
      show_menu_screen(state == WAVESHARE_UI_MENU);
      lv_label_set_text(state_label, state_text(state));
      lv_obj_set_style_text_color(
          state_label, lv_color_hex(state_colour(state)), 0);
    }
    /* lv_label_set_text already skips identical text. */
    lv_label_set_text(status_label, status);
    lv_label_set_text(transcript_label, transcript);
    paint_menu(&menu);
    lv_label_set_text(top_button_label, top_button_text(state, call_requested));
    lv_label_set_text(
        bottom_button_label, bottom_button_text(state, talk_held));
    if (talk_held != shown_talk_held || call_active != shown_call_active ||
        call_requested != shown_call_requested) {
      shown_talk_held = talk_held;
      shown_call_active = call_active;
      shown_call_requested = call_requested;
      lv_obj_set_style_text_color(
          bottom_button_label,
          lv_color_hex(talk_held ? 0x4ade80 : call_active ? 0xe8eaed : 0x8a8f98),
          0);
    }
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
static void refresh_timer(lv_timer_t *timer) {
  (void)timer;
  refresh_ui();
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
