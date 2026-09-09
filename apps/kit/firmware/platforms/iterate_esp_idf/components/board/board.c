#include "iterate/kit/platforms/board.h"

uint8_t iterate_kit_board_volume_code(
    const struct iterate_kit_volume_register *volume, uint8_t ceiling,
    uint8_t percent, uint8_t *applied) {
  if (ceiling > 100U) ceiling = 100U;
  if (percent > ceiling) percent = ceiling;
  if (applied != NULL) *applied = percent;
  return (uint8_t)(volume->floor_code +
      ((int32_t)volume->full_code - volume->floor_code) * percent / 100);
}

bool iterate_kit_board_boot_steps(
    const struct iterate_kit_gpio_step *steps, size_t count,
    bool (*drive)(int8_t gpio, uint8_t level), void (*wait)(uint16_t ms)) {
  if ((count != 0U && steps == NULL) || drive == NULL || wait == NULL) return false;
  for (size_t i = 0; i < count; ++i) {
    if (steps[i].gpio < 0 || steps[i].level > 1U || !drive(steps[i].gpio, steps[i].level)) return false;
    if (steps[i].hold_ms != 0U) wait(steps[i].hold_ms);
  }
  return true;
}

/** Slot bytes and nominal clock must describe the same 16 kHz PCM contract. */
bool iterate_kit_i2s_codec_valid_channel(
    i2s_port_t port, const i2s_std_config_t *config,
    const struct iterate_kit_pcm_shape *shape,
    uint16_t frames, uint8_t descriptors) {
  const size_t bytes = iterate_kit_pcm_bytes_for_frames(shape, frames);
  return (unsigned)port < SOC_I2S_NUM && bytes > 0U && bytes <= 4092U &&
      descriptors > 0U &&
      config->clk_cfg.sample_rate_hz == 16000U * shape->ratio &&
      config->slot_cfg.data_bit_width == shape->bits &&
      (config->slot_cfg.slot_bit_width == I2S_SLOT_BIT_WIDTH_AUTO ||
       config->slot_cfg.slot_bit_width == shape->bits) &&
      (unsigned)config->slot_cfg.slot_mode == shape->slots &&
      config->gpio_cfg.bclk >= 0 && config->gpio_cfg.ws >= 0;
}

/** Equal controllers must share clocks; separate controllers cannot drive the
 * same pins. M5 deliberately uses open_playback because its mic swaps owners.
 */
