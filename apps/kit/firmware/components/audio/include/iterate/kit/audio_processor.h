#ifndef ITERATE_KIT_AUDIO_PROCESSOR_H
#define ITERATE_KIT_AUDIO_PROCESSOR_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/status.h"

#ifdef __cplusplus
extern "C" {
#endif

/** Static facts imposed by a DSP adapter rather than by board storage. */
struct iterate_kit_audio_processor_properties {
  uint32_t sample_rate_hz;
  size_t frame_samples;
  bool requires_reference_channel;
  bool uses_playout_activity;
};

/**
 * One capture-clock-aligned DSP frame.
 *
 * `near` is the microphone plane. `reference` is the physical loudspeaker
 * feedback returned by the codec when required. `playout_activity` is a
 * separate per-sample policy plane: zero means no intended far-end content and
 * nonzero means content was rendered. Keeping it separate prevents analogue
 * reference noise from selecting an uplink branch. All input planes and
 * `output` contain exactly properties.frame_samples PCM16 samples.
 */
struct iterate_kit_audio_processor_frame {
  const int16_t *near;
  const int16_t *reference;
  const int16_t *playout_activity;
  int16_t *output;
  size_t sample_count;
};

struct iterate_kit_audio_processor_ops {
  /** Reset adaptive state after a discontinuity; never for a network reset. */
  enum iterate_kit_status (*reset)(void *context);
  /** Fully writes output without allocation, waiting, locks, or I/O. */
  enum iterate_kit_status (*process)(
      void *context,
      const struct iterate_kit_audio_processor_frame *frame);
};

struct iterate_kit_audio_processor {
  const struct iterate_kit_audio_processor_ops *ops;
  const struct iterate_kit_audio_processor_properties *properties;
  void *context;
};

/**
 * Dispatch one DSP frame with a fail-closed error rule.
 *
 * Once output and its exact configured extent are valid, any adapter failure
 * overwrites the complete output with silence before returning the error. Raw
 * microphone audio must never leak around a failed echo canceller.
 */
enum iterate_kit_status iterate_kit_audio_processor_process(
    struct iterate_kit_audio_processor *processor,
    const struct iterate_kit_audio_processor_frame *frame);

enum iterate_kit_status iterate_kit_audio_processor_reset(
    struct iterate_kit_audio_processor *processor);

enum iterate_kit_status iterate_kit_audio_processor_validate(
    const struct iterate_kit_audio_processor *processor);

/**
 * Stateless adapter for paths which need no firmware DSP.
 *
 * It copies near to output. macOS uses it because CoreAudio supplies no
 * aligned echo reference; HAVPE will use it because its XMOS path already
 * returns echo-cancelled capture. The returned object borrows static storage.
 */
struct iterate_kit_audio_processor iterate_kit_audio_processor_passthrough(void);

#ifdef __cplusplus
}
#endif

#endif
