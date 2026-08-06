/*
 * Home Assistant Voice Preview Edition audio bring-up.
 *
 * PROVEN on donor hardware (branch c-capabilities): this exact topology,
 * register scripting, and boot ordering carried production acceptance runs.
 *
 * Topology: ESP32-S3 -(I2S slave TX, 48 kHz stereo 32-bit)-> XMOS
 * -(I2S master)-> AIC3204. The AIC3204 is a third I2S device on an
 * XMOS-mastered link the ESP32 never sees; its 24.576 MHz MCLK comes from
 * the XMOS, and no MCLK reaches the ESP32 on either bus. Capture is a
 * separate controller (I2S_NUM_1, slave RX, 16 kHz stereo 32-bit) whose two
 * channels are same-time XMOS taps: ch0 = the selected cumulative DSP output
 * (NS), ch1 = the original microphone (diagnostic only). Both ESP channels
 * are slaves on SEPARATE controllers precisely because one duplex channel
 * pair would force shared BCLK/WS, impossible with two independent clock
 * domains.
 *
 * AEC is hardware, in the XMOS (XCORE-VOICE FFVA, firmware pinned to
 * exactly 1.3.1 and verified at boot). There is no software AEC and no
 * exposed loudspeaker reference; the portable seam advertises
 * capture_is_echo_cancelled and the composition uses the passthrough
 * processor.
 *
 * Slave-bus traps this file honours (all measured on the donor):
 *  - An unbooted XMOS means no BCLK on either bus and slave I2S blocks
 *    forever: boot fails closed behind the version read.
 *  - `sample_rate_hz` still matters in slave mode — the driver derives its
 *    internal timing from it, and a mismatch is silent data corruption.
 *  - The TX channel is never stopped or reconfigured mid-session: the XMOS
 *    AEC reference rides that stream, and a stopped stream is an AEC outage
 *    that presents as "echo came back".
 *  - `auto_clear_after_cb` on TX, or the DMA ring replays stale audio on
 *    underrun.
 */
#include "havpe_audio.h"

#include <stdatomic.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "driver/i2s_std.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "voice_pe_hardware_config.h"
#include "voice_pe_pcm_format.h"

static const char tag[] = "havpe-audio";

enum {
  PLAYBACK_RATE_HZ = 48000,
  /*
   * The XMOS NS tap is deliberately quiet, and the donor validated a fixed
   * x16 make-up gain for provider VAD (worker-side then; measured 3/3 with
   * VAD threshold 0.1). On this lane the wire is mu-law — a logarithmic
   * companding that spends resolution where the signal lives — so the gain
   * belongs BEFORE encoding, on the device. Saturating, with a lifetime
   * clip counter so an abnormal level stays observable; never adaptive.
   */
  CAPTURE_MAKEUP_GAIN = 16,
  /*
   * DMA geometry from Espressif's standard-mode sizing formula:
   *
   *   playback descriptor bytes = 480 frames * 2 slots * 32 bits / 8
   *                             = 3840 (must be <= 4092)
   *   playback interrupt period = 480 / 48000 = 10 ms; ring = 6 * 10 = 60 ms
   *   capture descriptor bytes  = 320 * 2 * 32 / 8 = 2560
   *   capture interrupt period  = 320 / 16000 = 20 ms; ring = 5 * 20 = 100 ms
   *
   * Donor-proven values. One capture read of 2560 bytes is exactly one
   * 20 ms wire frame; one playback write is one expanded 20 ms frame
   * (7680 bytes) spanning two descriptors.
   * Source: ESP-IDF 5.4 I2S documentation, "DMA buffer info and
   * configuration".
   * https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/api-reference/peripherals/i2s.html#dma-buffer-info-and-configuration
   */
  PLAYBACK_DMA_DESCRIPTOR_COUNT = 6,
  PLAYBACK_DMA_FRAMES = 480,
  PLAYBACK_RING_MS = 60,
  CAPTURE_DMA_DESCRIPTOR_COUNT = 5,
  CAPTURE_DMA_FRAMES = 320,
  CAPTURE_READ_TIMEOUT_MS = 40,
  PLAYBACK_WRITE_TIMEOUT_MS = 1000,
  PIN_I2C_SDA = 5,
  PIN_I2C_SCL = 6,
  PIN_XMOS_RESET = 4,
  PIN_SPEAKER_ENABLE = 47,
  PIN_PLAYBACK_WS = 7,
  PIN_PLAYBACK_BCLK = 8,
  PIN_PLAYBACK_DATA = 10,
  PIN_CAPTURE_WS = 14,
  PIN_CAPTURE_BCLK = 13,
  PIN_CAPTURE_DATA = 15,
  XMOS_I2C_ADDRESS = 0x42,
  AIC3204_I2C_ADDRESS = 0x18,
  I2C_FREQUENCY_HZ = 400000,
  I2C_TIMEOUT_MS = 50,
  /*
   * A first-party hardware contract, not retry padding: sending
   * configuration while XMOS firmware is still booting can NACK once and
   * leave the channel stages at unknown defaults for the boot.
   */
  XMOS_BOOT_MS = 3000,
};

