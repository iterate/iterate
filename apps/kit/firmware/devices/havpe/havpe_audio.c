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
 * (AEC — see board/codecs/aic3204.c for why not the AGC tap), ch1 = the
 * original microphone (diagnostic only, and the oracle). Both ESP channels
 * are slaves on SEPARATE controllers precisely because one duplex channel
 * pair would force shared BCLK/WS, impossible with two independent clock
 * domains.
 *
 * AEC is hardware, in the XMOS (XCORE-VOICE FFVA, firmware pinned to
 * exactly 1.3.1 and verified at boot). There is no software AEC and no
 * exposed loudspeaker reference, so the composition uses the passthrough
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
#include "iterate/kit/platforms/i2s_codec.h"

#include <string.h>

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "driver/i2s_std.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "iterate/kit/platforms/aic3204.h"
#include "iterate/kit/platforms/xmos_i2c.h"
#include "iterate/kit/pcm_format.h"

static const char tag[] = "havpe-audio";

enum {
  PLAYBACK_RATE_HZ = 48000,
  /*
   * ONE CONSTANT, APPLIED TO EVERY FRAME, WHATEVER THE SPEAKER IS DOING.
   *
   * The AEC tap this board reads is clean and quiet: the echo residual sits
   * about a decibel above the room floor at -83 dBFS, and a person a couple of
   * feet away arrives some thirty decibels above that. Both are too quiet for
   * a provider's detector — measured, x.ai answered before the question had
   * finished, twice, because it barely heard it.
   *
   * So the whole uplink is multiplied by one number. That number does not
   * change the only thing that matters, which is the DISTANCE between the
   * person and the residue; it moves both into a range something downstream
   * can hear. Saturating, with a lifetime clip counter, so an abnormal level
   * stays visible.
   *
   * WHAT MUST NOT COME BACK. This constant previously had three companions: a
   * duck to x1 whenever the speaker was running, a ramp back over sixteen
   * frames, and an absolute floor of 300 with a memset that deleted every
   * frame below it. Those made the gain conditional on the device's own
   * state, and a device that quietens its microphone while it talks cannot be
   * interrupted — measured, a full sentence spoken over the answer reached
   * the far end as digital silence. If the level is ever wrong, change this
   * number. Do not make it depend on anything.
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
  CAPTURE_DMA_DESCRIPTOR_COUNT = 5,
  CAPTURE_DMA_FRAMES = 320,
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
  /*
   * A first-party hardware contract, not retry padding: sending
   * configuration while XMOS firmware is still booting can NACK once and
   * leave the channel stages at unknown defaults for the boot.
   */
  XMOS_BOOT_MS = 3000,
};

static i2c_master_bus_handle_t i2c_bus;
static i2c_master_dev_handle_t xmos_device;
static i2c_master_dev_handle_t codec_device;

static struct iterate_kit_audio_codec codec;

/* What each XMOS output tap is currently selecting; 0..4, see the stage enum. */
static uint8_t pipeline_stage[2];

static uint8_t speaker_volume_percent = 100U;

enum iterate_kit_status havpe_audio_set_volume(
    uint8_t percent, uint8_t *applied) {
  if (percent > 100U) percent = 100U;
  if (iterate_kit_aic3204_set_volume(codec_device, percent) != ESP_OK) return ITERATE_KIT_IO_ERROR;
  speaker_volume_percent = percent;
  if (applied != NULL) *applied = percent;
  return ITERATE_KIT_OK;
}

uint8_t havpe_audio_volume(void) { return speaker_volume_percent; }

