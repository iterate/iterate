/*
 * Home Assistant Voice Preview Edition — what makes this board this board.
 *
 * The program it runs is components/voice/src/voice_loop.c, and it is the same
 * program the other three run. What is left here is the hardware: a 12-pixel
 * WS2812 ring that is the ENTIRE display, one centre button, an always-on
 * speaker rail, and an XMOS DSP doing echo cancellation in silicon.
 *
 * Turn taking is the PROVIDER'S, and that is a consequence of the XMOS rather
 * than a preference. This board is genuinely full duplex, so its microphone
 * stays open for the whole call and server VAD decides where turns end. It was
 * push-to-talk until somebody tried to talk to it: the call came up, the ring
 * showed one dim pixel meaning "call up, nobody listening", and speaking did
 * nothing, because the microphone only opened while a finger held the button.
 * Push-to-talk's rationale is the echo story on boards WITHOUT cancellation,
 * and this is the one board that has it in hardware.
 *
 * ITS XMOS AEC GETS NO VTABLE ENTRY, deliberately. Cancellation has already
 * happened by the time a sample reaches the ESP32, so the composition is
 * `audio_processor_passthrough` plus the codec's own
 * `capture_is_echo_cancelled` property — the two facts the loop needs, both
 * already expressible. A board op would have been a third spelling of them.
 *
 * `aec.setStage` IS here, because it is not the canceller: it is a handle on
 * the XMOS output taps, and it exists because an echo canceller cannot be
 * argued about, only measured — which means putting the SAME microphone on
 * both output channels, one raw and one cancelled, without a rebuild.
 *
 * Opening the USB console resets this board, which is why `health()` exists
 * and why the stats line is the instrument of record. There is no screen to
 * read anything off: if a method is not named in `instructions`, the only way
 * to find out this device can do it is to read this file.
 */
#include <stdio.h>

#include "iterate/kit/audio_processor.h"
#include "iterate/kit/capabilities/arguments.h"
#include "iterate/kit/devices/havpe.h"
#include "iterate/kit/voice/loop.h"
#include "iterate/kit/voice_device_profile.h"

#include "havpe_audio.h"
#include "havpe_ui.h"

/*
 * THE RING FIRST, THEN THE CODEC, AND THE RADIO BETWEEN THEM.
 *
 * `facts.radio_before_codec` defers this whole call until after the transport
 * has started, which is the point: the XMOS boot plus the AIC3204's mandatory
 * analogue soft-start is 6.2 s measured, and it used to run to completion
 * before Wi-Fi was even started, so two waits ran back to back for no reason
 * and this board reached a ready mount at ~14 s where the others managed ~8.
 *
 * Inside, the ring is raised BEFORE the codec, and that ordering is this
 * file's to keep: `transport_start` only configures Wi-Fi and spawns the
 * network task — association happens in the background — so it returns in
 * milliseconds, and the ring is therefore lit within milliseconds of where it
 * used to be, with the 6.2 s spent behind an already-lit ring rather than a
 * dark one. Doing it the other way round would leave this board's only display
 * dark for the whole of its longest bring-up step.
 */
static bool start(void *context, struct iterate_kit_board_audio *out) {
  (void)context;
  if (!havpe_ui_init()) return false;
  if (!havpe_audio_init()) return false;
  out->codec = havpe_audio_codec();
  /*
   * PASSTHROUGH, because the cancellation already happened. What arrives at
   * the ESP32 is the XMOS's echo-cancelled output; the codec advertises that
   * through its own properties, and running a second canceller over it would
   * adapt against a signal whose echo is already gone.
   */
  out->processor = iterate_kit_audio_processor_passthrough();
  return true;
}

static void present(
    void *context, const struct iterate_kit_voice_view *view) {
  (void)context;
  havpe_ui_set_state((enum havpe_ui_state)view->screen);
  havpe_ui_set_status(view->status == NULL ? "" : view->status);
  havpe_ui_set_call_active(view->call_active);
  havpe_ui_set_api_ready(view->api_ready);
  havpe_ui_set_stream_ready(view->stream_ready);
  havpe_ui_set_link_ready(view->link_ready);
  /*
   * THE ONE THING THIS RING SAYS THAT NOTHING ELSE CAN. The microphone sector
   * meters this so a person can SEE the device hearing them; with no screen
   * there is no other way to tell listening from deaf.
   */
  havpe_ui_set_microphone_peak(view->microphone_peak);
  if (view->fault) havpe_ui_set_fault();
  /* This ring has no timer behind it: `present` is also its pump. */
  havpe_ui_tick();
}

