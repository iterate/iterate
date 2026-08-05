#include "cli_device_profile.h"

#include "iterate/kit/voice_device_profile.h"
#include "iterate/kit/platforms/darwin_audio_output.h"

#include <assert.h>
#include <stdint.h>
#include <string.h>

#ifdef NDEBUG
#error "firmware tests must execute assertions"
#endif

/*
 * THE FAILURE THESE TESTS EXIST TO PREVENT.
 *
 * The rig runs the device's own C, so a run that passes on the host is taken
 * as evidence about the board. That inference is only worth anything while the
 * numbers agree. Let the board's row drift — a ring resized in
 * voice_device_profile.h and not here, a prefill raised on the device and left
 * alone on the host — and the rig keeps passing, keeps being believed, and is
 * now describing hardware nobody owns. A simulator that has quietly stopped
 * matching the firmware it simulates is worse than no simulator at all.
 *
 * So the first test below is the whole reason the module is safe to trust: it
 * compares the typed-out board row against the compiled constants the firmware
 * itself uses. The rest are the ways a table of profiles can be wrong without
 * drifting: a row nobody finished, a name that answers to nothing, a walk that
 * does not cover what --help promises.
 */

enum {
  /* host-ideal and waveshare-s3-amoled. A third row must be a deliberate one. */
  PROFILE_COUNT = 2,
  /* Exact at 16 kHz PCM16: 640 bytes per 20 ms frame. */
  DEVICE_BYTES_PER_MS =
      ITERATE_KIT_VOICE_FRAME_BYTES / ITERATE_KIT_VOICE_FRAME_MS,
  DEVICE_MS_PER_SECOND = 1000,
  DEVICE_BYTES_PER_SAMPLE = 2,
  /*
   * voice_device_profile.h states its prefill as "300 ms acoustic lead plus
   * the 90 ms I2S DMA lead" and compiles only the SUM, so the two halves are
   * spelled here and the sum is checked against the constant below. The I2S
   * half is what the board's output peripheral holds ahead of the speaker.
   */
  DEVICE_ACOUSTIC_LEAD_MS = 300,
  DEVICE_I2S_LEAD_MS = 90,
};

/* The board's row, which every drift assertion is about. */
static const struct cli_device_profile *board(void);

/*
 * THE DELIVERABLE.
 *
 * Every number in the board's row, against the constant the firmware on that
 * board compiles. If this fails, the correct response is never to edit the
 * assertion: either the rig has drifted and must be brought back, or the
 * device's budgets moved and every result the rig produced since is about the
 * old board.
 */
static void the_board_profile_agrees_with_the_firmware_it_simulates(void)
{
  const struct cli_device_profile *profile = board();

  assert(profile->frame_bytes == (uint32_t)ITERATE_KIT_VOICE_FRAME_BYTES);
  assert(profile->speaker_ring_bytes ==
         (uint32_t)ITERATE_KIT_VOICE_SPEAKER_BUFFER_BYTES);
  assert(profile->speaker_prefill_bytes ==
         (uint32_t)ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES);
  assert(profile->capture_frames_per_second ==
         (uint32_t)(DEVICE_MS_PER_SECOND / ITERATE_KIT_VOICE_FRAME_MS));
  /*
   * No sample rate is compiled over there; the wire frame is 320 samples of
   * 20 ms, which is 16 kHz and nothing else. Asserted as that division rather
   * than as 16000 so a re-rated frame cannot leave this row behind.
   */
  assert(profile->sample_rate_hz ==
         (uint32_t)(ITERATE_KIT_VOICE_FRAME_SAMPLES * DEVICE_MS_PER_SECOND /
                    ITERATE_KIT_VOICE_FRAME_MS));
  assert(profile->frame_bytes ==
         (uint32_t)(ITERATE_KIT_VOICE_FRAME_SAMPLES * DEVICE_BYTES_PER_SAMPLE));

  /* The prefill is the two leads together, so naming one names the other. */
  assert((DEVICE_ACOUSTIC_LEAD_MS + DEVICE_I2S_LEAD_MS) * DEVICE_BYTES_PER_MS ==
         ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES);
  /* Whole frames only: hardware cannot hold the remaining half of one. */
  assert(profile->output_lead_frames ==
         (uint32_t)(DEVICE_I2S_LEAD_MS / ITERATE_KIT_VOICE_FRAME_MS));

  /* FreeRTOS takes the audio task away; that is the point of the board row. */
  assert(profile->preemptive);
}

