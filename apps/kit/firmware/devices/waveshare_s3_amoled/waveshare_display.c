/*
 * The intentionally small Waveshare UI: one shared face and twelve lights.
 *
 * The old reference target also contained a menu, screenshots, image download,
 * touch, recording and remote styling. None is required to hold a voice
 * conversation, and each kept network or storage work next to the audio loop.
 * This module therefore owns only the product state a person needs in hand.
 *
 * It draws with esp_lcd directly. It used to hold LVGL for exactly two
 * canvases and a flush pipeline; that cost 278 KB of flash, a 24 KB private
 * heap in internal RAM, and a port task on core 1 — the audio core — waking
 * a thousand times a second. Two rectangles a second do not need a UI
 * runtime: the face and the light strip are pushed as bounded strips from a
 * 100 ms task pinned to core 0, the same pattern StackChan's renderer
 * proved.
 */
#include "waveshare_display.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "bsp/esp-bsp.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "iterate/kit/conversation_overlay.h"
#include "iterate/kit/face_wake.h"
#include "iterate/kit/platforms/lcd_transfer.h"
#include "waveshare_avatar.h"

static const char tag[] = "waveshare-ui";

enum {
  DISPLAY_WIDTH = 368,
  DISPLAY_HEIGHT = 448,
  FACE_SCALE = 2,
  CARD_SOURCE_HEIGHT = FACE_RENDER_HEIGHT,
  FACE_WIDTH = FACE_RENDER_WIDTH * FACE_SCALE,
  FACE_HEIGHT = CARD_SOURCE_HEIGHT * FACE_SCALE,
  FACE_LEFT = (DISPLAY_WIDTH - FACE_WIDTH) / 2,
  FACE_TOP = (DISPLAY_HEIGHT - FACE_HEIGHT) / 2,
  /*
   * The status lights live at the BOTTOM OF THE PANEL, not under the chin.
   * Drawn into the face card they were glued to it and moved with it, which
   * makes them part of the picture; they belong to the device, so they sit at
   * the device's own edge — the same reasoning as the Stick's left-edge rail.
   */
  LIGHTS_WIDTH = DISPLAY_WIDTH,
  /*
   * Half-height marks flush with the bottom edge, not a row of squares. They
   * are a status bar, not twelve objects — small enough to read as one strip
   * of information under the face rather than as a second thing competing
   * with it.
   */
  LIGHTS_HEIGHT = 10,
  LIGHTS_TOP = DISPLAY_HEIGHT - LIGHTS_HEIGHT,
  STATUS_CAPACITY = 64,
  REFRESH_PERIOD_MS = 100,
  DISPLAY_TRANSFER_TIMEOUT_MS = 50,
  /* One bounded DMA strip, sized like the old flush buffer: 20 full rows. */
  STRIP_ROWS = 20,
};

_Static_assert(FACE_WIDTH <= DISPLAY_WIDTH, "face must fit panel width");
_Static_assert(FACE_HEIGHT < DISPLAY_HEIGHT, "face must leave room for status");

static struct {
  SemaphoreHandle_t lock;
  enum iterate_kit_voice_screen state;
  char status[STATUS_CAPACITY];
  bool link_ready;
  /*
   * The two rungs beneath a call. `link_ready` is true only when the WHOLE
   * chain is usable; these say which half of it is up.
   */
  bool api_ready;
  bool stream_ready;
  bool call_active;
  bool call_requested;
  struct iterate_kit_voice_view view;
  /* Startup or display-transfer fault; latched until reboot. */
  bool fault;
} ui;

static esp_lcd_panel_handle_t panel;
static esp_lcd_panel_io_handle_t panel_io;
static StaticSemaphore_t strip_transfer_control;
static struct iterate_kit_lcd_transfer strip_transfer;
static uint16_t *strip_pixels;
/* Panel-endian (byte-swapped) pixel stores; strips memcpy straight out. */
static uint16_t *face_pixels;
static uint16_t *face_frame;
static uint16_t *face_shown;
static uint16_t *lights_pixels;
static uint16_t *lights_shown;

