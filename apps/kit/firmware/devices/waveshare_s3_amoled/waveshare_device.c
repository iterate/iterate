/* Waveshare's board-owned ES8311 and DMA mouth timing. Full duplex, no
 * AEC reference: push-to-talk remains the echo story. The BSP display owns
 * I2C0 and shared reset lines, so extra->start brings it up before audio.
 */
#include "iterate/kit/platforms/board.h"
#include "driver/i2c_master.h"
#include "driver/i2s_std.h"
#include "esp_codec_dev.h"
#include "esp_codec_dev_defaults.h"
#include "bsp/esp-bsp.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_attr.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

/* Preserve the existing build-time digital-microphone bring-up experiment. */
#ifndef WAVESHARE_AUDIO_DIGITAL_MIC
#define WAVESHARE_AUDIO_DIGITAL_MIC 0
#endif

static const char tag[] = "waveshare";
enum {
  WAVESHARE_AUDIO_SAMPLE_RATE_HZ = 16000,
  WAVESHARE_AUDIO_VOLUME_CEILING = 92,
  WAVESHARE_AUDIO_VOLUME_DEFAULT = 92,
  DMA_DESCRIPTOR_COUNT = 6, DMA_FRAMES_PER_DESCRIPTOR = 240,
  DMA_DESCRIPTOR_MS = 15, DMA_RING_MS = 90, ADDR_ES8311_8BIT = 0x30,
};
static i2c_master_bus_handle_t i2c_bus;
static esp_codec_dev_handle_t codec_dev;

/** The physical pair remains esp_codec_dev's: it reconfigures mono slots
 * on open. Its 240x6 ring is 90 ms; the avatar observes actual descriptors.
 * The shared amplifier gates GPIO46 because its idle noise is audible next
 * to the microphone. 80 ms settle precedes ledger credit: fast burst delivery
 * no longer leaves a prefill delay to settle the analogue path for free.
 */
static const struct iterate_kit_i2s_codec_facts audio_facts = {
  .playback_port = I2S_NUM_0, .capture_port = I2S_NUM_0, .role = I2S_ROLE_MASTER,
  .playback = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(16000),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
    .gpio_cfg = {.mclk = 16, .bclk = 9, .ws = 45, .dout = 8, .din = 10},
  },
  .capture = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(16000),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
    .gpio_cfg = {.mclk = 16, .bclk = 9, .ws = 45, .dout = 8, .din = 10},
  },
  .dma_frames = DMA_FRAMES_PER_DESCRIPTOR, .dma_descriptors = DMA_DESCRIPTOR_COUNT,
  .playback_shape = {16, 1, 0, -1, 1}, .capture_shape = {16, 1, 0, -1, 1},
  .capture_gain = 1,
  .amplifier_gpio = 46, .amplifier_gated = true, .amplifier_settle_ms = 80,
};

/** AXP2101: DC1 main rail and ALDO1 microphone rail, both 3.3 V.
 * The 20 ms settle is before probing the ES8311. All writes are intentional,
 * including rails off before the voltage changes; no read-modify-write.
 */
static const struct iterate_kit_register_write rail_writes[] = {
  {0x22, 0x06}, {0x27, 0x10}, {0x80, 0x01}, {0x90, 0x00}, {0x91, 0x00},
  {0x82, 18}, {0x92, 28}, {0x90, 0x01},
  {0x64, 0x02}, {0x61, 0x02}, {0x62, 0x08}, {0x63, 0x01},
};
static const struct iterate_kit_register_script scripts[] = {
  {.i2c_address = 0x34, .writes = rail_writes,
    .count = sizeof(rail_writes) / sizeof(rail_writes[0]),
    .settle_ms = 20, .when = ITERATE_KIT_SCRIPT_BEFORE_I2S, .timeout_ms = 100},
};

#include <stdio.h>
#include <string.h>

#include "esp_timer.h"

#include "iterate/kit/audio_processor.h"
#include "iterate/kit/capabilities/health.h"
#include "iterate/kit/platforms/i2s_codec.h"
#include "iterate/kit/devices/waveshare_s3_amoled.h"
#include "capnweb/capnweb.h"
#include "iterate/kit/session_grammar.h"
#include "iterate/kit/voice/loop.h"
#include "iterate/kit/voice_device_profile.h"

#include "waveshare_avatar.h"
#include "waveshare_buttons.h"
#include "waveshare_display.h"

