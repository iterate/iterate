#ifndef ITERATE_KIT_M5STICKS3_AUDIO_H
#define ITERATE_KIT_M5STICKS3_AUDIO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/audio_codec.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Applies 0-100 of this board's SAFE range to the ES8311 DAC.
 *
 * 100 is -18 dB, not 0 dB: the ceiling is a brownout limit, not a taste, and
 * this scale is stretched to fit inside it so the knob has usable travel. See
 * the note at the setter for the tone that tripped the detector.
 */
enum iterate_kit_status m5sticks3_audio_set_volume(
    uint8_t percent, uint8_t *applied);
uint8_t m5sticks3_audio_volume(void);

enum {
  M5STICKS3_AUDIO_SAMPLE_RATE_HZ = 16000,
  M5STICKS3_AUDIO_FRAME_SAMPLES = 320, /* 20 ms mono */
};

/**
 * Bring up the M5StickS3 audio path and its two hardware-owner tasks.
 *
 * One ES8311 does both directions, but the board is HALF duplex by wiring:
 * the microphone is the same codec's ADC driven on I2S1, sharing
 * MCLK/BCLK/WS (GPIO 18/17/15) with the I2S0 speaker path — two masters on
 * one set of pins. Capture therefore requires DELETING the playback channel
 * (ESP-IDF leaves MCLK routed after a mere disable), and playback requires
 * the microphone to be fully released first. M5Unified owns the microphone;
 * this adapter owns I2S0, the codec's playback registers, and the M5PM1
 * amplifier latch.
 *
 * Must be called after m5sticks3_board_init(): M5Unified's board bring-up is
 * what muxes the M5PM1 amplifier GPIO and probes the internal I2C bus.
 */
bool m5sticks3_audio_init(void);

/**
 * The nonblocking shared codec seam for this board.
 *
 * Dedicated hardware tasks own the blocking I2S and recorder calls. The seam
 * only copies complete 20 ms frames to and from bounded depth-one mailboxes.
 * This board is HALF DUPLEX: read() returns UNAVAILABLE outside capture mode
 * and write() returns UNAVAILABLE while the microphone owns the pins.
 */
struct iterate_kit_audio_codec m5sticks3_audio_codec(void);

/**
 * Which side of the half-duplex fence should own the shared pins.
 *
 * Asynchronous by design: the playback task lowers the amplifier and deletes
 * I2S0 before the capture task may start the microphone, and the microphone
 * is fully ended before playback hardware is rebuilt. Poll
 * m5sticks3_audio_capturing() when the composition needs the settled fact.
 */
void m5sticks3_audio_set_capture(bool capture);

/** True once the microphone actually owns the hardware. */
bool m5sticks3_audio_capturing(void);

/** True while the fence is moving in either direction. */
bool m5sticks3_audio_mode_switching(void);

/**
 * Power the class-D amplifier via the M5PM1 latch.
 *
 * Deliberately NOT held on for the life of the board: the speaker sits
 * millimetres from the microphone with no AEC reference. The playback path
 * raises it when audio arrives and drops it when the speaker runs dry.
 */
void m5sticks3_audio_amplifier(bool on);

/** Complete capture frames replaced before the portable task could read them. */
uint32_t m5sticks3_audio_capture_overruns(void);

/** Microphone starts/records that failed after hardware ownership began. */
uint32_t m5sticks3_audio_capture_driver_failures(void);

/** I2S writes or mode switches that failed after admission through the seam. */
uint32_t m5sticks3_audio_playback_driver_failures(void);

/** Half-duplex fence crossings, for the health surface. */
uint32_t m5sticks3_audio_mode_switches(void);

/**
 * Count starvation only while an answer is being fed. Between answers the
 * DAC correctly clocks zeros; counting that measures silence, not a fault.
 */
void m5sticks3_audio_watch(bool active);

/**
 * The source has run dry because the answer is over: stall time from here is
 * the normal end-of-answer drain, not a defect.
 */
void m5sticks3_audio_draining(void);

/**
 * An intentional flush just discarded queued audio. The hardware ring may
 * still hold up to one ring of audio it will never be credited for, so the
 * empty-deadline must not assume an empty ring.
 */
void m5sticks3_audio_note_flush(void);

/**
 * Reserve credit for `ms` of audio ABOUT to be written, before the blocking
 * write. Lateness is measured here against an absolute audio-empty deadline:
 * every reservation pushes the deadline out by exactly the audio written, and
 * a write arriving after the deadline passed is starvation the listener heard.
 */
void m5sticks3_audio_reserve_write(uint32_t ms);

/** Undo a reservation whose write did not happen. */
void m5sticks3_audio_rollback_write(uint32_t ms);

/** Milliseconds the DAC spent with an empty ring while being fed. */
uint32_t m5sticks3_audio_starved_ms(void);

/** How many separate times that happened. */
uint32_t m5sticks3_audio_starve_events(void);


#ifdef __cplusplus
}
#endif

#endif
