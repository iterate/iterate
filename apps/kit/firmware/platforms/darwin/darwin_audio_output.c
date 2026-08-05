/* iterate_kit_darwin_audio_output.c: owns the CoreAudio speaker and the ring it pulls from. */

#include <assert.h>
#include <errno.h>
#include <string.h>
#include <time.h>

#include "iterate/kit/platforms/darwin_audio_output.h"

enum {
  /* One wire frame's worth of playback time; the converter's true period. */
  ITERATE_KIT_DARWIN_AUDIO_OUTPUT_US_PER_MS = 1000,
  ITERATE_KIT_DARWIN_AUDIO_OUTPUT_PERIOD_US =
      ITERATE_KIT_VOICE_FRAME_MS * ITERATE_KIT_DARWIN_AUDIO_OUTPUT_US_PER_MS,
  /*
   * Periods one pump may serve. A host that slept with the lid shut returns a
   * stamp hours later; replaying every period since would write hours of
   * silence into the recording and report a quarter of a million starved
   * frames for a closed laptop. Past this the model resyncs to the new stamp.
   */
  ITERATE_KIT_DARWIN_AUDIO_OUTPUT_MAX_PULL_FRAMES = 256,
  ITERATE_KIT_DARWIN_AUDIO_OUTPUT_MS_PER_SECOND = 1000,
  ITERATE_KIT_DARWIN_AUDIO_OUTPUT_SAMPLE_RATE_HZ =
      ITERATE_KIT_VOICE_FRAME_SAMPLES *
      ITERATE_KIT_DARWIN_AUDIO_OUTPUT_MS_PER_SECOND /
      ITERATE_KIT_VOICE_FRAME_MS,
  ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BYTES_PER_SAMPLE = 2,
  ITERATE_KIT_DARWIN_AUDIO_OUTPUT_CHANNELS = 1,
  ITERATE_KIT_DARWIN_AUDIO_OUTPUT_FRAMES_PER_PACKET = 1,
  ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BITS_PER_BYTE = 8,
};

/* Refills one finished buffer from the ring and re-enqueues it, forever. */
static void iterate_kit_darwin_audio_output_refill(
    void *context, AudioQueueRef queue, AudioQueueBufferRef buffer);

/* Copies up to `length` bytes out of the ring; returns how many it got. */
static uint32_t iterate_kit_darwin_audio_output_take(struct iterate_kit_darwin_audio_output *out,
                                   uint8_t *destination, uint32_t length);

/* Releases resources acquired before an open failure. */
static void iterate_kit_darwin_audio_output_abandon_open(struct iterate_kit_darwin_audio_output *out);

static void iterate_kit_darwin_audio_output_remember_error(
    struct iterate_kit_darwin_audio_output *out, int32_t error);

static void iterate_kit_darwin_audio_output_classify_pull(
    struct iterate_kit_darwin_audio_output *out, uint32_t taken, bool expected);

static uint32_t iterate_kit_darwin_audio_output_pending_payload_bytes(
    const struct iterate_kit_darwin_audio_output *out);

const char *iterate_kit_darwin_audio_output_status_name(enum iterate_kit_darwin_audio_output_status status)
{
  switch (status) {
    case ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK: return "ok";
    case ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_ARG: return "bad-argument";
    case ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_PLATFORM: return "coreaudio";
    case ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_TIMEOUT: return "timeout";
    case ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_FULL: return "full";
    default: return "unknown";
  }
}

