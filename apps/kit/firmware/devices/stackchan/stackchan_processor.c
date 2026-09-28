/*
 * The StackChan AEC as an iterate_kit_audio_processor. See the header for
 * the tuned operating point; every constant here is the donor branch's
 * final measured state, not a fresh choice.
 */
#include "stackchan_processor.h"

#include <string.h>

#include "esp_aec.h"
#include "esp_heap_caps.h"
#include "esp_log.h"

#include "iterate/kit/aec_reference_scaler.h"
#include "iterate/kit/pcm_high_pass.h"

static const char tag[] = "stackchan-aec";

enum {
  SAMPLE_RATE_HZ = 16000,
  /*
   * Four filter blocks. The donor swept this with the physical oracle; four
   * was the operating point that held both suppression and double-talk.
   */
  AEC_FILTER_LENGTH = 4,
  /*
   * exp(-2*pi*100/16000) in Q15: a 100 Hz corner. The enclosure couples the
   * speaker into the microphone below speech; filtering it before the AEC
   * keeps the adaptive filter's energy where speech lives.
   */
  NEAR_HIGH_PASS_DECAY_Q15 = 31506,
  /* Saturating digital gain on the analogue divider reference. */
  REFERENCE_SCALE_MULTIPLIER = 8,
  /*
   * The donor's final uplink gain on the processed plane, sized so provider
   * VAD hears the otherwise quiet but bounded signal.
   */
  PROCESSED_GAIN_MULTIPLIER = 10,
};

static struct {
  void *aec;
  struct iterate_kit_pcm_high_pass near_high_pass;
  int16_t near_scratch[STACKCHAN_PROCESSOR_FRAME_SAMPLES];
  int16_t reference_scratch[STACKCHAN_PROCESSOR_FRAME_SAMPLES];
  int16_t clean_scratch[STACKCHAN_PROCESSOR_FRAME_SAMPLES];
  uint64_t reference_clipped_samples;
  uint64_t uplink_clipped_samples;
  uint32_t recreates;
  int mode;
  uint32_t recreate_failures;
  bool initialized;
} state;

static bool create_engine(int mode) {
  aec_config_t config = {
    .mic_num = 1,
    .ref_num = 1,
    .out_num = 1,
    .filter_length = AEC_FILTER_LENGTH,
    .sample_rate = SAMPLE_RATE_HZ,
    .caps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT,
    /*
     * AEC_MODE_VOIP_HIGH_PERF, THE ONE MODE ESP-SR CREATES ON THIS BOARD.
     * FD_HIGH_PERF, FD_LOW_COST and SR_HIGH_PERF all refuse to create here
     * (the board reported `aecMode: 4` after trying each in turn), and asking
     * for an absent mode on every reset spends failed allocations against the
     * capture deadline.
     *
     * Its cost is double-talk. VOIP mode brings its own aggressive residual
     * suppressor, and measured on this board it does not merely attenuate the
     * near end during double-talk — it destroys it. Same words, same
     * distance, same microphone (`voice_stream aec`, 2026-08-11):
     *
     *   board silent    whisper reads "Stop talking right now, please stop."
     *   board playing   whisper reads nothing at all
     *
     * The spectrograms are the diagnosis. Alone, the voice is clean harmonic
     * stacks with silence between syllables; over an answer the same syllables
     * are still there with the 2.5-3.5 kHz formants punched through and the
     * gaps smeared full of residual. The ENERGY survives — double-talk peaks
     * within 2 dB of voice-alone — so this is not attenuation, it is a
     * suppressor deciding which time-frequency cells belong to the far end and
     * being wrong about the ones that carry the words.
     *
     * AEC_MODE_FD_* trades some pure-echo suppression for keeping the near
     * end intact, which would be the right trade here: the echo residual has
     * never been the failure — no word of the assistant has ever reached the
     * uplink at any volume — and the interruption always has. It is worth one
     * flash again whenever an esp-sr upgrade might create it.
     */
    .mode = mode,
    /* Documented inert under VOIP mode, where the engine supplies its own. */
    .nlp_level = AEC_NLP_LEVEL_AGGR,
  };
  state.aec = aec_create_from_config(&config);
  if (state.aec == NULL) {
    ESP_LOGE(tag, "AEC mode %d would not create", (int)mode);
    return false;
  }
  /*
   * FAIL CLOSED on cadence: the whole capture path is sized around 16 ms
   * frames, and an engine that wants another chunk size would make every
   * downstream frame boundary a lie.
   */
  if (aec_get_chunksize(state.aec) != STACKCHAN_PROCESSOR_FRAME_SAMPLES) {
    ESP_LOGE(
        tag,
        "AEC mode %d wants chunksize %d, not %d — failing closed",
        (int)mode,
        aec_get_chunksize(state.aec),
        STACKCHAN_PROCESSOR_FRAME_SAMPLES);
    aec_destroy(state.aec);
    state.aec = NULL;
    return false;
  }
  state.mode = mode;
  return true;
}

