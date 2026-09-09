#include "havpe_ui.h"

#include "driver/gpio.h"
#include "esp_log.h"
#include <string.h>
#include "esp_timer.h"
#include "havpe_modes.h"
#include "iterate/kit/conversation_lights.h"
#include "iterate/kit/conversation_overlay.h"
#include "iterate/kit/platforms/led_ring.h"

static const char tag[] = "havpe-ui";

enum {
  LED_COUNT = ITERATE_KIT_CONVERSATION_LIGHT_COUNT,
  /* The rotary ring around the top face: same pins and quadrature grain as
   * the official firmware's `dial` (pin_a GPIO16, pin_b GPIO18,
   * resolution 2). */
  DIAL_A_GPIO = 16,
  DIAL_B_GPIO = 18,
  /* How long a dial gesture owns the ring before the state animation
   * returns — the official firmware's own 1 s "Volume Display" dwell. */
  OVERLAY_HOLD_US = 1000000,
};

/*
 * What the dial has borrowed the ring for. The overlay outranks the state
 * animation for OVERLAY_HOLD_US after the last gesture, because feedback that
 * arrives after the finger has left is decoration, not feedback.
 */
static uint8_t mode = HAVPE_MODE_COUNT;

/*
 * The dial, sampled by the tick rather than the control poll on purpose: the
 * tick runs every app-loop pass (~5 ms) while controls are polled at a human
 * 25 ms, and a quadrature decoder is the one input here that decays with the
 * sampling rate — each missed intermediate state is a lost count. Counts
 * accumulate here and the composition drains them at its own cadence. Both
 * run on the app task, which is why a plain int is enough.
 */
static struct {
  struct havpe_dial_decoder decoder;
  int steps;
} dial;

bool havpe_ui_init(void) {
  {
    /* Internal pull-ups, harmless if the board provides its own: a floating
     * quadrature pin reads as an endlessly spinning dial. */
    const gpio_config_t dial_config = {
      .pin_bit_mask = (1ULL << DIAL_A_GPIO) | (1ULL << DIAL_B_GPIO),
      .mode = GPIO_MODE_INPUT,
      .pull_up_en = GPIO_PULLUP_ENABLE,
      .pull_down_en = GPIO_PULLDOWN_DISABLE,
      .intr_type = GPIO_INTR_DISABLE,
    };
    if (gpio_config(&dial_config) != ESP_OK) {
      ESP_LOGE(tag, "dial configuration failed");
      return false;
    }
    /* Seed from the live levels so the first sample is never a phantom
     * transition out of an assumed 00. */
    havpe_dial_decoder_init(
        &dial.decoder,
        gpio_get_level(DIAL_A_GPIO) != 0,
        gpio_get_level(DIAL_B_GPIO) != 0);
  }

  return true;
}

void havpe_ui_set_mode(uint8_t value) { mode = value; }

int havpe_ui_take_dial(void) {
  const int steps = dial.steps;
  dial.steps = 0;
  return steps;
}

/*
 * The dial overlays and the idle quadrant. All are the WHITE of no particular
 * sector — the shared grammar's colours all mean something, and a level meter
 * borrowing the network's green would say the network moved — and they are
 * told apart by shape and brightness: the volume fills from pixel zero, a
 * mode lights one quadrant, bright for the second a gesture owns the ring and
 * dim for the idle steady state.
 */
enum {
  /* Plainly lit for the one-second overlay a finger just asked for... */
  MODE_QUADRANT_BRIGHT = 64,
  /* ...and barely lit for the hours it is merely a fact. 8 of 255 is visible
   * on an exposed WS2812 and reads as a state, not an event. */
  MODE_QUADRANT_DIM = 8,
};

static void render_quadrant(
    struct iterate_kit_rgb8 pixels[LED_COUNT], uint8_t mode, uint8_t level) {
  const int first = (int)mode * 3;
  for (int index = 0; index < LED_COUNT; ++index) {
    pixels[index] = index >= first && index < first + 3
        ? (struct iterate_kit_rgb8){level, level, level}
        : (struct iterate_kit_rgb8){0U, 0U, 0U};
  }
}

void havpe_ui_show_mode(uint8_t value) {
  if (value >= HAVPE_MODE_COUNT) return;
  struct iterate_kit_rgb8 pixels[LED_COUNT];
  render_quadrant(pixels, value, MODE_QUADRANT_BRIGHT);
  iterate_kit_led_ring_borrow(pixels, OVERLAY_HOLD_US / 1000);
}

static char last_status[64];

void havpe_ui_present(const struct iterate_kit_voice_view *view) {
  /* Every app pass (~5 ms), not the slower 25 ms control poll: missed
   * intermediate quadrature states are lost counts. */
  dial.steps += havpe_dial_decoder_step(
      &dial.decoder, gpio_get_level(DIAL_A_GPIO) != 0, gpio_get_level(DIAL_B_GPIO) != 0);
  /* A twelve-pixel ring cannot render prose, so the console carries the
   * status word: ONCE PER CHANGE. Logging it every 5 ms pass (the table
   * step's first boot printed it 5,749 times in 75 s) buries every other
   * line and costs the app task a UART write per pass. */
  if (view->status != NULL && view->status[0] != '\0' &&
      strncmp(view->status, last_status, sizeof(last_status)) != 0) {
    strlcpy(last_status, view->status, sizeof(last_status));
    ESP_LOGI(tag, "status: %s", view->status);
  }
  if (iterate_kit_led_ring_borrowed()) return;
  iterate_kit_led_ring_borrow(NULL, 0);
  struct iterate_kit_conversation_visual_state state;
  iterate_kit_voice_view_lights(view, &state);
  if (!iterate_kit_conversation_needs_attention(&state) &&
      !view->wants_call && !view->call_active && mode < HAVPE_MODE_COUNT) {
    struct iterate_kit_rgb8 pixels[LED_COUNT];
    render_quadrant(pixels, mode, MODE_QUADRANT_DIM);
    /* extra runs after the ring. Borrow for its next presentation, including
     * the throttle interval; a timed dial overlay still outranks this. */
    iterate_kit_led_ring_borrow(pixels, 0);
  }
}
