/* ST7305 initialization and pixel layout adapted from Waveshare's
 * ESP32-S3-RLCD-4.2 07_Audio_Test display_bsp.cpp (Apache-2.0).
 * https://github.com/waveshareteam/ESP32-S3-RLCD-4.2
 */
#include "rlcd_display.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <stdint.h>
#include <string.h>

static spi_device_handle_t panel;
static uint8_t frame[15000];
static const struct { uint8_t command, length, data[10]; uint16_t wait_ms; } init[] = {
  {0xD6, 2, {0x17, 0x02}, 0},
  {0xD1, 1, {0x01}, 0},
  {0xC0, 2, {0x11, 0x04}, 0},
  {0xC1, 4, {0x69, 0x69, 0x69, 0x69}, 0},
  {0xC2, 4, {0x19, 0x19, 0x19, 0x19}, 0},
  {0xC4, 4, {0x4B, 0x4B, 0x4B, 0x4B}, 0},
  {0xC5, 4, {0x19, 0x19, 0x19, 0x19}, 0},
  {0xD8, 2, {0x80, 0xE9}, 0},
  {0xB2, 1, {0x02}, 0},
  {0xB3, 10, {0xE5, 0xF6, 0x05, 0x46, 0x77, 0x77, 0x77, 0x77, 0x76, 0x45}, 0},
  {0xB4, 8, {0x05, 0x46, 0x77, 0x77, 0x77, 0x77, 0x76, 0x45}, 0},
  {0x62, 3, {0x32, 0x03, 0x1F}, 0},
  {0xB7, 1, {0x13}, 0},
  {0xB0, 1, {0x64}, 0},
  {0x11, 0, {0}, 200},
  {0xC9, 1, {0x00}, 0},
  {0x36, 1, {0x48}, 0},
  {0x3A, 1, {0x11}, 0},
  {0xB9, 1, {0x20}, 0},
  {0xB8, 1, {0x29}, 0},
  /* Normal polarity: our status glyphs and mono1 contract use 1 for black.
   * The vendor's 0x21 inversion expects the opposite (1 for white). */
  {0x20, 0, {0}, 0},
  {0x2A, 2, {0x12, 0x2A}, 0},
  {0x2B, 2, {0x00, 0xC7}, 0},
  {0x35, 1, {0x00}, 0},
  {0xD0, 1, {0xFF}, 0},
  {0x38, 0, {0}, 0},
  {0x29, 0, {0}, 0},
};

/* A small uppercase 5x7 font keeps this monochrome status panel independent
 * of a UI framework. Each byte is one column, least significant bit at top. */
static const uint8_t letters[26][5] = {
 {0x7e,0x11,0x11,0x11,0x7e},{0x7f,0x49,0x49,0x49,0x36},
 {0x3e,0x41,0x41,0x41,0x22},{0x7f,0x41,0x41,0x22,0x1c},
 {0x7f,0x49,0x49,0x49,0x41},{0x7f,0x09,0x09,0x09,0x01},
 {0x3e,0x41,0x49,0x49,0x7a},{0x7f,0x08,0x08,0x08,0x7f},
 {0,0x41,0x7f,0x41,0},{0x20,0x40,0x41,0x3f,0x01},
 {0x7f,0x08,0x14,0x22,0x41},{0x7f,0x40,0x40,0x40,0x40},
 {0x7f,0x02,0x0c,0x02,0x7f},{0x7f,0x04,0x08,0x10,0x7f},
 {0x3e,0x41,0x41,0x41,0x3e},{0x7f,0x09,0x09,0x09,0x06},
 {0x3e,0x41,0x51,0x21,0x5e},{0x7f,0x09,0x19,0x29,0x46},
 {0x46,0x49,0x49,0x49,0x31},{0x01,0x01,0x7f,0x01,0x01},
 {0x3f,0x40,0x40,0x40,0x3f},{0x1f,0x20,0x40,0x20,0x1f},
 {0x3f,0x40,0x38,0x40,0x3f},{0x63,0x14,0x08,0x14,0x63},
 {0x07,0x08,0x70,0x08,0x07},{0x61,0x51,0x49,0x45,0x43},
};

