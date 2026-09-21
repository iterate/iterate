/* Hardware facts translated from FutureProofHomes Satellite1-ESPHome
 * config/common/{core_board,speaker,led_ring,buttons}.yaml (MIT).
 * GPIO4 is only ever LOW: HIGH resets XMOS and selects its boot flash.
 */

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "iterate/kit/button.h"
#include "iterate/kit/capabilities/health.h"
#include "iterate/kit/platforms/board.h"
#include "iterate/kit/platforms/fusb302_esp.h"
#include "iterate/kit/platforms/pcm5122.h"
#include "iterate/kit/platforms/tas2780.h"
#include "iterate/kit/platforms/xmos_spi.h"

#include <sounds_generated.inc>

/* Startup, poll, volume RPC and health serialize codec/XMOS state on the app
 * task. USB-PD owns a separate I2C device and publishes copied status. */
static struct iterate_kit_xmos_spi xmos;
static struct iterate_kit_xmos_version xmos_version;
static struct iterate_kit_tas2780 amp;
static i2c_master_dev_handle_t line_out;
static struct iterate_kit_button volume_up, volume_down;
static bool microphone_muted;
static uint32_t side_button_read_failures;
static struct iterate_kit_fusb302_esp usb_pd = {.lock = portMUX_INITIALIZER_UNLOCKED};
static struct iterate_kit_pd_status power_status;
static bool amplifier_active;
static uint32_t amplifier_power_failures;

/* The former -40 dB echo-test level is not the speaker's physical ceiling.
 * DVC remains user-adjustable; power negotiation never turns the volume up. */
enum { SATELLITE1_START_VOLUME = 80, SATELLITE1_SPEAKER_CEILING = 100 };

static bool satellite1_activate_amplifier(void) {
  /* Start at the manufacturer's 15 dBV gain and measure the actual rail.
   * 20 dBV permits 25 W into 4 ohms; require >=18 V and a >=30 W contract.
   * The gain choice is a fact about this speaker, not a USB-PD policy. */
  if (!iterate_kit_tas2780_shutdown(&amp) ||
      !iterate_kit_tas2780_set_output_level(&amp, 8) ||
      !iterate_kit_tas2780_activate(&amp)) return false;
  if (power_status.state == ITERATE_KIT_PD_READY &&
      amp.pvdd_centivolts * 10U < power_status.millivolts * 9U / 10U) {
    ESP_LOGE("satellite1", "amplifier rail below PD contract: %ucV, requested %umV",
        amp.pvdd_centivolts, power_status.millivolts);
    return false;
  }
  const uint32_t contract_mw = (uint32_t)power_status.millivolts * power_status.milliamps / 1000U;
  if (power_status.state == ITERATE_KIT_PD_READY && contract_mw >= 30000U &&
      amp.pvdd_centivolts >= 1800U) {
    if (!iterate_kit_tas2780_shutdown(&amp) ||
        !iterate_kit_tas2780_set_output_level(&amp, 18) ||
        !iterate_kit_tas2780_activate(&amp)) return false;
  }
  ESP_LOGI("satellite1", "speaker PVDD=%ucV mode=%u output=%u volume=%u",
      amp.pvdd_centivolts, (unsigned)amp.power_mode, amp.output_level, amp.volume);
  return true;
}

static uint8_t satellite1_volume(void *context) {
  (void)context;
  return amp.volume;
}

/** Gate XMOS before hardware tasks can block on its slave clocks, then bring
 * up both chips. board.c has already enabled I2S with TX silence preloaded;
 * TAS2780 activation can now use BCLK for its SAR supply measurements.
 */
