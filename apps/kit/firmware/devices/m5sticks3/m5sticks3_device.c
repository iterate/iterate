/*
 * M5StickS3 — what makes this board this board.
 *
 * The program it runs is components/voice/src/voice_loop.c, and it is the same
 * program the other three run. What is left here is the hardware: a 240x135
 * status screen, two buttons and an ES8311. This file owns hardware setup;
 * the shared loop owns call lifetime and continuous capture.
 */
#include <stdio.h>

#include "iterate/kit/audio_processor.h"
#include "iterate/kit/capabilities/health.h"
#include "iterate/kit/platforms/board.h"
#include "iterate/kit/capabilities/arguments.h"
#include "iterate/kit/voice/loop.h"
#include "iterate/kit/voice_device_profile.h"

#include "m5sticks3_audio.h"
#include "m5sticks3_board.h"

/*
 * The baked UI sounds: the wake chime (the official Home Assistant Voice PE
 * press asset) and the "call ended" announcement, 16 kHz mono PCM16LE in
 * .rodata. Included here because the COMPOSITION decides what a gesture
 * sounds like; the audio driver only knows how to play PCM it is handed.
 */
#include "assets/sounds_generated.inc"

/*
 * `face.set({face})` — the same catalogue the CoreS3 wears, on the small
 * panel. There is no local face control at all on this board, so a face
 * nobody can ask for by name is a face it never makes.
 */
static const char *const button_press_path[] = {"button", "press"};

static enum capnweb_status button_press(
    void *context, const struct capnweb_call *call, struct capnweb_reply *reply) {
  (void)context;
  (void)call;
  m5sticks3_board_inject_call_press();
  return capnweb_reply_set_boolean(reply, true);
}

static const char *const face_set_path[] = {"face", "set"};

static enum capnweb_status face_set(
    void *context,
    const struct capnweb_call *call,
    struct capnweb_reply *reply) {
  struct capnweb_value object = {0};
  struct capnweb_value slug = {0};
  char buffer[48];
  size_t length = 0U;
  (void)context;
  if (!iterate_kit_read_object_argument(call, &object) ||
      !capnweb_value_object_get(&object, "face", &slug) ||
      capnweb_value_copy_string(&slug, buffer, sizeof(buffer), &length) !=
          CAPNWEB_OK) {
    return capnweb_reply_set_error(
        reply, "TypeError", "face.set needs {face} as a catalogue slug");
  }
  if (!m5sticks3_board_request_face(buffer, length)) {
    return capnweb_reply_set_error(
        reply,
        "Error",
        "unknown face — the catalogue is dot-matrix-oracle, furnace-imp, "
        "karakuri-brass, moonscope, starbyte");
  }
  return capnweb_reply_set_boolean(reply, true);
}

static size_t modules(
    void *context, struct iterate_kit_module *out, size_t capacity) {
  static const struct iterate_kit_method board_methods[] = {
    {button_press_path, 2U, button_press},
    {face_set_path, 2U, face_set},
  };
  (void)context;
  if (capacity < 1U) return 0U;
  out[0] = (struct iterate_kit_module){
    .methods = board_methods,
    .method_count = sizeof(board_methods) / sizeof(board_methods[0]),
    .context = NULL,
    .close = NULL,
    .session_ended = NULL,
  };
  return 1U;
}

static bool start(void *context, struct iterate_kit_board_audio *out) {
  (void)context;
  /* M5Unified first, and it fails closed on board identity: a wrong image
   * must not drive another board's pins. */
  if (!m5sticks3_board_init()) return false;
  if (!m5sticks3_audio_prepare()) return false;
  out->processor = iterate_kit_audio_processor_passthrough();
  return true;
}

/** Present and tick the face; board.c already retained this view for poll. */
static void present(
    void *context, const struct iterate_kit_voice_view *view) {
  (void)context;
  m5sticks3_ui_present(view);
  m5sticks3_ui_tick();
}

/** Supply either debounced physical M5 button as one session press. */
static void read_gestures(struct iterate_kit_board_gestures *out) {
  m5sticks3_board_poll();
  out->pressed |= m5sticks3_board_take_call_press();
}

static void phase(void *context, enum iterate_kit_voice_phase phase_value) {
  (void)context;
  if (phase_value == ITERATE_KIT_VOICE_PHASE_ARRIVED) {
    m5sticks3_audio_amplifier(true);
  } else if (phase_value == ITERATE_KIT_VOICE_PHASE_QUIET) {
    if (!iterate_kit_i2s_codec_sound_active()) m5sticks3_audio_amplifier(false);
  }
}

