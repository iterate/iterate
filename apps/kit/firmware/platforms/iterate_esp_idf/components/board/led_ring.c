#include "iterate/kit/platforms/led_ring_pixels.h"
#include <string.h>

bool iterate_kit_led_ring_repeat(
    const struct iterate_kit_rgb8 lights[12], uint8_t pixels,
    struct iterate_kit_rgb8 *out) {
  if (lights == NULL || out == NULL || pixels == 0U || pixels % 12U != 0U) return false;
  for (uint8_t index = 0U; index < pixels; ++index) {
    out[index] = lights[index / (pixels / 12U)];
  }
  return true;
}

bool iterate_kit_led_ring_dirty(
    bool painted, const struct iterate_kit_rgb8 shown[12],
    const struct iterate_kit_rgb8 next[12]) {
  return !painted || memcmp(shown, next, 12U * sizeof(*next)) != 0;
}

/** The white volume bar fills from light zero; silence remains visible in red. */
void iterate_kit_led_ring_render_volume(
    uint8_t percent, struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT]) {
  if (percent > 100U) percent = 100U;
  const int lit = ((int)percent * ITERATE_KIT_CONVERSATION_LIGHT_COUNT + 50) / 100;
  for (int index = 0; index < ITERATE_KIT_CONVERSATION_LIGHT_COUNT; ++index) {
    pixels[index] = index < lit
        ? (struct iterate_kit_rgb8){64U, 64U, 64U}
        : (struct iterate_kit_rgb8){0U, 0U, 0U};
  }
  /* Silence is a state, not an absence: one red pixel, as the official
   * firmware's volume display marks a muted speaker. */
  if (percent == 0U) pixels[0] = (struct iterate_kit_rgb8){255U, 64U, 48U};
}

#ifdef ESP_PLATFORM
#include "iterate/kit/platforms/led_ring.h"
#include "iterate/kit/conversation_overlay.h"
#include "driver/gpio.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static struct {
  led_strip_handle_t strip;
  uint8_t pixels;
  bool painted;
  int64_t last_refresh_us;
  struct iterate_kit_rgb8 shown[12];
  struct iterate_kit_rgb8 borrowed[12];
  int64_t borrowed_until_us;
  bool borrow_once;
} ring;

bool iterate_kit_led_ring_start(const struct iterate_kit_led_ring *facts) {
  if (facts == NULL || ring.strip != NULL || facts->pixels == 0U ||
      facts->pixels % 12U != 0U || facts->gpio < 0 || facts->gpio >= GPIO_NUM_MAX ||
      facts->power_gpio < -1 || facts->power_gpio >= GPIO_NUM_MAX) return false;
  if (facts->power_gpio >= 0) {
    const gpio_config_t power_config = {
      .pin_bit_mask = UINT64_C(1) << facts->power_gpio,
      .mode = GPIO_MODE_OUTPUT,
      .pull_up_en = GPIO_PULLUP_DISABLE,
      .pull_down_en = GPIO_PULLDOWN_DISABLE,
      .intr_type = GPIO_INTR_DISABLE,
    };
    if (gpio_config(&power_config) != ESP_OK ||
        gpio_set_level(facts->power_gpio, 1) != ESP_OK) return false;
    vTaskDelay(pdMS_TO_TICKS(20));
  }
  const led_strip_config_t strip_config = {
    .strip_gpio_num = facts->gpio,
    .max_leds = facts->pixels,
    .led_pixel_format = facts->order,
    .led_model = LED_MODEL_WS2812,
    .flags = {.invert_out = false},
  };
  const led_strip_rmt_config_t rmt_config = {
    .clk_src = RMT_CLK_SRC_DEFAULT,
    .resolution_hz = 10 * 1000 * 1000,
    .mem_block_symbols = 0,
    .flags = {.with_dma = false},
  };
  if (led_strip_new_rmt_device(&strip_config, &rmt_config, &ring.strip) != ESP_OK) return false;
  ring.pixels = facts->pixels;
  return true;
}

void iterate_kit_led_ring_borrow(const struct iterate_kit_rgb8 lights[12], uint32_t hold_ms) {
  if (lights == NULL) {
    ring.borrow_once = false;
    ring.borrowed_until_us = 0;
    return;
  }
  memcpy(ring.borrowed, lights, sizeof(ring.borrowed));
  ring.borrowed_until_us = esp_timer_get_time() + (int64_t)hold_ms * 1000;
  ring.borrow_once = hold_ms == 0U;
}

/** Share the twelve-light volume arithmetic across physical ring sizes. */
void iterate_kit_led_ring_show_volume(uint8_t percent, uint32_t hold_ms) {
  struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT];
  iterate_kit_led_ring_render_volume(percent, pixels);
  iterate_kit_led_ring_borrow(pixels, hold_ms);
}

/** Timed gestures outrank HAVPE's continually renewed idle quadrant. */
bool iterate_kit_led_ring_borrowed(void) {
  return esp_timer_get_time() < ring.borrowed_until_us;
}

bool iterate_kit_led_ring_present(
    const struct iterate_kit_conversation_visual_state *state, int64_t now_us) {
  if (ring.strip == NULL || now_us - ring.last_refresh_us < 50000) return false;
  struct iterate_kit_rgb8 lights[12];
  if (ring.borrow_once || now_us < ring.borrowed_until_us) {
    memcpy(lights, ring.borrowed, sizeof(lights));
  } else if (iterate_kit_conversation_needs_attention(state)) {
    /* A disconnected device must visibly keep trying; the shared animation
     * owns that motion, rather than a board-specific colour or breath. */
    iterate_kit_conversation_lights_animate(state, (uint32_t)(now_us / 1000), lights);
  } else {
    iterate_kit_conversation_lights_render(state, lights);
  }
  if (!iterate_kit_led_ring_dirty(ring.painted, ring.shown, lights)) {
    ring.borrow_once = false;
    return true;
  }
  struct iterate_kit_rgb8 pixels[252]; /* largest multiple of twelve in uint8_t */
  if (!iterate_kit_led_ring_repeat(lights, ring.pixels, pixels)) return false;
  for (uint8_t index = 0U; index < ring.pixels; ++index) {
    (void)led_strip_set_pixel(ring.strip, index,
        pixels[index].red, pixels[index].green, pixels[index].blue);
  }
  if (led_strip_refresh(ring.strip) != ESP_OK) return false;
  ring.painted = true;
  memcpy(ring.shown, lights, sizeof(lights));
  ring.last_refresh_us = now_us;
  ring.borrow_once = false;
  return true;
}
#endif
