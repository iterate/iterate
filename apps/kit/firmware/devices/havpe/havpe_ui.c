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

#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "havpe_modes.h"
#include "iterate/kit/button.h"
#include "iterate/kit/conversation_lights.h"
#include "iterate/kit/conversation_overlay.h"
#include "iterate/kit/platforms/led_ring.h"

static const char tag[] = "havpe-ui";

enum {
  LED_COUNT = ITERATE_KIT_CONVERSATION_LIGHT_COUNT,
  LED_GPIO = 21,
  LED_POWER_GPIO = 45,
  BUTTON_GPIO = 0,
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
enum ring_overlay {
  OVERLAY_NONE = 0,
  /* N of 12 pixels lit: the volume, exactly as the official firmware. */
  OVERLAY_VOLUME,
  /* One lit quadrant of 3: which of the four modes the wheel shows. */
  OVERLAY_MODE,
};

static struct {
  bool started;
  struct iterate_kit_voice_view view;
  enum ring_overlay overlay;
  /* Volume percent or mode index, depending on the overlay kind. */
  uint8_t overlay_value;
  int64_t overlay_until_us;
  /* The adopted mode, whose quadrant is the idle ring. HAVPE_MODE_COUNT
   * until the composition's restore sets it. */
  uint8_t mode;
  bool dirty;
} ui;

static struct iterate_kit_button button;

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

static uint64_t now_ms(void) {
  return (uint64_t)(esp_timer_get_time() / 1000);
}

bool havpe_ui_init(void) {
  const struct iterate_kit_led_ring ring = {
    .gpio = LED_GPIO,
    .pixels = LED_COUNT,
    .order = LED_PIXEL_FORMAT_GRB,
    .power_gpio = LED_POWER_GPIO,
  };
  if (!iterate_kit_led_ring_start(&ring)) {
    ESP_LOGE(tag, "ring bring-up failed");
    return false;
  }
  ui.started = true;

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

  ui.view.screen = ITERATE_KIT_VOICE_SCREEN_CONNECTING;
  ui.mode = HAVPE_MODE_COUNT;
  ui.dirty = true;
  havpe_ui_tick();
  return true;
}

void havpe_ui_present(const struct iterate_kit_voice_view *view) {
  if (ui.view.screen != view->screen ||
      ui.view.call_active != view->call_active ||
      ui.view.wants_call != view->wants_call ||
      ui.view.link_ready != view->link_ready ||
      ui.view.api_ready != view->api_ready ||
      ui.view.stream_ready != view->stream_ready ||
      (!ui.view.fault && view->fault)) ui.dirty = true;
  const bool fault = ui.view.fault || view->fault;
  ui.view = *view;
  ui.view.fault = fault;
  /* A twelve-pixel ring cannot render prose; retain the console status. */
  if (view->status != NULL && view->status[0] != '\0') {
    ESP_LOGI(tag, "status: %s", view->status);
  }
}

void havpe_ui_set_mode(uint8_t mode) {
  if (mode >= HAVPE_MODE_COUNT || ui.mode == mode) return;
  ui.mode = mode;
  ui.dirty = true;
}

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

static void render_volume(struct iterate_kit_rgb8 pixels[LED_COUNT]) {
  const int lit =
      ((int)ui.overlay_value * LED_COUNT + 50) / 100;
  for (int index = 0; index < LED_COUNT; ++index) {
    pixels[index] = index < lit
        ? (struct iterate_kit_rgb8){64U, 64U, 64U}
        : (struct iterate_kit_rgb8){0U, 0U, 0U};
  }
  /* Silence is a state, not an absence: one red pixel, as the official
   * firmware's volume display marks a muted speaker. */
  if (ui.overlay_value == 0U) {
    pixels[0] = (struct iterate_kit_rgb8){255U, 64U, 48U};
  }
}

static void render_quadrant(
    struct iterate_kit_rgb8 pixels[LED_COUNT], uint8_t mode, uint8_t level) {
  const int first = (int)mode * 3;
  for (int index = 0; index < LED_COUNT; ++index) {
    pixels[index] = index >= first && index < first + 3
        ? (struct iterate_kit_rgb8){level, level, level}
        : (struct iterate_kit_rgb8){0U, 0U, 0U};
  }
}

void havpe_ui_show_volume(uint8_t percent) {
  ui.overlay = OVERLAY_VOLUME;
  ui.overlay_value = percent > 100U ? 100U : percent;
  ui.overlay_until_us = esp_timer_get_time() + OVERLAY_HOLD_US;
  struct iterate_kit_rgb8 pixels[LED_COUNT];
  render_volume(pixels);
  iterate_kit_led_ring_borrow(pixels, (uint32_t)(OVERLAY_HOLD_US / 1000));
  ui.dirty = true;
}

void havpe_ui_show_mode(uint8_t mode) {
  if (mode >= HAVPE_MODE_COUNT) return;
  ui.overlay = OVERLAY_MODE;
  ui.overlay_value = mode;
  ui.overlay_until_us = esp_timer_get_time() + OVERLAY_HOLD_US;
  struct iterate_kit_rgb8 pixels[LED_COUNT];
  render_quadrant(pixels, ui.overlay_value, MODE_QUADRANT_BRIGHT);
  iterate_kit_led_ring_borrow(pixels, (uint32_t)(OVERLAY_HOLD_US / 1000));
  ui.dirty = true;
}

void havpe_ui_tick(void) {
  if (!ui.started) return;
  const int64_t now_us = esp_timer_get_time();
  /* The dial is sampled here, every pass, whatever the ring is doing —
   * see the note at the `dial` struct for why not the 25 ms control poll. */
  dial.steps += havpe_dial_decoder_step(
      &dial.decoder,
      gpio_get_level(DIAL_A_GPIO) != 0,
      gpio_get_level(DIAL_B_GPIO) != 0);
  if (ui.overlay != OVERLAY_NONE && now_us >= ui.overlay_until_us) {
    /* The gesture's second is up; repaint whatever the state animation
     * would have shown. */
    ui.overlay = OVERLAY_NONE;
    ui.dirty = true;
  }
  struct iterate_kit_conversation_visual_state state;
  iterate_kit_voice_view_lights(&ui.view, &state);
  /*
   * A DEVICE THAT IS NOT READY MUST NOT LOOK LIKE A STILL PHOTOGRAPH. While
   * the link is down the ring breathes, so this tick has real work to do on
   * every pass and cannot wait for a state change to be marked dirty. Once
   * the device is ready the breath stops at full brightness and the change
   * gate below goes quiet again.
   */
  const bool breathing = iterate_kit_conversation_needs_attention(&state);
  if (!ui.dirty && !breathing) return;
  if (ui.overlay == OVERLAY_NONE) iterate_kit_led_ring_borrow(NULL, 0U);
  if (ui.overlay == OVERLAY_NONE && !breathing && !ui.view.wants_call &&
      !ui.view.call_active && ui.mode < HAVPE_MODE_COUNT) {
    /* Idle has a face: the adopted mode's dim quadrant. The board borrows
     * exactly this presentation; a call or fault owns the very next one. */
    struct iterate_kit_rgb8 pixels[LED_COUNT];
    render_quadrant(pixels, ui.mode, MODE_QUADRANT_DIM);
    iterate_kit_led_ring_borrow(pixels, 0U);
  }
  if (iterate_kit_led_ring_present(&state, now_us)) ui.dirty = false;
}

void havpe_button_poll(void) {
  iterate_kit_button_update(&button, gpio_get_level(BUTTON_GPIO) == 0, now_ms());
}

void havpe_button_inject_tap(void) { iterate_kit_button_inject_tap(&button); }

bool havpe_button_take_end_hold(void) {
  return iterate_kit_button_take_end_hold(&button);
}

bool havpe_button_talk_held(void) {
  return iterate_kit_button_held(&button);
}

bool havpe_button_take_tap(void) {
  return iterate_kit_button_take_tap(&button);
}
