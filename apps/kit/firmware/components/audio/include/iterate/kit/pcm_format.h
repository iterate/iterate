#ifndef ITERATE_KIT_PCM_FORMAT_H
#define ITERATE_KIT_PCM_FORMAT_H

#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Adopted from the donor branch's proven HAVPE port (§5.1 Tier 2 companion
 * to voice_pe_hardware_config): the measured, allocation-free conversion
 * between the portable 16 kHz mono PCM16 wire format and this board's
 * XMOS-mastered 48 kHz stereo 32-bit I2S buses. Pure C99, host-tested.
 */

/** Stereo Q31 words emitted for one PCM16 sample by the 3:1 interpolator. */
enum { ITERATE_KIT_PCM_PLAYBACK_WORDS_PER_PCM16_SAMPLE = 6U };

/**
 * How 16 kHz mono PCM16 sits on a wire bus. bits is 16 or 32; slots is 1 or 2.
 * uplink_slot selects capture audio; diagnostic_slot is -1 (none) or a slot
 * that stays local. ratio is wire frames per 16 kHz sample: 1, or 3 on a
 * 48 kHz bus whose DSP repeats each sample three times. Capture calls must
 * begin at a group boundary and contain complete ratio-sized groups.
 */
struct iterate_kit_pcm_shape {
  uint8_t bits;
  uint8_t slots;
  uint8_t uplink_slot;
  int8_t diagnostic_slot;
  uint8_t ratio;
};

/** Facts observed while extracting one capture buffer. Peaks are taken before
 * the fixed uplink gain, so they remain an honest view of the selected XMOS
 * plane. The diagnostic plane is never scaled. */
struct iterate_kit_pcm_capture_metrics {
  uint32_t processed_peak;
  uint32_t diagnostic_peak;
  uint32_t processed_clipped;
};

/** Bytes occupied by wire frames (not 16 kHz samples), or 0 for an invalid
 * shape, zero frames, or overflow. DMA descriptors count wire frames; one
 * portable frame occupies bytes_for_frames(shape, 320 * shape->ratio).
 */
size_t iterate_kit_pcm_bytes_for_frames(
    const struct iterate_kit_pcm_shape *shape, size_t wire_frames);

/** One-sample interpolation history; reset only at a stream discontinuity. */
struct iterate_kit_pcm_playback_resampler {
  int16_t previous_sample;
  bool primed;
};

/**
 * Drops interpolation history at a real stream-generation discontinuity.
 * Frame boundaries are not discontinuities and must retain this state.
 */
void iterate_kit_pcm_playback_resampler_reset(
    struct iterate_kit_pcm_playback_resampler *resampler);

/**
 * Expands portable wire audio into the Voice Preview Edition playback format.
 *
 * The wire contract is mono signed PCM16 at 16 kHz. The board's first-party
 * XMOS/AIC3204 design owns a 48 kHz stereo bus with signed 32-bit slots.
 * This exact, allocation-free 3:1 linear interpolation serves any board
 * with that bus format. The retained one-sample history adds only 62.5 us of
 * fixed latency and prevents a periodic discontinuity at every frame edge
 * (zero-order hold was rejected on measured -12 dB images at 13 kHz for
 * 3 kHz speech). Each source sample becomes three consecutive stereo frames
 * in the most-significant 16 bits of each I2S word.
 *
 * The conversion does not buffer between calls: each frame is independently
 * conserved as exactly its own duration of hardware audio. A destination
 * which cannot hold the complete expansion is rejected without writing a
 * partial frame, because partial progress would create an implicit
 * queue/retry contract and make interruption accounting ambiguous.
 */
enum iterate_kit_status iterate_kit_pcm_expand_playback(
    struct iterate_kit_pcm_playback_resampler *resampler,
    const int16_t *source,
    size_t source_samples,
    int32_t *destination,
    size_t destination_capacity_samples,
    size_t *destination_samples_written);

/** Expand PCM16 into a table's wire shape. Ratio 1 duplicates slots without
 * gain; ratio 3 retains the proven one-sample 3:1 interpolation across calls.
 * Destination must be aligned for shape->bits. Capacity and result are bytes;
 * invalid inputs or insufficient capacity never produce a partial frame.
 */
enum iterate_kit_status iterate_kit_pcm_expand_playback_shape(
    const struct iterate_kit_pcm_shape *shape,
    struct iterate_kit_pcm_playback_resampler *resampler,
    const int16_t *source, size_t source_samples,
    void *destination, size_t destination_capacity_bytes,
    size_t *destination_bytes_written);

/**
 * Extracts the selected capture slots, keeping the first frame of each group.
 * Source must be aligned for shape->bits. Diagnostic output may be NULL only
 * when diagnostic_slot is -1. Invalid shapes or incomplete groups are rejected
 * without partial writes; insufficient output capacity returns LIMIT.
 *
 * HAVPE uses {32, 2, 0, 1, 1}, preserving both same-time XMOS taps:
 *
 * Channel zero uses the cumulative uplink stage selected by the hardware
 * policy (currently the cumulative NS tap: AEC, IC, and NS, excluding AGC).
 * Channel one is configured as NONE: the XMOS source defines that as its
 * original microphone tap, before AEC or any later DSP stage. That same-time
 * raw observation lets an acceptance harness establish that physical speech
 * and speaker energy really reached the microphones; it must not be treated
 * as a waveform-equivalent control because XMOS intentionally transforms
 * channel zero. Only channel zero is eligible for the uplink; channel one is
 * diagnostic data and must remain local. Both source words are Q31-aligned
 * little-endian signed samples supplied by ESP-IDF's 32-bit stereo I2S read.
 *
 * `processed_gain` is a nonzero fixed multiplier for the selected uplink
 * plane. Q31 capture applies it before conversion to PCM16, retaining quiet
 * low-order bits which would otherwise be discarded first. `metrics` is
 * optional and records pre-gain plane peaks plus exactly one clip per
 * saturated output sample.
 */
enum iterate_kit_status iterate_kit_pcm_extract_capture(
    const struct iterate_kit_pcm_shape *shape,
    const void *source_interleaved,
    size_t source_frames,
    uint8_t processed_gain,
    int16_t *processed_destination,
    int16_t *non_aec_destination,
    size_t destination_capacity_frames,
    size_t *destination_frames_written,
    struct iterate_kit_pcm_capture_metrics *metrics);

#ifdef __cplusplus
}
#endif

#endif
