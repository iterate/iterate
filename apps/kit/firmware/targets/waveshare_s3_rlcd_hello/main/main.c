#include "rlcd_display.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

void app_main(void) {
  const gpio_config_t key = {.pin_bit_mask = 1ULL << 18, .mode = GPIO_MODE_INPUT,
    .pull_up_en = GPIO_PULLUP_ENABLE};
  ESP_ERROR_CHECK(gpio_config(&key));
  if (!rlcd_display_start() || !rlcd_display_show("HELLO WORLD", "PRESS KEY")) {
    ESP_LOGE("rlcd-hello", "Display initialization failed");
    return;
  }
  ESP_LOGI("rlcd-hello", "Hello World! KEY is GPIO18; BOOT is GPIO0; PWR is hardware power.");
  bool previous = false;
  for (;;) {
    const bool pressed = gpio_get_level(18) == 0;
    if (pressed && !previous) {
      ESP_LOGI("rlcd-hello", "KEY pressed: Hello World!");
      if (!rlcd_display_show("HELLO WORLD", "KEY PRESSED")) ESP_LOGE("rlcd-hello", "Display write failed");
    }
    previous = pressed;
    vTaskDelay(pdMS_TO_TICKS(40));
  }
}
