#include "iterate/kit/platforms/i2s_codec.h"
#include "iterate/kit/starvation_ledger.h"
#include "iterate/kit/capabilities/health.h"
#include <stdatomic.h>
#include <string.h>
#include "esp_timer.h"
#include "esp_attr.h"
#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

static size_t channel_health(char *out, size_t capacity, size_t used);
static void table_amplifier_phase(enum iterate_kit_voice_phase phase);
static void table_amplifier_sound(uint32_t bytes);

/** One complete 20 ms wire frame; the only queued storage in either direction. */
struct iterate_kit_i2s_codec_frame {
  int16_t samples[320];
  size_t sample_count;
};

static QueueHandle_t capture_mailbox;
static QueueHandle_t playback_mailbox;
static atomic_bool capture_consumer_started;
static uint32_t capture_overruns;
static uint32_t capture_driver_failures;
static uint32_t playback_driver_failures;
static portMUX_TYPE codec_lock = portMUX_INITIALIZER_UNLOCKED;
static struct iterate_kit_starvation_ledger ledger;
static enum iterate_kit_status (*hardware_read)(void *, int16_t *, size_t);
static enum iterate_kit_status (*hardware_write)(void *, const int16_t *, size_t);
static void *hardware_context;
static void (*before_write)(void *);
static bool (*playback_ready)(void *);
static void (*playback_observed)(void *, const int16_t *, size_t, bool);
static void (*playback_idle)(void *);

void iterate_kit_i2s_codec_set_playback_callbacks(
    bool (*ready)(void *),
    void (*observed)(void *, const int16_t *, size_t, bool),
    void (*idle)(void *)) {
  playback_ready = ready;
  playback_observed = observed;
  playback_idle = idle;
}

void iterate_kit_i2s_codec_note_failure(bool capture) {
  portENTER_CRITICAL(&codec_lock);
  if (capture) ++capture_driver_failures;
  else ++playback_driver_failures;
  portEXIT_CRITICAL(&codec_lock);
}

void iterate_kit_i2s_codec_set_before_write(void (*wait)(void *)) {
  before_write = wait;
}

