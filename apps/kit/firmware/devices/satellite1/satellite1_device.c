/* Hardware facts translated from FutureProofHomes Satellite1-ESPHome
 * config/common/{core_board,speaker,led_ring,buttons}.yaml (MIT).
 * GPIO4 is only ever LOW: HIGH resets XMOS and selects its boot flash.
 */
#include "iterate/kit/devices/satellite1.h"

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "iterate/kit/button.h"
#include "iterate/kit/conversation_overlay.h"
#include "iterate/kit/capabilities/health.h"
#include "iterate/kit/platforms/board.h"
#include "iterate/kit/platforms/pcm5122.h"
#include "iterate/kit/platforms/tas2780.h"
#include "iterate/kit/platforms/xmos_spi.h"

#include "assets/satellite1_sounds_generated.inc"

/* Startup, poll, volume RPC and health all run serially on the app task.
 * No hardware task accesses either control bus or these chip states. */
static struct iterate_kit_xmos_spi xmos = {.cs_gpio = GPIO_NUM_10};
static struct iterate_kit_xmos_version xmos_version;
static struct iterate_kit_tas2780 amp;
static i2c_master_dev_handle_t line_out;
static struct iterate_kit_button volume_up, volume_down;
static bool microphone_muted;
static uint32_t side_button_read_failures;

/** Gate XMOS before hardware tasks can block on its slave clocks, then bring
 * up both chips. board.c has already enabled I2S with TX silence preloaded;
 * TAS2780 activation can now use BCLK for its SAR supply measurements.
 */
static bool iterate_kit_satellite1_open_codec(void) {
  const gpio_config_t cs = {
    .pin_bit_mask = UINT64_C(1) << GPIO_NUM_10,
    .mode = GPIO_MODE_OUTPUT,
    .pull_up_en = GPIO_PULLUP_DISABLE,
    .pull_down_en = GPIO_PULLDOWN_DISABLE,
    .intr_type = GPIO_INTR_DISABLE,
  };
  const spi_bus_config_t bus = {
    .mosi_io_num = 11, .miso_io_num = 13, .sclk_io_num = 12,
    .quadwp_io_num = -1, .quadhd_io_num = -1,
    .max_transfer_sz = 256,
  };
  const spi_device_interface_config_t device = {
    .clock_speed_hz = 8000000, .mode = 3, .spics_io_num = -1,
    .queue_size = 1, /* flags = 0: MSB first, full duplex; driver owns CS. */
  };
  const char *stage = "SPI CS";
  bool bus_open = false;
  i2c_master_dev_handle_t amp_device = NULL;
  if (gpio_set_level(GPIO_NUM_10, 1) != ESP_OK ||
      gpio_config(&cs) != ESP_OK) goto failed;
  stage = "SPI bus";
  /* Every transaction here is at most 8 bytes; with DMA on, the driver copies
   * each stack buffer into internal DMA memory it mallocs per transaction,
   * twice per 25 ms poll, on a board that reserves that memory for Wi-Fi. */
  if (spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_DISABLED) != ESP_OK) goto failed;
  bus_open = true;
  if (spi_bus_add_device(SPI2_HOST, &device, &xmos.device) != ESP_OK) goto failed;
  stage = "XMOS version";
  if (!iterate_kit_xmos_spi_read_version(&xmos, &xmos_version, 6, 250)) goto failed;
  ESP_LOGI("satellite1", "XMOS %u.%u.%u", xmos_version.major,
      xmos_version.minor, xmos_version.patch);
  stage = "I2C devices";
  if (iterate_kit_board_i2c_device(0x3F, &amp_device) != ESP_OK ||
      iterate_kit_board_i2c_device(0x4D, &line_out) != ESP_OK) goto failed;
  stage = "TAS2780 init";
  if (!iterate_kit_tas2780_init(&amp, amp_device)) goto failed;
  stage = "PCM5122 init";
  if (!iterate_kit_pcm5122_init(line_out)) goto failed;
  stage = "TAS2780 activate";
  if (!iterate_kit_tas2780_activate(&amp)) goto failed;
  stage = "PCM5122 unmute";
  if (!iterate_kit_pcm5122_mute(line_out, false)) goto failed;
  return true;