static bool send_bytes(bool data, const void *bytes, size_t length) {
  if (gpio_set_level(5, data) != ESP_OK) return false;
  spi_transaction_t transfer = {.length = length * 8, .tx_buffer = bytes};
  return spi_device_polling_transmit(panel, &transfer) == ESP_OK;
}

bool rlcd_display_start(void) {
  const gpio_config_t pins = {.pin_bit_mask = (1ULL << 5) | (1ULL << 41), .mode = GPIO_MODE_OUTPUT};
  if (gpio_config(&pins) != ESP_OK) return false;
  const spi_bus_config_t bus = {.mosi_io_num = 12, .miso_io_num = -1,
    .sclk_io_num = 11, .quadwp_io_num = -1, .quadhd_io_num = -1, .max_transfer_sz = sizeof(frame)};
  const spi_device_interface_config_t device = {.clock_speed_hz = 10000000,
    .mode = 0, .spics_io_num = 40, .queue_size = 1};
  if (spi_bus_initialize(SPI3_HOST, &bus, SPI_DMA_CH_AUTO) != ESP_OK ||
      spi_bus_add_device(SPI3_HOST, &device, &panel) != ESP_OK) return false;
  if (gpio_set_level(41, 0) != ESP_OK) return false;
  vTaskDelay(pdMS_TO_TICKS(20));
  if (gpio_set_level(41, 1) != ESP_OK) return false;
  vTaskDelay(pdMS_TO_TICKS(50));
  for (size_t i = 0; i < sizeof(init) / sizeof(init[0]); ++i) {
    if (!send_bytes(false, &init[i].command, 1) ||
        (init[i].length && !send_bytes(true, init[i].data, init[i].length))) return false;
    if (init[i].wait_ms) vTaskDelay(pdMS_TO_TICKS(init[i].wait_ms));
  }
  return true;
}

static void text_line(const char *text, unsigned y, unsigned scale) {
  const size_t length = strlen(text);
  if (length * 6 * scale > 400 || y + 7 * scale > 300) return;
  unsigned x = (400 - length * 6 * scale) / 2;
  for (; *text; ++text, x += 6 * scale) {
    if (*text < 'A' || *text > 'Z') continue;
    for (unsigned col = 0; col < 5; ++col) for (unsigned row = 0; row < 7; ++row) {
      if (!(letters[*text - 'A'][col] & (1 << row))) continue;
      for (unsigned dy = 0; dy < scale; ++dy) for (unsigned dx = 0; dx < scale; ++dx) {
        const unsigned px = x + col * scale + dx, py = 299 - (y + row * scale + dy);
        frame[(px / 2) * 75 + py / 4] |= 1 << (7 - ((py % 4) * 2 + px % 2));
      }
    }
  }
}

bool rlcd_display_show(const char *title, const char *status) {
  if (!panel) return false;
  memset(frame, 0, sizeof(frame));
  text_line("ITERATE", 32, 3);
  text_line(title, 100, 4);
  text_line(status, 190, 2);
  const uint8_t command = 0x2c;
  return send_bytes(false, &command, 1) && send_bytes(true, frame, sizeof(frame));
}

bool rlcd_display_show_bitmap(const uint8_t *bitmap, size_t length) {
  const uint8_t command = 0x2c;
  if (!panel || bitmap == NULL || length != RLCD_DISPLAY_BITMAP_BYTES) return false;
  memset(frame, 0, sizeof(frame));
  for (unsigned y = 0U; y < RLCD_DISPLAY_HEIGHT; ++y) {
    const unsigned py = RLCD_DISPLAY_HEIGHT - 1U - y;
    for (unsigned x = 0U; x < RLCD_DISPLAY_WIDTH; ++x) {
      const uint8_t source = bitmap[y * (RLCD_DISPLAY_WIDTH / 8U) + x / 8U];
      if ((source & (uint8_t)(0x80U >> (x % 8U))) == 0U) continue;
      frame[(x / 2U) * 75U + py / 4U] |=
          (uint8_t)(1U << (7U - ((py % 4U) * 2U + x % 2U)));
    }
  }
  return send_bytes(false, &command, 1) && send_bytes(true, frame, sizeof(frame));
}
