/* iterate_kit_darwin_audio_vpio.c: one VoiceProcessingIO unit feeding the capture ring and draining the playback ring. */

#include <assert.h>
#include <string.h>

#include "iterate/kit/platforms/darwin_audio_vpio.h"

enum {
  ITERATE_KIT_DARWIN_AUDIO_VPIO_OUTPUT_BUS = 0,
  ITERATE_KIT_DARWIN_AUDIO_VPIO_INPUT_BUS = 1,
  ITERATE_KIT_DARWIN_AUDIO_VPIO_BYTES_PER_SAMPLE = 2,
  ITERATE_KIT_DARWIN_AUDIO_VPIO_BITS_PER_BYTE = 8,
};

static OSStatus iterate_kit_darwin_audio_vpio_capture(
    void *context,
    AudioUnitRenderActionFlags *flags,
    const AudioTimeStamp *timestamp,
    UInt32 bus,
    UInt32 frame_count,
    AudioBufferList *unused);

static OSStatus iterate_kit_darwin_audio_vpio_render(
    void *context,
    AudioUnitRenderActionFlags *flags,
    const AudioTimeStamp *timestamp,
    UInt32 bus,
    UInt32 frame_count,
    AudioBufferList *data);

static void iterate_kit_darwin_audio_vpio_remember_error(
    struct iterate_kit_darwin_audio_vpio *vpio, int32_t error);

/* The wire's own format, as CoreAudio spells it. */
static AudioStreamBasicDescription iterate_kit_darwin_audio_vpio_client_format(void)
{
  const AudioStreamBasicDescription format = {
    .mSampleRate = ITERATE_KIT_VOICE_SAMPLE_RATE_HZ,
    .mFormatID = kAudioFormatLinearPCM,
    .mFormatFlags =
        kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
    .mBytesPerPacket = ITERATE_KIT_DARWIN_AUDIO_VPIO_BYTES_PER_SAMPLE,
    .mFramesPerPacket = 1,
    .mBytesPerFrame = ITERATE_KIT_DARWIN_AUDIO_VPIO_BYTES_PER_SAMPLE,
    .mChannelsPerFrame = 1,
    .mBitsPerChannel = ITERATE_KIT_DARWIN_AUDIO_VPIO_BYTES_PER_SAMPLE *
        ITERATE_KIT_DARWIN_AUDIO_VPIO_BITS_PER_BYTE,
  };
  return format;
}

enum iterate_kit_darwin_audio_vpio_status iterate_kit_darwin_audio_vpio_open(
    struct iterate_kit_darwin_audio_vpio *vpio,
    struct iterate_kit_darwin_audio_input *input,
    struct iterate_kit_darwin_audio_output *output)
{
  AudioComponentDescription description;
  AudioComponent component;
  OSStatus result;
  UInt32 enable = 1U;
  UInt32 max_frames = ITERATE_KIT_DARWIN_AUDIO_VPIO_MAX_FRAMES_PER_SLICE;
  const AudioStreamBasicDescription format = iterate_kit_darwin_audio_vpio_client_format();
  AURenderCallbackStruct capture_callback;
  AURenderCallbackStruct render_callback;
  if (vpio == NULL || input == NULL || output == NULL) {
    return ITERATE_KIT_DARWIN_AUDIO_VPIO_ERR_ARG;
  }
  memset(vpio, 0, sizeof(*vpio));
  vpio->input = input;
  vpio->output = output;

  memset(&description, 0, sizeof(description));
  description.componentType = kAudioUnitType_Output;
  description.componentSubType = kAudioUnitSubType_VoiceProcessingIO;
  description.componentManufacturer = kAudioUnitManufacturer_Apple;
  component = AudioComponentFindNext(NULL, &description);
  if (component == NULL) {
    iterate_kit_darwin_audio_vpio_remember_error(vpio, kAudioUnitErr_InvalidElement);
    return ITERATE_KIT_DARWIN_AUDIO_VPIO_ERR_PLATFORM;
  }
  result = AudioComponentInstanceNew(component, &vpio->unit);
  if (result != noErr) {
    vpio->unit = NULL;
    iterate_kit_darwin_audio_vpio_remember_error(vpio, (int32_t)result);
    return ITERATE_KIT_DARWIN_AUDIO_VPIO_ERR_PLATFORM;
  }

