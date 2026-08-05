#ifndef ITERATE_KIT_PLATFORMS_DARWIN_AUDIO_OUTPUT_H
#define ITERATE_KIT_PLATFORMS_DARWIN_AUDIO_OUTPUT_H

/*
 * iterate_kit_darwin_audio_output: the CoreAudio speaker, as a converter that PULLS.
 *
 * ORIGINATING FAILURE. This module used to push: the loop handed each played
 * frame straight into one of eight preallocated AudioQueue buffers, and a
 * full set was reported as ERR_FULL. Eight 20 ms buffers is 160 ms of lead
 * and nothing else. A producer that ran even slightly ahead filled them and
 * had the remainder REFUSED — and the caller discarded that refusal with a
 * cast — after which the queue drained and played nothing until the next
 * burst. A whole conversation arrived as fragments separated by silence,
 * while the WAV beside it recorded the same audio perfectly and the `played`
 * counter climbed at exactly fifty frames a second. The recording was clean,
 * the counters were clean, and the room was silent.
 *
 * THE SHAPE THAT FIXES IT. Hardware does not accept audio when the software
 * feels like offering it; it demands audio on its own clock and takes silence
 * when nobody has any. So the queue is primed at open and every buffer is
 * refilled and re-enqueued from CoreAudio's own callback, pulling from a ring
 * this module owns. Playback therefore never stops once started, a producer
 * running ahead is ABSORBED by the ring rather than refused, and a producer
 * running behind produces countable silence instead of a stalled queue.
 *
 * This is also what the device does. The ESP32's I2S peripheral pulls from a
 * DMA descriptor chain on the codec's clock; the host now models the same
 * relationship rather than an unrelated push protocol, which is the whole
 * premise of running the device's code here.
 *
 * OWNERSHIP AND THREADS. Exactly two threads touch this: the cooperative loop
 * calls write, and CoreAudio's internal thread calls the callback. They meet
 * only at the ring, which is single-producer single-consumer with atomic
 * indices. Nothing allocates after open and nothing blocks, because blocking
 * the loop to feed a speaker would stall the transport that fills it.
 */

#include <AudioToolbox/AudioToolbox.h>

#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/voice_device_profile.h"

enum {
  /*
   * Buffers cycling through CoreAudio. Four is enough to keep the callback
   * chain unbroken across a scheduler hiccup; more would only add latency,
   * because the elastic capacity that matters now lives in the ring.
   */
  ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_COUNT = 4,
  /*
   * Bytes per buffer handed to CoreAudio: one 20 ms frame of 16 kHz mono
   * PCM16, matching the wire frame so no buffer ever holds part of one.
   */
  ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES =
      ITERATE_KIT_VOICE_FRAME_BYTES,
  /*
   * Producer-ring reserve kept ahead of the hardware pull clock.
   *
   * CoreAudio owns the playback clock. Feeding this boundary one frame from a
   * separate 20 ms software timer made two nominally identical clocks race;
   * the faster one inevitably found the ring empty. All four AudioQueue
   * buffers can already be in flight when a callback must refill one, so they
   * cannot count as refill lead: one further descriptor chain waits in this
   * module's producer ring. That is eight frames of bounded payload in total,
   * not another elastic jitter buffer.
   */
  ITERATE_KIT_DARWIN_AUDIO_OUTPUT_LEAD_BYTES =
      ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_COUNT * ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES,
  /*
   * The elastic buffer, in bytes — two seconds.
   *
   * Sized for the producer's burstiness, not the speaker's latency: the loop
   * delivers frames in bursts as batches arrive, and the previous 160 ms of
   * total capacity is what turned those bursts into silence. Two seconds
   * absorbs any burst this rig has produced while still bounding how far
   * behind the room may get.
   */
  ITERATE_KIT_DARWIN_AUDIO_OUTPUT_RING_BYTES =
      ITERATE_KIT_VOICE_FRAME_BYTES * 100,
};

enum iterate_kit_darwin_audio_output_status {
  ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK = 0,
  ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_ARG,
  ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_PLATFORM,
  ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_TIMEOUT,
  /** The ring is full: the room is more than a ring behind the timeline. */
  ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_FULL,
};

/** Who is pulling audio out of the ring. */
enum iterate_kit_darwin_audio_output_mode {
  /** This Mac's speaker, pulled by CoreAudio's own thread. */
  ITERATE_KIT_DARWIN_AUDIO_OUTPUT_COREAUDIO = 0,
  /**
   * A file, pulled by the caller's loop at exactly the converter's rate.
   *
   * NOT a second implementation of playback — the ring, the drain arithmetic,
   * the starvation count and the drop accounting are the ones above, and the
   * only difference is which thread asks for a frame and where the frame
   * goes. That is the point: a rehearsal that took a different path through
   * this module would prove nothing about the path a listener hears, and this
   * one has already hidden a defect that made a whole conversation silent.
   *
   * It exists so a realistic session — real pacing, real starvation, real
   * back-pressure — can run with nobody at the machine and nothing audible,
   * and leave a recording of exactly what the speaker would have played.
   */
  ITERATE_KIT_DARWIN_AUDIO_OUTPUT_FILE,
};

/**
 * Deterministic stand-in for CoreAudio's pull clock.
 *
 * The Darwin adapter knows only that a complete PCM frame was admitted. The
 * host rig supplies a WAV-backed callback, while tests may supply memory. This
 * keeps the platform module independent of the host target without creating a
 * second playback ring or clock model.
 */
