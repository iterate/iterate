#ifndef ITERATE_KIT_CLI_SPEAKER_H
#define ITERATE_KIT_CLI_SPEAKER_H

/*
 * cli_speaker: the queue between "a frame arrived" and "a frame was heard".
 *
 * It owns a byte ring and nothing else about audio. WHICH frames are worth
 * queueing is iterate_kit_playout's decision; WHEN a queued frame is due is
 * iterate_kit_voice_playback_clock's. Keeping all three apart is what makes
 * each testable, and it is the arrangement the device uses — a host copy of
 * any of those policies would prove nothing about the device.
 *
 * The ring is sized from the shared profile, so the CLI cannot quietly hold
 * more audio than the board does.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/voice_device_profile.h"

/** One status per way the queue can refuse work. */
enum cli_speaker_status {
  CLI_SPEAKER_OK = 0,
  CLI_SPEAKER_ERR_ARG,
  /** No room. The caller counts this: it is speech thrown away on arrival. */
  CLI_SPEAKER_ERR_FULL,
  /** Nothing queued. Not an error at the end of an answer. */
  CLI_SPEAKER_ERR_EMPTY,
};

/**
 * A bounded queue of decoded PCM, in whole frames.
 *
 * `used` is bytes, not frames, because the playback clock reasons in
 * milliseconds of audio and one frame is a fixed number of bytes; converting
 * once at the boundary keeps every other line free of the conversion.
 */
struct cli_speaker {
  uint8_t bytes[ITERATE_KIT_VOICE_SPEAKER_BUFFER_BYTES];
  size_t read;
  size_t write;
  size_t used;
};

/** Human-readable status name, for logs and test failure messages. */
const char *cli_speaker_status_name(enum cli_speaker_status status);

/** Empty the queue. Used on a barge-in and at the start of a call. */
void cli_speaker_clear(struct cli_speaker *speaker);

/** Bytes that would fit right now. */
size_t cli_speaker_space(const struct cli_speaker *speaker);

/** Milliseconds of audio queued: what the playback clock decides from. */
uint32_t cli_speaker_queued_ms(const struct cli_speaker *speaker);

/**
 * Queue `length` bytes, all or nothing.
 *
 * A partial write would splice the head of one frame onto the next at an
 * arbitrary phase — a click, and at a full queue a click on EVERY frame — so
 * a queue with no room for the whole frame refuses it and says so.
 */
enum cli_speaker_status cli_speaker_write(
    struct cli_speaker *speaker, const uint8_t *pcm, size_t length);

/** Take `length` bytes, all or nothing. Fails with ERR_EMPTY. */
enum cli_speaker_status cli_speaker_read(
    struct cli_speaker *speaker, uint8_t *out, size_t length);

#endif /* ITERATE_KIT_CLI_SPEAKER_H */
