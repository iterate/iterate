#include "havpe_ui.h"

#include "driver/gpio.h"
#include "esp_log.h"
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

int havpe_ui_take_dial(void) {
  const int steps = dial.steps;
  dial.steps = 0;
  return steps;
}

static const char *last_status;

/** Sample the dial every app pass and log changed status. */
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
      view->status != last_status) {
    /* Voice-view status has static storage. Comparing its identity also
     * handles hints longer than the former 64-byte snapshot. */
    last_status = view->status;
    ESP_LOGI(tag, "status: %s", view->status);
  }
}
