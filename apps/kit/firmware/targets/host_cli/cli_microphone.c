/* cli_microphone.c: owns the latest-wins queue of captured PCM frames. */

#include <assert.h>
#include <string.h>

#include "cli_microphone.h"

/* Advances the oldest-frame cursor after an observed overflow. */
static void cli_microphone_displace_oldest(struct cli_microphone *microphone);

/* Copies one validated frame into the next producer slot. */
static void cli_microphone_store(
    struct cli_microphone *microphone, const uint8_t *frame);

const char *cli_microphone_status_name(enum cli_microphone_status status)
{
  switch (status) {
    case CLI_MICROPHONE_OK: return "ok";
    case CLI_MICROPHONE_ERR_ARG: return "bad-argument";
    case CLI_MICROPHONE_ERR_EMPTY: return "empty";
    default: return "unknown";
  }
}

void cli_microphone_clear(struct cli_microphone *microphone)
{
  if (microphone == NULL) return;
  microphone->read = 0U;
  microphone->write = 0U;
  microphone->used = 0U;
}

size_t cli_microphone_queued(const struct cli_microphone *microphone)
{
  if (microphone == NULL ||
      microphone->used > ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH) {
    return 0U;
  }
  return microphone->used;
}

enum cli_microphone_status cli_microphone_push(
    struct cli_microphone *microphone, const uint8_t *frame, size_t length)
{
  if (microphone == NULL || frame == NULL ||
      length != ITERATE_KIT_VOICE_FRAME_BYTES) {
    return CLI_MICROPHONE_ERR_ARG;
  }
  if (microphone->used > ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH) {
    return CLI_MICROPHONE_ERR_ARG;
  }
  if (microphone->used == ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH) {
    cli_microphone_displace_oldest(microphone);
  }
  cli_microphone_store(microphone, frame);
  return CLI_MICROPHONE_OK;
}

enum cli_microphone_status cli_microphone_pop(
    struct cli_microphone *microphone, uint8_t *out, size_t length)
{
  if (microphone == NULL || out == NULL ||
      length != ITERATE_KIT_VOICE_FRAME_BYTES) {
    return CLI_MICROPHONE_ERR_ARG;
  }
  if (microphone->used > ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH) {
    return CLI_MICROPHONE_ERR_ARG;
  }
  if (microphone->used == 0U) return CLI_MICROPHONE_ERR_EMPTY;

  memcpy(out, microphone->frames[microphone->read], length);
  microphone->read =
      (microphone->read + 1U) % ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH;
  --microphone->used;
  assert(microphone->used < ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH);
  return CLI_MICROPHONE_OK;
}

static void cli_microphone_displace_oldest(struct cli_microphone *microphone)
{
  assert(microphone != NULL);
  assert(microphone->used == ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH);
  microphone->read =
      (microphone->read + 1U) % ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH;
  --microphone->used;
  /* A saturated diagnostic is still monotonic; wrapping would look healed. */
  if (microphone->dropped < UINT32_MAX) ++microphone->dropped;
  assert(microphone->used + 1U == ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH);
}

static void cli_microphone_store(
    struct cli_microphone *microphone, const uint8_t *frame)
{
  assert(microphone != NULL && frame != NULL);
  assert(microphone->write < ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH);
  assert(microphone->used < ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH);
  memcpy(
      microphone->frames[microphone->write], frame,
      ITERATE_KIT_VOICE_FRAME_BYTES);
  microphone->write =
      (microphone->write + 1U) % ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH;
  ++microphone->used;
  assert(microphone->used <= ITERATE_KIT_VOICE_MIC_QUEUE_DEPTH);
}
