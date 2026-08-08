/* iterate_kit_darwin_audio_input.c: owns the CoreAudio capture queue and its handoff ring. */

#include <assert.h>
#include <errno.h>
#include <string.h>

#include "iterate/kit/platforms/darwin_audio_input.h"

enum {
  ITERATE_KIT_DARWIN_AUDIO_INPUT_SAMPLE_RATE_HZ =
      ITERATE_KIT_VOICE_SAMPLE_RATE_HZ,
  ITERATE_KIT_DARWIN_AUDIO_INPUT_BYTES_PER_SAMPLE = 2,
  ITERATE_KIT_DARWIN_AUDIO_INPUT_CHANNELS = 1,
  ITERATE_KIT_DARWIN_AUDIO_INPUT_FRAMES_PER_PACKET = 1,
  ITERATE_KIT_DARWIN_AUDIO_INPUT_BITS_PER_BYTE = 8,
  /*
   * One slot of headroom between producer and consumer, so the frame the
   * capture thread is writing is never the frame the poll owner is reading.
   */
  ITERATE_KIT_DARWIN_AUDIO_INPUT_USABLE_FRAMES = ITERATE_KIT_DARWIN_AUDIO_INPUT_RING_FRAMES - 1,
};

/* Receives one filled buffer on CoreAudio's capture thread and requeues it. */
static void iterate_kit_darwin_audio_input_captured(
    void *context,
    AudioQueueRef queue,
    AudioQueueBufferRef buffer,
    const AudioTimeStamp *start,
    UInt32 packet_count,
    const AudioStreamPacketDescription *packets);

/* Discards whole frames the consumer fell behind on. Returns frames pending. */
static uint32_t iterate_kit_darwin_audio_input_catch_up(struct iterate_kit_darwin_audio_input *in);

/* Releases resources acquired before an open failure. */
static void iterate_kit_darwin_audio_input_abandon_open(struct iterate_kit_darwin_audio_input *in);

static void iterate_kit_darwin_audio_input_remember_error(
    struct iterate_kit_darwin_audio_input *in, int32_t error);

enum iterate_kit_darwin_audio_input_status iterate_kit_darwin_audio_input_open(struct iterate_kit_darwin_audio_input *in)
{
  if (in == NULL) return ITERATE_KIT_DARWIN_AUDIO_INPUT_ERR_ARG;
  memset(in, 0, sizeof(*in));
  const AudioStreamBasicDescription format = {
    .mSampleRate = ITERATE_KIT_DARWIN_AUDIO_INPUT_SAMPLE_RATE_HZ,
    .mFormatID = kAudioFormatLinearPCM,
    .mFormatFlags =
        kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
    .mBytesPerPacket = ITERATE_KIT_DARWIN_AUDIO_INPUT_BYTES_PER_SAMPLE,
    .mFramesPerPacket = ITERATE_KIT_DARWIN_AUDIO_INPUT_FRAMES_PER_PACKET,
    .mBytesPerFrame = ITERATE_KIT_DARWIN_AUDIO_INPUT_BYTES_PER_SAMPLE,
    .mChannelsPerFrame = ITERATE_KIT_DARWIN_AUDIO_INPUT_CHANNELS,
    .mBitsPerChannel =
        ITERATE_KIT_DARWIN_AUDIO_INPUT_BYTES_PER_SAMPLE * ITERATE_KIT_DARWIN_AUDIO_INPUT_BITS_PER_BYTE,
  };
  OSStatus result = AudioQueueNewInput(
      &format, iterate_kit_darwin_audio_input_captured, in, NULL, NULL, 0U, &in->queue);
  if (result != noErr) {
    iterate_kit_darwin_audio_input_remember_error(in, (int32_t)result);
    return ITERATE_KIT_DARWIN_AUDIO_INPUT_ERR_PLATFORM;
  }
  for (size_t index = 0U; index < ITERATE_KIT_DARWIN_AUDIO_INPUT_BUFFER_COUNT; ++index) {
    result = AudioQueueAllocateBuffer(
        in->queue, ITERATE_KIT_VOICE_FRAME_BYTES, &in->buffers[index]);
    if (result == noErr) {
      result = AudioQueueEnqueueBuffer(in->queue, in->buffers[index], 0U, NULL);
    }
    if (result != noErr) {
      iterate_kit_darwin_audio_input_remember_error(in, (int32_t)result);
      iterate_kit_darwin_audio_input_abandon_open(in);
      return ITERATE_KIT_DARWIN_AUDIO_INPUT_ERR_PLATFORM;
    }
  }
  atomic_store_explicit(&in->enabled, true, memory_order_release);
  result = AudioQueueStart(in->queue, NULL);
  if (result != noErr) {
    iterate_kit_darwin_audio_input_remember_error(in, (int32_t)result);
    iterate_kit_darwin_audio_input_abandon_open(in);
    return ITERATE_KIT_DARWIN_AUDIO_INPUT_ERR_PLATFORM;
  }
  return ITERATE_KIT_DARWIN_AUDIO_INPUT_OK;
}

enum iterate_kit_darwin_audio_input_status iterate_kit_darwin_audio_input_push(
    struct iterate_kit_darwin_audio_input *in, const uint8_t *pcm, size_t length)
{
  if (in == NULL || pcm == NULL) return ITERATE_KIT_DARWIN_AUDIO_INPUT_ERR_ARG;
  if (length != ITERATE_KIT_VOICE_FRAME_BYTES) {
    (void)atomic_fetch_add_explicit(
        &in->short_buffers, 1U, memory_order_relaxed);
    return ITERATE_KIT_DARWIN_AUDIO_INPUT_ERR_ARG;
  }
  const uint32_t write =
      (uint32_t)atomic_load_explicit(&in->write, memory_order_relaxed);
  memcpy(in->frames[write % ITERATE_KIT_DARWIN_AUDIO_INPUT_RING_FRAMES], pcm, length);
  /* Release publishes the frame before the index that makes it visible. */
  atomic_store_explicit(&in->write, write + 1U, memory_order_release);
  (void)atomic_fetch_add_explicit(
      &in->captured, 1U, memory_order_relaxed);
  return ITERATE_KIT_DARWIN_AUDIO_INPUT_OK;
}

