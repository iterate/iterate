/*
 * The WS2812 status ring and the one physical button.
 *
 * The ring renders coarse conversation state as solid colours at a bounded
 * refresh rate; it is deliberately not the donor's animated three-sector
 * conversation-lights surface, which belonged to a metrics/capability layer
 * this consolidation does not port. Colours stay dim: these are exposed
 * physical LEDs, not a backlit panel.
 */
#include "havpe_ui.h"

#include <string.h>

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "led_strip.h"

static const char tag[] = "havpe-ui";

enum {
  LED_COUNT = 12,
  LED_GPIO = 21,
  LED_POWER_GPIO = 45,
  /* The rail needs to settle before the first RMT refresh is honest. */
  LED_POWER_ENABLE_MS = 20,
  BUTTON_GPIO = 0,
  BUTTON_DEBOUNCE_MS = 30,
  /* Shorter is a tap (call toggle); longer is push-to-talk. */
  BUTTON_TAP_THRESHOLD_MS = 250,
  /* 20 Hz ceiling on ring refreshes. */
  RING_REFRESH_MIN_US = 50000,
};

struct rgb {
  uint8_t red;
  uint8_t green;
  uint8_t blue;
};

static struct {
  led_strip_handle_t strip;
  enum havpe_ui_state state;
  bool call_active;
  bool link_ready;
  bool call_requested;
  bool dirty;
  /* False until the ring has actually been written once; see the tick. */
  bool painted;
  int64_t last_refresh_us;
  struct rgb shown;
} ui;

static struct {
  bool level_pressed;
  bool debounced_pressed;
  uint64_t changed_at_ms;
  uint64_t pressed_since_ms;
  bool talk_latched;
  bool tap_pending;
} button;

static uint64_t now_ms(void) {
  return (uint64_t)(esp_timer_get_time() / 1000);
}

bool havpe_ui_init(void) {
  const gpio_config_t power_config = {
    .pin_bit_mask = 1ULL << LED_POWER_GPIO,
    .mode = GPIO_MODE_OUTPUT,
    .pull_up_en = GPIO_PULLUP_DISABLE,
    .pull_down_en = GPIO_PULLDOWN_DISABLE,
    .intr_type = GPIO_INTR_DISABLE,
  };
  if (gpio_config(&power_config) != ESP_OK ||
      gpio_set_level(LED_POWER_GPIO, 1) != ESP_OK) {
    ESP_LOGE(tag, "ring power rail configuration failed");
    return false;
  }
  vTaskDelay(pdMS_TO_TICKS(LED_POWER_ENABLE_MS));

  const led_strip_config_t strip_config = {
    .strip_gpio_num = LED_GPIO,
    .max_leds = LED_COUNT,
    .led_pixel_format = LED_PIXEL_FORMAT_GRB,
    .led_model = LED_MODEL_WS2812,
    .flags = {.invert_out = false},
  };
  const led_strip_rmt_config_t rmt_config = {
    .clk_src = RMT_CLK_SRC_DEFAULT,
    .resolution_hz = 10 * 1000 * 1000,
    .mem_block_symbols = 0,
    .flags = {.with_dma = false},
  };
  if (led_strip_new_rmt_device(&strip_config, &rmt_config, &ui.strip) !=
      ESP_OK) {
    ESP_LOGE(tag, "ring bring-up failed");
    return false;
  }

  const gpio_config_t button_config = {
    .pin_bit_mask = 1ULL << BUTTON_GPIO,
    .mode = GPIO_MODE_INPUT,
    .pull_up_en = GPIO_PULLUP_ENABLE,
    .pull_down_en = GPIO_PULLDOWN_DISABLE,
    .intr_type = GPIO_INTR_DISABLE,
  };
  if (gpio_config(&button_config) != ESP_OK) {
    ESP_LOGE(tag, "center button configuration failed");
    return false;
  }

  ui.state = HAVPE_UI_CONNECTING;
  ui.dirty = true;
  havpe_ui_tick();
  return true;
}

/*
 * THIS RING IS THE ONLY THING THIS BOARD CAN SAY. It has no screen, so every
 * one of these colours has to be legible across a room in daylight — and the
 * first version was not: idle was {0,0,2}, two parts in 255 of blue, which
 * reads as a dead device to anyone looking at it. "Barely on" was the intent
 * and invisible was the result, reported as "the LEDs aren't on when it's on".
 *
 * So these are floors, not tastes. Nothing that means "alive" goes below ~12
 * of 255, which is the level at which a WS2812 is unambiguously lit rather
 * than arguably lit; the states that mean something is HAPPENING sit near 72
 * so they are distinguishable from the resting glow at a glance rather than by
 * comparison. Twelve LEDs at these levels is a few tens of milliamps, which is
 * nothing next to the XMOS and the speaker this board already runs.
 */
