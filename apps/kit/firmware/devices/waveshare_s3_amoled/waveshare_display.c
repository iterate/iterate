/*
 * The intentionally small Waveshare UI: one shared face and two status lines.
 *
 * The old reference target also contained a menu, screenshots, image download,
 * touch, recording and remote styling. None is required to hold a voice
 * conversation, and each kept network or storage work next to the audio loop.
 * This module therefore owns only the product state a person needs in hand.
 */
#include "waveshare_display.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "bsp/esp-bsp.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "iterate/kit/conversation_overlay.h"
#include "iterate/kit/face_wake.h"
#include "lvgl.h"
#include "waveshare_avatar.h"

static const char tag[] = "waveshare-ui";

enum {
  DISPLAY_WIDTH = 368,
  DISPLAY_HEIGHT = 448,
  FACE_SCALE = 2,
  /*
   * The card is the face PLUS a strip of status lights under it, drawn by the
   * shared overlay in source pixels so it scales with the face and is the
   * same code every other surface uses. It replaces a text label that said
   * "ready" — a word where twelve lights belong.
   */
  CARD_SOURCE_HEIGHT = FACE_RENDER_HEIGHT + ITERATE_KIT_OVERLAY_STRIP_HEIGHT,
  FACE_WIDTH = FACE_RENDER_WIDTH * FACE_SCALE,
  FACE_HEIGHT = CARD_SOURCE_HEIGHT * FACE_SCALE,
  STATUS_CAPACITY = 64,
  REFRESH_PERIOD_MS = 100,
};

_Static_assert(FACE_WIDTH <= DISPLAY_WIDTH, "face must fit panel width");
_Static_assert(FACE_HEIGHT < DISPLAY_HEIGHT, "face must leave room for status");

static struct {
  SemaphoreHandle_t lock;
  enum waveshare_ui_state state;
  char status[STATUS_CAPACITY];
  bool link_ready;
  bool call_active;
  bool call_requested;
  bool talk_held;
  /* Unrecoverable start-up fault; see waveshare_display_set_fault. */
  bool fault;
} ui;

static lv_obj_t *face_canvas;
static uint16_t *face_pixels;
static uint16_t *face_frame;
static uint16_t *face_shown;

static uint64_t now_ms(void) {
  return (uint64_t)(esp_timer_get_time() / 1000);
}

static void publish(void (*mutate)(void *), void *argument) {
  if (ui.lock == NULL) return;
  xSemaphoreTake(ui.lock, portMAX_DELAY);
  mutate(argument);
  xSemaphoreGive(ui.lock);
}

static void set_state_locked(void *argument) {
  ui.state = *(const enum waveshare_ui_state *)argument;
}

void waveshare_display_set_state(enum waveshare_ui_state state) {
  publish(set_state_locked, &state);
}

static void set_status_locked(void *argument) {
  const char *text = argument;
  (void)snprintf(
      ui.status, sizeof(ui.status), "%s", text == NULL ? "" : text);
}

void waveshare_display_set_status(const char *text) {
  publish(set_status_locked, (void *)(uintptr_t)text);
}

static void set_link_ready_locked(void *argument) {
  ui.link_ready = *(const bool *)argument;
}

static void set_fault_locked(void *argument) {
  (void)argument;
  ui.fault = true;
}

void waveshare_display_set_fault(void) {
  publish(set_fault_locked, NULL);
}

void waveshare_display_set_link_ready(bool ready) {
  publish(set_link_ready_locked, &ready);
}

static void set_call_active_locked(void *argument) {
  ui.call_active = *(const bool *)argument;
}

void waveshare_display_set_call_active(bool active) {
  publish(set_call_active_locked, &active);
}

static void set_call_requested_locked(void *argument) {
  ui.call_requested = *(const bool *)argument;
}

void waveshare_display_request_call(bool requested) {
  publish(set_call_requested_locked, &requested);
}

bool waveshare_display_call_requested(void) {
  bool requested = false;
  if (ui.lock == NULL) return false;
  xSemaphoreTake(ui.lock, portMAX_DELAY);
  requested = ui.call_requested;
  xSemaphoreGive(ui.lock);
  return requested;
}

static void set_talk_held_locked(void *argument) {
  ui.talk_held = *(const bool *)argument;
}

void waveshare_display_hold_talk(bool held) {
  publish(set_talk_held_locked, &held);
}

