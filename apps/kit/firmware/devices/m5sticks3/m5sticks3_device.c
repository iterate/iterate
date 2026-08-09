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

#include "iterate/kit/audio_processor.h"
#include "iterate/kit/devices/m5sticks3.h"
#include "iterate/kit/voice/loop.h"
#include "iterate/kit/voice_device_profile.h"

#include "m5sticks3_audio.h"
#include "m5sticks3_board.h"

static bool start(void *context, struct iterate_kit_board_audio *out) {
  (void)context;
  /* M5Unified first, and it fails closed on board identity: a wrong image
   * must not drive another board's pins. */
  if (!m5sticks3_board_init()) return false;
  if (!m5sticks3_audio_init()) return false;
  out->codec = m5sticks3_audio_codec();
  out->processor = iterate_kit_audio_processor_passthrough();
  return true;
}

static void present(
    void *context, const struct iterate_kit_voice_view *view) {
  (void)context;
  /*
   * The setters already compare before marking dirty, so writing all of them
   * every pass costs six compares and repaints nothing. `tick` is the throttled
   * repaint, and this panel is pumped by its caller — there is no LVGL timer
   * behind it — which is why `present` is also the pump.
   */
  m5sticks3_ui_set_state((enum m5sticks3_ui_state)view->screen);
  m5sticks3_ui_set_status(view->status == NULL ? "" : view->status);
  m5sticks3_ui_set_call_active(view->call_active);
  m5sticks3_ui_set_api_ready(view->api_ready);
  m5sticks3_ui_set_stream_ready(view->stream_ready);
  m5sticks3_ui_set_link_ready(view->link_ready);
  if (view->fault) m5sticks3_ui_set_fault();
  m5sticks3_ui_tick();
}

static void poll(void *context, struct iterate_kit_voice_intent *out) {
  (void)context;
  m5sticks3_board_poll();
  /*
   * ONE BUTTON, ONE INTENT. The side button cannot say start and end apart, so
   * it reports a toggle and the loop resolves it against the intent it holds.
   */
  out->toggle_call = m5sticks3_board_take_side_press();
  out->talk_held = m5sticks3_board_talk_held();
}

static void phase(void *context, enum iterate_kit_voice_phase phase_value) {
  (void)context;
  switch (phase_value) {
    case ITERATE_KIT_VOICE_PHASE_ARRIVED:
      m5sticks3_audio_amplifier(true);
      break;
    case ITERATE_KIT_VOICE_PHASE_FEEDING:
      m5sticks3_audio_watch(true);
      break;
    case ITERATE_KIT_VOICE_PHASE_WAITING:
      m5sticks3_audio_watch(false);
      break;
    case ITERATE_KIT_VOICE_PHASE_DRAINING:
      m5sticks3_audio_draining();
      m5sticks3_audio_watch(false);
      break;
    case ITERATE_KIT_VOICE_PHASE_FLUSHED:
      /* Disarm before declaring: the other order records the device's own
       * intentional cut as listener-visible starvation. */
      m5sticks3_audio_watch(false);
      m5sticks3_audio_note_flush();
      break;
    case ITERATE_KIT_VOICE_PHASE_QUIET:
      m5sticks3_audio_amplifier(false);
      break;
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

static enum iterate_kit_status set_volume(
    void *context, uint8_t percent, uint8_t *applied) {
  (void)context;
  return m5sticks3_audio_set_volume(percent, applied);
}

static uint8_t volume(void *context) {
  (void)context;
  return m5sticks3_audio_volume();
}

static size_t health(void *context, char *out, size_t capacity) {
  struct field {
    const char *name;
    uint32_t value;
  };
  const struct field fields[] = {
    {"codecCaptureOverruns", m5sticks3_audio_capture_overruns()},
    {"codecCaptureFailures", m5sticks3_audio_capture_driver_failures()},
    {"codecPlaybackFailures", m5sticks3_audio_playback_driver_failures()},
    /* The task-side starvation measure: ms the ring was empty, and how often. */
    {"spkStarvedMs", m5sticks3_audio_starved_ms()},
    {"spkStarveEvents", m5sticks3_audio_starve_events()},
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
  .capture_meta = NULL,
  /* Providing this pair is how this board declares itself half duplex. */
  .capture_fence = capture_fence,
  .playout_fenced_out = playout_fenced_out,
  /* No avatar: this board's screen is text, and its face has no mouth track. */
  .observe_playout = NULL,
  .observe_answer = NULL,
  .modules = NULL,
  .health = health,
};

static const struct iterate_kit_board_facts facts = {
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
      "conversation.end() hangs up. speaker.setVolume({percent}) sets how loud "
      "it plays, 0-100, and answers {percent,ceiling}, which speaker.volume() "
      "also returns. health() returns this device's full diagnostics "
      "document.\",\"children\":{}}",
  .talk_hint = "hold the front button to talk",
  .call_hint = "connection lost — press side to call",
  .speaker = {
    .context = NULL,
    .set_volume = set_volume,
    .volume = volume,
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
};

void iterate_kit_m5sticks3_run(void) {
  iterate_kit_voice_loop_run(&ops, &facts, NULL);
}