/*
 * The default has to be the rig as it stands, or the first thing this module
 * does is change every result that came before it. The two byte budgets below
 * are the ones the host binary literally compiles — cli_speaker's array and
 * the playback clock's wait — so the default row is a description of this
 * build rather than a second opinion about it.
 */
static void the_default_profile_is_the_rig_as_it_already_runs(void)
{
  const struct cli_device_profile *profile = cli_device_profile_default();

  assert(profile != NULL);
  assert(strcmp(profile->name, "host-ideal") == 0);
  assert(profile == cli_device_profile_at(0U));
  assert(profile->speaker_ring_bytes ==
         (uint32_t)ITERATE_KIT_VOICE_SPEAKER_BUFFER_BYTES);
  assert(profile->speaker_prefill_bytes ==
         (uint32_t)ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES);
  assert(profile->frame_bytes == (uint32_t)ITERATE_KIT_VOICE_FRAME_BYTES);
  assert(profile->output_lead_frames ==
         (uint32_t)(ITERATE_KIT_DARWIN_AUDIO_OUTPUT_BUFFER_COUNT +
                    ITERATE_KIT_DARWIN_AUDIO_OUTPUT_LEAD_BYTES /
                        ITERATE_KIT_VOICE_FRAME_BYTES));
  /*
   * The two axes on which the host is not the board, and the reason a stall
   * that is audible there is silent here: a deeper output queue and a loop
   * nothing preempts.
   */
  assert(profile->output_lead_frames > board()->output_lead_frames);
  assert(!profile->preemptive);
}

/*
 * A built-in that fails its own coherence check would be a rig running at a
 * size nobody meant, and the check would only ever be exercised against
 * profiles a test made up. Every row ships through the same gate.
 */
static void every_built_in_profile_is_internally_coherent(void)
{
  assert(cli_device_profile_count() == (size_t)PROFILE_COUNT);
  for (size_t index = 0U; index < cli_device_profile_count(); ++index) {
    const struct cli_device_profile *profile = cli_device_profile_at(index);
    assert(profile != NULL);
    assert(cli_device_profile_check(profile));
  }
}

/*
 * A mistyped --device must not be answered with a profile. The out pointer is
 * left alone on purpose: writing NULL into it would turn a spelling mistake
 * into a crash three frames into the call, and the operator would be reading a
 * stack trace instead of a list of names.
 */
static void an_unknown_device_is_refused_without_touching_the_caller(void)
{
  const struct cli_device_profile *found = cli_device_profile_default();
  const struct cli_device_profile *before = found;

  assert(cli_device_profile_find("waveshare-s3-amolod", &found) ==
         CLI_DEVICE_PROFILE_ERR_UNKNOWN);
  assert(found == before);
  assert(cli_device_profile_find("", &found) == CLI_DEVICE_PROFILE_ERR_UNKNOWN);
  assert(found == before);

  assert(cli_device_profile_find(NULL, &found) == CLI_DEVICE_PROFILE_ERR_ARG);
  assert(found == before);
  assert(cli_device_profile_find("host-ideal", NULL) ==
         CLI_DEVICE_PROFILE_ERR_ARG);
  assert(strcmp(cli_device_profile_status_name(CLI_DEVICE_PROFILE_ERR_UNKNOWN),
                "unknown-device") == 0);
}

/*
 * --help and the unknown-name error list what the walk returns. A walk that
 * stopped one short would advertise a device the CLI cannot select, and one
 * that ran past the end would read whatever followed the table into a report.
 */