/** Fill and enqueue one buffer, taking silence when the ring is short. */
static OSStatus iterate_kit_darwin_audio_output_prime_one(
    struct iterate_kit_darwin_audio_output *out, AudioQueueBufferRef buffer)
{
  bool expected;
  uint32_t taken;
  size_t index;
  OSStatus result;
  assert(out != NULL && buffer != NULL);
  /*
   * Classify the pull at the instant hardware asked for it. Loading this
   * after take() races the producer's first write: a callback that asked
   * before an answer existed can take silence, then observe the write's new
   * expectation and falsely report that pre-answer silence as starvation.
   */
  expected = atomic_load_explicit(
      &out->expecting_audio, memory_order_acquire);
  taken = iterate_kit_darwin_audio_output_take(
      out, (uint8_t *)buffer->mAudioData, (uint32_t)ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES);
  iterate_kit_darwin_audio_output_classify_pull(out, taken, expected);
  if (taken < (uint32_t)ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES) {
    /*
     * Silence rather than a short buffer. A short buffer would make the queue
     * play faster than realtime and drift, and the listener would hear the
     * hole either way — but only this way is it counted.
     */
    memset((uint8_t *)buffer->mAudioData + taken, 0,
           (size_t)ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES - taken);
  }
  if (taken == 0U &&
      atomic_load_explicit(&out->draining, memory_order_relaxed)) {
    return noErr;
  }
  for (index = 0U; index < ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_COUNT; ++index) {
    if (out->buffers[index] == buffer) break;
  }
  assert(index < ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_COUNT);
  buffer->mAudioDataByteSize = (UInt32)ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES;
  atomic_store_explicit(
      &out->buffer_payload_bytes[index], taken, memory_order_release);
  result = AudioQueueEnqueueBuffer(out->queue, buffer, 0U, NULL);
  if (result != noErr) {
    atomic_store_explicit(
        &out->buffer_payload_bytes[index], 0U, memory_order_release);
  }
  return result;
}

enum iterate_kit_darwin_audio_output_status iterate_kit_darwin_audio_output_open(struct iterate_kit_darwin_audio_output *out)
{
  if (out == NULL) return ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_ARG;
  memset(out, 0, sizeof(*out));
  atomic_store(&out->read, 0U);
  atomic_store(&out->write, 0U);
  const AudioStreamBasicDescription format = {
    .mSampleRate = ITERATE_KIT_DARWIN_AUDIO_OUTPUT_SAMPLE_RATE_HZ,
    .mFormatID = kAudioFormatLinearPCM,
    .mFormatFlags =
        kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
    .mBytesPerPacket = ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BYTES_PER_SAMPLE,
    .mFramesPerPacket = ITERATE_KIT_DARWIN_AUDIO_OUTPUT_FRAMES_PER_PACKET,
    .mBytesPerFrame = ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BYTES_PER_SAMPLE,
    .mChannelsPerFrame = ITERATE_KIT_DARWIN_AUDIO_OUTPUT_CHANNELS,
    .mBitsPerChannel =
        ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BYTES_PER_SAMPLE * ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BITS_PER_BYTE,
  };
  OSStatus result = AudioQueueNewOutput(
      &format, iterate_kit_darwin_audio_output_refill, out, NULL, NULL, 0U, &out->queue);
  if (result != noErr) {
    iterate_kit_darwin_audio_output_remember_error(out, (int32_t)result);
    return ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_PLATFORM;
  }
  for (size_t index = 0U; index < ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_COUNT; ++index) {
    result = AudioQueueAllocateBuffer(
        out->queue, ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES, &out->buffers[index]);
    if (result != noErr) {
      iterate_kit_darwin_audio_output_remember_error(out, (int32_t)result);
      iterate_kit_darwin_audio_output_abandon_open(out);
      return ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_PLATFORM;
    }
  }
  /*
   * Prime before starting. A queue with nothing enqueued has no callback in
   * flight, so nothing would ever come back to ask the ring for audio and the
   * speaker would stay silent however much the loop wrote.
   */
  atomic_store_explicit(&out->enabled, true, memory_order_release);
  for (size_t index = 0U; index < ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_COUNT; ++index) {
    result = iterate_kit_darwin_audio_output_prime_one(out, out->buffers[index]);
    if (result != noErr) {
      iterate_kit_darwin_audio_output_remember_error(out, (int32_t)result);
      iterate_kit_darwin_audio_output_abandon_open(out);
      return ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_PLATFORM;
    }
  }
  /* Priming with silence is not starvation; it is how playback begins. */
  atomic_store_explicit(&out->starved, 0U, memory_order_relaxed);
  result = AudioQueueStart(out->queue, NULL);
  if (result != noErr) {
    iterate_kit_darwin_audio_output_remember_error(out, (int32_t)result);
    iterate_kit_darwin_audio_output_abandon_open(out);
    return ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_PLATFORM;
  }
  return ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK;
}

