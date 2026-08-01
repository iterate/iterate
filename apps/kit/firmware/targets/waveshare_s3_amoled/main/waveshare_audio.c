/*
 * Waveshare ESP32-S3 Touch AMOLED 1.8 audio bring-up (ES8311, full duplex).
 *
 * PROVEN on hardware: a spoken question reaches Grok through this microphone
 * and the answer plays back through this speaker, both over one WebSocket.
 *
 * Recipe distilled from the board's xiaozhi-esp32 port and Waveshare's own
 * BSP:
 *  - I2C0 on SDA 15 / SCL 14; ES8311 at 0x18 (7-bit), AXP2101 at 0x34.
 *  - AXP2101: DC1 = 3.3 V main rail, ALDO1 = 3.3 V microphone rail.
 *  - One duplex I2S channel pair, master, MCLK x256 (the ES8311 driver's
 *    default divider); esp_codec_dev_open() reconfigures slots to mono.
 *  - PA on GPIO46, handled by the ES8311 driver.
 * No TCA9554 pulse here: that expander reset is panel/touch-only.
 *
 * Two settings are load-bearing and easy to get wrong:
 *  - `no_dac_ref = true` (reg 0x44 = 0x08). The default fills the ADC lane's
 *    right slot with DAC output as an AEC reference, which a mono capture
 *    has no use for.
 *  - PGA 36 dB. At 24 dB a talker a metre away lands at RMS -42 dBFS —
 *    clean, but too quiet for Grok's server VAD to open a turn.
 *
 * Diagnostics kept for the next bring-up: waveshare_audio_dump_registers()
 * (ADC-path registers after open) and waveshare_audio_probe_din() (is
 * anything driving the data line). Note when reading captured audio off the
 * stream: 640 PCM bytes base64-encode to 854 characters, which is NOT a
 * multiple of 4 — decode each frame separately. Concatenating the strings
 * first misaligns every frame after the first and yields convincing
 * broadband "noise" that looks exactly like a dead microphone.
 */
#include "waveshare_audio.h"

#include <string.h>

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "driver/i2s_std.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#ifndef WAVESHARE_AUDIO_MIC_ONLY_DIAGNOSTIC
#define WAVESHARE_AUDIO_MIC_ONLY_DIAGNOSTIC 0
#endif

/* Bring-up probe: treat the board's microphone as PDM rather than analog. */
#ifndef WAVESHARE_AUDIO_DIGITAL_MIC
#define WAVESHARE_AUDIO_DIGITAL_MIC 0
#endif

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
/*
 * Separate IN and OUT esp_codec_dev handles over their own ES8311 instances,
 * mirroring Waveshare's own BSP (bsp_audio_codec_speaker_init /
 * bsp_audio_codec_microphone_init). A single IN_OUT handle brings the codec
 * up with a working speaker but a microphone that returns gain-independent
 * broadband noise on this board.
 */
static esp_codec_dev_handle_t speaker_dev;
static esp_codec_dev_handle_t microphone_dev;
/* Retained for the post-open register dump (bring-up diagnostics only). */
static const audio_codec_ctrl_if_t *registers_ctrl_if;

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
    registers_ctrl_if = ctrl_interface;
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
      .digital_mic = WAVESHARE_AUDIO_DIGITAL_MIC,
      .invert_mclk = false,
      .invert_sclk = false,
      .hw_gain = {.pa_voltage = 5.0f, .codec_dac_voltage = 3.3f},
      /*
       * Default (false) writes reg 0x44 = 0x58, which fills the ADC lane's
       * RIGHT slot with DAC output as an AEC reference. A mono capture then
       * reads mic and speaker-loopback samples alternately — broadband
       * garbage whose level ignores the mic PGA, which is exactly the
       * failure this board showed. True writes 0x44 = 0x08: ADC only.
       */
      .no_dac_ref = true,
    };
#if WAVESHARE_AUDIO_MIC_ONLY_DIAGNOSTIC
    /*
     * Bring-up probe: one ADC-only codec instance, no speaker. Isolates the
     * microphone from any interaction between two es8311 instances sharing
     * one chip (each open() re-runs the chip's init sequence).
     */
    codec_config.codec_mode = ESP_CODEC_DEV_WORK_MODE_ADC;
    const audio_codec_if_t *microphone_codec = es8311_codec_new(&codec_config);
    if (microphone_codec == NULL) {
      ESP_LOGE(tag, "ES8311 probe failed");
      return false;
    }
    const audio_codec_if_t *speaker_codec = NULL;
#else
    const audio_codec_if_t *speaker_codec = es8311_codec_new(&codec_config);
    const audio_codec_if_t *microphone_codec = es8311_codec_new(&codec_config);
    if (speaker_codec == NULL || microphone_codec == NULL) {
      ESP_LOGE(tag, "ES8311 probe failed");
      return false;
    }
