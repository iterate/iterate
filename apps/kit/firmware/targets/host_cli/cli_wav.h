#ifndef ITERATE_KIT_CLI_WAV_H
#define ITERATE_KIT_CLI_WAV_H

/*
 * cli_wav: reads the microphone from a WAV file and writes what the speaker
 * played to another.
 *
 * The sink is the closest thing this rig has to a witness. It must record the
 * TRUE playback timeline — silence written where the device concealed a hole,
 * at the moment it concealed it — because a recording that concatenates only
 * successful writes makes a stuttering device sound perfect. That mistake has
 * already hidden this exact defect once: a device inserting 160 ms of silence
 * forty-five times a minute produced a recording a listener would call clean.
 *
 * Only 16 kHz mono PCM16 is accepted, which is the device's format and not a
 * simplification: resampling here would silently change the thing under test.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

/** One status per failure a caller can do something about. */
enum cli_wav_status {
  CLI_WAV_OK = 0,
  /** A NULL or otherwise unusable argument at a public entry point. */
  CLI_WAV_ERR_ARG,
  /** The path could not be opened for reading or writing. */
  CLI_WAV_ERR_OPEN,
  /** Not a RIFF/WAVE file, or truncated before its data chunk. */
  CLI_WAV_ERR_FORMAT,
  /** Readable, but not 16 kHz mono PCM16. */
  CLI_WAV_ERR_UNSUPPORTED,
  /** A read or write to the underlying file failed. */
  CLI_WAV_ERR_IO,
};

/**
 * A microphone recording being replayed one frame at a time.
 *
 * `synthetic` exists so the capability still works with no file at all: a
 * bounded voiced test tone, not silence, because a provider given silence has
 * nothing to transcribe and the run proves nothing.
 */
struct cli_wav_source {
  FILE *file;
  uint32_t data_remaining;
  bool synthetic;
  uint32_t synthetic_frame;
  uint32_t synthetic_frames;
};

/**
 * A growing WAV whose RIFF sizes are patched on close.
 *
 * `bytes` is the payload length written so far, which is the only state the
 * two header fixups need.
 */
struct cli_wav_sink {
  FILE *file;
  uint32_t bytes;
};

/** Human-readable status name, for logs and test failure messages. */
const char *cli_wav_status_name(enum cli_wav_status status);

/**
 * Open `path` for replay, or start bounded synthesis when `path` is NULL.
 * `source` is caller-owned and is left closed on failure. Pairs with
 * cli_wav_source_close.
 */
enum cli_wav_status cli_wav_source_open(
    struct cli_wav_source *source, const char *path);

/**
 * Fill one whole frame, zero-padding a short final read.
 * Returns CLI_WAV_ERR_IO once the recording is exhausted, which is how a
 * caller learns the utterance has finished.
 */
enum cli_wav_status cli_wav_source_frame(
    struct cli_wav_source *source, uint8_t *frame, size_t frame_bytes);

/** Release the file. Safe on an already-closed source. */
void cli_wav_source_close(struct cli_wav_source *source);

/**
 * Create `path` and write a placeholder header.
 * `sink` is caller-owned. Pairs with cli_wav_sink_close, which patches the
 * header — a sink that is never closed leaves a file no player will open.
 */
enum cli_wav_status cli_wav_sink_open(
    struct cli_wav_sink *sink, const char *path);

/** Append PCM to the recording. */
enum cli_wav_status cli_wav_sink_write(
    struct cli_wav_sink *sink, const uint8_t *pcm, size_t length);

/** Patch the RIFF sizes and close. Safe on an already-closed sink. */
void cli_wav_sink_close(struct cli_wav_sink *sink);

#endif /* ITERATE_KIT_CLI_WAV_H */