_Static_assert(
    PLAYBACK_DMA_FRAMES * 2 * 32 / 8 <= 4092,
    "playback I2S descriptor exceeds the ESP32-S3 DMA limit");
_Static_assert(
    CAPTURE_DMA_FRAMES * 2 * 32 / 8 <= 4092,
    "capture I2S descriptor exceeds the ESP32-S3 DMA limit");

struct audio_frame {
  int16_t samples[HAVPE_AUDIO_FRAME_SAMPLES];
  size_t sample_count;
};

static i2c_master_bus_handle_t i2c_bus;
static i2c_master_dev_handle_t xmos_device;
static i2c_master_dev_handle_t codec_device;
static i2s_chan_handle_t playback_channel;
static i2s_chan_handle_t capture_channel;

static QueueHandle_t capture_mailbox;
static QueueHandle_t playback_mailbox;

/* Startup capture is not loss until the portable consumer has started. */
static atomic_bool capture_consumer_started;
static volatile uint32_t capture_overruns;
static volatile uint32_t capture_driver_failures;
static volatile uint32_t playback_driver_failures;
static volatile uint32_t capture_queue_overflow_count;
static volatile uint32_t playback_queue_overflow_count;
static volatile uint32_t capture_gain_clipped_samples;

/* --- the shared codec seam ------------------------------------------------ */

