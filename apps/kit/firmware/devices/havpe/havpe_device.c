/* Home Assistant Voice PE: XMOS hardware AEC, a volume dial, and the table.
 * Cancellation happens before the ESP32 sees PCM, so the microphone stays
 * open and the processor needs no fabricated reference signal.
 */
#include <stdio.h>

#include "driver/gpio.h"

#include "iterate/kit/audio_processor.h"
#include "iterate/kit/capabilities/health.h"
#include "iterate/kit/capabilities/arguments.h"
#include "iterate/kit/voice/loop.h"
#include "iterate/kit/voice_device_profile.h"

#include "iterate/kit/platforms/board.h"
#include "iterate/kit/platforms/aic3204.h"
#include "iterate/kit/platforms/xmos_i2c.h"
#include "esp_log.h"
#include "havpe_ui.h"

/*
 * The baked UI sounds: the wake chime (the official Home Assistant Voice PE
 * press asset and the "call ended" announcement,
 * all 16 kHz mono PCM16LE in .rodata. Included here because the COMPOSITION
 * decides what a gesture sounds like; the audio driver only knows how to
 * play PCM it is handed.
 */
#include "assets/sounds_generated.inc"

static const char tag[] = "havpe";
static i2c_master_dev_handle_t xmos_device;
static uint8_t pipeline_stage[2];

/** Firmware must be exactly 1.3.1 and both selected taps must read back.
 * Enabling slave I2S is nonblocking; no capture/write task runs until this
 * gate succeeds. A dead XMOS therefore faults before a blocking read.
 */
static bool open_codec(void) {
  if (iterate_kit_board_i2c_device(0x42, &xmos_device) != ESP_OK) return false;
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
  return true;
}

/** Separate XMOS slave clock domains: capture ratio 1, playback ratio 3.
 * Keep capture's 320x5 geometry distinct from playback's 480x6 ring.
 */
static const struct iterate_kit_i2s_codec_facts audio_facts = {
  .playback_port = I2S_NUM_0,
  .capture_port = I2S_NUM_1,
  .role = I2S_ROLE_SLAVE,
  .playback = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(48000),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
        I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
    .gpio_cfg = {
      .mclk = I2S_GPIO_UNUSED,
      .bclk = 8,
      .ws = 7,
      .dout = 10,
      .din = I2S_GPIO_UNUSED,
      .invert_flags = {0},
    },
  },
  .capture = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(16000),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
        I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
    .gpio_cfg = {
      .mclk = I2S_GPIO_UNUSED,
      .bclk = 13,
      .ws = 14,
      .dout = I2S_GPIO_UNUSED,
      .din = 15,
      .invert_flags = {0},
    },
  },
  .dma_frames = 480,
  .dma_descriptors = 6,
  .playback_shape = {32, 2, 0, -1, 3},
  .capture_shape = {32, 2, 0, 1, 1},
  /* Fixed x16: the quiet XMOS tap otherwise landed below provider VAD.
   * Saturation is counted. Never duck, ramp or gate it while speaking:
   * those experiments erased nearby speech and made interruption impossible. */
  .capture_gain = 16,
  .amplifier_gpio = 47,
  .amplifier_gated = false,
  .amplifier_settle_ms = 0,
  .capture_dma_frames = 320,
  .capture_dma_descriptors = 5,
};

enum {
  /*
   * One dial count moves the volume 5 percent — the official firmware's
   * `volume_increment: 0.05`, kept so the wheel feels like the same wheel
   * under either firmware.
   */
  DIAL_VOLUME_STEP_PERCENT = 5,
};

static bool start(void *context, struct iterate_kit_board_audio *out) {
  (void)context;
  if (!havpe_ui_init()) return false;
  (void)out;
  return true;
}

/** Sample and present the dial; board.c already retained this view for poll. */
static void present(
    void *context, const struct iterate_kit_voice_view *view) {
  (void)context;
  havpe_ui_present(view);
}

/** The HAVPE dial is always a volume control. */
static void poll(void *context, struct iterate_kit_voice_intent *out) {
  (void)context;
  out->microphone_muted = gpio_get_level(3) != 0;
  const int steps = havpe_ui_take_dial();
  if (steps != 0) (void)iterate_kit_board_nudge_volume(steps * DIAL_VOLUME_STEP_PERCENT);
}

/* --- the XMOS pipeline, as something a person can move and then measure ---- */

