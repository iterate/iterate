#ifndef ITERATE_KIT_PLATFORMS_VOICE_PE_PCM_FORMAT_H
#define ITERATE_KIT_PLATFORMS_VOICE_PE_PCM_FORMAT_H

#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define ITERATE_KIT_VOICE_PE_PLAYBACK_WORDS_PER_PCM16_SAMPLE 6U

struct iterate_kit_voice_pe_playback_resampler {
  int16_t previous_sample;
  bool primed;
};

/**
 * Drops interpolation history at a real stream-generation discontinuity.
 * Lane frame boundaries are not discontinuities and must retain this state.
 */
void iterate_kit_voice_pe_playback_resampler_reset(
    struct iterate_kit_voice_pe_playback_resampler *resampler);

/**
 * Expands portable lane audio into the Voice Preview Edition playback format.
 *
 * The shared `/pcm` contract is mono signed PCM16 at 16 kHz.  The board's
 * first-party XMOS/AIC3204 design owns a 48 kHz stereo bus with signed 32-bit
 * slots. Keeping this exact, allocation-free 3:1 interpolation inside the
 * hardware owner avoids resampling or device knowledge in either userspace or
 * the real-time lane. The retained one-sample history adds only 62.5 us of
 * fixed latency and prevents a periodic discontinuity at every 10 ms lane
 * edge. Each source sample becomes three consecutive stereo frames and is
 * placed in the most-significant 16 bits of each I2S word.
 *
 * This conversion intentionally does not buffer between calls: each 20 ms
 * lane frame is independently conserved as exactly 20 ms of hardware audio.
 * A destination which cannot hold the complete expansion is rejected without
 * writing a partial frame, because partial progress would create an implicit
 * queue/retry contract and make interruption accounting ambiguous.
 */
enum iterate_kit_status iterate_kit_voice_pe_expand_playback(
    struct iterate_kit_voice_pe_playback_resampler *resampler,
    const int16_t *source,
    size_t source_samples,
    int32_t *destination,
    size_t destination_capacity_samples,
    size_t *destination_samples_written);

/**
 * Splits XMOS stereo capture into portable PCM16 and an AEC comparison lane.
 *
 * Channel zero uses the cumulative uplink stage selected by the hardware
 * policy (currently the cumulative NS tap: AEC, IC, and NS, excluding AGC).
 * Channel one is
 * configured as NONE: the XMOS source defines that as its original
 * microphone tap, before AEC or any later DSP stage. This same-time raw
 * observation lets the acceptance harness establish that physical speech and
 * speaker energy really reached the microphones; it must not be treated as a
 * waveform-equivalent control because XMOS intentionally transforms channel
 * zero. Only channel zero is eligible for `/pcm`; channel one is diagnostic
 * data and must remain local.
 * Both source words are Q31-aligned little-endian signed samples supplied by
 * ESP-IDF's 32-bit stereo I2S read.
 */
enum iterate_kit_status iterate_kit_voice_pe_extract_capture(
    const int32_t *source_interleaved,
    size_t source_stereo_frames,
    int16_t *processed_destination,
    int16_t *non_aec_destination,
    size_t destination_capacity_frames,
    size_t *destination_frames_written);

#ifdef __cplusplus
}
#endif

#endif
