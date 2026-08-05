#include "iterate/kit/audio_codec.h"

enum iterate_kit_status iterate_kit_audio_codec_validate(
    const struct iterate_kit_audio_codec *codec) {
  if (codec == NULL || codec->ops == NULL || codec->properties == NULL ||
      codec->ops->read == NULL || codec->ops->write == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  const struct iterate_kit_audio_codec_properties *const properties =
      codec->properties;
  if (properties->capture_sample_rate_hz == 0U ||
      properties->playback_sample_rate_hz == 0U ||
      properties->capture_channels == 0U ||
      properties->playback_channels == 0U ||
      properties->output_gain_ceiling_centi_db > 0 ||
      (!properties->has_output_gain_control &&
       properties->output_gain_ceiling_centi_db != 0)) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_audio_codec_read(
    struct iterate_kit_audio_codec *codec,
    int16_t *capture,
    int16_t *reference,
    size_t capacity_samples,
    size_t *sample_count) {
  if (iterate_kit_audio_codec_validate(codec) != ITERATE_KIT_OK ||
      capture == NULL || capacity_samples == 0U || sample_count == NULL ||
      (codec->properties->has_reference_channel != (reference != NULL))) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  *sample_count = 0U;
  const enum iterate_kit_status status = codec->ops->read(codec->context,
                                                           capture,
                                                           reference,
                                                           capacity_samples,
                                                           sample_count);
  if (status != ITERATE_KIT_OK) {
    *sample_count = 0U;
    return status;
  }
  if (*sample_count == 0U || *sample_count > capacity_samples) {
    *sample_count = 0U;
    return ITERATE_KIT_IO_ERROR;
  }
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_audio_codec_write(
    struct iterate_kit_audio_codec *codec,
    const int16_t *playback,
    size_t sample_count) {
  if (iterate_kit_audio_codec_validate(codec) != ITERATE_KIT_OK ||
      playback == NULL || sample_count == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  return codec->ops->write(codec->context, playback, sample_count);
}