static void the_walk_covers_exactly_the_built_ins(void)
{
  assert(cli_device_profile_at(cli_device_profile_count()) == NULL);
  assert(cli_device_profile_at(SIZE_MAX) == NULL);
  for (size_t index = 0U; index < cli_device_profile_count(); ++index) {
    const struct cli_device_profile *walked = cli_device_profile_at(index);
    assert(walked != NULL);
    /* Every walked row answers to its own name, so --help cannot lie. */
    const struct cli_device_profile *found = NULL;
    assert(cli_device_profile_find(walked->name, &found) ==
           CLI_DEVICE_PROFILE_OK);
    assert(found == walked);
  }
  const struct cli_device_profile *host = NULL;
  const struct cli_device_profile *s3 = NULL;
  assert(cli_device_profile_find("host-ideal", &host) == CLI_DEVICE_PROFILE_OK);
  assert(cli_device_profile_find("waveshare-s3-amoled", &s3) ==
         CLI_DEVICE_PROFILE_OK);
  assert(host != s3);
}

/*
 * The failure the coherence check was written for. A prefill the ring cannot
 * hold is a rig that waits forever for audio it discarded at the door, and it
 * presents not as a bad number but as a device that never speaks.
 */
static void a_prefill_larger_than_its_ring_is_refused(void)
{
  struct cli_device_profile broken = *board();

  assert(cli_device_profile_check(&broken));
  broken.speaker_prefill_bytes = broken.speaker_ring_bytes + 1U;
  assert(!cli_device_profile_check(&broken));
  /* Exactly the ring is still playable, if only just; past it is not. */
  broken.speaker_prefill_bytes = broken.speaker_ring_bytes;
  assert(cli_device_profile_check(&broken));

  /* A lead the ring cannot cover is the same fault told from the other end. */
  broken = *board();
  broken.output_lead_frames = broken.speaker_ring_bytes / broken.frame_bytes;
  assert(!cli_device_profile_check(&broken));
}

/*
 * A zero is not a default. A row half filled in would run the rig at whatever
 * a missing bound happens to mean — no lead, no ring, no capture — and the
 * report would name a board that behaved like nothing on earth.
 */
static void a_profile_left_half_written_is_refused(void)
{
  const struct cli_device_profile whole = *board();

  assert(!cli_device_profile_check(NULL));
  struct cli_device_profile broken = whole;
  broken.name = NULL;
  assert(!cli_device_profile_check(&broken));
  broken = whole;
  broken.summary = "";
  assert(!cli_device_profile_check(&broken));
  broken = whole;
  broken.frame_bytes = 0U;
  assert(!cli_device_profile_check(&broken));
  broken = whole;
  broken.sample_rate_hz = 0U;
  assert(!cli_device_profile_check(&broken));
  broken = whole;
  broken.output_lead_frames = 0U;
  assert(!cli_device_profile_check(&broken));
  broken = whole;
  broken.speaker_ring_bytes = 0U;
  assert(!cli_device_profile_check(&broken));
  broken = whole;
  broken.speaker_prefill_bytes = 0U;
  assert(!cli_device_profile_check(&broken));
  broken = whole;
  broken.capture_frames_per_second = 0U;
  assert(!cli_device_profile_check(&broken));
}

static const struct cli_device_profile *board(void)
{
  const struct cli_device_profile *profile = NULL;
  assert(cli_device_profile_find("waveshare-s3-amoled", &profile) ==
         CLI_DEVICE_PROFILE_OK);
  assert(profile != NULL);
  return profile;
}

int main(void)
{
  the_board_profile_agrees_with_the_firmware_it_simulates();
  the_default_profile_is_the_rig_as_it_already_runs();
  every_built_in_profile_is_internally_coherent();
  an_unknown_device_is_refused_without_touching_the_caller();
  the_walk_covers_exactly_the_built_ins();
  a_prefill_larger_than_its_ring_is_refused();
  a_profile_left_half_written_is_refused();
  return 0;
}
