#ifndef ITERATE_KIT_PLATFORMS_DARWIN_AUDIO_VPIO_H
#define ITERATE_KIT_PLATFORMS_DARWIN_AUDIO_VPIO_H

/*
 * iterate_kit_darwin_audio_vpio: this Mac's microphone AND speaker through one
 * Apple VoiceProcessingIO unit, so macOS cancels the speaker out of the
 * microphone before the stack ever sees it.
 *
 * ORIGINATING FAILURE. With a plain capture queue beside a plain playback
 * queue there is no echo cancellation anywhere, and the full-duplex model on
 * the far end hears its own answer coming back through the room. Measured on
 * this Mac (2026-09-11, unattended driver, real speaker and microphone): a
 * count to one hundred stopped at "One. Two. Three." and a two-minute story
 * died after one sentence and restarted with "Sure," — the model took its own
 * voice for a person interrupting. On the raw wire the same echo, fed back
 * digitally, was tolerated but transcribed as the USER's words, which is the
 * quieter failure: the durable transcript, the facet's forwarding of "what
 * the person said since", and the backend's context all fill with the
 * model's own speech.
 *
 * WHY ONE UNIT. Echo cancellation needs the render signal as its reference,
 * so capture and playback must go through the same processing graph; that is
 * what `kAudioUnitSubType_VoiceProcessingIO` is (FaceTime and every browser
 * on macOS run it). Both directions still land in the SAME rings the queue
 * path uses — `iterate_kit_darwin_audio_input` pushed from the unit's input
 * callback, `iterate_kit_darwin_audio_output` pulled from its render callback
 * — so the codec adapter, the metrics and every consumer are unchanged.
 *
 * FORMAT. The client format on both buses is the wire's own 16 kHz mono
 * PCM16; the unit converts from the devices' native rates. If the unit is
 * unavailable or refuses the format, open fails cleanly and the caller falls
 * back to the queues — an escape hatch that is also `--no-aec` on the CLI.
 */

#include <AudioToolbox/AudioToolbox.h>

#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/platforms/darwin_audio_input.h"
#include "iterate/kit/platforms/darwin_audio_output.h"
#include "iterate/kit/voice_device_profile.h"

#ifdef __cplusplus
extern "C" {
#endif

enum {
  /*
   * The most frames the unit may ask for or hand over in one callback, in
   * client-format frames. Devices run 512-frame slices at 44.1/48 kHz, which
   * is under 200 frames at 16 kHz; 4096 leaves room for aggregate devices and
   * whatever the OS chooses under load.
   */
  ITERATE_KIT_DARWIN_AUDIO_VPIO_MAX_FRAMES_PER_SLICE = 4096,
};

enum iterate_kit_darwin_audio_vpio_status {
  ITERATE_KIT_DARWIN_AUDIO_VPIO_OK = 0,
  ITERATE_KIT_DARWIN_AUDIO_VPIO_ERR_ARG,
  /** No VoiceProcessingIO component, or it refused the format. Fall back. */
  ITERATE_KIT_DARWIN_AUDIO_VPIO_ERR_PLATFORM,
};

/**
 * Caller-owned voice-processing unit driving two caller-owned rings. Nothing
 * allocates after open; both callbacks run on CoreAudio's I/O thread.
 */
struct iterate_kit_darwin_audio_vpio {
  AudioComponentInstance unit;
  struct iterate_kit_darwin_audio_input *input;
  struct iterate_kit_darwin_audio_output *output;
  /** Rendered capture for one callback, before it is cut into wire frames. */
  int16_t staging[ITERATE_KIT_DARWIN_AUDIO_VPIO_MAX_FRAMES_PER_SLICE];
  /** A partial wire frame carried from one input callback to the next. */
  uint8_t partial[ITERATE_KIT_VOICE_FRAME_BYTES];
  size_t partial_bytes;
  /** Input callbacks larger than the staging area; counted, dropped. */
  atomic_uint_least32_t oversize_slices;
  /** First failing OSStatus, zero while healthy. */
  atomic_int_least32_t platform_error;
  atomic_bool running;
};

/**
 * Create, configure and start the unit. `input` and `output` must already be
 * opened in their externally driven modes (see
 * iterate_kit_darwin_audio_input_open_external and
 * iterate_kit_darwin_audio_output_open_pulled). On failure nothing is left
 * running and the rings are untouched.
 */
enum iterate_kit_darwin_audio_vpio_status iterate_kit_darwin_audio_vpio_open(
    struct iterate_kit_darwin_audio_vpio *vpio,
    struct iterate_kit_darwin_audio_input *input,
    struct iterate_kit_darwin_audio_output *output);

int32_t iterate_kit_darwin_audio_vpio_platform_error(
    const struct iterate_kit_darwin_audio_vpio *vpio);

/** Stop and dispose the unit. Safe before or after a failed open. */
void iterate_kit_darwin_audio_vpio_close(struct iterate_kit_darwin_audio_vpio *vpio);

#ifdef __cplusplus
}
#endif

#endif