static enum iterate_kit_status codec_read(
    void *context,
    int16_t *capture,
    int16_t *reference,
    size_t capacity_samples,
    size_t *sample_count) {
  struct iterate_kit_i2s_codec_frame frame;
  (void)context;
  (void)reference;
  if (capture_mailbox == NULL ||
      capacity_samples < 320) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  atomic_store_explicit(
      &capture_consumer_started, true, memory_order_release);
  if (xQueueReceive(capture_mailbox, &frame, 0) != pdTRUE) {
    return ITERATE_KIT_UNAVAILABLE;
  }
  memcpy(capture, frame.samples, frame.sample_count * sizeof(*capture));
  *sample_count = frame.sample_count;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status codec_write(
    void *context, const int16_t *playback, size_t sample_count) {
  struct iterate_kit_i2s_codec_frame frame;
  (void)context;
  if (playback_mailbox == NULL || sample_count == 0U ||
      sample_count > 320) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memcpy(frame.samples, playback, sample_count * sizeof(*playback));
  frame.sample_count = sample_count;
  return xQueueSend(playback_mailbox, &frame, 0) == pdTRUE
      ? ITERATE_KIT_OK
      : ITERATE_KIT_BACKPRESSURE;
}

static const struct iterate_kit_audio_codec_ops codec_ops = {
  .read = codec_read,
  .write = codec_write,
};

static const struct iterate_kit_audio_codec_properties codec_properties = {
  .capture_sample_rate_hz = 16000,
  .playback_sample_rate_hz = 16000,
  .capture_channels = 1,
  .playback_channels = 1,
  .has_reference_channel = false,
  .has_output_gain_control = false,
  .output_gain_ceiling_centi_db = 0,
};

void iterate_kit_i2s_codec_phase(enum iterate_kit_voice_phase phase) {
  portENTER_CRITICAL(&codec_lock);
  iterate_kit_starvation_ledger_phase(&ledger, phase, esp_timer_get_time());
  portEXIT_CRITICAL(&codec_lock);
  table_amplifier_phase(phase);
}

bool iterate_kit_i2s_codec_speaker_is_playing(void) {
  portENTER_CRITICAL(&codec_lock);
  const bool playing = iterate_kit_starvation_ledger_speaker_is_playing(
      &ledger, esp_timer_get_time(), 1500U);
  portEXIT_CRITICAL(&codec_lock);
  return playing;
}

/* --- local sounds ---------------------------------------------------------- */

/*
 * THE BOARD'S OWN VOICE: chimes and mode announcements, straight from flash.
 *
 * Everything else this speaker plays arrives over the stream, paced by the
 * server, seconds after the gesture that asked for it — which is exactly the
 * problem these solve: a press that answers within a frame instead of after a
 * dial. So they bypass the stream entirely and cut in at the last seam before
 * the DAC, where the playback hardware task drains them BEFORE it looks at
 * the mailbox. Preemption, not mixing, on purpose: a chime stepping on the
 * first milliseconds of an answer is acceptable and a mixer is not simpler
 * than this. The stream's frames are not lost — the depth-one mailbox holds
 * one and the portable playback task absorbs the rest as backpressure it
 * already knows how to wait out.
 *
 * Allocation-free: the PCM lives in .rodata (flash), the cursor walks it in
 * 20 ms slices, and the lock is held only to move three words — the flash
 * read itself happens outside the critical section.
 */
static const uint8_t *sound_pcm; /* NULL when idle; guarded by codec_lock */
static uint32_t sound_bytes;
static uint32_t sound_cursor;

void iterate_kit_i2s_codec_play_sound(const uint8_t *pcm, uint32_t bytes) {
  if (pcm == NULL || bytes < 2U) return;
  table_amplifier_sound(bytes);
  portENTER_CRITICAL(&codec_lock);
  sound_pcm = pcm;
  sound_bytes = bytes & ~1U; /* whole PCM16 samples only */
  sound_cursor = 0U;
  portEXIT_CRITICAL(&codec_lock);
}

void iterate_kit_i2s_codec_drop_pending_sound(void) {
  portENTER_CRITICAL(&codec_lock);
  sound_pcm = NULL;
  portEXIT_CRITICAL(&codec_lock);
}

bool iterate_kit_i2s_codec_sound_active(void) {
  portENTER_CRITICAL(&codec_lock);
  const bool active = sound_pcm != NULL;
  portEXIT_CRITICAL(&codec_lock);
  return active;
}

static void capture_hardware_task(void *argument) {
  static struct iterate_kit_i2s_codec_frame frame = {.sample_count = 320};
  (void)argument;
  for (;;) {
    const enum iterate_kit_status status = hardware_read(hardware_context, frame.samples, 320);
    if (status != ITERATE_KIT_OK) {
      if (status != ITERATE_KIT_UNAVAILABLE) {
        portENTER_CRITICAL(&codec_lock);
        ++capture_driver_failures;
        portEXIT_CRITICAL(&codec_lock);
        vTaskDelay(1U);
      }
      continue;
    }
    if (atomic_load_explicit(&capture_consumer_started, memory_order_acquire) &&
        uxQueueMessagesWaiting(capture_mailbox) > 0U) {
      portENTER_CRITICAL(&codec_lock);
      ++capture_overruns;
      portEXIT_CRITICAL(&codec_lock);
    }
    (void)xQueueOverwrite(capture_mailbox, &frame);
  }
}

static void playback_hardware_task(void *argument) {
  static struct iterate_kit_i2s_codec_frame frame;
  (void)argument;
  for (;;) {
    if (playback_ready != NULL && !playback_ready(hardware_context)) continue;
    /*
     * A local sound outranks the mailbox — see the note at `sound_pcm`. The
     * slice bounds are taken under the lock and the flash copy happens
     * outside it; if the app task replaces the sound mid-slice, this frame
     * finishes from the superseded PCM and the next one starts the new
     * sound, which is the preemption behaving as specified.
     */
    const uint8_t *sound = NULL;
    uint32_t sound_offset = 0U;
    uint32_t sound_take = 0U;
    portENTER_CRITICAL(&codec_lock);
    if (sound_pcm != NULL) {
      const uint32_t remaining = sound_bytes - sound_cursor;
      sound = sound_pcm;
      sound_offset = sound_cursor;
      sound_take = remaining < sizeof(frame.samples)
          ? remaining
          : (uint32_t)sizeof(frame.samples);
      sound_cursor += sound_take;
      if (sound_cursor >= sound_bytes) sound_pcm = NULL;
    }
    portEXIT_CRITICAL(&codec_lock);
    if (sound != NULL) {
      memcpy(frame.samples, sound + sound_offset, sound_take);
      frame.sample_count = sound_take / sizeof(frame.samples[0]);
    } else if (
        /*
         * One frame period instead of portMAX_DELAY, so a chime requested
         * while the stream is silent starts within 20 ms. An idle wake that
         * finds neither sound nor frame costs one queue peek.
         */
        xQueueReceive(playback_mailbox, &frame, pdMS_TO_TICKS(20)) !=
        pdTRUE) {
      if (playback_idle != NULL) playback_idle(hardware_context);
      continue;
    }
    if (before_write != NULL) before_write(hardware_context);
    const uint32_t frame_ms = (uint32_t)(frame.sample_count * 1000U / 16000U);
    portENTER_CRITICAL(&codec_lock);
    iterate_kit_starvation_ledger_reserve_write(&ledger, frame_ms, esp_timer_get_time());
    portEXIT_CRITICAL(&codec_lock);
    const enum iterate_kit_status status = hardware_write(
        hardware_context, frame.samples, frame.sample_count);
    if (status != ITERATE_KIT_OK) {
      portENTER_CRITICAL(&codec_lock);
      iterate_kit_starvation_ledger_rollback_write(&ledger, frame_ms);
      if (status != ITERATE_KIT_UNAVAILABLE) ++playback_driver_failures;
      portEXIT_CRITICAL(&codec_lock);
    } else if (playback_observed != NULL) {
      playback_observed(hardware_context, frame.samples, frame.sample_count, sound != NULL);
    }
  }
}

bool iterate_kit_i2s_codec_start_over(
    enum iterate_kit_status (*read)(void *, int16_t *, size_t),
    enum iterate_kit_status (*write)(void *, const int16_t *, size_t),
    void *context, uint16_t ring_ms, struct iterate_kit_audio_codec *out) {
  if (read == NULL || write == NULL || out == NULL || capture_mailbox != NULL) return false;
  hardware_read = read;
  hardware_write = write;
  hardware_context = context;
  portENTER_CRITICAL(&codec_lock);
  iterate_kit_starvation_ledger_init(&ledger, ring_ms);
  portEXIT_CRITICAL(&codec_lock);
  capture_mailbox = xQueueCreate(1U, sizeof(struct iterate_kit_i2s_codec_frame));
  playback_mailbox = xQueueCreate(1U, sizeof(struct iterate_kit_i2s_codec_frame));
  TaskHandle_t capture_task = NULL;
  if (capture_mailbox == NULL || playback_mailbox == NULL ||
      xTaskCreatePinnedToCore(capture_hardware_task, "audio-hw-capture", 4096U,
          NULL, 19U, &capture_task, 1) != pdPASS ||
      xTaskCreatePinnedToCore(playback_hardware_task, "audio-hw-playback", 4096U,
          NULL, 20U, NULL, 1) != pdPASS) {
    if (capture_task != NULL) vTaskDelete(capture_task);
    if (capture_mailbox != NULL) vQueueDelete(capture_mailbox);
    if (playback_mailbox != NULL) vQueueDelete(playback_mailbox);
    capture_mailbox = NULL;
    playback_mailbox = NULL;
    return false;
  }
  *out = (struct iterate_kit_audio_codec){&codec_ops, &codec_properties, NULL};
  return true;
}

size_t iterate_kit_i2s_codec_health(char *out, size_t capacity) {
  struct iterate_kit_starvation_ledger_metrics metrics;
  portENTER_CRITICAL(&codec_lock);
  iterate_kit_starvation_ledger_metrics(&ledger, &metrics);
  const struct iterate_kit_health_field fields[] = {
    {"codecCaptureOverruns", capture_overruns},
    {"codecCaptureFailures", capture_driver_failures},
    {"codecPlaybackFailures", playback_driver_failures},
    {"spkStarvedMs", metrics.starved_ms},
    {"spkStarveEvents", metrics.starve_events},
    {"speakerPlaying", iterate_kit_starvation_ledger_speaker_is_playing(
        &ledger, esp_timer_get_time(), 1500U) ? 1U : 0U},
  };
  portEXIT_CRITICAL(&codec_lock);
  return channel_health(out, capacity, iterate_kit_health_append_fields(
      out, capacity, fields, sizeof(fields) / sizeof(fields[0])));
}

/* --- channels from hardware facts ----------------------------------------- */

static struct iterate_kit_i2s_codec_facts channel_facts;
static i2s_chan_handle_t table_playback_channel;
static i2s_chan_handle_t table_capture_channel;
static bool table_started;
static bool playback_overflows_observed;
static volatile uint32_t capture_queue_overflows;
static volatile uint32_t playback_queue_overflows;
static uint32_t capture_gain_clipped;
static uint32_t mic_raw_peak;
static uint32_t mic_clean_peak;
static uint32_t echo_raw_peak;
static uint32_t echo_clean_peak;
static bool (*after_enable)(void);
static bool amplifier_on;
static int64_t amplifier_settled_at_us;
static int64_t amplifier_sound_hold_until_us;

void iterate_kit_i2s_codec_set_after_enable(bool (*power_up)(void)) {
  after_enable = power_up;
}

static bool IRAM_ATTR note_playback_queue_overflow(
    i2s_chan_handle_t handle, i2s_event_data_t *event, void *context) {
  (void)handle;
  (void)event;
  (void)context;
  ++playback_queue_overflows;
  return false;
}

static bool IRAM_ATTR note_capture_queue_overflow(
    i2s_chan_handle_t handle, i2s_event_data_t *event, void *context) {
  (void)handle;
  (void)event;
  (void)context;
  ++capture_queue_overflows;
  return false;
}

/** Slot bytes and nominal clock must describe the same 16 kHz PCM contract. */
static bool valid_channel(
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
static bool valid_duplex(const struct iterate_kit_i2s_codec_facts *facts) {
  const bool duplex = facts->capture_port == facts->playback_port;
  if (!valid_channel(facts->playback_port, &facts->playback, &facts->playback_shape,
          facts->dma_frames, facts->dma_descriptors) ||
      !valid_channel(facts->capture_port, &facts->capture, &facts->capture_shape,
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

/** Preserve the proven difference: slave TX clears after callbacks (HAVPE),
 * master TX before (M5); interrupt priorities remain 3 and 2 respectively.
 */
static i2s_chan_config_t playback_config(const struct iterate_kit_i2s_codec_facts *facts) {
  i2s_chan_config_t config = I2S_CHANNEL_DEFAULT_CONFIG(facts->playback_port, facts->role);
  config.dma_frame_num = facts->dma_frames;
  config.dma_desc_num = facts->dma_descriptors;
  config.auto_clear_after_cb = facts->role == I2S_ROLE_SLAVE;
  config.auto_clear_before_cb = facts->role == I2S_ROLE_MASTER;
  config.allow_pd = false;
  config.intr_priority = facts->role == I2S_ROLE_SLAVE ? 3 : 2;
  return config;
}

/** Preload complete descriptors before enable: the XMOS must never hear
 * uninitialized memory while its AEC reference starts clocking.
 */
static bool initialize_playback(
    const struct iterate_kit_i2s_codec_facts *facts, i2s_chan_handle_t channel) {
  if (i2s_channel_init_std_mode(channel, &facts->playback) != ESP_OK) return false;
  const i2s_event_callbacks_t callbacks = {.on_send_q_ovf = note_playback_queue_overflow};
  if (i2s_channel_register_event_callback(channel, &callbacks, NULL) != ESP_OK) return false;
  static const int32_t silence[1023] = {0}; /* the 4092-byte DMA ceiling */
  const size_t descriptor_bytes = iterate_kit_pcm_bytes_for_frames(
      &facts->playback_shape, facts->dma_frames);
  const size_t total_bytes = descriptor_bytes * facts->dma_descriptors;
  size_t total_loaded = 0U;
  while (total_loaded < total_bytes) {
    size_t loaded = 0U;
    const size_t remaining = total_bytes - total_loaded;
    const size_t requested = remaining < descriptor_bytes ? remaining : descriptor_bytes;
    if (i2s_channel_preload_data(channel, silence, requested, &loaded) != ESP_OK) return false;
    if (loaded == 0U) break; /* driver says the ring is full; never spin */
    total_loaded += loaded;
  }
  playback_overflows_observed = true;
  return true;
}

bool iterate_kit_i2s_codec_open_playback(
    const struct iterate_kit_i2s_codec_facts *facts, i2s_chan_handle_t *out) {
  if (facts == NULL || out == NULL ||
      (facts->role != I2S_ROLE_MASTER && facts->role != I2S_ROLE_SLAVE) ||
      !valid_channel(facts->playback_port, &facts->playback, &facts->playback_shape,
          facts->dma_frames, facts->dma_descriptors) || facts->playback.gpio_cfg.dout < 0) return false;
  *out = NULL;
  i2s_chan_config_t config = playback_config(facts);
  i2s_chan_handle_t channel = NULL;
  if (i2s_new_channel(&config, &channel, NULL) != ESP_OK) return false;
  if (!initialize_playback(facts, channel)) {
    (void)i2s_del_channel(channel);
    return false;
  }
  *out = channel;
  return true;
}

static bool set_table_amplifier(bool on) {
  if (channel_facts.amplifier_gpio < 0 || on == amplifier_on) return true;
  if (gpio_set_level(channel_facts.amplifier_gpio, on ? 1 : 0) != ESP_OK) return false;
  amplifier_on = on;
  if (on) {
    portENTER_CRITICAL(&codec_lock);
    amplifier_settled_at_us = esp_timer_get_time() + (int64_t)channel_facts.amplifier_settle_ms * 1000;
    portEXIT_CRITICAL(&codec_lock);
  }
  return true;
}

static void wait_for_table_amplifier(void *context) {
  (void)context;
  portENTER_CRITICAL(&codec_lock);
  const int64_t remaining = amplifier_settled_at_us - esp_timer_get_time();
  portEXIT_CRITICAL(&codec_lock);
  if (remaining > 0) vTaskDelay(pdMS_TO_TICKS((uint32_t)((remaining + 999) / 1000)));
}

static void table_amplifier_phase(enum iterate_kit_voice_phase phase) {
  if (!table_started || !channel_facts.amplifier_gated) return;
  if (phase == ITERATE_KIT_VOICE_PHASE_ARRIVED) {
    if (!set_table_amplifier(true)) iterate_kit_i2s_codec_note_failure(false);
  } else if (phase == ITERATE_KIT_VOICE_PHASE_QUIET) {
    portENTER_CRITICAL(&codec_lock);
    const bool holding = sound_pcm != NULL || esp_timer_get_time() < amplifier_sound_hold_until_us;
    portEXIT_CRITICAL(&codec_lock);
    if (!holding && !set_table_amplifier(false)) iterate_kit_i2s_codec_note_failure(false);
  }
}

static void table_amplifier_sound(uint32_t bytes) {
  if (!table_started || !channel_facts.amplifier_gated) return;
  if (!set_table_amplifier(true)) iterate_kit_i2s_codec_note_failure(false);
  const uint32_t ring_ms = (uint32_t)((uint64_t)channel_facts.dma_frames *
      channel_facts.dma_descriptors * 1000U / channel_facts.playback.clk_cfg.sample_rate_hz);
  portENTER_CRITICAL(&codec_lock);
  amplifier_sound_hold_until_us = esp_timer_get_time() + (int64_t)(bytes / 2U) * 1000000 / 16000 +
      (int64_t)(ring_ms + channel_facts.amplifier_settle_ms) * 1000;
  portEXIT_CRITICAL(&codec_lock);
}

/** The two same-time taps are measured BEFORE fixed make-up gain. A loudness
 * gate cannot distinguish a quiet person from residual echo; never blank or
 * duck uplink PCM based on the speaker. Echo maxima accumulate during the
 * shared 1500 ms speaker window because RPC sampling misses short answers.
 */
static enum iterate_kit_status read_channels(void *context, int16_t *samples, size_t count) {
  (void)context;
  static int32_t words[320 * 6];
  static int16_t raw[320];
  const size_t frames = count * channel_facts.capture_shape.ratio;
  const size_t bytes = iterate_kit_pcm_bytes_for_frames(&channel_facts.capture_shape, frames);
  size_t read = 0U;
  if (i2s_channel_read(table_capture_channel, words, bytes, &read, 40U) != ESP_OK || read != bytes) {
    return ITERATE_KIT_IO_ERROR;
  }
  size_t extracted = 0U;
  if (iterate_kit_pcm_extract_capture(&channel_facts.capture_shape, words, frames,
          samples, raw, count, &extracted) != ITERATE_KIT_OK || extracted != count) return ITERATE_KIT_IO_ERROR;
  uint32_t raw_peak = 0U;
  uint32_t clean_peak = 0U;
  uint32_t clipped = 0U;
  for (size_t i = 0; i < count; ++i) {
    const uint32_t clean = (uint32_t)(samples[i] < 0 ? -(int32_t)samples[i] : samples[i]);
    if (clean > clean_peak) clean_peak = clean;
    if (channel_facts.capture_shape.diagnostic_slot >= 0) {
      const uint32_t original = (uint32_t)(raw[i] < 0 ? -(int32_t)raw[i] : raw[i]);
      if (original > raw_peak) raw_peak = original;
    }
    const int32_t amplified = (int32_t)samples[i] * channel_facts.capture_gain;
    if (amplified > INT16_MAX) { samples[i] = INT16_MAX; ++clipped; }
    else if (amplified < INT16_MIN) { samples[i] = INT16_MIN; ++clipped; }
    else samples[i] = (int16_t)amplified;
  }
  const bool playing = iterate_kit_i2s_codec_speaker_is_playing();
  portENTER_CRITICAL(&codec_lock);
  mic_raw_peak = raw_peak;
  mic_clean_peak = clean_peak;
  capture_gain_clipped += clipped;
  if (playing) {
    if (raw_peak > echo_raw_peak) echo_raw_peak = raw_peak;
    if (clean_peak > echo_clean_peak) echo_clean_peak = clean_peak;
  }
  portEXIT_CRITICAL(&codec_lock);
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status write_channels(void *context, const int16_t *samples, size_t count) {
  (void)context;
  static int32_t words[320 * 6];
  static struct iterate_kit_pcm_playback_resampler resampler;
  size_t bytes = 0U;
  if (iterate_kit_pcm_expand_playback_shape(&channel_facts.playback_shape, &resampler,
          samples, count, words, sizeof(words), &bytes) != ITERATE_KIT_OK) return ITERATE_KIT_IO_ERROR;
  size_t written = 0U;
  return i2s_channel_write(table_playback_channel, words, bytes, &written, 1000U) == ESP_OK
      ? ITERATE_KIT_OK : ITERATE_KIT_IO_ERROR;
}

bool iterate_kit_i2s_codec_start(
    const struct iterate_kit_i2s_codec_facts *facts, struct iterate_kit_audio_codec *out) {
  if (facts == NULL || out == NULL || capture_mailbox != NULL || !valid_duplex(facts)) return false;
  const uint64_t ring_ms = (uint64_t)facts->dma_frames * facts->dma_descriptors * 1000U /
      facts->playback.clk_cfg.sample_rate_hz;
  if (ring_ms == 0U || ring_ms > UINT16_MAX) return false;
  channel_facts = *facts;
  bool tx_enabled = false;
  bool rx_enabled = false;
  if (facts->amplifier_gpio >= 0) {
    const gpio_config_t config = {
      .pin_bit_mask = UINT64_C(1) << facts->amplifier_gpio,
      .mode = GPIO_MODE_OUTPUT,
      .pull_up_en = GPIO_PULLUP_DISABLE,
      .pull_down_en = GPIO_PULLDOWN_DISABLE,
      .intr_type = GPIO_INTR_DISABLE,
    };
    if (gpio_config(&config) != ESP_OK || gpio_set_level(facts->amplifier_gpio, 0) != ESP_OK) return false;
  }
  if (facts->capture_port == facts->playback_port) {
    i2s_chan_config_t config = playback_config(facts);
    if (i2s_new_channel(&config, &table_playback_channel, &table_capture_channel) != ESP_OK ||
        !initialize_playback(facts, table_playback_channel)) goto failed;
  } else {
    if (!iterate_kit_i2s_codec_open_playback(facts, &table_playback_channel)) goto failed;
    i2s_chan_config_t config = I2S_CHANNEL_DEFAULT_CONFIG(facts->capture_port, facts->role);
    config.dma_frame_num = facts->capture_dma_frames;
    config.dma_desc_num = facts->capture_dma_descriptors;
    config.intr_priority = facts->role == I2S_ROLE_SLAVE ? 3 : 2;
    if (i2s_new_channel(&config, NULL, &table_capture_channel) != ESP_OK) goto failed;
  }
  if (i2s_channel_init_std_mode(table_capture_channel, &facts->capture) != ESP_OK) goto failed;
  const i2s_event_callbacks_t callbacks = {.on_recv_q_ovf = note_capture_queue_overflow};
  if (i2s_channel_register_event_callback(table_capture_channel, &callbacks, NULL) != ESP_OK) goto failed;
  if (i2s_channel_enable(table_playback_channel) != ESP_OK) goto failed;
  tx_enabled = true;
  if (i2s_channel_enable(table_capture_channel) != ESP_OK) goto failed;
  rx_enabled = true;
  if (after_enable != NULL && !after_enable()) goto failed;
  if (!facts->amplifier_gated && !set_table_amplifier(true)) goto failed;
  iterate_kit_i2s_codec_set_before_write(wait_for_table_amplifier);
  if (!iterate_kit_i2s_codec_start_over(read_channels, write_channels, NULL, (uint16_t)ring_ms, out)) goto failed;
  table_started = true;
  return true;
failed:
  (void)set_table_amplifier(false);
  if (rx_enabled) (void)i2s_channel_disable(table_capture_channel);
  if (tx_enabled) (void)i2s_channel_disable(table_playback_channel);
  if (table_capture_channel != NULL) (void)i2s_del_channel(table_capture_channel);
  if (table_playback_channel != NULL) (void)i2s_del_channel(table_playback_channel);
  table_capture_channel = NULL;
  table_playback_channel = NULL;
  return false;
}

void iterate_kit_i2s_codec_reset_echo_peaks(void) {
  portENTER_CRITICAL(&codec_lock);
  echo_raw_peak = 0U;
  echo_clean_peak = 0U;
  portEXIT_CRITICAL(&codec_lock);
}

static size_t channel_health(char *out, size_t capacity, size_t used) {
  if (used == 0U || !playback_overflows_observed) return used;
  portENTER_CRITICAL(&codec_lock);
  const struct iterate_kit_health_field fields[] = {
    {"playbackQueueOverflows", playback_queue_overflows},
    {"captureQueueOverflows", capture_queue_overflows},
    {"captureGainClipped", capture_gain_clipped},
    {"micRawPeak", mic_raw_peak},
    {"micCleanPeak", mic_clean_peak},
    {"echoRawPeak", echo_raw_peak},
    {"echoCleanPeak", echo_clean_peak},
  };
  portEXIT_CRITICAL(&codec_lock);
  const size_t count = table_started ? sizeof(fields) / sizeof(fields[0]) : 1U;
  const size_t added = iterate_kit_health_append_fields(out + used, capacity - used, fields, count);
  return added == 0U ? 0U : used + added;
}
