#ifndef ITERATE_KIT_AUDIO_CODEC_H
#define ITERATE_KIT_AUDIO_CODEC_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/status.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Hardware facts which affect composition but do not size shared queues.
 *
 * These values describe the physical codec path after its adapter has applied
 * any fixed conversion. Wire-frame sizes, queue depths, and timeouts remain in
 * voice_device_profile.h so every board is supervised against one table. A
 * board adapter must not copy those supervision constants into this struct.
 *
 * `has_reference_channel` means read() returns a capture-clock-aligned
 * loudspeaker reference, not merely a copy of intended TX PCM. The property is
 * exposed before any portable caller uses it so adding AEC cannot require a
 * platform bypass. A true value does not by itself prove acoustic alignment or
 * cancellation quality; those require board-specific evidence.
 */
struct iterate_kit_audio_codec_properties {
  uint32_t capture_sample_rate_hz;
  uint32_t playback_sample_rate_hz;
  uint8_t capture_channels;
  uint8_t playback_channels;
  bool full_duplex;
  bool has_reference_channel;
  bool capture_is_echo_cancelled;
  /** True when the codec or platform driver, not its caller, advances capture. */
  bool capture_clock_is_hardware_owned;
  /**
   * True when the codec or platform driver advances playback. A deterministic
   * adapter may emulate that hardware-owned cadence without changing the fact.
   */
  bool playback_clock_is_hardware_owned;
  bool has_output_gain_control;
  /** Maximum gain relative to unity PCM (0 dB); negative values attenuate. */
  int16_t output_gain_ceiling_centi_db;
};

/**
 * Nonblocking hardware operations owned by one audio task.
 *
 * read() copies the oldest retained complete capture-clock-contiguous samples
 * and returns UNAVAILABLE when no frame is ready. An overrun may discard older
 * samples before this call, but a successful read never skips a retained frame.
 * `reference` must be non-NULL exactly when the properties advertise a
 * reference channel. `capacity_samples` counts int16_t entries in each plane,
 * not bytes; multi-channel capture is interleaved within the capture plane.
 * A successful read returns 1..capacity_samples entries and fully writes
 * `sample_count`. The public iterate_kit_audio_codec_read() wrapper initializes
 * it and overwrites any adapter residue so every non-OK result observed by a
 * caller leaves the pointed value at zero.
 *
 * write() copies one complete playback plane or returns BACKPRESSURE.
 * `sample_count` uses the same int16_t-entry convention; an adapter returns
 * INVALID_ARGUMENT for unsupported granularity and UNAVAILABLE when playback
 * is disabled. A successful copy is admission to the bounded hardware path,
 * not proof of physical playout. Platform diagnostics own that later
 * completion evidence. Neither operation allocates, waits, calls the network,
 * or silently drops.
 *
 * The composition root must match capture rate and frame cadence to its audio
 * processor and may select a reference-requiring processor only when
 * `has_reference_channel` is true. Those are configuration errors, not
 * recoverable per-frame outcomes.
 */
struct iterate_kit_audio_codec_ops {
  enum iterate_kit_status (*read)(void *context,
                                  int16_t *capture,
                                  int16_t *reference,
                                  size_t capacity_samples,
                                  size_t *sample_count);
  enum iterate_kit_status (*write)(void *context,
                                   const int16_t *playback,
                                   size_t sample_count);
};

struct iterate_kit_audio_codec {
  const struct iterate_kit_audio_codec_ops *ops;
  const struct iterate_kit_audio_codec_properties *properties;
  void *context;
};

/** Validate and dispatch through the codec seam. */
enum iterate_kit_status iterate_kit_audio_codec_read(
    struct iterate_kit_audio_codec *codec,
    int16_t *capture,
    int16_t *reference,
    size_t capacity_samples,
    size_t *sample_count);

enum iterate_kit_status iterate_kit_audio_codec_write(
    struct iterate_kit_audio_codec *codec,
    const int16_t *playback,
    size_t sample_count);

/** Reject incomplete or contradictory platform property tables. */
enum iterate_kit_status iterate_kit_audio_codec_validate(
    const struct iterate_kit_audio_codec *codec);

#ifdef __cplusplus
}
#endif

#endif
