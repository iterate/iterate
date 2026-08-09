/*
 * Waveshare ESP32-S3 Touch AMOLED 1.8 — what makes this board this board.
 *
 * The program it runs is components/voice/src/voice_loop.c, and it is the same
 * program the other three run. What is left here is the hardware: an AMOLED
 * panel with a face on it, two buttons, an ES8311 with a class-D amplifier
 * whose DMA ring this file accounts for, and the twelve health counters those
 * three produce.
 *
 * Turn taking is MANUAL: no VAD anywhere. BOOT toggles the call, PWR is held
 * while speaking. That is a FACT below rather than code, but the reason is
 * physical and belongs with the hardware: this board has no AEC reference, so
 * the only way the speaker is never live into an open microphone is for the
 * microphone to be shut unless somebody is holding it open.
 *
 * Opening the USB console resets this board, which is why `health()` exists
 * and why the stats line is the instrument of record.
 */
#include <stdio.h>
#include <string.h>

#include "iterate/kit/audio_processor.h"
#include "iterate/kit/devices/waveshare_s3_amoled.h"
#include "iterate/kit/voice/loop.h"
#include "iterate/kit/voice_device_profile.h"

#include "waveshare_audio.h"
#include "waveshare_avatar.h"
#include "waveshare_buttons.h"
#include "waveshare_display.h"

static bool start(void *context, struct iterate_kit_board_audio *out) {
  (void)context;
  /*
   * Display first: its bring-up pulses the board's shared reset lines (the
   * panel, the touch controller and their neighbours hang off one TCA9554),
   * and doing that after the codec is configured would reset the codec.
   */
  if (!waveshare_display_init()) return false;
  if (!waveshare_audio_init()) return false;
  (void)waveshare_buttons_init();
  out->codec = waveshare_audio_codec();
  out->processor = iterate_kit_audio_processor_passthrough();
  return true;
}

static void present(
    void *context, const struct iterate_kit_voice_view *view) {
  (void)context;
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
   * TWO BUTTONS, SO TWO EDGES. The other three boards have one control and
   * report a toggle; this one can say start and end separately, and the upper
   * button doubles as the microphone.
   */
  out->end_call = waveshare_buttons_take_lower_press();
  out->start_call = waveshare_buttons_take_upper_press();
  out->talk_held = waveshare_buttons_upper_held();
}

static void phase(void *context, enum iterate_kit_voice_phase phase_value) {
  (void)context;
  switch (phase_value) {
    case ITERATE_KIT_VOICE_PHASE_ARRIVED:
      waveshare_audio_amplifier(true);
      break;
    case ITERATE_KIT_VOICE_PHASE_FEEDING:
      waveshare_audio_dma_watch(true);
      break;
    case ITERATE_KIT_VOICE_PHASE_WAITING:
      waveshare_audio_dma_watch(false);
      break;
    case ITERATE_KIT_VOICE_PHASE_DRAINING:
      waveshare_audio_dma_draining();
      waveshare_audio_dma_watch(false);
      break;
    case ITERATE_KIT_VOICE_PHASE_FLUSHED:
      /*
       * DISARM BEFORE DECLARING, not after. The loop calls this before it
       * throws the audio away; doing the two in the other order leaves a
       * window in which the device's own intentional cut is recorded as
       * listener-visible starvation.
       */
      waveshare_audio_dma_watch(false);
      waveshare_audio_note_flush();
      break;
    case ITERATE_KIT_VOICE_PHASE_QUIET:
      waveshare_audio_amplifier(false);
      break;
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
       * The mouth track dies with the audio it was scheduled against. Its
       * INTAKE is currently unfed — the viseme event is deleted from the
       * contract and the face becomes liveState-published state — so this
       * clears a queue nothing is filling yet. Kept, not deleted, because the
       * queue and its reset are the half that survives that change.
       */
      waveshare_avatar_viseme_reset();
      break;
  }
}

static enum iterate_kit_status set_volume(
    void *context, uint8_t percent, uint8_t *applied) {
  (void)context;
  return waveshare_audio_set_volume(percent, applied);
}

static uint8_t volume(void *context) {
  (void)context;
  return waveshare_audio_volume();
}

/*
 * The twelve counters that are this board's hardware rather than the loop's
 * state. Same `,"name":value` shape as the shared table, and the same rule: a
 * field that does not fit returns 0 and the whole stats line is dropped,
 * because a truncated document is not a shorter one.
 */