/*
 * BOARD-LOCAL ON PURPOSE. Every other capability this device mounts is
 * portable and comes from the loop; this one is a handle on taps only this
 * board has. It exists because measuring cancellation means putting the SAME
 * microphone on both output channels — one raw, one cancelled — which needs a
 * knob rather than a rebuild.
 */
static const char *const aec_set_stage_path[] = {"aec", "setStage"};

static enum capnweb_status aec_set_stage(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct capnweb_value object = {0};
  int64_t channel = 0;
  int64_t stage = 0;
  (void)context;
  if (!iterate_kit_read_object_argument(call, &object) ||
      !iterate_kit_read_int_field(&object, "channel", &channel) ||
      !iterate_kit_read_int_field(&object, "stage", &stage)) {
    return capnweb_reply_set_error(
        reply, "TypeError", "aec.setStage needs {channel, stage}");
  }
  if (channel < 0 || channel > 1 || stage < 0 || stage > 4) {
    return capnweb_reply_set_error(
        reply,
        "RangeError",
        "channel is 0 or 1; stage is 0 none, 1 aec, 2 ic, 3 ns, 4 agc");
  }
  if (iterate_kit_xmos_i2c_configure_pipeline(
          xmos_device, (uint8_t)channel, (enum iterate_kit_xmos_stage)stage) != ESP_OK) {
    return capnweb_reply_set_error(
        reply, "Error", "the XMOS refused the pipeline change");
  }
  pipeline_stage[channel] = (uint8_t)stage;
  iterate_kit_i2s_codec_reset_echo_peaks();
  return capnweb_reply_set_boolean(reply, true);
}

/** Append the XMOS diagnostic control after board.c mounts button.press. */
static size_t modules(
    void *context, struct iterate_kit_module *out, size_t capacity) {
  static const struct iterate_kit_method methods[] = {
    {aec_set_stage_path, 2U, aec_set_stage},
  };
  (void)context;
  if (capacity < 1U) return 0U;
  out[0] = (struct iterate_kit_module){
    .methods = methods,
    .method_count = sizeof(methods) / sizeof(methods[0]),
    .context = NULL,
    .close = NULL,
    .session_ended = NULL,
  };
  return 1U;
}

/*
 * The counters that are this board's hardware rather than the loop's state.
 * Same `,"name":value` shape as the shared table, and the same rule: a field
 * that does not fit returns 0 and the whole stats line is dropped, because a
 * truncated document is not a shorter one.
 */
static size_t health(void *context, char *out, size_t capacity) {
  uint8_t vnr = 0U;
  (void)iterate_kit_xmos_i2c_read_vnr(xmos_device, &vnr);
  const struct iterate_kit_health_field fields[] = {
    /*
     * The DSP's own opinion of the uplink, 0-255, read live from the XMOS.
     * Reads as 0 both in silence and when the read fails; the codec failure
     * counters below say which.
     */
    {"xmosVnr", vnr},
    {"aecUplinkStage", pipeline_stage[0]},
    {"aecDiagnosticStage", pipeline_stage[1]},
  };
  (void)context;
  return iterate_kit_health_append_fields(
      out, capacity, fields, sizeof(fields) / sizeof(fields[0]));
}

static const struct iterate_kit_board_ops ops = {
  .start = start,
  .present = present,
  .poll = poll,
  .modules = modules,
  .health = health,
};

/** Rails off, active-high XMOS reset pulse, then its mandatory 3 s boot.
 * Sending stage commands early can NACK and leave unknown defaults.
 */
static const struct iterate_kit_gpio_step boot[] = {{47, 0, 0}, {4, 1, 1}, {4, 0, 3000}};