static enum iterate_kit_status processor_reset(void *context) {
  (void)context;
  if (!state.initialized) {
    return ITERATE_KIT_STATE_ERROR;
  }
  /*
   * ESP-SR exposes no filter reset: destroy and recreate, losing adaptation
   * deliberately. Counted, because a reset storm is a capture-path defect
   * that would otherwise present only as "the echo keeps coming back".
   */
  if (state.aec != NULL) {
    aec_destroy(state.aec);
    state.aec = NULL;
  }
  ++state.recreates;
  if (!create_engine(AEC_MODE_VOIP_HIGH_PERF)) {
    ++state.recreate_failures;
    return ITERATE_KIT_IO_ERROR;
  }
  iterate_kit_pcm_high_pass_reset(&state.near_high_pass);
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status processor_process(
    void *context, const struct iterate_kit_audio_processor_frame *frame) {
  (void)context;
  if (!state.initialized || state.aec == NULL || frame == NULL ||
      frame->sample_count != STACKCHAN_PROCESSOR_FRAME_SAMPLES ||
      frame->near == NULL || frame->reference == NULL ||
      frame->output == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  /*
   * Condition both planes into scratch: the processor interface's inputs are const, and
   * aec_process wants distinct in/out anyway. Order matters and is the
   * donor's: high-pass the near BEFORE the filter sees it, scale the
   * reference BEFORE the filter learns from it.
   */
  if (iterate_kit_pcm_high_pass_process(
          &state.near_high_pass,
          frame->near,
          state.near_scratch,
          STACKCHAN_PROCESSOR_FRAME_SAMPLES) != ITERATE_KIT_OK ||
      iterate_kit_aec_reference_scale(
          frame->reference,
          state.reference_scratch,
          STACKCHAN_PROCESSOR_FRAME_SAMPLES,
          REFERENCE_SCALE_MULTIPLIER,
          &state.reference_clipped_samples) != ITERATE_KIT_OK) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  aec_process(
      state.aec,
      state.near_scratch,
      state.reference_scratch,
      state.clean_scratch);
  /*
   * The uplink is the processed plane, always, at the same memoryless
   * saturating gain the reference gets. Adaptive AGC, speaker-time muting, and
   * weakened double-talk gates are deliberately forbidden; see the header.
   */
  return iterate_kit_aec_reference_scale(
      state.clean_scratch,
      frame->output,
      STACKCHAN_PROCESSOR_FRAME_SAMPLES,
      PROCESSED_GAIN_MULTIPLIER,
      &state.uplink_clipped_samples);
}

static const struct iterate_kit_audio_processor_ops processor_ops = {
  .reset = processor_reset,
  .process = processor_process,
};

static const struct iterate_kit_audio_processor_properties
    processor_properties = {
  .sample_rate_hz = SAMPLE_RATE_HZ,
  .frame_samples = STACKCHAN_PROCESSOR_FRAME_SAMPLES,
  .requires_reference_channel = true,
};

bool stackchan_processor_init(void) {
  if (state.initialized) {
    return true;
  }
  if (!create_engine(AEC_MODE_VOIP_HIGH_PERF)) {
    return false;
  }
  if (iterate_kit_pcm_high_pass_init(
          &state.near_high_pass, NEAR_HIGH_PASS_DECAY_Q15) !=
      ITERATE_KIT_OK) {
    return false;
  }
  state.initialized = true;
  ESP_LOGI(tag, "VOIP AEC ready: filter=%d frame=%d", AEC_FILTER_LENGTH,
           STACKCHAN_PROCESSOR_FRAME_SAMPLES);
  return true;
}

struct iterate_kit_audio_processor stackchan_processor(void) {
  return (struct iterate_kit_audio_processor){
    .ops = &processor_ops,
    .properties = &processor_properties,
    .context = NULL,
  };
}

uint32_t stackchan_processor_mode(void) {
  return (uint32_t)state.mode;
}

uint32_t stackchan_processor_recreates(void) {
  return state.recreates;
}

uint32_t stackchan_processor_recreate_failures(void) {
  return state.recreate_failures;
}

uint64_t stackchan_processor_reference_clipped_samples(void) {
  return state.reference_clipped_samples;
}

uint64_t stackchan_processor_near_high_pass_clipped_samples(void) {
  return state.near_high_pass.clipped_samples;
}

uint64_t stackchan_processor_uplink_clipped_samples(void) {
  return state.uplink_clipped_samples;
}
