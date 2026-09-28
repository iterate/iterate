/* Hardware facts: Waveshare ESP32-S3-RLCD-4.2 schematic and vendor
 * 07_Audio_Test / XiaoZhi board config. ES7210 MIC1/MIC2 are the two
 * physical microphones; MIC3 carries the analogue speaker reference.
 * This initial standard-I2S port captures MIC1 with MIC2 as a local meter.
 * It does not claim XMOS processing or software echo cancellation.
 */
#include "rlcd_display.h"
#include "iterate/kit/capabilities/screen.h"
#include "esp_codec_dev_defaults.h"
#include "esp_log.h"
#include "iterate/kit/platforms/board.h"
#include "iterate/kit/capabilities/health.h"
#include <sounds_generated.inc>
#include <ctype.h>
#include <string.h>

static i2c_master_bus_handle_t bus;
static const audio_codec_if_t *dac, *adc;
static uint32_t display_failures;
static bool display_ready;
static int last_screen = -1;
static char last_status[32];
static struct iterate_kit_screen screen;
static uint8_t image_buffer[15000];
static bool submit_image(void *context, enum iterate_kit_screen_format format,
                         const uint8_t *bytes, size_t length) {
  (void)context;
  return format == ITERATE_KIT_SCREEN_MONO1 && rlcd_display_show_bitmap(bytes, length);
}
static enum iterate_kit_screen_state image_state(void *context) {
  (void)context;
  return ITERATE_KIT_SCREEN_SHOWN;
}

static bool start(void *context, struct iterate_kit_board_audio *out) {
  (void)context;
  (void)out;
  display_ready = rlcd_display_start();
  if (!display_ready) return false;
  if (!rlcd_display_show("HELLO WORLD", "CONNECTING")) return false;
  const struct iterate_kit_screen_driver display = {
    .width = 400, .height = 300, .formats = ITERATE_KIT_SCREEN_MONO1,
    .preferred_format = ITERATE_KIT_SCREEN_MONO1, .refresh_timeout_ms = 2000,
    .submit = submit_image, .state = image_state,
  };
  if (!iterate_kit_screen_init(&screen, &display, image_buffer, sizeof(image_buffer))) return false;
  const i2c_master_bus_config_t config = {.i2c_port = I2C_NUM_0,
    .sda_io_num = 13, .scl_io_num = 14, .clk_source = I2C_CLK_SRC_DEFAULT,
    .glitch_ignore_cnt = 7, .flags.enable_internal_pullup = true};
  if (i2c_new_master_bus(&config, &bus) != ESP_OK) return false;
  iterate_kit_board_i2c_use(bus);
  return true;
}

static enum iterate_kit_status set_volume(uint8_t percent, uint8_t *applied) {
  if (!dac) return ITERATE_KIT_IO_ERROR;
  if (percent > 65) percent = 65;
  if (dac->set_vol(dac, -50.0f + percent * 0.5f) != ESP_CODEC_DEV_OK ||
      dac->mute(dac, percent == 0) != ESP_CODEC_DEV_OK) return ITERATE_KIT_IO_ERROR;
  *applied = percent;
  return ITERATE_KIT_OK;
}

static bool open_codec(void) {
  audio_codec_i2c_cfg_t control = {.port = I2C_NUM_0, .bus_handle = bus,
    .addr = ES8311_CODEC_DEFAULT_ADDR};
  const audio_codec_ctrl_if_t *dac_control = audio_codec_new_i2c_ctrl(&control);
  const audio_codec_gpio_if_t *gpio = audio_codec_new_gpio();
  if (!dac_control || !gpio) return false;
  es8311_codec_cfg_t output = {.ctrl_if = dac_control, .gpio_if = gpio,
    .codec_mode = ESP_CODEC_DEV_WORK_MODE_DAC, .pa_pin = -1, .use_mclk = true,
    .hw_gain = {.pa_voltage = 5.0f, .codec_dac_voltage = 3.3f}};
  dac = es8311_codec_new(&output);
  control.addr = ES7210_CODEC_DEFAULT_ADDR;
  const audio_codec_ctrl_if_t *adc_control = audio_codec_new_i2c_ctrl(&control);
  if (!dac || !adc_control) return false;
  es7210_codec_cfg_t input = {.ctrl_if = adc_control,
    .mic_selected = ES7210_SEL_MIC1 | ES7210_SEL_MIC2};
  adc = es7210_codec_new(&input);
  esp_codec_dev_sample_info_t format = {.sample_rate = 16000,
    .channel = 2, .bits_per_sample = 16, .mclk_multiple = 256};
  uint8_t applied;
  if (!adc || dac->set_fs(dac, &format) != ESP_CODEC_DEV_OK ||
      adc->set_fs(adc, &format) != ESP_CODEC_DEV_OK ||
      adc->set_mic_gain(adc, 24.0f) != ESP_CODEC_DEV_OK ||
      dac->enable(dac, true) != ESP_CODEC_DEV_OK ||
      adc->enable(adc, true) != ESP_CODEC_DEV_OK ||
      set_volume(65, &applied) != ITERATE_KIT_OK) return false;
  ESP_LOGI("rlcd", "ES8311 + ES7210 ready; KEY GPIO18 starts a conversation");
  return true;
}