failed:
  ESP_LOGE("satellite1", "%s failed; codec startup refused", stage);
  if (amp.device != NULL && !iterate_kit_tas2780_shutdown(&amp))
    ESP_LOGE("satellite1", "TAS2780 shutdown failed");
  if (line_out != NULL && !iterate_kit_pcm5122_mute(line_out, true))
    ESP_LOGE("satellite1", "PCM5122 mute failed");
  if (line_out != NULL && i2c_master_bus_rm_device(line_out) != ESP_OK)
    ESP_LOGE("satellite1", "PCM5122 detach failed");
  if (amp_device != NULL && i2c_master_bus_rm_device(amp_device) != ESP_OK)
    ESP_LOGE("satellite1", "TAS2780 detach failed");
  if (xmos.device != NULL && spi_bus_remove_device(xmos.device) != ESP_OK)
    ESP_LOGE("satellite1", "SPI detach failed");
  if (bus_open && spi_bus_free(SPI2_HOST) != ESP_OK)
    ESP_LOGE("satellite1", "SPI bus release failed");
  line_out = NULL;
  amp_device = NULL;
  amp.device = NULL;
  amp.initialized = false;
  xmos.device = NULL;
  return false;
}

/** The speaker RPC and side buttons both reach the chip's volume/mute map. */
static enum iterate_kit_status iterate_kit_satellite1_set_volume(
    uint8_t percent, uint8_t *applied) {
  return iterate_kit_tas2780_set_volume(&amp, percent, applied)
      ? ITERATE_KIT_OK : ITERATE_KIT_IO_ERROR;
}

/** Add the hardware mute fact to the shared renderer, after board.c presents.
 * Borrow once for its next refresh; a fault still uses the shared fault chase.
 * Poll clears the overlay on mute transitions before any new volume gesture.
 */
static void iterate_kit_satellite1_present(
    void *context, const struct iterate_kit_voice_view *view) {
  (void)context;
  if (!microphone_muted) return;
  struct iterate_kit_conversation_visual_state state;
  struct iterate_kit_rgb8 pixels[ITERATE_KIT_CONVERSATION_LIGHT_COUNT];
  iterate_kit_voice_view_lights(view, &state);
  state.microphone_muted = true;
  iterate_kit_conversation_lights_animate(
      &state, (uint32_t)(esp_timer_get_time() / 1000), pixels);
  iterate_kit_led_ring_borrow(pixels, 0);
}

/** Read only trustworthy GPIO_IN_A at the shared 25 ms control cadence.
 * A failed read releases both debouncers immediately, clears mute and counts
 * the failure. Bit 1 is the action button's duplicate; GPIO0 owns its grammar.
 */