enum iterate_kit_darwin_audio_output_status iterate_kit_darwin_audio_output_open_file(
    struct iterate_kit_darwin_audio_output *out,
    const struct iterate_kit_darwin_audio_file_sink *sink)
{
  if (out == NULL || sink == NULL || sink->write == NULL) {
    return ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_ARG;
  }
  memset(out, 0, sizeof(*out));
  atomic_store(&out->read, 0U);
  atomic_store(&out->write, 0U);
  out->mode = ITERATE_KIT_DARWIN_AUDIO_OUTPUT_FILE;
  out->file = *sink;
  /* Zero means "not started"; the first pump anchors it to the loop's clock. */
  out->next_pull_us = 0U;
  atomic_store_explicit(&out->enabled, true, memory_order_release);
  return ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK;
}

void iterate_kit_darwin_audio_output_pump(struct iterate_kit_darwin_audio_output *out, uint64_t now_us)
{
  uint8_t frame[ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES];
  uint32_t served = 0U;
  if (out == NULL || out->mode != ITERATE_KIT_DARWIN_AUDIO_OUTPUT_FILE ||
      !atomic_load_explicit(&out->enabled, memory_order_acquire)) return;
  if (out->next_pull_us == 0U) out->next_pull_us = now_us;
  /*
   * A stamp behind one already served is ignored rather than subtracted. The
   * unsigned underflow that would otherwise follow is the same arithmetic
   * that once rebuilt a healthy call 42 times in three minutes.
   */
  if (now_us < out->next_pull_us) return;

  while (now_us >= out->next_pull_us &&
         served < (uint32_t)ITERATE_KIT_DARWIN_AUDIO_OUTPUT_MAX_PULL_FRAMES) {
    const uint32_t taken =
        iterate_kit_darwin_audio_output_take(out, frame, (uint32_t)ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES);
    const bool expected = atomic_load_explicit(
        &out->expecting_audio, memory_order_acquire);
    iterate_kit_darwin_audio_output_classify_pull(out, taken, expected);
    if (taken < (uint32_t)ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES) {
      memset(frame + taken, 0, (size_t)ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES - taken);
    }
    /*
     * Silence is written, not skipped. A recording that omits the frames the
     * converter had nothing for is simply shorter and sounds perfect, which
     * is exactly how a run that dropped a fifth of a second of a call went
     * unnoticed.
     */
    if (!out->file.write(out->file.context,
                         frame,
                         (size_t)ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES)) {
      iterate_kit_darwin_audio_output_remember_error(out, EIO);
      atomic_store_explicit(&out->enabled, false, memory_order_release);
      return;
    }
    (void)atomic_fetch_add_explicit(
        &out->completed_bytes, taken, memory_order_relaxed);
    out->next_pull_us += (uint64_t)ITERATE_KIT_DARWIN_AUDIO_OUTPUT_PERIOD_US;
    served++;
  }
  if (served >= (uint32_t)ITERATE_KIT_DARWIN_AUDIO_OUTPUT_MAX_PULL_FRAMES) out->next_pull_us = now_us;
}

enum iterate_kit_darwin_audio_output_status iterate_kit_darwin_audio_output_write(
    struct iterate_kit_darwin_audio_output *out, const uint8_t *pcm, size_t length)
{
  uint32_t write_index;
  uint32_t used;
  uint32_t space;
  uint32_t first;
  if (out == NULL || pcm == NULL || length > UINT32_MAX) {
    return ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_ARG;
  }
  if (!atomic_load_explicit(&out->enabled, memory_order_acquire)) {
    return iterate_kit_darwin_audio_output_platform_error(out) == 0
        ? ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK
        : ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_PLATFORM;
  }

