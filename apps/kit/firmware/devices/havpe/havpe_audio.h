#ifndef ITERATE_KIT_HAVPE_AUDIO_H
#define ITERATE_KIT_HAVPE_AUDIO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/audio_codec.h"

#ifdef __cplusplus
extern "C" {
#endif

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
void havpe_audio_inject_starvation(uint32_t ms);
bool havpe_audio_starvation_pending(void);
uint32_t havpe_audio_take_injected_starvation(void);

#ifdef __cplusplus
}
#endif

#endif