static enum iterate_kit_status codec_read(
    void *context,
    int16_t *capture,
    int16_t *reference,
    size_t capacity_samples,
    size_t *sample_count) {
  struct audio_frame frame;
  (void)context;
  (void)reference;
  if (capture_mailbox == NULL ||
      capacity_samples < HAVPE_AUDIO_FRAME_SAMPLES) {
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
  struct audio_frame frame;
  (void)context;
  if (playback_mailbox == NULL || sample_count == 0U ||
      sample_count > HAVPE_AUDIO_FRAME_SAMPLES) {
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
  .capture_sample_rate_hz = HAVPE_AUDIO_SAMPLE_RATE_HZ,
  .playback_sample_rate_hz = HAVPE_AUDIO_SAMPLE_RATE_HZ,
  .capture_channels = 1,
  .playback_channels = 1,
  .full_duplex = true,
  /*
   * FALSE is the load-bearing fact of this board: the XMOS keeps its AEC
   * reference private, nothing on the ESP capture bus carries it, and zero
   * or scheduler-aligned intended playback must never be presented as a
   * measured reference.
   */
  .has_reference_channel = false,
  .capture_is_echo_cancelled = true,
  .capture_clock_is_hardware_owned = true,
  .playback_clock_is_hardware_owned = true,
  /*
   * The AIC3204 DAC is pinned at 0 dB: a production run at ESPHome's +24 dB
   * endpoint made the provider transcribe its own speaker output. Exposing
   * a gain control here would be an invitation to reintroduce that.
   */
  .has_output_gain_control = false,
  .output_gain_ceiling_centi_db = 0,
};

/* --- absolute-deadline starvation ledger (see m5sticks3_audio.c) ---------- */

static portMUX_TYPE ledger_lock = portMUX_INITIALIZER_UNLOCKED;
static bool ledger_watch;
static bool ledger_draining;
static bool ledger_stale_ring;
static int64_t ledger_empty_at_us;
static uint32_t ledger_written_ms;
static uint32_t ledger_starved_ms;
static uint32_t ledger_starve_events;
static atomic_uint inject_starvation_ms;

static uint32_t saturating_add(uint32_t value, uint32_t delta) {
  const uint32_t sum = value + delta;
  return sum < value ? 0xffffffffU : sum;
}

void havpe_audio_watch(bool active) {
  portENTER_CRITICAL(&ledger_lock);
  if (active && !ledger_watch) {
    ledger_written_ms = 0U;
    ledger_empty_at_us = esp_timer_get_time() +
        (ledger_stale_ring ? (int64_t)PLAYBACK_RING_MS * 1000 : 0);
    ledger_stale_ring = false;
  }
  if (active) ledger_draining = false;
  ledger_watch = active;
  portEXIT_CRITICAL(&ledger_lock);
}

void havpe_audio_draining(void) {
  portENTER_CRITICAL(&ledger_lock);
  ledger_draining = true;
  portEXIT_CRITICAL(&ledger_lock);
}

void havpe_audio_note_flush(void) {
  portENTER_CRITICAL(&ledger_lock);
  ledger_stale_ring = true;
  portEXIT_CRITICAL(&ledger_lock);
}

void havpe_audio_reserve_write(uint32_t ms) {
  const int64_t now_us = esp_timer_get_time();
  portENTER_CRITICAL(&ledger_lock);
  if (ledger_watch && !ledger_draining && ledger_empty_at_us > 0 &&
      ledger_written_ms >= (uint32_t)PLAYBACK_RING_MS &&
      now_us > ledger_empty_at_us) {
    ledger_starved_ms = saturating_add(
        ledger_starved_ms,
        (uint32_t)((now_us - ledger_empty_at_us) / 1000));
    ledger_starve_events = saturating_add(ledger_starve_events, 1U);
  }
  {
    const int64_t base_us =
        now_us > ledger_empty_at_us ? now_us : ledger_empty_at_us;
    ledger_empty_at_us = base_us + (int64_t)ms * 1000;
  }
  ledger_written_ms = saturating_add(ledger_written_ms, ms);
  portEXIT_CRITICAL(&ledger_lock);
}

void havpe_audio_rollback_write(uint32_t ms) {
  portENTER_CRITICAL(&ledger_lock);
  ledger_empty_at_us -= (int64_t)ms * 1000;
  if (ledger_written_ms >= ms) ledger_written_ms -= ms;
  portEXIT_CRITICAL(&ledger_lock);
}

uint32_t havpe_audio_starved_ms(void) {
  return ledger_starved_ms;
}

uint32_t havpe_audio_starve_events(void) {
  return ledger_starve_events;
}

uint32_t havpe_audio_written_ms(void) {
  return ledger_written_ms;
}

void havpe_audio_inject_starvation(uint32_t ms) {
  atomic_store_explicit(&inject_starvation_ms, ms, memory_order_relaxed);
}

bool havpe_audio_starvation_pending(void) {
  return atomic_load_explicit(&inject_starvation_ms, memory_order_relaxed) >
      0U;
}

uint32_t havpe_audio_take_injected_starvation(void) {
  return atomic_exchange_explicit(
      &inject_starvation_ms, 0U, memory_order_relaxed);
}

/* --- hardware tasks -------------------------------------------------------- */

/*
 * ONLY THESE TASKS CALL THE BLOCKING I2S DRIVER. Capture keeps the newest
 * complete frame in a depth-one mailbox; playback accepts at most one
 * complete frame beyond the one being handed to DMA.
 */
static void capture_hardware_task(void *argument) {
  /* One 20 ms stereo Q31 read, and its two extracted mono planes. */
  static int32_t stereo_words[HAVPE_AUDIO_FRAME_SAMPLES * 2];
  static int16_t raw_plane[HAVPE_AUDIO_FRAME_SAMPLES];
  static struct audio_frame frame = {
    .sample_count = HAVPE_AUDIO_FRAME_SAMPLES,
  };
  (void)argument;
  for (;;) {
    size_t bytes_read = 0U;
    if (i2s_channel_read(
            capture_channel,
            stereo_words,
            sizeof(stereo_words),
            &bytes_read,
            CAPTURE_READ_TIMEOUT_MS) != ESP_OK ||
        bytes_read != sizeof(stereo_words)) {
      ++capture_driver_failures;
      vTaskDelay(1U);
      continue;
    }
    size_t frames_written = 0U;
    /*
     * The raw ch1 plane is extracted because the adopted converter conserves
     * both same-time taps, then deliberately discarded: it is XMOS-defined
     * diagnostic data for acoustic evidence harnesses, and no such harness
     * is part of this consolidation. Only the echo-cancelled ch0 plane may
     * reach the uplink.
     */
    if (iterate_kit_voice_pe_extract_capture(
            stereo_words,
            HAVPE_AUDIO_FRAME_SAMPLES,
            frame.samples,
            raw_plane,
            HAVPE_AUDIO_FRAME_SAMPLES,
            &frames_written) != ITERATE_KIT_OK ||
        frames_written != HAVPE_AUDIO_FRAME_SAMPLES) {
      ++capture_driver_failures;
      continue;
    }
    for (size_t index = 0U; index < HAVPE_AUDIO_FRAME_SAMPLES; ++index) {
      const int32_t amplified =
          (int32_t)frame.samples[index] * CAPTURE_MAKEUP_GAIN;
      if (amplified > INT16_MAX) {
        frame.samples[index] = INT16_MAX;
        ++capture_gain_clipped_samples;
      } else if (amplified < INT16_MIN) {
        frame.samples[index] = INT16_MIN;
        ++capture_gain_clipped_samples;
      } else {
        frame.samples[index] = (int16_t)amplified;
      }
    }
    if (atomic_load_explicit(
            &capture_consumer_started, memory_order_acquire) &&
        uxQueueMessagesWaiting(capture_mailbox) > 0U) {
      ++capture_overruns;
    }
    (void)xQueueOverwrite(capture_mailbox, &frame);
  }
}

static void playback_hardware_task(void *argument) {
  static struct audio_frame frame;
  /* One expanded 20 ms frame: 320 * 6 words = 7680 bytes. */
  static int32_t stereo_words
      [HAVPE_AUDIO_FRAME_SAMPLES *
       ITERATE_KIT_VOICE_PE_PLAYBACK_WORDS_PER_PCM16_SAMPLE];
  static struct iterate_kit_voice_pe_playback_resampler resampler;
  (void)argument;
  for (;;) {
    if (xQueueReceive(playback_mailbox, &frame, portMAX_DELAY) != pdTRUE) {
      continue;
    }
    size_t words_written = 0U;
    if (iterate_kit_voice_pe_expand_playback(
            &resampler,
            frame.samples,
            frame.sample_count,
            stereo_words,
            sizeof(stereo_words) / sizeof(stereo_words[0]),
            &words_written) != ITERATE_KIT_OK) {
      ++playback_driver_failures;
      continue;
    }
    const uint32_t frame_ms = (uint32_t)(
        frame.sample_count * 1000U / HAVPE_AUDIO_SAMPLE_RATE_HZ);
    /*
     * Credit before the blocking write: the deadline ledger must see the
     * audio being handed over while it is being handed over.
     */
    havpe_audio_reserve_write(frame_ms);
    size_t bytes_written = 0U;
    if (i2s_channel_write(
            playback_channel,
            stereo_words,
            words_written * sizeof(stereo_words[0]),
            &bytes_written,
            PLAYBACK_WRITE_TIMEOUT_MS) != ESP_OK) {
      havpe_audio_rollback_write(frame_ms);
      ++playback_driver_failures;
    }
  }
}

/* --- boot ------------------------------------------------------------------ */

static bool IRAM_ATTR note_playback_queue_overflow(
    i2s_chan_handle_t handle, i2s_event_data_t *event, void *context) {
  (void)handle;
  (void)event;
  (void)context;
  ++playback_queue_overflow_count;
  return false;
}

static bool IRAM_ATTR note_capture_queue_overflow(
    i2s_chan_handle_t handle, i2s_event_data_t *event, void *context) {
  (void)handle;
  (void)event;
  (void)context;
  ++capture_queue_overflow_count;
  return false;
}

static esp_err_t write_codec_registers(
    const struct iterate_kit_voice_pe_register_write *writes, size_t count) {
  if (writes == NULL || count == 0U) {
    return ESP_ERR_INVALID_ARG;
  }
  for (size_t index = 0U; index < count; ++index) {
    const uint8_t command[] = {writes[index].address, writes[index].value};
    const esp_err_t status = i2c_master_transmit(
        codec_device, command, sizeof(command), I2C_TIMEOUT_MS);
    if (status != ESP_OK) {
      return status;
    }
  }
  return ESP_OK;
}

/*
 * Write a pipeline stage, then read it back and fail on mismatch: XMOS
 * defaults are ch0=AGC, ch1=NS, taps are volatile across the reset this boot
 * pulses, and a write ACK alone does not establish the live stage.
 */
static uint8_t speaker_volume_percent = 100U;

/*
 * Percent to the AIC3204's two DAC channel-gain registers (0x41, 0x42), in
 * half-decibel steps on page 0.
 *
 * 100 IS 0 dB, NOT THE CHIP'S +24 dB CEILING. Positive digital gain here made
 * the provider transcribe this device's own speaker output almost verbatim on
 * the XMOS processed channel — the gain exhausted acoustic and AEC headroom
 * before the DSP could cancel anything. 0 dB is also the loudest setting that
 * cannot electrically clip a full-scale provider sample, and PCM reaches this
 * boundary unscaled. So the knob spans silence to 0 dB, which is the whole of
 * the safe range; anything above it is a different measurement, not a setting.
 *
 * The scale is in dB rather than linear percent because the ear is: halfway
 * along this control is -31.5 dB, which is quiet but not inaudible.
 */
static esp_err_t apply_dac_volume(uint8_t percent) {
  enum { MINIMUM_HALF_DB = -126 };  /* -63 dB, the register's floor */
  const int8_t half_db = percent == 0U
      ? (int8_t)MINIMUM_HALF_DB
      : (int8_t)(MINIMUM_HALF_DB + ((int)-MINIMUM_HALF_DB * (int)percent) / 100);
  const struct iterate_kit_voice_pe_register_write writes[] = {
    {0x00U, 0x00U},
    {0x41U, (uint8_t)half_db},
    {0x42U, (uint8_t)half_db},
  };
  return write_codec_registers(writes, sizeof(writes) / sizeof(writes[0]));
}

enum iterate_kit_status havpe_audio_set_volume(
    uint8_t percent, uint8_t *applied) {
  if (percent > 100U) percent = 100U;
  if (apply_dac_volume(percent) != ESP_OK) return ITERATE_KIT_IO_ERROR;
  speaker_volume_percent = percent;
  if (applied != NULL) *applied = percent;
  return ITERATE_KIT_OK;
}

uint8_t havpe_audio_volume(void) { return speaker_volume_percent; }

static esp_err_t configure_xmos_pipeline(
    uint8_t channel, enum iterate_kit_voice_pe_xmos_stage stage) {
  uint8_t command[4];
  if (iterate_kit_voice_pe_xmos_pipeline_command(
          channel, stage, command, sizeof(command)) != ITERATE_KIT_OK) {
    return ESP_ERR_INVALID_ARG;
  }
  esp_err_t status = i2c_master_transmit(
      xmos_device, command, sizeof(command), I2C_TIMEOUT_MS);
  if (status != ESP_OK) {
    return status;
  }
  uint8_t read_command[3];
  uint8_t response[2] = {0xffU, 0xffU};
  if (iterate_kit_voice_pe_xmos_pipeline_read_command(
          channel, read_command, sizeof(read_command)) != ITERATE_KIT_OK) {
    return ESP_ERR_INVALID_ARG;
  }
  status = i2c_master_transmit(
      xmos_device, read_command, sizeof(read_command), I2C_TIMEOUT_MS);
  if (status != ESP_OK) {
    return status;
  }
  status = i2c_master_receive(
      xmos_device, response, sizeof(response), I2C_TIMEOUT_MS);
  if (status != ESP_OK) {
    return status;
  }
  return iterate_kit_voice_pe_xmos_pipeline_response_matches(
             response, sizeof(response), stage)
      ? ESP_OK
      : ESP_ERR_INVALID_RESPONSE;
}

static esp_err_t verify_xmos_version(
    struct iterate_kit_voice_pe_xmos_version *version) {
  uint8_t command[3];
  uint8_t response[4] = {0xffU, 0xffU, 0xffU, 0xffU};
  if (version == NULL ||
      iterate_kit_voice_pe_xmos_version_command(command, sizeof(command)) !=
          ITERATE_KIT_OK) {
    return ESP_ERR_INVALID_ARG;
  }
  esp_err_t status = i2c_master_transmit(
      xmos_device, command, sizeof(command), I2C_TIMEOUT_MS);
  if (status != ESP_OK) {
    return status;
  }
  status = i2c_master_receive(
      xmos_device, response, sizeof(response), I2C_TIMEOUT_MS);
  if (status != ESP_OK) {
    return status;
  }
  if (iterate_kit_voice_pe_parse_xmos_version(
          response, sizeof(response), version) != ITERATE_KIT_OK ||
      !iterate_kit_voice_pe_xmos_version_is_supported(version)) {
    return ESP_ERR_INVALID_VERSION;
  }
  return ESP_OK;
}

static esp_err_t initialize_i2c(void) {
  const i2c_master_bus_config_t bus_config = {
    .i2c_port = -1,
    .sda_io_num = PIN_I2C_SDA,
    .scl_io_num = PIN_I2C_SCL,
    .clk_source = I2C_CLK_SRC_DEFAULT,
    .glitch_ignore_cnt = 7U,
    .intr_priority = 0,
    .trans_queue_depth = 0U,
    .flags = {
      .enable_internal_pullup = true,
      .allow_pd = false,
    },
  };
  const i2c_device_config_t xmos_config = {
    .dev_addr_length = I2C_ADDR_BIT_LEN_7,
    .device_address = XMOS_I2C_ADDRESS,
    .scl_speed_hz = I2C_FREQUENCY_HZ,
  };
  const i2c_device_config_t codec_config = {
    .dev_addr_length = I2C_ADDR_BIT_LEN_7,
    .device_address = AIC3204_I2C_ADDRESS,
    .scl_speed_hz = I2C_FREQUENCY_HZ,
  };
  esp_err_t status = i2c_new_master_bus(&bus_config, &i2c_bus);
  if (status != ESP_OK) {
    return status;
  }
  status = i2c_master_bus_add_device(i2c_bus, &xmos_config, &xmos_device);
  if (status != ESP_OK) {
    return status;
  }
  return i2c_master_bus_add_device(i2c_bus, &codec_config, &codec_device);
}

static esp_err_t initialize_control_gpios(void) {
  const gpio_config_t config = {
    .pin_bit_mask = (UINT64_C(1) << PIN_XMOS_RESET) |
        (UINT64_C(1) << PIN_SPEAKER_ENABLE),
    .mode = GPIO_MODE_OUTPUT,
    .pull_up_en = GPIO_PULLUP_DISABLE,
    .pull_down_en = GPIO_PULLDOWN_DISABLE,
    .intr_type = GPIO_INTR_DISABLE,
  };
  esp_err_t status = gpio_config(&config);
  if (status != ESP_OK) {
    return status;
  }
  /*
   * The speaker rail defaults OFF in hardware — a perfect digital chain
   * with zero sound. It is raised as the LAST boot step below.
   */
  status = gpio_set_level(PIN_SPEAKER_ENABLE, 0);
  if (status != ESP_OK) {
    return status;
  }
  /* Active-high reset pulse, then the mandatory XMOS boot wait. */
  status = gpio_set_level(PIN_XMOS_RESET, 1);
  if (status != ESP_OK) {
    return status;
  }
  vTaskDelay(pdMS_TO_TICKS(1U));
  status = gpio_set_level(PIN_XMOS_RESET, 0);
  if (status != ESP_OK) {
    return status;
  }
  vTaskDelay(pdMS_TO_TICKS(XMOS_BOOT_MS));
  return ESP_OK;
}

static esp_err_t initialize_i2s(void) {
  i2s_chan_config_t playback_channel_config =
      I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_SLAVE);
  playback_channel_config.dma_desc_num = PLAYBACK_DMA_DESCRIPTOR_COUNT;
  playback_channel_config.dma_frame_num = PLAYBACK_DMA_FRAMES;
  /* Underrun plays silence, never a stale ring (donor-proven setting). */
  playback_channel_config.auto_clear_after_cb = true;
  playback_channel_config.auto_clear_before_cb = false;
  playback_channel_config.intr_priority = 3;

  i2s_chan_config_t capture_channel_config =
      I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_SLAVE);
  capture_channel_config.dma_desc_num = CAPTURE_DMA_DESCRIPTOR_COUNT;
  capture_channel_config.dma_frame_num = CAPTURE_DMA_FRAMES;
  capture_channel_config.intr_priority = 3;

  /*
   * Slave mode still derives internal timing from sample_rate_hz; a
   * mismatch with the XMOS's real clocking is silent data corruption with
   * no error path anywhere in the driver.
   */
  const i2s_std_config_t playback_config = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(PLAYBACK_RATE_HZ),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
        I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
    .gpio_cfg = {
      .mclk = I2S_GPIO_UNUSED,
      .bclk = PIN_PLAYBACK_BCLK,
      .ws = PIN_PLAYBACK_WS,
      .dout = PIN_PLAYBACK_DATA,
      .din = I2S_GPIO_UNUSED,
      .invert_flags = {0},
    },
  };
  const i2s_std_config_t capture_config = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(HAVPE_AUDIO_SAMPLE_RATE_HZ),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
        I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
    .gpio_cfg = {
      .mclk = I2S_GPIO_UNUSED,
      .bclk = PIN_CAPTURE_BCLK,
      .ws = PIN_CAPTURE_WS,
      .dout = I2S_GPIO_UNUSED,
      .din = PIN_CAPTURE_DATA,
      .invert_flags = {0},
    },
  };

  esp_err_t status =
      i2s_new_channel(&playback_channel_config, &playback_channel, NULL);
  if (status != ESP_OK) {
    return status;
  }
  status = i2s_channel_init_std_mode(playback_channel, &playback_config);
  if (status != ESP_OK) {
    return status;
  }
  {
    const i2s_event_callbacks_t playback_callbacks = {
      .on_send_q_ovf = note_playback_queue_overflow,
    };
    status = i2s_channel_register_event_callback(
        playback_channel, &playback_callbacks, NULL);
    if (status != ESP_OK) {
      return status;
    }
  }
  status = i2s_new_channel(&capture_channel_config, NULL, &capture_channel);
  if (status != ESP_OK) {
    return status;
  }
  status = i2s_channel_init_std_mode(capture_channel, &capture_config);
  if (status != ESP_OK) {
    return status;
  }
  {
    const i2s_event_callbacks_t capture_callbacks = {
      .on_recv_q_ovf = note_capture_queue_overflow,
    };
    return i2s_channel_register_event_callback(
        capture_channel, &capture_callbacks, NULL);
  }
}