bool iterate_kit_i2s_codec_valid(const struct iterate_kit_i2s_codec_facts *facts) {
  if (facts == NULL) return false;
  const bool duplex = facts->capture_port == facts->playback_port;
  if (!iterate_kit_i2s_codec_valid_channel(facts->playback_port, &facts->playback, &facts->playback_shape,
          facts->dma_frames, facts->dma_descriptors) ||
      !iterate_kit_i2s_codec_valid_channel(facts->capture_port, &facts->capture, &facts->capture_shape,
          duplex ? facts->dma_frames : facts->capture_dma_frames,
          duplex ? facts->dma_descriptors : facts->capture_dma_descriptors) ||
      facts->capture_gain == 0U ||
      (facts->role != I2S_ROLE_MASTER && facts->role != I2S_ROLE_SLAVE) ||
      facts->amplifier_gpio < -1 || facts->amplifier_gpio >= GPIO_NUM_MAX) return false;
  const i2s_std_gpio_config_t *tx = &facts->playback.gpio_cfg;
  const i2s_std_gpio_config_t *rx = &facts->capture.gpio_cfg;
  if (tx->dout < 0 || rx->din < 0 || tx->dout == rx->din) return false;
  if (duplex) {
    return tx->bclk == rx->bclk && tx->ws == rx->ws && tx->mclk == rx->mclk &&
        (tx->din == I2S_GPIO_UNUSED || tx->din == rx->din) &&
        (rx->dout == I2S_GPIO_UNUSED || rx->dout == tx->dout) &&
        facts->playback.clk_cfg.sample_rate_hz == facts->capture.clk_cfg.sample_rate_hz &&
        facts->playback.clk_cfg.mclk_multiple == facts->capture.clk_cfg.mclk_multiple &&
        facts->playback.clk_cfg.clk_src == facts->capture.clk_cfg.clk_src &&
        facts->playback.slot_cfg.ws_width == facts->capture.slot_cfg.ws_width &&
        facts->playback.slot_cfg.ws_pol == facts->capture.slot_cfg.ws_pol &&
        facts->playback.slot_cfg.bit_shift == facts->capture.slot_cfg.bit_shift &&
        facts->playback.slot_cfg.data_bit_width == facts->capture.slot_cfg.data_bit_width &&
        facts->playback.slot_cfg.slot_mode == facts->capture.slot_cfg.slot_mode &&
        tx->invert_flags.bclk_inv == rx->invert_flags.bclk_inv &&
        tx->invert_flags.ws_inv == rx->invert_flags.ws_inv &&
        tx->invert_flags.mclk_inv == rx->invert_flags.mclk_inv;
  }
  if (tx->din != I2S_GPIO_UNUSED || rx->dout != I2S_GPIO_UNUSED) return false;
  const gpio_num_t tx_pins[] = {tx->mclk, tx->bclk, tx->ws, tx->dout};
  const gpio_num_t rx_pins[] = {rx->mclk, rx->bclk, rx->ws, rx->din};
  for (size_t i = 0; i < sizeof(tx_pins) / sizeof(tx_pins[0]); ++i) {
    for (size_t j = 0; j < sizeof(rx_pins) / sizeof(rx_pins[0]); ++j) {
      if (tx_pins[i] >= 0 && tx_pins[i] == rx_pins[j]) return false;
    }
  }
  return true;
}


#ifdef ESP_PLATFORM
#include "driver/gpio.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "iterate/kit/button.h"
#include "iterate/kit/platforms/wake_word.h"

static const struct iterate_kit_board *board;
static i2c_master_bus_handle_t i2c_bus;
static bool (*i2c_write)(uint8_t address, uint8_t reg, uint8_t value, uint32_t hz);
static struct iterate_kit_button button;
static struct iterate_kit_session session;
static struct iterate_kit_session_actions actions;
static struct iterate_kit_voice_view view;
static enum iterate_kit_voice_turns turns;
static uint8_t volume_percent;

static void wait_ms(uint16_t ms) { vTaskDelay(pdMS_TO_TICKS(ms)); }

static bool drive_gpio(int8_t gpio, uint8_t level) {
  if (gpio < 0 || gpio >= GPIO_NUM_MAX) return false;
  const gpio_config_t config = {
    .pin_bit_mask = UINT64_C(1) << gpio,
    .mode = GPIO_MODE_OUTPUT,
    .pull_up_en = GPIO_PULLUP_DISABLE,
    .pull_down_en = GPIO_PULLDOWN_DISABLE,
    .intr_type = GPIO_INTR_DISABLE,
  };
  return gpio_config(&config) == ESP_OK && gpio_set_level(gpio, level) == ESP_OK;
}

void iterate_kit_board_i2c_write_with(
    bool (*write)(uint8_t address, uint8_t reg, uint8_t value, uint32_t hz)) {
  i2c_write = write;
}

void iterate_kit_board_i2c_use(i2c_master_bus_handle_t bus) { i2c_bus = bus; }

esp_err_t iterate_kit_board_i2c_device(uint8_t address, i2c_master_dev_handle_t *out) {
  if (i2c_bus == NULL) return ESP_ERR_INVALID_STATE;
  const i2c_device_config_t config = {
    .dev_addr_length = I2C_ADDR_BIT_LEN_7,
    .device_address = address,
    .scl_speed_hz = board->i2c.hz,
  };
  return i2c_master_bus_add_device(i2c_bus, &config, out);
}