static uint64_t now_ms(void) {
  return (uint64_t)(esp_timer_get_time() / 1000);
}

/*
 * ONE PUBLICATION, UNDER ONE LOCK.
 *
 * The loop hands over the complete view once per pass; the renderer reads this
 * snapshot on its own timer. Copying it wholesale is both simpler and
 * cheaper than the nine lock round trips the setters cost, and it removes the
 * class of bug where one setter erased what another had just published.
 */
void waveshare_display_present(const struct iterate_kit_voice_view *view) {
  if (ui.lock == NULL || view == NULL) return;
  xSemaphoreTake(ui.lock, portMAX_DELAY);
  ui.state = view->screen;
  (void)snprintf(
      ui.status, sizeof(ui.status), "%s",
      view->status == NULL ? "" : view->status);
  ui.link_ready = view->link_ready;
  ui.api_ready = view->api_ready;
  ui.stream_ready = view->stream_ready;
  ui.call_active = view->call_active;
  ui.call_requested = view->wants_call;
  ui.view = *view;
  /* Latching, not copied: nothing clears a fault but a reboot. */
  if (view->fault) ui.fault = true;
  xSemaphoreGive(ui.lock);
}

/* The shared snapshot: this panel's picture and the twelve-light rail must
 * agree, and both must agree with the ring on the other board. */
static struct iterate_kit_conversation_visual_state face_status(void) {
  struct iterate_kit_conversation_visual_state status = {0};
  xSemaphoreTake(ui.lock, portMAX_DELAY);
  ui.view.fault = ui.fault;
  iterate_kit_voice_view_lights(&ui.view, &status);
  xSemaphoreGive(ui.lock);
  return status;
}

static void note_display_transfer_failure(
    enum iterate_kit_lcd_transfer_result result) {
  xSemaphoreTake(ui.lock, portMAX_DELAY);
  ui.fault = true;
  xSemaphoreGive(ui.lock);
  ESP_LOGE(
      tag, "display transfer %s; display task stopped",
      result == ITERATE_KIT_LCD_TRANSFER_TIMED_OUT ? "timed out" : "failed");
}

/*
 * Push one row-major, already panel-endian region in bounded strips. The
 * shared transfer owner waits before the strip buffer is rewritten, so the
 * copy can never race the DMA that is still reading the previous strip.
 */
static bool push_region(
    int32_t left,
    int32_t top,
    int32_t width,
    int32_t height,
    const uint16_t *pixels) {
  int32_t row = 0;
  while (row < height) {
    int32_t rows = height - row;
    if (rows > STRIP_ROWS) rows = STRIP_ROWS;
    memcpy(
        strip_pixels,
        &pixels[(size_t)row * width],
        (size_t)rows * width * sizeof(*pixels));
    const enum iterate_kit_lcd_transfer_result result =
        iterate_kit_lcd_transfer_draw_and_wait(
            &strip_transfer, panel, left, top + row, width, rows,
            strip_pixels, pdMS_TO_TICKS(DISPLAY_TRANSFER_TIMEOUT_MS));
    if (result != ITERATE_KIT_LCD_TRANSFER_OK) {
      note_display_transfer_failure(result);
      return false;
    }
    row += rows;
  }
  return true;
}

/*
 * NOTHING LEFT TO WRITE. The lights say connected or not, and the face says
 * whether a conversation is happening. A status line under both was a third
 * copy of one fact. Status strings still reach the console log, where
 * somebody debugging actually reads them.
 */
