/* cli_device_profile.c: the table of boards the rig can be, and its guards. */

#include <assert.h>
#include <string.h>

#include "cli_device_profile.h"

#include "iterate/kit/voice_device_profile.h"

enum {
  CLI_DEVICE_PROFILE_MS_PER_SECOND = 1000,
  /* The row a caller gets when nobody chose one. */
  CLI_DEVICE_PROFILE_DEFAULT_INDEX = 0,
};

/*
 * THE HOST ROW IS DERIVED, NOT TYPED.
 *
 * Selecting host-ideal must change nothing, so its numbers have to be the ones
 * this binary already runs at: cli_speaker's ring IS
 * ITERATE_KIT_VOICE_SPEAKER_BUFFER_BYTES and the playback clock's wait IS
 * ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES, because both are compiled in. Typing
 * them out here would make the default row a claim about the rig that could
 * quietly stop being true; deriving them makes it a description of it.
 */
enum {
  CLI_DEVICE_PROFILE_HOST_SAMPLE_RATE_HZ =
      ITERATE_KIT_VOICE_FRAME_SAMPLES * CLI_DEVICE_PROFILE_MS_PER_SECOND /
      ITERATE_KIT_VOICE_FRAME_MS,
  CLI_DEVICE_PROFILE_HOST_CAPTURE_FPS =
      CLI_DEVICE_PROFILE_MS_PER_SECOND / ITERATE_KIT_VOICE_FRAME_MS,
  /*
   * The host's output peripheral is the CoreAudio queue, which holds
   * four buffers of one wire frame each plus the same reserve in its producer
   * ring — twice the
   * board's lead, which is the whole reason a stall that is audible on the
   * board is silent here. This typed copy is checked against the Darwin codec
   * constant by cli_device_profile_test.c; keeping CoreAudio types out of this
   * platform-independent table is deliberate.
   */
  CLI_DEVICE_PROFILE_HOST_LEAD_FRAMES = 8,
};

/*
 * THE BOARD ROW IS TYPED, NOT DERIVED.
 *
 * Every number below has a counterpart in voice_device_profile.h and could
 * have been written as that constant — and then the test that says the two
 * agree would be asserting that a constant equals itself, which catches
 * nothing. A second, independent copy is the only thing a drift test can
 * compare against, and drift is the failure worth catching: a simulator that
 * has quietly stopped matching the firmware it simulates is worse than no
 * simulator, because its passes are believed.
 */
enum {
  /* ITERATE_KIT_VOICE_FRAME_BYTES: 20 ms of 16 kHz mono PCM16. */
  CLI_DEVICE_PROFILE_S3_FRAME_BYTES = 640,
  /* ITERATE_KIT_VOICE_FRAME_SAMPLES per ITERATE_KIT_VOICE_FRAME_MS: 320/20. */
  CLI_DEVICE_PROFILE_S3_SAMPLE_RATE_HZ = 16000,
  /*
   * The ES8311 channel is six DMA descriptors of 240 samples
   * (waveshare_audio.c), which is the 90 ms I2S lead voice_device_profile.h
   * names in prose and carries as the +2880 byte term of its prefill. That is
   * four and a half wire frames; hardware cannot hold the remaining half of
   * one, so neither does the model.
   */
  CLI_DEVICE_PROFILE_S3_LEAD_FRAMES = 4,
  /* ITERATE_KIT_VOICE_SPEAKER_BUFFER_BYTES: 30 s of PSRAM, not a cushion. */
  CLI_DEVICE_PROFILE_S3_RING_BYTES = 960000,
  /* ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES: 300 ms acoustic + 90 ms I2S. */
  CLI_DEVICE_PROFILE_S3_PREFILL_BYTES = 12480,
  /* One frame every ITERATE_KIT_VOICE_FRAME_MS, both directions. */
  CLI_DEVICE_PROFILE_S3_CAPTURE_FPS = 50,
};

/*
 * The built-ins, default first. Order is the walk order, so --help lists the
 * default at the top rather than wherever an alphabetiser put it.
 */
