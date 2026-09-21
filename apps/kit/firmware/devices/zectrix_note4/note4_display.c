#include "note4_display.h"
#include "status_font.h"
#include "zectrix_epd.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>

/* E-paper refresh must never block button polling, transport or audio. A
 * one-item queue coalesces rapid voice states to the latest requested view. */
struct status_view {
  char title[24]; char status[33];
  const uint8_t *image;
  size_t length;
  enum iterate_kit_screen_format format;
};
static QueueHandle_t views;
static zectrix_epd_handle_t panel;
static uint8_t frame[ZECTRIX_EPD_1BPP_FRAME_BYTES];
static atomic_uint updates, failures;
static atomic_int image_state = ITERATE_KIT_SCREEN_IDLE;

static void text_line(const char *text, unsigned y, unsigned scale) {
  const size_t length = strlen(text);
  if (length * 6 * scale > 400 || y + 7 * scale > 300) return;
  unsigned x = (400 - length * 6 * scale) / 2;
  for (; *text; ++text, x += 6 * scale) {
    if (*text < 'A' || *text > 'Z') continue;
    for (unsigned col = 0; col < 5; ++col) for (unsigned row = 0; row < 7; ++row) {
      if (!(letters[*text - 'A'][col] & (1 << row))) continue;
      for (unsigned dy = 0; dy < scale; ++dy) for (unsigned dx = 0; dx < scale; ++dx) {
        const unsigned px = x + col * scale + dx, py = y + row * scale + dy;
        frame[py * 50 + px / 8] &= ~(0x80U >> (px % 8));
      }
    }
  }
}

static void display_task(void *unused) {
  (void)unused;
  struct status_view view;
  while (xQueueReceive(views, &view, portMAX_DELAY) == pdTRUE) {
    esp_err_t result;
    static bool grayscale = false;
    if (view.image && view.format == ITERATE_KIT_SCREEN_GRAY4) {
      result = zectrix_epd_refresh_full_4bpp(panel, view.image, view.length);
      grayscale = true;
    } else {
      if (view.image) {
        for (size_t i = 0; i < sizeof(frame); ++i) frame[i] = ~view.image[i];
      } else {
        memset(frame, 0xff, sizeof(frame));
        text_line("ITERATE", 32, 3);
        text_line(view.title, 100, 4);
        text_line(view.status, 190, 2);
      }
      if (grayscale || atomic_load(&updates) % 20 == 0) {
        result = zectrix_epd_refresh_full_1bpp(panel, frame, sizeof(frame));
      } else {
        const zectrix_epd_rect_t rect = {0, 0, 400, 300};
        result = zectrix_epd_refresh_partial_1bpp(panel, &rect, frame, sizeof(frame));
      }
      grayscale = false;
    }
    if (result != ESP_OK) {
      atomic_fetch_add(&failures, 1);
      atomic_store(&image_state, ITERATE_KIT_SCREEN_FAILED);
      ESP_LOGE("note4-display", "Refresh failed (%s); updates stopped", esp_err_to_name(result));
      vTaskDelete(NULL);
      return;
    }
    if (view.image) atomic_store(&image_state, ITERATE_KIT_SCREEN_SHOWN);
    const unsigned count = atomic_fetch_add(&updates, 1) + 1;
    ESP_LOGI("note4-display", "Refresh %u: %s / %s", count, view.title, view.status);
    vTaskDelay(pdMS_TO_TICKS(1000));
  }
}

bool note4_display_start(void) {
  zectrix_epd_config_t config;
  zectrix_epd_get_default_config(&config);
  esp_err_t result = zectrix_epd_new(&config, &panel);
  if (result == ESP_OK) result = zectrix_epd_power_on(panel);
  if (result != ESP_OK) {
    atomic_fetch_add(&failures, 1);
    ESP_LOGE("note4-display", "Initialization failed: %s", esp_err_to_name(result));
    return false;
  }
  views = xQueueCreate(1, sizeof(struct status_view));
  if (!views || xTaskCreate(display_task, "note4-display", 4096, NULL, 2, NULL) != pdPASS) {
    atomic_fetch_add(&failures, 1);
    return false;
  }
  return true;
}

bool note4_display_show(const char *title, const char *status) {
  if (!views || atomic_load(&failures)) return false;
  struct status_view view = {0};
  snprintf(view.title, sizeof(view.title), "%s", title);
  snprintf(view.status, sizeof(view.status), "%s", status);
  return xQueueOverwrite(views, &view) == pdTRUE;
}

uint32_t note4_display_updates(void) { return atomic_load(&updates); }
uint32_t note4_display_failures(void) { return atomic_load(&failures); }

bool note4_display_submit(void *context, enum iterate_kit_screen_format format,
                          const uint8_t *bytes, size_t length) {
  (void)context;
  if (!views || atomic_load(&failures) || !bytes ||
      length != iterate_kit_screen_frame_bytes(400, 300, format) ||
      (format != ITERATE_KIT_SCREEN_MONO1 && format != ITERATE_KIT_SCREEN_GRAY4)) return false;
  const struct status_view view = {.image = bytes, .length = length, .format = format};
  atomic_store(&image_state, ITERATE_KIT_SCREEN_PENDING);
  return xQueueOverwrite(views, &view) == pdTRUE;
}

enum iterate_kit_screen_state note4_display_state(void *context) {
  (void)context;
  return atomic_load(&image_state);
}