static const struct iterate_kit_board board = {
  .facts = {
  .stream_path = "/agents/voice/home-assistant-voice-preview-edition",
  .client_path = "/clients/home-assistant-voice-preview-edition",
  .conversation_id = "havpedev",
  .instructions =
      "Home Assistant Voice Preview Edition: a voice endpoint with no screen — "
      "a twelve-LED ring is its only local feedback. A press on the centre "
      "button WAKES it into a call (chime); saying Jarvis also wakes it. "
      "A tap during the call ends it, and "
      "an ended call — hang-up, tap, or idle timeout — says 'call ended' and "
      "leaves it silent, sending no microphone audio, until the next press. "
      "The rotary dial adjusts speaker volume. The microphone stays open for "
      "the whole call because the XMOS DSP cancels speaker echo. "
      "conversation.start() and conversation.end() begin and end a call. "
      "health() returns this device's full diagnostics — start there when it "
      "seems unwell. "
      "speaker.setVolume({percent}) sets how loud it plays, 0-100, clamped to "
      "a ceiling this board has a measured reason for; speaker.volume() reads "
      "it back. Both answer {percent,ceiling}. "
      "aec.setStage({channel,stage}) moves an XMOS output tap for diagnosis — "
      "stage 0 is the raw microphone, 1 AEC, 2 AEC+IC, 3 AEC+IC+NS, 4 with AGC "
      "— and health() reports echoRawPeak and echoCleanPeak measured while the "
      "speaker was running, which is how its cancellation is measured. "
      "Audio and lifecycle events share this stream connection.",
  /*
   * WHAT THE MODEL IS TOLD IT CAN DO — and it matters more on this board than
   * on any other, because it has NO SCREEN. There is no glanceable state here
   * at all: if the methods are not named, the only way to find out what this
   * device can do is to read its firmware.
   */
  .peer_description =
      "{\"instructions\":\"Home Assistant Voice PE voice endpoint. It has no "
      "screen: its LED ring is the only local feedback. A press on the centre "
      "button wakes it into a call; saying Jarvis also wakes it with a chime. "
      "A tap during the call ends it, and an "
      "ended call leaves it silent until the next press. "
      "conversation.start() / conversation.end() begin and end a call. "
      "aec.setStage({channel,stage}) moves an XMOS output tap — stage 0 is the "
      "raw microphone, 1 AEC, 2 AEC+IC, 3 AEC+IC+NS, 4 with AGC — and health() "
      "reports echoRawPeak and echoCleanPeak accumulated while the speaker was "
      "running, which is how this board's cancellation is measured. "
      "Its rotary dial adjusts speaker volume. The microphone is open for the "
      "whole call because hardware echo cancellation in the XMOS DSP makes it "
      "safe, and the server decides when you have finished speaking. "
      "speaker.setVolume({percent}) sets how loud it plays, 0-100; it clamps "
      "to a ceiling this board has a measured reason for and answers with "
      "{percent,ceiling}, which speaker.volume() also returns. "
      "health() returns this device's full diagnostics "
      "document.\",\"children\":{}}",
  .talk_hint = "speak whenever you like",
  .call_hint = "connection lost — press the centre button to call",
  .speaker = {
    .context = NULL,
    /*
     * 100 is 0 dB here — the loudest setting that neither clips a full-scale
     * sample nor feeds the provider this device's own voice. The clamp lives
     * in the table: full 0, floor -126 half-dB steps.
     */
    .ceiling = 100,
  },
  /* XMOS cancellation makes a continuously open microphone safe. */
  .turns = ITERATE_KIT_VOICE_TURNS_SERVER_VAD,
  /*
   * THE ONLY BOARD THAT ASKS FOR THIS. Its XMOS + AIC3204 bring-up is 6.2 s
   * measured and nothing in the transport needs the codec — only the capture
   * and playback tasks do, and they are created after both. Overlapping the
   * two is very nearly free, because Wi-Fi association plus TLS plus the mount
   * is itself ~6-8 s of waiting.
   */
  .radio_before_codec = true,
  },
  .i2c = {.sda = 5, .scl = 6, .hz = 400000},
  .boot = boot, .boot_count = sizeof(boot) / sizeof(boot[0]),
  .scripts = iterate_kit_aic3204_scripts, .script_count = 2,
  .audio = &audio_facts,
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
  .volume = {.i2c_address = 0x18, .page_register = 0, .page = 0,
    .registers = {0x41, 0x42}, .register_count = 2, .full_code = 0, .floor_code = -126},
  .ring = {.gpio = 21, .pixels = 12, .order = LED_PIXEL_FORMAT_GRB, .power_gpio = 45},
  .status_led_gpio = -1,
  .button = {.gpio = 0, .active_low = true, .tap_wakes = false, .tap_ends = true},
  .wake_word = "jarvis",
  .sounds = {.wake = sound_chime_press, .wake_bytes = sizeof(sound_chime_press),
    .ended = sound_chime_ended, .ended_bytes = sizeof(sound_chime_ended)},
  .open_codec = open_codec,
  .extra = &ops,
};

/** ESP-IDF entry point: run this board through the shared voice loop. */
void app_main(void) {
  iterate_kit_board_run(&board);
}
