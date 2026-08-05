#include "iterate/kit/platforms/darwin_audio_output.h"

#include "cli_wav.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

/* The hardware-facing ring is deliberately large, so keep it off the stack. */
static struct iterate_kit_darwin_audio_output output;
static struct cli_wav_sink sink;
static uint8_t pcm[ITERATE_KIT_DARWIN_AUDIO_OUTPUT_RING_BYTES];

static bool write_wav(void *context, const uint8_t *samples, size_t length)
{
  return cli_wav_sink_write(context, samples, length) == CLI_WAV_OK;
}

static void open_file_output(const char *path)
{
  memset(&output, 0, sizeof(output));
  memset(&sink, 0, sizeof(sink));
  assert(cli_wav_sink_open(&sink, path) == CLI_WAV_OK);
  const struct iterate_kit_darwin_audio_file_sink file_sink = {
    .context = &sink,
    .write = write_wav,
  };
  assert(iterate_kit_darwin_audio_output_open_file(&output, &file_sink) ==
         ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
}

static void close_file_output(const char *path)
{
  iterate_kit_darwin_audio_output_close(&output);
  cli_wav_sink_close(&sink);
  (void)remove(path);
}

/* Drain confirms every accepted byte at the file/hardware boundary. */
static void drain_accounts_only_payload_that_completed(void)
{
  const char *path = "/tmp/iterate-kit-darwin-audio-drain.wav";
  open_file_output(path);
  memset(pcm, 0x5AU, 2U * ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES);
  assert(iterate_kit_darwin_audio_output_write(
             &output, pcm, 2U * ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES) ==
         ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
  assert(iterate_kit_darwin_audio_output_completed_bytes(&output) == 0U);
  assert(iterate_kit_darwin_audio_output_drain(&output, 100U) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
  assert(iterate_kit_darwin_audio_output_queued_bytes(&output) == 0U);
  assert(iterate_kit_darwin_audio_output_completed_bytes(&output) ==
         2U * ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES);
  assert(iterate_kit_darwin_audio_output_starved_buffers(&output) == 0U);
  assert(iterate_kit_darwin_audio_output_platform_error(&output) == 0);
  close_file_output(path);
}

/* Refused room audio is bounded, returned, and counted in bytes. */
static void a_full_ring_cannot_look_like_success(void)
{
  const char *path = "/tmp/iterate-kit-darwin-audio-full.wav";
  open_file_output(path);
  memset(pcm, 0x2AU, sizeof(pcm));
  assert(iterate_kit_darwin_audio_output_write(&output, pcm, sizeof(pcm)) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
  assert(iterate_kit_darwin_audio_output_write(
             &output, pcm, ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES) ==
         ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_FULL);
  assert(output.dropped == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES);
  assert(iterate_kit_darwin_audio_output_drain(&output, 100U) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
  assert(iterate_kit_darwin_audio_output_completed_bytes(&output) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_RING_BYTES);
  close_file_output(path);
}

/* A dry pull is a hole only when later answer payload proves speech resumed. */
static void starvation_has_an_explicit_answer_window(void)
{
  const char *path = "/tmp/iterate-kit-darwin-audio-starve.wav";
  open_file_output(path);
  iterate_kit_darwin_audio_output_pump(&output, 1000U);
  assert(iterate_kit_darwin_audio_output_starved_buffers(&output) == 0U);
  iterate_kit_darwin_audio_output_set_expected(&output, true);
  iterate_kit_darwin_audio_output_pump(&output, 21000U);
  assert(iterate_kit_darwin_audio_output_starved_buffers(&output) == 0U);
  memset(pcm, 0x3AU, ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES);
  assert(iterate_kit_darwin_audio_output_write(
             &output, pcm, ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
  iterate_kit_darwin_audio_output_pump(&output, 41000U);
  assert(iterate_kit_darwin_audio_output_starved_buffers(&output) == 1U);
  iterate_kit_darwin_audio_output_set_expected(&output, false);
  iterate_kit_darwin_audio_output_pump(&output, 61000U);
  assert(iterate_kit_darwin_audio_output_starved_buffers(&output) == 1U);
  assert(iterate_kit_darwin_audio_output_drain(&output, 100U) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
  close_file_output(path);
}

/* An answer's final dry pulls are idle tail, not error telemetry. */
static void trailing_silence_is_not_starvation(void)
{
  const char *path = "/tmp/iterate-kit-darwin-audio-tail.wav";
  open_file_output(path);
  memset(pcm, 0x4AU, ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES);
  assert(iterate_kit_darwin_audio_output_write(
             &output, pcm, ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_BYTES) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
  iterate_kit_darwin_audio_output_pump(&output, 1000U);
  iterate_kit_darwin_audio_output_pump(&output, 21000U);
  assert(iterate_kit_darwin_audio_output_starved_buffers(&output) == 0U);
  iterate_kit_darwin_audio_output_set_expected(&output, false);
  assert(iterate_kit_darwin_audio_output_starved_buffers(&output) == 0U);
  assert(iterate_kit_darwin_audio_output_drain(&output, 100U) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_OK);
  close_file_output(path);
}

static void unusable_arguments_are_refused(void)
{
  const struct iterate_kit_darwin_audio_file_sink file_sink = {
    .context = &sink,
    .write = write_wav,
  };
  assert(iterate_kit_darwin_audio_output_open(NULL) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_ARG);
  assert(iterate_kit_darwin_audio_output_open_file(NULL, &file_sink) ==
         ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_ARG);
  assert(iterate_kit_darwin_audio_output_open_file(&output, NULL) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_ARG);
  assert(iterate_kit_darwin_audio_output_write(NULL, pcm, sizeof(pcm)) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_ARG);
  assert(iterate_kit_darwin_audio_output_drain(NULL, 100U) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_ARG);
  assert(iterate_kit_darwin_audio_output_drain(&output, 0U) == ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_ARG);
  assert(strcmp(iterate_kit_darwin_audio_output_status_name(ITERATE_KIT_DARWIN_AUDIO_OUTPUT_ERR_TIMEOUT),
                "timeout") == 0);
  iterate_kit_darwin_audio_output_close(NULL);
}

int main(void)
{
  drain_accounts_only_payload_that_completed();
  a_full_ring_cannot_look_like_success();
  starvation_has_an_explicit_answer_window();
  trailing_silence_is_not_starvation();
  unusable_arguments_are_refused();
  return 0;
}
