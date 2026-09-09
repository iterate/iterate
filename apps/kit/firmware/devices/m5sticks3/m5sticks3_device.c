/*
 * M5StickS3 — what makes this board this board.
 *
 * The program it runs is components/voice/src/voice_loop.c, and it is the same
 * program the other three run. What is left here is the hardware: a 240x135
 * status screen, two buttons, an ES8311, and the one structural novelty this
 * board has — the HALF-DUPLEX FENCE.
 *
 * THE FENCE IS PHYSICS, NOT POLICY. The microphone is the same codec's ADC
 * driven on I2S1, sharing MCLK/BCLK/WS (GPIO 18/17/15) with the I2S0 speaker
 * path — two masters on one set of pins. Capture therefore requires DELETING
 * the playback channel, so the microphone cannot run while the speaker does
 * even if the firmware wanted it to. On a board with no AEC that is the whole
 * echo story, and it is why turns here are push-to-talk.
 *
 * The loop owns the SEQUENCING of that fence (marker on the wire -> speaker
 * queue empty -> pins), because the ordering is a correctness argument rather
 * than a driver detail. This file owns only the asking and the answering.
 */
#include <stdio.h>

#include "esp_timer.h"

#include "iterate/kit/audio_processor.h"
#include "iterate/kit/capabilities/health.h"
#include "iterate/kit/platforms/board.h"
#include "iterate/kit/capabilities/arguments.h"
#include "iterate/kit/devices/m5sticks3.h"
#include "iterate/kit/session_grammar.h"
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
#include "assets/m5sticks3_sounds_generated.inc"

/** The shared grammar driven by this board's distinct button inputs. */
static struct iterate_kit_session session;

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
  m5sticks3_board_inject_side_press();
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
  out->codec = m5sticks3_audio_codec();
  out->processor = iterate_kit_audio_processor_passthrough();
  return true;
}

static void present(
    void *context, const struct iterate_kit_voice_view *view) {
  (void)context;
  m5sticks3_ui_present(view);
  m5sticks3_ui_tick();
}

/** Classify board inputs against the last view held by board.c. */
static void poll(void *context, struct iterate_kit_voice_intent *out) {
  const struct iterate_kit_voice_view *view = iterate_kit_board_view();
  (void)context;
  m5sticks3_board_poll();
  /*
   * THE BUTTONS MEAN WHAT THE SESSION SAYS THEY MEAN — the shared grammar
   * in iterate/kit/session_grammar.h, push-to-talk posture. The side button
   * is the call control, its own button rather than the talk hold, so a
   * bare press WAKES from idle (`tap_wakes`) and ends the session it is in;
   * the front button is the talk hold, and holding it from idle is a wake
   * too. The grammar's chime edges render through the baked sounds — the
   * wake chime and "call ended" — except where the half-duplex fence makes
   * a render physically impossible: a wake by front-hold hands the pins to
   * the microphone in the same breath, so play_sound drops that chime and
   * the hold stays chime-less. What the machine fixes over the old raw
   * toggle: a press or a front-hold during the teardown no longer reopens
   * the call it just ended (ENDING absorbs both), and a session the far end
   * hangs up stays ended under a still-held button.
   */
  struct iterate_kit_session_actions actions;
  const struct iterate_kit_session_poll gestures = {
    .tap = m5sticks3_board_take_side_press(),
    .held = m5sticks3_board_talk_held(),
    .wants_call = view->wants_call,
    .call_active = view->call_active,
    .push_to_talk = true,
    .tap_wakes = true,
    .tap_ends = true,
    .now_ms = (uint64_t)(esp_timer_get_time() / 1000),
  };
  iterate_kit_session_step(&session, &gestures, &actions);
  out->start_call = actions.start_call;
  out->end_call = actions.end_call;
  out->talk_held = actions.talk_held;
  /* End before wake: play_sound replaces, so if one poll carries both
   * edges the newer intent — the wake — is the one heard. */
  if (actions.end_chime) {
    m5sticks3_audio_play_sound(
        m5sticks3_sound_chime_ended, sizeof(m5sticks3_sound_chime_ended));
  }
  if (actions.wake_chime) {
    m5sticks3_audio_play_sound(
        m5sticks3_sound_chime_press, sizeof(m5sticks3_sound_chime_press));
  }
}

