/* cli_speaker.c: owns the bounded PCM queue between delivery and playback. */

#include <assert.h>
#include <string.h>

#include "cli_speaker.h"

enum {
  CLI_SPEAKER_BYTES_PER_MS =
      ITERATE_KIT_VOICE_FRAME_BYTES / ITERATE_KIT_VOICE_FRAME_MS,
};

/* Copies bytes at the write cursor, wrapping once. Caller proved space. */
static void cli_speaker_copy_in(
    struct cli_speaker *speaker, const uint8_t *pcm, size_t length);

/* Copies bytes at the read cursor, wrapping once. Caller proved occupancy. */
static void cli_speaker_copy_out(
    struct cli_speaker *speaker, uint8_t *out, size_t length);

const char *cli_speaker_status_name(enum cli_speaker_status status)
{
  switch (status) {
    case CLI_SPEAKER_OK: return "ok";
    case CLI_SPEAKER_ERR_ARG: return "bad-argument";
    case CLI_SPEAKER_ERR_FULL: return "full";
    case CLI_SPEAKER_ERR_EMPTY: return "empty";
    default: return "unknown";
  }
}

void cli_speaker_clear(struct cli_speaker *speaker)
{
  if (speaker == NULL) return;
  speaker->read = 0U;
  speaker->write = 0U;
  speaker->used = 0U;
}

size_t cli_speaker_space(const struct cli_speaker *speaker)
{
  if (speaker == NULL || speaker->used > sizeof(speaker->bytes)) return 0U;
  return sizeof(speaker->bytes) - speaker->used;
}

uint32_t cli_speaker_queued_ms(const struct cli_speaker *speaker)
{
  if (speaker == NULL || speaker->used > sizeof(speaker->bytes)) return 0U;
  return (uint32_t)(speaker->used / CLI_SPEAKER_BYTES_PER_MS);
}

enum cli_speaker_status cli_speaker_write(
    struct cli_speaker *speaker, const uint8_t *pcm, size_t length)
{
  if (speaker == NULL || pcm == NULL || length == 0U) {
    return CLI_SPEAKER_ERR_ARG;
  }
  if (speaker->used > sizeof(speaker->bytes)) return CLI_SPEAKER_ERR_ARG;
  if (length > cli_speaker_space(speaker)) return CLI_SPEAKER_ERR_FULL;

  cli_speaker_copy_in(speaker, pcm, length);
  return CLI_SPEAKER_OK;
}

enum cli_speaker_status cli_speaker_read(
    struct cli_speaker *speaker, uint8_t *out, size_t length)
{
  if (speaker == NULL || out == NULL || length == 0U) {
    return CLI_SPEAKER_ERR_ARG;
  }
  if (speaker->used > sizeof(speaker->bytes)) return CLI_SPEAKER_ERR_ARG;
  if (length > speaker->used) return CLI_SPEAKER_ERR_EMPTY;

  cli_speaker_copy_out(speaker, out, length);
  return CLI_SPEAKER_OK;
}

static void cli_speaker_copy_in(
    struct cli_speaker *speaker, const uint8_t *pcm, size_t length)
{
  assert(speaker != NULL && pcm != NULL);
  assert(speaker->write < sizeof(speaker->bytes));
  assert(length <= sizeof(speaker->bytes) - speaker->used);
  const size_t tail = sizeof(speaker->bytes) - speaker->write;
  const size_t first = length < tail ? length : tail;
  memcpy(speaker->bytes + speaker->write, pcm, first);
  memcpy(speaker->bytes, pcm + first, length - first);
  speaker->write = (speaker->write + length) % sizeof(speaker->bytes);
  speaker->used += length;
  assert(speaker->used <= sizeof(speaker->bytes));
}

static void cli_speaker_copy_out(
    struct cli_speaker *speaker, uint8_t *out, size_t length)
{
  assert(speaker != NULL && out != NULL);
  assert(speaker->read < sizeof(speaker->bytes));
  assert(length <= speaker->used);
  const size_t tail = sizeof(speaker->bytes) - speaker->read;
  const size_t first = length < tail ? length : tail;
  memcpy(out, speaker->bytes + speaker->read, first);
  memcpy(out + first, speaker->bytes, length - first);
  speaker->read = (speaker->read + length) % sizeof(speaker->bytes);
  speaker->used -= length;
  assert(speaker->used <= sizeof(speaker->bytes));
}