  write_index = (uint32_t)atomic_load_explicit(&out->write, memory_order_relaxed);
  used = write_index -
         (uint32_t)atomic_load_explicit(&out->read, memory_order_acquire);
  space = (uint32_t)ITERATE_KIT_DARWIN_AUDIO_OUTPUT_RING_BYTES - used;
  if ((uint32_t)length > space) {
    out->dropped += (uint32_t)length;
    return ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_FULL;
  }
  first = (uint32_t)ITERATE_KIT_DARWIN_AUDIO_OUTPUT_RING_BYTES -
          (write_index % (uint32_t)ITERATE_KIT_DARWIN_AUDIO_OUTPUT_RING_BYTES);
  if (first > (uint32_t)length) first = (uint32_t)length;
  memcpy(
      &out->ring[write_index % (uint32_t)ITERATE_KIT_DARWIN_AUDIO_OUTPUT_RING_BYTES], pcm, first);
  memcpy(&out->ring[0], pcm + first, (size_t)length - first);
  atomic_store_explicit(
      &out->write, write_index + (uint32_t)length, memory_order_release);
  if (length > 0U) {
    atomic_store_explicit(&out->expecting_audio, true, memory_order_release);
  }
  return ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK;
}

void iterate_kit_darwin_audio_output_set_expected(struct iterate_kit_darwin_audio_output *out, bool expected)
{
  if (out == NULL) return;
  atomic_store_explicit(&out->expecting_audio, expected, memory_order_release);
  if (!expected) {
    (void)atomic_exchange_explicit(
        &out->pending_starved, 0U, memory_order_acq_rel);
  }
}

enum iterate_kit_darwin_audio_output_status iterate_kit_darwin_audio_output_drain(
    struct iterate_kit_darwin_audio_output *out, uint32_t timeout_ms)
{
  if (out == NULL || timeout_ms == 0U) return ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_ARG;
  if (!atomic_load_explicit(&out->enabled, memory_order_acquire)) {
    return iterate_kit_darwin_audio_output_platform_error(out) == 0
        ? ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK
        : ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_PLATFORM;
  }
  atomic_store_explicit(&out->expecting_audio, false, memory_order_release);
  atomic_store_explicit(&out->draining, true, memory_order_release);
  if (out->mode == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_FILE) {
    uint8_t frame[ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES];
    while (iterate_kit_darwin_audio_output_queued_bytes(out) > 0U) {
      const uint32_t taken = iterate_kit_darwin_audio_output_take(
          out, frame, (uint32_t)ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES);
      if (taken < (uint32_t)ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES) {
        memset(frame + taken, 0,
               (size_t)ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES - taken);
      }
      if (!out->file.write(
              out->file.context,
              frame,
              (size_t)ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES)) {
        iterate_kit_darwin_audio_output_remember_error(out, EIO);
        return ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_PLATFORM;
      }
      (void)atomic_fetch_add_explicit(
          &out->completed_bytes, taken, memory_order_relaxed);
    }
    return ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK;
  }
  {
    struct timespec started;
    const struct timespec delay = {.tv_sec = 0, .tv_nsec = 5000000L};
    if (clock_gettime(CLOCK_MONOTONIC, &started) != 0) {
      iterate_kit_darwin_audio_output_remember_error(out, errno != 0 ? errno : EIO);
      return ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_PLATFORM;
    }
    while (iterate_kit_darwin_audio_output_queued_bytes(out) > 0U ||
           iterate_kit_darwin_audio_output_pending_payload_bytes(out) > 0U) {
      struct timespec now;
      uint64_t elapsed_ms;
      if (iterate_kit_darwin_audio_output_platform_error(out) != 0) {
        return ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_PLATFORM;
      }
      if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) {
        iterate_kit_darwin_audio_output_remember_error(out, errno != 0 ? errno : EIO);
        return ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_PLATFORM;
      }
      elapsed_ms = (uint64_t)(now.tv_sec - started.tv_sec) * 1000U;
      if (now.tv_nsec >= started.tv_nsec) {
        elapsed_ms += (uint64_t)(now.tv_nsec - started.tv_nsec) / 1000000U;
      } else {
        elapsed_ms -= 1000U;
        elapsed_ms +=
            (uint64_t)(1000000000L + now.tv_nsec - started.tv_nsec) / 1000000U;
      }
      if (elapsed_ms >= timeout_ms) return ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_TIMEOUT;
      (void)nanosleep(&delay, NULL);
    }
  }
  atomic_store_explicit(&out->enabled, false, memory_order_release);
  {
    const OSStatus result = AudioQueueStop(out->queue, false);
    if (result != noErr) {
      iterate_kit_darwin_audio_output_remember_error(out, (int32_t)result);
      return ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_PLATFORM;
    }
  }
  return ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK;
}

