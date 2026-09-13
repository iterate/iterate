#ifndef ITERATE_KIT_PLATFORMS_LCD_TRANSFER_H
#define ITERATE_KIT_PLATFORMS_LCD_TRANSFER_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#ifdef __cplusplus
extern "C" {
#endif

/* One caller-owned DMA buffer. A timeout permanently retires it: ESP-IDF may
 * still be reading it, so it must never be rewritten or freed afterwards. */
struct iterate_kit_lcd_transfer {
  SemaphoreHandle_t completion;
  bool failed;
};

enum iterate_kit_lcd_transfer_result {
  ITERATE_KIT_LCD_TRANSFER_OK,
  ITERATE_KIT_LCD_TRANSFER_DRAW_FAILED,
  ITERATE_KIT_LCD_TRANSFER_TIMED_OUT,
};

bool iterate_kit_lcd_transfer_init(
    struct iterate_kit_lcd_transfer *transfer,
    StaticSemaphore_t *completion_storage);

bool iterate_kit_lcd_transfer_complete(
    esp_lcd_panel_io_handle_t panel_io,
    esp_lcd_panel_io_event_data_t *event_data,
    void *context);

enum iterate_kit_lcd_transfer_result iterate_kit_lcd_transfer_draw_and_wait(
    struct iterate_kit_lcd_transfer *transfer,
    esp_lcd_panel_handle_t panel,
    int32_t left,
    int32_t top,
    int32_t width,
    int32_t height,
    const void *pixels,
    TickType_t timeout);

#ifdef __cplusplus
}
#endif

#endif