bool iterate_kit_i2c_write_script(const struct iterate_kit_register_script *script) {
  if (script == NULL || (script->count != 0U && script->writes == NULL)) return false;
  if (i2c_write != NULL) {
    for (size_t i = 0; i < script->count; ++i) {
      if (!i2c_write(script->i2c_address, script->writes[i].address,
              script->writes[i].value, board->i2c.hz)) return false;
    }
    if (script->settle_ms != 0U) wait_ms(script->settle_ms);
    return true;
  }
  i2c_master_dev_handle_t device;
  if (iterate_kit_board_i2c_device(script->i2c_address, &device) != ESP_OK) return false;
  esp_err_t status = ESP_OK;
  for (size_t i = 0; i < script->count && status == ESP_OK; ++i) {
    const uint8_t command[] = {script->writes[i].address, script->writes[i].value};
    status = i2c_master_transmit(device, command, sizeof(command),
        script->timeout_ms == 0U ? 50 : script->timeout_ms);
  }
  const esp_err_t removed = i2c_master_bus_rm_device(device);
  if (status != ESP_OK || removed != ESP_OK) return false;
  if (script->settle_ms != 0U) wait_ms(script->settle_ms);
  return true;
}

static bool run_scripts(bool after_i2s) {
  for (size_t i = 0; i < board->script_count; ++i) {
    const struct iterate_kit_register_script *script = &board->scripts[i];
    if ((script->when == ITERATE_KIT_SCRIPT_AFTER_I2S) == after_i2s &&
        !iterate_kit_i2c_write_script(script)) return false;
  }
  return true;
}

enum iterate_kit_status iterate_kit_board_set_volume(uint8_t percent, uint8_t *applied) {
  uint8_t clamped;
  const uint8_t code = iterate_kit_board_volume_code(
      &board->volume, board->facts.speaker.ceiling, percent, &clamped);
  if (board->volume.register_count != 0U) {
    struct iterate_kit_register_write writes[3];
    size_t count = 0;
    if (board->volume.page_register != 0xffU) {
      writes[count++] = (struct iterate_kit_register_write){board->volume.page_register, board->volume.page};
    }
    for (size_t i = 0; i < board->volume.register_count; ++i) {
      writes[count++] = (struct iterate_kit_register_write){board->volume.registers[i], code};
    }
    const struct iterate_kit_register_script script = {
      .i2c_address = board->volume.i2c_address, .writes = writes, .count = count,
    };
    if (!iterate_kit_i2c_write_script(&script)) return ITERATE_KIT_IO_ERROR;
  } else {
    if (board->set_volume == NULL) return ITERATE_KIT_UNAVAILABLE;
    const enum iterate_kit_status status = board->set_volume(clamped, &clamped);
    if (status != ITERATE_KIT_OK) return status;
  }
  volume_percent = clamped;
  if (applied != NULL) *applied = clamped;
  return ITERATE_KIT_OK;
}

uint8_t iterate_kit_board_volume(void) { return volume_percent; }
static uint8_t volume(void *context) { (void)context; return volume_percent; }
static enum iterate_kit_status set_volume(void *context, uint8_t percent, uint8_t *applied) {
  (void)context;
  return iterate_kit_board_set_volume(percent, applied);
}
void iterate_kit_board_inject_tap(void) { iterate_kit_button_inject_tap(&button); }
void iterate_kit_board_set_turns(enum iterate_kit_voice_turns value) {
  turns = value;
  iterate_kit_voice_loop_set_turns(value);
}
const struct iterate_kit_session_actions *iterate_kit_board_button_actions(void) { return &actions; }

/** Finish wake-word startup on the app task, before accepting any detections.
 * Boards with an extra-owned button classifier must wire that classifier first.
 */
