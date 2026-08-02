#include "cli_wav.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

enum {
  FRAME_BYTES = 640,
  SAMPLE_RATE_HZ = 16000,
};

/*
 * The sink is the only witness to what a listener would have heard, so the
 * cases here are the ones that would let a bad run look good: a header whose
 * lengths were never patched (no player opens the file, so nobody listens), a
 * file at the wrong sample rate silently accepted (every measurement then
 * describes a different device), and a truncated read reported as success (the
 * caller sends a frame of stale stack).
 */

static char *temp_path(char *buffer, size_t capacity, const char *suffix)
{
  (void)snprintf(buffer, capacity, "/tmp/iterate-kit-cli-wav-%s.wav", suffix);
  return buffer;
}

/* A minimal valid 16 kHz mono PCM16 file with `samples` samples of `value`. */
static void write_fixture(const char *path, uint16_t samples, int16_t value)
{
  struct cli_wav_sink sink;
  memset(&sink, 0, sizeof(sink));
  assert(cli_wav_sink_open(&sink, path) == CLI_WAV_OK);
  for (uint16_t index = 0U; index < samples; ++index) {
    const uint8_t encoded[2] = {
      (uint8_t)((uint16_t)value & 0xFFU),
      (uint8_t)(((uint16_t)value >> 8U) & 0xFFU),
    };
    assert(cli_wav_sink_write(&sink, encoded, sizeof(encoded)) == CLI_WAV_OK);
  }
  cli_wav_sink_close(&sink);
}

/*
 * A recording is worthless unless its RIFF lengths are patched on close: an
 * unpatched file reports zero samples and every player refuses it, so a run
 * that sounded terrible produces no evidence at all.
 */
static void sink_patches_its_lengths_on_close(void)
{
  char path[128];
  (void)temp_path(path, sizeof(path), "sink");
  write_fixture(path, 100U, 1234);

  FILE *file = fopen(path, "rb");
  assert(file != NULL);
  uint8_t header[44];
  assert(fread(header, 1U, sizeof(header), file) == sizeof(header));
  (void)fclose(file);

  const uint32_t riff = (uint32_t)header[4] | ((uint32_t)header[5] << 8U) |
      ((uint32_t)header[6] << 16U) | ((uint32_t)header[7] << 24U);
  const uint32_t data = (uint32_t)header[40] | ((uint32_t)header[41] << 8U) |
      ((uint32_t)header[42] << 16U) | ((uint32_t)header[43] << 24U);
  assert(data == 200U);
  assert(riff == 236U);
  (void)remove(path);
}

/* What was written comes back, frame by frame, in order. */
static void source_replays_what_the_sink_wrote(void)
{
  char path[128];
  (void)temp_path(path, sizeof(path), "roundtrip");
  write_fixture(path, FRAME_BYTES / 2U, 4321);

  struct cli_wav_source source;
  memset(&source, 0, sizeof(source));
  assert(cli_wav_source_open(&source, path) == CLI_WAV_OK);
  uint8_t frame[FRAME_BYTES];
  assert(cli_wav_source_frame(&source, frame, sizeof(frame)) == CLI_WAV_OK);
  assert(frame[0] == (4321U & 0xFFU));
  assert(frame[1] == ((4321U >> 8U) & 0xFFU));
  /* Exhausted: this is how a caller learns the utterance has finished. */
  assert(cli_wav_source_frame(&source, frame, sizeof(frame)) == CLI_WAV_ERR_IO);
  cli_wav_source_close(&source);
  (void)remove(path);
}

/*
 * A short final read must be padded, not reported short. Sending a partly
 * filled frame would put whatever the buffer held before — stale speech from
 * the previous utterance — on the wire as if the microphone had heard it.
 */
