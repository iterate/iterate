/*
 * BOOT and PWR, debounced. BOOT is an ordinary ESP pin; PWR is EXIO4 on the
 * board's TCA9554, so reading it is an I2C transaction — cheap at the 20ms
 * poll the app loop already runs, and worth it because push-to-talk wants a
 * button the user can hold without covering the screen.
 */
#include "waveshare_buttons.h"

#include "bsp/esp-bsp.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_timer.h"

static const char tag[] = "waveshare-buttons";

enum {
  PIN_BOOT = 0,
  /* PWR sits on the expander, and reads HIGH while pressed. */
  EXPANDER_PIN_TALK = IO_EXPANDER_PIN_NUM_4,
  DEBOUNCE_MS = 30,
  /* Hold the call button this long to reboot. */
  REBOOT_HOLD_MS = 3000,
};

static struct {
  esp_io_expander_handle_t expander;
  bool call_down;
  bool talk_down;
  bool call_press_pending;
  bool call_long_press_pending;
  bool call_long_press_fired;
  uint64_t call_down_since_ms;
  uint64_t call_changed_at_ms;
  uint64_t talk_changed_at_ms;
  bool initialized;
} buttons;

static uint64_t now_ms(void) {
  return (uint64_t)(esp_timer_get_time() / 1000);
}

bool waveshare_buttons_init(void) {
  const gpio_config_t boot_config = {
    .pin_bit_mask = 1ULL << PIN_BOOT,
    .mode = GPIO_MODE_INPUT,
    .pull_up_en = GPIO_PULLUP_ENABLE,
    .pull_down_en = GPIO_PULLDOWN_DISABLE,
    .intr_type = GPIO_INTR_DISABLE,
  };
  if (gpio_config(&boot_config) != ESP_OK) {
    ESP_LOGE(tag, "boot button config failed");
    return false;
  }
  buttons.expander = bsp_io_expander_init();
  if (buttons.expander == NULL) {
    ESP_LOGW(tag, "no expander: push-to-talk button unavailable");
  } else {
    (void)esp_io_expander_set_dir(
        buttons.expander, EXPANDER_PIN_TALK, IO_EXPANDER_INPUT);
  }
  buttons.initialized = true;
  return true;
}

void waveshare_buttons_poll(void) {
  const uint64_t now = now_ms();
  bool call_down;
  bool talk_down = buttons.talk_down;

  if (!buttons.initialized) return;

  call_down = gpio_get_level(PIN_BOOT) == 0;
  if (call_down != buttons.call_down &&
      now - buttons.call_changed_at_ms >= DEBOUNCE_MS) {
    buttons.call_changed_at_ms = now;
    buttons.call_down = call_down;
    if (call_down) {
      buttons.call_down_since_ms = now;
      buttons.call_long_press_fired = false;
    } else if (!buttons.call_long_press_fired) {
      /*
       * The short press is only committed on RELEASE, so a hold that is on
       * its way to a reboot does not also toggle the call.
       */
      buttons.call_press_pending = true;
    }
  }
  if (buttons.call_down && !buttons.call_long_press_fired &&
      buttons.call_down_since_ms != 0U &&
      now - buttons.call_down_since_ms >= REBOOT_HOLD_MS) {
    buttons.call_long_press_fired = true;
    buttons.call_long_press_pending = true;
  }

  if (buttons.expander != NULL) {
    uint32_t levels = 0U;
    if (esp_io_expander_get_level(
            buttons.expander, EXPANDER_PIN_TALK, &levels) == ESP_OK) {
      talk_down = (levels & EXPANDER_PIN_TALK) != 0U;
    }
  }
  if (talk_down != buttons.talk_down &&
      now - buttons.talk_changed_at_ms >= DEBOUNCE_MS) {
    buttons.talk_changed_at_ms = now;
    buttons.talk_down = talk_down;
  }
}

bool waveshare_buttons_take_call_press(void) {
  const bool pressed = buttons.call_press_pending;
  buttons.call_press_pending = false;
  return pressed;
}

bool waveshare_buttons_take_call_long_press(void) {
  const bool fired = buttons.call_long_press_pending;
  buttons.call_long_press_pending = false;
  return fired;
}

uint32_t waveshare_buttons_call_held_ms(void) {
  if (!buttons.call_down || buttons.call_down_since_ms == 0U) return 0U;
  return (uint32_t)(now_ms() - buttons.call_down_since_ms);
}

bool waveshare_buttons_talk_held(void) {
  return buttons.talk_down;
}
