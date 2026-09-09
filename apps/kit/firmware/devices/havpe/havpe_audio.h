#ifndef ITERATE_KIT_HAVPE_AUDIO_H
#define ITERATE_KIT_HAVPE_AUDIO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/audio_codec.h"
#include "iterate/kit/platforms/i2s_codec.h"
#include "iterate/kit/voice_playout.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Applies 0-100 of this board's safe range to the AIC3204 DAC.
 *
 * 100 is 0 dB, the loudest setting that neither clips a full-scale sample nor
 * feeds the provider this device's own voice. See the note at the setter.
 */
enum iterate_kit_status havpe_audio_set_volume(
    uint8_t percent, uint8_t *applied);
uint8_t havpe_audio_volume(void);

/*
 * The XMOS DSP's live voice-to-noise estimate (0-255) over the servicer
 * I2C lane. Fails UNAVAILABLE before audio bring-up; the bus lock makes it
 * safe to ask from the health path while a call is running.
 */
enum iterate_kit_status havpe_audio_read_vnr(uint8_t *vnr);

enum {
  HAVPE_AUDIO_SAMPLE_RATE_HZ = 16000,
  HAVPE_AUDIO_FRAME_SAMPLES = 320, /* 20 ms mono on the wire */
};

/**
 * Bring up the Home Assistant Voice Preview Edition audio path.
 *
 * Fails CLOSED on the XMOS: the DSP must report firmware 1.3.1 exactly and
 * echo back the pipeline stages written to it (ch0 = the AEC uplink tap,
 * ch1 = NONE), or this returns false — an unverified XMOS means AEC evidence
 * cannot be trusted and slave I2S would block forever on a dead clock.
 * The complete boot ordering (reset pulse, 3 s XMOS boot, AIC3204 scripts
 * around the mandatory 2.5 s analogue soft-start, silence preload before
 * enable, speaker rail last) is a first-party hardware contract; every step
 * is commented at its site.
 */
bool havpe_audio_init(void);

/**
 * The nonblocking shared codec seam for this board.
 *
 * The XMOS masters both I2S buses; the ESP32 is a slave on two separate
 * controllers. Dedicated hardware tasks own the blocking reads and writes
 * and the 48 kHz stereo Q31 <-> 16 kHz mono PCM16 conversion; the seam only
 * copies complete 20 ms frames through bounded depth-one mailboxes.
 * Capture is the XMOS's echo-cancelled output — which is why this board
 * composes the passthrough processor — and no loudspeaker reference is
 * exposed: the XMOS keeps its AEC reference private to the DSP, and
 * fabricating one from intended playback would be dishonest evidence.
 */
struct iterate_kit_audio_codec havpe_audio_codec(void);

/**
 * Moves an XMOS output tap, and forgets the echo measured through the old one.
 *
 * `stage` is the first-party pipeline enum: 0 none (the raw microphone), 1
 * AEC, 2 AEC+IC, 3 AEC+IC+NS, 4 and AGC on top. Channel 0 is the uplink and
 * channel 1 is the diagnostic lane. Putting the SAME stage-1 and stage-0 taps
 * on the two channels is how the cancellation is measured honestly.
 */
enum iterate_kit_status havpe_audio_set_pipeline_stage(
    uint8_t channel, uint8_t stage);
uint8_t havpe_audio_pipeline_stage(uint8_t channel);

#ifdef __cplusplus
}
#endif

#endif
