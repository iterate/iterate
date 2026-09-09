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
 * Two tempting bring-up changes are deliberately absent:
 *  - `no_dac_ref` remains false, as in working board ports. The earlier noise
 *    diagnosis was actually two codec instances reconfiguring one I2S pair.
 *  - PGA remains 24 dB. At 30 dB measured speech clipped; the old 36 dB note
 *    described a VAD workaround rather than a safe capture level.
 *
 * The bring-up diagnostics this file once carried (register dumps, a DIN
 * probe) were deleted once the board proved out; git history has them if a
 * future bring-up needs the pattern. Note when reading captured audio off the
 * stream: 640 PCM bytes base64-encode to 854 characters, which is NOT a
 * multiple of 4 — decode each frame separately. Concatenating the strings
 * first misaligns every frame after the first and yields convincing
 * broadband "noise" that looks exactly like a dead microphone.
 */
#include "waveshare_audio.h"

#include "iterate/kit/platforms/i2s_codec.h"
#include <string.h>

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "driver/i2s_std.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "bsp/esp-bsp.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

/* Bring-up probe: treat the board's microphone as PDM rather than analog. */
#ifndef WAVESHARE_AUDIO_DIGITAL_MIC
#define WAVESHARE_AUDIO_DIGITAL_MIC 0
#endif

static const char tag[] = "waveshare-audio";

enum {
  DMA_DESCRIPTOR_COUNT = 6,
  DMA_FRAMES_PER_DESCRIPTOR = 240,
  /* 6 descriptors x 240 frames at 16kHz = the ring's depth in milliseconds. */
  DMA_RING_MS = 90,
  /* One descriptor: 240 frames at 16kHz. */
  DMA_DESCRIPTOR_MS = 15,
  PIN_I2C_SDA = 15,
  PIN_I2C_SCL = 14,
  PIN_I2S_MCLK = 16,
  PIN_I2S_BCLK = 9,
  PIN_I2S_WS = 45,
  PIN_I2S_DIN = 10,
  PIN_I2S_DOUT = 8,
  PIN_PA = 46,
  /*
   * How long this board's class-D amplifier needs between its enable going
   * high and it reproducing a sample faithfully. Generous rather than tuned:
   * the cost is 80 ms added to the first word of an answer, paid out of a
   * thirty-second ring that already holds the whole thing, and the failure it
   * prevents is a missing syllable that no counter can report.
   */
  AMPLIFIER_SETTLE_MS = 80,
  ADDR_ES8311_8BIT = 0x30, /* esp_codec_dev shifts to 7-bit 0x18 */
  ADDR_AXP2101 = 0x34,
};

static i2c_master_bus_handle_t i2c_bus;
/*
 * One ES8311 instance, one IN_OUT handle: the chip is one device and the I2S
 * channel pair has one owner. Two handles over one data interface meant the
 * second open() reconfigured the channels the first had set up.
 */
static esp_codec_dev_handle_t codec_dev;
static uint8_t speaker_volume_percent = WAVESHARE_AUDIO_VOLUME_DEFAULT;
/* Retained for the post-open register dump (bring-up diagnostics only). */
static const audio_codec_ctrl_if_t *registers_ctrl_if;

static struct iterate_kit_audio_codec shared_codec;

static const struct iterate_kit_audio_codec_properties codec_properties = {
  .capture_sample_rate_hz = WAVESHARE_AUDIO_SAMPLE_RATE_HZ,
  .playback_sample_rate_hz = WAVESHARE_AUDIO_SAMPLE_RATE_HZ,
  .capture_channels = 1,
  .playback_channels = 1,
  .has_reference_channel = false,
  .has_output_gain_control = true,
  .output_gain_ceiling_centi_db = 0,
};

/* --- local sounds ---------------------------------------------------------- */

static portMUX_TYPE sound_lock = portMUX_INITIALIZER_UNLOCKED;
/*
 * Until when the amplifier must be left up for a local sound. The loop
 * re-raises PHASE_QUIET on every idle pass and this board answers it by
 * cutting the amplifier — which, ungated, beheads a chime played from idle.
 * A conservative absolute deadline (settle plus clip length plus one DMA
 * ring) is enough: QUIET keeps arriving, so the amp drops on the first pass
 * after it expires.
 */
