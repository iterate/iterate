/*
 * Waveshare ESP32-S3 Touch AMOLED 1.8 — the Iterate UI.
 *
 * SH8601 QSPI panel (368x448, CS 12 / PCLK 11 / D0..D3 4,5,6,7, no reset or
 * backlight pin — an AMOLED's brightness is register 0x51) plus an FT5x06
 * touch controller on the audio I2C bus (INT 21). One LVGL task owns every
 * widget and polls touch; other tasks publish into a small mutex-guarded
 * snapshot, so nothing outside this file touches LVGL.
 *
 * The panel init sequence is the vendor's, as used by this board's
 * xiaozhi-esp32 port: sleep-out, then the 0x2A/0x2B column/row windows that
 * match 368x448, then display-on.
 */
#include "waveshare_display.h"

#include <stdio.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_heap_caps.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_sh8601.h"
#include "esp_lcd_touch_ft5x06.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lvgl.h"
#include "waveshare_audio.h"

static const char tag[] = "waveshare-ui";

enum {
  PIN_LCD_CS = 12,
  PIN_LCD_PCLK = 11,
  PIN_LCD_D0 = 4,
  PIN_LCD_D1 = 5,
  PIN_LCD_D2 = 6,
  PIN_LCD_D3 = 7,
  PIN_TOUCH_INT = 21,
  TRANSCRIPT_LINES = 6,
  TRANSCRIPT_LINE_CHARS = 96,
  STATUS_CHARS = 64,
  /*
   * Two 20-line stripes, in PSRAM. Internal RAM is the Wi-Fi driver's
   * budget: 40-line stripes in internal DMA memory left only ~81 KiB free
   * and the station associated but never completed DHCP. The S3's GDMA
   * reaches PSRAM, so the panel does not need internal memory at all.
   */
  DRAW_BUFFER_LINES = 20,
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
  bool dirty;
} ui = {
  .background = 0x101820,
};

/*
 * The vendor's panel bring-up, as used by this board's xiaozhi-esp32 port:
 * sleep-out, the 0x2A/0x2B windows that describe 368x448, full brightness
 * (0x51 — an AMOLED has no backlight pin), display on.
 */
static const sh8601_lcd_init_cmd_t vendor_init[] = {
  {0x11, (uint8_t[]){0x00}, 0, 120},
  {0x44, (uint8_t[]){0x01, 0xD1}, 2, 0},
  {0x35, (uint8_t[]){0x00}, 1, 0},
  {0x53, (uint8_t[]){0x20}, 1, 10},
  {0x2A, (uint8_t[]){0x00, 0x00, 0x01, 0x6F}, 4, 0},
  {0x2B, (uint8_t[]){0x00, 0x00, 0x01, 0xBF}, 4, 0},
  {0x51, (uint8_t[]){0xFF}, 1, 10},
  {0x29, (uint8_t[]){0x00}, 0, 10},
};

static lv_obj_t *screen_root;
static lv_obj_t *state_label;
static lv_obj_t *status_label;
static lv_obj_t *transcript_label;
static lv_obj_t *call_button;
static lv_obj_t *call_button_label;
static esp_lcd_touch_handle_t touch_handle;
/* Set once the panel is up; the retriable touch bring-up needs it. */
static lv_display_t *ui_display;

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

static void call_button_pressed(lv_event_t *event) {
  (void)event;
  xSemaphoreTake(ui.lock, portMAX_DELAY);
  ui.call_requested = !ui.call_requested;
  ui.dirty = true;
  xSemaphoreGive(ui.lock);
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
  lv_obj_set_width(transcript_label, WAVESHARE_DISPLAY_WIDTH - 32);
  lv_label_set_text(transcript_label, "");
  lv_obj_set_style_text_color(transcript_label, lv_color_hex(0xe8eaed), 0);
  lv_obj_set_style_text_font(transcript_label, &lv_font_montserrat_16, 0);
  lv_obj_align(transcript_label, LV_ALIGN_TOP_LEFT, 0, 100);

  call_button = lv_button_create(screen_root);
  lv_obj_set_size(call_button, WAVESHARE_DISPLAY_WIDTH - 32, 72);
  lv_obj_align(call_button, LV_ALIGN_BOTTOM_MID, 0, 0);
  lv_obj_add_event_cb(call_button, call_button_pressed, LV_EVENT_CLICKED, NULL);
  call_button_label = lv_label_create(call_button);
  lv_label_set_text(call_button_label, "start call");
  lv_obj_set_style_text_font(call_button_label, &lv_font_montserrat_20, 0);
  lv_obj_center(call_button_label);
}

