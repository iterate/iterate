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
#include "iterate/kit/aec_uplink_selector.h"
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
   * The donor's final uplink gains. Raw x6 is inert under the shipped
   * constant-processed policy but is the measured value the switched A/B
   * policy would use; processed x10 is what the wire carries.
   */
  RAW_GAIN_MULTIPLIER = 6,
  PROCESSED_GAIN_MULTIPLIER = 10,
  PROCESSED_HANGOVER_FRAMES = 8,
};

static struct {
  void *aec;
  struct iterate_kit_pcm_high_pass near_high_pass;
  struct iterate_kit_aec_uplink_selector selector;
  int16_t near_scratch[STACKCHAN_PROCESSOR_FRAME_SAMPLES];
  int16_t reference_scratch[STACKCHAN_PROCESSOR_FRAME_SAMPLES];
  int16_t clean_scratch[STACKCHAN_PROCESSOR_FRAME_SAMPLES];
  uint64_t reference_clipped_samples;
  uint32_t recreates;
  uint32_t recreate_failures;
  bool initialized;
} state;

/*
 * The selector demands a far-active plane even though the shipped constant
 * policy ignores it; this processor declares uses_playout_activity = false,
 * so the plane is a documented zero. Re-measuring the switched policy would
 * wire the codec's per-chunk activity bit through here instead.
 */
static const int16_t
    zero_playout_plane[STACKCHAN_PROCESSOR_FRAME_SAMPLES];

static bool create_engine(void) {
  aec_config_t config = {
    .mic_num = 1,
    .ref_num = 1,
    .out_num = 1,
    .filter_length = AEC_FILTER_LENGTH,
    .sample_rate = SAMPLE_RATE_HZ,
    .caps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT,
    .mode = AEC_MODE_VOIP_HIGH_PERF,
    /* Inert in VOIP mode (NLP is the engine's own); kept at the donor value. */
    .nlp_level = AEC_NLP_LEVEL_AGGR,
  };
  state.aec = aec_create_from_config(&config);
  if (state.aec == NULL) {
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
        "AEC chunksize %d != %d — failing closed",
        aec_get_chunksize(state.aec),
        STACKCHAN_PROCESSOR_FRAME_SAMPLES);
    aec_destroy(state.aec);
    state.aec = NULL;
    return false;
  }
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
  if (!create_engine()) {
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
   * Condition both planes into scratch: the seam's inputs are const, and
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
   * The shipped uplink policy: the processed plane, always, at a saturating
   * x10 — sized so provider VAD sees the otherwise quiet but bounded signal.
   * Adaptive AGC, speaker-time muting, and weakened double-talk gates are
   * deliberately forbidden; see the header.
   */
  return iterate_kit_aec_uplink_selector_process(
      &state.selector,
      state.near_scratch,
      zero_playout_plane,
      state.clean_scratch,
      frame->output,
      STACKCHAN_PROCESSOR_FRAME_SAMPLES);
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
  .uses_playout_activity = false,
};

bool stackchan_processor_init(void) {
  if (state.initialized) {
    return true;
  }
  if (!create_engine()) {
    return false;
  }
  if (iterate_kit_pcm_high_pass_init(
          &state.near_high_pass, NEAR_HIGH_PASS_DECAY_Q15) !=
          ITERATE_KIT_OK ||
      iterate_kit_aec_uplink_selector_init(
          &state.selector,
          ITERATE_KIT_AEC_UPLINK_CONSTANT_PROCESSED,
          PROCESSED_HANGOVER_FRAMES,
          RAW_GAIN_MULTIPLIER,
          PROCESSED_GAIN_MULTIPLIER) != ITERATE_KIT_OK) {
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
  return state.selector.clipped_samples;
}
