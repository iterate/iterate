#ifndef ITERATE_KIT_CLI_AUDIO_OUT_H
#define ITERATE_KIT_CLI_AUDIO_OUT_H

/*
 * cli_audio_out: the optional CoreAudio mirror of the played WAV timeline.
 *
 * This sink is deliberately lossy: the WAV is the authoritative record, while
 * room monitoring must never block the cooperative transport loop. Eight
 * preallocated buffers bound both memory and callback ownership; a full set is
 * reported to the caller so the loss remains visible.
 */

#include <AudioToolbox/AudioToolbox.h>

#include <stdbool.h>
#include <stddef.h>
#include <stdatomic.h>
#include <stdint.h>

enum {
  CLI_AUDIO_OUT_BUFFER_COUNT = 8,
};

enum cli_audio_out_status {
  CLI_AUDIO_OUT_OK = 0,
  CLI_AUDIO_OUT_ERR_ARG,
  CLI_AUDIO_OUT_ERR_PLATFORM,
  CLI_AUDIO_OUT_ERR_FULL,
};

/** Caller-owned CoreAudio output with no allocation after open. */
struct cli_audio_out {
  AudioQueueRef queue;
  AudioQueueBufferRef buffers[CLI_AUDIO_OUT_BUFFER_COUNT];
  /* CoreAudio releases these from its callback while the poll owner claims. */
  atomic_bool busy[CLI_AUDIO_OUT_BUFFER_COUNT];
  bool enabled;
  uint32_t dropped;
};

/** Human-readable status name, for the one top-level log boundary. */
const char *cli_audio_out_status_name(enum cli_audio_out_status status);

/** Allocate and start the fixed CoreAudio queue. Pairs with close. */
enum cli_audio_out_status cli_audio_out_open(struct cli_audio_out *out);

/**
 * Queue one PCM frame without blocking. A disabled sink accepts it as a no-op;
 * a saturated sink counts and reports ERR_FULL.
 */
enum cli_audio_out_status cli_audio_out_write(
    struct cli_audio_out *out, const uint8_t *pcm, size_t length);

/** Stop and release CoreAudio resources. Safe before or after a failed open. */
void cli_audio_out_close(struct cli_audio_out *out);

#endif /* ITERATE_KIT_CLI_AUDIO_OUT_H */
