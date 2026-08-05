#include "cli_audio_out.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

/* The hardware-facing ring is deliberately large, so keep it off the stack. */
static struct cli_audio_out output;
static struct cli_wav_sink sink;
static uint8_t pcm[CLI_AUDIO_OUT_RING_BYTES];

static void open_file_output(const char *path)
{
  memset(&output, 0, sizeof(output));
  memset(&sink, 0, sizeof(sink));
  assert(cli_wav_sink_open(&sink, path) == CLI_WAV_OK);
  assert(cli_audio_out_open_file(&output, &sink) == CLI_AUDIO_OUT_OK);
}

static void close_file_output(const char *path)
{
  cli_audio_out_close(&output);
  cli_wav_sink_close(&sink);
  (void)remove(path);
}

/* Drain confirms every accepted byte at the file/hardware boundary. */
static void drain_accounts_only_payload_that_completed(void)
{
  const char *path = "/tmp/iterate-kit-cli-audio-out-drain.wav";
  open_file_output(path);
  memset(pcm, 0x5AU, 2U * CLI_AUDIO_OUT_BUFFER_BYTES);
  assert(cli_audio_out_write(
             &output, pcm, 2U * CLI_AUDIO_OUT_BUFFER_BYTES) ==
         CLI_AUDIO_OUT_OK);
  assert(cli_audio_out_completed_bytes(&output) == 0U);
  assert(cli_audio_out_drain(&output, 100U) == CLI_AUDIO_OUT_OK);
  assert(cli_audio_out_queued_bytes(&output) == 0U);
  assert(cli_audio_out_completed_bytes(&output) ==
         2U * CLI_AUDIO_OUT_BUFFER_BYTES);
  assert(cli_audio_out_starved_buffers(&output) == 0U);
  assert(cli_audio_out_platform_error(&output) == 0);
  close_file_output(path);
}

/* Refused room audio is bounded, returned, and counted in bytes. */
static void a_full_ring_cannot_look_like_success(void)
{
  const char *path = "/tmp/iterate-kit-cli-audio-out-full.wav";
  open_file_output(path);
  memset(pcm, 0x2AU, sizeof(pcm));
  assert(cli_audio_out_write(&output, pcm, sizeof(pcm)) == CLI_AUDIO_OUT_OK);
  assert(cli_audio_out_write(
             &output, pcm, CLI_AUDIO_OUT_BUFFER_BYTES) ==
         CLI_AUDIO_OUT_ERR_FULL);
  assert(output.dropped == CLI_AUDIO_OUT_BUFFER_BYTES);
  assert(cli_audio_out_drain(&output, 100U) == CLI_AUDIO_OUT_OK);
  assert(cli_audio_out_completed_bytes(&output) == CLI_AUDIO_OUT_RING_BYTES);
  close_file_output(path);
}

/* A dry pull is a hole only when later answer payload proves speech resumed. */
static void starvation_has_an_explicit_answer_window(void)
{
  const char *path = "/tmp/iterate-kit-cli-audio-out-starve.wav";
  open_file_output(path);
  cli_audio_out_pump(&output, 1000U);
  assert(cli_audio_out_starved_buffers(&output) == 0U);
  cli_audio_out_set_expected(&output, true);
  cli_audio_out_pump(&output, 21000U);
  assert(cli_audio_out_starved_buffers(&output) == 0U);
  memset(pcm, 0x3AU, CLI_AUDIO_OUT_BUFFER_BYTES);
  assert(cli_audio_out_write(
             &output, pcm, CLI_AUDIO_OUT_BUFFER_BYTES) == CLI_AUDIO_OUT_OK);
  cli_audio_out_pump(&output, 41000U);
  assert(cli_audio_out_starved_buffers(&output) == 1U);
  cli_audio_out_set_expected(&output, false);
  cli_audio_out_pump(&output, 61000U);
  assert(cli_audio_out_starved_buffers(&output) == 1U);
  assert(cli_audio_out_drain(&output, 100U) == CLI_AUDIO_OUT_OK);
  close_file_output(path);
}

/* An answer's final dry pulls are idle tail, not error telemetry. */
static void trailing_silence_is_not_starvation(void)
{
  const char *path = "/tmp/iterate-kit-cli-audio-out-tail.wav";
  open_file_output(path);
  memset(pcm, 0x4AU, CLI_AUDIO_OUT_BUFFER_BYTES);
  assert(cli_audio_out_write(
             &output, pcm, CLI_AUDIO_OUT_BUFFER_BYTES) == CLI_AUDIO_OUT_OK);
  cli_audio_out_pump(&output, 1000U);
  cli_audio_out_pump(&output, 21000U);
  assert(cli_audio_out_starved_buffers(&output) == 0U);
  cli_audio_out_set_expected(&output, false);
  assert(cli_audio_out_starved_buffers(&output) == 0U);
  assert(cli_audio_out_drain(&output, 100U) == CLI_AUDIO_OUT_OK);
  close_file_output(path);
}

static void unusable_arguments_are_refused(void)
{
  assert(cli_audio_out_open(NULL) == CLI_AUDIO_OUT_ERR_ARG);
  assert(cli_audio_out_open_file(NULL, &sink) == CLI_AUDIO_OUT_ERR_ARG);
  assert(cli_audio_out_open_file(&output, NULL) == CLI_AUDIO_OUT_ERR_ARG);
  assert(cli_audio_out_write(NULL, pcm, sizeof(pcm)) == CLI_AUDIO_OUT_ERR_ARG);
  assert(cli_audio_out_drain(NULL, 100U) == CLI_AUDIO_OUT_ERR_ARG);
  assert(cli_audio_out_drain(&output, 0U) == CLI_AUDIO_OUT_ERR_ARG);
  assert(strcmp(cli_audio_out_status_name(CLI_AUDIO_OUT_ERR_TIMEOUT),
                "timeout") == 0);
  cli_audio_out_close(NULL);
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
