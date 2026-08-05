#ifndef ITERATE_KIT_CLI_AUDIO_IN_H
#define ITERATE_KIT_CLI_AUDIO_IN_H

/*
 * cli_audio_in: this Mac's microphone, as a source behind the existing seam.
 *
 * ORIGINATING FAILURE. The target's only microphone was a WAV file, so nobody
 * could talk to the stack by hand. Every turn was a recording, and a recording
 * cannot interrupt, cannot pause mid-sentence, and cannot tell you the answer
 * came back sounding wrong. Whole classes of complaint had to wait for a board
 * to be flashed before anybody could hear them.
 *
 * IT IS A SOURCE, NOT A SECOND PATH. Captured frames go into the same
 * cli_microphone queue, by the same route, gated by the same talk flag as a
 * file source. The entire value of this target is that the code under test is
 * the device's own; a live-microphone path that reached the uplink some other
 * way would prove nothing about the device and would be the first thing to
 * drift.
 *
 * CONCURRENCY. CoreAudio fills buffers on its own capture thread and calls
 * back there; the cooperative poll owner drains. One producer, one consumer,
 * no locks: the producer only ever advances `write`, and `read` belongs to the
 * consumer alone. On overrun the CONSUMER discards the oldest frames and
 * counts them, which is cli_microphone's policy and for the same reason — a
 * queue that keeps the oldest speech sends a sentence that falls further
 * behind the speaker with every frame.
 *
 * A slot of headroom is kept between the two: the consumer never reads the
 * frame the producer is in the middle of writing, so a lap costs whole old
 * frames rather than one torn one, which would be a click.
 *
 * FORMAT. 16 kHz mono PCM16, converted by CoreAudio from whatever the default
 * input device runs at. Anything else would be a different device under test.
 * macOS gates microphone access: a process without permission is started
 * successfully and simply never receives a callback, so `captured` is the only
 * way to tell a denied prompt from a quiet room.
 */

#include <AudioToolbox/AudioToolbox.h>

#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/voice_device_profile.h"

enum {
  /*
   * Eight buffers of one frame each. CoreAudio needs enough outstanding to
   * cover a scheduling gap; more than this only delays the discovery that the
   * consumer has stopped draining.
   */
  CLI_AUDIO_IN_BUFFER_COUNT = 8,
  /*
   * The handoff ring, sized to the device's own microphone queue depth so the
   * host cannot quietly hold more speech than the board does.
   */
  CLI_AUDIO_IN_RING_FRAMES = ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH,
};

/** One status per way capture can refuse work. */
enum cli_audio_in_status {
  CLI_AUDIO_IN_OK = 0,
  CLI_AUDIO_IN_ERR_ARG,
  CLI_AUDIO_IN_ERR_PLATFORM,
  /** Nothing captured yet. Normal between frames, not an error. */
  CLI_AUDIO_IN_ERR_EMPTY,
};

/**
 * Caller-owned capture with no allocation after open.
 *
 * `write` is the only field the capture thread touches, and it counts frames
 * ever produced rather than a slot index: the difference against `read` is
 * then the true backlog even after either wraps.
 */
struct cli_audio_in {
  AudioQueueRef queue;
  AudioQueueBufferRef buffers[CLI_AUDIO_IN_BUFFER_COUNT];
  uint8_t frames[CLI_AUDIO_IN_RING_FRAMES][ITERATE_KIT_VOICE_FRAME_BYTES];
  atomic_uint_least32_t write;
  atomic_int_least32_t platform_error;
  uint32_t read;
  /** Frames the consumer discarded because it had fallen a whole ring behind. */
  uint32_t dropped;
  /** Callbacks that were not a whole frame; see cli_audio_in_push. */
  atomic_uint_least32_t short_buffers;
  /** Frames accepted. Zero while talking means macOS refused the microphone. */
  atomic_uint_least32_t captured;
  atomic_bool enabled;
};

/** Human-readable status name, for the one top-level log boundary. */
const char *cli_audio_in_status_name(enum cli_audio_in_status status);

/** Allocate and start the fixed CoreAudio input queue. Pairs with close. */
enum cli_audio_in_status cli_audio_in_open(struct cli_audio_in *in);

/**
 * Accept one captured frame. Called from the CoreAudio capture thread, and
 * directly by tests, which is why it is public: the ring's overrun policy is
 * the interesting part of this module and it must be provable without a
 * microphone, a permission prompt, or a room.
 *
 * A length that is not exactly one frame is COUNTED AND DROPPED rather than
 * padded. CoreAudio delivers whole buffers except around start and stop, and
 * padding those with silence would put a click at the front of every turn.
 */
enum cli_audio_in_status cli_audio_in_push(
    struct cli_audio_in *in, const uint8_t *pcm, size_t length);

/** Take the oldest frame, discarding any the consumer fell behind on. */
enum cli_audio_in_status cli_audio_in_pop(
    struct cli_audio_in *in, uint8_t *out, size_t length);

uint32_t cli_audio_in_captured_frames(const struct cli_audio_in *in);
int32_t cli_audio_in_platform_error(const struct cli_audio_in *in);

/** Stop and release CoreAudio resources. Safe before or after a failed open. */
void cli_audio_in_close(struct cli_audio_in *in);

#endif /* ITERATE_KIT_CLI_AUDIO_IN_H */
