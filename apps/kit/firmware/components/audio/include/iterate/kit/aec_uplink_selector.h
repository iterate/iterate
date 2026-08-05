#ifndef ITERATE_KIT_AEC_UPLINK_SELECTOR_H
#define ITERATE_KIT_AEC_UPLINK_SELECTOR_H

#include "iterate/kit/status.h"

#include <stddef.h>
#include <stdint.h>

enum iterate_kit_aec_uplink_policy {
  ITERATE_KIT_AEC_UPLINK_PLAYBACK_SWITCHED = 1,
  ITERATE_KIT_AEC_UPLINK_CONSTANT_PROCESSED = 2,
};

/**
 * Chooses the truthful microphone signal for one full-duplex AEC frame.
 *
 * Some communication AEC engines include an always-on residual suppressor.
 * On CoreS3 we measured that suppressor removing 92--99% of nearby speech
 * while the playback owner reported digital silence. AEC cannot improve a
 * frame that contains no far-end signal, so the raw microphone is the
 * information-preserving output in that state. While speaker PCM exists (and
 * for a short acoustic tail afterwards), the processed output remains
 * mandatory and is never muted: real double-talk must continue upstream.
 *
 * The selector is intentionally independent of device I/O and transport. It
 * has no allocation, clock, queue, or callback, making the policy executable
 * in host tests and reusable by another board only if its measurements justify
 * the same topology.
 */
struct iterate_kit_aec_uplink_selector {
  enum iterate_kit_aec_uplink_policy policy;
  size_t processed_hangover_frames;
  size_t processed_hangover_remaining;
  uint32_t raw_gain_multiplier;
  uint32_t processed_gain_multiplier;
  uint64_t raw_frames;
  uint64_t processed_frames;
  uint64_t clipped_samples;
};

enum iterate_kit_status iterate_kit_aec_uplink_selector_init(
    struct iterate_kit_aec_uplink_selector *selector,
    enum iterate_kit_aec_uplink_policy policy,
    size_t processed_hangover_frames,
    uint32_t raw_gain_multiplier,
    uint32_t processed_gain_multiplier);

/**
 * Writes exactly one output sample for every input sample.
 *
 * `processed` must be the result of running AEC for this same aligned
 * near/reference frame. `playout_samples` is a capture-aligned far-active
 * policy signal; it is not an acoustic reference and need not contain the
 * original speaker PCM. The constant-processed policy deliberately ignores
 * it. The AEC must run even when the switched policy chooses raw near audio so
 * its adaptive state remains current for the next far-end frame.
 */
enum iterate_kit_status iterate_kit_aec_uplink_selector_process(
    struct iterate_kit_aec_uplink_selector *selector,
    const int16_t *near_samples,
    const int16_t *playout_samples,
    const int16_t *processed_samples,
    int16_t *output_samples,
    size_t sample_count);

#endif
