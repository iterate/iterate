/* Translated from upstream ESPHome pcm5122/pcm5122.cpp as recorded in board-table task step 17. */
#include "iterate/kit/platforms/pcm5122.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static bool iterate_kit_pcm5122_write(i2c_master_dev_handle_t device, uint8_t address, uint8_t value) {
  const uint8_t bytes[] = {address, value};
  return i2c_master_transmit(device, bytes, sizeof(bytes), 100) == ESP_OK;
}

static bool iterate_kit_pcm5122_read(i2c_master_dev_handle_t device, uint8_t address, uint8_t *value) {
  return i2c_master_transmit_receive(device, &address, 1, value, 1, 100) == ESP_OK;
}

bool iterate_kit_pcm5122_init(i2c_master_dev_handle_t device) {
  if (device == NULL || !iterate_kit_pcm5122_write(device, 0x00, 0x00)) return false;
  size_t count;
  const struct iterate_kit_register_write *reset = iterate_kit_pcm5122_reset_script(&count);
  for (size_t i = 0; i < count; ++i) {
    if (!iterate_kit_pcm5122_write(device, reset[i].address, reset[i].value)) return false;
    if (i == 0) vTaskDelay(pdMS_TO_TICKS(ITERATE_KIT_PCM5122_RESET_SETTLE_MS));
  }
  uint8_t error_detect, pll_reference;
  if (!iterate_kit_pcm5122_read(device, 0x25, &error_detect) ||
      !iterate_kit_pcm5122_read(device, 0x0D, &pll_reference)) return false;
  struct iterate_kit_register_write writes[ITERATE_KIT_PCM5122_INIT_WRITE_COUNT];
  count = iterate_kit_pcm5122_init_script(error_detect, pll_reference, writes,
      sizeof(writes) / sizeof(writes[0]));
  for (size_t i = 0; i < count; ++i) {
    if (!iterate_kit_pcm5122_write(device, writes[i].address, writes[i].value)) return false;
  }
  return true;
}

bool iterate_kit_pcm5122_set_volume(i2c_master_dev_handle_t device, uint8_t percent, uint8_t *applied) {
  if (device == NULL || applied == NULL) return false;
  const uint8_t volume = percent > 100U ? 100U : percent;
  const uint8_t dvol = iterate_kit_pcm5122_dvol_for_percent(volume);
  if (!iterate_kit_pcm5122_write(device, 0x00, 0x00) ||
      !iterate_kit_pcm5122_write(device, 0x3D, dvol) ||
      !iterate_kit_pcm5122_write(device, 0x3E, dvol)) return false;
  *applied = volume;
  return true;
}

bool iterate_kit_pcm5122_mute(i2c_master_dev_handle_t device, bool muted) {
  return device != NULL && iterate_kit_pcm5122_write(device, 0x00, 0x00) &&
      iterate_kit_pcm5122_write(device, 0x03, muted ? 0x11 : 0x00);
}

bool iterate_kit_pcm5122_read_gpio(i2c_master_dev_handle_t device, uint8_t pin, bool *level) {
  if (device == NULL || level == NULL || pin < 1U || pin > 6U) return false;
  uint8_t gpio;
  if (!iterate_kit_pcm5122_write(device, 0x00, 0x00) ||
      !iterate_kit_pcm5122_read(device, 0x77, &gpio)) return false;
  *level = (gpio & (1U << (pin - 1U))) != 0;
  return true;
}