static int64_t sound_amp_hold_until_us;

void waveshare_audio_play_sound(const uint8_t *pcm, uint32_t bytes) {
  if (pcm == NULL || bytes < 2U) return;
  /*
   * The chime must be audible from idle: the amplifier is normally raised
   * when an answer's audio arrives and dropped after 1.5 s of quiet, so a
   * gesture's acknowledgement usually finds it down. The settle deadline the
   * amplifier stamps is honoured by the playback task before its first
   * write, so the chime's opening is not eaten the way "banana" once was.
   */
  waveshare_audio_amplifier(true);
  const int64_t hold_us =
      (int64_t)(bytes / 2U) * 1000000 / WAVESHARE_AUDIO_SAMPLE_RATE_HZ +
      (int64_t)(AMPLIFIER_SETTLE_MS + DMA_RING_MS) * 1000;
  portENTER_CRITICAL(&sound_lock);
  sound_amp_hold_until_us = esp_timer_get_time() + hold_us;
  portEXIT_CRITICAL(&sound_lock);
  iterate_kit_i2s_codec_play_sound(pcm, bytes);
}

bool waveshare_audio_sound_active(void) {
  bool active;
  portENTER_CRITICAL(&sound_lock);
  active = iterate_kit_i2s_codec_sound_active() ||
      esp_timer_get_time() < sound_amp_hold_until_us;
  portEXIT_CRITICAL(&sound_lock);
  return active;
}

/* The avatar is an in-firmware reader of descriptor debt, even though apps/os
 * has no dma* reader. Keep only its owed-time ISR; starvation and its saturated
 * counters belong to the shared deadline ledger. No descriptor deficit metrics.
 */
static DRAM_ATTR portMUX_TYPE dma_ledger_lock = portMUX_INITIALIZER_UNLOCKED;
static volatile int32_t dma_owed_ms;
static bool dma_watch;

static bool IRAM_ATTR on_dma_sent(
    i2s_chan_handle_t handle, i2s_event_data_t *event, void *context) {
  (void)handle;
  (void)context;
  if (event == NULL || event->dma_buf == NULL) return false;
  portENTER_CRITICAL_ISR(&dma_ledger_lock);
  if (dma_watch) {
    dma_owed_ms -= DMA_DESCRIPTOR_MS;
    if (dma_owed_ms < 0) dma_owed_ms = 0;
  }
  portEXIT_CRITICAL_ISR(&dma_ledger_lock);
  return false;
}

int32_t waveshare_audio_dma_owed_ms(void) {
  return dma_owed_ms;
}

void waveshare_audio_phase(enum iterate_kit_voice_phase phase) {
  iterate_kit_i2s_codec_phase(phase);
  portENTER_CRITICAL(&dma_ledger_lock);
  switch (phase) {
    case ITERATE_KIT_VOICE_PHASE_FEEDING:
      if (!dma_watch) dma_owed_ms = 0;
      dma_watch = true;
      break;
    case ITERATE_KIT_VOICE_PHASE_WAITING:
    case ITERATE_KIT_VOICE_PHASE_DRAINING:
    case ITERATE_KIT_VOICE_PHASE_FLUSHED:
      dma_watch = false;
      break;
    default:
      break;
  }
  portEXIT_CRITICAL(&dma_ledger_lock);
}

/** esp_codec_dev owns the blocking mono read; task/mailbox policy is shared. */
static enum iterate_kit_status hardware_read(void *context, int16_t *samples, size_t count) {
  (void)context;
  return esp_codec_dev_read(codec_dev, samples, count * sizeof(*samples)) == ESP_CODEC_DEV_OK
      ? ITERATE_KIT_OK : ITERATE_KIT_IO_ERROR;
}

/*
 * When the amplifier can be trusted to reproduce a sample. Written wherever
 * the amplifier is raised (the receive path when an answer's audio arrives,
 * the poll task when a local chime asks for it), read by the playback task; a
 * single aligned 64-bit stamp whose rare concurrent writers store the same
 * "now plus settle" value.
 */
