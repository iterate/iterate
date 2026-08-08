#ifndef ITERATE_KIT_PLATFORMS_DARWIN_AUDIO_CODEC_H
#define ITERATE_KIT_PLATFORMS_DARWIN_AUDIO_CODEC_H

#include <stdbool.h>
#include <stdint.h>

#include "iterate/kit/audio_codec.h"
#include "iterate/kit/platforms/darwin_audio_input.h"
#include "iterate/kit/platforms/darwin_audio_output.h"

#ifdef __cplusplus
extern "C" {
#endif

struct iterate_kit_darwin_audio_codec_options {
  bool capture_enabled;
  bool playback_enabled;
  /** Non-NULL selects deterministic file playback instead of CoreAudio. */
  const struct iterate_kit_darwin_audio_file_sink *file_playback;
};

struct iterate_kit_darwin_audio_codec_metrics {
  uint32_t capture_frames;
  uint32_t capture_frames_dropped;
  uint32_t playback_queued_bytes;
  uint32_t playback_completed_bytes;
  uint32_t playback_dropped_bytes;
  uint32_t playback_starved_buffers;
  int32_t capture_platform_error;
  int32_t playback_platform_error;
};

/**
 * Caller-owned CoreAudio codec adapter.
 *
 * CoreAudio owns both sample clocks and calls the bounded SPSC rings from its
 * internal threads. The cooperative owner crosses the portable codec seam;
 * lifecycle and diagnostics remain Darwin-specific because neither is a
 * hardware-independent audio operation. open() may allocate CoreAudio queue
 * resources. After it returns, read(), write(), and pump() do not allocate or
 * block; drain() is the only bounded wait and belongs to shutdown.
 */
struct iterate_kit_darwin_audio_codec {
  struct iterate_kit_audio_codec codec;
  struct iterate_kit_darwin_audio_input input;
  struct iterate_kit_darwin_audio_output output;
  bool capture_enabled;
  bool playback_enabled;
};

enum iterate_kit_status iterate_kit_darwin_audio_codec_open(
    struct iterate_kit_darwin_audio_codec *darwin,
    const struct iterate_kit_darwin_audio_codec_options *options);

void iterate_kit_darwin_audio_codec_close(
    struct iterate_kit_darwin_audio_codec *darwin);

void iterate_kit_darwin_audio_codec_pump(
    struct iterate_kit_darwin_audio_codec *darwin,
    uint64_t now_us);

void iterate_kit_darwin_audio_codec_set_playback_expected(
    struct iterate_kit_darwin_audio_codec *darwin,
    bool expected);

enum iterate_kit_darwin_audio_output_status
iterate_kit_darwin_audio_codec_drain(
    struct iterate_kit_darwin_audio_codec *darwin,
    uint32_t timeout_ms);

void iterate_kit_darwin_audio_codec_metrics(
    const struct iterate_kit_darwin_audio_codec *darwin,
    struct iterate_kit_darwin_audio_codec_metrics *metrics);

#ifdef __cplusplus
}
#endif

#endif