uint32_t iterate_kit_darwin_audio_output_queued_bytes(const struct iterate_kit_darwin_audio_output *out)
{
  if (out == NULL) return 0U;
  return (uint32_t)atomic_load_explicit(&out->write, memory_order_relaxed) -
         (uint32_t)atomic_load_explicit(&out->read, memory_order_relaxed);
}

uint32_t iterate_kit_darwin_audio_output_completed_bytes(const struct iterate_kit_darwin_audio_output *out)
{
  return out == NULL ? 0U : (uint32_t)atomic_load_explicit(
      &out->completed_bytes, memory_order_acquire);
}

uint32_t iterate_kit_darwin_audio_output_starved_buffers(const struct iterate_kit_darwin_audio_output *out)
{
  return out == NULL ? 0U : (uint32_t)atomic_load_explicit(
      &out->starved, memory_order_acquire);
}

int32_t iterate_kit_darwin_audio_output_platform_error(const struct iterate_kit_darwin_audio_output *out)
{
  return out == NULL ? 0 : (int32_t)atomic_load_explicit(
      &out->platform_error, memory_order_acquire);
}

void iterate_kit_darwin_audio_output_close(struct iterate_kit_darwin_audio_output *out)
{
  if (out == NULL) return;
  if (out->mode == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_FILE) {
    /* The sink belongs to the caller; only stop pulling from it. */
    atomic_store_explicit(&out->enabled, false, memory_order_release);
    memset(&out->file, 0, sizeof(out->file));
    return;
  }
  if (out->queue == NULL) return;
  /*
   * Cleared before stopping so the callback, which may run once more on
   * CoreAudio's thread while the queue winds down, stops re-enqueueing.
   */
  atomic_store_explicit(&out->enabled, false, memory_order_release);
  {
    const OSStatus stop = AudioQueueStop(out->queue, true);
    if (stop != noErr) iterate_kit_darwin_audio_output_remember_error(out, (int32_t)stop);
  }
  {
    const OSStatus dispose = AudioQueueDispose(out->queue, true);
    if (dispose != noErr) iterate_kit_darwin_audio_output_remember_error(out, (int32_t)dispose);
  }
  out->queue = NULL;
}

static uint32_t iterate_kit_darwin_audio_output_take(
    struct iterate_kit_darwin_audio_output *out, uint8_t *destination, uint32_t length)
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
  first = (uint32_t)ITERATE_KIT_DARWIN_AUDIO_OUTPUT_RING_BYTES -
          (read_index % (uint32_t)ITERATE_KIT_DARWIN_AUDIO_OUTPUT_RING_BYTES);
  if (first > taken) first = taken;
  memcpy(
      destination, &out->ring[read_index % (uint32_t)ITERATE_KIT_DARWIN_AUDIO_OUTPUT_RING_BYTES],
      first);
  memcpy(destination + first, &out->ring[0], (size_t)taken - first);
  atomic_store_explicit(&out->read, read_index + taken, memory_order_release);
  return taken;
}

