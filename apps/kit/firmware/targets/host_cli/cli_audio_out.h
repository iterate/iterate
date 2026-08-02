#ifndef ITERATE_KIT_CLI_AUDIO_OUT_H
#define ITERATE_KIT_CLI_AUDIO_OUT_H

/*
 * cli_audio_out: the CoreAudio speaker, as a converter that PULLS.
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

enum {
  /*
   * Buffers cycling through CoreAudio. Four is enough to keep the callback
   * chain unbroken across a scheduler hiccup; more would only add latency,
   * because the elastic capacity that matters now lives in the ring.
   */
  CLI_AUDIO_OUT_BUFFER_COUNT = 4,
  /*
   * Bytes per buffer handed to CoreAudio: one 20 ms frame of 16 kHz mono
   * PCM16, matching the wire frame so no buffer ever holds part of one.
   */
  CLI_AUDIO_OUT_BUFFER_BYTES = 640,
  /*
   * The elastic buffer, in bytes — two seconds.
   *
   * Sized for the producer's burstiness, not the speaker's latency: the loop
   * delivers frames in bursts as batches arrive, and the previous 160 ms of
   * total capacity is what turned those bursts into silence. Two seconds
   * absorbs any burst this rig has produced while still bounding how far
   * behind the room may get.
   */
  CLI_AUDIO_OUT_RING_BYTES = 64000,
};

enum cli_audio_out_status {
  CLI_AUDIO_OUT_OK = 0,
  CLI_AUDIO_OUT_ERR_ARG,
  CLI_AUDIO_OUT_ERR_PLATFORM,
  /** The ring is full: the room is more than a ring behind the timeline. */
  CLI_AUDIO_OUT_ERR_FULL,
};

/**
 * Caller-owned CoreAudio output with no allocation after open.
 *
 * `read` is advanced only by the CoreAudio callback and `write` only by the
 * loop, which is what makes the ring safe without a lock. The counters are
 * the postmortem: `dropped` is audio the room never got because the producer
 * outran it, and `starved` is silence the listener actually heard.
 */
struct cli_audio_out {
  AudioQueueRef queue;
  AudioQueueBufferRef buffers[CLI_AUDIO_OUT_BUFFER_COUNT];
  uint8_t ring[CLI_AUDIO_OUT_RING_BYTES];
  atomic_uint_least32_t read;
  atomic_uint_least32_t write;
  bool enabled;
  /** Bytes refused because the ring was full. */
  uint32_t dropped;
  /** Buffers CoreAudio asked for that the ring could not fill. */
  uint32_t starved;
};

/** Human-readable status name, for the one top-level log boundary. */
const char *cli_audio_out_status_name(enum cli_audio_out_status status);

/**
 * Allocate the queue, prime every buffer with silence, and start playing.
 *
 * Priming is not a nicety: an AudioQueue with nothing enqueued has no
 * callback in flight, so nothing would ever ask the ring for audio and the
 * speaker would stay silent however much the loop wrote.
 */
enum cli_audio_out_status cli_audio_out_open(struct cli_audio_out *out);

/**
 * Hand one PCM frame to the ring without blocking.
 *
 * A disabled sink accepts it as a no-op. A full ring counts the bytes it
 * could not take and returns ERR_FULL — which a caller should report rather
 * than discard, because it is the difference between a quiet room and a
 * broken one.
 */
enum cli_audio_out_status cli_audio_out_write(
    struct cli_audio_out *out, const uint8_t *pcm, size_t length);

/** Bytes currently waiting in the ring, for the pulse line. */
uint32_t cli_audio_out_queued_bytes(const struct cli_audio_out *out);

/** Stop and release CoreAudio resources. Safe before or after a failed open. */
void cli_audio_out_close(struct cli_audio_out *out);

#endif /* ITERATE_KIT_CLI_AUDIO_OUT_H */