/*
 * The baked UI sounds: the wake chime (the official Home Assistant Voice PE
 * press asset, trimmed to its audible body — see assets/make-sounds.py for
 * why an open microphone with no AEC makes the full ring a cost) and the
 * "call ended" announcement, 16 kHz mono PCM16LE in .rodata. Included here
 * because the COMPOSITION decides what a gesture sounds like; the audio
 * driver only knows how to play PCM it is handed.
 */
#include "assets/waveshare_sounds_generated.inc"

/*
 * The session the two buttons speak, and mirrors of the loop's two view
 * facts the grammar classifies against, because `poll` runs before the
 * pass's view exists. The machine is components/core's shared session
 * grammar; this file only wires gestures to it and its answers to the
 * loop's intent seams.
 */
static struct {
  struct iterate_kit_session session;
  bool call_active;
  bool wants_call;
} session_state;

static const struct iterate_kit_audio_codec_properties codec_properties = {
  .capture_sample_rate_hz = WAVESHARE_AUDIO_SAMPLE_RATE_HZ,
  .playback_sample_rate_hz = WAVESHARE_AUDIO_SAMPLE_RATE_HZ,
  .capture_channels = 1,
  .playback_channels = 1,
  .has_reference_channel = false,
  .has_output_gain_control = true,
  .output_gain_ceiling_centi_db = 0,
};

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
  /* PHYSICAL ring occupancy, whatever phase the answer is in: idle silence
   * is written too, so every sent descriptor must be subtracted, and the
   * debt must not be zeroed at FEEDING while the ring still holds up to 90 ms
   * of that silence ahead of the first real frame (review round 2, #4). */
  portENTER_CRITICAL_ISR(&dma_ledger_lock);
  dma_owed_ms -= DMA_DESCRIPTOR_MS;
  if (dma_owed_ms < 0) dma_owed_ms = 0;
  portEXIT_CRITICAL_ISR(&dma_ledger_lock);
  return false;
}

int32_t waveshare_audio_dma_owed_ms(void) {
  return dma_owed_ms;
}