static void a_partial_final_frame_is_zero_padded(void)
{
  char path[128];
  (void)temp_path(path, sizeof(path), "partial");
  write_fixture(path, 10U, 999);

  struct cli_wav_source source;
  memset(&source, 0, sizeof(source));
  assert(cli_wav_source_open(&source, path) == CLI_WAV_OK);
  uint8_t frame[FRAME_BYTES];
  memset(frame, 0x7F, sizeof(frame));
  assert(cli_wav_source_frame(&source, frame, sizeof(frame)) == CLI_WAV_OK);
  for (size_t index = 20U; index < sizeof(frame); ++index) {
    assert(frame[index] == 0U);
  }
  cli_wav_source_close(&source);
  (void)remove(path);
}

/*
 * The wrong sample rate must be REFUSED, not resampled or accepted. Accepting
 * 44.1 kHz here would make every latency and continuity number describe a
 * device nobody is testing, and nothing downstream could notice.
 */
static void a_file_at_the_wrong_rate_is_refused(void)
{
  char path[128];
  (void)temp_path(path, sizeof(path), "rate");
  write_fixture(path, 10U, 1);

  FILE *file = fopen(path, "rb+");
  assert(file != NULL);
  assert(fseek(file, 24L, SEEK_SET) == 0);
  const uint8_t rate[4] = {0x44U, 0xACU, 0x00U, 0x00U}; /* 44100 */
  assert(fwrite(rate, 1U, sizeof(rate), file) == sizeof(rate));
  (void)fclose(file);

  struct cli_wav_source source;
  memset(&source, 0, sizeof(source));
  assert(cli_wav_source_open(&source, path) == CLI_WAV_ERR_UNSUPPORTED);
  (void)remove(path);
}

/* A missing file is a distinct, actionable status, not a generic failure. */
static void a_missing_file_says_so(void)
{
  struct cli_wav_source source;
  memset(&source, 0, sizeof(source));
  assert(cli_wav_source_open(&source, "/tmp/iterate-kit-cli-wav-absent.wav") ==
         CLI_WAV_ERR_OPEN);
  assert(strcmp(cli_wav_status_name(CLI_WAV_ERR_OPEN), "cannot-open") == 0);
}

/* With no file at all the microphone still produces bounded voiced audio. */
static void synthesis_is_bounded_and_not_silence(void)
{
  struct cli_wav_source source;
  memset(&source, 0, sizeof(source));
  assert(cli_wav_source_open(&source, NULL) == CLI_WAV_OK);
  uint8_t frame[FRAME_BYTES];
  bool heard_a_nonzero_sample = false;
  uint32_t frames = 0U;
  while (cli_wav_source_frame(&source, frame, sizeof(frame)) == CLI_WAV_OK) {
    for (size_t index = 0U; index < sizeof(frame); ++index) {
      if (frame[index] != 0U) heard_a_nonzero_sample = true;
    }
    ++frames;
    assert(frames <= 1000U); /* bounded, or an unattended run never ends */
  }
  assert(heard_a_nonzero_sample);
  assert(frames * (FRAME_BYTES / 2U) <= 10U * SAMPLE_RATE_HZ);
  cli_wav_source_close(&source);
}

/* Every public entry point rejects a NULL rather than dereferencing it. */
static void null_arguments_are_refused(void)
{
  uint8_t frame[FRAME_BYTES];
  assert(cli_wav_source_open(NULL, NULL) == CLI_WAV_ERR_ARG);
  assert(cli_wav_source_frame(NULL, frame, sizeof(frame)) == CLI_WAV_ERR_ARG);
  assert(cli_wav_sink_open(NULL, "/tmp/x.wav") == CLI_WAV_ERR_ARG);
  assert(cli_wav_sink_write(NULL, frame, sizeof(frame)) == CLI_WAV_ERR_ARG);
  cli_wav_source_close(NULL);
  cli_wav_sink_close(NULL);
}

int main(void)
{
  sink_patches_its_lengths_on_close();
  source_replays_what_the_sink_wrote();
  a_partial_final_frame_is_zero_padded();
  a_file_at_the_wrong_rate_is_refused();
  a_missing_file_says_so();
  synthesis_is_bounded_and_not_silence();
  null_arguments_are_refused();
  return 0;
}
