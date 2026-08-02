#ifndef ITERATE_KIT_CLI_DEVICE_PROFILE_H
#define ITERATE_KIT_CLI_DEVICE_PROFILE_H

/*
 * cli_device_profile: which board this rig is pretending to be.
 *
 * ORIGINATING FAILURE. The rig ran the device's own C and was still not the
 * device, because the numbers that bound a device — how many frames of lead
 * the I2S peripheral holds, how much speaker ring PSRAM affords, how much
 * audio must arrive before playback may start — reached the host as compile
 * time constants for whichever board was last built. So "it works on the CLI"
 * meant "it works at the host's sizes", and a defect that only appears at the
 * board's sizes stayed on the board.
 *
 * WHAT A PROFILE IS. The bounded resources of one piece of hardware, as
 * runtime values. Nothing about adversity: a profile says a board holds four
 * frames of I2S lead, not that its Wi-Fi drops. Identity and misfortune are
 * different axes and conflating them makes both unreadable — you could not
 * ask "does this defect need a bad network or a small board?" of a knob that
 * is both. Adversity lives in cli_fault_schedule.
 *
 * WHY RUNTIME AND NOT #define. Because the answer to "and other devices
 * later" has to be adding a row, not editing the rig, and because one process
 * must be able to run the same conversation at two boards' sizes to say which
 * of the two the defect belongs to.
 *
 * THE RELATIONSHIP TO voice_device_profile.h. That header is the shared,
 * compiled truth for firmware that runs ON a board and is not changed here;
 * this is the host's runtime copy of the subset a simulation needs. The
 * built-in profile named for a board MUST agree with it, and a test asserts
 * so — a simulator that has quietly drifted from the firmware it simulates is
 * worse than no simulator, because its passes are believed.
 */

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/** One status per way a profile can be asked for and not had. */
enum cli_device_profile_status {
  CLI_DEVICE_PROFILE_OK = 0,
  /** A NULL profile or name. */
  CLI_DEVICE_PROFILE_ERR_ARG,
  /** No built-in profile goes by that name. */
  CLI_DEVICE_PROFILE_ERR_UNKNOWN,
};

/**
 * One board's bounded resources.
 *
 * Every field is a number the hardware imposes, and each carries the failure
 * it bounds. A profile with a zero in it is not a profile with a default; it
 * is a profile somebody forgot to finish, and cli_device_profile_check says
 * so rather than letting the rig run at an accidental size.
 */
struct cli_device_profile {
  /** Stable identifier, as given to --device. */
  const char *name;
  /** One line for the report, so a result says which board it describes. */
  const char *summary;
  /** Wire frame, in bytes of 16-bit mono PCM. 640 is the 20 ms frame. */
  uint32_t frame_bytes;
  uint32_t sample_rate_hz;
  /**
   * Frames the output peripheral holds ahead of the speaker.
   *
   * This is how long a scheduler stall is absorbed before a listener hears
   * it: at four frames an 80 ms stall is silent and a 120 ms one is not.
   * A host that models zero lead hears every stall and calls the board
   * broken; one that models an unbounded lead hears none and calls it fine.
   */
  uint32_t output_lead_frames;
  /**
   * Speaker ring capacity in bytes.
   *
   * Sized for a server that paces, this ring discarded 2080 frames — 41
   * seconds of speech — in a two minute call, and the concealment that
   * followed was blamed on the network for a day.
   */
  uint32_t speaker_ring_bytes;
  /** Audio that must be queued before playback starts, in bytes. */
  uint32_t speaker_prefill_bytes;
  /** Frames per second the capture path produces. */
  uint32_t capture_frames_per_second;
  /**
   * Whether the platform preempts the audio loop.
   *
   * The board's task is preempted by FreeRTOS; the host's cooperative loop is
   * not. False here does not mean the board is kind — it means a stall must be
   * INJECTED to be reachable, and a rig that does not inject one is testing a
   * scheduler the device does not have.
   */
  bool preemptive;
};

/** Human-readable status name, for logs and test failure messages. */
const char *cli_device_profile_status_name(enum cli_device_profile_status s);

/**
 * The default profile: the host at its own comfortable sizes.
 *
 * Named rather than implied so that a report can say which profile produced a
 * result even when nobody chose one, and so that "the rig's own behaviour" is
 * a row in the table like any other rather than the absence of a row.
 */
const struct cli_device_profile *cli_device_profile_default(void);

/** Look up a built-in profile by the name given to --device. */
enum cli_device_profile_status cli_device_profile_find(
    const char *name, const struct cli_device_profile **out);

/**
 * Walk the built-in profiles, so --help and an unknown-name error can list
 * what is actually available instead of a list that goes stale.
 */
size_t cli_device_profile_count(void);
const struct cli_device_profile *cli_device_profile_at(size_t index);

/**
 * Whether `profile` is internally coherent — no zero where a bound belongs,
 * a prefill the ring can actually hold, a lead smaller than the ring.
 *
 * Called on every profile by a test, and on any profile the CLI selects. A
 * prefill larger than the ring is a rig that waits forever for audio it has
 * already discarded, and it presents as a device that never speaks.
 */
bool cli_device_profile_check(const struct cli_device_profile *profile);

#endif /* ITERATE_KIT_CLI_DEVICE_PROFILE_H */
