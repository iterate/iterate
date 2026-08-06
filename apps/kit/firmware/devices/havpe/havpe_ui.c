/*
 * The WS2812 status ring and the one physical button.
 *
 * THIS RING HAS TWELVE LEDS AND THE SHARED LANGUAGE HAS TWELVE LIGHTS. That
 * is not a coincidence — the grammar was designed around this ring — and yet
 * this board spent the consolidation painting all twelve one flat colour,
 * which is why it read as "a sort of white glowy ring" instead of three green
 * for the network, three for the speaker and three for the microphone.
 *
 * So the ring now renders exactly what every screen's status rail renders,
 * pixel for pixel and sector for sector: `conversation_lights` decides the
 * colours, `conversation_overlay` decides whether the whole thing should be
 * breathing because the device is not ready. A person who has learned the
 * lights on the StackChan's screen can read this ring without being told.
 */
#include "havpe_ui.h"

#include <string.h>

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "iterate/kit/conversation_lights.h"
#include "iterate/kit/conversation_overlay.h"
#include "led_strip.h"

static const char tag[] = "havpe-ui";

enum {
  LED_COUNT = ITERATE_KIT_CONVERSATION_LIGHT_COUNT,
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

static struct {
  led_strip_handle_t strip;
  enum havpe_ui_state state;
  bool call_active;
  bool link_ready;
  bool call_requested;
  /* Unrecoverable start-up fault; see havpe_ui_set_fault. */
  bool fault;
  bool dirty;
  /* False until the ring has actually been written once; see the tick. */
  bool painted;
  int64_t last_refresh_us;
  struct iterate_kit_rgb8 shown[LED_COUNT];
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
 * THIS RING IS THE ONLY THING THIS BOARD CAN SAY, so the snapshot it renders
 * has to be honest about the two states that matter most: whether the network
 * is there, and whether the microphone is open. Everything else this board
 * knows already reaches a person some other way.
 */
static struct iterate_kit_conversation_visual_state ring_state(void) {
  const struct iterate_kit_conversation_visual_state state = {
    .network = ui.link_ready ? ITERATE_KIT_NETWORK_CONNECTED
                             : ITERATE_KIT_NETWORK_CONNECTING,
    .has_wifi_rssi = false,
    .wifi_rssi_dbm = 0,
    .conversation_active = ui.call_active,
    .media_ready = ui.link_ready,
    .media_failed = ui.fault,
    .microphone_listening = ui.state == HAVPE_UI_LISTENING,
    .microphone_peak = 0U,
    /*
     * This board has no physical playout tap to sample, so speaking is taken
     * from the state the app loop settles. It is one frame early rather than
     * wrong, and only the LED brightness depends on it.
     */
    .speaker_peak = ui.state == HAVPE_UI_SPEAKING ? 4096U : 0U,
    .restart_armed = false,
  };
  return state;
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

void havpe_ui_set_fault(void) {
  if (ui.fault) return;
  ui.fault = true;
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
  if (ui.strip == NULL) return;
  const int64_t now_us = esp_timer_get_time();
  const struct iterate_kit_conversation_visual_state state = ring_state();
  /*
   * A DEVICE THAT IS NOT READY MUST NOT LOOK LIKE A STILL PHOTOGRAPH. While
   * the link is down the ring breathes, so this tick has real work to do on
   * every pass and cannot wait for a state change to be marked dirty. Once
   * the device is ready the breath stops at full brightness and the change
   * gate below goes quiet again.
   */
  const bool breathing = iterate_kit_conversation_needs_attention(&state);
  if (!ui.dirty && !breathing) return;
  if (now_us - ui.last_refresh_us < RING_REFRESH_MIN_US) return;
  {
    struct iterate_kit_rgb8 pixels[LED_COUNT];
    const uint8_t scale = iterate_kit_conversation_attention_scale(
        &state, (uint32_t)(now_us / 1000));
    iterate_kit_conversation_lights_render(&state, pixels);
    for (int index = 0; index < LED_COUNT; ++index) {
      pixels[index].red = (uint8_t)(((uint32_t)pixels[index].red * scale) / 255U);
      pixels[index].green =
          (uint8_t)(((uint32_t)pixels[index].green * scale) / 255U);
      pixels[index].blue =
          (uint8_t)(((uint32_t)pixels[index].blue * scale) / 255U);
    }
    /*
     * `shown` starts black, so "equal to what is shown" is a lie until the
     * first successful refresh — and any state whose colour happened to be
     * black would clear `dirty` and never light the ring at all, which is
     * unfalsifiable from the outside on a board with no screen. Paint once,
     * then compare.
     */
    if (ui.painted && memcmp(pixels, ui.shown, sizeof(pixels)) == 0) {
      ui.dirty = false;
      return;
    }
    for (int index = 0; index < LED_COUNT; ++index) {
      (void)led_strip_set_pixel(
          ui.strip,
          index,
          pixels[index].red,
          pixels[index].green,
          pixels[index].blue);
    }
    if (led_strip_refresh(ui.strip) == ESP_OK) {
      ui.painted = true;
      memcpy(ui.shown, pixels, sizeof(pixels));
      ui.last_refresh_us = now_us;
      ui.dirty = false;
    }
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
