/*
 * Waveshare ESP32-S3 Touch AMOLED 1.8 audio bring-up (ES8311, full duplex).
 *
 * Recipe distilled from the board's xiaozhi-esp32 port (the authoritative
 * open implementation for this hardware) and the Waveshare BSP:
 *  - I2C0 on SDA 15 / SCL 14; ES8311 at 0x18 (7-bit), AXP2101 at 0x34.
 *  - AXP2101: DC1 = 3.3 V main rail, ALDO1 = 3.3 V microphone rail — the
 *    mic is dead without the ALDO1 write.
 *  - One duplex I2S channel pair, master, MCLK x256 (the ES8311 driver's
 *    default divider); esp_codec_dev_open() reconfigures slots to mono.
 *  - PA on GPIO46, handled by the ES8311 driver.
 * No TCA9554 pulse here: that expander reset is panel/touch-only.
 */
#include "waveshare_audio.h"

#include <string.h>

#include "driver/i2c_master.h"
#include "driver/i2s_std.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char tag[] = "waveshare-audio";

enum {
  PIN_I2C_SDA = 15,
  PIN_I2C_SCL = 14,
  PIN_I2S_MCLK = 16,
  PIN_I2S_BCLK = 9,
  PIN_I2S_WS = 45,
  PIN_I2S_DIN = 10,
  PIN_I2S_DOUT = 8,
  PIN_PA = 46,
  ADDR_ES8311_8BIT = 0x30, /* esp_codec_dev shifts to 7-bit 0x18 */
  ADDR_AXP2101 = 0x34,
};

static i2c_master_bus_handle_t i2c_bus;
static esp_codec_dev_handle_t codec_dev;

static bool axp2101_write(
    i2c_master_dev_handle_t device, uint8_t reg, uint8_t value) {
  const uint8_t frame[2] = {reg, value};
  return i2c_master_transmit(device, frame, sizeof(frame), 100) == ESP_OK;
}

static bool power_rails_up(void) {
  const i2c_device_config_t config = {
    .dev_addr_length = I2C_ADDR_BIT_LEN_7,
    .device_address = ADDR_AXP2101,
    .scl_speed_hz = 400000,
  };
  i2c_master_dev_handle_t pmic;
  bool ok;
  if (i2c_master_bus_add_device(i2c_bus, &config, &pmic) != ESP_OK) {
    ESP_LOGE(tag, "AXP2101 not reachable");
    return false;
  }
  ok = axp2101_write(pmic, 0x22, 0x06) &&
      axp2101_write(pmic, 0x27, 0x10) &&
      axp2101_write(pmic, 0x80, 0x01) &&           /* DCDCs: DC1 only */
      axp2101_write(pmic, 0x90, 0x00) &&
      axp2101_write(pmic, 0x91, 0x00) &&
      axp2101_write(pmic, 0x82, (3300 - 1500) / 100) && /* DC1 3.3V */
      axp2101_write(pmic, 0x92, (3300 - 500) / 100) &&  /* ALDO1 3.3V */
      axp2101_write(pmic, 0x90, 0x01) &&           /* ALDO1 on == MIC rail */
      axp2101_write(pmic, 0x64, 0x02) &&
      axp2101_write(pmic, 0x61, 0x02) &&
      axp2101_write(pmic, 0x62, 0x08) &&
      axp2101_write(pmic, 0x63, 0x01);
  (void)i2c_master_bus_rm_device(pmic);
  if (!ok) {
    ESP_LOGE(tag, "AXP2101 rail configuration failed");
    return false;
  }
  vTaskDelay(pdMS_TO_TICKS(20)); /* rails settle before codec probe */
  return true;
}

