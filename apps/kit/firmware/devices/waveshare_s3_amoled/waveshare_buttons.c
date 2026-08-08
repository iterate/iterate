/*
 * The two buttons described in waveshare_buttons.h, debounced.
 *
 * UPPER is BOOT, an ordinary ESP pin. LOWER is PWR on the board's TCA9554, so
 * reading it is an I2C transaction — cheap at the 25ms poll the app loop
 * already runs, and unavoidable because that is where the button is wired.
 */
#include "waveshare_buttons.h"

#include <assert.h>

#include "bsp/esp-bsp.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_timer.h"

static const char tag[] = "waveshare-buttons";

enum {
  PIN_UPPER = 0,
  /* The lower button sits on the expander, and reads HIGH while pressed. */
  EXPANDER_PIN_LOWER = IO_EXPANDER_PIN_NUM_4,
  DEBOUNCE_MS = 30,
};

static struct {
  esp_io_expander_handle_t expander;
  bool upper_down;
  bool lower_down;
  bool upper_press_pending;
  bool lower_press_pending;
  uint64_t upper_changed_at_ms;
  uint64_t lower_changed_at_ms;
  bool initialized;
  uint32_t lower_read_failures;
} buttons;

static uint64_t now_ms(void) {
  return (uint64_t)(esp_timer_get_time() / 1000);
}

bool waveshare_buttons_init(void) {
  const gpio_config_t upper_config = {
    .pin_bit_mask = 1ULL << PIN_UPPER,
    .mode = GPIO_MODE_INPUT,
    .pull_up_en = GPIO_PULLUP_ENABLE,
    .pull_down_en = GPIO_PULLDOWN_DISABLE,
    .intr_type = GPIO_INTR_DISABLE,
  };
  if (gpio_config(&upper_config) != ESP_OK) {
    ESP_LOGE(tag, "upper button config failed");
    return false;
  }
  /*
   * One expander handle, created once. Reading it is I2C on a shared bus, so
   * the read is treated as advisory: see the fail-released path in poll().
   */
  buttons.expander = bsp_io_expander_init();
  if (buttons.expander == NULL) {
    ESP_LOGW(tag, "no expander: the lower button is unavailable");
  } else {
    (void)esp_io_expander_set_dir(
        buttons.expander, EXPANDER_PIN_LOWER, IO_EXPANDER_INPUT);
  }
  buttons.initialized = true;
  return true;
}

/** Read the lower button, treating a failed I2C read as "not pressed". */
static bool read_lower_pressed(void) {
  uint32_t levels = 0U;

  if (buttons.expander == NULL) {
    return false;
  }
  if (esp_io_expander_get_level(
          buttons.expander, EXPANDER_PIN_LOWER, &levels) != ESP_OK) {
    /*
     * FAIL RELEASED, never "keep the last value". This read shares a bus with
     * the codec, the touch controller and the PMIC, so it can and does fail —
     * and retaining the previous state meant a single failed read while the
     * button was down latched it held FOREVER. A dropped release costs one
     * repeated press; a stuck one costs the whole device.
     */
    ++buttons.lower_read_failures;
    return false;
  }
  return (levels & EXPANDER_PIN_LOWER) != 0U;
}

/**
 * Commit a debounced down edge.
 *
 * Both buttons want the same thing — the press registers when it goes down,
 * not when it is released — so the rule lives in one place rather than being
 * written out twice and drifting.
 */
static void settle(
    bool pressed, bool *down, uint64_t *changed_at_ms, bool *press_pending) {
  const uint64_t now = now_ms();

  assert(down != NULL && changed_at_ms != NULL && press_pending != NULL);
  if (pressed == *down) {
    return;
  }
  if (now - *changed_at_ms < (uint64_t)DEBOUNCE_MS) {
    return;
  }
  *changed_at_ms = now;
  *down = pressed;
  if (pressed) {
    *press_pending = true;
  }
}

void waveshare_buttons_poll(void) {
  if (!buttons.initialized) return;

  settle(
      gpio_get_level(PIN_UPPER) == 0, &buttons.upper_down,
      &buttons.upper_changed_at_ms, &buttons.upper_press_pending);
  settle(
      read_lower_pressed(), &buttons.lower_down, &buttons.lower_changed_at_ms,
      &buttons.lower_press_pending);
}

bool waveshare_buttons_take_upper_press(void) {
  const bool pressed = buttons.upper_press_pending;
  buttons.upper_press_pending = false;
  return pressed;
}

bool waveshare_buttons_upper_held(void) {
  return buttons.upper_down;
}

bool waveshare_buttons_take_lower_press(void) {
  const bool pressed = buttons.lower_press_pending;
  buttons.lower_press_pending = false;
  return pressed;
}

uint32_t waveshare_buttons_lower_read_failures(void) {
  return buttons.lower_read_failures;
}
