#ifndef ITERATE_KIT_WAVESHARE_AUDIO_H
#define ITERATE_KIT_WAVESHARE_AUDIO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "driver/i2c_master.h"
#include "iterate/kit/audio_codec.h"
#include "iterate/kit/voice_playout.h"

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

/**
 * Power the class-D amplifier. It is deliberately NOT held on for the life of
 * the board: the amp sits centimetres from the microphone with no AEC
 * reference, and its idle noise floor is audible. The playback path raises it
 * before the first frame and drops it when the speaker runs dry.
 */
void waveshare_audio_amplifier(bool on);

/**
 * Play a flash-resident 16 kHz mono PCM16LE sound through the speaker, now.
 *
 * The board's local voice — the wake chime and "call ended" — with none of
 * the stream's latency: the playback hardware task drains this BEFORE the
 * paced queue, so it starts within one frame period (plus the amplifier
 * settle when it was down, which this call raises itself so a chime from
 * idle is audible). It PREEMPTS rather than mixes; whatever the stream
 * delivers meanwhile waits as backpressure. A second call replaces the first
 * mid-note. `pcm` must stay valid for the whole playback, which the
 * generated .rodata arrays trivially are.
 */
void waveshare_audio_play_sound(const uint8_t *pcm, uint32_t bytes);

/**
 * True while a local sound is playing or its tail may still be in the DMA
 * ring. The PHASE_QUIET amplifier cut consults this so an idle-powerdown
 * pass cannot behead a chime; QUIET is re-raised every idle pass, so the
 * amplifier still drops promptly once the sound is done.
 */
bool waveshare_audio_sound_active(void);

/** Descriptor debt used by the avatar to delay the mouth until PCM is heard.
 * This ISR-backed fact is separate from the shared starvation deadline.
 */
int32_t waveshare_audio_dma_owed_ms(void);
/** Apply the shared phase and retain the avatar's descriptor epoch boundary. */
void waveshare_audio_phase(enum iterate_kit_voice_phase phase);

/** Ceiling and shipped level; see the note at the setter for the measurement. */
enum {
  WAVESHARE_AUDIO_VOLUME_CEILING = 92,
  WAVESHARE_AUDIO_VOLUME_DEFAULT = 92,
};

/** Applies 0-100 to the codec, clamped to the ceiling, reporting what it took. */
enum iterate_kit_status waveshare_audio_set_volume(
    uint8_t percent, uint8_t *applied);
uint8_t waveshare_audio_volume(void);

#ifdef __cplusplus
}
#endif

#endif