bool waveshare_display_talk_held(void) {
  bool held = false;
  if (ui.lock == NULL) return false;
  xSemaphoreTake(ui.lock, portMAX_DELAY);
  held = ui.talk_held;
  xSemaphoreGive(ui.lock);
  return held;
}

/* The shared snapshot: this panel's labels and the twelve-light rail must
 * agree, and both must agree with the ring on the other board. */
static struct iterate_kit_conversation_visual_state face_status(void) {
  struct iterate_kit_conversation_visual_state status = {0};
  xSemaphoreTake(ui.lock, portMAX_DELAY);
  status.network = ui.link_ready ? ITERATE_KIT_NETWORK_CONNECTED
                                 : ITERATE_KIT_NETWORK_CONNECTING;
  status.media_ready = ui.link_ready;
  status.media_failed = ui.fault;
  status.conversation_active = ui.call_active;
  status.microphone_listening =
      ui.talk_held || ui.state == WAVESHARE_UI_LISTENING;
  status.speaker_peak = ui.state == WAVESHARE_UI_SPEAKING ? 4096U : 0U;
  xSemaphoreGive(ui.lock);
  return status;
}

/*
 * NOTHING LEFT TO WRITE. The lights say connected or not, the banner says it
 * in words when it matters, and the face says whether a conversation is
 * happening. A status line under all three was a third copy of one fact —
 * "connecting" appearing in three places at once, none of which a person read
 * as more trustworthy than the others. Status strings still reach the console
 * log, where somebody debugging actually reads them.
 */
static void refresh_face(void) {
  int32_t source_y;
  static struct iterate_kit_face_wake wake;
  const struct iterate_kit_conversation_visual_state status = face_status();
  const uint64_t now = now_ms();

  if (face_pixels == NULL || face_frame == NULL || face_shown == NULL) return;
  if (!waveshare_avatar_render(
          face_frame, (size_t)FACE_RENDER_PIXEL_COUNT,
          iterate_kit_face_awake(&wake, status.conversation_active, now))) {
    return;
  }
  iterate_kit_conversation_overlay_render(
      &status,
      (uint32_t)now,
      ITERATE_KIT_OVERLAY_LIGHTS_STRIP,
      face_frame,
      (uint32_t)FACE_RENDER_WIDTH,
      (uint32_t)CARD_SOURCE_HEIGHT);
  {
    const size_t card_bytes =
        (size_t)FACE_RENDER_WIDTH * CARD_SOURCE_HEIGHT * sizeof(*face_frame);
    if (memcmp(face_frame, face_shown, card_bytes) == 0) return;
    memcpy(face_shown, face_frame, card_bytes);
  }
  for (source_y = 0; source_y < CARD_SOURCE_HEIGHT; ++source_y) {
    uint16_t *const output =
        &face_pixels[(size_t)source_y * FACE_SCALE * FACE_WIDTH];
    const uint16_t *const input =
        &face_frame[(size_t)source_y * FACE_RENDER_WIDTH];
    int32_t source_x;
    int32_t repeat;
    for (source_x = 0; source_x < FACE_RENDER_WIDTH; ++source_x) {
      for (repeat = 0; repeat < FACE_SCALE; ++repeat) {
        output[source_x * FACE_SCALE + repeat] = input[source_x];
      }
    }
    for (repeat = 1; repeat < FACE_SCALE; ++repeat) {
      memcpy(
          output + (size_t)repeat * FACE_WIDTH,
          output,
          (size_t)FACE_WIDTH * sizeof(*output));
    }
  }
  lv_obj_invalidate(face_canvas);
}

static void refresh_timer(lv_timer_t *timer) {
  (void)timer;
  refresh_face();
}

/*
 * Waveshare's examples pulse TCA9554 EXIO0/1/2/6 before panel creation. The
 * board BSP leaves BSP_LCD_RST disconnected, so omitting this source-derived
 * sequence leaves even the vendor LVGL demo black.
 */
static bool release_board_resets(void) {
  const uint32_t pins = IO_EXPANDER_PIN_NUM_0 | IO_EXPANDER_PIN_NUM_1 |
      IO_EXPANDER_PIN_NUM_2 | IO_EXPANDER_PIN_NUM_6;
  esp_io_expander_handle_t expander = bsp_io_expander_init();
  if (expander == NULL) return false;
  if (esp_io_expander_set_dir(expander, pins, IO_EXPANDER_OUTPUT) != ESP_OK ||
      esp_io_expander_set_level(expander, pins, 0) != ESP_OK) {
    return false;
  }
  vTaskDelay(pdMS_TO_TICKS(20));
  if (esp_io_expander_set_level(expander, pins, 1) != ESP_OK) return false;
  vTaskDelay(pdMS_TO_TICKS(20));
  return true;
}

