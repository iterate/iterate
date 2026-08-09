#include "iterate/kit/platforms/darwin_audio_codec.h"

#include "iterate/kit/voice_device_profile.h"

#include <assert.h>
#include <string.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

static bool discard_file_frame(
    void *context, const uint8_t *pcm, size_t length)
{
  (void)context;
  return pcm != NULL && length == ITERATE_KIT_VOICE_FRAME_BYTES;
}

static void a_disabled_adapter_is_explicitly_unavailable(void)
{
  struct iterate_kit_darwin_audio_codec darwin;
  const struct iterate_kit_darwin_audio_codec_options options = {0};
  int16_t frame[ITERATE_KIT_VOICE_FRAME_SAMPLES] = {0};
  size_t sample_count = 91U;

  assert(iterate_kit_darwin_audio_codec_open(&darwin, &options) ==
         ITERATE_KIT_OK);
  assert(darwin.codec.properties->capture_sample_rate_hz == 16000U);
  assert(darwin.codec.properties->playback_sample_rate_hz == 16000U);
  assert(!darwin.codec.properties->has_reference_channel);
  assert(iterate_kit_audio_codec_read(
             &darwin.codec,
             frame,
             NULL,
             ITERATE_KIT_VOICE_FRAME_SAMPLES,
             &sample_count) == ITERATE_KIT_UNAVAILABLE);
  assert(sample_count == 0U);
  assert(iterate_kit_audio_codec_write(
             &darwin.codec, frame, ITERATE_KIT_VOICE_FRAME_SAMPLES) ==
         ITERATE_KIT_UNAVAILABLE);

  struct iterate_kit_darwin_audio_codec_metrics metrics;
  memset(&metrics, 0x7F, sizeof(metrics));
  iterate_kit_darwin_audio_codec_metrics(&darwin, &metrics);
  assert(metrics.capture_frames == 0U);
  assert(metrics.capture_frames_dropped == 0U);
  assert(metrics.playback_completed_bytes == 0U);
  assert(metrics.playback_dropped_bytes == 0U);
  assert(metrics.capture_platform_error == 0);
  assert(metrics.playback_platform_error == 0);
  iterate_kit_darwin_audio_codec_close(&darwin);
}

static void a_file_clock_requires_enabled_playback(void)
{
  struct iterate_kit_darwin_audio_codec darwin;
  const struct iterate_kit_darwin_audio_file_sink sink = {
    .write = discard_file_frame,
  };
  const struct iterate_kit_darwin_audio_codec_options options = {
    .file_playback = &sink,
  };

  assert(iterate_kit_darwin_audio_codec_open(&darwin, &options) ==
         ITERATE_KIT_INVALID_ARGUMENT);
  assert(iterate_kit_darwin_audio_codec_open(NULL, &options) ==
         ITERATE_KIT_INVALID_ARGUMENT);

  const struct iterate_kit_darwin_audio_file_sink unusable_sink = {0};
  const struct iterate_kit_darwin_audio_codec_options unusable_options = {
    .playback_enabled = true,
    .file_playback = &unusable_sink,
  };
  assert(iterate_kit_darwin_audio_codec_open(&darwin, &unusable_options) ==
         ITERATE_KIT_INVALID_ARGUMENT);
  iterate_kit_darwin_audio_codec_close(NULL);
}

static void file_playback_maps_a_full_ring_to_backpressure(void)
{
  struct iterate_kit_darwin_audio_codec darwin;
  const struct iterate_kit_darwin_audio_file_sink sink = {
    .write = discard_file_frame,
  };
  const struct iterate_kit_darwin_audio_codec_options options = {
    .playback_enabled = true,
    .file_playback = &sink,
  };
  int16_t frame[ITERATE_KIT_VOICE_FRAME_SAMPLES] = {0};

  assert(iterate_kit_darwin_audio_codec_open(&darwin, &options) ==
         ITERATE_KIT_OK);
  for (size_t index = 0U;
       index < ITERATE_KIT_DARWIN_AUDIO_OUTPUT_RING_BYTES /
           ITERATE_KIT_VOICE_FRAME_BYTES;
       ++index) {
    assert(iterate_kit_audio_codec_write(
               &darwin.codec, frame, ITERATE_KIT_VOICE_FRAME_SAMPLES) ==
           ITERATE_KIT_OK);
  }
  assert(iterate_kit_audio_codec_write(
             &darwin.codec, frame, ITERATE_KIT_VOICE_FRAME_SAMPLES) ==
         ITERATE_KIT_BACKPRESSURE);
  iterate_kit_darwin_audio_codec_close(&darwin);
}

int main(void)
{
  a_disabled_adapter_is_explicitly_unavailable();
  a_file_clock_requires_enabled_playback();
  file_playback_maps_a_full_ring_to_backpressure();
  return 0;
}
