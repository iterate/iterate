/* cli_audio_in.c: owns the CoreAudio capture queue and its handoff ring. */

#include <assert.h>
#include <errno.h>
#include <string.h>

#include "cli_audio_in.h"

enum {
  CLI_AUDIO_IN_SAMPLE_RATE_HZ = 16000,
  CLI_AUDIO_IN_BYTES_PER_SAMPLE = 2,
  CLI_AUDIO_IN_CHANNELS = 1,
  CLI_AUDIO_IN_FRAMES_PER_PACKET = 1,
  CLI_AUDIO_IN_BITS_PER_BYTE = 8,
  /*
   * One slot of headroom between producer and consumer, so the frame the
   * capture thread is writing is never the frame the poll owner is reading.
   */
  CLI_AUDIO_IN_USABLE_FRAMES = CLI_AUDIO_IN_RING_FRAMES - 1,
};

/* Receives one filled buffer on CoreAudio's capture thread and requeues it. */
static void cli_audio_in_captured(
    void *context,
    AudioQueueRef queue,
    AudioQueueBufferRef buffer,
    const AudioTimeStamp *start,
    UInt32 packet_count,
    const AudioStreamPacketDescription *packets);

/* Discards whole frames the consumer fell behind on. Returns frames pending. */
static uint32_t cli_audio_in_catch_up(struct cli_audio_in *in);

/* Releases resources acquired before an open failure. */
static void cli_audio_in_abandon_open(struct cli_audio_in *in);

static void cli_audio_in_remember_error(
    struct cli_audio_in *in, int32_t error);

const char *cli_audio_in_status_name(enum cli_audio_in_status status)
{
  switch (status) {
    case CLI_AUDIO_IN_OK: return "ok";
    case CLI_AUDIO_IN_ERR_ARG: return "bad-argument";
    case CLI_AUDIO_IN_ERR_PLATFORM: return "coreaudio";
    case CLI_AUDIO_IN_ERR_EMPTY: return "empty";
    default: return "unknown";
  }
}

enum cli_audio_in_status cli_audio_in_open(struct cli_audio_in *in)
{
  if (in == NULL) return CLI_AUDIO_IN_ERR_ARG;
  memset(in, 0, sizeof(*in));
  const AudioStreamBasicDescription format = {
    .mSampleRate = CLI_AUDIO_IN_SAMPLE_RATE_HZ,
    .mFormatID = kAudioFormatLinearPCM,
    .mFormatFlags =
        kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
    .mBytesPerPacket = CLI_AUDIO_IN_BYTES_PER_SAMPLE,
    .mFramesPerPacket = CLI_AUDIO_IN_FRAMES_PER_PACKET,
    .mBytesPerFrame = CLI_AUDIO_IN_BYTES_PER_SAMPLE,
    .mChannelsPerFrame = CLI_AUDIO_IN_CHANNELS,
    .mBitsPerChannel =
        CLI_AUDIO_IN_BYTES_PER_SAMPLE * CLI_AUDIO_IN_BITS_PER_BYTE,
  };
  OSStatus result = AudioQueueNewInput(
      &format, cli_audio_in_captured, in, NULL, NULL, 0U, &in->queue);
  if (result != noErr) {
    cli_audio_in_remember_error(in, (int32_t)result);
    return CLI_AUDIO_IN_ERR_PLATFORM;
  }
  for (size_t index = 0U; index < CLI_AUDIO_IN_BUFFER_COUNT; ++index) {
    result = AudioQueueAllocateBuffer(
        in->queue, ITERATE_KIT_VOICE_FRAME_BYTES, &in->buffers[index]);
    if (result == noErr) {
      result = AudioQueueEnqueueBuffer(in->queue, in->buffers[index], 0U, NULL);
    }
    if (result != noErr) {
      cli_audio_in_remember_error(in, (int32_t)result);
      cli_audio_in_abandon_open(in);
      return CLI_AUDIO_IN_ERR_PLATFORM;
    }
  }
  atomic_store_explicit(&in->enabled, true, memory_order_release);
  result = AudioQueueStart(in->queue, NULL);
  if (result != noErr) {
    cli_audio_in_remember_error(in, (int32_t)result);
    cli_audio_in_abandon_open(in);
    return CLI_AUDIO_IN_ERR_PLATFORM;
  }
  return CLI_AUDIO_IN_OK;
}

