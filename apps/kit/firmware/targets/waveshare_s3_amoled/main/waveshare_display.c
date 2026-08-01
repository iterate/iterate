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

#include <stdio.h>
#include <string.h>

#include "bsp/esp-bsp.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lvgl.h"

static const char tag[] = "waveshare-ui";

enum {
  TRANSCRIPT_LINES = 6,
  TRANSCRIPT_LINE_CHARS = 96,
  STATUS_CHARS = 64,
  /* How often the published snapshot is painted, in milliseconds. */
  REFRESH_PERIOD_MS = 100,
};

struct transcript_line {
  char text[TRANSCRIPT_LINE_CHARS];
  bool from_device_user;
};

static struct {
  SemaphoreHandle_t lock;
  enum waveshare_ui_state state;
  char status[STATUS_CHARS];
  struct transcript_line lines[TRANSCRIPT_LINES];
  size_t line_count;
  bool last_line_open; /* newest line is a growing partial */
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
static lv_obj_t *hint_label;
static lv_obj_t *top_button_label;
static lv_obj_t *bottom_button_label;
/* Snapshot staging: full-resolution RGB565 in PSRAM, reused per capture. */
static lv_draw_buf_t snapshot_buf;
static uint8_t *snapshot_pixels;

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

static void set_background_locked(void *argument) {
  ui.background = *(uint32_t *)argument;
}

void waveshare_display_set_background(uint32_t rgb) {
  publish(set_background_locked, &rgb);
}

static void set_call_active_locked(void *argument) {
  ui.call_active = *(bool *)argument;
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
  if (ui.last_line_open && ui.line_count > 0U &&
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
  snprintf(
      line->text,
      sizeof(line->text),
      "%s %s",
      is_user ? "you" : "grok",
      update->text);
  ui.last_line_open = !update->final;
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

  hint_label = lv_label_create(screen_root);
  lv_label_set_long_mode(hint_label, LV_LABEL_LONG_WRAP);
  lv_obj_set_width(hint_label, WAVESHARE_DISPLAY_WIDTH - 32);
  lv_label_set_text(hint_label, "");
  lv_obj_set_style_text_color(hint_label, lv_color_hex(0x8a8f98), 0);
  lv_obj_set_style_text_font(hint_label, &lv_font_montserrat_16, 0);
  lv_obj_align(hint_label, LV_ALIGN_BOTTOM_LEFT, 0, 0);
}

static void refresh_ui(void) {
  static char transcript[TRANSCRIPT_LINES * TRANSCRIPT_LINE_CHARS];
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
  transcript[0] = '\0';
  for (index = 0U; index < ui.line_count; ++index) {
    const int written = snprintf(
        transcript + offset,
        sizeof(transcript) - offset,
        "%s%s",
        index == 0U ? "" : "\n",
        ui.lines[index].text);
    if (written < 0 || (size_t)written >= sizeof(transcript) - offset) break;
    offset += (size_t)written;
  }
  xSemaphoreGive(ui.lock);

  lv_obj_set_style_bg_color(screen_root, lv_color_hex(background), 0);
  lv_label_set_text(state_label, state_text(state));
  lv_obj_set_style_text_color(state_label, lv_color_hex(state_colour(state)), 0);
  lv_label_set_text(status_label, status);
  lv_label_set_text(transcript_label, transcript);
  /* The buttons are physical; the screen only says what they do. */
  lv_label_set_text(
      hint_label,
      talk_held ? "release to send"
      : call_active ? "hold the lower button to talk"
      : call_requested ? "starting…"
                       : "press the upper button to call");
  lv_label_set_text(top_button_label, call_requested ? "end call  >" : "call  >");
  lv_obj_set_style_text_color(
      bottom_button_label,
      lv_color_hex(talk_held ? 0x4ade80 : call_active ? 0xe8eaed : 0x8a8f98),
      0);
  lv_label_set_text(bottom_button_label, talk_held ? "talking  >" : "talk  >");
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

static void refresh_timer(lv_timer_t *timer) {
  (void)timer;
  refresh_ui();
}

bool waveshare_display_snapshot(uint8_t *out, size_t capacity) {
  uint16_t *destination = (uint16_t *)(void *)out;
  const uint16_t *source;
  size_t y;

  if (out == NULL || capacity < (size_t)WAVESHARE_SNAPSHOT_BYTES ||
      snapshot_pixels == NULL) {
    return false;
  }
  if (!bsp_display_lock(1000)) {
    return false;
  }
  if (lv_snapshot_take_to_draw_buf(
          lv_screen_active(), LV_COLOR_FORMAT_RGB565, &snapshot_buf) !=
      LV_RESULT_OK) {
    bsp_display_unlock();
    return false;
  }
  bsp_display_unlock();

  /* Half scale: legible on a laptop, a quarter of the bytes to ship. */
  source = (const uint16_t *)(const void *)snapshot_buf.data;
  for (y = 0U; y < (size_t)WAVESHARE_SNAPSHOT_HEIGHT; ++y) {
    size_t x;
    const uint16_t *row =
        &source[y * 2U * (snapshot_buf.header.stride / 2U)];
    for (x = 0U; x < (size_t)WAVESHARE_SNAPSHOT_WIDTH; ++x) {
      destination[y * (size_t)WAVESHARE_SNAPSHOT_WIDTH + x] = row[x * 2U];
    }
  }
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
   * Not bsp_display_start(): its defaults put the LVGL draw buffers in PSRAM
   * and leave the LVGL task unpinned. PSRAM buffers make every flush do a
   * synchronous bounce-buffer memcpy into internal DMA memory on the LVGL
   * task, and an unpinned LVGL task migrates onto the audio core mid-flush.
   * Both show up as audio latency, not as a display fault.
   */
  {
    bsp_display_cfg_t cfg = {
      .lvgl_port_cfg = ESP_LVGL_PORT_INIT_CONFIG(),
      .buffer_size = BSP_LCD_H_RES * LVGL_BUFFER_HEIGHT,
      .double_buffer = true,
      .flags = {.buff_dma = true, .buff_spiram = false},
    };
    cfg.lvgl_port_cfg.task_affinity = 0; /* core 0: core 1 is the audio core */
    cfg.lvgl_port_cfg.task_priority = 3;
    if (bsp_display_start_with_config(&cfg) == NULL) {
      ESP_LOGE(tag, "bsp display start failed");
      return false;
    }
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
    if (snapshot_pixels != NULL) {
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
  lv_obj_invalidate(lv_screen_active()); /* paint the whole panel once */
  (void)lv_timer_create(refresh_timer, REFRESH_PERIOD_MS, NULL);
  bsp_display_unlock();

  ESP_LOGI(tag, "iterate UI up on %dx%d AMOLED",
           WAVESHARE_DISPLAY_WIDTH, WAVESHARE_DISPLAY_HEIGHT);
  return true;
}