static void refresh_ui(void) {
  static char transcript[TRANSCRIPT_LINES * TRANSCRIPT_LINE_CHARS];
  enum waveshare_ui_state state;
  uint32_t background;
  bool call_requested;
  bool call_active;
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
  lv_label_set_text(call_button_label, call_requested ? "hang up" : "start call");
  lv_obj_set_style_bg_color(
      call_button,
      lv_color_hex(call_requested ? 0xdc2626 : 0x2563eb),
      0);
  lv_obj_set_style_border_width(call_button, call_active ? 2 : 0, 0);
  lv_obj_set_style_border_color(call_button, lv_color_hex(0x4ade80), 0);
}

static void touch_read(lv_indev_t *indev, lv_indev_data_t *data) {
  uint16_t x = 0;
  uint16_t y = 0;
  uint16_t strength = 0;
  uint8_t count = 0;
  (void)indev;
  if (touch_handle == NULL) {
    data->state = LV_INDEV_STATE_RELEASED;
    return;
  }
  /*
   * This panel's controller sleeps between touches and NACKs every register
   * read while it does. Polling it anyway produced a continuous I2C error
   * storm that starved the network stack on this core — so the INT line
   * (active low, asserted while a finger is down) is the gate, and I2C is
   * only touched when there is something to read.
   */
  if (gpio_get_level(PIN_TOUCH_INT) != 0) {
    data->state = LV_INDEV_STATE_RELEASED;
    return;
  }
  esp_lcd_touch_read_data(touch_handle);
  if (esp_lcd_touch_get_coordinates(touch_handle, &x, &y, &strength, &count, 1) &&
      count > 0U) {
    data->point.x = x;
    data->point.y = y;
    data->state = LV_INDEV_STATE_PRESSED;
    return;
  }
  data->state = LV_INDEV_STATE_RELEASED;
}

/*
 * This panel's capacitive controller sleeps hard: while asleep it NACKs
 * every I2C transaction, so a one-shot probe at boot reports "no touch
 * controller" on a board that has one. Two things fix that — pulsing the
 * INT line low wakes it (the line is bidirectional on this part), and the
 * bring-up is retried from the UI task, so a controller that only ever wakes
 * under a finger still gets attached.
 */
static void pulse_touch_interrupt(void) {
  const gpio_config_t as_output = {
    .pin_bit_mask = 1ULL << PIN_TOUCH_INT,
    .mode = GPIO_MODE_OUTPUT,
    .pull_up_en = GPIO_PULLUP_DISABLE,
    .pull_down_en = GPIO_PULLDOWN_DISABLE,
    .intr_type = GPIO_INTR_DISABLE,
  };
  const gpio_config_t as_input = {
    .pin_bit_mask = 1ULL << PIN_TOUCH_INT,
    .mode = GPIO_MODE_INPUT,
    .pull_up_en = GPIO_PULLUP_ENABLE,
    .pull_down_en = GPIO_PULLDOWN_DISABLE,
    .intr_type = GPIO_INTR_DISABLE,
  };
  (void)gpio_config(&as_output);
  (void)gpio_set_level(PIN_TOUCH_INT, 0);
  vTaskDelay(pdMS_TO_TICKS(6));
  (void)gpio_set_level(PIN_TOUCH_INT, 1);
  (void)gpio_config(&as_input);
  vTaskDelay(pdMS_TO_TICKS(60));
}