  /* Capture on bus 1 is off by default; playback on bus 0 is on. Say both. */
  result = AudioUnitSetProperty(
      vpio->unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input,
      ITERATE_KIT_DARWIN_AUDIO_VPIO_INPUT_BUS, &enable, sizeof(enable));
  if (result == noErr) {
    result = AudioUnitSetProperty(
        vpio->unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output,
        ITERATE_KIT_DARWIN_AUDIO_VPIO_OUTPUT_BUS, &enable, sizeof(enable));
  }
  /*
   * The client formats: what the unit hands us on the capture bus's output
   * side, and what it takes from us on the playback bus's input side. The
   * unit converts to and from whatever the devices actually run at.
   */
  if (result == noErr) {
    result = AudioUnitSetProperty(
        vpio->unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output,
        ITERATE_KIT_DARWIN_AUDIO_VPIO_INPUT_BUS, &format, sizeof(format));
  }
  if (result == noErr) {
    result = AudioUnitSetProperty(
        vpio->unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input,
        ITERATE_KIT_DARWIN_AUDIO_VPIO_OUTPUT_BUS, &format, sizeof(format));
  }
  if (result == noErr) {
    result = AudioUnitSetProperty(
        vpio->unit, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global,
        0U, &max_frames, sizeof(max_frames));
  }
  if (result == noErr) {
    capture_callback.inputProc = iterate_kit_darwin_audio_vpio_capture;
    capture_callback.inputProcRefCon = vpio;
    result = AudioUnitSetProperty(
        vpio->unit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global,
        0U, &capture_callback, sizeof(capture_callback));
  }
  if (result == noErr) {
    render_callback.inputProc = iterate_kit_darwin_audio_vpio_render;
    render_callback.inputProcRefCon = vpio;
    result = AudioUnitSetProperty(
        vpio->unit, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input,
        ITERATE_KIT_DARWIN_AUDIO_VPIO_OUTPUT_BUS, &render_callback, sizeof(render_callback));
  }
  if (result == noErr) result = AudioUnitInitialize(vpio->unit);
  if (result == noErr) {
    atomic_store_explicit(&vpio->running, true, memory_order_release);
    result = AudioOutputUnitStart(vpio->unit);
  }
  if (result != noErr) {
    iterate_kit_darwin_audio_vpio_remember_error(vpio, (int32_t)result);
    iterate_kit_darwin_audio_vpio_close(vpio);
    return ITERATE_KIT_DARWIN_AUDIO_VPIO_ERR_PLATFORM;
  }
  return ITERATE_KIT_DARWIN_AUDIO_VPIO_OK;
}

int32_t iterate_kit_darwin_audio_vpio_platform_error(
    const struct iterate_kit_darwin_audio_vpio *vpio)
{
  return vpio == NULL ? 0 : (int32_t)atomic_load_explicit(
      &vpio->platform_error, memory_order_acquire);
}

void iterate_kit_darwin_audio_vpio_close(struct iterate_kit_darwin_audio_vpio *vpio)
{
  if (vpio == NULL || vpio->unit == NULL) return;
  /* Cleared first so a callback already on the I/O thread does no work. */
  atomic_store_explicit(&vpio->running, false, memory_order_release);
  (void)AudioOutputUnitStop(vpio->unit);
  (void)AudioUnitUninitialize(vpio->unit);
  (void)AudioComponentInstanceDispose(vpio->unit);
  vpio->unit = NULL;
}

/*
 * The unit has captured `frame_count` frames: render them into the staging
 * area, then cut them into wire frames for the ring. A partial frame is
 * carried to the next callback rather than padded, so no click lands in the
 * middle of speech.
 */