static esp_err_t preload_playback_silence(void) {
  /*
   * The whole TX ring starts as silence so enabling the slave channel never
   * clocks out uninitialized memory while the first real frame is written.
   */
  static int32_t silence[PLAYBACK_DMA_FRAMES * 2];
  memset(silence, 0, sizeof(silence));
  const size_t total_dma_bytes = (size_t)PLAYBACK_DMA_DESCRIPTOR_COUNT *
      PLAYBACK_DMA_FRAMES * 2U * sizeof(int32_t);
  size_t total_loaded = 0U;
  while (total_loaded < total_dma_bytes) {
    size_t loaded = 0U;
    const size_t remaining = total_dma_bytes - total_loaded;
    const size_t requested =
        remaining < sizeof(silence) ? remaining : sizeof(silence);
    const esp_err_t status = i2s_channel_preload_data(
        playback_channel, silence, requested, &loaded);
    if (status != ESP_OK) {
      return status;
    }
    if (loaded == 0U) {
      /* The ring is full; preload cannot make further progress. */
      break;
    }
    total_loaded += loaded;
  }
  return ESP_OK;
}

bool havpe_audio_init(void) {
  size_t initial_write_count = 0U;
  size_t power_up_write_count = 0U;
  const struct iterate_kit_voice_pe_register_write *initial_writes =
      iterate_kit_voice_pe_aic3204_initial_writes(&initial_write_count);
  const struct iterate_kit_voice_pe_register_write *power_up_writes =
      iterate_kit_voice_pe_aic3204_power_up_writes(&power_up_write_count);

  if (initialize_control_gpios() != ESP_OK) {
    ESP_LOGE(tag, "control GPIO bring-up failed");
    return false;
  }
  if (initialize_i2c() != ESP_OK) {
    ESP_LOGE(tag, "I2C bring-up failed");
    return false;
  }
  {
    struct iterate_kit_voice_pe_xmos_version xmos_version;
    if (verify_xmos_version(&xmos_version) != ESP_OK) {
      ESP_LOGE(tag, "XMOS version verification failed — failing closed");
      return false;
    }
    ESP_LOGI(
        tag,
        "verified XMOS firmware %u.%u.%u",
        xmos_version.major,
        xmos_version.minor,
        xmos_version.patch);
  }
  if (configure_xmos_pipeline(
          0U, iterate_kit_voice_pe_xmos_uplink_stage()) != ESP_OK ||
      configure_xmos_pipeline(1U, ITERATE_KIT_VOICE_PE_XMOS_STAGE_NONE) !=
          ESP_OK) {
    ESP_LOGE(tag, "XMOS pipeline configuration failed — failing closed");
    return false;
  }
  if (write_codec_registers(initial_writes, initial_write_count) != ESP_OK) {
    ESP_LOGE(tag, "AIC3204 initial register script failed");
    return false;
  }
  /*
   * The codec's analogue soft-start, not an arbitrary boot delay. Sending
   * the power-up table early can pop and enter a different analogue state
   * from the first-party implementation.
   */
  vTaskDelay(pdMS_TO_TICKS(ITERATE_KIT_VOICE_PE_AIC3204_SETTLE_MS));
  if (initialize_i2s() != ESP_OK) {
    ESP_LOGE(tag, "I2S bring-up failed");
    return false;
  }
  if (preload_playback_silence() != ESP_OK ||
      i2s_channel_enable(playback_channel) != ESP_OK ||
      i2s_channel_enable(capture_channel) != ESP_OK) {
    ESP_LOGE(tag, "I2S preload/enable failed");
    return false;
  }
  if (write_codec_registers(power_up_writes, power_up_write_count) !=
      ESP_OK) {
    ESP_LOGE(tag, "AIC3204 power-up register script failed");
    return false;
  }
  /*
   * The rail stays ON for the life of the boot, unlike the amp-gated
   * boards: the XMOS AEC — not silence discipline — is this board's echo
   * story, and its reference rides the always-running TX stream.
   */
  if (gpio_set_level(PIN_SPEAKER_ENABLE, 1) != ESP_OK) {
    ESP_LOGE(tag, "speaker rail enable failed");
    return false;
  }

  capture_mailbox = xQueueCreate(1U, sizeof(struct audio_frame));
  playback_mailbox = xQueueCreate(1U, sizeof(struct audio_frame));
  if (capture_mailbox == NULL || playback_mailbox == NULL) {
    ESP_LOGE(tag, "audio seam queue allocation failed");
    return false;
  }
  {
    TaskHandle_t capture_task_handle = NULL;
    if (xTaskCreatePinnedToCore(
            capture_hardware_task,
            "audio-hw-capture",
            4096U,
            NULL,
            19U,
            &capture_task_handle,
            1) != pdPASS ||
        xTaskCreatePinnedToCore(
            playback_hardware_task,
            "audio-hw-playback",
            4096U,
            NULL,
            20U,
            NULL,
            1) != pdPASS) {
      if (capture_task_handle != NULL) {
        vTaskDelete(capture_task_handle);
      }
      ESP_LOGE(tag, "audio hardware task creation failed");
      return false;
    }
  }
  ESP_LOGI(tag, "XMOS/AIC3204 full-duplex audio ready at 16 kHz");
  return true;
}

struct iterate_kit_audio_codec havpe_audio_codec(void) {
  return (struct iterate_kit_audio_codec){
    .ops = &codec_ops,
    .properties = &codec_properties,
    .context = NULL,
  };
}

uint32_t havpe_audio_capture_overruns(void) {
  return capture_overruns;
}

uint32_t havpe_audio_capture_driver_failures(void) {
  return capture_driver_failures;
}

uint32_t havpe_audio_playback_driver_failures(void) {
  return playback_driver_failures;
}

uint32_t havpe_audio_capture_queue_overflows(void) {
  return capture_queue_overflow_count;
}

uint32_t havpe_audio_playback_queue_overflows(void) {
  return playback_queue_overflow_count;
}

uint32_t havpe_audio_capture_gain_clipped(void) {
  return capture_gain_clipped_samples;
}