static volatile int64_t amplifier_settled_at_us;

/** Unlike HAVPE's always-on amp, wait before the shared ledger credits PCM.
 * Settling on the receive path would stall decoding; prefill is no longer a
 * wall-clock delay when a whole answer arrives in a burst.
 */
static void wait_for_amplifier(void *context) {
  (void)context;
    /*
     * THE AMPLIFIER HAS TO BE CONDUCTING BEFORE THE FIRST SAMPLE, AND THIS IS
     * THE SECOND TIME THAT HAS NEEDED FIXING.
     *
     * The first fix raised the amp when audio ARRIVED rather than when the
     * first sample was written, and spent the playout prefill as settle time.
     * That was sound while the server dripped frames in real time: the prefill
     * really did take 160 ms of wall clock to accumulate. It is not sound any
     * more — a whole answer now leaves the bridge as fast as the wire takes
     * it, so the prefill threshold is crossed a few milliseconds after the
     * first frame lands and the amp gets no settle window at all. Heard as
     * "banana" arriving as "nana".
     *
     * The counters could not see it and never will: every frame was received,
     * queued and written (spkPlayed == spkWrites, nothing discarded). The
     * audio was lost in the analogue domain, after the last instrument.
     *
     * So the settle is an explicit deadline now rather than a side effect of
     * how slowly audio happens to arrive. Waiting HERE is safe and waiting in
     * the amplifier call is not: this task exists to feed DMA, while that one
     * runs on the receive path that decodes speaker PCM.
     */
    {
      const int64_t settle_us = amplifier_settled_at_us - esp_timer_get_time();
      if (settle_us > 0) {
        vTaskDelay(pdMS_TO_TICKS((uint32_t)((settle_us + 999) / 1000)));
      }
    }
}

