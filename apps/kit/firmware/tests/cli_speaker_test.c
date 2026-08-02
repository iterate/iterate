#include "cli_speaker.h"

#include <assert.h>
#include <string.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

enum {
  TEST_FRAME_BYTES = ITERATE_KIT_VOICE_FRAME_BYTES,
  TEST_FULL_FRAMES =
      ITERATE_KIT_VOICE_SPEAKER_BUFFER_BYTES / ITERATE_KIT_VOICE_FRAME_BYTES,
  TEST_EXISTING_BYTE = 0x31,
  TEST_REJECTED_BYTE = 0x72,
};

static struct cli_speaker speaker;
static uint8_t input[ITERATE_KIT_VOICE_SPEAKER_BUFFER_BYTES];
static uint8_t output[ITERATE_KIT_VOICE_SPEAKER_BUFFER_BYTES];

/*
 * Long answers make both cursors cross the allocation boundary. A queue that
 * copies only its contiguous tail repeats old PCM or changes frame order at
 * that point, which a listener hears as a click followed by corrupt speech.
 */
static void playback_stays_ordered_when_both_cursors_wrap(void)
{
  cli_speaker_clear(&speaker);
  for (size_t index = 0U; index < sizeof(input); ++index) {
    input[index] = (uint8_t)(index % TEST_FRAME_BYTES);
  }
  assert(cli_speaker_write(&speaker, input, sizeof(input)) == CLI_SPEAKER_OK);
  assert(cli_speaker_read(&speaker, output, TEST_FRAME_BYTES) ==
         CLI_SPEAKER_OK);
  assert(cli_speaker_write(&speaker, input, TEST_FRAME_BYTES) ==
         CLI_SPEAKER_OK);
  assert(cli_speaker_read(&speaker, output, sizeof(output)) == CLI_SPEAKER_OK);
  assert(memcmp(output, input + TEST_FRAME_BYTES,
                sizeof(input) - TEST_FRAME_BYTES) == 0);
  assert(memcmp(output + sizeof(input) - TEST_FRAME_BYTES,
                input, TEST_FRAME_BYTES) == 0);
}

/*
 * A frame arriving with only half a frame free must be refused whole. Copying
 * the half that fits splices two unrelated waveforms and clicks on this frame
 * and every frame whose boundary follows it.
 */
static void a_frame_that_does_not_fit_is_refused_without_splicing(void)
{
  cli_speaker_clear(&speaker);
  memset(input, TEST_EXISTING_BYTE, sizeof(input));
  const size_t almost_full = sizeof(input) - TEST_FRAME_BYTES / 2U;
  assert(cli_speaker_write(&speaker, input, almost_full) == CLI_SPEAKER_OK);
  const size_t used_before = speaker.used;
  memset(output, TEST_REJECTED_BYTE, TEST_FRAME_BYTES);
  assert(cli_speaker_write(&speaker, output, TEST_FRAME_BYTES) ==
         CLI_SPEAKER_ERR_FULL);
  assert(speaker.used == used_before);
  assert(cli_speaker_read(&speaker, output, almost_full) == CLI_SPEAKER_OK);
  for (size_t index = 0U; index < almost_full; ++index) {
    assert(output[index] == TEST_EXISTING_BYTE);
  }
}

/*
 * Playback thresholds are expressed in milliseconds. Off-by-one arithmetic
 * at empty, one frame, or saturation changes when playout primes and when it
 * sheds latency, so all three boundary facts are fixed here.
 */
static void queued_milliseconds_match_empty_one_frame_and_full(void)
{
  cli_speaker_clear(&speaker);
  assert(cli_speaker_queued_ms(&speaker) == 0U);
  assert(cli_speaker_write(&speaker, input, TEST_FRAME_BYTES) ==
         CLI_SPEAKER_OK);
  assert(cli_speaker_queued_ms(&speaker) == ITERATE_KIT_VOICE_FRAME_MS);
  assert(cli_speaker_write(
             &speaker, input + TEST_FRAME_BYTES,
             sizeof(input) - TEST_FRAME_BYTES) == CLI_SPEAKER_OK);
  assert(speaker.used == sizeof(input));
  assert(cli_speaker_queued_ms(&speaker) ==
         TEST_FULL_FRAMES * ITERATE_KIT_VOICE_FRAME_MS);
}

/* Every public boundary refuses unusable storage instead of corrupting it. */
static void unusable_arguments_are_refused(void)
{
  assert(cli_speaker_write(NULL, input, TEST_FRAME_BYTES) ==
         CLI_SPEAKER_ERR_ARG);
  assert(cli_speaker_read(&speaker, NULL, TEST_FRAME_BYTES) ==
         CLI_SPEAKER_ERR_ARG);
  assert(strcmp(cli_speaker_status_name(CLI_SPEAKER_ERR_FULL), "full") == 0);
}

int main(void)
{
  playback_stays_ordered_when_both_cursors_wrap();
  a_frame_that_does_not_fit_is_refused_without_splicing();
  queued_milliseconds_match_empty_one_frame_and_full();
  unusable_arguments_are_refused();
  return 0;
}
