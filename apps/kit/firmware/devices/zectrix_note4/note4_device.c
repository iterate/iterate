/* NOTE4 hardware facts from ZECTRIX's zectrix-note4-epd-demo. See NOTICE.md.
 * One ES8311 supplies microphone and speaker; there is no AEC reference. */
#include "note4_display.h"
#include "driver/gpio.h"
#include "esp_codec_dev_defaults.h"
#include "esp_log.h"
#include "esp_attr.h"
#include "iterate/kit/platforms/board.h"
#include "iterate/kit/capabilities/health.h"
#include <sounds_generated.inc>
#include <ctype.h>
#include <string.h>

static i2c_master_bus_handle_t bus;
static const audio_codec_if_t *codec;
static int last_screen = -1;
static char last_status[32];
static struct iterate_kit_screen screen;
EXT_RAM_BSS_ATTR static uint8_t image_buffer[60000];

static bool start(void *context, struct iterate_kit_board_audio *out) {
  (void)context;
  (void)out;
  /* The factory firmware holds these pins across resets. Release them before
   * the shared boot sequence configures the power rails and amplifier. */
  gpio_hold_dis(17);
  gpio_hold_dis(42);
  gpio_hold_dis(46);
  gpio_hold_dis(3);
  const struct iterate_kit_screen_driver display = {
    .width = 400, .height = 300,
    .formats = ITERATE_KIT_SCREEN_MONO1 | ITERATE_KIT_SCREEN_GRAY4,
    .preferred_format = ITERATE_KIT_SCREEN_MONO1, .refresh_timeout_ms = 45000,
    .partial_refresh = true, .submit = note4_display_submit, .state = note4_display_state,
  };
  if (!iterate_kit_screen_init(&screen, &display, image_buffer, sizeof(image_buffer))) return false;
  if (!note4_display_start() || !note4_display_show("HELLO WORLD", "CONNECTING")) return false;
  const i2c_master_bus_config_t config = {.i2c_port = I2C_NUM_0,
    .sda_io_num = 47, .scl_io_num = 48, .clk_source = I2C_CLK_SRC_DEFAULT,
    .glitch_ignore_cnt = 7, .flags.enable_internal_pullup = true};
  if (i2c_new_master_bus(&config, &bus) != ESP_OK) return false;
  iterate_kit_board_i2c_use(bus);
  return true;
}

static enum iterate_kit_status set_volume(uint8_t percent, uint8_t *applied) {
  if (!codec) return ITERATE_KIT_IO_ERROR;
  if (percent > 70) percent = 70;
  if (codec->set_vol(codec, -50.0f + percent * 0.5f) != ESP_CODEC_DEV_OK ||
      codec->mute(codec, percent == 0) != ESP_CODEC_DEV_OK) return ITERATE_KIT_IO_ERROR;
  *applied = percent;
  return ITERATE_KIT_OK;
}

static bool open_codec(void) {
  /* The shared boot sequence has now driven the battery latch high. */
  gpio_hold_en(17);
  audio_codec_i2c_cfg_t control = {.port = I2C_NUM_0, .bus_handle = bus,
    .addr = ES8311_CODEC_DEFAULT_ADDR};
  const audio_codec_ctrl_if_t *ctrl = audio_codec_new_i2c_ctrl(&control);
  const audio_codec_gpio_if_t *gpio = audio_codec_new_gpio();
  if (!ctrl || !gpio) return false;
  es8311_codec_cfg_t config = {.ctrl_if = ctrl, .gpio_if = gpio,
    .codec_mode = ESP_CODEC_DEV_WORK_MODE_BOTH, .pa_pin = -1, .use_mclk = true,
    .hw_gain = {.pa_voltage = 5.0f, .codec_dac_voltage = 3.3f}};
  codec = es8311_codec_new(&config);
  esp_codec_dev_sample_info_t format = {.sample_rate = 16000,
    .channel = 1, .bits_per_sample = 16, .mclk_multiple = 256};
  uint8_t applied;
  if (!codec || codec->set_fs(codec, &format) != ESP_CODEC_DEV_OK ||
      codec->set_mic_gain(codec, 30.0f) != ESP_CODEC_DEV_OK ||
      codec->enable(codec, true) != ESP_CODEC_DEV_OK ||
      set_volume(70, &applied) != ITERATE_KIT_OK) return false;
  int dac_volume = 0, dac_mute = 0, dac_interface = 0;
  if (codec->get_reg(codec, 0x32, &dac_volume) != ESP_CODEC_DEV_OK ||
      codec->get_reg(codec, 0x31, &dac_mute) != ESP_CODEC_DEV_OK ||
      codec->get_reg(codec, 0x09, &dac_interface) != ESP_CODEC_DEV_OK) return false;
  ESP_LOGI("note4", "DAC volume=0x%02x mute=0x%02x interface=0x%02x",
    dac_volume, dac_mute, dac_interface);
  ESP_LOGI("note4", "ES8311 duplex ready; front OK GPIO0 starts/ends conversation");
  return true;
}

