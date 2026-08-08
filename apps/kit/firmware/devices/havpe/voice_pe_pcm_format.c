#include "voice_pe_pcm_format.h"

void iterate_kit_voice_pe_playback_resampler_reset(
    struct iterate_kit_voice_pe_playback_resampler *resampler) {
  if (resampler == NULL) {
    return;
  }
  resampler->previous_sample = 0;
  resampler->primed = false;
}

static int16_t interpolate_third(
    int16_t previous,
    int16_t current,
    int32_t current_weight) {
  const int32_t previous_weight = 3 - current_weight;
  return (int16_t)(
      ((int32_t)previous * previous_weight +
       (int32_t)current * current_weight) /
      3);
}

static void write_stereo_q31(
    int16_t sample,
    int32_t *destination,
    size_t offset) {
  /*
   * Multiplication, rather than left-shifting a negative signed integer,
   * keeps every input value including INT16_MIN defined by C99. No gain is
   * applied here: analog/digital volume belongs to the codec owner, not this
   * transport-format boundary.
   */
  const int32_t word = (int32_t)sample * 65536;
  destination[offset] = word;
  destination[offset + 1U] = word;
}

enum iterate_kit_status iterate_kit_voice_pe_expand_playback(
    struct iterate_kit_voice_pe_playback_resampler *resampler,
    const int16_t *source,
    size_t source_samples,
    int32_t *destination,
    size_t destination_capacity_samples,
    size_t *destination_samples_written) {
  if (destination_samples_written == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  *destination_samples_written = 0U;
  if (resampler == NULL || source == NULL || source_samples == 0U ||
      destination == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (source_samples >
      destination_capacity_samples /
          ITERATE_KIT_VOICE_PE_PLAYBACK_WORDS_PER_PCM16_SAMPLE) {
    return ITERATE_KIT_LIMIT;
  }

  for (size_t source_index = 0U;
       source_index < source_samples;
       ++source_index) {
    const int16_t current = source[source_index];
    const size_t destination_offset =
        source_index *
        ITERATE_KIT_VOICE_PE_PLAYBACK_WORDS_PER_PCM16_SAMPLE;
    if (!resampler->primed) {
      /*
       * There is no sample before the first generation. Holding only this
       * first 62.5 us interval is deterministic and avoids inventing a fade
       * from zero which would attenuate the first speech consonant.
       */
      write_stereo_q31(current, destination, destination_offset);
      write_stereo_q31(current, destination, destination_offset + 2U);
      write_stereo_q31(current, destination, destination_offset + 4U);
      resampler->primed = true;
    } else {
      write_stereo_q31(
          resampler->previous_sample,
          destination,
          destination_offset);
      write_stereo_q31(
          interpolate_third(
              resampler->previous_sample, current, 1),
          destination,
          destination_offset + 2U);
      write_stereo_q31(
          interpolate_third(
              resampler->previous_sample, current, 2),
          destination,
          destination_offset + 4U);
    }
    resampler->previous_sample = current;
  }

  *destination_samples_written =
      source_samples *
      ITERATE_KIT_VOICE_PE_PLAYBACK_WORDS_PER_PCM16_SAMPLE;
  return ITERATE_KIT_OK;
}

static int16_t q31_word_to_pcm16(int32_t word) {
  /*
   * Signed right shift is implementation-defined in C99.  Extracting through
   * uint32_t and mapping the upper half back into the mathematical int16 range
   * gives the same bit-accurate result on the host rig and ESP32 without making
   * an undocumented compiler assumption.
   */
  const uint16_t upper = (uint16_t)((uint32_t)word >> 16U);
  const int32_t signed_upper = upper <= INT16_MAX
      ? (int32_t)upper
      : (int32_t)upper - 65536;
  return (int16_t)signed_upper;
}

enum iterate_kit_status iterate_kit_voice_pe_extract_capture(
    const int32_t *source_interleaved,
    size_t source_stereo_frames,
    int16_t *processed_destination,
    int16_t *non_aec_destination,
    size_t destination_capacity_frames,
    size_t *destination_frames_written) {
  if (destination_frames_written == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  *destination_frames_written = 0U;
  if (source_interleaved == NULL || source_stereo_frames == 0U ||
      processed_destination == NULL || non_aec_destination == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (source_stereo_frames > destination_capacity_frames) {
    return ITERATE_KIT_LIMIT;
  }

  for (size_t frame = 0U; frame < source_stereo_frames; ++frame) {
    processed_destination[frame] =
        q31_word_to_pcm16(source_interleaved[frame * 2U]);
    non_aec_destination[frame] =
        q31_word_to_pcm16(source_interleaved[frame * 2U + 1U]);
  }
  *destination_frames_written = source_stereo_frames;
  return ITERATE_KIT_OK;
}