static void phase(void *context, enum iterate_kit_voice_phase phase) {
  (void)context;
  portENTER_CRITICAL(&dma_ledger_lock);
  switch (phase) {
    case ITERATE_KIT_VOICE_PHASE_FEEDING:
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

/** esp_codec_dev owns both channels: one IN_OUT handle, opened once.
 * Table scripts have settled the rails before this post-I2S hook opens the
 * board-owned channels; audio=NULL keeps the shared runner off these pins.
 */
static bool open_codec(void) {
  i2s_chan_handle_t tx = NULL;
  i2s_chan_handle_t rx = NULL;
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
    const i2s_std_config_t std_config = audio_facts.playback;
    const i2s_event_callbacks_t tx_callbacks = {.on_sent = on_dma_sent};
    (void)i2s_channel_register_event_callback(tx, &tx_callbacks, NULL);
    if (i2s_channel_init_std_mode(tx, &std_config) != ESP_OK ||
        i2s_channel_init_std_mode(rx, &std_config) != ESP_OK) return false;
    const int16_t silence[DMA_FRAMES_PER_DESCRIPTOR] = {0};
    for (unsigned i = 0; i < DMA_DESCRIPTOR_COUNT; ++i) {
      size_t loaded = 0;
      if (i2s_channel_preload_data(tx, silence, sizeof(silence), &loaded) != ESP_OK ||
          loaded != sizeof(silence)) return false;
    }
    if (i2s_channel_enable(tx) != ESP_OK ||
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
      /*
       * The amplifier is driven by hand (the table amplifier), not
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
  }
  if (!iterate_kit_i2s_codec_prepare_amplifier(&audio_facts)) return false;
  struct iterate_kit_audio_codec shared_codec;
  if (!iterate_kit_i2s_codec_start_over(
          hardware_read, hardware_write, NULL, DMA_RING_MS, &shared_codec)) {
    ESP_LOGE(tag, "audio hardware task creation failed");
    return false;
  }
  ESP_LOGI(tag, "ES8311 duplex audio ready at 16 kHz");
  return true;
}
/*
 * MEASURED DISTORTION IS THE CEILING HERE, not power or echo: a 1 kHz tone at
 * volume 100 put the 2nd harmonic at -16.8 dB, and at 60 at -34.9 dB. 92 is
 * where the harmonic is still below the noise a listener notices and the
 * device is meaningfully louder than the old 85. Above that it gets louder by
 * getting dirtier, which is not louder.
 */
static enum iterate_kit_status set_volume(
    uint8_t percent, uint8_t *applied) {
  if (codec_dev == NULL) return ITERATE_KIT_UNAVAILABLE;
  if (percent > WAVESHARE_AUDIO_VOLUME_CEILING) {
    percent = WAVESHARE_AUDIO_VOLUME_CEILING;
  }
  if (esp_codec_dev_set_out_vol(codec_dev, (int)percent) !=
      ESP_CODEC_DEV_OK) {
    return ITERATE_KIT_IO_ERROR;
  }
  if (applied != NULL) *applied = percent;
  return ITERATE_KIT_OK;
}

static bool start(void *context, struct iterate_kit_board_audio *out) {
  (void)context;
  /*
   * Display first: its bring-up pulses the board's shared reset lines (the
   * panel, the touch controller and their neighbours hang off one TCA9554),
   * and doing that after the codec is configured would reset the codec.
   */
  if (!waveshare_display_init()) return false;
  if (!iterate_kit_i2s_codec_valid(&audio_facts)) return false;
  i2c_bus = bsp_i2c_get_handle();
  if (i2c_bus == NULL) return false;
  iterate_kit_board_i2c_use(i2c_bus);
  (void)waveshare_buttons_init();
  out->codec = iterate_kit_i2s_codec();
  out->codec.properties = &codec_properties;
  out->processor = iterate_kit_audio_processor_passthrough();
  return true;
}

/*
 * `button.press()` / `button.end()` — the two physical buttons, injectable.
 * They set the same pending latches the fingers do, so the handler path is
 * ONE path and the loop's button audit records both alike.
 */
static const char *const button_press_path[] = {"button", "press"};
static const char *const button_end_path[] = {"button", "end"};

static enum capnweb_status button_press(
    void *context, const struct capnweb_call *call, struct capnweb_reply *reply) {
  (void)context;
  (void)call;
  waveshare_buttons_inject_upper();
  return capnweb_reply_set_boolean(reply, true);
}

static enum capnweb_status button_end(
    void *context, const struct capnweb_call *call, struct capnweb_reply *reply) {
  (void)context;
  (void)call;
  waveshare_buttons_inject_lower();
  return capnweb_reply_set_boolean(reply, true);
}

static size_t modules(
    void *context, struct iterate_kit_module *out, size_t capacity) {
  static const struct iterate_kit_method board_methods[] = {
    {button_press_path, 2U, button_press},
    {button_end_path, 2U, button_end},
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

static void present(
    void *context, const struct iterate_kit_voice_view *view) {
  (void)context;
  /* Mirrored for `poll`, which classifies the session before this pass's
   * view exists — one poll of lag, invisible at the loop's cadence. */
  session_state.call_active = view->call_active;
  session_state.wants_call = view->wants_call;
  waveshare_display_present(view);
  /*
   * Let the face's delay line drain on this task, which is the only one that
   * writes to the analyzer. Without it the last 90ms of every answer would
   * never be animated and the mouth would stop open — see waveshare_avatar.h.
   * It rides `present` because `present` is the once-per-pass call the loop
   * already makes, and a second op for "tick me" would have said nothing the
   * first one does not.
   */
  waveshare_avatar_set_call_active(view->call_active);
  waveshare_avatar_set_listening(view->listening);
  waveshare_avatar_tick();
}

static void poll(void *context, struct iterate_kit_voice_intent *out) {
  (void)context;
  waveshare_buttons_poll();
  /*
   * THE BUTTONS MEAN WHAT THE SESSION SAYS THEY MEAN — the shared grammar
   * in iterate/kit/session_grammar.h, push-to-talk posture. The upper
   * button is both the call control and the talk hold: its press edge wakes
   * from idle (`tap_wakes` — which is also what keeps the injected
   * button.press() a wake, since injection raises only the edge, never the
   * level) and its level is the microphone, but the press must NOT end the
   * session (`tap_ends` false) or every turn would begin by hanging up. The
   * lower button is the dedicated end (`end_press`), the one gesture whose
   * only meaning is hang up. The grammar's chime edges render through the
   * baked sounds: the wake chime (trimmed — the wake gesture opens the
   * microphone on a board with no AEC, see assets/make-sounds.py) and the
   * "call ended" announcement on every session's exit. What the machine
   * fixes over the raw edges: an upper hold begun during the teardown no
   * longer reopens the call the lower button just ended (ENDING absorbs
   * it), and an idle lower press no longer minted a phantom end.
   */
  struct iterate_kit_session_actions actions;
  const struct iterate_kit_session_poll gestures = {
    .tap = waveshare_buttons_take_upper_press(),
    .held = waveshare_buttons_upper_held(),
    .end_press = waveshare_buttons_take_lower_press(),
    .wants_call = session_state.wants_call,
    .call_active = session_state.call_active,
    .push_to_talk = true,
    .tap_wakes = true,
    .tap_ends = false,
    .now_ms = (uint64_t)(esp_timer_get_time() / 1000),
  };
  iterate_kit_session_step(&session_state.session, &gestures, &actions);
  out->start_call = actions.start_call;
  out->end_call = actions.end_call;
  out->talk_held = actions.talk_held;
  /* End before wake: play_sound replaces, so if one poll carries both
   * edges the newer intent — the wake — is the one heard. */
  if (actions.end_chime) {
    iterate_kit_i2s_codec_play_sound(
        waveshare_sound_chime_ended, sizeof(waveshare_sound_chime_ended));
  }
  if (actions.wake_chime) {
    iterate_kit_i2s_codec_play_sound(
        waveshare_sound_chime_press, sizeof(waveshare_sound_chime_press));
  }
}

static void observe_playout(
    void *context, const int16_t *pcm, size_t samples) {
  (void)context;
  /*
   * The mouth, from audio the DAC has accepted rather than audio that
   * arrived. This is the only place on the device where those two are the
   * same thing — see waveshare_avatar.h for what the delay line does with it.
   */
  waveshare_avatar_observe_playout(pcm, samples);
}

static void observe_answer(
    void *context, const struct iterate_kit_voice_answer_note *note) {
  (void)context;
  switch (note->kind) {
    case ITERATE_KIT_VOICE_ANSWER_ADMITTED:
      /* Counted only for frames the playout admitted: the viseme ledger must
       * see exactly the samples the analyzer will eventually be fed. */
      waveshare_avatar_note_accepted(note->answer, note->sample_count);
      break;
    case ITERATE_KIT_VOICE_ANSWER_ABANDONED:
      waveshare_avatar_note_abandoned();
      /*
       * The mouth track dies with the audio it was scheduled against: a mouth
       * saying words nobody will hear is the exact lie this lane exists to
       * avoid. Its intake was unfed for a while — the `viseme` event was
       * deleted before the state that replaced it was wired — and the queue
       * and this reset are the half that survived that gap.
       */
      waveshare_avatar_viseme_reset();
      break;
    case ITERATE_KIT_VOICE_ANSWER_VISEME:
      /*
       * From the processor's runtime bag rather than an event, and in the
       * same coordinates the event used: a 0-14 shape at a sample offset
       * inside `answer`. The queue schedules it against audio the DAC has
       * actually accepted, so a shape whose answer was abandoned above is
       * already gone by the time it would have played.
       */
      waveshare_avatar_note_viseme(
          note->answer, note->offset_samples, note->viseme, note->confidence);
      break;
  }
}

/*
 * The counters that are this board's hardware rather than the loop's
 * state. Same `,"name":value` shape as the shared table, and the same rule: a
 * field that does not fit returns 0 and the whole stats line is dropped,
 * because a truncated document is not a shorter one.
 */
static size_t health(void *context, char *out, size_t capacity) {
  const struct iterate_kit_health_field fields[] = {
    /*
     * Worth publishing because the lower button's I2C read deliberately fails
     * RELEASED, which makes a button that has quietly stopped working look
     * exactly like a user who has stopped pressing it.
     */
    {"lowerReadFailures", waveshare_buttons_lower_read_failures()},
    /*
     * THE FACE, AND THE ONE NUMBER THAT SAYS IT IS ALIVE.
     *
     * `faceFrames` counts completed analysis windows — 100 a second while
     * audio plays. A mouth that has stopped moving is either this number
     * standing still or the audio never arriving, and nothing on the screen
     * tells those apart. The frozen-pose bug was diagnosed from source because
     * there was no counter to look at; there is one now.
     */
    {"faceFrames", waveshare_avatar_frames_analysed()},
    {"faceDropped", waveshare_avatar_dropped_samples()},
    {"faceRenderFails", waveshare_avatar_render_failures()},
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
  /* Full duplex by policy rather than by hardware: see `turns` below. */
  .capture_fence = NULL,
  .playout_fenced_out = NULL,
  .observe_playout = observe_playout,
  .observe_answer = observe_answer,
  /* Speaker, health, conversation control and push-to-talk are the loop's. */
  .modules = modules,
  .health = health,
};

static const struct iterate_kit_board board = {
  .facts = {
  /*
   * Under /agents/voice/ because the conversation's stream IS its agent: the
   * voice half and the thinking half are one identity at one path. A default
   * outside /agents/ gave the device a conversation with no agent behind it.
   * And one per BOARD: while every device defaulted to "/agents/voice/device",
   * three boards on one stream produced two call-started for a single press
   * and an answer that never reached anybody.
   */
  .stream_path = "/agents/voice/waveshare",
  .client_path = "/clients/waveshare",
  .conversation_id = "wsdev",
  .greeting = "Hi, I am your Iterate device. What can I do for you?",
  .instructions =
      "Waveshare AMOLED: a voice endpoint with a touch screen showing a face. "
      "The upper button is push-to-talk; the lower button hangs up. "
      "pushToTalk.start() is the whole gesture: it opens a call if none is up "
      "and holds the microphone open, exactly as pressing the upper button "
      "does; pushToTalk.stop() commits the turn and asks for an answer. It has "
      "no echo cancellation, so it only listens while talk is held. "
      "conversation.start() opens a call WITHOUT holding the microphone, for "
      "when you want it to greet you first; conversation.end() hangs up. "
      "health() returns this device's full diagnostics — start there when it "
      "seems unwell. "
      "speaker.setVolume({percent}) sets how loud it plays, 0-100, clamped to "
      "a ceiling this board has a measured reason for; speaker.volume() reads "
      "it back. Both answer {percent,ceiling}. "
      "Audio and lifecycle events share this stream connection.",
  .peer_description =
      "{\"instructions\":\"Waveshare voice endpoint. "
      "pushToTalk.start() opens a call and holds the microphone open the way "
      "the upper button does, and pushToTalk.stop() commits the turn; "
      "conversation.start() opens a call without holding the microphone and "
      "conversation.end() hangs up. speaker.setVolume({percent}) sets how loud "
      "it plays, 0-100; it clamps to a ceiling this board has a measured "
      "reason for and answers with {percent,ceiling}, which speaker.volume() "
      "also returns. health() returns this device's full diagnostics "
      "document.\",\"children\":{}}",
  .talk_hint = "hold the upper button to talk",
  .call_hint = "press upper to call",
  .speaker = {
    /*
     * TURN IT UP. Every board here shipped at a volume somebody measured once
     * and nobody could change without a reflash, and all four were reported as
     * too quiet. The driver keeps its ceiling; the knob is a call away.
     */
    .context = NULL,
    .ceiling = WAVESHARE_AUDIO_VOLUME_CEILING,
  },
  /*
   * Two thirds of the 90 ms I2S DMA ring (6 descriptors x 240 frames at
   * 16 kHz), so a late frame is absorbed by the hardware cushion rather than
   * concealed, while the remaining third still bounds how long the playback
   * step can sit before the ring genuinely empties.
   */
  .speaker_dry_wait_ms = 60,
  .processing_frame_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  /* This codec hands over one whole 20 ms frame per read, so the bridge's
   * three cadences are all 320 and it degenerates to a pass-through. */
  .capture_chunk_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  .capture_stack_bytes = 4096,
  .turns = ITERATE_KIT_VOICE_TURNS_PUSH_TO_TALK,
  /*
   * The codec first. This board's panel and codec share reset lines, so the
   * order inside `start` is fixed — and its bring-up is fast, so there is
   * nothing for the radio to overlap with.
   */
  .radio_before_codec = false,
  },
  .i2c = {.sda = 15, .scl = 14, .hz = 400000},
  .scripts = scripts, .script_count = sizeof(scripts) / sizeof(scripts[0]),
  /* esp_codec_dev owns the I2S pair. extra supplies the shared mailbox codec;
   * open_codec powers it after the table's rail script. Amplifier facts above
   * are passed to the shared codec without transferring channel ownership. */
  .audio = NULL,
  .ring = {.gpio = -1, .power_gpio = -1},
  .status_led_gpio = -1,
  /* Press-edge upper button plus expander lower button require extra's grammar. */
  .button = {.gpio = -1},
  .sounds = {.wake = waveshare_sound_chime_press, .wake_bytes = sizeof(waveshare_sound_chime_press),
    .ended = waveshare_sound_chime_ended, .ended_bytes = sizeof(waveshare_sound_chime_ended)},
  .open_codec = open_codec,
  .set_volume = set_volume,
  .extra = &ops,
};

void iterate_kit_waveshare_s3_amoled_run(void) {
  iterate_kit_board_run(&board);
}
