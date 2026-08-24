#include "iterate/kit/audio_processor.h"

#include <string.h>

#include "iterate/kit/voice_device_profile.h"

/*
 * Passthrough uses the one global wire geometry instead of accepting another
 * copy from each board. A DSP with a genuinely different native cadence, such
 * as StackChan's ESP-SR adapter, supplies its own immutable properties and a
 * cadence bridge at composition time.
 */
static const struct iterate_kit_audio_processor_properties
    passthrough_properties = {
        .sample_rate_hz = ITERATE_KIT_VOICE_SAMPLE_RATE_HZ,
        .frame_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
        .requires_reference_channel = false,
        .uses_playout_activity = false,
};

static enum iterate_kit_status passthrough_reset(void *context) {
  (void)context;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status passthrough_process(
    void *context,
    const struct iterate_kit_audio_processor_frame *frame) {
  (void)context;
  if (frame == NULL || frame->near == NULL || frame->output == NULL) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  memmove(frame->output,
          frame->near,
          frame->sample_count * sizeof(*frame->output));
  return ITERATE_KIT_OK;
}

static const struct iterate_kit_audio_processor_ops passthrough_ops = {
    .reset = passthrough_reset,
    .process = passthrough_process,
};

enum iterate_kit_status iterate_kit_audio_processor_validate(
    const struct iterate_kit_audio_processor *processor) {
  if (processor == NULL || processor->ops == NULL ||
      processor->properties == NULL || processor->ops->reset == NULL ||
      processor->ops->process == NULL ||
      processor->properties->sample_rate_hz == 0U ||
      processor->properties->frame_samples == 0U) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  return ITERATE_KIT_OK;
}

enum iterate_kit_status iterate_kit_audio_processor_process(
    struct iterate_kit_audio_processor *processor,
    const struct iterate_kit_audio_processor_frame *frame) {
  if (iterate_kit_audio_processor_validate(processor) != ITERATE_KIT_OK) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  const bool output_extent_is_safe = frame != NULL &&
      frame->output != NULL &&
      frame->sample_count == processor->properties->frame_samples;
  if (frame == NULL || frame->near == NULL || !output_extent_is_safe ||
      (processor->properties->requires_reference_channel &&
       frame->reference == NULL) ||
      (processor->properties->uses_playout_activity &&
       frame->playout_activity == NULL)) {
    if (output_extent_is_safe) {
      memset(frame->output,
             0,
             frame->sample_count * sizeof(*frame->output));
    }
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  const enum iterate_kit_status status =
      processor->ops->process(processor->context, frame);
  if (status != ITERATE_KIT_OK) {
    memset(frame->output,
           0,
           frame->sample_count * sizeof(*frame->output));
  }
  return status;
}

enum iterate_kit_status iterate_kit_audio_processor_reset(
    struct iterate_kit_audio_processor *processor) {
  if (iterate_kit_audio_processor_validate(processor) != ITERATE_KIT_OK) {
    return ITERATE_KIT_INVALID_ARGUMENT;
  }
  return processor->ops->reset(processor->context);
}

struct iterate_kit_audio_processor iterate_kit_audio_processor_passthrough(
    void) {
  return (struct iterate_kit_audio_processor){
      .ops = &passthrough_ops,
      .properties = &passthrough_properties,
      .context = NULL,
  };
}