enum cli_audio_in_status cli_audio_in_push(
    struct cli_audio_in *in, const uint8_t *pcm, size_t length)
{
  if (in == NULL || pcm == NULL) return CLI_AUDIO_IN_ERR_ARG;
  if (length != ITERATE_KIT_VOICE_FRAME_BYTES) {
    (void)atomic_fetch_add_explicit(
        &in->short_buffers, 1U, memory_order_relaxed);
    return CLI_AUDIO_IN_ERR_ARG;
  }
  const uint32_t write =
      (uint32_t)atomic_load_explicit(&in->write, memory_order_relaxed);
  memcpy(in->frames[write % CLI_AUDIO_IN_RING_FRAMES], pcm, length);
  /* Release publishes the frame before the index that makes it visible. */
  atomic_store_explicit(&in->write, write + 1U, memory_order_release);
  (void)atomic_fetch_add_explicit(
      &in->captured, 1U, memory_order_relaxed);
  return CLI_AUDIO_IN_OK;
}

uint32_t cli_audio_in_captured_frames(const struct cli_audio_in *in)
{
  return in == NULL ? 0U : (uint32_t)atomic_load_explicit(
      &in->captured, memory_order_acquire);
}

int32_t cli_audio_in_platform_error(const struct cli_audio_in *in)
{
  return in == NULL ? 0 : (int32_t)atomic_load_explicit(
      &in->platform_error, memory_order_acquire);
}

enum cli_audio_in_status cli_audio_in_pop(
    struct cli_audio_in *in, uint8_t *out, size_t length)
{
  if (in == NULL || out == NULL || length != ITERATE_KIT_VOICE_FRAME_BYTES) {
    return CLI_AUDIO_IN_ERR_ARG;
  }
  if (cli_audio_in_catch_up(in) == 0U) return CLI_AUDIO_IN_ERR_EMPTY;
  memcpy(out, in->frames[in->read % CLI_AUDIO_IN_RING_FRAMES], length);
  ++in->read;
  return CLI_AUDIO_IN_OK;
}

void cli_audio_in_close(struct cli_audio_in *in)
{
  if (in == NULL || in->queue == NULL) return;
  atomic_store_explicit(&in->enabled, false, memory_order_release);
  {
    const OSStatus stop = AudioQueueStop(in->queue, true);
    if (stop != noErr) cli_audio_in_remember_error(in, (int32_t)stop);
  }
  {
    const OSStatus dispose = AudioQueueDispose(in->queue, true);
    if (dispose != noErr) cli_audio_in_remember_error(in, (int32_t)dispose);
  }
  in->queue = NULL;
}

static uint32_t cli_audio_in_catch_up(struct cli_audio_in *in)
{
  assert(in != NULL);
  /* Acquire pairs with the producer's release; the frame is complete. */
  const uint32_t write =
      (uint32_t)atomic_load_explicit(&in->write, memory_order_acquire);
  const uint32_t pending = write - in->read;
  if (pending <= CLI_AUDIO_IN_USABLE_FRAMES) return pending;
  /*
   * The consumer has been away for a whole ring. What is here is stale
   * speech; keeping it would send a sentence that trails further behind the
   * speaker with every frame, so the oldest go and the count says how many.
   */
  const uint32_t lost = pending - CLI_AUDIO_IN_USABLE_FRAMES;
  in->read += lost;
  in->dropped += lost;
  return CLI_AUDIO_IN_USABLE_FRAMES;
}

static void cli_audio_in_captured(
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
  struct cli_audio_in *in = context;
  enum cli_audio_in_status push;
  OSStatus enqueue;
  assert(in != NULL && buffer != NULL);
  if (!atomic_load_explicit(&in->enabled, memory_order_acquire)) return;
  push = cli_audio_in_push(in, buffer->mAudioData, buffer->mAudioDataByteSize);
  if (push != CLI_AUDIO_IN_OK && push != CLI_AUDIO_IN_ERR_ARG) {
    cli_audio_in_remember_error(in, EIO);
    atomic_store_explicit(&in->enabled, false, memory_order_release);
    return;
  }
  /* Requeue unconditionally: a buffer not returned is capture stopping dead. */
  enqueue = AudioQueueEnqueueBuffer(queue, buffer, 0U, NULL);
  if (enqueue != noErr) {
    cli_audio_in_remember_error(in, (int32_t)enqueue);
    atomic_store_explicit(&in->enabled, false, memory_order_release);
  }
}

static void cli_audio_in_abandon_open(struct cli_audio_in *in)
{
  assert(in != NULL && in->queue != NULL);
  atomic_store_explicit(&in->enabled, false, memory_order_release);
  {
    const OSStatus result = AudioQueueDispose(in->queue, true);
    if (result != noErr) cli_audio_in_remember_error(in, (int32_t)result);
  }
  in->queue = NULL;
}

static void cli_audio_in_remember_error(
    struct cli_audio_in *in, int32_t error)
{
  int_least32_t expected = 0;
  if (in == NULL || error == 0) return;
  (void)atomic_compare_exchange_strong_explicit(
      &in->platform_error, &expected, (int_least32_t)error,
      memory_order_release, memory_order_relaxed);
}
