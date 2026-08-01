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

#include "esp_lcd_touch.h"
#include "bsp/esp-bsp.h"
#include "bsp/touch.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lvgl.h"

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
      lv_label_set_text(state_label, state_text(state));
      lv_obj_set_style_text_color(
          state_label, lv_color_hex(state_colour(state)), 0);
    }
    /* lv_label_set_text already skips identical text. */
    lv_label_set_text(status_label, status);
    lv_label_set_text(transcript_label, transcript);
    lv_label_set_text(
        top_button_label, call_requested ? "end call  >" : "call  >");
    lv_label_set_text(
        bottom_button_label, talk_held ? "talking  >" : "talk  >");
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
    {
      esp_lcd_touch_handle_t touch = NULL;
      const bsp_touch_config_t touch_config = {0};
      if (bsp_touch_new(&touch_config, &touch) == ESP_OK && touch != NULL) {
        const lvgl_port_touch_cfg_t touch_port = {
          .disp = lv_display_get_default(),
          .handle = touch,
        };
        (void)lvgl_port_add_touch(&touch_port);
      } else {
        ESP_LOGW(tag, "touch controller not found; screen is display-only");
      }
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
  build_ui();
  ui.dirty = true;
  refresh_ui();
  (void)lv_timer_create(refresh_timer, REFRESH_PERIOD_MS, NULL);
  bsp_display_unlock();

  ESP_LOGI(tag, "iterate UI up on %dx%d AMOLED",
           WAVESHARE_DISPLAY_WIDTH, WAVESHARE_DISPLAY_HEIGHT);
  return true;
}