static size_t health(void *context, char *out, size_t capacity) {
  struct field {
    const char *name;
    uint32_t value;
  };
  const struct field fields[] = {
    {"codecCaptureOverruns", waveshare_audio_capture_overruns()},
    {"codecCaptureFailures", waveshare_audio_capture_driver_failures()},
    /*
     * NOT A STARVATION MEASURE — an epoch-relative ledger deficit, kept for
     * diagnosis and named so nobody gates on it again.
     *
     * The ISR credits audio per feeding epoch and debits a descriptor per send.
     * An intentional cut discards the software buffer but NOT the DMA ring, so
     * the ring keeps sending descriptors credited in the PREVIOUS epoch while
     * the re-arm has reset the ledger to zero. Measured across one barge-in:
     * written fell 380ms -> 20ms and eleven such descriptors arrived; they were
     * charged to dmaOpening that time and to this counter (+4, +2) on an
     * earlier run, differing only in how much new audio had been credited when
     * they landed. The same physical event under two names is not a gate.
     *
     * spkStarvedMs is the authoritative one: wall-clock lateness against an
     * absolute audio-empty deadline, which stayed at 0 through both cuts.
     */
    {"dmaLedgerDeficit", waveshare_audio_dma_underruns()},
    {"dmaOpening", waveshare_audio_dma_underruns_opening()},
    /* Normal answer-end drain, kept apart from the ledger deficit on purpose. */
    {"dmaDraining", waveshare_audio_dma_sends_draining()},
    /* The task-side starvation measure: ms the ring was empty, and how often. */
    {"spkStarvedMs", waveshare_audio_starved_ms()},
    {"spkStarveEvents", waveshare_audio_starve_events()},
    {"codecPlaybackFailures", waveshare_audio_playback_driver_failures()},
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
  /* Full duplex by policy rather than by hardware: see `turns` below. */
  .capture_fence = NULL,
  .playout_fenced_out = NULL,
  .observe_playout = observe_playout,
  .observe_answer = observe_answer,
  /* Speaker, health, conversation control and push-to-talk are the loop's. */
  .modules = NULL,
  .health = health,
};

static const struct iterate_kit_board_facts facts = {
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
      "conversation.start() and conversation.end() begin and end a call. "
      "health() returns this device's full diagnostics, the same document it "
      "pushes as dev-stats — start there when it seems unwell. "
      "speaker.setVolume({percent}) sets how loud it plays, 0-100, clamped to "
      "a ceiling this board has a measured reason for; speaker.volume() reads "
      "it back. Both answer {percent,ceiling}. "
      "pushToTalk.start() and pushToTalk.stop() hold its microphone open, "
      "joining the physical button as a wired-OR: it has no echo cancellation, "
      "so it only listens while one of them is held. "
      "Audio and lifecycle events share this stream connection.",
  .peer_description =
      "{\"instructions\":\"Waveshare voice endpoint. "
      "conversation.start() / conversation.end() begin and end a call; "
      "pushToTalk.start() / pushToTalk.stop() hold its microphone open the way "
      "the upper button does. speaker.setVolume({percent}) sets how loud it "
      "plays, 0-100; it clamps to a ceiling this board has a measured reason "
      "for and answers with {percent,ceiling}, which speaker.volume() also "
      "returns. health() returns the same diagnostics document the device "
      "pushes as dev-stats.\",\"children\":{}}",
  .talk_hint = "hold the upper button to talk",
  .call_hint = "press upper to call",
  .speaker = {
    /*
     * TURN IT UP. Every board here shipped at a volume somebody measured once
     * and nobody could change without a reflash, and all four were reported as
     * too quiet. The driver keeps its ceiling; the knob is a call away.
     */
    .context = NULL,
    .set_volume = set_volume,
    .volume = volume,
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
  .capture_stack_bytes = 4096,
  .turns = ITERATE_KIT_VOICE_TURNS_PUSH_TO_TALK,
  /*
   * The codec first. This board's panel and codec share reset lines, so the
   * order inside `start` is fixed — and its bring-up is fast, so there is
   * nothing for the radio to overlap with.
   */
  .radio_before_codec = false,
};

void iterate_kit_waveshare_s3_amoled_run(void) {
  iterate_kit_voice_loop_run(&ops, &facts, NULL);
}