#endif
    esp_codec_dev_cfg_t microphone_config = {
      .dev_type = ESP_CODEC_DEV_TYPE_IN,
      .codec_if = microphone_codec,
      .data_if = data_interface,
    };
    microphone_dev = esp_codec_dev_new(&microphone_config);
    if (microphone_dev == NULL) {
      ESP_LOGE(tag, "esp_codec_dev creation failed");
      return false;
    }
    if (speaker_codec != NULL) {
      esp_codec_dev_cfg_t speaker_config = {
        .dev_type = ESP_CODEC_DEV_TYPE_OUT,
        .codec_if = speaker_codec,
        .data_if = data_interface,
      };
      speaker_dev = esp_codec_dev_new(&speaker_config);
      if (speaker_dev == NULL) {
        ESP_LOGE(tag, "esp_codec_dev creation failed");
        return false;
      }
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
    if (esp_codec_dev_open(microphone_dev, &sample_info) != ESP_CODEC_DEV_OK ||
        (speaker_dev != NULL &&
         esp_codec_dev_open(speaker_dev, &sample_info) != ESP_CODEC_DEV_OK)) {
      ESP_LOGE(tag, "codec open failed");
      return false;
    }
    /*
     * 36 dB PGA (the driver quantises to 6 dB steps). At 24 dB a talker a
     * metre away measured RMS -42 dBFS at the stream, which is clean but too
     * quiet for Grok's server VAD to open a turn; +12 dB puts normal speech
     * near -30 dBFS with peaks still ~12 dB below clipping.
     */
    (void)esp_codec_dev_set_in_gain(microphone_dev, 36.0f);
    (void)esp_codec_dev_set_out_vol(speaker_dev, 80);
  }
  ESP_LOGI(tag, "ES8311 duplex audio ready at 16 kHz");
  waveshare_audio_dump_registers();
  waveshare_audio_probe_din();
  return true;
}

void waveshare_audio_probe_din(void) {
  /*
   * Is anything driving the ADC data line? Sample the pad under an internal
   * pull-down and then a pull-up while the I2S master clocks the bus. A
   * driven line reads roughly the same both ways (its own data); a floating
   * line simply follows the pull — which would prove the codec never puts
   * ADC data on DIN, and that no amount of register tuning will fix it.
   */
  size_t high_with_pulldown = 0U;
  size_t high_with_pullup = 0U;
  size_t index;
  gpio_set_pull_mode(PIN_I2S_DIN, GPIO_PULLDOWN_ONLY);
  esp_rom_delay_us(2000);
  for (index = 0U; index < 2000U; ++index) {
    high_with_pulldown += (size_t)gpio_get_level(PIN_I2S_DIN);
  }
  gpio_set_pull_mode(PIN_I2S_DIN, GPIO_PULLUP_ONLY);
  esp_rom_delay_us(2000);
  for (index = 0U; index < 2000U; ++index) {
    high_with_pullup += (size_t)gpio_get_level(PIN_I2S_DIN);
  }
  gpio_set_pull_mode(PIN_I2S_DIN, GPIO_FLOATING);
  ESP_LOGI(
      tag,
      "din probe: pulldown_high=%u/2000 pullup_high=%u/2000 (equal-ish means "
      "driven; 0 vs 2000 means floating)",
      (unsigned int)high_with_pulldown,
      (unsigned int)high_with_pullup);
}

void waveshare_audio_dump_registers(void) {
  /* ES8311 ADC-path registers, per the datasheet's init tables. */
  static const uint8_t interesting[] = {
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a,
    0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15,
    0x16, 0x17, 0x1b, 0x1c, 0x32, 0x37, 0x44, 0x45,
  };
  char line[256];
  size_t offset = 0U;
  size_t index;
  if (registers_ctrl_if == NULL) {
    ESP_LOGW(tag, "register dump unavailable before init");
    return;
  }
  for (index = 0U; index < sizeof(interesting); ++index) {
    uint8_t value = 0U;
    int written;
    if (registers_ctrl_if->read_reg(
            registers_ctrl_if, interesting[index], 1, &value, 1) !=
        ESP_CODEC_DEV_OK) {
      value = 0xffU;
    }
    written = snprintf(
        line + offset,
        sizeof(line) - offset,
        "%02x=%02x ",
        interesting[index],
        value);
    if (written < 0 || (size_t)written >= sizeof(line) - offset) {
      break;
    }
    offset += (size_t)written;
  }
  ESP_LOGI(tag, "es8311 regs: %s", line);
}

bool waveshare_audio_read(int16_t *destination, size_t samples) {
  return microphone_dev != NULL &&
      esp_codec_dev_read(
          microphone_dev, destination, samples * sizeof(int16_t)) ==
      ESP_CODEC_DEV_OK;
}

bool waveshare_audio_write(const int16_t *pcm, size_t samples) {
  return speaker_dev != NULL &&
      esp_codec_dev_write(
          speaker_dev, (void *)(uintptr_t)pcm, samples * sizeof(int16_t)) ==
      ESP_CODEC_DEV_OK;
}