static void phase(void *context, enum iterate_kit_voice_phase phase_value) {
  (void)context;
  if (phase_value == ITERATE_KIT_VOICE_PHASE_ARRIVED) {
    m5sticks3_audio_amplifier(true);
  } else if (phase_value == ITERATE_KIT_VOICE_PHASE_QUIET) {
    /* The idle powerdown fires 1.5 s after the last stream write, while
     * "call ended" may still be playing. QUIET repeats each idle pass, so
     * the amp drops on the first pass after the board's own voice finishes. */
    if (!m5sticks3_audio_sound_active()) m5sticks3_audio_amplifier(false);
  }
}

static void capture_fence(void *context, bool microphone_owns_pins) {
  (void)context;
  m5sticks3_audio_set_capture(microphone_owns_pins);
}

static bool playout_fenced_out(void *context) {
  (void)context;
  /* Either the microphone holds the pins, or the handover is still in flight. */
  return m5sticks3_audio_capturing() || m5sticks3_audio_mode_switching();
}

static size_t health(void *context, char *out, size_t capacity) {
  const struct iterate_kit_health_field fields[] = {
    /* The half-duplex fence, this board's one structural novelty. */
    {"audioModeSwitches", m5sticks3_audio_mode_switches()},
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
  .poll = poll,
  .phase = phase,
  .capture_meta = NULL,
  /* Providing this pair is how this board declares itself half duplex. */
  .capture_fence = capture_fence,
  .playout_fenced_out = playout_fenced_out,
  /*
   * The mouth is fed by the AUDIO layer, not from here: the playback task
   * hands each mono frame it wrote to the board's envelope animator, so the
   * face animates audio the hardware actually accepted.
   */
  .observe_playout = NULL,
  .observe_answer = NULL,
  .modules = modules,
  .health = health,
};

/** Native stereo PCM16: 320x6 gives a 120 ms DMA ring. MCLK is present
 * but the codec clocks off BCLK: 0x01=B5, 0x02=18 selects 8xBCLK=256fs.
 * The microphone on I2S1 shares these clocks, so extra deletes/rebuilds TX
 * before M5.Mic can own them; this is deliberately not a duplex declaration.
 */
const struct iterate_kit_i2s_codec_facts m5sticks3_audio_facts = {
  .playback_port = I2S_NUM_0, .capture_port = I2S_NUM_1, .role = I2S_ROLE_MASTER,
  .playback = {
    .clk_cfg = {.sample_rate_hz = 16000, .clk_src = I2S_CLK_SRC_DEFAULT,
      .mclk_multiple = I2S_MCLK_MULTIPLE_128},
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
    .gpio_cfg = {.mclk = 18, .bclk = 17, .ws = 15, .dout = 14, .din = I2S_GPIO_UNUSED},
  },
  .dma_frames = 320, .dma_descriptors = 6,
  .playback_shape = {16, 2, 0, -1, 1},
  .amplifier_gpio = -1,
};

/** M5Unified's sequence except for the measured -18 dB ceiling, 0x9b.
 * Dropping its software mixer but copying its 0 dB DAC made a 75%-scale
 * tone trip brownout. Raising this ceiling needs a physical power proof.
 * Writes fail on the first NACK. The PMIC amplifier is muted by extra.
 */
static const struct iterate_kit_register_write dac_writes[] = {
  {0x00, 0x80}, {0x01, 0xb5}, {0x02, 0x18}, {0x0d, 0x01},
  {0x12, 0x00}, {0x13, 0x10}, {0x32, 0x9b}, {0x37, 0x08},
};
const struct iterate_kit_register_script m5sticks3_audio_script = {
  .i2c_address = 0x18, .writes = dac_writes,
  .count = sizeof(dac_writes) / sizeof(dac_writes[0]),
  .when = ITERATE_KIT_SCRIPT_BEFORE_I2S,
};

static const struct iterate_kit_board board = {
  .facts = {
  .stream_path = "/agents/voice/m5stick-s3",
  .client_path = "/clients/m5stick-s3",
  .conversation_id = "stickdev",
  .greeting = "Hi, I am your Iterate device. What can I do for you?",
  .instructions =
      "M5StickS3: a small voice endpoint with a text status screen. "
      "The front button is push-to-talk; the side button starts and ends a "
      "call. pushToTalk.start() is the whole gesture: it opens a call if none "
      "is up and holds the microphone open, exactly as holding the front "
      "button does; pushToTalk.stop() commits the turn and asks for an answer. "
      "It has no echo cancellation and its microphone and speaker share pins, "
      "so it only listens while talk is held. "
      "conversation.start() opens a call WITHOUT holding the microphone, for "
      "when you want it to greet you first; conversation.end() hangs up. "
      "face.set({face}) changes which animated face it wears; the catalogue "
      "is dot-matrix-oracle, furnace-imp, karakuri-brass, moonscope, "
      "starbyte. "
      "health() returns this device's full diagnostics — start there when it "
      "seems unwell. "
      "speaker.setVolume({percent}) sets how loud it plays, 0-100; "
      "speaker.volume() reads it back. Both answer {percent,ceiling}. "
      "Audio and lifecycle events share this stream connection.",
  .peer_description =
      "{\"instructions\":\"M5StickS3 voice endpoint. "
      "pushToTalk.start() opens a call and holds the microphone open the way "
      "the front button does, and pushToTalk.stop() commits the turn; "
      "conversation.start() opens a call without holding the microphone and "
      "conversation.end() hangs up. face.set({face}) changes which animated "
      "face it wears; the catalogue is dot-matrix-oracle, furnace-imp, "
      "karakuri-brass, moonscope, starbyte. speaker.setVolume({percent}) sets "
      "how loud it plays, 0-100, and answers {percent,ceiling}, which "
      "speaker.volume() also returns. health() returns this device's full "
      "diagnostics document.\",\"children\":{}}",
  .talk_hint = "hold the front button to talk",
  .call_hint = "connection lost — press side to call",
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
  .processing_frame_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  /* This codec hands over one whole 20 ms frame per read, so the bridge's
   * three cadences are all 320 and it degenerates to a pass-through. */
  .capture_chunk_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  .capture_stack_bytes = 4096,
  .turns = ITERATE_KIT_VOICE_TURNS_PUSH_TO_TALK,
  .radio_before_codec = false,
  },
  .i2c = {.sda = 47, .scl = 48, .hz = 100000},
  .scripts = &m5sticks3_audio_script, .script_count = 1,
  .audio = NULL, /* M5.Mic and the fence own capture; only TX uses the facts above. */
  .volume = {.i2c_address = 0x18, .page_register = 0xff, .registers = {0x32},
    .register_count = 1, .full_code = 0x9b, .floor_code = 0},
  .ring = {.gpio = -1, .power_gpio = -1},
  .status_led_gpio = -1,
  .button = {.gpio = -1}, /* M5's debounced side press and front hold are distinct. */
  .sounds = {.wake = m5sticks3_sound_chime_press, .wake_bytes = sizeof(m5sticks3_sound_chime_press),
    .ended = m5sticks3_sound_chime_ended, .ended_bytes = sizeof(m5sticks3_sound_chime_ended)},
  .open_codec = m5sticks3_audio_init,
  .extra = &ops,
};

void iterate_kit_m5sticks3_run(void) {
  iterate_kit_board_run(&board);
}