enum iterate_kit_status havpe_audio_read_vnr(uint8_t *vnr) {
  return iterate_kit_xmos_i2c_read_vnr(xmos_device, vnr);
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

/** Separate XMOS slave clock domains: capture ratio 1, playback ratio 3.
 * Keep capture's 320x5 geometry distinct from playback's 480x6 ring.
 */
static const struct iterate_kit_i2s_codec_facts audio_facts = {
  .playback_port = I2S_NUM_0,
  .capture_port = I2S_NUM_1,
  .role = I2S_ROLE_SLAVE,
  .playback = {
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
  },
  .capture = {
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
  },
  .dma_frames = PLAYBACK_DMA_FRAMES,
  .dma_descriptors = PLAYBACK_DMA_DESCRIPTOR_COUNT,
  .playback_shape = {32, 2, 0, -1, 3},
  .capture_shape = {32, 2, 0, 1, 1},
  .capture_gain = CAPTURE_MAKEUP_GAIN,
  .amplifier_gpio = PIN_SPEAKER_ENABLE,
  .amplifier_gated = false,
  .amplifier_settle_ms = 0,
  .capture_dma_frames = CAPTURE_DMA_FRAMES,
  .capture_dma_descriptors = CAPTURE_DMA_DESCRIPTOR_COUNT,
};

/** AIC3204 powers up after I2S enable; the shared start raises the rail last. */
static bool power_up_codec(void) {
  return iterate_kit_aic3204_write_script(
      codec_device, iterate_kit_aic3204_power_up_script()) == ESP_OK;
}

bool havpe_audio_init(void) {
  const struct iterate_kit_register_script *initial = iterate_kit_aic3204_initial_script();

  if (initialize_control_gpios() != ESP_OK) {
    ESP_LOGE(tag, "control GPIO bring-up failed");
    return false;
  }
  if (initialize_i2c() != ESP_OK) {
    ESP_LOGE(tag, "I2C bring-up failed");
    return false;
  }
  {
    struct iterate_kit_xmos_version xmos_version;
    if (iterate_kit_xmos_i2c_verify_version(xmos_device, &xmos_version) != ESP_OK) {
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
  pipeline_stage[0] = (uint8_t)iterate_kit_xmos_uplink_stage();
  pipeline_stage[1] = (uint8_t)ITERATE_KIT_XMOS_STAGE_NONE;
  if (iterate_kit_xmos_i2c_configure_pipeline(
          xmos_device, 0U, (enum iterate_kit_xmos_stage)pipeline_stage[0]) !=
          ESP_OK ||
      iterate_kit_xmos_i2c_configure_pipeline(
          xmos_device, 1U, (enum iterate_kit_xmos_stage)pipeline_stage[1]) !=
          ESP_OK) {
    ESP_LOGE(tag, "XMOS pipeline configuration failed — failing closed");
    return false;
  }
  if (iterate_kit_aic3204_write_script(codec_device, initial) != ESP_OK) {
    ESP_LOGE(tag, "AIC3204 initial register script failed");
    return false;
  }
  /*
   * The codec's analogue soft-start, not an arbitrary boot delay. Sending
   * the power-up table early can pop and enter a different analogue state
   * from the first-party implementation.
   */
  vTaskDelay(pdMS_TO_TICKS(initial->settle_ms));
  iterate_kit_i2s_codec_set_after_enable(power_up_codec);
  if (!iterate_kit_i2s_codec_start(&audio_facts, &codec)) {
    ESP_LOGE(tag, "I2S/codec power-up failed");
    return false;
  }
  ESP_LOGI(tag, "XMOS/AIC3204 full-duplex audio ready at 16 kHz");
  return true;
}

struct iterate_kit_audio_codec havpe_audio_codec(void) { return codec; }

enum iterate_kit_status havpe_audio_set_pipeline_stage(
    uint8_t channel, uint8_t stage) {
  /*
   * THE ONLY WAY TO ARGUE ABOUT AN ECHO CANCELLER IS TO MOVE IT AND WATCH.
   *
   * Both XMOS output taps are selectable at runtime, so a person can put the
   * SAME microphone on both channels — one raw, one cancelled — and read the
   * ratio out of health() without reflashing. Comparing the shipped taps
   * (channel 0 processed, channel 1 raw) compares two different microphones,
   * which cannot settle the question either way.
   */
  if (channel > 1U || stage >= (uint8_t)ITERATE_KIT_XMOS_STAGE_COUNT) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (iterate_kit_xmos_i2c_configure_pipeline(
          xmos_device, channel, (enum iterate_kit_xmos_stage)stage) != ESP_OK) {
    return ITERATE_KIT_IO_ERROR;
  }
  pipeline_stage[channel] = stage;
  iterate_kit_i2s_codec_reset_echo_peaks();
  return ITERATE_KIT_OK;
}

uint8_t havpe_audio_pipeline_stage(uint8_t channel) {
  return channel > 1U ? 0xffU : pipeline_stage[channel];
}