static void iterate_kit_satellite1_poll(void *context, struct iterate_kit_voice_intent *out) {
  (void)context;
  (void)out;
  uint8_t status[4];
  if (!iterate_kit_xmos_spi_read_status(&xmos, status)) {
    if (side_button_read_failures < UINT32_MAX) ++side_button_read_failures;
    volume_up = (struct iterate_kit_button){0};
    volume_down = (struct iterate_kit_button){0};
    if (microphone_muted) iterate_kit_led_ring_borrow(NULL, 0);
    microphone_muted = false;
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
  if (microphone_muted != muted) iterate_kit_led_ring_borrow(NULL, 0);
  microphone_muted = muted;
  const int step = (int)iterate_kit_button_take_press(&volume_up) -
      (int)iterate_kit_button_take_press(&volume_down);
  if (step == 0) return;
  if (iterate_kit_board_nudge_volume(step * 5) == ITERATE_KIT_OK && microphone_muted) {
    /* A volume gesture still changes the amp while the hardware mic rail is
     * cut, but must never flash a white bar over the mute indication. Both
     * borrows happen on this task before the ring can refresh. */
    iterate_kit_satellite1_present(NULL, iterate_kit_board_view());
  }
}

/** Refresh amplifier faults before appending its fields and the XMOS facts. */
static size_t iterate_kit_satellite1_health(void *context, char *out, size_t capacity) {
  (void)context;
  uint32_t faults;
  (void)iterate_kit_tas2780_read_faults(&amp, &faults); /* failures counted by chip */
  const size_t used = iterate_kit_tas2780_health(&amp, out, capacity);
  if (used == 0U) return 0U;
  const struct iterate_kit_health_field fields[] = {
    {"xmosMajor", xmos_version.major}, {"xmosMinor", xmos_version.minor},
    {"xmosPatch", xmos_version.patch}, {"micMuted", microphone_muted},
    {"sideButtonReadFailures", side_button_read_failures},
  };
  const size_t added = iterate_kit_health_append_fields(
      out + used, capacity - used, fields, sizeof(fields) / sizeof(fields[0]));
  return added == 0U ? 0U : used + added;
}

static const struct iterate_kit_board_ops satellite1_extra = {
  .present = iterate_kit_satellite1_present,
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
  /* MEASURED 2026-09-09 on XMOS 1.0.3: slot 0 carries the microphone
   * (micRawPeak 891 on room noise) and slot 1 is SILENT (peak 2), whatever
   * the source comments say about which tap is which. The uplink is slot 0.
   * There is NO raw microphone tap on this bus, so no diagnostic plane: with
   * slot 1 declared as one, the echo oracle read +45 dB (a dead plane against
   * the AGC'd uplink) and would have sent the next reader chasing a phantom.
   * On this board the self-trigger detector is the transcript of a long
   * answer, not the oracle. Slot 0 is the AGC'd tap, and the HA Voice
   * PE's essay (board/codecs/aic3204.c) measured a x16 make-up gain AFTER an
   * AGC as the thing that fed the provider its own echo; so start at unity
   * and let the bench raise it. */
  .capture_shape = {32, 2, 0, -1, 3},
  .capture_gain = 1,
  .amplifier_gpio = -1,
};

static const struct iterate_kit_board board = {
  .facts = {
    .stream_path = "/agents/voice/satellite1", .client_path = "/clients/satellite1",
    .conversation_id = "sat1dev",
    .greeting = "Hi, I am your Iterate device. What can I do for you?",
    .instructions =
        "FutureProofHomes Satellite1 voice endpoint with XMOS hardware echo cancellation. "
        "conversation.start() and conversation.end() begin and end an open-mic call. "
        "button.press() taps the action button: wake while idle, end while in a call. "
        "speaker.setVolume({percent}) and speaker.volume() answer {percent,ceiling}. "
        "health() returns diagnostics including XMOS version, amplifier supply and faults, "
        "and micMuted, the hardware microphone rail cut. Both echo taps are post-AEC; "
        "echoRawPeak is the AGC tap, not a raw microphone reference.",
    .peer_description =
        "{\"instructions\":\"Satellite1 voice endpoint. The LED ring is its local feedback. "
        "Tap action to start or end a call; speak freely during the call. Vol+ and Vol- "
        "change speaker volume. Hardware mute cuts the microphone rail.\",\"children\":{}}",
    .talk_hint = "speak whenever you like",
    .call_hint = "connection lost — press the action button to call",
    .speaker = {.ceiling = 100}, .speaker_dry_wait_ms = 40,
    .processing_frame_samples = 320, .capture_chunk_samples = 320, .capture_stack_bytes = 4096,
    .turns = ITERATE_KIT_VOICE_TURNS_SERVER_VAD, .radio_before_codec = true,
  },
  .i2c = {.sda = 5, .scl = 6, .hz = 400000},
  .boot = boot, .boot_count = 1,
  /* Chip init owns all scripts; the volume callback owns register 0x1A. */
  .scripts = NULL, .script_count = 0,
  .audio = &audio,
  .volume = {.register_count = 0},
  .ring = {.gpio = 21, .pixels = 24, .order = LED_PIXEL_FORMAT_GRB, .power_gpio = -1},
  .status_led_gpio = 45,
  .button = {.gpio = 0, .active_low = true, .tap_wakes = true, .tap_ends = true},
  .wake_word = "jarvis",
  .sounds = {
    .wake = satellite1_sound_chime_press, .wake_bytes = sizeof(satellite1_sound_chime_press),
    .ended = satellite1_sound_chime_ended, .ended_bytes = sizeof(satellite1_sound_chime_ended),
  },
  .open_codec = iterate_kit_satellite1_open_codec,
  .set_volume = iterate_kit_satellite1_set_volume,
  .extra = &satellite1_extra,
};

void iterate_kit_satellite1_run(void) {
  iterate_kit_board_run(&board);
}