static struct rgb state_colour(void) {
  if (!ui.link_ready) {
    return (struct rgb){72, 24, 0}; /* amber: offline or reconnecting */
  }
  switch (ui.state) {
    case HAVPE_UI_LISTENING:
      return (struct rgb){0, 72, 12}; /* green: microphone is live */
    case HAVPE_UI_SPEAKING:
      return (struct rgb){0, 24, 72}; /* blue: the agent is talking */
    case HAVPE_UI_CONNECTING:
      return (struct rgb){72, 24, 0};
    case HAVPE_UI_IDLE:
      break;
  }
  if (ui.call_active) {
    return (struct rgb){24, 24, 40}; /* slate: call open, nobody talking */
  }
  return (struct rgb){12, 12, 16}; /* resting: powered and connected */
}

void havpe_ui_set_state(enum havpe_ui_state state) {
  if (ui.state == state) return;
  ui.state = state;
  ui.dirty = true;
}

void havpe_ui_set_status(const char *status) {
  /*
   * A twelve-pixel ring cannot render prose. Status strings still arrive so
   * the composition can rhyme with the screen boards; the interesting ones
   * are already visible as state colours, and the exact text goes to the
   * console log where a person debugging actually reads it.
   */
  if (status != NULL && status[0] != '\0') {
    ESP_LOGI(tag, "status: %s", status);
  }
}

void havpe_ui_set_call_active(bool active) {
  if (ui.call_active == active) return;
  ui.call_active = active;
  ui.dirty = true;
}

void havpe_ui_set_link_ready(bool ready) {
  if (ui.link_ready == ready) return;
  ui.link_ready = ready;
  ui.dirty = true;
}

void havpe_ui_request_call(bool wanted) {
  ui.call_requested = wanted;
}

bool havpe_ui_call_requested(void) {
  return ui.call_requested;
}

void havpe_ui_tick(void) {
  if (!ui.dirty || ui.strip == NULL) return;
  const int64_t now_us = esp_timer_get_time();
  if (now_us - ui.last_refresh_us < RING_REFRESH_MIN_US) return;
  const struct rgb colour = state_colour();
  /*
   * `shown` starts black, so "equal to what is shown" is a lie until the first
   * successful refresh — and any state whose colour happened to be black would
   * clear `dirty` and never light the ring at all, which is unfalsifiable from
   * the outside on a board with no screen. Paint once, then compare.
   */
  if (ui.painted && memcmp(&colour, &ui.shown, sizeof(colour)) == 0) {
    ui.dirty = false;
    return;
  }
  for (int index = 0; index < LED_COUNT; ++index) {
    (void)led_strip_set_pixel(
        ui.strip, index, colour.red, colour.green, colour.blue);
  }
  if (led_strip_refresh(ui.strip) == ESP_OK) {
    ui.painted = true;
    ui.shown = colour;
    ui.last_refresh_us = now_us;
    ui.dirty = false;
  }
}

void havpe_button_poll(void) {
  const uint64_t now = now_ms();
  const bool pressed = gpio_get_level(BUTTON_GPIO) == 0;
  if (pressed != button.level_pressed) {
    button.level_pressed = pressed;
    button.changed_at_ms = now;
  }
  if (pressed != button.debounced_pressed &&
      now - button.changed_at_ms >= BUTTON_DEBOUNCE_MS) {
    button.debounced_pressed = pressed;
    if (pressed) {
      button.pressed_since_ms = now;
      button.talk_latched = false;
    } else if (!button.talk_latched) {
      /* Released before the threshold: a completed tap. */
      button.tap_pending = true;
    } else {
      button.talk_latched = false;
    }
  }
  if (button.debounced_pressed && !button.talk_latched &&
      now - button.pressed_since_ms >= BUTTON_TAP_THRESHOLD_MS) {
    button.talk_latched = true;
  }
}

bool havpe_button_talk_held(void) {
  return button.talk_latched && button.debounced_pressed;
}

bool havpe_button_take_tap(void) {
  const bool tapped = button.tap_pending;
  button.tap_pending = false;
  return tapped;
}
