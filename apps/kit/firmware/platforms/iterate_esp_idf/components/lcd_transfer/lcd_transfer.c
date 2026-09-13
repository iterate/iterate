#include "iterate/kit/platforms/lcd_transfer.h"

#include "esp_attr.h"

bool iterate_kit_lcd_transfer_init(
    struct iterate_kit_lcd_transfer *transfer,
    StaticSemaphore_t *completion_storage) {
  if (transfer == NULL || completion_storage == NULL) return false;
  transfer->completion =
      xSemaphoreCreateBinaryStatic(completion_storage);
  transfer->failed = false;
  return transfer->completion != NULL;
}

bool IRAM_ATTR iterate_kit_lcd_transfer_complete(
    esp_lcd_panel_io_handle_t panel_io,
    esp_lcd_panel_io_event_data_t *event_data,
    void *context) {
  (void)panel_io;
  (void)event_data;
  struct iterate_kit_lcd_transfer *const transfer = context;
  if (transfer == NULL || transfer->completion == NULL) return false;
  BaseType_t higher_priority_task_woken = pdFALSE;
  xSemaphoreGiveFromISR(transfer->completion, &higher_priority_task_woken);
  return higher_priority_task_woken == pdTRUE;
}

enum iterate_kit_lcd_transfer_result iterate_kit_lcd_transfer_draw_and_wait(
    struct iterate_kit_lcd_transfer *transfer,
    esp_lcd_panel_handle_t panel,
    int32_t left,
    int32_t top,
    int32_t width,
    int32_t height,
    const void *pixels,
    TickType_t timeout) {
  if (transfer == NULL || transfer->completion == NULL || panel == NULL ||
      pixels == NULL || width <= 0 || height <= 0 || transfer->failed) {
    return ITERATE_KIT_LCD_TRANSFER_DRAW_FAILED;
  }
  /* Discard an old completion before this buffer becomes DMA-owned again. */
  (void)xSemaphoreTake(transfer->completion, 0U);
  if (esp_lcd_panel_draw_bitmap(
          panel, left, top, left + width, top + height, pixels) != ESP_OK) {
    transfer->failed = true;
    return ITERATE_KIT_LCD_TRANSFER_DRAW_FAILED;
  }
  if (xSemaphoreTake(transfer->completion, timeout) == pdPASS) {
    return ITERATE_KIT_LCD_TRANSFER_OK;
  }
  transfer->failed = true;
  return ITERATE_KIT_LCD_TRANSFER_TIMED_OUT;
}