static void poll(void *context, struct iterate_kit_voice_intent *out) {
  (void)context;
  havpe_button_poll();
  /*
   * ONE BUTTON, ONE INTENT. A tap toggles whether a call is wanted, and the
   * loop resolves the toggle against the intent it holds.
   *
   * The HOLD gesture is still classified by the poller and deliberately not
   * reported: with the microphone open for the whole call there is no turn to
   * hold. What matters is that a long press is still NOT a tap, so leaning on
   * the button cannot hang up.
   */
  out->toggle_call = havpe_button_take_tap();
}

static void phase(void *context, enum iterate_kit_voice_phase phase_value) {
  (void)context;
  switch (phase_value) {
    case ITERATE_KIT_VOICE_PHASE_ARRIVED:
    case ITERATE_KIT_VOICE_PHASE_QUIET:
      /*
       * NO AMPLIFIER TO GATE. The speaker rail stays up for the life of the
       * boot because the XMOS's AEC reference rides the always-running TX
       * stream — cutting the rail between answers would take the canceller's
       * reference with it. See havpe_audio_init().
       */
      break;
    case ITERATE_KIT_VOICE_PHASE_FEEDING:
      havpe_audio_watch(true);
      break;
    case ITERATE_KIT_VOICE_PHASE_WAITING:
      havpe_audio_watch(false);
      break;
    case ITERATE_KIT_VOICE_PHASE_DRAINING:
      havpe_audio_draining();
      havpe_audio_watch(false);
      break;
    case ITERATE_KIT_VOICE_PHASE_FLUSHED:
      /* Disarm before declaring: the other order records the device's own
       * intentional cut as listener-visible starvation. */
      havpe_audio_watch(false);
      havpe_audio_note_flush();
      break;
  }
}

static enum iterate_kit_status set_volume(
    void *context, uint8_t percent, uint8_t *applied) {
  (void)context;
  return havpe_audio_set_volume(percent, applied);
}

static uint8_t volume(void *context) {
  (void)context;
  return havpe_audio_volume();
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
  if (havpe_audio_set_pipeline_stage((uint8_t)channel, (uint8_t)stage) !=
      ITERATE_KIT_OK) {
    return capnweb_reply_set_error(
        reply, "Error", "the XMOS refused the pipeline change");
  }
  return capnweb_reply_set_boolean(reply, true);
}

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
  struct field {
    const char *name;
    uint32_t value;
  };
  const struct field fields[] = {
    {"codecCaptureOverruns", havpe_audio_capture_overruns()},
    {"codecCaptureFailures", havpe_audio_capture_driver_failures()},
    /* The task-side starvation measure: ms the ring was empty, and how often. */
    {"spkStarvedMs", havpe_audio_starved_ms()},
    {"spkStarveEvents", havpe_audio_starve_events()},
    {"codecPlaybackFailures", havpe_audio_playback_driver_failures()},
    {"captureGainClipped", havpe_audio_capture_gain_clipped()},
    /*
     * THE AEC ORACLE. cleanPeak/rawPeak measured WHILE THE SPEAKER WAS RUNNING
     * is the cancellation, and it is the only form of the claim that can be
     * checked: the same DSP with both taps exposed, one raw and one cancelled,
     * moved by aec.setStage above.
     */
    {"captureGain", havpe_audio_capture_gain()},
    {"micRawPeak", havpe_audio_capture_raw_peak()},
    {"micCleanPeak", havpe_audio_capture_clean_peak()},
    {"speakerPlaying", havpe_audio_speaker_is_playing() ? 1U : 0U},
    {"aecUplinkStage", havpe_audio_pipeline_stage(0U)},
    {"aecDiagnosticStage", havpe_audio_pipeline_stage(1U)},
    {"echoRawPeak", havpe_audio_capture_echo_raw_peak()},
    {"echoCleanPeak", havpe_audio_capture_echo_clean_peak()},
    /* Driver-level DMA overflows: the slave buses' own loss signals. */
    {"captureQueueOverflows", havpe_audio_capture_queue_overflows()},
    {"playbackQueueOverflows", havpe_audio_playback_queue_overflows()},
    /*
     * Echo this device declined to SEND, and the driver's own copy of the
     * gate that decided. Distinct from the loop's `bargeInsRejected`, which
     * refuses a provider's claim; this one refuses a frame.
     */
    {"echoFramesMuted", havpe_audio_echo_frames_muted()},
    {"gateAdmitted", havpe_audio_barge_in_admitted()},
    {"gateRefused", havpe_audio_barge_in_refused()},
    {"gateLoudestRefused", havpe_audio_loudest_refused()},
  };
  size_t used = 0U;
  size_t index;
  (void)context;
  for (index = 0U; index < sizeof(fields) / sizeof(fields[0]); index++) {
    const int written = snprintf(
        out + used,
        capacity - used,
        ",\"%s\":%u",
        fields[index].name,
        (unsigned int)fields[index].value);
    if (written <= 0 || (size_t)written >= capacity - used) return 0U;
    used += (size_t)written;
  }
  return used;
}

