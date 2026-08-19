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
#include "havpe_modes.h"
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
  /* The rotary ring around the top face: same pins and quadrature grain as
   * the official firmware's `dial` (pin_a GPIO16, pin_b GPIO18,
   * resolution 2). */
  DIAL_A_GPIO = 16,
  DIAL_B_GPIO = 18,
  /* 20 Hz ceiling on ring refreshes. */
  RING_REFRESH_MIN_US = 50000,
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
  led_strip_handle_t strip;
  enum havpe_ui_state state;
  bool call_active;
  /*
   * INTENT, mirrored so the ring can say "trying" from the press itself —
   * see ring_state() for what wanting an inactive call does to the snapshot.
   */
  bool wants_call;
  enum ring_overlay overlay;
  /* Volume percent or mode index, depending on the overlay kind. */
  uint8_t overlay_value;
  int64_t overlay_until_us;
  /* The adopted mode, whose quadrant is the idle ring. HAVPE_MODE_COUNT
   * until the composition's restore sets it. */
  uint8_t mode;
  bool link_ready;
  /*
   * The two rungs beneath a call, kept apart from `link_ready` on purpose.
   *
   * `link_ready` is the gate every producer sits behind and is true only when
   * the WHOLE chain is usable. These two say which half of it is up, which is
   * the difference between "wait a second" and "this will never work".
   */
  bool api_ready;
  bool stream_ready;
  /* Unrecoverable start-up fault; see havpe_ui_set_fault. */
  bool fault;
  bool dirty;
  /* False until the ring has actually been written once; see the tick. */
  bool painted;
  int64_t last_refresh_us;
  struct iterate_kit_rgb8 shown[LED_COUNT];
} ui;

/*
 * Written by the capture task, read by the app task. A single aligned word,
 * so a torn read is impossible here and the worst case is one stale frame of
 * a meter that redraws twenty times a second.
 */
static volatile uint32_t microphone_peak;

void havpe_ui_set_microphone_peak(uint32_t peak) {
  microphone_peak = peak;
}

static struct {
  bool level_pressed;
  bool debounced_pressed;
  uint64_t changed_at_ms;
  uint64_t pressed_since_ms;
  bool talk_latched;
  bool tap_pending;
} button;

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

  ui.state = HAVPE_UI_CONNECTING;
  ui.mode = HAVPE_MODE_COUNT;
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
  struct iterate_kit_conversation_visual_state state = {
    .network = ui.link_ready ? ITERATE_KIT_NETWORK_CONNECTED
                             : ITERATE_KIT_NETWORK_CONNECTING,
    .reach =
        iterate_kit_reach_from(ui.api_ready, ui.stream_ready, ui.call_active),
    .has_wifi_rssi = false,
    .wifi_rssi_dbm = 0,
    .conversation_active = ui.call_active,
    .media_ready = ui.link_ready,
    .media_failed = ui.fault,
    .microphone_listening = ui.state == HAVPE_UI_LISTENING,
    .microphone_peak = microphone_peak,
    /*
     * This board has no physical playout tap to sample, so speaking is taken
     * from the state the app loop settles. It is one frame early rather than
     * wrong, and only the LED brightness depends on it.
     */
    .speaker_peak = ui.state == HAVPE_UI_SPEAKING ? 4096U : 0U,
    .restart_armed = false,
  };
  /*
   * A PRESS THAT IS NOT YET A CALL MUST LOOK LIKE THE DEVICE WORKING ON IT.
   * The tap used to be answered by nothing at all until the far end accepted
   * the call seconds later — a still ring under a pressed button reads as a
   * dead button. The fleet has exactly ONE "working on it" animation, the
   * amber comet, and `needs_attention` is its trigger; so for as long as the
   * intent is ahead of the call the snapshot says not-ready on purpose, and
   * the instant call_active flips the view owns the ring again. This also
   * keeps the tick breathing, which is what repaints the chase.
   */
  if (ui.wants_call && !ui.call_active) state.media_ready = false;
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

void havpe_ui_set_wants_call(bool wanted) {
  if (ui.wants_call == wanted) return;
  ui.wants_call = wanted;
  ui.dirty = true;
}

void havpe_ui_show_volume(uint8_t percent) {
  ui.overlay = OVERLAY_VOLUME;
  ui.overlay_value = percent > 100U ? 100U : percent;
  ui.overlay_until_us = esp_timer_get_time() + OVERLAY_HOLD_US;
  ui.dirty = true;
}

void havpe_ui_show_mode(uint8_t mode) {
  if (mode >= HAVPE_MODE_COUNT) return;
  ui.overlay = OVERLAY_MODE;
  ui.overlay_value = mode;
  ui.overlay_until_us = esp_timer_get_time() + OVERLAY_HOLD_US;
  ui.dirty = true;
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

void havpe_ui_set_api_ready(bool ready) {
  if (ui.api_ready == ready) return;
  ui.api_ready = ready;
  ui.dirty = true;
}

void havpe_ui_set_stream_ready(bool ready) {
  if (ui.stream_ready == ready) return;
  ui.stream_ready = ready;
  ui.dirty = true;
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

void havpe_ui_tick(void) {
  if (ui.strip == NULL) return;
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
    /*
     * ONE CALL, and it is the same one the screens make for their status
     * rail. Everything this ring knows about what device state looks like
     * lives on the other side of it — except the two dial overlays, which
     * borrow the ring for one second of direct feedback and then give it
     * back.
     */
    if (ui.overlay == OVERLAY_VOLUME) {
      render_volume(pixels);
    } else if (ui.overlay == OVERLAY_MODE) {
      render_quadrant(pixels, ui.overlay_value, MODE_QUADRANT_BRIGHT);
    } else if (!breathing && !ui.wants_call && !ui.call_active &&
               ui.mode < HAVPE_MODE_COUNT) {
      /*
       * IDLE HAS A FACE. No session and nothing wrong: the ring shows the
       * adopted mode's quadrant, dim — the microphone is sending nothing,
       * and the one fact worth a glance is which posture the next press
       * will take. The session states own every other frame: waking is the
       * amber comet (breathing above), a live call is the shared lights.
       */
      render_quadrant(pixels, ui.mode, MODE_QUADRANT_DIM);
    } else {
      iterate_kit_conversation_lights_animate(
          &state, (uint32_t)(now_us / 1000), pixels);
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
