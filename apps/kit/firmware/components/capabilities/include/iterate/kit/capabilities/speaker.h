#ifndef ITERATE_KIT_CAPABILITIES_SPEAKER_H
#define ITERATE_KIT_CAPABILITIES_SPEAKER_H

#include "iterate/kit/peer.h"
#include "iterate/kit/status.h"

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * How loud this device plays, as a number somebody can change and hear.
 *
 * EVERY BOARD'S VOLUME IS A TUNED CONSTANT WITH A REASON, AND EVERY ONE OF
 * THOSE REASONS IS A CEILING RATHER THAN A TASTE:
 *
 *   - the M5StickS3's DAC is pinned 18 dB down because a 75%-scale tone at
 *     0 dB tripped the board's BROWNOUT detector;
 *   - the Waveshare distorts measurably above ~85 (2nd harmonic -16.8 dB at
 *     100, -34.9 dB at 60);
 *   - the StackChan's speaker level is also its AEC reference level, so
 *     raising it spends echo-cancellation headroom;
 *   - the HA Voice PE ran its DAC at 0 dB because positive digital gain made
 *     the provider transcribe the device's own speaker output.
 *
 * Those are all real and all measured, and the result was a set of devices
 * that were, in one word, quiet — with no way to find out where the ceiling
 * actually was without a reflash. So the number is a knob now. A driver
 * refuses to exceed its own physical ceiling and REPORTS what it applied, so
 * asking for 100 on a board that can only give 70 is answered with 70 rather
 * than with a brownout.
 */
struct iterate_kit_speaker_driver {
  void *context;
  /**
   * Applies a 0-100 level and reports what the hardware actually took.
   *
   * `applied` is never NULL and is always written on success. A driver that
   * clamps must write the clamped value: the caller is entitled to learn the
   * ceiling by asking for more than it.
   */
  enum iterate_kit_status (*set_volume)(
      void *context, uint8_t percent, uint8_t *applied);
  /** The level in force now. */
  uint8_t (*volume)(void *context);
  /** The most this board will accept, so a caller need not probe for it. */
  uint8_t ceiling;
};

/** Bounded state for the speaker capability; zero-initialise before init. */
struct iterate_kit_speaker {
  struct iterate_kit_speaker_driver driver;
};

enum iterate_kit_status iterate_kit_speaker_init(
    struct iterate_kit_speaker *speaker,
    const struct iterate_kit_speaker_driver *driver);

/**
 * Mounts `speaker.setVolume({percent})` and `speaker.volume()`.
 *
 * Both answer with `{"percent":N,"ceiling":C}` — the same shape either way, so
 * a caller that sets and a caller that reads parse one thing.
 */
struct iterate_kit_module iterate_kit_speaker_module(
    struct iterate_kit_speaker *speaker);

#ifdef __cplusplus
}
#endif

#endif
