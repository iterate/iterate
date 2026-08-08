#ifndef ITERATE_KIT_HAVPE_AUDIO_H
#define ITERATE_KIT_HAVPE_AUDIO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/audio_codec.h"

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

enum {
  HAVPE_AUDIO_SAMPLE_RATE_HZ = 16000,
  HAVPE_AUDIO_FRAME_SAMPLES = 320, /* 20 ms mono on the wire */
};

/**
 * Bring up the Home Assistant Voice Preview Edition audio path.
 *
 * Fails CLOSED on the XMOS: the DSP must report firmware 1.3.1 exactly and
 * echo back the pipeline stages written to it (ch0 = the NS uplink tap,
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

/** Complete capture frames replaced before the portable task could read them. */
uint32_t havpe_audio_capture_overruns(void);

/** Blocking capture reads that failed or timed out after ownership began. */
uint32_t havpe_audio_capture_driver_failures(void);

/** Blocking playback writes that failed after admission through the seam. */
uint32_t havpe_audio_playback_driver_failures(void);

/** RX DMA overflows (oldest buffer silently dropped by the driver). */
uint32_t havpe_audio_capture_queue_overflows(void);

/** TX DMA send-queue overflows reported by the driver ISR. */
uint32_t havpe_audio_playback_queue_overflows(void);

/** Samples the x16 capture make-up gain had to clip (lifetime). */
uint32_t havpe_audio_capture_gain_clipped(void);

/* The absolute-deadline starvation ledger; semantics identical to the other
 * boards (see m5sticks3_audio.h). */
void havpe_audio_watch(bool active);
void havpe_audio_draining(void);
void havpe_audio_note_flush(void);
void havpe_audio_reserve_write(uint32_t ms);
void havpe_audio_rollback_write(uint32_t ms);
uint32_t havpe_audio_starved_ms(void);
uint32_t havpe_audio_starve_events(void);
uint32_t havpe_audio_written_ms(void);

/** Whether the hardware ring still holds audio due out of the speaker. */
bool havpe_audio_speaker_is_playing(void);

/**
 * The echo-cancellation oracle, sampled every 20 ms frame.
 *
 * `raw` is the microphone before any XMOS processing and `clean` is the same
 * instant after AEC/IC/NS, both BEFORE the make-up gain. While the speaker is
 * running, clean/raw is this board's cancellation, and it can be watched
 * during a real conversation rather than reconstructed from files.
 * `capture_gain` is the make-up factor in force, which drops to one for as
 * long as the speaker is playing.
 */
uint32_t havpe_audio_capture_gain(void);
uint32_t havpe_audio_capture_raw_peak(void);
uint32_t havpe_audio_capture_clean_peak(void);

/**
 * The same two peaks, but only ever sampled while the speaker was running.
 *
 * These are the echo: what the microphone heard of this device's own voice
 * before the XMOS and after it. Their ratio is the cancellation, and it is
 * accumulated here rather than polled because the window is short.
 */
uint32_t havpe_audio_capture_echo_raw_peak(void);
uint32_t havpe_audio_capture_echo_clean_peak(void);

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
void havpe_audio_reset_echo_peaks(void);

/** Frames of this device's own echo that were withheld from the uplink. */
uint32_t havpe_audio_echo_frames_muted(void);
/** Frames the barge-in gate believed were a person. */
uint32_t havpe_audio_barge_in_admitted(void);
/** Frames it called echo — the decision that silences an interruption. */
uint32_t havpe_audio_barge_in_refused(void);
/**
 * The loudest cancelled-plane peak the gate still called echo.
 *
 * The number the floor should be argued about with. If this sits close under
 * ITERATE_KIT_BARGE_IN_FLOOR across real conversations, the floor is the
 * reason interruptions do not work.
 */
uint32_t havpe_audio_loudest_refused(void);
void havpe_audio_inject_starvation(uint32_t ms);
bool havpe_audio_starvation_pending(void);
uint32_t havpe_audio_take_injected_starvation(void);

#ifdef __cplusplus
}
#endif

#endif
