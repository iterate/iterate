/* cli_audio_out.c: owns the CoreAudio speaker and the ring it pulls from. */

#include <assert.h>
#include <string.h>

#include "cli_audio_out.h"

enum {
  CLI_AUDIO_OUT_SAMPLE_RATE_HZ = 16000,
  CLI_AUDIO_OUT_BYTES_PER_SAMPLE = 2,
  CLI_AUDIO_OUT_CHANNELS = 1,
  CLI_AUDIO_OUT_FRAMES_PER_PACKET = 1,
  CLI_AUDIO_OUT_BITS_PER_BYTE = 8,
};

/* Refills one finished buffer from the ring and re-enqueues it, forever. */
static void cli_audio_out_refill(
    void *context, AudioQueueRef queue, AudioQueueBufferRef buffer);

/* Copies up to `length` bytes out of the ring; returns how many it got. */
static uint32_t cli_audio_out_take(struct cli_audio_out *out,
                                   uint8_t *destination, uint32_t length);

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

/** Fill and enqueue one buffer, taking silence when the ring is short. */
static OSStatus cli_audio_out_prime_one(
    struct cli_audio_out *out, AudioQueueBufferRef buffer)
{
  uint32_t taken;
  assert(out != NULL && buffer != NULL);
  taken = cli_audio_out_take(
      out, (uint8_t *)buffer->mAudioData, (uint32_t)CLI_AUDIO_OUT_BUFFER_BYTES);
  if (taken < (uint32_t)CLI_AUDIO_OUT_BUFFER_BYTES) {
    /*
     * Silence rather than a short buffer. A short buffer would make the queue
     * play faster than realtime and drift, and the listener would hear the
     * hole either way — but only this way is it counted.
     */
    memset((uint8_t *)buffer->mAudioData + taken, 0,
           (size_t)CLI_AUDIO_OUT_BUFFER_BYTES - taken);
    ++out->starved;
  }
  buffer->mAudioDataByteSize = (UInt32)CLI_AUDIO_OUT_BUFFER_BYTES;
  return AudioQueueEnqueueBuffer(out->queue, buffer, 0U, NULL);
}

enum cli_audio_out_status cli_audio_out_open(struct cli_audio_out *out)
{
  if (out == NULL) return CLI_AUDIO_OUT_ERR_ARG;
  memset(out, 0, sizeof(*out));
  atomic_store(&out->read, 0U);
  atomic_store(&out->write, 0U);
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
      &format, cli_audio_out_refill, out, NULL, NULL, 0U, &out->queue);
  if (result != noErr) return CLI_AUDIO_OUT_ERR_PLATFORM;
  for (size_t index = 0U; index < CLI_AUDIO_OUT_BUFFER_COUNT; ++index) {
    result = AudioQueueAllocateBuffer(
        out->queue, CLI_AUDIO_OUT_BUFFER_BYTES, &out->buffers[index]);
    if (result != noErr) {
      cli_audio_out_abandon_open(out);
      return CLI_AUDIO_OUT_ERR_PLATFORM;
    }
  }
  /*
   * Prime before starting. A queue with nothing enqueued has no callback in
   * flight, so nothing would ever come back to ask the ring for audio and the
   * speaker would stay silent however much the loop wrote.
   */
  out->enabled = true;
  for (size_t index = 0U; index < CLI_AUDIO_OUT_BUFFER_COUNT; ++index) {
    if (cli_audio_out_prime_one(out, out->buffers[index]) != noErr) {
      cli_audio_out_abandon_open(out);
      return CLI_AUDIO_OUT_ERR_PLATFORM;
    }
  }
  /* Priming with silence is not starvation; it is how playback begins. */
  out->starved = 0U;
  result = AudioQueueStart(out->queue, NULL);
  if (result != noErr) {
    cli_audio_out_abandon_open(out);
    return CLI_AUDIO_OUT_ERR_PLATFORM;
  }
  return CLI_AUDIO_OUT_OK;
}