/** Only the shared playback task calls this blocking ES8311 writer. */
static enum iterate_kit_status hardware_write(void *context, const int16_t *samples, size_t count) {
  (void)context;
  const uint32_t ms = (uint32_t)(count * 1000U / WAVESHARE_AUDIO_SAMPLE_RATE_HZ);
  portENTER_CRITICAL(&dma_ledger_lock);
  dma_owed_ms += (int32_t)ms;
  portEXIT_CRITICAL(&dma_ledger_lock);
  if (esp_codec_dev_write(codec_dev, (void *)(uintptr_t)samples,
          count * sizeof(*samples)) != ESP_CODEC_DEV_OK) {
    portENTER_CRITICAL(&dma_ledger_lock);
    dma_owed_ms -= (int32_t)ms;
    if (dma_owed_ms < 0) dma_owed_ms = 0;
    portEXIT_CRITICAL(&dma_ledger_lock);
    return ITERATE_KIT_IO_ERROR;
  }
  return ITERATE_KIT_OK;
}

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
  i2s_chan_handle_t tx = NULL;
  i2s_chan_handle_t rx = NULL;

  /*
   * One owner for I2C0: the BSP creates it (same SDA 15 / SCL 14) and the
   * codec, the PMIC and the touch controller all ride that bus. Two creators
   * of the same port is an error, and the display needs it either way.
   */
  i2c_bus = bsp_i2c_get_handle();
  if (i2c_bus == NULL) {
    ESP_LOGE(tag, "i2c bus unavailable");
    return false;
  }
  if (!power_rails_up()) {
    return false;
  }

  /*
   * DMA geometry from Espressif's standard-mode sizing formula:
   *
   *   descriptor bytes = frames * slots * bits / 8
   *                    = 240 * 1 * 16 / 8 = 480 (must be <= 4092)
   *   interrupt period = frames / sample rate = 240 / 16000 = 15 ms
   *   ring depth       = descriptors * period = 6 * 15 = 90 ms
   *
   * The 20 ms hardware-task cycle therefore needs more than 20/15
   * descriptors; six leaves four cycles of scheduling headroom. The driver's
   * receive buffer is 6 * 480 = 2880 bytes and the public seam removes a full
   * 640-byte frame at a time. Source: ESP-IDF 5.4 I2S documentation,
   * "DMA buffer info and configuration".
   * https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/api-reference/peripherals/i2s.html#dma-buffer-info-and-configuration
   */
  _Static_assert(
      DMA_FRAMES_PER_DESCRIPTOR * 1 * 16 / 8 <= 4092,
      "I2S descriptor exceeds the ESP32-S3 DMA limit");
  _Static_assert(
      DMA_DESCRIPTOR_COUNT * DMA_FRAMES_PER_DESCRIPTOR * 1000 /
              WAVESHARE_AUDIO_SAMPLE_RATE_HZ ==
          DMA_RING_MS,
      "documented I2S ring depth drifted");
  i2s_chan_config_t channel_config =
      I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  channel_config.dma_desc_num = DMA_DESCRIPTOR_COUNT;
  channel_config.dma_frame_num = DMA_FRAMES_PER_DESCRIPTOR;
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
    const i2s_event_callbacks_t tx_callbacks = {.on_sent = on_dma_sent};
    (void)i2s_channel_register_event_callback(tx, &tx_callbacks, NULL);
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
      /*
       * The amplifier is driven by hand (waveshare_audio_amplifier), not
       * latched on by the codec for the life of the board.
       */
      .pa_pin = -1,
      .pa_reverted = false,
      .master_mode = false,
      .use_mclk = true,
      .digital_mic = WAVESHARE_AUDIO_DIGITAL_MIC,
      .invert_mclk = false,
      .invert_sclk = false,
      .hw_gain = {.pa_voltage = 5.0f, .codec_dac_voltage = 3.3f},
      /*
       * Kept to match Waveshare's BSP recipe. The NS4150B supply is
       * physically 3.3 V, so 5.0 V makes the codec abstraction's gain
       * arithmetic inaccurate — but correcting it is an ACOUSTIC change and
       * belongs in its own measured comparison, not folded into a structural
       * one. Retune it only against a recording, never by reasoning.
       */
      /*
       * Reg 0x44 = 0x58 (the default) puts DAC output in the ADC lane's right
       * slot as an AEC reference. That was blamed for this board's "broadband
       * garbage" capture and worked around here — but the real cause was two
       * codec instances fighting over one I2S channel pair (see below), and
       * every working port of this board leaves this at the default.
       */
      .no_dac_ref = false,
    };
    /*
     * ONE codec instance, ONE device handle, opened once.
     *
     * This used to build two es8311 instances over the same control
     * interface and two esp_codec_dev handles (IN and OUT) over the same
     * I2S data interface. Every esp_codec_dev_open() calls the data
     * interface's set_fmt, which DISABLES BOTH I2S CHANNELS, rewrites the
     * slot configuration and re-enables them — so opening the speaker tore
     * down and reconfigured the channel pair the microphone had just set up,
     * and clobbered the shared format state that this driver assumes has a
     * single owner. A capture whose slot mask got rewritten underneath it is
     * exactly the "gain-independent broadband noise" this board showed.
     */
    const audio_codec_if_t *codec = es8311_codec_new(&codec_config);
    if (codec == NULL) {
      ESP_LOGE(tag, "ES8311 construction failed");
      return false;
    }
    {
      esp_codec_dev_cfg_t device_config = {
        .dev_type = ESP_CODEC_DEV_TYPE_IN_OUT,
        .codec_if = codec,
        .data_if = data_interface,
      };
      codec_dev = esp_codec_dev_new(&device_config);
      if (codec_dev == NULL) {
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
    if (esp_codec_dev_open(codec_dev, &sample_info) != ESP_CODEC_DEV_OK) {
      ESP_LOGE(tag, "codec open failed");
      return false;
    }
    /*
     * Preserved, not endorsed: ES8311's esp_codec_dev adapter writes register
     * 0x16 ADC_SCALE here, whose reset value is already 24 dB, and clears
     * ADC_SYNC. It does not change the analogue PGA at register 0x14. The
     * earlier "30 dB clipped" result therefore measured digital saturation,
     * not an analogue-PGA comparison — so it is not evidence about the PGA at
     * all, and the comparison it appeared to settle is still open.
     */
    (void)esp_codec_dev_set_in_gain(codec_dev, 24.0f);
    /*
     * As loud as it gets without audible distortion. Measured by acoustic
     * loopback — play a 440Hz tone, capture it on this board's own
     * microphone, compare harmonics to fundamental:
     *
     *   volume 100 -> 2nd harmonic -16.8 dB   (distorting, even with the
     *                                          microphone well below clipping)
     *   volume  60 -> 2nd harmonic -34.9 dB   (clean)
     *
     * So full scale overdrives this amp, and "turn it all the way up" was
     * making the speaker worse rather than louder. 85 keeps the headroom
     * while staying loud; `itx.kit.waveshare.setVolume(n)` tunes it live.
     */
    (void)esp_codec_dev_set_out_vol(codec_dev, WAVESHARE_AUDIO_VOLUME_DEFAULT);
    speaker_volume_percent = WAVESHARE_AUDIO_VOLUME_DEFAULT;
  }
  iterate_kit_i2s_codec_set_before_write(wait_for_amplifier);
  if (!iterate_kit_i2s_codec_start_over(
          hardware_read, hardware_write, NULL, DMA_RING_MS, &shared_codec)) {
    ESP_LOGE(tag, "audio hardware task creation failed");
    return false;
  }
  shared_codec.properties = &codec_properties;
  ESP_LOGI(tag, "ES8311 duplex audio ready at 16 kHz");
  /*
   * Bring-up probes deliberately NOT run here: probe_din reconfigures the
   * pull mode on a live DIN pad, busy-spins, and leaves the pad FLOATING —
   * discarding whatever the I2S driver installed. Call them by hand when
   * diagnosing, never on the shipping path.
   */
  return true;
}

