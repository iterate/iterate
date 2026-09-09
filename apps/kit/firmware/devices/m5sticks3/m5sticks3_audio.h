#ifndef ITERATE_KIT_M5STICKS3_AUDIO_H
#define ITERATE_KIT_M5STICKS3_AUDIO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "iterate/kit/platforms/board.h"
#include "iterate/kit/voice_playout.h"

#ifdef __cplusplus
extern "C" {
#endif

/** C table for the playback controller; capture shares these pins but its
 * lifetime belongs to M5.Mic and the half-duplex fence, never duplex start.
 */
extern const struct iterate_kit_i2s_codec_facts m5sticks3_audio_facts;
/** ES8311 DAC reset/clock/power script; replayed after every Mic.end. */
extern const struct iterate_kit_register_script m5sticks3_audio_script;
/** Bind M5Unified's native I2C writer and mute the PMIC amplifier before
 * board.c runs the register script. Called after M5 board identity checks.
 */
bool m5sticks3_audio_prepare(void);

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
 * Called by board.open_codec after the BEFORE_I2S script. M5 board bring-up is
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

/**
 * Play a flash-resident 16 kHz mono PCM16LE sound through the speaker, now.
 *
 * The board's local voice — the wake chime and "call ended" — with none of
 * the stream's latency: the playback hardware task drains this BEFORE the
 * paced mailbox, so it starts within one frame period. It PREEMPTS rather
 * than mixes; whatever the stream delivers meanwhile waits as backpressure.
 * A second call replaces the first mid-note. The half-duplex fence outranks
 * it both ways: a sound requested while the microphone owns or is taking the
 * pins is DROPPED (there is no speaker to play through), and a fence
 * crossing mid-note drops the remainder. Raises the amplifier itself, so a
 * chime from idle is audible. `pcm` must stay valid for the whole playback,
 * which the generated .rodata arrays trivially are.
 */
void m5sticks3_audio_play_sound(const uint8_t *pcm, uint32_t bytes);

/**
 * True while a local sound is playing or its tail may still be in the DMA
 * ring. The PHASE_QUIET amplifier cut consults this so an idle-powerdown
 * pass cannot behead a chime; QUIET is re-raised every idle pass, so the
 * amplifier still drops promptly once the sound is done.
 */
bool m5sticks3_audio_sound_active(void);

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

/** Half-duplex fence crossings, for the health surface. */
uint32_t m5sticks3_audio_mode_switches(void);

#ifdef __cplusplus
}
#endif

#endif