static const struct iterate_kit_board_ops ops = {
  .start = start,
  .present = present,
  .poll = poll,
  .phase = phase,
  /* No bridge metadata: this codec hands over whole wire frames, so the loop
   * synthesises the timeline. See `capture_chunk_samples`. */
  .capture_meta = NULL,
  /* Full duplex in silicon: no fence, and nothing to wait for. */
  .capture_fence = NULL,
  .playout_fenced_out = NULL,
  /* No face and no mouth track; the ring's speaking cue is the view's. */
  .observe_playout = NULL,
  .observe_answer = NULL,
  .modules = modules,
  .health = health,
};

static const struct iterate_kit_board_facts facts = {
  .stream_path = "/agents/voice/home-assistant-voice-preview-edition",
  .client_path = "/clients/home-assistant-voice-preview-edition",
  .conversation_id = "havpedev",
  .greeting = "Hi, I am your Iterate device. What can I do for you?",
  .instructions =
      "Home Assistant Voice Preview Edition: a voice endpoint with no screen — "
      "a twelve-LED ring is its only local feedback. A tap on the centre "
      "button starts and ends the call. Its microphone stays OPEN throughout: "
      "it has hardware echo cancellation in an XMOS DSP, so it can be "
      "interrupted and there is no push-to-talk. "
      "conversation.start() and conversation.end() begin and end a call. "
      "health() returns this device's full diagnostics, the same document it "
      "pushes as dev-stats — start there when it seems unwell. "
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
      "screen: its LED ring is the only local feedback. A short tap on the "
      "centre button starts and ends the call. "
      "conversation.start() / conversation.end() begin and end a call. "
      "aec.setStage({channel,stage}) moves an XMOS output tap — stage 0 is the "
      "raw microphone, 1 AEC, 2 AEC+IC, 3 AEC+IC+NS, 4 with AGC — and health() "
      "reports echoRawPeak and echoCleanPeak accumulated while the speaker was "
      "running, which is how this board's cancellation is measured. "
      "There is no push-to-talk: this board has hardware echo cancellation in "
      "its XMOS DSP, so its microphone is open for the whole call and the "
      "provider's server VAD decides when you have finished speaking. "
      "speaker.setVolume({percent}) sets how loud it plays, 0-100; it clamps "
      "to a ceiling this board has a measured reason for and answers with "
      "{percent,ceiling}, which speaker.volume() also returns. "
      "health() returns the same diagnostics document the device pushes "
      "as dev-stats.\",\"children\":{}}",
  /*
   * THE TURN POLICY, SAID OUT LOUD. This read "hold the button to talk" on a
   * board that had stopped implementing push-to-talk months earlier — the
   * sentence is not decoration, it is the policy, and it was lying.
   */
  .talk_hint = "speak whenever you like",
  .call_hint = "connection lost — press the centre button to call",
  .speaker = {
    .context = NULL,
    .set_volume = set_volume,
    .volume = volume,
    /*
     * 100 is 0 dB here — the loudest setting that neither clips a full-scale
     * sample nor feeds the provider this device's own voice. The clamp lives
     * in the driver; see havpe_audio.h.
     */
    .ceiling = 100,
  },
  /*
   * Two thirds of the 60 ms I2S TX DMA ring (6 descriptors x 480 frames at
   * 48 kHz), so a late frame is absorbed by the hardware cushion rather than
   * concealed, while the remaining third still bounds how long the playback
   * step can sit before the ring genuinely empties.
   */
  .speaker_dry_wait_ms = 40,
  .processing_frame_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  /* This codec hands over one whole 20 ms frame per read, so the bridge's
   * three cadences are all 320 and it degenerates to a pass-through. */
  .capture_chunk_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  .capture_stack_bytes = 4096,
  /*
   * The provider's, because the XMOS makes it safe. Requesting the manual
   * default here produced an accepted call and a deaf assistant.
   */
  .turns = ITERATE_KIT_VOICE_TURNS_SERVER_VAD,
  /*
   * THE ONLY BOARD THAT ASKS FOR THIS. Its XMOS + AIC3204 bring-up is 6.2 s
   * measured and nothing in the transport needs the codec — only the capture
   * and playback tasks do, and they are created after both. Overlapping the
   * two is very nearly free, because Wi-Fi association plus TLS plus the mount
   * is itself ~6-8 s of waiting.
   */
  .radio_before_codec = true,
};

void iterate_kit_havpe_run(void) {
  iterate_kit_voice_loop_run(&ops, &facts, NULL);
}