static void present(void *context, const struct iterate_kit_voice_view *view) {
  (void)context;
  if (note4_display_failures()) return;
  if (screen.showing_image) { last_screen = -3; return; }
  const char *title = view->fault ? "FAULT" :
    view->screen == ITERATE_KIT_VOICE_SCREEN_IDLE ? "READY" :
    view->screen == ITERATE_KIT_VOICE_SCREEN_LISTENING ? "LISTENING" :
    view->screen == ITERATE_KIT_VOICE_SCREEN_SPEAKING ? "SPEAKING" : "CONNECTING";
  char status[32] = {0};
  const char *message = view->status && *view->status ? view->status : "PRESS OK";
  for (size_t i = 0; message[i] && i < sizeof(status) - 1; ++i)
    status[i] = (char)toupper((unsigned char)message[i]);
  const int screen = view->fault ? -2 : (int)view->screen;
  if (screen == last_screen && strcmp(status, last_status) == 0) return;
  if (!note4_display_show(title, status)) return;
  last_screen = screen;
  memcpy(last_status, status, sizeof(status));
}

static size_t health(void *context, char *out, size_t capacity) {
  (void)context;
  const struct iterate_kit_health_field fields[] = {
    {"displayFailures", note4_display_failures()},
    {"displayUpdates", note4_display_updates()}, {"softwareAec", 0},
    {"screenUploadsStarted", screen.uploads_started},
    {"screenUploadsCompleted", screen.uploads_completed},
    {"screenUploadFailures", screen.upload_failures},
    {"screenBytesReceived", screen.bytes_received},
    {"screenImageShown", screen.showing_image ? 1 : 0},
  };
  return iterate_kit_health_append_fields(out, capacity, fields, sizeof(fields) / sizeof(fields[0]));
}

static size_t modules(void *context, struct iterate_kit_module *out, size_t capacity) {
  (void)context;
  if (!out || !capacity) return 0;
  out[0] = iterate_kit_screen_module(&screen);
  return 1;
}

static const struct iterate_kit_board_ops extra = {
  .start = start, .present = present, .health = health, .modules = modules,
};
static const struct iterate_kit_gpio_step boot[] = {
  {17, 1, 0}, /* Battery power latch. */
  {42, 1, 20}, /* Codec rail. */
  {46, 0, 0}, /* Amplifier, enabled by the shared playback driver. */
  {3, 1, 0}, /* Active-low status LED off. */
};
static const struct iterate_kit_i2s_codec_facts audio = {
  .playback_port = I2S_NUM_0, .capture_port = I2S_NUM_0, .role = I2S_ROLE_MASTER,
  .playback = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(16000),
    /* IDF 5.4's S3 default mask is BOTH even in MONO: RX then returns
     * both slots (32k samples/s). The ES8311's PCM is the left slot. */
    .slot_cfg = {.data_bit_width = I2S_DATA_BIT_WIDTH_16BIT,
      .slot_bit_width = I2S_SLOT_BIT_WIDTH_AUTO, .slot_mode = I2S_SLOT_MODE_MONO,
      .slot_mask = I2S_STD_SLOT_LEFT, .ws_width = 16, .bit_shift = true, .left_align = true},
    .gpio_cfg = {.mclk = 14, .bclk = 15, .ws = 38, .dout = 45, .din = 16},
  },
  .capture = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(16000),
    /* IDF 5.4's S3 default mask is BOTH even in MONO: RX then returns
     * both slots (32k samples/s). The ES8311's PCM is the left slot. */
    .slot_cfg = {.data_bit_width = I2S_DATA_BIT_WIDTH_16BIT,
      .slot_bit_width = I2S_SLOT_BIT_WIDTH_AUTO, .slot_mode = I2S_SLOT_MODE_MONO,
      .slot_mask = I2S_STD_SLOT_LEFT, .ws_width = 16, .bit_shift = true, .left_align = true},
    .gpio_cfg = {.mclk = 14, .bclk = 15, .ws = 38, .dout = 45, .din = 16},
  },
  .dma_frames = 320, .dma_descriptors = 6,
  .playback_shape = {16, 1, 0, -1, 1}, .capture_shape = {16, 1, 0, -1, 1},
  .capture_gain = 1, .amplifier_gpio = 46,
};
static const struct iterate_kit_board board = {
  .facts = {.device_name = "zectrix-note4", .speaker = {.ceiling = 70}},
  .i2c = {.sda = 47, .scl = 48, .hz = 400000},
  .boot = boot, .boot_count = sizeof(boot) / sizeof(boot[0]), .audio = &audio,
  .status_led_gpio = -1, .button = {.gpio = 0, .active_low = true},
  .ring = {.gpio = -1, .power_gpio = -1},
  .sounds = {.wake = sound_chime_press, .wake_bytes = sizeof(sound_chime_press),
    .ended = sound_chime_ended, .ended_bytes = sizeof(sound_chime_ended),
    .no_wifi = sound_offline_no_wifi, .no_wifi_bytes = sizeof(sound_offline_no_wifi),
    .no_internet = sound_offline_no_internet, .no_internet_bytes = sizeof(sound_offline_no_internet),
    .no_iterate = sound_offline_no_iterate, .no_iterate_bytes = sizeof(sound_offline_no_iterate)},
  .open_codec = open_codec, .set_volume = set_volume, .extra = &extra,
};
void app_main(void) { iterate_kit_board_run(&board); }