static bool iterate_kit_board_finish_wake_word(void) {
  if (board->wake_word == NULL) return true;
#ifdef CONFIG_ITERATE_KIT_WAKE_WORD
  if (board->button.gpio < 0) return false;
  return iterate_kit_wake_word_start(board->wake_word);
#else
  return false; /* A non-NULL table must never silently lack its component. */
#endif
}

static bool start(void *context, struct iterate_kit_board_audio *out) {
  (void)context;
  if (board->volume.register_count > 2U ||
      (board->script_count != 0U && board->scripts == NULL) ||
      (board->audio != NULL && !iterate_kit_i2s_codec_valid(board->audio)) ||
      (board->ring.pixels != 0U && board->ring.pixels % 12U != 0U)) return false;
  if (board->ring.pixels != 0U) {
    if (!iterate_kit_led_ring_start(&board->ring)) return false;
    /* The only display must be lit throughout the codec's multi-second boot. */
    const struct iterate_kit_voice_view connecting = {.screen = ITERATE_KIT_VOICE_SCREEN_CONNECTING};
    struct iterate_kit_conversation_visual_state lights;
    iterate_kit_voice_view_lights(&connecting, &lights);
    (void)iterate_kit_led_ring_present(&lights, esp_timer_get_time());
  }
  out->processor = iterate_kit_audio_processor_passthrough();
  if (board->extra != NULL && board->extra->start != NULL && !board->extra->start(NULL, out)) return false;
  if (!iterate_kit_board_boot_steps(board->boot, board->boot_count, drive_gpio, wait_ms)) return false;
  if (board->status_led_gpio >= 0 && !drive_gpio(board->status_led_gpio, 0)) return false;
  if (board->button.gpio >= 0) {
    if (board->button.gpio >= GPIO_NUM_MAX) return false;
    const gpio_config_t config = {
      .pin_bit_mask = UINT64_C(1) << board->button.gpio,
      .mode = GPIO_MODE_INPUT,
      .pull_up_en = board->button.active_low ? GPIO_PULLUP_ENABLE : GPIO_PULLUP_DISABLE,
      .pull_down_en = board->button.active_low ? GPIO_PULLDOWN_DISABLE : GPIO_PULLDOWN_ENABLE,
      .intr_type = GPIO_INTR_DISABLE,
    };
    if (gpio_config(&config) != ESP_OK) return false;
  }
  if (i2c_bus == NULL && i2c_write == NULL && board->i2c.sda >= 0 && board->i2c.scl >= 0) {
    const i2c_master_bus_config_t config = {
      .i2c_port = -1, .sda_io_num = board->i2c.sda, .scl_io_num = board->i2c.scl,
      .clk_source = I2C_CLK_SRC_DEFAULT, .glitch_ignore_cnt = 7,
      .flags = {.enable_internal_pullup = true},
    };
    if (i2c_new_master_bus(&config, &i2c_bus) != ESP_OK) return false;
  }
  if (!run_scripts(false)) return false;
  if (board->audio != NULL && !iterate_kit_i2s_codec_start(board->audio, &out->codec)) return false;
  if (!run_scripts(true) || (board->open_codec != NULL && !board->open_codec()) ||
      (board->audio != NULL && !iterate_kit_i2s_codec_finish(&out->codec))) {
    if (board->audio != NULL) iterate_kit_i2s_codec_abort();
    return false;
  }
  if (!iterate_kit_board_finish_wake_word()) return false;
  if (board->facts.speaker.volume != NULL) {
    volume_percent = board->facts.speaker.volume(board->facts.speaker.context);
  }
  return true;
}

static void present(void *context, const struct iterate_kit_voice_view *value) {
  (void)context;
  view = *value;
#ifdef CONFIG_ITERATE_KIT_WAKE_WORD
  if (board->wake_word != NULL) iterate_kit_wake_word_set_enabled(!view.call_active && !view.wants_call);
#endif
  if (board->ring.pixels != 0U) {
    struct iterate_kit_conversation_visual_state lights;
    iterate_kit_voice_view_lights(value, &lights);
    (void)iterate_kit_led_ring_present(&lights, esp_timer_get_time());
  }
  if (board->status_led_gpio >= 0) (void)gpio_set_level(board->status_led_gpio, value->link_ready);
  if (board->extra != NULL && board->extra->present != NULL) board->extra->present(NULL, value);
}