uint32_t iterate_kit_darwin_audio_input_captured_frames(const struct iterate_kit_darwin_audio_input *in)
{
  return in == NULL ? 0U : (uint32_t)atomic_load_explicit(
      &in->captured, memory_order_acquire);
}

int32_t iterate_kit_darwin_audio_input_platform_error(const struct iterate_kit_darwin_audio_input *in)
{
  return in == NULL ? 0 : (int32_t)atomic_load_explicit(
      &in->platform_error, memory_order_acquire);
}

enum iterate_kit_darwin_audio_input_status iterate_kit_darwin_audio_input_pop(
    struct iterate_kit_darwin_audio_input *in, uint8_t *out, size_t length)
{
  if (in == NULL || out == NULL || length != ITERATE_KIT_VOICE_FRAME_BYTES) {
    return ITERATE_KIT_DARWIN_AUDIO_INPUT_ERR_ARG;
  }
  if (iterate_kit_darwin_audio_input_catch_up(in) == 0U) return ITERATE_KIT_DARWIN_AUDIO_INPUT_ERR_EMPTY;
  memcpy(out, in->frames[in->read % ITERATE_KIT_DARWIN_AUDIO_INPUT_RING_FRAMES], length);
  ++in->read;
  return ITERATE_KIT_DARWIN_AUDIO_INPUT_OK;
}

void iterate_kit_darwin_audio_input_close(struct iterate_kit_darwin_audio_input *in)
{
  if (in == NULL || in->queue == NULL) return;
  atomic_store_explicit(&in->enabled, false, memory_order_release);
  {
    const OSStatus stop = AudioQueueStop(in->queue, true);
    if (stop != noErr) iterate_kit_darwin_audio_input_remember_error(in, (int32_t)stop);
  }
  {
    const OSStatus dispose = AudioQueueDispose(in->queue, true);
    if (dispose != noErr) iterate_kit_darwin_audio_input_remember_error(in, (int32_t)dispose);
  }
  in->queue = NULL;
}

static uint32_t iterate_kit_darwin_audio_input_catch_up(struct iterate_kit_darwin_audio_input *in)
{
  assert(in != NULL);
  /* Acquire pairs with the producer's release; the frame is complete. */
  const uint32_t write =
      (uint32_t)atomic_load_explicit(&in->write, memory_order_acquire);
  const uint32_t pending = write - in->read;
  if (pending <= ITERATE_KIT_DARWIN_AUDIO_INPUT_USABLE_FRAMES) return pending;
  /*
   * The consumer has been away for a whole ring. What is here is stale
   * speech; keeping it would send a sentence that trails further behind the
   * speaker with every frame, so the oldest go and the count says how many.
   */
  const uint32_t lost = pending - ITERATE_KIT_DARWIN_AUDIO_INPUT_USABLE_FRAMES;
  in->read += lost;
  in->dropped += lost;
  return ITERATE_KIT_DARWIN_AUDIO_INPUT_USABLE_FRAMES;
}

static void iterate_kit_darwin_audio_input_captured(
    void *context,
    AudioQueueRef queue,
    AudioQueueBufferRef buffer,
    const AudioTimeStamp *start,
    UInt32 packet_count,
    const AudioStreamPacketDescription *packets)
{
  (void)start;
  (void)packet_count;
  (void)packets;
  struct iterate_kit_darwin_audio_input *in = context;
  enum iterate_kit_darwin_audio_input_status push;
  OSStatus enqueue;
  assert(in != NULL && buffer != NULL);
  if (!atomic_load_explicit(&in->enabled, memory_order_acquire)) return;
  push = iterate_kit_darwin_audio_input_push(in, buffer->mAudioData, buffer->mAudioDataByteSize);
  if (push != ITERATE_KIT_DARWIN_AUDIO_INPUT_OK && push != ITERATE_KIT_DARWIN_AUDIO_INPUT_ERR_ARG) {
    iterate_kit_darwin_audio_input_remember_error(in, EIO);
    atomic_store_explicit(&in->enabled, false, memory_order_release);
    return;
  }
  /* Requeue unconditionally: a buffer not returned is capture stopping dead. */
  enqueue = AudioQueueEnqueueBuffer(queue, buffer, 0U, NULL);
  if (enqueue != noErr) {
    iterate_kit_darwin_audio_input_remember_error(in, (int32_t)enqueue);
    atomic_store_explicit(&in->enabled, false, memory_order_release);
  }
}

static void iterate_kit_darwin_audio_input_abandon_open(struct iterate_kit_darwin_audio_input *in)
{
  assert(in != NULL && in->queue != NULL);
  atomic_store_explicit(&in->enabled, false, memory_order_release);
  {
    const OSStatus result = AudioQueueDispose(in->queue, true);
    if (result != noErr) iterate_kit_darwin_audio_input_remember_error(in, (int32_t)result);
  }
  in->queue = NULL;
}

static void iterate_kit_darwin_audio_input_remember_error(
    struct iterate_kit_darwin_audio_input *in, int32_t error)
{
  int_least32_t expected = 0;
  if (in == NULL || error == 0) return;
  (void)atomic_compare_exchange_strong_explicit(
      &in->platform_error, &expected, (int_least32_t)error,
      memory_order_release, memory_order_relaxed);
}