static bool iterate_kit_satellite1_open_codec(void) {
  i2c_master_dev_handle_t amp_device = NULL;
  i2c_master_dev_handle_t pd_device = NULL;
  uint8_t applied;
  const char *stage = iterate_kit_xmos_spi_open(
      &xmos, 11, 13, 12, GPIO_NUM_10, &xmos_version, 6, 250);
  if (stage != NULL) goto failed;
  ESP_LOGI("satellite1", "XMOS %u.%u.%u", xmos_version.major,
      xmos_version.minor, xmos_version.patch);
  stage = "I2C devices";
  if (iterate_kit_board_i2c_device(0x3F, &amp_device) != ESP_OK ||
      iterate_kit_board_i2c_device(0x4D, &line_out) != ESP_OK ||
      iterate_kit_board_i2c_device(0x22, &pd_device) != ESP_OK) goto failed;
  stage = "TAS2780 init";
  if (!iterate_kit_tas2780_init(&amp, amp_device)) goto failed;
  stage = "TAS2780 volume";
  if (!iterate_kit_tas2780_set_volume(
      &amp, SATELLITE1_START_VOLUME, &applied)) goto failed;
  stage = "USB-PD start";
  if (!iterate_kit_fusb302_esp_start(&usb_pd, pd_device,
      (struct iterate_kit_pd_limits){.millivolts = 20000, .milliamps = 3000, .milliwatts = 30000})) goto failed;
  /* Keep the amplifier shut down throughout initial negotiation. */
  stage = "USB-PD settle";
  const int64_t deadline = esp_timer_get_time() + 3000000;
  do {
    power_status = iterate_kit_fusb302_esp_status(&usb_pd);
    if (power_status.state == ITERATE_KIT_PD_READY || power_status.state == ITERATE_KIT_PD_USB_ONLY) break;
    if (power_status.state == ITERATE_KIT_PD_FAILED) goto failed;
    vTaskDelay(pdMS_TO_TICKS(10));
  } while (esp_timer_get_time() < deadline);
  if (power_status.state != ITERATE_KIT_PD_READY && power_status.state != ITERATE_KIT_PD_USB_ONLY) goto failed;
  stage = "PCM5122 init";
  if (!iterate_kit_pcm5122_init(line_out)) goto failed;
  stage = "TAS2780 activate";
  if (!satellite1_activate_amplifier()) goto failed;
  amplifier_active = true;
  stage = "PCM5122 unmute";
  if (!iterate_kit_pcm5122_mute(line_out, false)) goto failed;
  return true;

failed:
  amplifier_active = false;
  ESP_LOGE("satellite1", "%s failed; codec startup refused", stage);
  if (amp.device != NULL && !iterate_kit_tas2780_shutdown(&amp))
    ESP_LOGE("satellite1", "TAS2780 shutdown failed");
  if (line_out != NULL && !iterate_kit_pcm5122_mute(line_out, true))
    ESP_LOGE("satellite1", "PCM5122 mute failed");
  return false;
}

/** The speaker RPC and side buttons both reach the chip's volume/mute map. */
static enum iterate_kit_status iterate_kit_satellite1_set_volume(
    uint8_t percent, uint8_t *applied) {
  return iterate_kit_tas2780_set_volume(&amp, percent, applied)
      ? ITERATE_KIT_OK : ITERATE_KIT_IO_ERROR;
}

/** Read only trustworthy GPIO_IN_A at the shared 25 ms control cadence.
 * A failed read releases both debouncers and fails closed until a valid
 * mute reading arrives; the failure remains counted. Only bits 0/2/3 are used; GPIO0 owns the action-button grammar.
 */
static void iterate_kit_satellite1_poll(void *context, struct iterate_kit_voice_intent *out) {
  (void)context;
  const struct iterate_kit_pd_status current_power = iterate_kit_fusb302_esp_status(&usb_pd);
  if (current_power.state != power_status.state || current_power.contracts != power_status.contracts) {
    power_status = current_power;
    /* Reconfigure once per transition, as the vendor's refresh_audio_output
     * does. A failed reconfiguration is visible and is not retried forever. */
    const bool ready = power_status.state == ITERATE_KIT_PD_READY || power_status.state == ITERATE_KIT_PD_USB_ONLY;
    const bool changed = ready ? satellite1_activate_amplifier() : iterate_kit_tas2780_shutdown(&amp);
    amplifier_active = ready && changed;
    if (!changed) {
      if (amplifier_power_failures != UINT32_MAX) ++amplifier_power_failures;
      ESP_LOGE("satellite1", "amplifier power transition failed");
      if (!iterate_kit_tas2780_shutdown(&amp)) ESP_LOGE("satellite1", "amplifier shutdown failed");
    }
  }
  uint8_t status[4];
  if (!iterate_kit_xmos_spi_read_status(&xmos, status)) {
    if (side_button_read_failures < UINT32_MAX) ++side_button_read_failures;
    volume_up = (struct iterate_kit_button){0};
    volume_down = (struct iterate_kit_button){0};
    microphone_muted = true;
    out->microphone_muted = true;
    return;
  }
  const uint8_t pressed = (uint8_t)~status[1];
  const uint64_t now_ms = (uint64_t)(esp_timer_get_time() / 1000);
  iterate_kit_button_update(&volume_up, (pressed & 1U) != 0U, now_ms);
  iterate_kit_button_update(&volume_down, (pressed & 4U) != 0U, now_ms);
  /* NOT inverted, unlike Vol+/Vol-: the vendor's buttons.yaml declares the
   * hardware-mute pin `inverted: false` (bit 3 HIGH = the mic rail is cut).
   * Reading it through the same ~status mask as the volume keys made a
   * fresh board report micMuted 1 and refuse every call on the first bench. */
  const bool muted = (status[1] & 8U) != 0U;
  microphone_muted = muted;
  out->microphone_muted = muted;
  const int step = (int)iterate_kit_button_take_press(&volume_up) -
      (int)iterate_kit_button_take_press(&volume_down);
  if (step == 0) return;
  (void)iterate_kit_board_nudge_volume(step * 5);
}