static size_t health(void *context, char *out, size_t capacity) {
  const struct iterate_kit_health_field fields[] = {
    /*
     * The face, counted rather than eyeballed. A face is the one part of this
     * device a person judges by eye, which makes it the easiest thing to
     * believe is working when it is not.
     */
    {"faceFrames", m5sticks3_board_face_frames()},
    {"faceFailures", m5sticks3_board_face_failures()},
  };
  (void)context;
  return iterate_kit_health_append_fields(
      out, capacity, fields, sizeof(fields) / sizeof(fields[0]));
}

static const struct iterate_kit_board_ops ops = {
  .start = start,
  .present = present,
  .phase = phase,
  .modules = modules,
  .health = health,
};

/** One native stereo PCM16 bus, owned by one ESP I2S controller. ES8311
 * clocks from BCLK (0x01=B5, 0x02=18), while MCLK remains physically routed.
 * ADCDAT is the right slot, matching M5Unified's prior microphone config.
 * This concurrent ADC/DAC configuration needs bench capture/playout
 * qualification; compiling it is not acoustic proof.
 */
const struct iterate_kit_i2s_codec_facts m5sticks3_audio_facts = {
  .playback_port = I2S_NUM_0, .capture_port = I2S_NUM_0, .role = I2S_ROLE_MASTER,
  .playback = {
    .clk_cfg = {.sample_rate_hz = 16000, .clk_src = I2S_CLK_SRC_DEFAULT,
      .mclk_multiple = I2S_MCLK_MULTIPLE_128},
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
    .gpio_cfg = {.mclk = 18, .bclk = 17, .ws = 15, .dout = 14, .din = 16},
  },
  .capture = {
    .clk_cfg = {.sample_rate_hz = 16000, .clk_src = I2S_CLK_SRC_DEFAULT,
      .mclk_multiple = I2S_MCLK_MULTIPLE_128},
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
    .gpio_cfg = {.mclk = 18, .bclk = 17, .ws = 15, .dout = 14, .din = 16},
  },
  .dma_frames = 320, .dma_descriptors = 6,
  .playback_shape = {16, 2, 0, -1, 1}, .capture_shape = {16, 2, 1, -1, 1},
  .capture_gain = 1,
  .amplifier_gpio = -1,
};

/** M5Unified's sequence except for the measured -18 dB ceiling, 0x9b.
 * Dropping its software mixer but copying its 0 dB DAC made a 75%-scale
 * tone trip brownout. Raising this ceiling needs a physical power proof.
 * Writes fail on the first NACK. The PMIC amplifier is muted by extra.
 */
static const struct iterate_kit_register_write codec_writes[] = {
  {0x00, 0x80}, {0x01, 0xb5}, {0x02, 0x18}, {0x0d, 0x01},
  {0x0e, 0x02}, {0x12, 0x00}, {0x13, 0x10},
  {0x14, 0x10}, {0x17, 0xff}, {0x1c, 0x6a},
  {0x32, 0x9b}, {0x37, 0x08},
};
const struct iterate_kit_register_script m5sticks3_audio_script = {
  .i2c_address = 0x18, .writes = codec_writes,
  .count = sizeof(codec_writes) / sizeof(codec_writes[0]),
  .when = ITERATE_KIT_SCRIPT_BEFORE_I2S,
};

static const struct iterate_kit_board board = {
  .facts = {
  .device_name = "m5stick-s3",
  .speaker = {
    .context = NULL,
    /*
     * 100 means this capability advertises no clamp, not that the board plays
     * at full scale: the ceiling here is a brownout limit and lives inside the
     * driver, where 100 is -18 dB rather than 0. See m5sticks3_audio.h.
     */
    .ceiling = 100,
  },
  /*
   * Two thirds of the 120 ms I2S DMA ring (6 descriptors x 320 frames at
   * 16 kHz), so a late frame is absorbed by the hardware cushion rather than
   * concealed, while the remaining third still bounds how long the playback
   * step can sit before the ring genuinely empties.
   */
  .speaker_dry_wait_ms = 80,
  },
  .i2c = {.sda = 47, .scl = 48, .hz = 100000},
  .scripts = &m5sticks3_audio_script, .script_count = 1,
  .audio = &m5sticks3_audio_facts,
  .volume = {.i2c_address = 0x18, .page_register = 0xff, .registers = {0x32},
    .register_count = 1, .full_code = 0x9b, .floor_code = 0},
  .ring = {.gpio = -1, .power_gpio = -1},
  .status_led_gpio = -1,
  .button = {.gpio = -1},
  .read_gestures = read_gestures,
  .sounds = {.wake = sound_chime_press, .wake_bytes = sizeof(sound_chime_press),
    .ended = sound_chime_ended, .ended_bytes = sizeof(sound_chime_ended)},
  .play_sound = m5sticks3_audio_play_sound,
  .extra = &ops,
};

/** ESP-IDF entry point: run this board through the shared voice loop. */
void app_main(void) {
  iterate_kit_board_run(&board);
}