struct iterate_kit_darwin_audio_file_sink {
  void *context;
  bool (*write)(void *context, const uint8_t *pcm, size_t length);
};

/**
 * Caller-owned CoreAudio output with no allocation after open.
 *
 * `read` is advanced only by the CoreAudio callback and `write` only by the
 * loop, which is what makes the ring safe without a lock. The counters are
 * the postmortem: `dropped` is audio the room never got because the producer
 * outran it, and `starved` is silence the listener actually heard.
 */
struct iterate_kit_darwin_audio_output {
  enum iterate_kit_darwin_audio_output_mode mode;
  /** FILE mode only: where the pulled audio lands, and when the next pull is due. */
  struct iterate_kit_darwin_audio_file_sink file;
  uint64_t next_pull_us;
  AudioQueueRef queue;
  AudioQueueBufferRef buffers[ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_COUNT];
  uint8_t ring[ITERATE_KIT_DARWIN_AUDIO_OUTPUT_RING_BYTES];
  atomic_uint_least32_t read;
  atomic_uint_least32_t write;
  atomic_bool enabled;
  atomic_bool expecting_audio;
  atomic_bool draining;
  /** Actual payload currently owned by each enqueued CoreAudio buffer. */
  atomic_uint_least32_t buffer_payload_bytes[ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_COUNT];
  /** Payload whose completed CoreAudio callback proves hardware consumption. */
  atomic_uint_least32_t completed_bytes;
  /** First failing AudioQueue/WAV status, zero while the output is healthy. */
  atomic_int_least32_t platform_error;
  /** Bytes refused because the ring was full. */
  uint32_t dropped;
  /**
   * Dry pulls followed by more payload in the same answer: audible holes.
   * Trailing silence before response completion is classified separately and
   * discarded when the caller closes the expectation window.
   */
  atomic_uint_least32_t starved;
  /** Dry pulls not yet proven to be internal rather than trailing silence. */
  atomic_uint_least32_t pending_starved;
};

/** Human-readable status name, for the one top-level log boundary. */
const char *iterate_kit_darwin_audio_output_status_name(enum iterate_kit_darwin_audio_output_status status);

/**
 * Allocate the queue, prime every buffer with silence, and start playing.
 *
 * Priming is not a nicety: an AudioQueue with nothing enqueued has no
 * callback in flight, so nothing would ever ask the ring for audio and the
 * speaker would stay silent however much the loop wrote.
 */
enum iterate_kit_darwin_audio_output_status iterate_kit_darwin_audio_output_open(struct iterate_kit_darwin_audio_output *out);

/**
 * Hand one PCM frame to the ring without blocking.
 *
 * A disabled sink accepts it as a no-op. A full ring counts the bytes it
 * could not take and returns ERR_FULL — which a caller should report rather
 * than discard, because it is the difference between a quiet room and a
 * broken one.
 */
enum iterate_kit_darwin_audio_output_status iterate_kit_darwin_audio_output_write(
    struct iterate_kit_darwin_audio_output *out, const uint8_t *pcm, size_t length);

/**
 * Open in FILE mode: `sink` is pulled from by iterate_kit_darwin_audio_output_pump instead of
 * by CoreAudio. The caller owns the sink and must keep it open.
 */
enum iterate_kit_darwin_audio_output_status iterate_kit_darwin_audio_output_open_file(
    struct iterate_kit_darwin_audio_output *out,
    const struct iterate_kit_darwin_audio_file_sink *sink);

/**
 * FILE mode only: pull every frame now due, writing silence for any the ring
 * could not fill.
 *
 * Call once per loop iteration with the same clock everything else uses. A
 * caller that forgets simply never plays anything, loudly — the ring fills
 * and `dropped` climbs — rather than quietly playing at the wrong rate.
 */
void iterate_kit_darwin_audio_output_pump(struct iterate_kit_darwin_audio_output *out, uint64_t now_us);

/**
 * Open or close the answer-audio expectation window.
 *
 * Closing discards unconfirmed trailing dry pulls. A dry pull becomes
 * starvation only if later payload proves there was a hole inside the answer.
 */
void iterate_kit_darwin_audio_output_set_expected(struct iterate_kit_darwin_audio_output *out, bool expected);

/**
 * Wait until every accepted payload byte has completed at the hardware/file
 * boundary. The wait is bounded by timeout_ms and never counts trailing idle
 * silence as payload.
 */
enum iterate_kit_darwin_audio_output_status iterate_kit_darwin_audio_output_drain(
    struct iterate_kit_darwin_audio_output *out, uint32_t timeout_ms);

/** Bytes currently waiting in the producer ring, for the pulse line. */
uint32_t iterate_kit_darwin_audio_output_queued_bytes(const struct iterate_kit_darwin_audio_output *out);

uint32_t iterate_kit_darwin_audio_output_completed_bytes(const struct iterate_kit_darwin_audio_output *out);
uint32_t iterate_kit_darwin_audio_output_starved_buffers(const struct iterate_kit_darwin_audio_output *out);
int32_t iterate_kit_darwin_audio_output_platform_error(const struct iterate_kit_darwin_audio_output *out);

/** Stop and release CoreAudio resources. Safe before or after a failed open. */
void iterate_kit_darwin_audio_output_close(struct iterate_kit_darwin_audio_output *out);

#endif