static bool refresh_face(void) {
  int32_t source_y;
  static struct iterate_kit_face_wake wake;
  const struct iterate_kit_conversation_visual_state status = face_status();
  const uint64_t now = now_ms();

  if (face_pixels == NULL || face_frame == NULL || face_shown == NULL) return true;
  if (!waveshare_avatar_render(
          face_frame, (size_t)FACE_RENDER_PIXEL_COUNT,
          iterate_kit_face_awake(&wake, status.conversation_active, now))) {
    return true;
  }
  {
    const size_t card_bytes =
        (size_t)FACE_RENDER_WIDTH * CARD_SOURCE_HEIGHT * sizeof(*face_frame);
    if (memcmp(face_frame, face_shown, card_bytes) == 0) return true;
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
      /* Swapped once here, at scale time: the panel wants big-endian 565. */
      const uint16_t colour = __builtin_bswap16(input[source_x]);
      for (repeat = 0; repeat < FACE_SCALE; ++repeat) {
        output[source_x * FACE_SCALE + repeat] = colour;
      }
    }
    for (repeat = 1; repeat < FACE_SCALE; ++repeat) {
      memcpy(
          output + (size_t)repeat * FACE_WIDTH,
          output,
          (size_t)FACE_WIDTH * sizeof(*output));
    }
  }
  return push_region(FACE_LEFT, FACE_TOP, FACE_WIDTH, FACE_HEIGHT, face_pixels);
}

/*
 * The twelve lights across the foot of the panel. Colours from the one shared
 * renderer; only the geometry is this board's business.
 */
static bool refresh_lights(void) {
  struct iterate_kit_rgb8 lights[ITERATE_KIT_CONVERSATION_LIGHT_COUNT];
  const struct iterate_kit_conversation_visual_state status = face_status();
  const int32_t pitch =
      LIGHTS_WIDTH / (int32_t)ITERATE_KIT_CONVERSATION_LIGHT_COUNT;
  const int32_t mark_width = pitch - 6;
  const int32_t mark_height = LIGHTS_HEIGHT / 2;
  const int32_t left = (pitch - mark_width) / 2;
  const size_t strip_bytes =
      (size_t)LIGHTS_WIDTH * LIGHTS_HEIGHT * sizeof(*lights_pixels);
  int32_t index;

  if (lights_pixels == NULL || lights_shown == NULL) return true;
  iterate_kit_conversation_lights_for_screen(
      &status, (uint32_t)now_ms(), lights);
  memset(lights_pixels, 0, strip_bytes);
  for (index = 0; index < (int32_t)ITERATE_KIT_CONVERSATION_LIGHT_COUNT;
       ++index) {
    const uint16_t colour = __builtin_bswap16((uint16_t)(
        ((lights[index].red & 0xF8U) << 8) |
        ((lights[index].green & 0xFCU) << 3) | (lights[index].blue >> 3)));
    int32_t row;
    /* Flush with the bottom: the last rows of the strip, nothing under them. */
    for (row = LIGHTS_HEIGHT - mark_height; row < LIGHTS_HEIGHT; ++row) {
      uint16_t *const out =
          &lights_pixels[(size_t)row * LIGHTS_WIDTH + index * pitch + left];
      int32_t column;
      for (column = 0; column < mark_width; ++column) out[column] = colour;
    }
  }
  if (memcmp(lights_pixels, lights_shown, strip_bytes) == 0) return true;
  memcpy(lights_shown, lights_pixels, strip_bytes);
  return push_region(0, LIGHTS_TOP, LIGHTS_WIDTH, LIGHTS_HEIGHT, lights_pixels);
}

static void ui_task(void *context) {
  (void)context;
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(REFRESH_PERIOD_MS));
    if (!refresh_face() || !refresh_lights()) {
      vTaskDelete(NULL);
      return;
    }
  }
}