static bool start_panel(void) {
  esp_lcd_panel_handle_t panel = NULL;
  esp_lcd_panel_io_handle_t panel_io = NULL;
  const bsp_display_config_t panel_config = {0};
  const lvgl_port_cfg_t port_config = {
    .task_priority = 2,
    .task_stack = 8192,
    .task_affinity = 1,
    .task_max_sleep_ms = 500,
    .timer_period_ms = 5,
  };
  lvgl_port_display_cfg_t display_config;

  if (bsp_display_new(&panel_config, &panel, &panel_io) != ESP_OK ||
      lvgl_port_init(&port_config) != ESP_OK) {
    return false;
  }
  memset(&display_config, 0, sizeof(display_config));
  display_config.io_handle = panel_io;
  display_config.panel_handle = panel;
  display_config.buffer_size = BSP_LCD_H_RES * 20;
  display_config.hres = BSP_LCD_H_RES;
  display_config.vres = BSP_LCD_V_RES;
  display_config.color_format = LV_COLOR_FORMAT_RGB565;
  display_config.flags.buff_dma = true;
  display_config.flags.swap_bytes = true;
  if (lvgl_port_add_disp(&display_config) == NULL) return false;
  return bsp_display_brightness_set(90) == ESP_OK;
}

static void build_ui(void) {
  lv_obj_t *screen = lv_screen_active();
  lv_obj_set_style_bg_color(screen, lv_color_black(), 0);
  lv_obj_set_style_bg_opa(screen, LV_OPA_COVER, 0);
  lv_obj_clear_flag(screen, LV_OBJ_FLAG_SCROLLABLE);

  if (face_pixels != NULL) {
    face_canvas = lv_canvas_create(screen);
    lv_canvas_set_buffer(
        face_canvas, face_pixels, FACE_WIDTH, FACE_HEIGHT,
        LV_COLOR_FORMAT_RGB565);
    /*
     * Centred, now that nothing sits under it. The 54-pixel top offset was
     * making room for two text labels that no longer exist — the lights and
     * the banner say what they said, inside the card itself.
     */
    lv_obj_align(face_canvas, LV_ALIGN_CENTER, 0, 0);
  }

}

bool waveshare_display_init(void) {
  ui.lock = xSemaphoreCreateMutex();
  if (ui.lock == NULL) return false;
  ui.state = WAVESHARE_UI_CONNECTING;
  (void)snprintf(ui.status, sizeof(ui.status), "starting");

  /* Display first is a correctness condition, not cosmetic ordering. */
  if (!release_board_resets() || !start_panel()) {
    ESP_LOGE(tag, "panel bring-up failed");
    return false;
  }

  face_pixels = heap_caps_calloc(
      (size_t)FACE_WIDTH * FACE_HEIGHT, sizeof(*face_pixels), MALLOC_CAP_SPIRAM);
  face_frame = heap_caps_calloc(
      (size_t)FACE_RENDER_WIDTH * CARD_SOURCE_HEIGHT,
      sizeof(*face_frame),
      MALLOC_CAP_SPIRAM);
  face_shown = heap_caps_malloc(
      (size_t)FACE_RENDER_WIDTH * CARD_SOURCE_HEIGHT * sizeof(*face_shown),
      MALLOC_CAP_SPIRAM);
  if (face_pixels == NULL || face_frame == NULL || face_shown == NULL ||
      !waveshare_avatar_init()) {
    ESP_LOGE(tag, "avatar allocation or initialization failed");
    return false;
  }
  memset(
      face_shown,
      0xff,
      (size_t)FACE_RENDER_WIDTH * CARD_SOURCE_HEIGHT * sizeof(*face_shown));

  if (!bsp_display_lock(0)) return false;
  build_ui();
  (void)lv_timer_create(refresh_timer, REFRESH_PERIOD_MS, NULL);
  bsp_display_unlock();
  ESP_LOGI(tag, "minimal Iterate UI ready");
  return true;
}
