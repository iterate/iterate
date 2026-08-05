#include "iterate/kit/platforms/darwin_audio_codec.h"

#include <string.h>

#include "iterate/kit/voice_device_profile.h"

enum { DARWIN_AUDIO_BYTES_PER_SAMPLE = 2 };

/*
 * Geometry is derived from the global wire contract rather than copied into a
 * Mac profile. CoreAudio converts the default devices to this exact format at
 * its queue boundary, so these are adapter facts after conversion—not claims
 * about the native USB/Bluetooth device behind the default route.
 */
static const struct iterate_kit_audio_codec_properties darwin_properties = {
    .capture_sample_rate_hz = ITERATE_KIT_VOICE_SAMPLE_RATE_HZ,
    .playback_sample_rate_hz = ITERATE_KIT_VOICE_SAMPLE_RATE_HZ,
    .capture_channels = 1U,
    .playback_channels = 1U,
    .full_duplex = true,
    .has_reference_channel = false,
    .capture_is_echo_cancelled = false,
    .capture_clock_is_hardware_owned = true,
    .playback_clock_is_hardware_owned = true,
    .has_output_gain_control = false,
    .output_gain_ceiling_centi_db = 0,
};

static enum iterate_kit_status darwin_read(void *context,
                                           int16_t *capture,
                                           int16_t *reference,
                                           size_t capacity_samples,
                                           size_t *sample_count) {
  struct iterate_kit_darwin_audio_codec *const darwin = context;
  if (darwin == NULL || capture == NULL || reference != NULL ||
      sample_count == NULL ||
      capacity_samples < ITERATE_KIT_VOICE_FRAME_SAMPLES) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (!darwin->capture_enabled) {
    return ITERATE_KIT_UNAVAILABLE;
  }
  const enum iterate_kit_darwin_audio_input_status status =
      iterate_kit_darwin_audio_input_pop(
          &darwin->input,
          (uint8_t *)capture,
          ITERATE_KIT_VOICE_FRAME_BYTES);
  if (status == ITERATE_KIT_DARWIN_AUDIO_INPUT_ERR_EMPTY) {
    return ITERATE_KIT_UNAVAILABLE;
  }
  if (status != ITERATE_KIT_DARWIN_AUDIO_INPUT_OK) {
    return status == ITERATE_KIT_DARWIN_AUDIO_INPUT_ERR_ARG
        ? ITERATE_KIT_INVALID_ARGUMENT
        : ITERATE_KIT_IO_ERROR;
  }
  *sample_count = ITERATE_KIT_VOICE_FRAME_SAMPLES;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status darwin_write(void *context,
                                            const int16_t *playback,
                                            size_t sample_count) {
  struct iterate_kit_darwin_audio_codec *const darwin = context;
  if (darwin == NULL || playback == NULL ||
      sample_count != ITERATE_KIT_VOICE_FRAME_SAMPLES) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  if (!darwin->playback_enabled) {
    return ITERATE_KIT_UNAVAILABLE;
  }
  const enum iterate_kit_darwin_audio_output_status status =
      iterate_kit_darwin_audio_output_write(
          &darwin->output,
          (const uint8_t *)playback,
          sample_count * DARWIN_AUDIO_BYTES_PER_SAMPLE);
  switch (status) {
    case ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK:
      return ITERATE_KIT_OK;
    case ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_FULL:
      return ITERATE_KIT_BACKPRESSURE;
    case ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_ARG:
      return ITERATE_KIT_INVALID_ARGUMENT;
    case ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_PLATFORM:
    case ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_TIMEOUT:
      return ITERATE_KIT_IO_ERROR;
  }
  return ITERATE_KIT_IO_ERROR;
}

static const struct iterate_kit_audio_codec_ops darwin_ops = {
    .read = darwin_read,
    .write = darwin_write,
};

enum iterate_kit_status iterate_kit_darwin_audio_codec_open(
    struct iterate_kit_darwin_audio_codec *darwin,
    const struct iterate_kit_darwin_audio_codec_options *options) {
  if (darwin == NULL || options == NULL ||
      (options->file_playback != NULL &&
       (!options->playback_enabled || options->file_playback->write == NULL))) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memset(darwin, 0, sizeof(*darwin));
  darwin->codec = (struct iterate_kit_audio_codec){
      .ops = &darwin_ops,
      .properties = &darwin_properties,
      .context = darwin,
  };
  darwin->capture_enabled = options->capture_enabled;
  darwin->playback_enabled = options->playback_enabled;
  if (options->playback_enabled) {
    const enum iterate_kit_darwin_audio_output_status status =
        options->file_playback == NULL
        ? iterate_kit_darwin_audio_output_open(&darwin->output)
        : iterate_kit_darwin_audio_output_open_file(
              &darwin->output, options->file_playback);
    if (status != ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK) {
      iterate_kit_darwin_audio_codec_close(darwin);
      return ITERATE_KIT_IO_ERROR;
    }
  }
  if (options->capture_enabled &&
      iterate_kit_darwin_audio_input_open(&darwin->input) !=
          ITERATE_KIT_DARWIN_AUDIO_INPUT_OK) {
    iterate_kit_darwin_audio_codec_close(darwin);
    return ITERATE_KIT_IO_ERROR;
  }
  return iterate_kit_audio_codec_validate(&darwin->codec);
}

void iterate_kit_darwin_audio_codec_close(
    struct iterate_kit_darwin_audio_codec *darwin) {
  if (darwin == NULL) {
    return;
  }
  iterate_kit_darwin_audio_output_close(&darwin->output);
  iterate_kit_darwin_audio_input_close(&darwin->input);
  darwin->capture_enabled = false;
  darwin->playback_enabled = false;
}

void iterate_kit_darwin_audio_codec_pump(
    struct iterate_kit_darwin_audio_codec *darwin,
    uint64_t now_us) {
  if (darwin != NULL && darwin->playback_enabled) {
    iterate_kit_darwin_audio_output_pump(&darwin->output, now_us);
  }
}

void iterate_kit_darwin_audio_codec_set_playback_expected(
    struct iterate_kit_darwin_audio_codec *darwin,
    bool expected) {
  if (darwin != NULL && darwin->playback_enabled) {
    iterate_kit_darwin_audio_output_set_expected(&darwin->output, expected);
  }
}

enum iterate_kit_darwin_audio_output_status
iterate_kit_darwin_audio_codec_drain(
    struct iterate_kit_darwin_audio_codec *darwin,
    uint32_t timeout_ms) {
  if (darwin == NULL || timeout_ms == 0U) {
    return ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_ARG;
  }
  if (!darwin->playback_enabled) {
    return ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK;
  }
  return iterate_kit_darwin_audio_output_drain(&darwin->output, timeout_ms);
}

void iterate_kit_darwin_audio_codec_metrics(
    const struct iterate_kit_darwin_audio_codec *darwin,
    struct iterate_kit_darwin_audio_codec_metrics *metrics) {
  if (metrics == NULL) {
    return;
  }
  memset(metrics, 0, sizeof(*metrics));
  if (darwin == NULL) {
    return;
  }
  metrics->capture_frames =
      iterate_kit_darwin_audio_input_captured_frames(&darwin->input);
  metrics->capture_frames_dropped = darwin->input.dropped;
  metrics->playback_queued_bytes =
      iterate_kit_darwin_audio_output_queued_bytes(&darwin->output);
  metrics->playback_completed_bytes =
      iterate_kit_darwin_audio_output_completed_bytes(&darwin->output);
  metrics->playback_dropped_bytes = darwin->output.dropped;
  metrics->playback_starved_buffers =
      iterate_kit_darwin_audio_output_starved_buffers(&darwin->output);
  metrics->capture_platform_error =
      iterate_kit_darwin_audio_input_platform_error(&darwin->input);
  metrics->playback_platform_error =
      iterate_kit_darwin_audio_output_platform_error(&darwin->output);
}