/* Releases whatever this board holds in reset behind its TCA9554 expander. */
static void release_expander_resets(void) {
  i2c_master_dev_handle_t expander = NULL;
  const i2c_device_config_t expander_config = {
    .dev_addr_length = I2C_ADDR_BIT_LEN_7,
    .device_address = 0x20,
    .scl_speed_hz = 100000,
  };
  if (i2c_master_bus_add_device(
          waveshare_audio_i2c_bus(), &expander_config, &expander) != ESP_OK) {
    return;
  }
  {
    const uint8_t outputs_high[] = {0x01, 0xff};
    const uint8_t all_outputs[] = {0x03, 0x00};
    (void)i2c_master_transmit(expander, outputs_high, sizeof(outputs_high), 100);
    (void)i2c_master_transmit(expander, all_outputs, sizeof(all_outputs), 100);
  }
  (void)i2c_master_bus_rm_device(expander);
  vTaskDelay(pdMS_TO_TICKS(50));
}

static bool attach_touch(void) {
  esp_lcd_panel_io_handle_t touch_io = NULL;
  const esp_lcd_panel_io_i2c_config_t touch_io_config =
      ESP_LCD_TOUCH_IO_I2C_FT5x06_CONFIG();
  const esp_lcd_touch_config_t touch_config = {
    .x_max = WAVESHARE_DISPLAY_WIDTH,
    .y_max = WAVESHARE_DISPLAY_HEIGHT,
    .rst_gpio_num = -1,
    .int_gpio_num = -1, /* read gating is ours; see touch_read */
    .levels = {.reset = 0, .interrupt = 0},
    .flags = {.swap_xy = 0, .mirror_x = 0, .mirror_y = 0},
  };
  if (touch_handle != NULL) {
    return true;
  }
  pulse_touch_interrupt();
  if (i2c_master_probe(waveshare_audio_i2c_bus(), 0x38, 100) != ESP_OK) {
    return false;
  }
  if (esp_lcd_new_panel_io_i2c(
          waveshare_audio_i2c_bus(), &touch_io_config, &touch_io) != ESP_OK) {
    return false;
  }
  if (esp_lcd_touch_new_i2c_ft5x06(touch_io, &touch_config, &touch_handle) !=
      ESP_OK) {
    touch_handle = NULL;
    (void)esp_lcd_panel_io_del(touch_io);
    return false;
  }
  {
    lv_indev_t *indev = lv_indev_create();
    lv_indev_set_type(indev, LV_INDEV_TYPE_POINTER);
    lv_indev_set_read_cb(indev, touch_read);
    lv_indev_set_display(indev, ui_display);
  }
  ESP_LOGI(tag, "touch controller attached");
  return true;
}

static bool flush_ready(
    esp_lcd_panel_io_handle_t io,
    esp_lcd_panel_io_event_data_t *event,
    void *context) {
  (void)io;
  (void)event;
  lv_display_flush_ready((lv_display_t *)context);
  return false;
}

static void flush_cb(lv_display_t *display, const lv_area_t *area, uint8_t *pixels) {
  esp_lcd_panel_handle_t panel = lv_display_get_user_data(display);
  /* The panel takes big-endian RGB565 over QSPI. */
  lv_draw_sw_rgb565_swap(pixels, lv_area_get_size(area));
  esp_lcd_panel_draw_bitmap(
      panel, area->x1, area->y1, area->x2 + 1, area->y2 + 1, pixels);
}

static uint32_t lvgl_tick(void) {
  return (uint32_t)(esp_timer_get_time() / 1000);
}

static void lvgl_task(void *argument) {
  uint32_t ticks_since_touch_retry = 0U;
  (void)argument;
  for (;;) {
    refresh_ui();
    const uint32_t next = lv_timer_handler();
    /* Keep courting a sleeping touch controller until it answers. */
    if (touch_handle == NULL && ++ticks_since_touch_retry >= 30U) {
      ticks_since_touch_retry = 0U;
      (void)attach_touch();
    }
    vTaskDelay(pdMS_TO_TICKS(next > 30U ? 30U : (next < 5U ? 5U : next)));
  }
}