static void present(void *context, const struct iterate_kit_voice_view *view) {
  (void)context;
  if (!display_ready || display_failures) return;
  if (screen.showing_image) {
    /* clear() must make the normal state redraw even when the voice view has
     * not changed while the image was latched. */
    last_screen = -3;
    return;
  }
  const char *title = view->fault ? "FAULT" :
    view->screen == ITERATE_KIT_VOICE_SCREEN_IDLE ? "READY" :
    view->screen == ITERATE_KIT_VOICE_SCREEN_LISTENING ? "LISTENING" :
    view->screen == ITERATE_KIT_VOICE_SCREEN_SPEAKING ? "SPEAKING" : "CONNECTING";
  char status[32] = {0};
  const char *message = view->status && *view->status ? view->status : "PRESS KEY";
  for (size_t i = 0; message[i] && i < sizeof(status) - 1; ++i)
    status[i] = (char)toupper((unsigned char)message[i]);
  const int screen = view->fault ? -2 : (int)view->screen;
  if (screen == last_screen && strcmp(status, last_status) == 0) return;
  if (!rlcd_display_show(title, status)) {
    ++display_failures;
    ESP_LOGE("rlcd", "Display transfer failed; further updates stopped");
    return;
  }
  last_screen = screen;
  memcpy(last_status, status, sizeof(status));
}

static size_t health(void *context, char *out, size_t capacity) {
  (void)context;
  const struct iterate_kit_health_field fields[] = {
    {"displayFailures", display_failures}, {"softwareAec", 0},
    {"screenUploadsStarted", screen.uploads_started},
    {"screenUploadsCompleted", screen.uploads_completed},
    {"screenUploadFailures", screen.upload_failures},
    {"screenBytesReceived", screen.bytes_received},
    {"screenImageShown", screen.showing_image ? 1 : 0},
  };
  return iterate_kit_health_append_fields(out, capacity, fields, 7);
}

static size_t modules(void *context, struct iterate_kit_module *out, size_t capacity) {
  (void)context;
  if (out == NULL || capacity == 0U) return 0U;
  out[0] = iterate_kit_screen_module(&screen);
  return 1U;
}

static const struct iterate_kit_board_ops extra = {
  .start = start, .present = present, .modules = modules, .health = health,
};
static const struct iterate_kit_gpio_step boot[] = {{46, 0, 0}};
static const struct iterate_kit_i2s_codec_facts audio = {
  .playback_port = I2S_NUM_0, .capture_port = I2S_NUM_0, .role = I2S_ROLE_MASTER,
  .playback = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(16000),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
    .gpio_cfg = {.mclk = 16, .bclk = 9, .ws = 45, .dout = 8, .din = 10},
  },
  .capture = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(16000),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
    .gpio_cfg = {.mclk = 16, .bclk = 9, .ws = 45, .dout = 8, .din = 10},
  },
  .dma_frames = 320, .dma_descriptors = 6,
  .playback_shape = {16, 2, 0, -1, 1}, .capture_shape = {16, 2, 0, 1, 1},
  /* Bench voice peaks were only 162/32767 at unity; fixed gain preserves
   * quiet speech without a speaker-dependent gate. Clipping is in health. */
  .capture_gain = 16, .amplifier_gpio = 46,
};
static const struct iterate_kit_board board = {
  .facts = {.device_name = "waveshare-rlcd-4-2", .speaker = {.ceiling = 65}},
  .i2c = {.sda = 13, .scl = 14, .hz = 400000},
  .boot = boot, .boot_count = 1, .audio = &audio,
  .status_led_gpio = -1, .button = {.gpio = 18, .active_low = true},
  .ring = {.gpio = -1, .power_gpio = -1},
  .sounds = {.wake = sound_chime_press, .wake_bytes = sizeof(sound_chime_press),
    .speech_peak = ITERATE_KIT_SPEECH_PEAK},
  .open_codec = open_codec, .set_volume = set_volume, .extra = &extra,
};
void app_main(void) { iterate_kit_board_run(&board); }
