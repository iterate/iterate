#ifndef ITERATE_KIT_WAVESHARE_AUDIO_H
#define ITERATE_KIT_WAVESHARE_AUDIO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "driver/i2c_master.h"
#include "iterate/kit/audio_codec.h"

#ifdef __cplusplus
extern "C" {
#endif

enum {
  WAVESHARE_AUDIO_SAMPLE_RATE_HZ = 16000,
  WAVESHARE_AUDIO_FRAME_SAMPLES = 320, /* 20 ms mono */
};

/**
 * Bring up the Waveshare ESP32-S3 Touch AMOLED 1.8 audio path: I2C bus,
 * AXP2101 rails (DC1 3.3V main, ALDO1 3.3V mic), one duplex I2S pair
 * (MCLK 16 / BCLK 9 / WS 45 / DIN 10 / DOUT 8, mclk x256), ES8311 via
 * esp_codec_dev (PA on GPIO46), 16 kHz mono PCM16 both directions.
 */
bool waveshare_audio_init(void);

/**
 * The nonblocking shared codec seam for this board.
 *
 * Dedicated hardware tasks own esp_codec_dev's blocking calls. The seam only
 * copies complete 20 ms frames to and from bounded depth-one queues.
 */
struct iterate_kit_audio_codec waveshare_audio_codec(void);

/** Complete capture frames replaced before the portable task could read them. */
uint32_t waveshare_audio_capture_overruns(void);

/** Blocking codec-driver reads which failed after hardware ownership began. */
uint32_t waveshare_audio_capture_driver_failures(void);

/** Blocking codec-driver writes which failed after admission through the seam. */
uint32_t waveshare_audio_playback_driver_failures(void);

/**
 * Power the class-D amplifier. It is deliberately NOT held on for the life of
 * the board: the amp sits centimetres from the microphone with no AEC
 * reference, and its idle noise floor is audible. The playback path raises it
 * before the first frame and drops it when the speaker runs dry.
 */
void waveshare_audio_amplifier(bool on);

/**
 * DMA buffers the hardware sent with nothing in them.
 *
 * The one starvation measure taken from the hardware rather than inferred
 * from the software queue. See the callback for why that distinction is the
 * whole point.
 */
uint32_t waveshare_audio_dma_underruns(void);

/**
 * Count underruns only while an answer is playing.
 *
 * An idle DAC clocks out zeros by design, so counting them measures silence
 * rather than starvation — 23471 of them in six turns, before this existed.
 */
void waveshare_audio_dma_watch(bool active);

/**
 * Underruns in the first ring's worth of buffers after playback resumes.
 *
 * Separated because they are unavoidable and uninteresting — the ring has
 * been idle, so its buffers were cleared before the first write could reach
 * them. It is the OTHER counter that measures a pipeline failing to keep up.
 */
uint32_t waveshare_audio_dma_underruns_opening(void);

/**
 * The source has run dry: descriptors the hardware sends from here are empty
 * because nobody is filling them, which is how every answer ends.
 *
 * Call it BEFORE blocking for a frame that may not come. Without it the whole
 * 90ms ring drains under an active watch and the normal end of an answer reads
 * as 6-12 underruns on a turn where every frame sent was played.
 */
void waveshare_audio_dma_draining(void);

/** Cleared descriptors sent while dry — normal answer-end, not a fault. */
uint32_t waveshare_audio_dma_sends_draining(void);

/**
 * Deliberately stop feeding the DAC for `ms` while an answer is playing.
 *
 * FAULT INJECTION, and the only way to show the underrun detector still works.
 * "The watch stays armed" is an assertion about code; this produces the actual
 * condition — a real mid-answer gap with the ring draining — so the counter can
 * be seen to move. A detector that has never fired is not a detector.
 */
void waveshare_audio_inject_starvation(uint32_t ms);

/** Whether an injected starvation is still owed. */
bool waveshare_audio_starvation_pending(void);

/** Claim the owed starvation, clearing it. */
uint32_t waveshare_audio_take_injected_starvation(void);

/**
 * Reserve credit for `ms` of audio ABOUT to be written.
 *
 * Called before the blocking write, because the DAC's send callbacks fire while
 * that write is in progress and must see the audio they are sending. Roll it
 * back if the write fails.
 */
void waveshare_audio_reserve_write(uint32_t ms);

/**
 * Milliseconds the DAC spent with an empty ring while we were meant to be
 * feeding it — measured on the writing task, so it does not depend on the DMA
 * driver issuing callbacks during a gap.
 */
uint32_t waveshare_audio_starved_ms(void);

/** How many separate times that happened. */
uint32_t waveshare_audio_starve_events(void);

/**
 * An intentional flush just discarded queued audio.
 *
 * Tells the next arm that the hardware ring may still hold up to one ring of
 * audio it will never be credited for, so the empty-deadline must not assume an
 * empty ring. Without it a barge-in reports listener starvation that did not
 * happen.
 */
void waveshare_audio_note_flush(void);

/** Undo a reservation whose write did not happen. */
void waveshare_audio_rollback_write(uint32_t ms);

/** Send index of the FIRST counted underrun since feeding began. Diagnostic. */
uint32_t waveshare_audio_dma_underrun_first_send(void);

/** Audio handed over but not yet sent, in ms. Negative is impossible (clamped). */
int32_t waveshare_audio_dma_owed_ms(void);

/** Descriptors sent since feeding began — is the callback firing at all? */
uint32_t waveshare_audio_dma_sends(void);

/** Audio handed over since feeding began, in ms. */
uint32_t waveshare_audio_dma_written_ms(void);

/** Microseconds since the last write when the first underrun was counted. */
uint32_t waveshare_audio_dma_underrun_gap_us(void);

/** Send index of the most recent counted underrun. Diagnostic. */
uint32_t waveshare_audio_dma_underrun_last_send(void);

void waveshare_audio_set_volume(int percent);

/** Microphone PGA in dB; the driver quantises to 6 dB steps. */
void waveshare_audio_set_mic_gain(float db);

/** The shared I2C0 bus (codec, PMIC, touch). NULL before init. */
i2c_master_bus_handle_t waveshare_audio_i2c_bus(void);

/** Log the ES8311's ADC-path registers (bring-up diagnostics). */
void waveshare_audio_dump_registers(void);

/** Log whether anything drives the I2S DIN pad (bring-up diagnostics). */
void waveshare_audio_probe_din(void);

#ifdef __cplusplus
}
#endif

#endif