static OSStatus iterate_kit_darwin_audio_vpio_capture(
    void *context,
    AudioUnitRenderActionFlags *flags,
    const AudioTimeStamp *timestamp,
    UInt32 bus,
    UInt32 frame_count,
    AudioBufferList *unused)
{
  struct iterate_kit_darwin_audio_vpio *vpio = context;
  AudioBufferList list;
  OSStatus result;
  const uint8_t *bytes;
  size_t remaining;
  (void)unused;
  assert(vpio != NULL);
  if (!atomic_load_explicit(&vpio->running, memory_order_acquire)) return noErr;
  if (frame_count > ITERATE_KIT_DARWIN_AUDIO_VPIO_MAX_FRAMES_PER_SLICE) {
    (void)atomic_fetch_add_explicit(&vpio->oversize_slices, 1U, memory_order_relaxed);
    return noErr;
  }
  list.mNumberBuffers = 1U;
  list.mBuffers[0].mNumberChannels = 1U;
  list.mBuffers[0].mDataByteSize = frame_count * ITERATE_KIT_DARWIN_AUDIO_VPIO_BYTES_PER_SAMPLE;
  list.mBuffers[0].mData = vpio->staging;
  result = AudioUnitRender(vpio->unit, flags, timestamp, bus, frame_count, &list);
  if (result != noErr) {
    iterate_kit_darwin_audio_vpio_remember_error(vpio, (int32_t)result);
    return result;
  }
  bytes = (const uint8_t *)vpio->staging;
  remaining = list.mBuffers[0].mDataByteSize;
  while (remaining > 0U) {
    const size_t room = ITERATE_KIT_VOICE_FRAME_BYTES - vpio->partial_bytes;
    const size_t take = remaining < room ? remaining : room;
    memcpy(vpio->partial + vpio->partial_bytes, bytes, take);
    vpio->partial_bytes += take;
    bytes += take;
    remaining -= take;
    if (vpio->partial_bytes == ITERATE_KIT_VOICE_FRAME_BYTES) {
      (void)iterate_kit_darwin_audio_input_push(
          vpio->input, vpio->partial, ITERATE_KIT_VOICE_FRAME_BYTES);
      vpio->partial_bytes = 0U;
    }
  }
  return noErr;
}

/* The unit wants `frame_count` frames to play: pull them from the ring, silence for the shortfall. */
static OSStatus iterate_kit_darwin_audio_vpio_render(
    void *context,
    AudioUnitRenderActionFlags *flags,
    const AudioTimeStamp *timestamp,
    UInt32 bus,
    UInt32 frame_count,
    AudioBufferList *data)
{
  struct iterate_kit_darwin_audio_vpio *vpio = context;
  UInt32 index;
  (void)flags;
  (void)timestamp;
  (void)bus;
  assert(vpio != NULL && data != NULL);
  for (index = 0U; index < data->mNumberBuffers; ++index) {
    AudioBuffer *buffer = &data->mBuffers[index];
    const uint32_t wanted = frame_count * ITERATE_KIT_DARWIN_AUDIO_VPIO_BYTES_PER_SAMPLE;
    const uint32_t length = buffer->mDataByteSize < wanted ? buffer->mDataByteSize : wanted;
    if (buffer->mData == NULL) continue;
    if (index == 0U && atomic_load_explicit(&vpio->running, memory_order_acquire)) {
      (void)iterate_kit_darwin_audio_output_pull(vpio->output, buffer->mData, length);
    } else {
      memset(buffer->mData, 0, length);
    }
  }
  return noErr;
}

static void iterate_kit_darwin_audio_vpio_remember_error(
    struct iterate_kit_darwin_audio_vpio *vpio, int32_t error)
{
  int_least32_t expected = 0;
  if (vpio == NULL || error == 0) return;
  (void)atomic_compare_exchange_strong_explicit(
      &vpio->platform_error, &expected, (int_least32_t)error,
      memory_order_release, memory_order_relaxed);
}