/** Refresh amplifier faults before appending its fields and the XMOS facts. */
static size_t iterate_kit_satellite1_health(void *context, char *out, size_t capacity) {
  (void)context;
  uint32_t faults;
  (void)iterate_kit_tas2780_read_faults(&amp, &faults); /* failures counted by chip */
  const size_t used = iterate_kit_tas2780_health(&amp, out, capacity);
  if (used == 0U) return 0U;
  const struct iterate_kit_pd_status pd = iterate_kit_fusb302_esp_status(&usb_pd);
  const struct iterate_kit_health_field fields[] = {
    {"xmosMajor", xmos_version.major}, {"xmosMinor", xmos_version.minor},
    {"xmosPatch", xmos_version.patch}, {"micMuted", microphone_muted},
    {"sideButtonReadFailures", side_button_read_failures},
    {"pdState", pd.state}, {"pdFailure", pd.failure},
    {"pdMilliVolts", pd.millivolts}, {"pdMilliAmps", pd.milliamps},
    {"pdContracts", pd.contracts}, {"pdHardResets", pd.hard_resets},
    {"pdSoftResets", pd.soft_resets}, {"pdI2cFailures", pd.i2c_failures},
    {"pdMessages", pd.messages}, {"pdCc", pd.cc},
    {"ampActive", amplifier_active}, {"ampPowerFailures", amplifier_power_failures},
  };
  const size_t added = iterate_kit_health_append_fields(
      out + used, capacity - used, fields, sizeof(fields) / sizeof(fields[0]));
  return added == 0U ? 0U : used + added;
}

static const struct iterate_kit_board_ops satellite1_extra = {
  .poll = iterate_kit_satellite1_poll,
  .health = iterate_kit_satellite1_health,
};

static const struct iterate_kit_gpio_step boot[] = {{4, 0, 0}};

/* Slot layout translated from Satellite1-XMOS satellite-xmos-firmware/src/main.c:187-215.
 * XMOS owns BCLK/LRCLK and GPIO16 MCLK. TX never stops: GPIO9 is its AEC reference. */
static const struct iterate_kit_i2s_codec_facts audio = {
  .playback_port = I2S_NUM_0, .capture_port = I2S_NUM_0, .role = I2S_ROLE_SLAVE,
  .playback = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(48000),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
    .gpio_cfg = {.mclk = I2S_GPIO_UNUSED, .bclk = 8, .ws = 7, .dout = 9, .din = 15},
  },
  .capture = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(48000),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
    .gpio_cfg = {.mclk = I2S_GPIO_UNUSED, .bclk = 8, .ws = 7, .dout = 9, .din = 15},
  },
  .dma_frames = 480, .dma_descriptors = 6,
  .playback_shape = {32, 2, 0, -1, 3},
  /* v1.0.3 DOUT1 carries AGC in slot 0 and AEC+IC+NS in slot 1.
   * Use the noise-suppressed output with fixed gain and the calibrated speaker.
   * Neither slot is a raw microphone plane. */
  .capture_shape = {32, 2, 1, -1, 3},
  .capture_gain = 32,
  .amplifier_gpio = -1,
};

static const struct iterate_kit_board board = {
  .facts = {
    .device_name = "satellite1",
    .speaker = {.ceiling = SATELLITE1_SPEAKER_CEILING, .volume = satellite1_volume},
  },
  .i2c = {.sda = 5, .scl = 6, .hz = 400000},
  .boot = boot, .boot_count = 1,
  /* Chip init owns all scripts; the volume callback owns register 0x1A. */
  .scripts = NULL, .script_count = 0,
  .audio = &audio,
  .volume = {.register_count = 0},
  .ring = {.gpio = 21, .pixels = 24, .order = LED_PIXEL_FORMAT_GRB, .power_gpio = -1},
  .status_led_gpio = 45,
  .button = {.gpio = 0, .active_low = true},
  .wake_word = "jarvis",
  .sounds = {
    .wake = sound_chime_press, .wake_bytes = sizeof(sound_chime_press),
    .ended = sound_chime_ended, .ended_bytes = sizeof(sound_chime_ended),
  },
  .open_codec = iterate_kit_satellite1_open_codec,
  .set_volume = iterate_kit_satellite1_set_volume,
  .extra = &satellite1_extra,
};

/** ESP-IDF entry point: run this board through the shared voice loop. */
void app_main(void) {
  iterate_kit_board_run(&board);
}
