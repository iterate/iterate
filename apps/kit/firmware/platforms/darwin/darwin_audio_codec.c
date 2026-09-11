#include "iterate/kit/platforms/darwin_audio_codec.h"

#include <stdatomic.h>
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
    .has_reference_channel = false,
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
  /*
   * ECHO CANCELLATION FIRST. A live microphone beside a live speaker is the
   * one configuration where the far end hears itself; both then go through
   * the voice-processing unit, and the queues below are the fallback. A
   * pretend speaker has no room to echo in, so it keeps the plain queue.
   */
  if ((options->capture_enabled || options->force_voice_processing) &&
      options->playback_enabled && options->file_playback == NULL &&
      !options->echo_cancellation_off) {
    if (iterate_kit_darwin_audio_output_open_pulled(&darwin->output, options->render_tap) ==
            ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK &&
        iterate_kit_darwin_audio_input_open_external(&darwin->input) ==
            ITERATE_KIT_DARWIN_AUDIO_INPUT_OK &&
        iterate_kit_darwin_audio_vpio_open(&darwin->vpio, &darwin->input, &darwin->output) ==
            ITERATE_KIT_DARWIN_AUDIO_VPIO_OK) {
      darwin->voice_processing_active = true;
      return iterate_kit_audio_codec_validate(&darwin->codec);
    }
    /* Remember why, then take the plain path below with fresh rings. */
    {
      const int32_t reason = iterate_kit_darwin_audio_vpio_platform_error(&darwin->vpio);
      iterate_kit_darwin_audio_output_close(&darwin->output);
      iterate_kit_darwin_audio_input_close(&darwin->input);
      memset(&darwin->vpio, 0, sizeof(darwin->vpio));
      atomic_store(&darwin->vpio.platform_error, (int_least32_t)reason);
    }
  }
  if (options->playback_enabled) {
    const enum iterate_kit_darwin_audio_output_status status =
        options->file_playback == NULL
        ? iterate_kit_darwin_audio_output_open(&darwin->output, options->render_tap)
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
  /* The unit first: it is what calls into the rings from the I/O thread. */
  iterate_kit_darwin_audio_vpio_close(&darwin->vpio);
  iterate_kit_darwin_audio_output_close(&darwin->output);
  iterate_kit_darwin_audio_input_close(&darwin->input);
  darwin->capture_enabled = false;
  darwin->playback_enabled = false;
  darwin->voice_processing_active = false;
}

void iterate_kit_darwin_audio_codec_pump(
    struct iterate_kit_darwin_audio_codec *darwin,
    uint64_t now_us) {
  if (darwin != NULL && darwin->playback_enabled) {
    iterate_kit_darwin_audio_output_pump(&darwin->output, now_us);
  }
}

uint32_t iterate_kit_darwin_audio_codec_playback_lead_bytes(
    const struct iterate_kit_darwin_audio_codec *darwin) {
  if (darwin == NULL || !darwin->playback_enabled) {
    return 0U;
  }
  return iterate_kit_darwin_audio_output_lead_bytes(&darwin->output);
}

uint32_t iterate_kit_darwin_audio_codec_discard_playback(
    struct iterate_kit_darwin_audio_codec *darwin) {
  if (darwin == NULL || !darwin->playback_enabled) {
    return 0U;
  }
  return iterate_kit_darwin_audio_output_discard(&darwin->output);
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
  metrics->voice_processing_active = darwin->voice_processing_active;
  metrics->voice_processing_error =
      iterate_kit_darwin_audio_vpio_platform_error(&darwin->vpio);
  metrics->vpio_capture_callbacks =
      (uint32_t)atomic_load_explicit(&darwin->vpio.capture_callbacks, memory_order_relaxed);
  metrics->vpio_capture_frames_pushed =
      (uint32_t)atomic_load_explicit(&darwin->vpio.capture_frames_pushed, memory_order_relaxed);
  metrics->vpio_capture_short_renders =
      (uint32_t)atomic_load_explicit(&darwin->vpio.capture_short_renders, memory_order_relaxed);
  metrics->vpio_render_requests =
      (uint32_t)atomic_load_explicit(&darwin->vpio.render_requests, memory_order_relaxed);
  metrics->vpio_render_shortfall_bytes =
      (uint32_t)atomic_load_explicit(&darwin->vpio.render_shortfall_bytes, memory_order_relaxed);
  metrics->vpio_render_unaligned_requests = (uint32_t)atomic_load_explicit(
      &darwin->vpio.render_unaligned_requests, memory_order_relaxed);
  metrics->playback_pull_reprimes =
      iterate_kit_darwin_audio_output_pull_reprimes(&darwin->output);
  metrics->render_tap_bytes =
      iterate_kit_darwin_audio_output_tap_bytes(&darwin->output);
  metrics->render_tap_dropped_bytes =
      iterate_kit_darwin_audio_output_tap_dropped_bytes(&darwin->output);
}