static void poll(void *context, struct iterate_kit_voice_intent *out) {
  (void)context;
  *out = (struct iterate_kit_voice_intent){0};
#ifdef CONFIG_ITERATE_KIT_WAKE_WORD
  /* Worker detections reach the classifier only on this app task. Recheck
   * both mirrors: a queued idle detection must never become a hang-up tap.
   * The existing actions.wake_chime below plays the shared sound exactly once.
   */
  if (board->wake_word != NULL && !view.call_active && !view.wants_call &&
      iterate_kit_wake_word_take_detection()) iterate_kit_board_inject_tap();
#endif
  if (board->button.gpio >= 0) {
    const uint64_t now_ms = (uint64_t)(esp_timer_get_time() / 1000);
    const bool pressed = (gpio_get_level(board->button.gpio) == 0) == board->button.active_low;
    iterate_kit_button_update(&button, pressed, now_ms);
    const struct iterate_kit_session_poll gestures = {
      .tap = iterate_kit_button_take_tap(&button),
      .held = iterate_kit_button_held(&button),
      .end_hold = iterate_kit_button_take_end_hold(&button),
      .wants_call = view.wants_call, .call_active = view.call_active,
      .push_to_talk = turns == ITERATE_KIT_VOICE_TURNS_PUSH_TO_TALK,
      .tap_wakes = board->button.tap_wakes, .tap_ends = board->button.tap_ends,
      .now_ms = now_ms,
    };
    iterate_kit_session_step(&session, &gestures, &actions);
    out->start_call = actions.start_call;
    out->end_call = actions.end_call;
    out->talk_held = actions.talk_held;
    if (actions.end_chime) iterate_kit_i2s_codec_play_sound(board->sounds.ended, board->sounds.ended_bytes);
    if (actions.wake_chime) iterate_kit_i2s_codec_play_sound(board->sounds.wake, board->sounds.wake_bytes);
  }
  if (board->extra != NULL && board->extra->poll != NULL) board->extra->poll(NULL, out);
}

static void phase(void *context, enum iterate_kit_voice_phase value) {
  (void)context;
  iterate_kit_i2s_codec_phase(value);
  if (board->extra != NULL && board->extra->phase != NULL) board->extra->phase(NULL, value);
}

static size_t health(void *context, char *out, size_t capacity) {
  (void)context;
  size_t used = iterate_kit_i2s_codec_health(out, capacity);
#ifdef CONFIG_ITERATE_KIT_WAKE_WORD
  if (used != 0U && board->wake_word != NULL) {
    const size_t added = iterate_kit_wake_word_health(out + used, capacity - used);
    if (added == 0U) return 0U;
    used += added;
  }
#endif
  if (used == 0U || board->extra == NULL || board->extra->health == NULL) return used;
  const size_t added = board->extra->health(NULL, out + used, capacity - used);
  return added == 0U ? 0U : used + added;
}

void iterate_kit_board_run(const struct iterate_kit_board *value) {
  board = value;
  turns = board->facts.turns;
  volume_percent = board->facts.speaker.ceiling;
  struct iterate_kit_board_facts facts = board->facts;
  facts.speaker.set_volume = set_volume;
  facts.speaker.volume = volume;
  facts.speaker.context = NULL;
  struct iterate_kit_board_ops ops = board->extra != NULL ? *board->extra : (struct iterate_kit_board_ops){0};
  ops.start = start;
  ops.present = present;
  ops.poll = poll;
  ops.phase = phase;
  ops.health = health;
  iterate_kit_voice_loop_run(&ops, &facts, NULL);
}
#endif