/*
 * Waveshare's examples pulse TCA9554 EXIO0/1/2/6 before panel creation. The
 * board BSP leaves BSP_LCD_RST disconnected, so omitting this source-derived
 * sequence leaves even the vendor LVGL demo black. (esp-brookesia's board
 * description for this same board lists the output set as 0/1/2/7, not 6 —
 * two vendor sources disagree; this set is the one proven on our board, so
 * check both pins before blaming the panel in a future bring-up.)
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
  const bsp_display_config_t panel_config = {0};
  const esp_lcd_panel_io_callbacks_t callbacks = {
    .on_color_trans_done = iterate_kit_lcd_transfer_complete,
  };
  if (bsp_display_new(&panel_config, &panel, &panel_io) != ESP_OK) {
    return false;
  }
  if (esp_lcd_panel_io_register_event_callbacks(
          panel_io, &callbacks, &strip_transfer) != ESP_OK) {
    return false;
  }
  return bsp_display_brightness_set(90) == ESP_OK;
}

/* The whole panel painted black once, through the same bounded strip. */
static bool clear_panel(void) {
  int32_t row = 0;
  while (row < DISPLAY_HEIGHT) {
    int32_t rows = DISPLAY_HEIGHT - row;
    if (rows > STRIP_ROWS) rows = STRIP_ROWS;
    memset(
        strip_pixels, 0,
        (size_t)rows * DISPLAY_WIDTH * sizeof(*strip_pixels));
    const enum iterate_kit_lcd_transfer_result result =
        iterate_kit_lcd_transfer_draw_and_wait(
            &strip_transfer, panel, 0, row, DISPLAY_WIDTH, rows, strip_pixels,
            pdMS_TO_TICKS(DISPLAY_TRANSFER_TIMEOUT_MS));
    if (result != ITERATE_KIT_LCD_TRANSFER_OK) {
      note_display_transfer_failure(result);
      return false;
    }
    row += rows;
  }
  return true;
}

bool waveshare_display_init(void) {
  ui.lock = xSemaphoreCreateMutex();
  if (ui.lock == NULL) return false;
  ui.state = ITERATE_KIT_VOICE_SCREEN_CONNECTING;
  (void)snprintf(ui.status, sizeof(ui.status), "starting");

  if (!iterate_kit_lcd_transfer_init(
          &strip_transfer, &strip_transfer_control)) return false;
  strip_pixels = heap_caps_malloc(
      (size_t)DISPLAY_WIDTH * STRIP_ROWS * sizeof(*strip_pixels),
      MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA);
  if (strip_pixels == NULL) return false;

  /* Display first is a correctness condition, not cosmetic ordering. */
  if (!release_board_resets() || !start_panel()) {
    ESP_LOGE(tag, "panel bring-up failed");
    return false;
  }
  if (!clear_panel()) return false;

  lights_pixels = heap_caps_calloc(
      (size_t)LIGHTS_WIDTH * LIGHTS_HEIGHT, sizeof(*lights_pixels),
      MALLOC_CAP_SPIRAM);
  lights_shown = heap_caps_calloc(
      (size_t)LIGHTS_WIDTH * LIGHTS_HEIGHT, sizeof(*lights_shown),
      MALLOC_CAP_SPIRAM);
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
      lights_pixels == NULL || lights_shown == NULL ||
      !waveshare_avatar_init()) {
    ESP_LOGE(tag, "avatar allocation or initialization failed");
    return false;
  }
  memset(
      face_shown,
      0xff,
      (size_t)FACE_RENDER_WIDTH * CARD_SOURCE_HEIGHT * sizeof(*face_shown));

  /*
   * Core 0, away from the 20 ms I2S deadline. The LVGL port this replaces
   * ran its flush task on core 1 at a millisecond cadence; two bounded
   * pushes every 100 ms do not belong next to the audio clock.
   */
  if (xTaskCreatePinnedToCore(
          ui_task, "waveshare-ui", 4096, NULL, 2, NULL, 0) != pdPASS) {
    ESP_LOGE(tag, "ui task creation failed");
    return false;
  }
  ESP_LOGI(tag, "minimal Iterate UI ready");
  return true;
}
