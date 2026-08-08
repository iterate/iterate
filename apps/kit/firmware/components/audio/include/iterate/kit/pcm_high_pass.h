#ifndef ITERATE_KIT_PCM_HIGH_PASS_H
#define ITERATE_KIT_PCM_HIGH_PASS_H

#include "iterate/kit/status.h"

#include <stddef.h>
#include <stdint.h>

/*
 * Removes low-frequency capture energy without buffering or changing cadence.
 *
 * A physical StackChan incident retained a valid, gap-free uplink which two
 * independent Grok transcription paths nevertheless decoded incorrectly.
 * Applying a one-pole high-pass to those exact samples recovered the intended
 * short phrase; generic denoising and a 4 kHz voice-band cutoff did not. This
 * primitive therefore models only that measured correction. It is not a
 * noise suppressor, VAD, AGC, or substitute for AEC.
 *
 * The caller owns this state and must keep one instance per continuous audio
 * channel. Processing is allocation-free, emits one sample per input sample,
 * and may be in-place. Reset at a real capture discontinuity; resetting at a
 * WebSocket or DMA chunk boundary creates a repeated transient and corrupts
 * speech. `decay_q15` is the pole coefficient in [1, 32767]; 31506 represents
 * exp(-2*pi*100/16000), a 100 Hz corner at the kit's 16 kHz PCM rate.
 */
struct iterate_kit_pcm_high_pass {
  int16_t previous_input;
  int16_t previous_output;
  uint16_t decay_q15;
  uint64_t clipped_samples;
};

enum iterate_kit_status iterate_kit_pcm_high_pass_init(
    struct iterate_kit_pcm_high_pass *filter,
    uint16_t decay_q15);

void iterate_kit_pcm_high_pass_reset(
    struct iterate_kit_pcm_high_pass *filter);

enum iterate_kit_status iterate_kit_pcm_high_pass_process(
    struct iterate_kit_pcm_high_pass *filter,
    const int16_t *input,
    int16_t *output,
    size_t sample_count);

#endif