/*
 * MEASURED DISTORTION IS THE CEILING HERE, not power or echo: a 1 kHz tone at
 * volume 100 put the 2nd harmonic at -16.8 dB, and at 60 at -34.9 dB. 92 is
 * where the harmonic is still below the noise a listener notices and the
 * device is meaningfully louder than the old 85. Above that it gets louder by
 * getting dirtier, which is not louder.
 */
enum iterate_kit_status waveshare_audio_set_volume(
    uint8_t percent, uint8_t *applied) {
  if (codec_dev == NULL) return ITERATE_KIT_UNAVAILABLE;
  if (percent > WAVESHARE_AUDIO_VOLUME_CEILING) {
    percent = WAVESHARE_AUDIO_VOLUME_CEILING;
  }
  if (esp_codec_dev_set_out_vol(codec_dev, (int)percent) !=
      ESP_CODEC_DEV_OK) {
    return ITERATE_KIT_IO_ERROR;
  }
  speaker_volume_percent = percent;
  if (applied != NULL) *applied = percent;
  return ITERATE_KIT_OK;
}

uint8_t waveshare_audio_volume(void) { return speaker_volume_percent; }

void waveshare_audio_amplifier(bool on) {
  static bool configured;
  static bool current;
  if (!configured) {
    const gpio_config_t pa_config = {
      .pin_bit_mask = 1ULL << PIN_PA,
      .mode = GPIO_MODE_OUTPUT,
      .pull_up_en = GPIO_PULLUP_DISABLE,
      .pull_down_en = GPIO_PULLDOWN_DISABLE,
      .intr_type = GPIO_INTR_DISABLE,
    };
    if (gpio_config(&pa_config) != ESP_OK) return;
    configured = true;
    current = false;
    (void)gpio_set_level(PIN_PA, 0);
  }
  if (on == current) return;
  current = on;
  (void)gpio_set_level(PIN_PA, on ? 1 : 0);
  /*
   * Still no delay on the way up — blocking here would stall the task that
   * decodes speaker PCM, which is exactly what must not happen. Instead this
   * publishes the instant the amp can be trusted, and the PLAYBACK task waits
   * for it. See the wait in playback_task for why the old "the prefill settles
   * it for free" reasoning stopped being true.
   */
  if (on) {
    amplifier_settled_at_us =
        esp_timer_get_time() + (int64_t)AMPLIFIER_SETTLE_MS * 1000;
  }
}

struct iterate_kit_audio_codec waveshare_audio_codec(void) {
  return shared_codec;
}