static const struct cli_device_profile cli_device_profile_table[] = {
  {
    .name = "host-ideal",
    .summary = "host rig as built: cooperative loop, CoreAudio's deeper lead",
    .frame_bytes = ITERATE_KIT_VOICE_FRAME_BYTES,
    .sample_rate_hz = CLI_DEVICE_PROFILE_HOST_SAMPLE_RATE_HZ,
    .output_lead_frames = CLI_DEVICE_PROFILE_HOST_LEAD_FRAMES,
    .speaker_ring_bytes = ITERATE_KIT_VOICE_SPEAKER_BUFFER_BYTES,
    .speaker_prefill_bytes = ITERATE_KIT_VOICE_SPEAKER_PREFILL_BYTES,
    .capture_frames_per_second = CLI_DEVICE_PROFILE_HOST_CAPTURE_FPS,
    /* A cooperative loop nothing takes the CPU from; see the field's note. */
    .preemptive = false,
  },
  {
    .name = "waveshare-s3-amoled",
    .summary = "Waveshare ESP32-S3 AMOLED: 30 s PSRAM ring, 90 ms I2S lead",
    .frame_bytes = CLI_DEVICE_PROFILE_S3_FRAME_BYTES,
    .sample_rate_hz = CLI_DEVICE_PROFILE_S3_SAMPLE_RATE_HZ,
    .output_lead_frames = CLI_DEVICE_PROFILE_S3_LEAD_FRAMES,
    .speaker_ring_bytes = CLI_DEVICE_PROFILE_S3_RING_BYTES,
    .speaker_prefill_bytes = CLI_DEVICE_PROFILE_S3_PREFILL_BYTES,
    .capture_frames_per_second = CLI_DEVICE_PROFILE_S3_CAPTURE_FPS,
    /* FreeRTOS preempts the audio task; a stall has to be injected to be met. */
    .preemptive = true,
  },
};

/* True when a row can be named in a report and looked up by --device. */
static bool cli_device_profile_named(const struct cli_device_profile *profile);

/* True when no bound was left at zero, which is a row nobody finished. */
static bool cli_device_profile_bounded(const struct cli_device_profile *profile);

/* True when the bounds do not contradict each other. */
static bool cli_device_profile_coherent(
    const struct cli_device_profile *profile);

const char *cli_device_profile_status_name(enum cli_device_profile_status s)
{
  switch (s) {
    case CLI_DEVICE_PROFILE_OK: return "ok";
    case CLI_DEVICE_PROFILE_ERR_ARG: return "bad-argument";
    case CLI_DEVICE_PROFILE_ERR_UNKNOWN: return "unknown-device";
    default: return "unknown";
  }
}

const struct cli_device_profile *cli_device_profile_default(void)
{
  return &cli_device_profile_table[CLI_DEVICE_PROFILE_DEFAULT_INDEX];
}

enum cli_device_profile_status cli_device_profile_find(
    const char *name, const struct cli_device_profile **out)
{
  if (name == NULL || out == NULL) return CLI_DEVICE_PROFILE_ERR_ARG;
  for (size_t index = 0U; index < cli_device_profile_count(); ++index) {
    const struct cli_device_profile *profile = &cli_device_profile_table[index];
    if (strcmp(profile->name, name) != 0) continue;
    *out = profile;
    return CLI_DEVICE_PROFILE_OK;
  }
  /*
   * `out` is left exactly as the caller had it. Writing NULL on the way out
   * would turn a mistyped --device into a crash three frames into the call,
   * where the operator would be reading a stack trace instead of a spelling.
   */
  return CLI_DEVICE_PROFILE_ERR_UNKNOWN;
}

size_t cli_device_profile_count(void)
{
  return sizeof(cli_device_profile_table) / sizeof(cli_device_profile_table[0]);
}

const struct cli_device_profile *cli_device_profile_at(size_t index)
{
  if (index >= cli_device_profile_count()) return NULL;
  return &cli_device_profile_table[index];
}

bool cli_device_profile_check(const struct cli_device_profile *profile)
{
  if (profile == NULL) return false;
  if (!cli_device_profile_named(profile)) return false;
  if (!cli_device_profile_bounded(profile)) return false;
  return cli_device_profile_coherent(profile);
}

static bool cli_device_profile_named(const struct cli_device_profile *profile)
{
  assert(profile != NULL);
  if (profile->name == NULL || profile->name[0] == '\0') return false;
  return profile->summary != NULL && profile->summary[0] != '\0';
}

static bool cli_device_profile_bounded(const struct cli_device_profile *profile)
{
  assert(profile != NULL);
  if (profile->frame_bytes == 0U || profile->sample_rate_hz == 0U) return false;
  if (profile->output_lead_frames == 0U) return false;
  if (profile->speaker_ring_bytes == 0U) return false;
  if (profile->speaker_prefill_bytes == 0U) return false;
  return profile->capture_frames_per_second != 0U;
}

static bool cli_device_profile_coherent(const struct cli_device_profile *profile)
{
  assert(profile != NULL);
  /*
   * A prefill the ring cannot hold is a rig that waits forever for audio it
   * has already discarded at the door, and it presents as a device that never
   * speaks — which is a week of blaming the provider.
   */
  if (profile->speaker_prefill_bytes > profile->speaker_ring_bytes) {
    return false;
  }
  /* 64-bit, so a typo'd lead cannot wrap its way back into looking legal. */
  const uint64_t lead_bytes =
      (uint64_t)profile->output_lead_frames * profile->frame_bytes;
  return lead_bytes < profile->speaker_ring_bytes;
}