bool waveshare_audio_init(void) {
  const i2c_master_bus_config_t bus_config = {
    .i2c_port = I2C_NUM_0,
    .sda_io_num = PIN_I2C_SDA,
    .scl_io_num = PIN_I2C_SCL,
    .clk_source = I2C_CLK_SRC_DEFAULT,
    .glitch_ignore_cnt = 7,
    .intr_priority = 0,
    .trans_queue_depth = 0,
    .flags = {.enable_internal_pullup = 1},
  };
  i2s_chan_handle_t tx = NULL;
  i2s_chan_handle_t rx = NULL;

  if (i2c_new_master_bus(&bus_config, &i2c_bus) != ESP_OK) {
    ESP_LOGE(tag, "i2c bus init failed");
    return false;
  }
  if (!power_rails_up()) {
    return false;
  }

  i2s_chan_config_t channel_config =
      I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  channel_config.dma_desc_num = 6;
  channel_config.dma_frame_num = 240;
  channel_config.auto_clear = true;
  if (i2s_new_channel(&channel_config, &tx, &rx) != ESP_OK) {
    ESP_LOGE(tag, "i2s duplex channel creation failed");
    return false;
  }
  {
    i2s_std_config_t std_config = {
      .clk_cfg = {
        .sample_rate_hz = WAVESHARE_AUDIO_SAMPLE_RATE_HZ,
        .clk_src = I2S_CLK_SRC_DEFAULT,
        .mclk_multiple = I2S_MCLK_MULTIPLE_256,
      },
      .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
          I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
      .gpio_cfg = {
        .mclk = PIN_I2S_MCLK,
        .bclk = PIN_I2S_BCLK,
        .ws = PIN_I2S_WS,
        .dout = PIN_I2S_DOUT,
        .din = PIN_I2S_DIN,
        .invert_flags = {0},
      },
    };
    if (i2s_channel_init_std_mode(tx, &std_config) != ESP_OK ||
        i2s_channel_init_std_mode(rx, &std_config) != ESP_OK ||
        i2s_channel_enable(tx) != ESP_OK ||
        i2s_channel_enable(rx) != ESP_OK) {
      ESP_LOGE(tag, "i2s std init failed");
      return false;
    }
  }

  {
    audio_codec_i2s_cfg_t i2s_config = {
      .port = I2S_NUM_0,
      .rx_handle = rx,
      .tx_handle = tx,
    };
    const audio_codec_data_if_t *data_interface =
        audio_codec_new_i2s_data(&i2s_config);
    audio_codec_i2c_cfg_t i2c_config = {
      .port = I2C_NUM_0,
      .addr = ADDR_ES8311_8BIT,
      .bus_handle = i2c_bus,
    };
    const audio_codec_ctrl_if_t *ctrl_interface =
        audio_codec_new_i2c_ctrl(&i2c_config);
    const audio_codec_gpio_if_t *gpio_interface = audio_codec_new_gpio();
    if (data_interface == NULL || ctrl_interface == NULL ||
        gpio_interface == NULL) {
      ESP_LOGE(tag, "codec interface creation failed");
      return false;
    }

    /* Soft reset before construction — cures "present but silent" boots. */
    {
      uint8_t reset = 0x1f;
      (void)ctrl_interface->write_reg(ctrl_interface, 0x00, 1, &reset, 1);
      vTaskDelay(pdMS_TO_TICKS(5));
    }

    es8311_codec_cfg_t codec_config = {
      .ctrl_if = ctrl_interface,
      .gpio_if = gpio_interface,
      .codec_mode = ESP_CODEC_DEV_WORK_MODE_BOTH,
      .pa_pin = PIN_PA,
      .pa_reverted = false,
      .master_mode = false,
      .use_mclk = true,
      .digital_mic = false,
      .invert_mclk = false,
      .invert_sclk = false,
      .hw_gain = {.pa_voltage = 5.0f, .codec_dac_voltage = 3.3f},
    };
    const audio_codec_if_t *codec_interface = es8311_codec_new(&codec_config);
    if (codec_interface == NULL) {
      ESP_LOGE(tag, "ES8311 probe failed");
      return false;
    }
    esp_codec_dev_cfg_t dev_config = {
      .dev_type = ESP_CODEC_DEV_TYPE_IN_OUT,
      .codec_if = codec_interface,
      .data_if = data_interface,
    };
    codec_dev = esp_codec_dev_new(&dev_config);
    if (codec_dev == NULL) {
      ESP_LOGE(tag, "esp_codec_dev creation failed");
      return false;
    }
  }

  {
    esp_codec_dev_sample_info_t sample_info = {
      .bits_per_sample = 16,
      .channel = 1,
      .channel_mask = 0,
      .sample_rate = WAVESHARE_AUDIO_SAMPLE_RATE_HZ,
      .mclk_multiple = 0, /* 0 -> x256, matching the I2S clock */
    };
    if (esp_codec_dev_open(codec_dev, &sample_info) != ESP_CODEC_DEV_OK) {
      ESP_LOGE(tag, "codec open failed");
      return false;
    }
    (void)esp_codec_dev_set_in_gain(codec_dev, 30.0f);
    (void)esp_codec_dev_set_out_vol(codec_dev, 80);
  }
  ESP_LOGI(tag, "ES8311 duplex audio ready at 16 kHz");
  return true;
}

bool waveshare_audio_read(int16_t *destination, size_t samples) {
  return codec_dev != NULL &&
      esp_codec_dev_read(
          codec_dev, destination, samples * sizeof(int16_t)) ==
      ESP_CODEC_DEV_OK;
}

bool waveshare_audio_write(const int16_t *pcm, size_t samples) {
  return codec_dev != NULL &&
      esp_codec_dev_write(
          codec_dev, (void *)(uintptr_t)pcm, samples * sizeof(int16_t)) ==
      ESP_CODEC_DEV_OK;
}
