#include "iterate/kit/audio_codec.h"
#include "iterate/kit/audio_processor.h"
#include "iterate/kit/voice_device_profile.h"

#include <assert.h>
#include <string.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

struct fake_codec {
  enum iterate_kit_status read_status;
  enum iterate_kit_status write_status;
  size_t read_samples;
  size_t write_samples;
};

static enum iterate_kit_status fake_codec_read(
    void *context,
    int16_t *capture,
    int16_t *reference,
    size_t capacity_samples,
    size_t *sample_count)
{
  struct fake_codec *fake = context;
  if (fake->read_status != ITERATE_KIT_OK) {
    /* Prove the public wrapper removes residue from a failing adapter. */
    *sample_count = SIZE_MAX;
    return fake->read_status;
  }
  assert(capacity_samples >= ITERATE_KIT_VOICE_FRAME_SAMPLES);
  for (size_t index = 0U; index < ITERATE_KIT_VOICE_FRAME_SAMPLES; ++index) {
    capture[index] = (int16_t)index;
    reference[index] = (int16_t)(0 - (int16_t)index);
  }
  *sample_count = fake->read_samples;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status fake_codec_write(
    void *context, const int16_t *playback, size_t sample_count)
{
  struct fake_codec *fake = context;
  assert(playback != NULL);
  fake->write_samples = sample_count;
  return fake->write_status;
}

static const struct iterate_kit_audio_codec_ops fake_codec_ops = {
  .read = fake_codec_read,
  .write = fake_codec_write,
};

static const struct iterate_kit_audio_codec_properties fake_codec_properties = {
  .capture_sample_rate_hz = 16000U,
  .playback_sample_rate_hz = 16000U,
  .capture_channels = 1U,
  .playback_channels = 1U,
  .has_reference_channel = true,
  .has_output_gain_control = true,
  .output_gain_ceiling_centi_db = -1200,
};

static void a_codec_dispatches_complete_aligned_planes(void)
{
  struct fake_codec fake = {
    .read_status = ITERATE_KIT_OK,
    .write_status = ITERATE_KIT_BACKPRESSURE,
    .read_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  };
  struct iterate_kit_audio_codec codec = {
    .ops = &fake_codec_ops,
    .properties = &fake_codec_properties,
    .context = &fake,
  };
  int16_t capture[ITERATE_KIT_VOICE_FRAME_SAMPLES] = {0};
  int16_t reference[ITERATE_KIT_VOICE_FRAME_SAMPLES] = {0};
  size_t sample_count = 99U;

  assert(iterate_kit_audio_codec_validate(&codec) == ITERATE_KIT_OK);
  assert(iterate_kit_audio_codec_read(
             &codec,
             capture,
             reference,
             ITERATE_KIT_VOICE_FRAME_SAMPLES,
             &sample_count) == ITERATE_KIT_OK);
  assert(sample_count == ITERATE_KIT_VOICE_FRAME_SAMPLES);
  assert(capture[13] == 13);
  assert(reference[13] == -13);
  assert(iterate_kit_audio_codec_write(
             &codec, capture, ITERATE_KIT_VOICE_FRAME_SAMPLES) ==
         ITERATE_KIT_BACKPRESSURE);
  assert(fake.write_samples == ITERATE_KIT_VOICE_FRAME_SAMPLES);
}

static void a_codec_refuses_reference_and_property_drift(void)
{
  struct fake_codec fake = {
    .read_status = ITERATE_KIT_UNAVAILABLE,
    .write_status = ITERATE_KIT_OK,
    .read_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  };
  struct iterate_kit_audio_codec codec = {
    .ops = &fake_codec_ops,
    .properties = &fake_codec_properties,
    .context = &fake,
  };
  int16_t capture[ITERATE_KIT_VOICE_FRAME_SAMPLES] = {0};
  int16_t reference[ITERATE_KIT_VOICE_FRAME_SAMPLES] = {0};
  size_t sample_count = 99U;

  assert(iterate_kit_audio_codec_read(
             &codec,
             capture,
             NULL,
             ITERATE_KIT_VOICE_FRAME_SAMPLES,
             &sample_count) == ITERATE_KIT_INVALID_ARGUMENT);
  assert(sample_count == 0U);
  assert(iterate_kit_audio_codec_read(
             &codec,
             capture,
             reference,
             ITERATE_KIT_VOICE_FRAME_SAMPLES,
             &sample_count) == ITERATE_KIT_UNAVAILABLE);
  assert(sample_count == 0U);

  struct iterate_kit_audio_codec_properties broken = fake_codec_properties;
  broken.capture_sample_rate_hz = 0U;
  codec.properties = &broken;
  assert(iterate_kit_audio_codec_validate(&codec) ==
         ITERATE_KIT_INVALID_ARGUMENT);
  sample_count = 51U;
  assert(iterate_kit_audio_codec_read(
             &codec,
             capture,
             reference,
             ITERATE_KIT_VOICE_FRAME_SAMPLES,
             &sample_count) == ITERATE_KIT_INVALID_ARGUMENT);
  assert(sample_count == 0U);
  assert(iterate_kit_audio_codec_read(
             &codec,
             capture,
             reference,
             ITERATE_KIT_VOICE_FRAME_SAMPLES,
             NULL) == ITERATE_KIT_INVALID_ARGUMENT);
  broken = fake_codec_properties;
  broken.has_output_gain_control = false;
  codec.properties = &broken;
  assert(iterate_kit_audio_codec_validate(&codec) ==
         ITERATE_KIT_INVALID_ARGUMENT);

  codec.properties = &fake_codec_properties;
  fake.read_status = ITERATE_KIT_OK;
  fake.read_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES + 1U;
  assert(iterate_kit_audio_codec_read(
             &codec,
             capture,
             reference,
             ITERATE_KIT_VOICE_FRAME_SAMPLES,
             &sample_count) == ITERATE_KIT_IO_ERROR);
  assert(sample_count == 0U);

  fake.read_samples = 0U;
  assert(iterate_kit_audio_codec_read(
             &codec,
             capture,
             reference,
             ITERATE_KIT_VOICE_FRAME_SAMPLES,
             &sample_count) == ITERATE_KIT_IO_ERROR);
  assert(sample_count == 0U);

  broken = fake_codec_properties;
  broken.has_reference_channel = false;
  codec.properties = &broken;
  sample_count = 73U;
  assert(iterate_kit_audio_codec_read(
             &codec,
             capture,
             reference,
             ITERATE_KIT_VOICE_FRAME_SAMPLES,
             &sample_count) == ITERATE_KIT_INVALID_ARGUMENT);
  assert(sample_count == 0U);

  broken = fake_codec_properties;
  broken.output_gain_ceiling_centi_db = 1;
  codec.properties = &broken;
  assert(iterate_kit_audio_codec_validate(&codec) ==
         ITERATE_KIT_INVALID_ARGUMENT);
}

static enum iterate_kit_status failing_process(
    void *context, const struct iterate_kit_audio_processor_frame *frame)
{
  (void)context;
  memset(frame->output, 0x7F,
         frame->sample_count * sizeof(*frame->output));
  return ITERATE_KIT_IO_ERROR;
}

static enum iterate_kit_status successful_reset(void *context)
{
  (void)context;
  return ITERATE_KIT_OK;
}

static enum iterate_kit_status failing_reset(void *context)
{
  (void)context;
  return ITERATE_KIT_STATE_ERROR;
}

static const struct iterate_kit_audio_processor_ops failing_processor_ops = {
  .reset = successful_reset,
  .process = failing_process,
};

static const struct iterate_kit_audio_processor_ops reset_failing_ops = {
  .reset = failing_reset,
  .process = failing_process,
};

static const struct iterate_kit_audio_processor_properties
    failing_processor_properties = {
      .sample_rate_hz = 16000U,
      .frame_samples = ITERATE_KIT_VOICE_FRAME_SAMPLES,
      .requires_reference_channel = true,
      .uses_playout_activity = true,
    };

static void passthrough_is_an_exact_in_place_safe_processor(void)
{
  struct iterate_kit_audio_processor processor =
      iterate_kit_audio_processor_passthrough();
  int16_t near[ITERATE_KIT_VOICE_FRAME_SAMPLES];
  int16_t output[ITERATE_KIT_VOICE_FRAME_SAMPLES];
  for (size_t index = 0U; index < ITERATE_KIT_VOICE_FRAME_SAMPLES; ++index) {
    near[index] = (int16_t)((int16_t)index - 160);
  }
  memset(output, 0x5A, sizeof(output));
  struct iterate_kit_audio_processor_frame frame = {
    .near = near,
    .output = output,
    .sample_count = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  };

  assert(iterate_kit_audio_processor_validate(&processor) == ITERATE_KIT_OK);
  assert(iterate_kit_audio_processor_reset(&processor) == ITERATE_KIT_OK);
  assert(iterate_kit_audio_processor_process(&processor, &frame) ==
         ITERATE_KIT_OK);
  assert(memcmp(output, near, sizeof(near)) == 0);

  frame.output = near;
  assert(iterate_kit_audio_processor_process(&processor, &frame) ==
         ITERATE_KIT_OK);
  assert(near[0] == -160);
  assert(near[319] == 159);
}

static void a_failed_echo_processor_cannot_leak_raw_microphone_audio(void)
{
  struct iterate_kit_audio_processor processor = {
    .ops = &failing_processor_ops,
    .properties = &failing_processor_properties,
  };
  int16_t near[ITERATE_KIT_VOICE_FRAME_SAMPLES];
  int16_t reference[ITERATE_KIT_VOICE_FRAME_SAMPLES];
  int16_t activity[ITERATE_KIT_VOICE_FRAME_SAMPLES];
  int16_t output[ITERATE_KIT_VOICE_FRAME_SAMPLES];
  memset(near, 0x11, sizeof(near));
  memset(reference, 0x22, sizeof(reference));
  memset(activity, 0x33, sizeof(activity));
  memset(output, 0x44, sizeof(output));
  const struct iterate_kit_audio_processor_frame frame = {
    .near = near,
    .reference = reference,
    .playout_activity = activity,
    .output = output,
    .sample_count = ITERATE_KIT_VOICE_FRAME_SAMPLES,
  };

  assert(iterate_kit_audio_processor_process(&processor, &frame) ==
         ITERATE_KIT_IO_ERROR);
  for (size_t index = 0U; index < ITERATE_KIT_VOICE_FRAME_SAMPLES; ++index) {
    assert(output[index] == 0);
  }

  struct iterate_kit_audio_processor_frame missing = frame;
  memset(output, 0x55, sizeof(output));
  missing.reference = NULL;
  assert(iterate_kit_audio_processor_process(&processor, &missing) ==
         ITERATE_KIT_INVALID_ARGUMENT);
  for (size_t index = 0U; index < ITERATE_KIT_VOICE_FRAME_SAMPLES; ++index) {
    assert(output[index] == 0);
  }
  missing = frame;
  memset(output, 0x66, sizeof(output));
  missing.playout_activity = NULL;
  assert(iterate_kit_audio_processor_process(&processor, &missing) ==
         ITERATE_KIT_INVALID_ARGUMENT);
  for (size_t index = 0U; index < ITERATE_KIT_VOICE_FRAME_SAMPLES; ++index) {
    assert(output[index] == 0);
  }

  int16_t unchanged[ITERATE_KIT_VOICE_FRAME_SAMPLES];
  memset(output, 0x77, sizeof(output));
  memcpy(unchanged, output, sizeof(unchanged));
  struct iterate_kit_audio_processor_frame wrong_extent = frame;
  wrong_extent.sample_count = ITERATE_KIT_VOICE_FRAME_SAMPLES - 1U;
  assert(iterate_kit_audio_processor_process(&processor, &wrong_extent) ==
         ITERATE_KIT_INVALID_ARGUMENT);
  assert(memcmp(output, unchanged, sizeof(output)) == 0);

  processor.ops = &reset_failing_ops;
  assert(iterate_kit_audio_processor_reset(&processor) ==
         ITERATE_KIT_STATE_ERROR);
}

int main(void)
{
  a_codec_dispatches_complete_aligned_planes();
  a_codec_refuses_reference_and_property_drift();
  passthrough_is_an_exact_in_place_safe_processor();
  a_failed_echo_processor_cannot_leak_raw_microphone_audio();
  return 0;
}