static void iterate_kit_darwin_audio_output_refill(
    void *context, AudioQueueRef queue, AudioQueueBufferRef buffer)
{
  struct iterate_kit_darwin_audio_output *out = context;
  size_t index;
  OSStatus result;
  (void)queue;
  assert(out != NULL && buffer != NULL);
  for (index = 0U; index < ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_COUNT; ++index) {
    if (out->buffers[index] == buffer) break;
  }
  assert(index < ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_COUNT);
  (void)atomic_fetch_add_explicit(
      &out->completed_bytes,
      atomic_exchange_explicit(
          &out->buffer_payload_bytes[index], 0U, memory_order_acq_rel),
      memory_order_relaxed);
  /*
   * The chain must not be broken. Returning without re-enqueueing would end
   * playback permanently, which is precisely the failure this module was
   * rewritten to remove — so a shutting-down queue is the only reason to stop.
   */
  if (!atomic_load_explicit(&out->enabled, memory_order_acquire)) return;
  result = iterate_kit_darwin_audio_output_prime_one(out, buffer);
  if (result != noErr) {
    iterate_kit_darwin_audio_output_remember_error(out, (int32_t)result);
    atomic_store_explicit(&out->enabled, false, memory_order_release);
  }
}

static void iterate_kit_darwin_audio_output_abandon_open(struct iterate_kit_darwin_audio_output *out)
{
  assert(out != NULL && out->queue != NULL);
  atomic_store_explicit(&out->enabled, false, memory_order_release);
  {
    const OSStatus result = AudioQueueDispose(out->queue, true);
    if (result != noErr) iterate_kit_darwin_audio_output_remember_error(out, (int32_t)result);
  }
  out->queue = NULL;
}

static void iterate_kit_darwin_audio_output_remember_error(
    struct iterate_kit_darwin_audio_output *out, int32_t error)
{
  int_least32_t expected = 0;
  if (out == NULL || error == 0) return;
  (void)atomic_compare_exchange_strong_explicit(
      &out->platform_error, &expected, (int_least32_t)error,
      memory_order_release, memory_order_relaxed);
}

static void iterate_kit_darwin_audio_output_classify_pull(
    struct iterate_kit_darwin_audio_output *out, uint32_t taken, bool expected)
{
  uint_least32_t pending;
  assert(out != NULL);
  /*
   * Silence after the last word is ordinary response tail, not missing
   * speech. It becomes a hole only when a later payload proves that the
   * answer continued after it — the same classification used by the core
   * playback clock. Promote previous candidates before recording a partial
   * current buffer, so a payload+silence buffer proves earlier gaps while its
   * own tail remains unconfirmed.
   */
  if (taken > 0U) {
    pending = atomic_exchange_explicit(
        &out->pending_starved, 0U, memory_order_acq_rel);
    if (pending > 0U) {
      (void)atomic_fetch_add_explicit(
          &out->starved, pending, memory_order_relaxed);
    }
  }
  if (taken < (uint32_t)ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES && expected &&
      !atomic_load_explicit(&out->draining, memory_order_relaxed)) {
    (void)atomic_fetch_add_explicit(
        &out->pending_starved, 1U, memory_order_relaxed);
  }
}

static uint32_t iterate_kit_darwin_audio_output_pending_payload_bytes(
    const struct iterate_kit_darwin_audio_output *out)
{
  uint32_t pending = 0U;
  size_t index;
  assert(out != NULL);
  for (index = 0U; index < ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_COUNT; ++index) {
    pending += (uint32_t)atomic_load_explicit(
        &out->buffer_payload_bytes[index], memory_order_acquire);
  }
  return pending;
}