enum cli_audio_out_status cli_audio_out_write(
    struct cli_audio_out *out, const uint8_t *pcm, size_t length)
{
  uint32_t write_index;
  uint32_t used;
  uint32_t space;
  uint32_t first;
  if (out == NULL || pcm == NULL || length > UINT32_MAX) {
    return CLI_AUDIO_OUT_ERR_ARG;
  }
  if (!out->enabled) return CLI_AUDIO_OUT_OK;

  write_index = (uint32_t)atomic_load_explicit(&out->write, memory_order_relaxed);
  used = write_index -
         (uint32_t)atomic_load_explicit(&out->read, memory_order_acquire);
  space = (uint32_t)CLI_AUDIO_OUT_RING_BYTES - used;
  if ((uint32_t)length > space) {
    out->dropped += (uint32_t)length;
    return CLI_AUDIO_OUT_ERR_FULL;
  }
  first = (uint32_t)CLI_AUDIO_OUT_RING_BYTES -
          (write_index % (uint32_t)CLI_AUDIO_OUT_RING_BYTES);
  if (first > (uint32_t)length) first = (uint32_t)length;
  memcpy(
      &out->ring[write_index % (uint32_t)CLI_AUDIO_OUT_RING_BYTES], pcm, first);
  memcpy(&out->ring[0], pcm + first, (size_t)length - first);
  atomic_store_explicit(
      &out->write, write_index + (uint32_t)length, memory_order_release);
  return CLI_AUDIO_OUT_OK;
}

uint32_t cli_audio_out_queued_bytes(const struct cli_audio_out *out)
{
  if (out == NULL) return 0U;
  return (uint32_t)atomic_load_explicit(&out->write, memory_order_relaxed) -
         (uint32_t)atomic_load_explicit(&out->read, memory_order_relaxed);
}

void cli_audio_out_close(struct cli_audio_out *out)
{
  if (out == NULL || out->queue == NULL) return;
  /*
   * Cleared before stopping so the callback, which may run once more on
   * CoreAudio's thread while the queue winds down, stops re-enqueueing.
   */
  out->enabled = false;
  (void)AudioQueueStop(out->queue, true);
  (void)AudioQueueDispose(out->queue, true);
  out->queue = NULL;
}

static uint32_t cli_audio_out_take(
    struct cli_audio_out *out, uint8_t *destination, uint32_t length)
{
  uint32_t read_index;
  uint32_t available;
  uint32_t taken;
  uint32_t first;
  assert(out != NULL && destination != NULL);

  read_index = (uint32_t)atomic_load_explicit(&out->read, memory_order_relaxed);
  available = (uint32_t)atomic_load_explicit(&out->write, memory_order_acquire) -
              read_index;
  taken = available < length ? available : length;
  if (taken == 0U) return 0U;
  first = (uint32_t)CLI_AUDIO_OUT_RING_BYTES -
          (read_index % (uint32_t)CLI_AUDIO_OUT_RING_BYTES);
  if (first > taken) first = taken;
  memcpy(
      destination, &out->ring[read_index % (uint32_t)CLI_AUDIO_OUT_RING_BYTES],
      first);
  memcpy(destination + first, &out->ring[0], (size_t)taken - first);
  atomic_store_explicit(&out->read, read_index + taken, memory_order_release);
  return taken;
}

static void cli_audio_out_refill(
    void *context, AudioQueueRef queue, AudioQueueBufferRef buffer)
{
  struct cli_audio_out *out = context;
  (void)queue;
  assert(out != NULL && buffer != NULL);
  /*
   * The chain must not be broken. Returning without re-enqueueing would end
   * playback permanently, which is precisely the failure this module was
   * rewritten to remove — so a shutting-down queue is the only reason to stop.
   */
  if (!out->enabled) return;
  (void)cli_audio_out_prime_one(out, buffer);
}

static void cli_audio_out_abandon_open(struct cli_audio_out *out)
{
  assert(out != NULL && out->queue != NULL);
  out->enabled = false;
  (void)AudioQueueDispose(out->queue, true);
  out->queue = NULL;
}
