/* The panel's touch controller, polled as described in waveshare_touch.h. */

#include "waveshare_touch.h"

#include "bsp/esp-bsp.h"
#include "bsp/touch.h"
#include "driver/gpio.h"
#include "esp_lcd_touch.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "iterate/kit/touch_tap.h"

static const char tag[] = "waveshare-touch";

enum {
  /*
   * How often the glass is looked at, in milliseconds.
   *
   * The same cadence the lower button uses, and for the same reason: a finger is
   * on the screen for a tenth of a second at the very least, so polling faster
   * would buy nothing a person could perceive.
   */
  POLL_PERIOD_MS = 25,
  /*
   * THE INTERRUPT PIN IS WHAT MAKES THIS CHEAP, AND QUIET.
   *
   * The FT3168 sleeps between touches and NACKs every register read while it
   * does. Polling it over I2C regardless produced 4,379 lines of driver error in
   * thirty idle seconds — five ESP_LOGE lines per attempt, forty times a second,
   * on the bus the codec and the buttons share — and no way to tell that flood
   * from a real fault.
   *
   * So the I2C read only happens when the controller says there is something to
   * read. INT is a plain GPIO, asserted LOW (the BSP configures GPIO 21 with
   * levels.interrupt = 0), and reading it costs nothing and touches no bus. An
   * idle device now does no I2C for touch at all.
   */
  INTERRUPT_ASSERTED_LEVEL = 0,
};

static struct {
  esp_lcd_touch_handle_t touch;
  struct iterate_kit_touch_tap tap;
  bool pending;
  uint64_t polled_at_ms;
  uint32_t read_failures;
} state;

static uint64_t now_ms(void) {
  return (uint64_t)(esp_timer_get_time() / 1000);
}

bool waveshare_touch_init(void) {
  const bsp_touch_config_t config = {0};

  if (bsp_touch_new(&config, &state.touch) != ESP_OK || state.touch == NULL) {
    ESP_LOGW(tag, "no touch controller; the buttons still work");
    state.touch = NULL;
    return false;
  }
  /*
   * True: the controller's state at boot is unknown, and a device that came up
   * with a finger on it — or with the register still reading touched from before
   * the reset — must not manufacture a tap and start a call nobody asked for.
   * The first observed release establishes the baseline.
   */
  iterate_kit_touch_tap_init(&state.tap, true);
  ESP_LOGI(tag, "touch ready: one tap anywhere starts or ends a call");
  return true;
}

void waveshare_touch_poll(void) {
  /* Read and discarded: the tap decision is deliberately coordinate-free, and
   * the API has no way to ask "is anything touching" without a point. */
  esp_lcd_touch_point_data_t point;
  uint8_t point_count = 0U;
  const uint64_t now = now_ms();
  esp_err_t status;

  if (state.touch == NULL) return;
  if (now - state.polled_at_ms < (uint64_t)POLL_PERIOD_MS) return;
  state.polled_at_ms = now;

  /*
   * Nothing is touching, said by a pin rather than by a bus. This IS a coherent
   * release — unlike a failed read — so the edge detector gets it, which is how
   * a tap completes at all.
   */
  if (gpio_get_level(BSP_LCD_TOUCH_INT) != INTERRUPT_ASSERTED_LEVEL) {
    if (iterate_kit_touch_tap_update(&state.tap, false)) state.pending = true;
    return;
  }

  status = esp_lcd_touch_read_data(state.touch);
  if (status == ESP_OK) {
    status = esp_lcd_touch_get_data(state.touch, &point, &point_count, 1U);
  }
  if (status != ESP_OK) {
    /*
     * A FAILED READ IS NOT A RELEASE. Skipping the sample leaves the last
     * coherent electrical level in force; feeding false into the edge detector
     * would turn a transient bus fault into a tap, and a tap toggles a call.
     */
    state.read_failures++;
    return;
  }
  if (iterate_kit_touch_tap_update(&state.tap, point_count > 0U)) {
    state.pending = true;
  }
}

bool waveshare_touch_take_tap(void) {
  const bool pending = state.pending;
  state.pending = false;
  return pending;
}

uint32_t waveshare_touch_read_failures(void) {
  return state.read_failures;
}