bool waveshare_display_init(void) {
  esp_lcd_panel_io_handle_t panel_io = NULL;
  esp_lcd_panel_handle_t panel = NULL;
  lv_display_t *display = NULL;

  ui.lock = xSemaphoreCreateMutex();
  if (ui.lock == NULL) return false;
  snprintf(ui.status, sizeof(ui.status), "starting");

  spi_bus_config_t bus_config = SH8601_PANEL_BUS_QSPI_CONFIG(
      PIN_LCD_PCLK,
      PIN_LCD_D0,
      PIN_LCD_D1,
      PIN_LCD_D2,
      PIN_LCD_D3,
      WAVESHARE_DISPLAY_WIDTH * DRAW_BUFFER_LINES * 2);
  if (spi_bus_initialize(SPI2_HOST, &bus_config, SPI_DMA_CH_AUTO) != ESP_OK) {
    ESP_LOGE(tag, "qspi bus init failed");
    return false;
  }

  esp_lcd_panel_io_spi_config_t io_config =
      SH8601_PANEL_IO_QSPI_CONFIG(PIN_LCD_CS, NULL, NULL);
  io_config.pclk_hz = 40 * 1000 * 1000;
  io_config.trans_queue_depth = 10;
  if (esp_lcd_new_panel_io_spi(SPI2_HOST, &io_config, &panel_io) != ESP_OK) {
    ESP_LOGE(tag, "panel io failed");
    return false;
  }

  const sh8601_vendor_config_t vendor_config = {
    .init_cmds = vendor_init,
    .init_cmds_size = sizeof(vendor_init) / sizeof(vendor_init[0]),
    .flags = {.use_qspi_interface = 1},
  };
  const esp_lcd_panel_dev_config_t panel_config = {
    .reset_gpio_num = -1,
    .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
    .bits_per_pixel = 16,
    .vendor_config = (void *)&vendor_config,
    .flags = {.reset_active_high = 1},
  };
  if (esp_lcd_new_panel_sh8601(panel_io, &panel_config, &panel) != ESP_OK) {
    ESP_LOGE(tag, "sh8601 init failed");
    return false;
  }
  (void)esp_lcd_panel_reset(panel);
  (void)esp_lcd_panel_init(panel);
  (void)esp_lcd_panel_invert_color(panel, false);
  (void)esp_lcd_panel_disp_on_off(panel, true);

  lv_init();
  lv_tick_set_cb(lvgl_tick);
  display = lv_display_create(WAVESHARE_DISPLAY_WIDTH, WAVESHARE_DISPLAY_HEIGHT);
  if (display == NULL) {
    ESP_LOGE(tag, "lvgl display creation failed");
    return false;
  }
  {
    const size_t buffer_bytes = WAVESHARE_DISPLAY_WIDTH * DRAW_BUFFER_LINES * 2U;
    void *first = heap_caps_malloc(buffer_bytes, MALLOC_CAP_DMA | MALLOC_CAP_SPIRAM);
    void *second = heap_caps_malloc(buffer_bytes, MALLOC_CAP_DMA | MALLOC_CAP_SPIRAM);
    if (first == NULL || second == NULL) {
      ESP_LOGE(tag, "lvgl draw buffers unavailable");
      return false;
    }
    lv_display_set_buffers(
        display, first, second, buffer_bytes, LV_DISPLAY_RENDER_MODE_PARTIAL);
  }
  ui_display = display;
  lv_display_set_user_data(display, panel);
  lv_display_set_flush_cb(display, flush_cb);
  {
    const esp_lcd_panel_io_callbacks_t callbacks = {
      .on_color_trans_done = flush_ready,
    };
    (void)esp_lcd_panel_io_register_event_callbacks(panel_io, &callbacks, display);
  }

  release_expander_resets();
  attach_touch();

  build_ui();
  ui.dirty = true;
  if (xTaskCreatePinnedToCore(lvgl_task, "iterate-ui", 8192, NULL, 4, NULL, 0) !=
      pdPASS) {
    ESP_LOGE(tag, "lvgl task creation failed");
    return false;
  }
  ESP_LOGI(tag, "iterate UI up on 368x448 AMOLED");
  return true;
}
