/* cli_audio_out.c: owns the optional, bounded CoreAudio playback mirror. */

#include <assert.h>
#include <string.h>

#include "cli_audio_out.h"
#include "iterate/kit/voice_device_profile.h"

enum {
  CLI_AUDIO_OUT_SAMPLE_RATE_HZ = 16000,
  CLI_AUDIO_OUT_BYTES_PER_SAMPLE = 2,
  CLI_AUDIO_OUT_CHANNELS = 1,
  CLI_AUDIO_OUT_FRAMES_PER_PACKET = 1,
  CLI_AUDIO_OUT_BITS_PER_BYTE = 8,
};

/* Marks the buffer returned by CoreAudio reusable by the cooperative owner. */
static void cli_audio_out_release(
    void *context, AudioQueueRef queue, AudioQueueBufferRef buffer);

/* Returns the first idle buffer, or NULL when monitoring has fallen behind. */
static AudioQueueBufferRef cli_audio_out_claim(struct cli_audio_out *out);

/* Releases resources acquired before an open failure. */
static void cli_audio_out_abandon_open(struct cli_audio_out *out);

const char *cli_audio_out_status_name(enum cli_audio_out_status status)
{
  switch (status) {
    case CLI_AUDIO_OUT_OK: return "ok";
    case CLI_AUDIO_OUT_ERR_ARG: return "bad-argument";
    case CLI_AUDIO_OUT_ERR_PLATFORM: return "coreaudio";
    case CLI_AUDIO_OUT_ERR_FULL: return "full";
    default: return "unknown";
  }
}

enum cli_audio_out_status cli_audio_out_open(struct cli_audio_out *out)
{
  if (out == NULL) return CLI_AUDIO_OUT_ERR_ARG;
  memset(out, 0, sizeof(*out));
  const AudioStreamBasicDescription format = {
    .mSampleRate = CLI_AUDIO_OUT_SAMPLE_RATE_HZ,
    .mFormatID = kAudioFormatLinearPCM,
    .mFormatFlags =
        kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
    .mBytesPerPacket = CLI_AUDIO_OUT_BYTES_PER_SAMPLE,
    .mFramesPerPacket = CLI_AUDIO_OUT_FRAMES_PER_PACKET,
    .mBytesPerFrame = CLI_AUDIO_OUT_BYTES_PER_SAMPLE,
    .mChannelsPerFrame = CLI_AUDIO_OUT_CHANNELS,
    .mBitsPerChannel =
        CLI_AUDIO_OUT_BYTES_PER_SAMPLE * CLI_AUDIO_OUT_BITS_PER_BYTE,
  };
  OSStatus result = AudioQueueNewOutput(
      &format, cli_audio_out_release, out, NULL, NULL, 0U, &out->queue);
  if (result != noErr) return CLI_AUDIO_OUT_ERR_PLATFORM;
  for (size_t index = 0U; index < CLI_AUDIO_OUT_BUFFER_COUNT; ++index) {
    result = AudioQueueAllocateBuffer(
        out->queue, ITERATE_KIT_VOICE_FRAME_BYTES, &out->buffers[index]);
    if (result != noErr) {
      cli_audio_out_abandon_open(out);
      return CLI_AUDIO_OUT_ERR_PLATFORM;
    }
  }
  result = AudioQueueStart(out->queue, NULL);
  if (result != noErr) {
    cli_audio_out_abandon_open(out);
    return CLI_AUDIO_OUT_ERR_PLATFORM;
  }
  out->enabled = true;
  return CLI_AUDIO_OUT_OK;
}

enum cli_audio_out_status cli_audio_out_write(
    struct cli_audio_out *out, const uint8_t *pcm, size_t length)
{
  if (out == NULL || pcm == NULL || length > UINT32_MAX) {
    return CLI_AUDIO_OUT_ERR_ARG;
  }
  if (!out->enabled) return CLI_AUDIO_OUT_OK;
  AudioQueueBufferRef buffer = cli_audio_out_claim(out);
  if (buffer == NULL) {
    ++out->dropped;
    return CLI_AUDIO_OUT_ERR_FULL;
  }
  memcpy(buffer->mAudioData, pcm, length);
  buffer->mAudioDataByteSize = (UInt32)length;
  const OSStatus result = AudioQueueEnqueueBuffer(out->queue, buffer, 0U, NULL);
  if (result == noErr) return CLI_AUDIO_OUT_OK;
  cli_audio_out_release(out, out->queue, buffer);
  ++out->dropped;
  return CLI_AUDIO_OUT_ERR_PLATFORM;
}

void cli_audio_out_close(struct cli_audio_out *out)
{
  if (out == NULL || out->queue == NULL) return;
  (void)AudioQueueStop(out->queue, true);
  (void)AudioQueueDispose(out->queue, true);
  out->queue = NULL;
  out->enabled = false;
}

static void cli_audio_out_release(
    void *context, AudioQueueRef queue, AudioQueueBufferRef buffer)
{
  (void)queue;
  struct cli_audio_out *out = context;
  assert(out != NULL && buffer != NULL);
  for (size_t index = 0U; index < CLI_AUDIO_OUT_BUFFER_COUNT; ++index) {
    if (out->buffers[index] == buffer) {
      /* Release publishes CoreAudio's ownership return to the poll owner. */
      atomic_store_explicit(&out->busy[index], false, memory_order_release);
    }
  }
}

static AudioQueueBufferRef cli_audio_out_claim(struct cli_audio_out *out)
{
  assert(out != NULL && out->queue != NULL);
  for (size_t index = 0U; index < CLI_AUDIO_OUT_BUFFER_COUNT; ++index) {
    bool expected = false;
    /* Acquire pairs with callback release; one owner can claim each return. */
    if (atomic_compare_exchange_strong_explicit(
            &out->busy[index], &expected, true,
            memory_order_acquire, memory_order_relaxed)) {
      return out->buffers[index];
    }
  }
  return NULL;
}

static void cli_audio_out_abandon_open(struct cli_audio_out *out)
{
  assert(out != NULL && out->queue != NULL);
  (void)AudioQueueDispose(out->queue, true);
  out->queue = NULL;
  out->enabled = false;
}
